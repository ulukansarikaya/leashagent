/**
 * Intel TDX on dstack (Phala Cloud) — TEE Lite hardware adapter.
 *
 * Provider (inside the CVM): asks the dstack guest agent for a TDX quote whose REPORTDATA carries
 * computeAttestationReportData(signer, nonce, serviceId), and ships the RTMR3 event log with it.
 *
 * Verifier (executor side):
 *  1. DCAP: quote signature chain up to Intel's root CA, collateral and TCB status (@phala/dcap-qvl).
 *  2. RTMR3: recompute every runtime-event digest from (type, name, payload) — never trusting the digest field —
 *     replay from 48 zero bytes and require the quote's RTMR3. Only then is the log's "compose-hash" trusted.
 *  3. measurement = keccak256(MRTD ‖ RTMR0 ‖ RTMR1 ‖ RTMR2 ‖ compose-hash): firmware + OS image + this app's
 *     docker-compose. RTMR3 itself is not pinned because it also covers per-instance events (app/instance id).
 *  4. REPORTDATA = our 32-byte binding followed by 32 zero bytes.
 */
import { request } from "node:http";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { concat, keccak256, toHex } from "viem";
import * as dcap from "@phala/dcap-qvl";
import { computeAttestationReportData, type AttestationEvidence, type EpochSec, type Hex } from "@leashagent/shared";
import type { AttestationProvider, QuoteVerifier, VerifiedQuote } from "./ports.js";

/** One TDX event-log entry as served by dstack's GetQuote (`digest` may be absent for RTMR3 entries). */
export type TdxEvent = { imr: number; event_type: number; digest?: string; event: string; event_payload: string };

/** Platform payload carried base64-encoded in AttestationEvidence.quote for platform "tdx". */
export type DstackTdxEvidence = { quote: string; eventLog: TdxEvent[] };

// ---------------------------------------------------------------------------------------------------------
// RTMR3 replay (dstack runtime events)
// ---------------------------------------------------------------------------------------------------------

/** dstack: sha384(event_type as u32 little-endian ‖ ":" ‖ event ‖ ":" ‖ payload bytes). */
export function dstackEventDigest(eventType: number, event: string, payload: Uint8Array): Uint8Array {
  const ty = Buffer.alloc(4);
  ty.writeUInt32LE(eventType >>> 0);
  return createHash("sha384").update(ty).update(":").update(event, "utf8").update(":").update(payload).digest();
}

/** Replay RTMR3 from the event log, recomputing each digest. */
export function replayRtmr3(log: TdxEvent[]): Uint8Array {
  let mr: Uint8Array = Buffer.alloc(48);
  for (const e of log) {
    if (e.imr !== 3) continue;
    const payload = Buffer.from(e.event_payload, "hex");
    if (payload.length * 2 !== e.event_payload.length) throw new Error(`event "${e.event}": payload is not hex`);
    mr = createHash("sha384").update(mr).update(dstackEventDigest(e.event_type, e.event, payload)).digest();
  }
  return mr;
}

/** The single "compose-hash" runtime event's payload (sha256 of the app-compose manifest). */
export function composeHashFromLog(log: TdxEvent[]): Hex {
  const hits = log.filter((e) => e.imr === 3 && e.event === "compose-hash");
  if (hits.length !== 1) throw new Error(`expected exactly one compose-hash event, found ${hits.length}`);
  const h = hits[0]!.event_payload.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("compose-hash payload is not 32 bytes");
  return `0x${h}`;
}

/** Allow-list value for a dstack TDX app: firmware + OS image + compose manifest. */
export function tdxAppMeasurement(r: { mrTd: Uint8Array; rtMr0: Uint8Array; rtMr1: Uint8Array; rtMr2: Uint8Array }, composeHash: Hex): Hex {
  return keccak256(concat([toHex(r.mrTd), toHex(r.rtMr0), toHex(r.rtMr1), toHex(r.rtMr2), composeHash]));
}

// ---------------------------------------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------------------------------------

export type TdxVerifierOptions = {
  /** Collateral source. Default: Phala's PCCS via @phala/dcap-qvl, cached for an hour per PCK chain. */
  collateral?: (quote: Uint8Array) => Promise<dcap.Collateral>;
  /** Verification time (seconds). Default: now. */
  now?: () => EpochSec;
  /** TCB statuses accepted. Default: UpToDate, SWHardeningNeeded. Debug TDs are always refused. */
  acceptedTcbStatuses?: dcap.TcbStatus[];
  /** Test seam: replace the DCAP step (signature chain + TCB). Production code must not set this. */
  dcapVerify?: (quote: Uint8Array, collateral: dcap.Collateral, nowSecs: number) => { status: dcap.TcbStatus; report: dcap.Report };
};

export const DEFAULT_ACCEPTED_TCB: dcap.TcbStatus[] = ["UpToDate", "SWHardeningNeeded"];

function tdBody(report: dcap.Report): dcap.TDReport10 {
  const td = report.asTd10() ?? report.asTd15()?.base ?? report.asTd15Ex()?.base.base ?? null;
  if (!td) throw new Error("not a TDX quote");
  return td;
}

