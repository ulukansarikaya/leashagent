import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeOrder, type NormalizedOrder } from "@bekci/shared";
import { BTC_USDT, limitBuy } from "@bekci/mocks";
import {
  AtkUncertainError,
  CliTransport,
  McpStdioTransport,
  OkxAtkClient,
  OkxPublicMarketData,
  buildAtkEnv,
  classifyWrite,
  errorIsDefiniteRejection,
  type AtkCallResult,
} from "../src";

const FIX = join(__dirname, "fixtures");
const POLICY = ("0x" + "ab".repeat(32)) as `0x${string}`;
const env = { apiKey: "k", secretKey: "s", passphrase: "p", demo: true, site: "global" };
const order = (o = limitBuy(), id = crypto.randomUUID()): NormalizedOrder => normalizeOrder(o, BTC_USDT, id, POLICY);

describe("error classification (fail-safe)", () => {
  const e = (type: string, code?: string) => ({ type, message: "m", ...(code ? { code } : {}) });
  it.each([
    [e("ValidationError"), true],
    [e("ConfigError"), true],
    [e("AuthenticationError", "50111"), true],
    [e("RateLimitError", "50011"), true],
    [e("OkxApiError", "1"), true],
    [e("OkxApiError", "51008"), true],
    [e("OkxApiError", "51016"), true],
    [e("OkxApiError", "50004"), false], // "does not mean the request was successful or failed"
    [e("OkxApiError", "50001"), false],
    [e("OkxApiError", "502"), false], // bare HTTP status
    [e("OkxApiError"), false],
    [e("NetworkError"), false],
    [e("InternalError"), false],
    [e("SomethingNew", "1"), false],
  ])("%j -> definite=%s", (err, definite) => {
    expect(errorIsDefiniteRejection(err)).toBe(definite);
  });

  it("per-item sCode, missing ordId and empty data", () => {
    const ok = (data: unknown): AtkCallResult => ({ ok: true, response: { data } });
    expect(classifyWrite(ok([{ ordId: "1", sCode: "0" }]))).toMatchObject({ kind: "accepted", ordId: "1" });
    expect(classifyWrite(ok([{ ordId: "", sCode: "51008", sMsg: "no money" }]))).toMatchObject({ kind: "rejected", code: "51008" });
    expect(classifyWrite(ok([{ sCode: "50004" }]))).toMatchObject({ kind: "uncertain" });
    expect(classifyWrite(ok([{ sCode: "0" }]))).toMatchObject({ kind: "uncertain" });
    expect(classifyWrite(ok([]))).toMatchObject({ kind: "uncertain" });
    expect(classifyWrite(ok(null))).toMatchObject({ kind: "uncertain" });
  });
});

describe("buildAtkEnv", () => {
  it("passes only OKX_* settings and process essentials, nothing else from the parent", () => {
    const out = buildAtkEnv(env, { PATH: "/bin", HOME: "/h", LEAKED_SECRET: "x", OKX_TRADE_KEY: "y", GUARD_SIGNING_KEY: "z" });
    expect(Object.keys(out).sort()).toEqual(["HOME", "OKX_API_KEY", "OKX_DEMO", "OKX_PASSPHRASE", "OKX_SECRET_KEY", "OKX_SITE", "PATH"]);
    expect(out.OKX_DEMO).toBe("1");
  });
});

describe("McpStdioTransport + OkxAtkClient against a fake okx-trade-mcp (real stdio)", () => {
  const open: McpStdioTransport[] = [];
  afterEach(async () => { await Promise.all(open.splice(0).map((t) => t.close())); });
  const mk = (mode = "ok", extra: Partial<ConstructorParameters<typeof McpStdioTransport>[0]> = {}) => {
    const t = new McpStdioTransport({
      command: process.execPath,
      commandArgs: [join(FIX, "fake-okx-mcp.mjs"), `--fake-mode=${mode}`],
      modules: ["spot"],
      readOnly: false,
      env,
      callTimeoutMs: 1500,
      ...extra,
    });
    open.push(t);
    return t;
  };

  it("child sees only OKX credentials/config; read-only and modules flags are forwarded", async () => {
    process.env.LEAKED_SECRET = "should-not-pass";
    try {
      const t = mk("ok", { readOnly: true, modules: ["market"] });
      expect(await t.listTools()).not.toContain("spot_place_order");
      const r = await t.callTool("debug_env", {});
      expect(r.ok && (r.response.data as Record<string, unknown>[])[0]).toMatchObject({
        keys: ["OKX_API_KEY", "OKX_DEMO", "OKX_PASSPHRASE", "OKX_SECRET_KEY", "OKX_SITE"],
        demo: "1", site: "global", hasKey: true, modules: "market", readOnly: true,
      });
    } finally {
      delete process.env.LEAKED_SECRET;
    }
  });

  it("limit order: accepted, then queried by clOrdId; cancel works", async () => {
    const c = new OkxAtkClient(mk());
    const o = order();
    const r = await c.placeSpotOrder(o);
    expect(r).toMatchObject({ ok: true });
    const q = await c.getOrderByClOrdId(o.instId, o.clOrdId!);
    expect(q).toMatchObject({ clOrdId: o.clOrdId, state: "live", accFillSz: "0" });
    const ordId = (r as { ordId: string }).ordId;
    const cancel = normalizeOrder({ tool: "spot_cancel_order", instId: "BTC-USDT", ordId }, BTC_USDT, crypto.randomUUID(), POLICY);
    expect(await c.cancelSpotOrder(cancel)).toMatchObject({ ok: true, ordId });
    expect((await c.getOrderByClOrdId(o.instId, o.clOrdId!))?.state).toBe("canceled");
  });

  it("market order sends tgtCcy=base_ccy and tdMode=cash", async () => {
    const t = mk();
    const c = new OkxAtkClient(t);
    const o = order(limitBuy({ ordType: "market", px: undefined }));
    await c.placeSpotOrder(o);
    const q = await c.getOrderByClOrdId(o.instId, o.clOrdId!);
    expect(q?.state).toBe("filled");
    expect((q?.raw as { tgtCcy?: string }).tgtCcy).toBe("base_ccy");
  });

  it("duplicate clOrdId is a definite OKX rejection (exchange-side INV-8 backstop)", async () => {
    const c = new OkxAtkClient(mk());
    const o = order();
    await c.placeSpotOrder(o);
    expect(await c.placeSpotOrder(o)).toMatchObject({ ok: false, kind: "rejected", code: "51016" });
  });

  it("'order does not exist' maps to null; other query failures throw", async () => {
    expect(await new OkxAtkClient(mk()).getOrderByClOrdId("BTC-USDT", "bk000")).toBeNull();
    await expect(new OkxAtkClient(mk("queryfail")).getOrderByClOrdId("BTC-USDT", "bk000")).rejects.toThrow();
  });

  it.each([["reject", "rejected"], ["network", "uncertain"], ["http502", "uncertain"], ["timeout50004", "uncertain"], ["hang", "uncertain"], ["crash", "uncertain"]])(
    "mode %s -> %s",
    async (mode, expected) => {
      const c = new OkxAtkClient(mk(mode));
      const p = c.placeSpotOrder(order());
      if (expected === "rejected") await expect(p).resolves.toMatchObject({ ok: false, kind: "rejected", code: "1" });
      else await expect(p).rejects.toBeInstanceOf(AtkUncertainError);
    },
    10_000,
  );
});

