import { SELL_INVENTORY_REASON } from "../src/limits";
import { describe, expect, it } from "vitest";
import { ReasonCodes, computeAuthHash, dec, recoverAuthorizationSigner } from "@bekci/shared";
import { limitBuy } from "@bekci/mocks";
import { harness } from "./engine-harness";

const cancel = (ordId = "777") => ({ tool: "spot_cancel_order" as const, instId: "BTC-USDT", ordId });

describe("PolicyEngine — ALLOW path", () => {
  it("issues one order-bound, signed authorization and consumes one credit", async () => {
    const h = await harness();
    const { v, out } = await h.submit(limitBuy({ sz: "0.001", px: "60000" }));
    expect(out.status).toBe("ALLOWED");
    const a = out.authorization!;
    expect(a.normalizedOrderHash).toBe(v.normalizedOrderHash);
    expect(a.accountRef).toBe(h.policy.binding.accountRef);
    expect(a.policyVersion).toBe(1);
    expect(a.basis).toBe("rules_only");
    expect(a.guardInstanceId).toBe("guard-1");
    expect(a.expiresAt - a.issuedAt).toBe(h.policy.authorizationTtlSec);
    expect(await recoverAuthorizationSigner(a)).toBe(h.signerAccount.address);
    expect(h.payment.consumed()).toBe(1);
    expect(h.risk.getReservation(h.base.policyId, v.request.requestId)?.state).toBe("reserved");
    expect(h.store.getRequest(h.base.policyId, v.request.requestId)?.status).toBe("ALLOWED");

    const rec = h.outbox.pending().at(-1)!;
    expect(rec).toMatchObject({ kind: "decision", verdict: "ALLOW", authHash: computeAuthHash(a) });
    expect(h.audit.all().map((e) => e.type)).toEqual(["intent_received", "decision", "authorization_issued"]);
    expect(h.audit.verify()).toBeNull();
  });

  it("is idempotent: a repeated decide returns the same authorization and burns nothing", async () => {
    const h = await harness();
    const { v, out } = await h.submit(limitBuy());
    const again = await h.engine.decide(v);
    expect(again.authorization).toEqual(out.authorization);
    expect(h.payment.consumed()).toBe(1);
    expect(dec(h.risk.reservedNotional(h.base.policyId)).eq("60")).toBe(true);
    expect(h.outbox.pending().length).toBe(1);
  });

  it("a forged ValidatedIntent (order swapped after L3) is blocked", async () => {
    const h = await harness();
    const req = await h.agent.sign({ ...h.base, intent: limitBuy() }, { issuedAt: h.clock() });
    const v = await h.gate.validate(req);
    const forged = { ...(v as never as { order: object }), order: { ...(v as never as { order: object }).order, sz: "1.00000000" } };
    const out = await h.engine.decide(forged as never);
    expect(out.status).toBe("BLOCKED");
    expect(out.authorization).toBeUndefined();
  });
});

