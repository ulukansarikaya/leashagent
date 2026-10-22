import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type * as dcap from "@phala/dcap-qvl";
import { computeAttestationReportData, type Hex } from "@leashagent/shared";
import {
  AttestedSignerRegistry, DstackTdxProvider, TdxDstackQuoteVerifier, attestOnce, composeHashFromLog, dstackClient,
  dstackEventDigest, replayRtmr3, tdxAppMeasurement, type DstackQuoteClient, type TdxEvent,
} from "../src";

const FIX = join(__dirname, "fixtures");
const SAMPLE_QUOTE = readFileSync(join(FIX, "tdx_quote_td15ex"));
const SAMPLE_COLLATERAL = JSON.parse(readFileSync(join(FIX, "tdx_quote_td15ex_collateral.json"), "utf8"));
const SAMPLE_NOW = Date.parse("2026-10-08T02:45:00Z") / 1000;
const SERVICE = "leashagent-gateway";
const DSTACK_EVENT = 0x08000001;

const evidenceBytes = (quoteHex: string, eventLog: TdxEvent[]) => new Uint8Array(Buffer.from(JSON.stringify({ quote: quoteHex, eventLog })));
const hex = (n: number, fill: number) => Buffer.alloc(n, fill).toString("hex");

/** A dstack-shaped boot log for one app; `compose` is the compose-hash payload. */
function bootLog(compose: string, instance = hex(20, 7)): TdxEvent[] {
  const e = (event: string, payload: string): TdxEvent => ({ imr: 3, event_type: DSTACK_EVENT, event, event_payload: payload });
  return [
    { imr: 0, event_type: 1, digest: hex(48, 1), event: "", event_payload: "" },
    e("system-preparing", ""), e("app-id", hex(20, 5)), e("compose-hash", compose), e("instance-id", instance),
    e("boot-mr-done", ""), e("key-provider", Buffer.from('{"name":"kms"}').toString("hex")), e("system-ready", ""),
  ];
}

describe("TDX / dstack — RTMR3 replay", () => {
  it("event digest is sha384(type u32 LE ‖ ':' ‖ name ‖ ':' ‖ payload)", () => {
    const payload = Buffer.alloc(32, 0xab);
    const expected = createHash("sha384").update(Buffer.from([0x01, 0x00, 0x00, 0x08])).update(":compose-hash:").update(payload).digest();
    expect(Buffer.from(dstackEventDigest(DSTACK_EVENT, "compose-hash", payload)).equals(expected)).toBe(true);
  });

  it("replays only RTMR3 entries, from 48 zero bytes, ignoring any supplied digest", () => {
    const log = bootLog(hex(32, 9));
    const lying = log.map((e) => (e.imr === 3 ? { ...e, digest: hex(48, 0xff) } : e));
    expect(Buffer.from(replayRtmr3(lying)).equals(Buffer.from(replayRtmr3(log)))).toBe(true);
    expect(Buffer.from(replayRtmr3([])).equals(Buffer.alloc(48))).toBe(true);
  });

  it("any change to a runtime event changes the replayed register", () => {
    const base = Buffer.from(replayRtmr3(bootLog(hex(32, 9))));
    expect(Buffer.from(replayRtmr3(bootLog(hex(32, 8)))).equals(base)).toBe(false);
    expect(Buffer.from(replayRtmr3(bootLog(hex(32, 9), hex(20, 6)))).equals(base)).toBe(false);
  });

  it("requires exactly one well-formed compose-hash event", () => {
    expect(composeHashFromLog(bootLog(hex(32, 9)))).toBe(`0x${hex(32, 9)}`);
    const twice = [...bootLog(hex(32, 9)), { imr: 3, event_type: DSTACK_EVENT, event: "compose-hash", event_payload: hex(32, 1) }];
    expect(() => composeHashFromLog(twice)).toThrow(/exactly one/);
    expect(() => composeHashFromLog(bootLog("abcd"))).toThrow(/32 bytes/);
  });
});

describe("TDX / dstack — DCAP on a real Intel TDX quote (offline collateral)", () => {
  const verifier = (opts: Partial<ConstructorParameters<typeof TdxDstackQuoteVerifier>[0]> = {}) =>
    new TdxDstackQuoteVerifier({ collateral: async () => SAMPLE_COLLATERAL, now: () => SAMPLE_NOW, ...opts });

  it("a genuine quote passes DCAP; the unsigned event log must still replay to its RTMR3", async () => {
    await expect(verifier().verify(evidenceBytes(SAMPLE_QUOTE.toString("hex"), []))).rejects.toThrow(/does not replay to RTMR3/);
  });

  it("a single flipped byte in the signed body fails the signature check", async () => {
    const t = Buffer.from(SAMPLE_QUOTE);
    t[54 + 200] ^= 1;
    await expect(verifier().verify(evidenceBytes(t.toString("hex"), []))).rejects.toThrow(/signature/i);
  });

  it("TCB status outside the accepted set is refused", async () => {
    await expect(verifier({ acceptedTcbStatuses: ["SWHardeningNeeded"] }).verify(evidenceBytes(SAMPLE_QUOTE.toString("hex"), [])))
      .rejects.toThrow(/TCB status UpToDate not accepted/);
  });

  it("expired collateral is refused", async () => {
    const later = Date.parse("2031-01-01T00:00:00Z") / 1000;
    await expect(verifier({ now: () => later }).verify(evidenceBytes(SAMPLE_QUOTE.toString("hex"), []))).rejects.toThrow();
  });
});

