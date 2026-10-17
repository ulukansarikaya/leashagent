/**
 * P0 ATK / OKX demo spike (§17, §19, §25.6). Places a few tiny orders on an OKX *demo* account
 * through the exact path L6 uses (OkxAtkClient -> ATK MCP or CLI -> OKX) and records what OKX
 * actually does. Refuses to run against a live profile.
 *
 *   OKX_TRADE_KEY=… OKX_TRADE_SECRET=… OKX_TRADE_PASSPHRASE=… OKX_PROFILE=demo OKX_SITE=global \
 *     pnpm spike:atk --yes-place-demo-orders [--transport mcp|cli] [--instId BTC-USDT] [--probe-default-tgtccy]
 *
 * Output: spike-results/atk-spike-<timestamp>.json (no credentials are written).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dec, deriveClOrdId, type Hex, type InstrumentInfo, type NormalizedOrder } from "@bekci/shared";
import { tradeAtkEnvFromProcess } from "@bekci/executor";
import { AtkUncertainError, CliTransport, McpStdioTransport, OkxAtkClient, OkxPublicMarketData, type AtkTransport } from "@bekci/atk";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : d;
};

type Step = { id: string; question: string; status: "PASS" | "FAIL" | "INFO" | "SKIP"; finding: string; data?: unknown; ms?: number };
const steps: Step[] = [];
const SPIKE_POLICY = ("0x" + "5b".repeat(32)) as Hex;
const newClOrdId = () => deriveClOrdId(SPIKE_POLICY, randomUUID());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function step(id: string, question: string, fn: () => Promise<Omit<Step, "id" | "question" | "ms">>) {
  const t0 = Date.now();
  try {
    const r = await fn();
    steps.push({ id, question, ...r, ms: Date.now() - t0 });
  } catch (e) {
    const err = e as Error & { raw?: unknown };
    steps.push({ id, question, status: "FAIL", finding: `${err.name}: ${err.message}`, data: err.raw, ms: Date.now() - t0 });
  }
  const s = steps.at(-1)!;
  console.log(`[${s.status}] ${s.id} ${s.question}\n        ${s.finding} (${s.ms} ms)`);
}

async function pollOrder(c: OkxAtkClient, instId: string, clOrdId: string, until: (s: string) => boolean, ms = 8000) {
  const end = Date.now() + ms;
  let last = null as Awaited<ReturnType<OkxAtkClient["getOrderByClOrdId"]>>;
  while (Date.now() < end) {
    last = await c.getOrderByClOrdId(instId, clOrdId);
    if (last && until(last.state)) return last;
    await sleep(500);
  }
  return last;
}

async function main() {
  if (!flag("yes-place-demo-orders")) {
    console.error("Refusing to run without --yes-place-demo-orders (this places real orders on the OKX demo account).");
    process.exit(2);
  }
  const env = tradeAtkEnvFromProcess();
  if (!env.demo) {
    console.error("OKX_PROFILE must be 'demo' for the spike. Live trading is never used here.");
    process.exit(2);
  }
  const instId = opt("instId", "BTC-USDT");
  const kind = opt("transport", "mcp");
  const transport: AtkTransport =
    kind === "cli"
      ? new CliTransport({ env, timeoutMs: 25_000 })
      : new McpStdioTransport({ env, modules: ["spot"], readOnly: false, callTimeoutMs: 25_000 });
  const atk = new OkxAtkClient(transport);
  const market = new OkxPublicMarketData({ site: env.site, demo: true });
  console.log(`ATK spike — transport=${kind} site=${env.site} demo=true instId=${instId}\n`);

  if (transport instanceof McpStdioTransport) {
    await step("S1", "Does okx-trade-mcp expose spot_place_order/cancel/get without a confirmation step?", async () => {
      const tools = await transport.listTools();
      const need = ["spot_place_order", "spot_cancel_order", "spot_get_order"];
      const missing = need.filter((t) => !tools.includes(t));
      return missing.length
        ? { status: "FAIL", finding: `missing tools: ${missing.join(", ")}`, data: tools }
        : { status: "PASS", finding: `${tools.length} tools; spot write tools present`, data: tools };
    });
  }

  let inst = null as InstrumentInfo | null;
  await step("S2", `Instrument metadata for ${instId} (lotSz/tickSz/minSz) on site ${env.site} demo`, async () => {
    inst = await market.getInstrument(instId);
    return inst ? { status: "PASS", finding: JSON.stringify(inst), data: inst } : { status: "FAIL", finding: "instrument not live / not found" };
  });
  if (!inst) return finish(transport);
  const I: InstrumentInfo = inst;
  const minSz = I.minSz ?? I.lotSz;

  let last = "0";
  await step("S3", "Demo ticker available (x-simulated-trading: 1)?", async () => {
    const t = await market.getTicker(instId);
    last = t.last;
    return { status: "PASS", finding: `bid ${t.bid} ask ${t.ask} last ${t.last}, age ${Math.floor(Date.now() / 1000) - t.ts}s`, data: t };
  });

  // S4/S5: the core question — is a market BUY with tgtCcy=base_ccy sized in base units?
  const buyId = newClOrdId();
  const buy: NormalizedOrder = { tool: "spot_place_order", instId, side: "buy", ordType: "market", sz: minSz, tgtCcy: "base_ccy", clOrdId: buyId };
  let bought = "0";
  await step("S4", `Market buy sz=${minSz} tgtCcy=base_ccy clOrdId=${buyId} (32 chars) accepted, no prompt?`, async () => {
    const r = await atk.placeSpotOrder(buy);
    return r.ok ? { status: "PASS", finding: `ordId ${r.ordId}`, data: r.raw } : { status: "FAIL", finding: `rejected ${r.code}: ${r.msg}`, data: r.raw };
  });
  await step("S5", "Fill size: base units (accFillSz ≈ sz) or quote (accFillSz × avgPx ≈ sz)?", async () => {
    const o = await pollOrder(atk, instId, buyId, (s) => s === "filled" || s === "canceled");
    if (!o) return { status: "FAIL", finding: "order not found by clOrdId" };
    const raw = o.raw as Record<string, string>;
    bought = o.accFillSz;
    const avgPx = raw.avgPx && dec(raw.avgPx).gt("0") ? raw.avgPx : last;
    const baseMatch = dec(o.accFillSz).sub(minSz).abs().lte(I.lotSz);
    const quoteValue = dec(o.accFillSz).mul(avgPx).toString();
    const verdict = baseMatch ? "BASE units — keep tgtCcy=base_ccy and notional = sz × ask" : `NOT base: filled ${o.accFillSz} (≈ ${quoteValue} quote)`;
    return { status: baseMatch ? "PASS" : "FAIL", finding: `state ${o.state}, accFillSz ${o.accFillSz}, avgPx ${avgPx}, fee ${raw.fee} ${raw.feeCcy}. ${verdict}`, data: raw };
  });

  await step("S6", "Market sell back the filled amount (cleanup; sell semantics in base units)", async () => {
    if (!dec(bought).gt("0")) return { status: "SKIP", finding: "nothing bought" };
    const sellId = newClOrdId();
    const sz = dec(bought).floorToStep(I.lotSz).toFixed(Math.max(0, I.lotSz.split(".")[1]?.length ?? 0));
    const r = await atk.placeSpotOrder({ tool: "spot_place_order", instId, side: "sell", ordType: "market", sz, tgtCcy: "base_ccy", clOrdId: sellId });
    if (!r.ok) return { status: "INFO", finding: `sell rejected ${r.code}: ${r.msg} (fees may have reduced the balance below sz)`, data: r.raw };
    const o = await pollOrder(atk, instId, sellId, (s) => s === "filled");
    return { status: o?.state === "filled" ? "PASS" : "INFO", finding: `state ${o?.state} accFillSz ${o?.accFillSz}`, data: o?.raw };
  });

  // S7: duplicate clOrdId must be rejected by OKX itself (backstop for INV-8).
  const restingId = newClOrdId();
  const farPx = dec(last).mul("0.5").floorToStep(I.tickSz).toFixed(Math.max(0, I.tickSz.split(".")[1]?.length ?? 0));
  const resting: NormalizedOrder = { tool: "spot_place_order", instId, side: "buy", ordType: "limit", sz: minSz, px: farPx, clOrdId: restingId };
  let restingOrdId: string | undefined;
  await step("S7a", `Resting limit buy at ${farPx} (50% below last)`, async () => {
    const r = await atk.placeSpotOrder(resting);
    if (r.ok) restingOrdId = r.ordId;
    return r.ok ? { status: "PASS", finding: `ordId ${r.ordId}` } : { status: "FAIL", finding: `rejected ${r.code}: ${r.msg}`, data: r.raw };
  });
  await step("S7b", "Same clOrdId again -> definite rejection (expected 51016 Duplicated clOrdId)?", async () => {
    const r = await atk.placeSpotOrder(resting);
    if (r.ok) return { status: "FAIL", finding: `DUPLICATE ACCEPTED as ${r.ordId} — OKX does not dedupe clOrdId; executor nonce/WAL is the only guard` };
    return { status: "PASS", finding: `rejected with code ${r.code}: ${r.msg}`, data: r.raw };
  });
  await step("S7c", "Query the resting order by clOrdId -> live", async () => {
    const o = await atk.getOrderByClOrdId(instId, restingId);
    return { status: o?.state === "live" ? "PASS" : "FAIL", finding: `state ${o?.state}`, data: o?.raw };
  });
  await step("S7d", "Cancel the resting order by ordId", async () => {
    if (!restingOrdId) return { status: "SKIP", finding: "no resting order" };
    const r = await atk.cancelSpotOrder({ tool: "spot_cancel_order", instId, cancel: { ordId: restingOrdId } });
    return r.ok ? { status: "PASS", finding: "cancelled" } : { status: "FAIL", finding: `cancel rejected ${r.code}: ${r.msg}`, data: r.raw };
  });

  await step("S8", "clOrdId of 33 chars -> definite rejection (classifier must not call it uncertain)", async () => {
    try {
      const r = await atk.placeSpotOrder({ ...resting, clOrdId: `${newClOrdId()}x` });
      if (r.ok) {
        await atk.cancelSpotOrder({ tool: "spot_cancel_order", instId, cancel: { ordId: r.ordId } });
        return { status: "FAIL", finding: "33-char clOrdId ACCEPTED (limit is not 32?) — cancelled it" };
      }
      return { status: "PASS", finding: `rejected with code ${r.code}: ${r.msg}`, data: r.raw };
    } catch (e) {
      if (e instanceof AtkUncertainError) return { status: "FAIL", finding: `classified UNCERTAIN (${e.reason}) — add this code to the definite list if OKX documents it`, data: e.raw };
      throw e;
    }
  });

  await step("S9", "Query a never-placed clOrdId -> null (51603 'Order does not exist')", async () => {
    const o = await atk.getOrderByClOrdId(instId, newClOrdId());
    return { status: o === null ? "PASS" : "FAIL", finding: o === null ? "null" : `unexpected ${JSON.stringify(o)}` };
  });

  if (flag("probe-default-tgtccy")) {
    await step("S10", `Market buy sz=${minSz} WITHOUT tgtCcy (what is OKX's default unit?)`, async () => {
      const id = newClOrdId();
      const r = await atk.placeSpotOrder({ tool: "spot_place_order", instId, side: "buy", ordType: "market", sz: minSz, clOrdId: id });
      if (!r.ok) return { status: "INFO", finding: `rejected ${r.code}: ${r.msg} — consistent with quote-currency default (sz too small as USDT)`, data: r.raw };
      const o = await pollOrder(atk, instId, id, (s) => s === "filled");
      return { status: "INFO", finding: `filled accFillSz ${o?.accFillSz} (base default if ≈ ${minSz})`, data: o?.raw };
    });
  } else {
    steps.push({ id: "S10", question: "Default tgtCcy for market buy", status: "SKIP", finding: "pass --probe-default-tgtccy to test" });
  }

  return finish(transport);
}

async function finish(transport: AtkTransport) {
  await transport.close();
  const dir = join(process.cwd(), "spike-results");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `atk-spike-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const summary = {
    ranAt: new Date().toISOString(),
    site: process.env.OKX_SITE ?? "global",
    transport: opt("transport", "mcp"),
    instId: opt("instId", "BTC-USDT"),
    passed: steps.filter((s) => s.status === "PASS").length,
    failed: steps.filter((s) => s.status === "FAIL").length,
    steps,
  };
  writeFileSync(file, JSON.stringify(summary, null, 2));
  console.log(`\n${summary.passed} passed, ${summary.failed} failed -> ${file}`);
  process.exit(summary.failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