describe("PolicyEngine — deterministic BLOCKs (no auditor call, no credit burn)", () => {
  const cases: [string, Parameters<typeof harness>[0], (h: Awaited<ReturnType<typeof harness>>) => void, object, number][] = [
    ["101 instrument", {}, () => {}, limitBuy({ instId: "ETH-USDT", sz: "0.01", px: "3000" }), ReasonCodes.INSTRUMENT],
    ["103 single order", {}, () => {}, limitBuy({ sz: "0.01" }), ReasonCodes.SINGLE_ORDER_LIMIT],
    ["104 open notional", {}, (h) => { h.riskProvider.state.openNotionalUsdt = "1950"; }, limitBuy(), ReasonCodes.OPEN_NOTIONAL],
    ["106 daily loss", {}, (h) => { h.riskProvider.state.dailyPnlUsdt = "-150"; }, limitBuy(), ReasonCodes.DAILY_LOSS],
    ["107 price deviation", {}, () => {}, limitBuy({ px: "70000" }), ReasonCodes.PRICE_DEVIATION],
    ["110 stale risk data", {}, (h) => { h.riskProvider.staleBySec = 120; }, limitBuy(), ReasonCodes.STALE_DATA],
    ["110 risk provider down", {}, (h) => { h.riskProvider.failing = true; }, limitBuy(), ReasonCodes.STALE_DATA],
    ["110 stale ticker", {}, (h) => { h.market.staleBySec = 60; }, limitBuy(), ReasonCodes.STALE_DATA],
  ];
  for (const [name, pol, prep, intent, code] of cases) {
    it(name, async () => {
      const h = await harness({ ...pol, auditor: { ...harnessAuditor(), mode: "enabled" } });
      prep(h);
      const { out } = await h.submit(intent as never);
      expect(out.status).toBe("BLOCKED");
      expect(out.decision?.reasonCode).toBe(code);
      expect(out.authorization).toBeUndefined();
      expect(h.auditor.calls.length).toBe(0);
      expect(h.payment.consumed()).toBe(0);
      expect(h.payment.remaining).toBe(100);
      expect(h.risk.reservedNotional(h.base.policyId)).toBe("0");
    });
  }

  it("102 tool not in allowedTools (passes L3, blocked at L4)", async () => {
    const h = await harness({ allowedTools: ["spot_place_order"] });
    const { out } = await h.submit(cancel());
    expect(out.decision?.reasonCode).toBe(ReasonCodes.TOOL);
  });

  it("105 rate: blocked intents still consume rate budget", async () => {
    const h = await harness({ limits: { ...baseLimits(), maxOrdersPerMinute: 3 } });
    h.riskProvider.state.dailyPnlUsdt = "-150"; // every order blocked (106)
    for (let i = 0; i < 3; i++) expect((await h.submit(limitBuy())).out.decision?.reasonCode).toBe(ReasonCodes.DAILY_LOSS);
    h.riskProvider.state.dailyPnlUsdt = "0";
    const { out } = await h.submit(limitBuy());
    expect(out.decision?.reasonCode).toBe(ReasonCodes.RATE);
    h.advance(61);
    expect((await h.submit(limitBuy())).out.status).toBe("ALLOWED");
  });
});

describe("PolicyEngine — policy verification (INV-11)", () => {
  it("on-chain hash that does not match the document -> BLOCK 003", async () => {
    const h = await harness();
    h.chain.mutate(h.base.policyId, { policyHash: ("0x" + "11".repeat(32)) as `0x${string}` });
    const { out } = await h.submit(limitBuy());
    expect(out.decision?.reasonCode).toBe(ReasonCodes.POLICY_UNVERIFIED);
    expect(out.authorization).toBeUndefined();
  });

  it("tampered document behind a new on-chain version -> BLOCK 003", async () => {
    const h = await harness();
    const next = { ...h.policy, policyVersion: 2 };
    h.chain.publish(next);
    h.chain.tamperDocument(h.base.policyId, (p) => { p.limits.maxOrderNotionalUsdt = "1000000"; });
    expect((await h.submit(limitBuy())).out.decision?.reasonCode).toBe(ReasonCodes.POLICY_UNVERIFIED);
  });

  it("chain down: cache within TTL is used, past TTL blocks", async () => {
    const h = await harness();
    h.chain.failing = true;
    expect((await h.submit(limitBuy())).out.status).toBe("ALLOWED");
    h.advance(31);
    const { out } = await h.submit(limitBuy());
    expect(out.decision?.reasonCode).toBe(ReasonCodes.POLICY_UNVERIFIED);
  });

  it("delegation revoked between L3 and L4 -> BLOCK 003", async () => {
    const h = await harness();
    const req = await h.agent.sign({ ...h.base, intent: limitBuy() }, { issuedAt: h.clock() });
    const v = await h.gate.validate(req);
    h.chain.setRevoked(h.base.policyId, true);
    const out = await h.engine.decide(v as never);
    expect(out.decision?.reasonCode).toBe(ReasonCodes.POLICY_UNVERIFIED);
  });

  it("agent key rotated on chain -> old-key intents blocked", async () => {
    const h = await harness();
    const req = await h.agent.sign({ ...h.base, intent: limitBuy() }, { issuedAt: h.clock() });
    const v = await h.gate.validate(req);
    h.chain.mutate(h.base.policyId, { agentAuthAddress: "0x3333333333333333333333333333333333333333" });
    expect((await h.engine.decide(v as never)).decision?.reasonCode).toBe(ReasonCodes.POLICY_UNVERIFIED);
  });
});