describe("TDX / dstack — provider + verifier + registry (INV-22 on the TDX path)", () => {
  const MRS = { mrTd: Buffer.alloc(48, 1), rtMr0: Buffer.alloc(48, 2), rtMr1: Buffer.alloc(48, 3), rtMr2: Buffer.alloc(48, 4) };

  /** A fake guest agent plus a fake DCAP step that "signs" whatever the agent was asked for. */
  function setup(opts: { compose?: string; tamperLog?: (l: TdxEvent[]) => TdxEvent[]; reportDataOverride?: Buffer } = {}) {
    const compose = opts.compose ?? hex(32, 9);
    const signer = privateKeyToAccount(generatePrivateKey()).address;
    const asked: Uint8Array[] = [];
    let lastLog: TdxEvent[] = [];
    let lastRd = Buffer.alloc(0);
    const client: DstackQuoteClient = {
      async getQuote(rd) {
        asked.push(rd);
        lastLog = bootLog(compose);
        lastRd = Buffer.from(rd);
        return { quote: "00", event_log: JSON.stringify(lastLog) };
      },
    };
    const fakeDcap = (): { status: dcap.TcbStatus; report: dcap.Report } => {
      const td = { ...MRS, rtMr3: replayRtmr3(lastLog), reportData: Buffer.concat([opts.reportDataOverride ?? lastRd, Buffer.alloc(32)]) };
      return { status: "UpToDate", report: { asTd10: () => td, asTd15: () => null, asTd15Ex: () => null } as unknown as dcap.Report };
    };
    const tdxVerifier = new TdxDstackQuoteVerifier({ collateral: async () => ({}) as dcap.Collateral, dcapVerify: fakeDcap });
    const tamper = opts.tamperLog;
    const verifier = tamper
      ? { platform: "tdx" as const, verify: async (b: Uint8Array) => {
          const ev = JSON.parse(Buffer.from(b).toString("utf8"));
          return tdxVerifier.verify(evidenceBytes(ev.quote, tamper(ev.eventLog)));
        } }
      : tdxVerifier;
    const expected = tdxAppMeasurement(MRS, `0x${hex(32, 9)}`);
    const registry = new AttestedSignerRegistry({ serviceId: SERVICE, allowedMeasurements: [expected], maxAgeSec: 300, verifiers: { tdx: verifier } });
    const provider = new DstackTdxProvider(signer, SERVICE, client);
    return { signer, asked, registry, provider };
  }

  it("the expected app build is accepted; the agent is asked for exactly our 32-byte binding", async () => {
    const t = setup();
    const r = await attestOnce(t.registry, t.provider);
    expect(r).toMatchObject({ ok: true, accepted: { platform: "tdx", signer: t.signer } });
    expect(await t.registry.isAuthorizedSigner(t.signer)).toBe(true);
    expect(t.asked).toHaveLength(1);
    expect(t.asked[0]!.length).toBe(32);
  });

  it("the provider ships only RTMR3 entries", async () => {
    const t = setup();
    const ev = await t.provider.attest(t.registry.challenge());
    const payload = JSON.parse(Buffer.from(ev.quote, "base64").toString("utf8"));
    expect(payload.eventLog.every((e: TdxEvent) => e.imr === 3)).toBe(true);
  });

  it("a different docker-compose (compose-hash) is not an allowed measurement", async () => {
    const t = setup({ compose: hex(32, 8) });
    expect(await attestOnce(t.registry, t.provider)).toEqual({ ok: false, reason: "measurement_not_allowed" });
  });

  it("an event log edited after the fact no longer replays to the signed RTMR3", async () => {
    const t = setup({ tamperLog: (l) => l.map((e) => (e.event === "compose-hash" ? { ...e, event_payload: hex(32, 9).replace(/^09/, "0a") } : e)) });
    expect(await attestOnce(t.registry, t.provider)).toEqual({ ok: false, reason: "quote_invalid" });
  });

  it("a quote whose REPORTDATA binds another nonce or signer is refused", async () => {
    const other = Buffer.from(computeAttestationReportData(privateKeyToAccount(generatePrivateKey()).address, `0x${"11".repeat(32)}` as Hex, SERVICE).slice(2), "hex");
    const t = setup({ reportDataOverride: other });
    expect(await attestOnce(t.registry, t.provider)).toEqual({ ok: false, reason: "report_data_mismatch" });
  });
});

describe("dstack guest-agent client", () => {
  it("POSTs /GetQuote with hex report_data and returns quote + event_log", async () => {
    let seen: { path?: string; body?: string } = {};
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen = { path: req.url, body };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ quote: "abcd", event_log: "[]" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      const r = await dstackClient(`http://127.0.0.1:${port}`).getQuote(Buffer.alloc(32, 0xaa));
      expect(seen.path).toBe("/GetQuote");
      expect(JSON.parse(seen.body!)).toEqual({ report_data: "aa".repeat(32) });
      expect(r).toEqual({ quote: "abcd", event_log: "[]" });
      await expect(dstackClient(`http://127.0.0.1:${port}`).getQuote(Buffer.alloc(65))).rejects.toThrow(/64 bytes/);
    } finally {
      server.close();
    }
  });

  it("outside a CVM, creating the client fails clearly", () => {
    const saved = process.env.DSTACK_SIMULATOR_ENDPOINT;
    delete process.env.DSTACK_SIMULATOR_ENDPOINT;
    try { expect(() => dstackClient()).toThrow(/not running inside a dstack CVM/); }
    finally { if (saved !== undefined) process.env.DSTACK_SIMULATOR_ENDPOINT = saved; }
  });
});
