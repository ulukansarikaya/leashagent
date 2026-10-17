import { describe, expect, it } from "vitest";
import { ReasonCodes, dec, hashCanonical, normalizeOrder, type OrderIntent, type Policy, type RiskSnapshot } from "@leashagent/shared";
import { BTC_USDT, limitBuy, mockPolicy } from "@leashagent/mocks";
import { evaluate, type RuleInputs } from "../src";

const NOW = 1_760_000_000;
const AGENT = "0x2222222222222222222222222222222222222222" as const;

function vi(intent: OrderIntent, policy: Policy) {
  const order = normalizeOrder(intent, BTC_USDT, "11111111-1111-4111-8111-111111111111", policy.binding.policyId);
  return {
    request: {
      requestId: "11111111-1111-4111-8111-111111111111", policyId: policy.binding.policyId, agentId: policy.binding.agentId,
      issuedAt: NOW, authNonce: ("0x" + "00".repeat(16)) as `0x${string}`, intent, agentReason: "", referencedReadIds: [],
      agentSignature: "0x" as `0x${string}`,
    },
    order,
    normalizedOrderHash: hashCanonical(order),
    receivedAt: NOW,
  };
}

function inputs(policy: Policy, patch: Partial<RuleInputs> = {}, risk: Partial<RiskSnapshot> = {}): RuleInputs {
  return {
    now: NOW,
    policy,
    delegationValidUntil: NOW + 3600,
    paused: false,
    risk: {
      policyId: policy.binding.policyId, fetchedAt: NOW, dailyPnlUsdt: "0", openNotionalUsdt: "0",
      pendingOrdersNotionalUsdt: "0", reservedNotionalUsdt: "0", baseBalances: { BTC: "1" }, ordersLastMinute: 1,
      ...risk,
    },
    ticker: { instId: "BTC-USDT", bid: "59990", ask: "60010", last: "60000", ts: NOW },
    sellAvailable: null,
    ownership: null,
    ...patch,
  };
}

const codes = (r: { violations: { code: number }[] }) => r.violations.map((v) => v.code).sort();

describe("RuleEngine — derived fields (INV-4)", () => {
  const policy = mockPolicy(AGENT, {}, NOW);

  it("limit buy: notional = sz × px, risk-increasing", () => {
    const r = evaluate(vi(limitBuy({ sz: "0.001", px: "60000" }), policy), inputs(policy));
    expect(r.pass).toBe(true);
    expect(r.derived).toMatchObject({ riskIncreasing: true, verifiedProtectiveAction: false, referencePrice: "60000", priceDeviationBps: 0 });
    expect(dec(r.derived.notionalUsdt).eq("60")).toBe(true);
  });

  it("market buy: notional = sz × ask × (1 + buffer)", () => {
    const r = evaluate(vi(limitBuy({ ordType: "market", px: undefined, sz: "0.001" }), policy), inputs(policy));
    // 0.001 * 60010 = 60.01 ; * 1.005 = 60.31005
    expect(r.derived.notionalUsdt.startsWith("60.31005")).toBe(true);
    expect(r.derived.riskIncreasing).toBe(true);
  });

  it("market sell: notional = sz × bid; risk-reducing only with fresh inventory", () => {
    const sell = vi(limitBuy({ side: "sell", ordType: "market", px: undefined, sz: "0.001" }), policy);
    const ok = evaluate(sell, inputs(policy, { sellAvailable: { available: "0.002", fetchedAt: NOW } }));
    expect(ok.pass).toBe(true);
    expect(ok.derived.riskIncreasing).toBe(false);
    expect(ok.derived.notionalUsdt.startsWith("59.99")).toBe(true);

    expect(codes(evaluate(sell, inputs(policy, { sellAvailable: { available: "0.0009", fetchedAt: NOW } })))).toEqual([ReasonCodes.SELL_INVENTORY]);
    expect(codes(evaluate(sell, inputs(policy, { sellAvailable: { available: "1", fetchedAt: NOW - 999 } })))).toEqual([ReasonCodes.SELL_INVENTORY]);
    expect(codes(evaluate(sell, inputs(policy, { sellAvailable: null })))).toEqual([ReasonCodes.SELL_INVENTORY]);
  });

  it("cancel is protective only with a fresh, verified own open order (INV-13)", () => {
    const cancel = vi({ tool: "spot_cancel_order", instId: "BTC-USDT", ordId: "1" }, policy);
    expect(evaluate(cancel, inputs(policy, { ownership: { open: true, fetchedAt: NOW } })).derived.verifiedProtectiveAction).toBe(true);
    expect(evaluate(cancel, inputs(policy, { ownership: { open: false, fetchedAt: NOW } })).derived.verifiedProtectiveAction).toBe(false);
    expect(evaluate(cancel, inputs(policy, { ownership: { open: true, fetchedAt: NOW - 999 } })).derived.verifiedProtectiveAction).toBe(false);
    expect(evaluate(cancel, inputs(policy, { ownership: null })).derived.verifiedProtectiveAction).toBe(false);
    expect(evaluate(cancel, inputs(policy)).derived.riskIncreasing).toBe(false);
  });
});

