import { dec, isDec, type Dec, type EpochSec, type Hex } from "@leashagent/shared";
import type { AtkTransport } from "./types";

// Read-key account data for L5 (§6.5 RiskProvider) and L4 (§6.4 verifiedProtectiveAction).
// Structurally matches @leashagent/gateway AccountState / RiskProvider / OrderOwnershipVerifier.

export type OkxAccountState = {
  fetchedAt: EpochSec;
  dailyPnlUsdt: Dec;
  openNotionalUsdt: Dec;
  pendingOrdersNotionalUsdt: Dec;
  baseBalances: Record<string, Dec>;
  lockedBySellOrders: Record<string, Dec>;
};

/**
 * Persists the account equity at the start of each UTC day, so daily PnL survives restarts (§6.5).
 * `setIfAbsent` returns the stored baseline (the first value written for that day wins).
 */
export interface EquityBaselineStore {
  setIfAbsent(policyId: Hex, utcDay: string, equityUsdt: Dec): Dec;
}

export type OkxAccountOptions = {
  /** Quote currency of the managed spot pairs (notional unit). */
  quoteCcy?: string;
  baseline: EquityBaselineStore;
  clock?: () => EpochSec;
};

/** OKX returns "" for unset numeric fields; anything non-decimal is a hard error (fail closed). */
function num(v: unknown, field: string, allowEmpty = true): Dec {
  if ((v === "" || v === undefined || v === null) && allowEmpty) return "0";
  const s = String(v);
  if (!isDec(s)) throw new Error(`malformed OKX field ${field}: ${s}`);
  return s;
}

function rows(r: Awaited<ReturnType<AtkTransport["callTool"]>>, what: string): Record<string, unknown>[] {
  if (!r.ok) throw new Error(`${what} failed: ${r.error.type}${r.error.code ? ` ${r.error.code}` : ""}`);
  const d = r.response.data;
  if (!Array.isArray(d)) throw new Error(`${what}: unexpected response`);
  return d as Record<string, unknown>[];
}

/**
 * RiskProvider over ATK with the **read-only** key (`okx-trade-mcp --modules account,spot --read-only`).
 *
 *  - baseBalances[ccy]       = cashBal (total, verified by OKX)
 *  - lockedBySellOrders[ccy] = Σ (sz − accFillSz) of open SELL orders on <ccy>-<quote>
 *  - pendingOrdersNotional   = Σ (sz − accFillSz) × px of open BUY orders (quote units)
 *  - openNotional            = Σ eqUsd of non-quote holdings (actual position)
 *  - dailyPnl                = totalEq now − totalEq at UTC day start (realized + unrealized, fees included)
 *
 * Unverified (§19.7): totalEq/eqUsd are USD while limits are USDT (≈ 1:1); a deposit or transfer during
 * the day moves equity and therefore daily PnL. Any read or parse failure throws, which the gateway
 * treats as stale data (fail closed for risk-increasing orders).
 */
export class OkxRiskProvider {
  private readonly quote: string;

  constructor(private readonly t: AtkTransport, private readonly o: OkxAccountOptions) {
    this.quote = o.quoteCcy ?? "USDT";
  }

  private now(): EpochSec {
    return (this.o.clock ?? (() => Math.floor(Date.now() / 1000)))();
  }

  async getAccountState(policyId: Hex): Promise<OkxAccountState> {
    const fetchedAt = this.now();
    const [balR, ordR] = await Promise.all([
      this.t.callTool("account_get_balance", {}),
      this.t.callTool("spot_get_open_orders", { instType: "SPOT" }),
    ]);

    const bal = rows(balR, "account_get_balance")[0];
    if (!bal) throw new Error("account_get_balance: empty");
    const totalEq = num(bal.totalEq, "totalEq", false);
    const baseBalances: Record<string, Dec> = {};
    let openNotional = dec("0");
    for (const d of (bal.details as Record<string, unknown>[] | undefined) ?? []) {
      const ccy = String(d.ccy);
      baseBalances[ccy] = num(d.cashBal, `${ccy}.cashBal`);
      if (ccy !== this.quote) openNotional = openNotional.add(num(d.eqUsd, `${ccy}.eqUsd`));
    }

    const lockedBySellOrders: Record<string, Dec> = {};
    let pending = dec("0");
    for (const o of rows(ordR, "spot_get_open_orders")) {
      const instId = String(o.instId);
      const [base, quote] = instId.split("-");
      if (!base || quote !== this.quote) continue;
      const remaining = dec(num(o.sz, `${instId}.sz`, false)).sub(num(o.accFillSz, `${instId}.accFillSz`));
      if (remaining.isNegative() || remaining.isZero()) continue;
      if (o.side === "sell") {
        lockedBySellOrders[base] = dec(lockedBySellOrders[base] ?? "0").add(remaining).toString();
      } else {
        // Resting buy: committed quote = remaining × px. A market buy has no px; its notional is
        // already counted by the gateway's reservation until the exchange reflects it.
        const px = num(o.px, `${instId}.px`);
        pending = pending.add(remaining.mul(px));
      }
    }

    const day = new Date(fetchedAt * 1000).toISOString().slice(0, 10);
    const baseline = this.o.baseline.setIfAbsent(policyId, day, totalEq);
    return {
      fetchedAt,
      dailyPnlUsdt: dec(totalEq).sub(baseline).toString(),
      openNotionalUsdt: openNotional.toString(),
      pendingOrdersNotionalUsdt: pending.toString(),
      baseBalances,
      lockedBySellOrders,
    };
  }
}

const OPEN_STATES = new Set(["live", "partially_filled"]);

/**
 * OrderOwnershipVerifier over the read-only key: an order is a verified own open order only if OKX
 * returns it for this account's key in an open state. "Order does not exist" (51603) means not ours or
 * not open; any other failure throws (protective exception not granted).
 */
export class OkxOrderOwnershipVerifier {
  constructor(private readonly t: AtkTransport, private readonly clock: () => EpochSec = () => Math.floor(Date.now() / 1000)) {}

  async isOwnOpenOrder(_policyId: Hex, instId: string, ref: { ordId?: string; clOrdId?: string }) {
    if (!ref.ordId && !ref.clOrdId) return { open: false, fetchedAt: this.clock() };
    const args: Record<string, unknown> = { instId };
    if (ref.ordId) args.ordId = ref.ordId;
    else args.clOrdId = ref.clOrdId;
    const r = await this.t.callTool("spot_get_order", args);
    const fetchedAt = this.clock();
    if (!r.ok) {
      if (r.error.code === "51603") return { open: false, fetchedAt };
      throw new Error(`order lookup failed: ${r.error.type}${r.error.code ? ` ${r.error.code}` : ""}`);
    }
    const row = Array.isArray(r.response.data) ? (r.response.data[0] as Record<string, unknown> | undefined) : undefined;
    const matches = !!row && row.instId === instId && (ref.ordId ? row.ordId === ref.ordId : row.clOrdId === ref.clOrdId);
    return { open: matches && OPEN_STATES.has(String(row!.state)), fetchedAt };
  }
}
