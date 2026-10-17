import { describe, expect, it } from "vitest";
import { dec, type Hex } from "@leashagent/shared";
import { OkxOrderOwnershipVerifier, OkxRiskProvider, type AtkCallResult, type AtkTransport, type EquityBaselineStore } from "../src";

const P = ("0x" + "ab".repeat(32)) as Hex;

/** Transport answering ATK tool calls from a table (shape of ATK's normalized response). */
function fake(answers: Record<string, AtkCallResult | ((a: Record<string, unknown>) => AtkCallResult)>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const t: AtkTransport = {
    async callTool(name, args) {
      calls.push({ name, args });
      const a = answers[name];
      if (!a) throw new Error(`unexpected tool ${name}`);
      return typeof a === "function" ? a(args) : a;
    },
    async close() {},
  };
  return { t, calls };
}
const ok = (data: unknown[]): AtkCallResult => ({ ok: true, response: { data } });

class MemBaseline implements EquityBaselineStore {
  readonly m = new Map<string, string>();
  setIfAbsent(policyId: Hex, day: string, eq: string) {
    const k = `${policyId}:${day}`;
    if (!this.m.has(k)) this.m.set(k, eq);
    return this.m.get(k)!;
  }
}

const balance = (totalEq: string, details: Record<string, string>[]) => ok([{ totalEq, details }]);

describe("OkxRiskProvider", () => {
  it("derives balances, locked sells, pending buys, open notional and daily PnL", async () => {
    let now = Date.UTC(2026, 9, 17, 8) / 1000;
    let eq = "10000";
    const { t } = fake({
      account_get_balance: () => balance(eq, [
        { ccy: "USDT", cashBal: "4000", eqUsd: "4000" },
        { ccy: "BTC", cashBal: "0.1", eqUsd: "6000" },
      ]),
      spot_get_orders: ok([
        { instId: "BTC-USDT", side: "sell", sz: "0.05", accFillSz: "0.01", px: "70000", state: "live" },
        { instId: "BTC-USDT", side: "buy", sz: "0.002", accFillSz: "", px: "50000", state: "live" },
        { instId: "ETH-BTC", side: "buy", sz: "1", accFillSz: "0", px: "0.05", state: "live" }, // not a USDT pair
      ]),
    });
    const baseline = new MemBaseline();
    const p = new OkxRiskProvider(t, { baseline, clock: () => now });
    const a = await p.getAccountState(P);
    expect(a.baseBalances).toEqual({ USDT: "4000", BTC: "0.1" });
    expect(a.lockedBySellOrders).toEqual({ BTC: "0.04" });
    expect(dec(a.pendingOrdersNotionalUsdt).eq("100")).toBe(true);
    expect(dec(a.openNotionalUsdt).eq("6000")).toBe(true);
    expect(dec(a.dailyPnlUsdt).isZero()).toBe(true);

    eq = "9850"; // fees + price move
    now += 3600;
    expect((await p.getAccountState(P)).dailyPnlUsdt).toBe("-150");

    now += 24 * 3600; // new UTC day: new baseline
    expect(dec((await p.getAccountState(P)).dailyPnlUsdt).isZero()).toBe(true);
  });

  it("fails closed on read errors and malformed numbers", async () => {
    const err: AtkCallResult = { ok: false, error: { type: "NetworkError", message: "x" } };
    const p1 = new OkxRiskProvider(fake({ account_get_balance: err, spot_get_orders: ok([]) }).t, { baseline: new MemBaseline() });
    await expect(p1.getAccountState(P)).rejects.toThrow();
    const p2 = new OkxRiskProvider(
      fake({ account_get_balance: balance("1e4", []), spot_get_orders: ok([]) }).t,
      { baseline: new MemBaseline() },
    );
    await expect(p2.getAccountState(P)).rejects.toThrow(/malformed/);
  });
});

describe("OkxOrderOwnershipVerifier", () => {
  const order = (state: string) => ok([{ instId: "BTC-USDT", ordId: "42", clOrdId: "la1", state }]);

  it("open own order -> open; filled/cancelled -> not open", async () => {
    expect((await new OkxOrderOwnershipVerifier(fake({ spot_get_order: order("live") }).t).isOwnOpenOrder(P, "BTC-USDT", { ordId: "42" })).open).toBe(true);
    expect((await new OkxOrderOwnershipVerifier(fake({ spot_get_order: order("partially_filled") }).t).isOwnOpenOrder(P, "BTC-USDT", { ordId: "42" })).open).toBe(true);
    expect((await new OkxOrderOwnershipVerifier(fake({ spot_get_order: order("filled") }).t).isOwnOpenOrder(P, "BTC-USDT", { ordId: "42" })).open).toBe(false);
  });

  it("51603 (not this account's order) -> not open; other errors throw", async () => {
    const nf: AtkCallResult = { ok: false, error: { type: "OkxApiError", code: "51603", message: "Order does not exist" } };
    expect((await new OkxOrderOwnershipVerifier(fake({ spot_get_order: nf }).t).isOwnOpenOrder(P, "BTC-USDT", { ordId: "1" })).open).toBe(false);
    const ne: AtkCallResult = { ok: false, error: { type: "NetworkError", message: "x" } };
    await expect(new OkxOrderOwnershipVerifier(fake({ spot_get_order: ne }).t).isOwnOpenOrder(P, "BTC-USDT", { ordId: "1" })).rejects.toThrow();
  });

  it("a response for a different order/instrument is not accepted", async () => {
    const other = ok([{ instId: "ETH-USDT", ordId: "42", state: "live" }]);
    expect((await new OkxOrderOwnershipVerifier(fake({ spot_get_order: other }).t).isOwnOpenOrder(P, "BTC-USDT", { ordId: "42" })).open).toBe(false);
  });
});