describe("PolicyEngine — pause and protective cancel", () => {
  it("paused: buy BLOCK 100; verified own-order cancel passes without credit", async () => {
    const h = await harness({}, { credits: 0 });
    h.chain.setPaused(h.base.policyId, true);
    expect((await h.submit(limitBuy())).out.decision?.reasonCode).toBe(ReasonCodes.PAUSED);

    h.ownership.open.add("BTC-USDT:777");
    const { out } = await h.submit(cancel("777"));
    expect(out.status).toBe("ALLOWED");
    expect(out.decision?.ruleResult.derived.verifiedProtectiveAction).toBe(true);
    expect(h.payment.consumed()).toBe(0);
  });

  it("paused: cancel of an order that is not ours / unverifiable -> BLOCK 100", async () => {
    const h = await harness();
    h.chain.setPaused(h.base.policyId, true);
    expect((await h.submit(cancel("999"))).out.decision?.reasonCode).toBe(ReasonCodes.PAUSED);
    h.ownership.open.add("BTC-USDT:1");
    h.ownership.failing = true;
    expect((await h.submit(cancel("1"))).out.decision?.reasonCode).toBe(ReasonCodes.PAUSED);
  });

  it("local pause (dashboard) survives a chain refresh", async () => {
    const h = await harness();
    h.store.setLocalPause(h.base.policyId, true);
    await h.loader.load(h.base.policyId);
    expect((await h.submit(limitBuy())).out.decision?.reasonCode).toBe(ReasonCodes.PAUSED);
  });
});

describe("PolicyEngine — payment entitlement (§21.2, INV-17/18/21)", () => {
  it("no credit -> REJECTED_PAYMENT 004; cancel still works", async () => {
    const h = await harness({}, { credits: 0 });
    const { out } = await h.submit(limitBuy());
    expect(out.status).toBe("REJECTED_PAYMENT");
    expect(out.decision?.reasonCode).toBe(ReasonCodes.PAYMENT_REQUIRED);
    h.ownership.open.add("BTC-USDT:777");
    expect((await h.submit(cancel())).out.status).toBe("ALLOWED");
  });

  it("payment never overrides a deterministic block", async () => {
    const h = await harness({}, { credits: 1000 });
    expect((await h.submit(limitBuy({ sz: "1" }))).out.status).toBe("BLOCKED");
    expect(h.payment.remaining).toBe(1000);
  });

  it("credit finalization failure releases the risk reservation", async () => {
    const h = await harness();
    h.payment.failConsume = true;
    const { v, out } = await h.submit(limitBuy());
    expect(out.status).toBe("REJECTED_PAYMENT");
    expect(out.authorization).toBeUndefined();
    expect(h.risk.getReservation(h.base.policyId, v.request.requestId)?.state).toBe("released");
    expect(h.payment.remaining).toBe(100);
  });

  it("payer must be the delegated agent address", async () => {
    const h = await harness();
    h.payment.payer = "0x4444444444444444444444444444444444444444";
    expect((await h.submit(limitBuy())).out.status).toBe("REJECTED_PAYMENT");
  });
});