function cachedCollateral(): (quote: Uint8Array) => Promise<dcap.Collateral> {
  const cache = new Map<string, { at: number; c: dcap.Collateral }>();
  return async (quote) => {
    const key = createHash("sha256").update(dcap.Quote.parse(quote).rawCertChain()).digest("hex");
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 3_600_000) return hit.c;
    const c = await dcap.getCollateral(dcap.PHALA_PCCS_URL, quote);
    cache.set(key, { at: Date.now(), c });
    return c;
  };
}

export class TdxDstackQuoteVerifier implements QuoteVerifier {
  readonly platform = "tdx" as const;
  private readonly collateral: (quote: Uint8Array) => Promise<dcap.Collateral>;
  private readonly accepted: Set<string>;

  constructor(private readonly opts: TdxVerifierOptions = {}) {
    this.collateral = opts.collateral ?? cachedCollateral();
    this.accepted = new Set(opts.acceptedTcbStatuses ?? DEFAULT_ACCEPTED_TCB);
  }

  async verify(bytes: Uint8Array): Promise<VerifiedQuote> {
    const ev = JSON.parse(Buffer.from(bytes).toString("utf8")) as DstackTdxEvidence;
    if (typeof ev.quote !== "string" || !Array.isArray(ev.eventLog)) throw new Error("malformed dstack TDX evidence");
    const quote = Buffer.from(ev.quote.replace(/^0x/, ""), "hex");

    // 1. Intel DCAP: signature chain, collateral, TCB. Production root CA; debug TDs refused.
    const now = this.opts.now?.() ?? Math.floor(Date.now() / 1000);
    const dcapVerify = this.opts.dcapVerify ?? ((q, c, t) => dcap.QuoteVerifier.newProd().allowDebug(false).verify(q, c, t));
    const vr = dcapVerify(quote, await this.collateral(quote), now);
    if (!this.accepted.has(vr.status)) throw new Error(`TCB status ${vr.status} not accepted`);
    const td = tdBody(vr.report);

    // 2. The (unsigned) event log must be the one the CVM actually extended into the signed RTMR3.
    if (!Buffer.from(replayRtmr3(ev.eventLog)).equals(Buffer.from(td.rtMr3))) throw new Error("event log does not replay to RTMR3");

    // 3 + 4.
    const reportData = Buffer.from(td.reportData);
    if (reportData.length !== 64 || !reportData.subarray(32).equals(Buffer.alloc(32))) throw new Error("unexpected REPORTDATA layout");
    return { measurement: tdxAppMeasurement(td, composeHashFromLog(ev.eventLog)), reportData: toHex(reportData.subarray(0, 32)) };
  }
}

// ---------------------------------------------------------------------------------------------------------
// Provider (runs inside the dstack CVM)
// ---------------------------------------------------------------------------------------------------------

/** Minimal dstack guest-agent client: POST /GetQuote {report_data: hex} over the unix socket (or HTTP simulator). */
export type DstackQuoteClient = { getQuote(reportData: Uint8Array): Promise<{ quote: string; event_log: string }> };

const SOCKETS = ["/var/run/dstack.sock", "/run/dstack.sock", "/var/run/dstack/dstack.sock", "/run/dstack/dstack.sock"];

export function dstackClient(endpoint = process.env.DSTACK_SIMULATOR_ENDPOINT ?? SOCKETS.find((p) => existsSync(p))): DstackQuoteClient {
  if (!endpoint) throw new Error("dstack guest agent not found (no /var/run/dstack.sock): not running inside a dstack CVM");
  return {
    getQuote: (reportData) => new Promise((resolve, reject) => {
      if (reportData.length > 64) return reject(new Error("report data must be at most 64 bytes"));
      const body = JSON.stringify({ report_data: Buffer.from(reportData).toString("hex") });
      const http = endpoint.startsWith("http");
      const url = http ? new URL("/GetQuote", endpoint) : undefined;
      const req = request({
        ...(http ? { host: url!.hostname, port: url!.port, path: url!.pathname } : { socketPath: endpoint, path: "/GetQuote" }),
        method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 30_000,
      }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const r = JSON.parse(data);
            if (r.error) return reject(new Error(String(r.error)));
            resolve({ quote: r.quote, event_log: r.event_log });
          } catch (e) { reject(e); }
        });
      });
      req.on("timeout", () => req.destroy(new Error("dstack GetQuote timed out")));
      req.on("error", reject);
      req.end(body);
    }),
  };
}

export class DstackTdxProvider implements AttestationProvider {
  readonly platform = "tdx" as const;

  constructor(
    readonly signer: Hex,
    private readonly serviceId: string,
    private readonly client: DstackQuoteClient = dstackClient(),
    private readonly clock: () => EpochSec = () => Math.floor(Date.now() / 1000),
  ) {}

  async attest(nonce: Hex): Promise<AttestationEvidence> {
    const rd = Buffer.from(computeAttestationReportData(this.signer, nonce, this.serviceId).slice(2), "hex"); // 32 raw bytes
    const r = await this.client.getQuote(rd);
    const eventLog = (JSON.parse(r.event_log) as TdxEvent[]).filter((e) => e.imr === 3);
    const payload: DstackTdxEvidence = { quote: r.quote, eventLog };
    return {
      platform: "tdx", quote: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
      signer: this.signer, nonce, serviceId: this.serviceId, issuedAt: this.clock(),
    };
  }
}
