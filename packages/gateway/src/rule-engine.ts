import {
  REASON,
  dec,
  type Dec,
  type EpochSec,
  type Policy,
  type RiskSnapshot,
  type RuleResult,
  type RuleViolation,
  type ValidatedIntent,
} from "@bekci/shared";
import type { Ticker } from "./ports";

/**
 * Everything the rules may look at. Gathered by the PolicyEngine beforehand; `null` means
 * "could not be obtained" and is treated fail-closed.
 */
export type RuleInputs = {
  now: EpochSec;
  policy: Policy;
  /** Delegation expiry from the chain record (authoritative over the policy document). */
  delegationValidUntil: EpochSec;
  paused: boolean;
  risk: RiskSnapshot | null;
  /** Required for place orders. */
  ticker: Ticker | null;
  /** Sells only: total − locked by open sells − reserved sells. */
  sellAvailable: { available: Dec; fetchedAt: EpochSec } | null;
  /** Cancels only: OKX-verified "open order of this accountRef". */
  ownership: { open: boolean; fetchedAt: EpochSec } | null;
};

const fresh = (fetchedAt: EpochSec | undefined, now: EpochSec, maxAge: number) =>
  fetchedAt !== undefined && now - fetchedAt <= maxAge && fetchedAt <= now + 5;

/**
 * L4 RuleEngine (§6.4): pure, no I/O, no LLM. Derived fields are computed here only (INV-4);
 * nothing the agent sent besides the normalized order is consulted.
 */
export function evaluate(v: ValidatedIntent, x: RuleInputs): RuleResult {
  const { order } = v;
  const { policy, now } = x;
  const L = policy.limits;
  const F = policy.freshness;
  const violations: RuleViolation[] = [];
  const add = (rule: string, code: number, detail: string) => violations.push({ rule, code, detail });

  const riskFresh = fresh(x.risk?.fetchedAt, now, F.maxRiskDataAgeSec);
  const marketFresh = fresh(x.ticker?.ts, now, F.maxMarketDataAgeSec);

  // ---- derived fields ----
  let riskIncreasing: boolean;
  let verifiedProtectiveAction = false;
  let notionalUsdt: Dec = "0";
  let referencePrice: Dec | undefined;
  let priceDeviationBps: number | undefined;

  if (order.tool === "spot_cancel_order") {
    riskIncreasing = false;
    verifiedProtectiveAction =
      x.ownership !== null && x.ownership.open && fresh(x.ownership.fetchedAt, now, F.maxRiskDataAgeSec);
  } else if (order.side === "buy") {
    riskIncreasing = true;
  } else {
    // Sell: risk-reducing only with fresh, sufficient available inventory; otherwise invalid.
    riskIncreasing = false;
    const ok =
      x.sellAvailable !== null &&
      fresh(x.sellAvailable.fetchedAt, now, F.maxRiskDataAgeSec) &&
      dec(x.sellAvailable.available).gte(order.sz!);
    if (!ok) add("sell_inventory", REASON.SELL_INVENTORY, "sell exceeds fresh available base balance");
  }

  if (order.tool === "spot_place_order" && x.ticker) {
    const t = x.ticker;
    const sz = order.sz!;
    if (order.ordType === "limit") {
      notionalUsdt = dec(sz).mul(order.px!).toString();
    } else if (order.side === "buy") {
      const base = dec(sz).mul(t.ask);
      notionalUsdt = base.add(base.mulBps(L.marketSlippageBufferBps).toString()).toString();
    } else {
      notionalUsdt = dec(sz).mul(t.bid).toString();
    }
    // Deviation of the proposed (limit) or executable (market) price from the last trade price.
    referencePrice = t.last;
    const proposed = order.ordType === "limit" ? order.px! : order.side === "buy" ? t.ask : t.bid;
    if (dec(t.last).gt("0")) {
      const diff = dec(proposed).sub(t.last).abs();
      priceDeviationBps = Number(diff.mul("10000").divFloor(t.last, 0).toString());
      // exact comparison: diff * 10000 > maxBps * last
      if (diff.mul("10000").gt(dec(t.last).mul(String(L.maxPriceDeviationBps)).toString())) {
        add("price_deviation", REASON.PRICE_DEVIATION, `deviation ${priceDeviationBps}bps > ${L.maxPriceDeviationBps}bps`);
      }
    }
  }

  // ---- rule table (§6.4) ----
  if (now > x.delegationValidUntil) add("delegation_expiry", REASON.POLICY_UNVERIFIED, "delegation expired");
  if (x.paused && !verifiedProtectiveAction) add("pause", REASON.PAUSED, "policy paused");

  // Freshness: risk-increasing orders need fresh risk + market data. Place orders always need a
  // ticker to compute notional/deviation, so a missing ticker is stale data for sells too.
  if (riskIncreasing && (!riskFresh || !marketFresh)) {
    add("freshness", REASON.STALE_DATA, "risk or market data stale/missing");
  } else if (order.tool === "spot_place_order" && !marketFresh) {
    add("freshness", REASON.STALE_DATA, "market data stale/missing");
  }

  if (!policy.allowedInstruments.includes(order.instId)) add("instrument", REASON.INSTRUMENT, order.instId);
  if (!policy.allowedTools.includes(order.tool)) add("tool", REASON.TOOL, order.tool);

  if (order.tool === "spot_place_order") {
    if (dec(notionalUsdt).gt(L.maxOrderNotionalUsdt)) {
      add("single_order", REASON.SINGLE_ORDER_LIMIT, `${notionalUsdt} > ${L.maxOrderNotionalUsdt}`);
    }
    // L3 records this request's rate event before L4 runs, so the count includes it:
    // "ordersLastMinute(prior) >= max" <=> "count(including self) > max".
    if (x.risk && x.risk.ordersLastMinute > L.maxOrdersPerMinute) {
      add("rate", REASON.RATE, `${x.risk.ordersLastMinute} > ${L.maxOrdersPerMinute}/min`);
    }
  }

  if (riskIncreasing && x.risk) {
    const total = dec(x.risk.openNotionalUsdt)
      .add(x.risk.pendingOrdersNotionalUsdt)
      .add(x.risk.reservedNotionalUsdt)
      .add(notionalUsdt);
    if (total.gt(L.maxOpenNotionalUsdt)) add("open_notional", REASON.OPEN_NOTIONAL, `${total.toString()} > ${L.maxOpenNotionalUsdt}`);
    if (dec(x.risk.dailyPnlUsdt).lte(dec(L.maxDailyLossUsdt).neg().toString())) {
      add("daily_loss", REASON.DAILY_LOSS, `pnl ${x.risk.dailyPnlUsdt}`);
    }
  }

  const escalate = order.tool === "spot_place_order" && dec(notionalUsdt).gt(L.escalateAboveUsdt);

  const derived: RuleResult["derived"] = { riskIncreasing, verifiedProtectiveAction, notionalUsdt };
  if (referencePrice !== undefined) derived.referencePrice = referencePrice;
  if (priceDeviationBps !== undefined) derived.priceDeviationBps = priceDeviationBps;

  return { pass: violations.length === 0, violations, escalate, derived };
}