describe("PolicyEngine — sells", () => {
  it("sell without inventory -> REJECTED_POLICY", async () => {
    const h = await harness();
    const { out } = await h.submit(limitBuy({ side: "sell" }));
    expect(out.status).toBe("REJECTED_POLICY");
    expect(out.decision?.reasonCode).toBe(SELL_INVENTORY_REASON);
  });

  it("sell with inventory is risk-reducing: no credit, not limited by open notional", async () => {
    const h = await harness();
    h.riskProvider.state.baseBalances.BTC = "0.01";
    h.riskProvider.state.openNotionalUsdt = "5000";
    const { v, out } = await h.submit(limitBuy({ side: "sell", sz: "0.004" }));
    expect(out.status).toBe("ALLOWED");
    expect(out.decision?.ruleResult.derived.riskIncreasing).toBe(false);
    expect(h.payment.consumed()).toBe(0);
    expect(h.risk.getReservation(h.base.policyId, v.request.requestId)?.notionalUsdt).toBe("0");
    expect(dec((await h.risk.sellAvailable(h.base.policyId, "BTC")).available).eq("0.006")).toBe(true);
  });
});

describe("PolicyEngine — auditor (INV-5)", () => {
  const enabled = () => ({ auditor: { ...harnessAuditor(), mode: "enabled" as const } });

  it("allow -> ALLOW with basis rules_and_auditor", async () => {
    const h = await harness(enabled());
    const { out } = await h.submit(limitBuy());
    expect(out.status).toBe("ALLOWED");
    expect(out.authorization?.basis).toBe("rules_and_auditor");
    expect(out.decision?.auditorOutput?.provider).toBe("mock");
  });

  const cases: [string, (h: Awaited<ReturnType<typeof harness>>) => void, string, number][] = [
    ["injection suspicion -> BLOCK 201", (h) => h.auditor.set({ allow: "0.9", block: "0", askHuman: "0.1" }, { injectionSuspicion: "0.8" }), "BLOCKED", ReasonCodes.AUDITOR_INJECTION],
    ["inconsistent -> BLOCK 202", (h) => h.auditor.set({ allow: "0.9", block: "0", askHuman: "0.1" }, { consistency: "0.2" }), "BLOCKED", ReasonCodes.AUDITOR_INCONSISTENT],
    ["block verdict -> BLOCK 203", (h) => h.auditor.set({ allow: "0.2", block: "0.7", askHuman: "0.1" }), "BLOCKED", ReasonCodes.AUDITOR_BLOCK],
    ["tie allow/block -> BLOCK 203", (h) => h.auditor.set({ allow: "0.5", block: "0.5", askHuman: "0" }), "BLOCKED", ReasonCodes.AUDITOR_BLOCK],
    ["askHuman -> PENDING 301", (h) => h.auditor.set({ allow: "0.3", block: "0.1", askHuman: "0.6" }), "PENDING", ReasonCodes.HUMAN_AUDITOR_ASK],
    ["low confidence -> PENDING 301", (h) => h.auditor.set({ allow: "0.4", block: "0.3", askHuman: "0.3" }), "PENDING", ReasonCodes.HUMAN_AUDITOR_ASK],
    ["timeout -> PENDING 302", (h) => { h.auditor.mode = "timeout"; }, "PENDING", ReasonCodes.HUMAN_AUDITOR_UNAVAILABLE],
    ["error -> PENDING 302", (h) => { h.auditor.mode = "throw"; }, "PENDING", ReasonCodes.HUMAN_AUDITOR_UNAVAILABLE],
    ["out-of-schema -> PENDING 302", (h) => { h.auditor.mode = "garbage"; }, "PENDING", ReasonCodes.HUMAN_AUDITOR_UNAVAILABLE],
  ];
  for (const [name, prep, status, code] of cases) {
    it(name, async () => {
      const h = await harness(enabled());
      prep(h);
      const { out } = await h.submit(limitBuy());
      expect(out.status).toBe(status);
      expect(out.decision?.reasonCode).toBe(code);
      expect(out.authorization).toBeUndefined();
      expect(h.payment.consumed()).toBe(0);
      expect(h.payment.remaining).toBe(100);
    });
  }

  it("auditor 'allow' cannot rescue a rule BLOCK", async () => {
    const h = await harness(enabled());
    h.auditor.set({ allow: "1", block: "0", askHuman: "0" });
    expect((await h.submit(limitBuy({ sz: "1" }))).out.status).toBe("BLOCKED");
    expect(h.auditor.calls.length).toBe(0);
  });

  it("auditor sees only this policy's recorded reads, labeled as given", async () => {
    const h = await harness(enabled());
    const mine = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const foreign = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const summary = { readId: mine, source: "news", topics: ["btc"], sentiment: "positive" as const, confidence: "0.7", sourceUrls: [], flags: [] };
    h.store.saveRead({ readId: mine, policyId: h.base.policyId, fetchedAt: h.clock(), contentHash: ("0x" + "00".repeat(32)) as `0x${string}`, excerpt: "BTC up", summary });
    h.store.saveRead({ readId: foreign, policyId: ("0x" + "99".repeat(32)) as `0x${string}`, fetchedAt: h.clock(), contentHash: ("0x" + "00".repeat(32)) as `0x${string}`, excerpt: "x", summary: { ...summary, readId: foreign } });
    await h.submit(limitBuy(), { referencedReadIds: [mine, foreign], agentReason: "news says up" });
    const input = h.auditor.calls[0]!;
    expect(input.recentReads.map((r) => r.readId)).toEqual([mine]);
    expect(input.agentReason).toBe("news says up");
    expect(input.policyMandate).toBe(h.policy.mandate);
  });
});

