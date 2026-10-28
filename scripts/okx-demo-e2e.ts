/**
 * OKX demo E2E through the REAL gateway (L3–L5, L7) and executor (L6) over the real ATK path:
 *   limit BUY → ACK · same signed request again → no second write · duplicate clOrdId at OKX (direct ATK call, the
 *   exchange's own backstop) · cancel through the gateway · limit SELL → ACK → cancel · lost reply → UNKNOWN →
 *   reconcile by clOrdId → ACK, never resent. Market BUY stays disabled.
 *
 *   OKX_MODE=atk npm run e2e:okx-demo   # needs .env: OKX_READ_* (read-only key) + OKX_TRADE_* (Read+Trade, NO withdraw),
 *                                       #   OKX_PROFILE=demo, OKX_SITE=global; `npm i -g @okx_ai/okx-trade-mcp`
 *   npm run e2e:okx-demo                # dry run against the simulated exchange (no keys)
 *
 * Orders rest 2% away from the touch and are cancelled; size OKX_E2E_SZ (default 0.0001 BTC).
 */
import { randomBytes } from "node:crypto";
import { privateKeyToAccount, type IntentResponse, type OrderIntent } from "@leashagent/shared";
import { IntentBuilder, LeashClient } from "@leashagent/agent";
import { OkxPublicMarketData } from "@leashagent/atk";
import { buildDevGateway } from "./lib/devGateway";

const live = process.env.OKX_MODE === "atk";
const SZ = process.env.OKX_E2E_SZ ?? "0.0001";
const INST = "BTC-USDT";

const g = await buildDevGateway({
  exchange: live ? "okx" : "fake",
  credits: "unlimited",
  limits: { maxPriceDeviationBps: 500, maxOrderNotionalUsdt: "1000", escalateAboveUsdt: "1000" },
});
const url = await g.listen();
const acct = privateKeyToAccount(g.agentKey);
const { policyId, agentId } = g.policy.binding;
const client = new LeashClient(url, acct, policyId);
const builder = new IntentBuilder(acct, policyId, agentId);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond: boolean, label: string, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label.padEnd(58)} OKX writes ${String(g.atk.writes.length).padStart(2)}  ${detail}`);
  if (!cond) failures++;
};
const info = (label: string, detail: string) => console.log(`ℹ ${label.padEnd(58)} ${detail}`);
const get = async (id: string) => (await (await fetch(`${url}/v1/intents/${id}`)).json()) as IntentResponse & { order?: { clOrdId?: string } };
async function until(id: string, want: RegExp, ms = 20_000): Promise<string> {
  let s = "";
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(1000)) {
    s = (await get(id)).status;
    if (want.test(s)) return s;
    await g.app.tick(); // maintenance: executor reconciliation by clOrdId (read-only)
  }
  return s;
}

// Prices 2% away from the touch: resting orders, inside the 500 bps deviation limit.
let bid = 60000, ask = 60000;
if (live) {
  const t = await new OkxPublicMarketData({ site: (process.env.OKX_SITE ?? "global") as "global", demo: true }).getTicker(INST);
  bid = Number(t.bid); ask = Number(t.ask);
}
const buyPx = (bid * 0.98).toFixed(1), sellPx = (ask * 1.02).toFixed(1);
const limit = (side: "buy" | "sell", px: string): OrderIntent => ({ tool: "spot_place_order", instId: INST, side, ordType: "limit", sz: SZ, px });
const cancel = (clOrdId: string): OrderIntent => ({ tool: "spot_cancel_order", instId: INST, clOrdIdToCancel: clOrdId });

console.log(`OKX demo E2E — ${live ? `REAL OKX DEMO via ATK (site ${process.env.OKX_SITE ?? "global"})` : "DRY RUN (simulated exchange, no keys)"}  bid ${bid} ask ${ask}\n`);

// 1. limit BUY
const buyReq = await builder.build(limit("buy", buyPx), "e2e: resting limit buy", []);
const buy = await client.submitIntent(buyReq);
const buyState = await until(buy.requestId, /ACKNOWLEDGED|FILLED|PARTIALLY_FILLED/);
ok(/ACKNOWLEDGED|FILLED|PARTIALLY_FILLED/.test(buyState), `limit BUY ${SZ} @ ${buyPx}`, buyState);
const buyClOrdId = (await get(buy.requestId)).order?.clOrdId ?? "";

// 2. same signed request again
const w2 = g.atk.writes.length;
const again = await client.submitIntent(buyReq);
ok(again.requestId === buy.requestId && g.atk.writes.length === w2, "same signed request again → existing state, no 2nd write", again.status);

// 3. duplicate clOrdId straight at the exchange (bypasses Leash Agent on purpose: tests OKX's own backstop)
const dup = live
  ? await g.exchange.placeSpotOrder({ tool: "spot_place_order", instId: INST, side: "buy", ordType: "limit", sz: SZ, px: buyPx, clOrdId: buyClOrdId })
  : null;
if (!dup) {
  info("duplicate clOrdId at OKX (direct ATK call)", "skipped in dry run: only meaningful against the real exchange");
} else if (dup.ok) {
  info("duplicate clOrdId at OKX (direct ATK call)", `ACCEPTED as ${dup.ordId} — OKX does not dedupe; the executor's nonce/WAL is the guard. Cancelling it.`);
  await g.exchange.cancelSpotOrder({ tool: "spot_cancel_order", instId: INST, cancel: { ordId: dup.ordId } });
} else {
  ok(true, "duplicate clOrdId at OKX (direct ATK call) → rejected", `${dup.code} ${dup.msg}`);
}