describe("RuleEngine — rule table", () => {
  const policy = mockPolicy(AGENT, {}, NOW);
  const buy = vi(limitBuy(), policy);

  it("003 delegation expired", () => {
    expect(codes(evaluate(buy, inputs(policy, { delegationValidUntil: NOW - 1 })))).toContain(ReasonCodes.POLICY_UNVERIFIED);
  });

  it("100 paused blocks everything except a verified protective cancel", () => {
    expect(codes(evaluate(buy, inputs(policy, { paused: true })))).toEqual([ReasonCodes.PAUSED]);
    const cancel = vi({ tool: "spot_cancel_order", instId: "BTC-USDT", ordId: "1" }, policy);
    expect(evaluate(cancel, inputs(policy, { paused: true, ownership: { open: true, fetchedAt: NOW } })).pass).toBe(true);
    expect(codes(evaluate(cancel, inputs(policy, { paused: true, ownership: { open: false, fetchedAt: NOW } })))).toEqual([ReasonCodes.PAUSED]);
  });

  it("110 stale / missing / future-dated data (INV-12)", () => {
    expect(codes(evaluate(buy, inputs(policy, {}, { fetchedAt: NOW - 31 })))).toEqual([ReasonCodes.STALE_DATA]);
    expect(codes(evaluate(buy, inputs(policy, { risk: null })))).toEqual([ReasonCodes.STALE_DATA]);
    expect(codes(evaluate(buy, inputs(policy, { ticker: null })))).toEqual([ReasonCodes.STALE_DATA]);
    const t = { instId: "BTC-USDT", bid: "59990", ask: "60010", last: "60000" };
    expect(codes(evaluate(buy, inputs(policy, { ticker: { ...t, ts: NOW - 11 } })))).toEqual([ReasonCodes.STALE_DATA]);
    expect(codes(evaluate(buy, inputs(policy, { ticker: { ...t, ts: NOW + 60 } })))).toEqual([ReasonCodes.STALE_DATA]);
  });

  it("stale data does not block a verified protective cancel", () => {
    const cancel = vi({ tool: "spot_cancel_order", instId: "BTC-USDT", ordId: "1" }, policy);
    expect(evaluate(cancel, inputs(policy, { risk: null, ticker: null, ownership: { open: true, fetchedAt: NOW } })).pass).toBe(true);
  });

  it("101 instrument / 102 tool", () => {
    const p = mockPolicy(AGENT, { allowedInstruments: ["ETH-USDT"], allowedTools: ["spot_cancel_order"] }, NOW);
    expect(codes(evaluate(vi(limitBuy(), p), inputs(p)))).toEqual([ReasonCodes.INSTRUMENT, ReasonCodes.TOOL]);
  });

  it("103 single order limit", () => {
    expect(codes(evaluate(vi(limitBuy({ sz: "0.0084" }), policy), inputs(policy)))).toEqual([ReasonCodes.SINGLE_ORDER_LIMIT]); // 504
    expect(evaluate(vi(limitBuy({ sz: "0.0083" }), policy), inputs(policy)).pass).toBe(true); // 498
  });

  it("104 open + pending + reserved + notional > max (risk-increasing only)", () => {
    const r = inputs(policy, {}, { openNotionalUsdt: "1000", pendingOrdersNotionalUsdt: "500", reservedNotionalUsdt: "441" });
    expect(codes(evaluate(buy, r))).toEqual([ReasonCodes.OPEN_NOTIONAL]); // 1941 + 60 > 2000
    const r2 = inputs(policy, {}, { openNotionalUsdt: "1000", pendingOrdersNotionalUsdt: "500", reservedNotionalUsdt: "440" });
    expect(evaluate(buy, r2).pass).toBe(true); // exactly 2000
  });

  it("105 rate: count includes this request", () => {
    expect(evaluate(buy, inputs(policy, {}, { ordersLastMinute: 5 })).pass).toBe(true);
    expect(codes(evaluate(buy, inputs(policy, {}, { ordersLastMinute: 6 })))).toEqual([ReasonCodes.RATE]);
  });

  it("106 daily loss (risk-increasing only)", () => {
    expect(codes(evaluate(buy, inputs(policy, {}, { dailyPnlUsdt: "-100" })))).toEqual([ReasonCodes.DAILY_LOSS]);
    expect(evaluate(buy, inputs(policy, {}, { dailyPnlUsdt: "-99.99" })).pass).toBe(true);
    const sell = vi(limitBuy({ side: "sell" }), policy);
    expect(evaluate(sell, inputs(policy, { sellAvailable: { available: "1", fetchedAt: NOW } }, { dailyPnlUsdt: "-500" })).pass).toBe(true);
  });

  it("107 price deviation, exact at the boundary", () => {
    expect(evaluate(vi(limitBuy({ px: "61200" }), policy), inputs(policy)).pass).toBe(true); // exactly 200 bps
    const r = evaluate(vi(limitBuy({ px: "61200.1" }), policy), inputs(policy));
    expect(codes(r)).toEqual([ReasonCodes.PRICE_DEVIATION]);
    expect(codes(evaluate(vi(limitBuy({ px: "58799.9" }), policy), inputs(policy)))).toEqual([ReasonCodes.PRICE_DEVIATION]);
  });

  it("escalate above threshold (not a violation)", () => {
    const r = evaluate(vi(limitBuy({ sz: "0.006" }), policy), inputs(policy)); // 360 > 300
    expect(r.pass).toBe(true);
    expect(r.escalate).toBe(true);
  });

  it("is pure: same inputs, same output", () => {
    const x = inputs(policy);
    expect(evaluate(buy, x)).toEqual(evaluate(buy, x));
  });
});