describe("PolicyEngine — concurrency (INV-10)", () => {
  it("parallel decisions never exceed maxOpenNotional", async () => {
    const h = await harness({ limits: { ...baseLimits(), maxOrdersPerMinute: 100 } });
    h.riskProvider.latencyMs = () => Math.floor(Math.random() * 5);
    const reqs = await Promise.all(Array.from({ length: 12 }, () =>
      h.agent.sign({ ...h.base, intent: limitBuy({ sz: "0.004" }) }, { issuedAt: h.clock() }))); // 240 each
    const vs = await Promise.all(reqs.map((r) => h.gate.validate(r)));
    const outs = await Promise.all(vs.map((v) => h.engine.decide(v as never)));
    expect(outs.filter((o) => o.status === "ALLOWED").length).toBe(8); // 8 * 240 = 1920 <= 2000
    expect(outs.filter((o) => o.decision?.reasonCode === ReasonCodes.OPEN_NOTIONAL).length).toBe(4);
    expect(h.payment.consumed()).toBe(8);
  });
});

describe("PolicyEngine — signer failure", () => {
  it("no signing key -> BLOCK, reservation and credit released", async () => {
    const h = await harness();
    (h.authorizer as unknown as { sign: () => never }).sign = () => { throw new Error("hsm down"); };
    const { v, out } = await h.submit(limitBuy());
    expect(out.status).toBe("BLOCKED");
    expect(h.risk.getReservation(h.base.policyId, v.request.requestId)?.state).toBe("released");
    expect(h.payment.remaining).toBe(100);
  });
});

function baseLimits() {
  return {
    maxOrderNotionalUsdt: "500", maxOpenNotionalUsdt: "2000", maxOrdersPerMinute: 5, maxDailyLossUsdt: "100",
    maxPriceDeviationBps: 200, marketSlippageBufferBps: 50, escalateAboveUsdt: "300",
  };
}

function harnessAuditor() {
  return { mode: "disabled" as const, maxInjectionSuspicion: "0.5", minConsistency: "0.6", minVerdictConfidence: "0.5", onUnavailable: "pending" as const };
}