// 4. cancel through the gateway (protective: no credit, allowed while paused for own open orders)
if (/ACKNOWLEDGED|PARTIALLY_FILLED/.test(buyState)) {
  const c = await client.submitIntent(await builder.build(cancel(buyClOrdId), "e2e: cancel", []));
  const cs = await until(c.requestId, /CANCELLED|ACKNOWLEDGED|FILLED/);
  const orig = await until(buy.requestId, /CANCELLED|FILLED/);
  ok(orig === "CANCELLED", "cancel through the gateway → original order CANCELLED", `cancel ${cs}, order ${orig}`);
} else info("cancel", "skipped: the buy filled immediately");

// 5. limit SELL → ACK → cancel
const sell = await client.submitIntent(await builder.build(limit("sell", sellPx), "e2e: resting limit sell", []));
if (sell.status === "REJECTED_POLICY" || sell.status === "BLOCKED") {
  info(`limit SELL ${SZ} @ ${sellPx}`, `${sell.status} ${sell.reasonCode ?? ""} — no free base balance on the account (fund the demo account with BTC)`);
} else {
  const ss = await until(sell.requestId, /ACKNOWLEDGED|FILLED|PARTIALLY_FILLED/);
  ok(/ACKNOWLEDGED|FILLED|PARTIALLY_FILLED/.test(ss), `limit SELL ${SZ} @ ${sellPx}`, ss);
  if (ss === "ACKNOWLEDGED") {
    const sc = await client.submitIntent(await builder.build(cancel((await get(sell.requestId)).order?.clOrdId ?? ""), "e2e: cancel sell", []));
    await until(sc.requestId, /CANCELLED|ACKNOWLEDGED/);
    ok((await until(sell.requestId, /CANCELLED|FILLED/)) === "CANCELLED", "cancel the SELL", "");
  }
}

// 6. lost reply → UNKNOWN → reconcile → never resent
g.atk.loseNextReply = true;
const lost = await client.submitIntent(await builder.build(limit("buy", buyPx), "e2e: lost reply", []));
const lostClOrdId = (await get(lost.requestId)).order?.clOrdId ?? "";
ok(lost.status === "UNKNOWN", "reply lost after the order reached OKX → UNKNOWN (not resent)", lost.status);
const rec = await until(lost.requestId, /ACKNOWLEDGED|FILLED|PARTIALLY_FILLED|CANCELLED/);
const sends = g.atk.writes.filter((w) => w.kind === "place" && w.clOrdId === lostClOrdId).length;
ok(/ACKNOWLEDGED|FILLED|PARTIALLY_FILLED/.test(rec) && sends === 1, "reconcile by clOrdId resolves it; exactly 1 write", `${rec}, writes for this clOrdId: ${sends}`);
if (rec === "ACKNOWLEDGED") {
  const lc = await client.submitIntent(await builder.build(cancel(lostClOrdId), "e2e: cleanup", []));
  await until(lc.requestId, /CANCELLED|ACKNOWLEDGED/);
  await until(lost.requestId, /CANCELLED|FILLED/);
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`} — ${g.atk.writes.length} exchange writes through the executor, ` +
  `${g.atk.writes.filter((w) => w.kind === "place").length} placements, ${g.atk.writes.filter((w) => w.kind === "cancel").length} cancels`);
if (failures) process.exitCode = 1;
g.close();
await sleep(200);
process.exit();