describe("CliTransport against a fake okx CLI", () => {
  const mk = (mode: string) =>
    new OkxAtkClient(new CliTransport({ command: process.execPath, commandArgs: [join(FIX, "fake-okx-cli.mjs"), `--fake-mode=${mode}`], env, timeoutMs: 5000 }));

  it("maps the order to CLI flags and parses --json output", async () => {
    const o = order();
    const r = await mk("ok").placeSpotOrder(o);
    expect(r).toMatchObject({ ok: true, ordId: "777" });
    const argv = ((r as { raw: { data: { argv: string[] }[] } }).raw.data[0]!).argv;
    expect(argv).toEqual(expect.arrayContaining(["spot", "place", "--tdMode", "cash", "--clOrdId", o.clOrdId!, "--json"]));
    expect((await mk("ok").getOrderByClOrdId("BTC-USDT", o.clOrdId!))?.state).toBe("filled");
  });

  it("text errors: numeric Code -> rejected; network hint / no code / bad JSON -> uncertain", async () => {
    await expect(mk("reject").placeSpotOrder(order())).resolves.toMatchObject({ ok: false, code: "51008" });
    await expect(mk("network").placeSpotOrder(order())).rejects.toBeInstanceOf(AtkUncertainError);
    await expect(mk("weird").placeSpotOrder(order())).rejects.toBeInstanceOf(AtkUncertainError);
    await expect(mk("badjson").placeSpotOrder(order())).rejects.toBeInstanceOf(AtkUncertainError);
  });
});

describe("OkxPublicMarketData", () => {
  const fake = (routes: Record<string, unknown>, seen: { url: string; headers: Record<string, string> }[] = []) =>
    (async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: init?.headers as Record<string, string> });
      const key = Object.keys(routes).find((k) => url.includes(k));
      return new Response(JSON.stringify(key ? routes[key] : { code: "51001", msg: "not found", data: [] }), { status: 200 });
    }) as unknown as typeof fetch;

  it("reads instrument and ticker, sends the demo header, uses the TR host", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const md = new OkxPublicMarketData({
      site: "tr", demo: true,
      fetchImpl: fake({
        "/public/instruments": { code: "0", data: [{ instId: "BTC-USDT", lotSz: "0.00000001", tickSz: "0.1", minSz: "0.00001", state: "live" }] },
        "/market/ticker": { code: "0", data: [{ instId: "BTC-USDT", bidPx: "59990", askPx: "60010", last: "60000", ts: "1760000000123" }] },
      }, seen),
    });
    expect(await md.getInstrument("BTC-USDT")).toEqual({ instId: "BTC-USDT", lotSz: "0.00000001", tickSz: "0.1", minSz: "0.00001" });
    expect(await md.getTicker("BTC-USDT")).toEqual({ instId: "BTC-USDT", bid: "59990", ask: "60010", last: "60000", ts: 1760000000 });
    expect(seen[0]!.url.startsWith("https://tr.okx.com/api/v5/")).toBe(true);
    expect(seen.every((s) => s.headers["x-simulated-trading"] === "1")).toBe(true);
    await md.getInstrument("BTC-USDT");
    expect(seen.filter((s) => s.url.includes("instruments")).length).toBe(1); // cached
  });

  it("errors and malformed data throw (callers treat as stale -> fail closed)", async () => {
    const md = new OkxPublicMarketData({ site: "global", demo: false, fetchImpl: fake({ "/market/ticker": { code: "0", data: [{ bidPx: "x" }] } }) });
    await expect(md.getTicker("BTC-USDT")).rejects.toThrow();
    await expect(md.getInstrument("BTC-USDT")).rejects.toThrow();
  });
});
