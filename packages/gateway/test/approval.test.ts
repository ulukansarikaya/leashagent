import { describe, expect, it } from "vitest";
import { ReasonCodes } from "@bekci/shared";
import { limitBuy } from "@bekci/mocks";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { harness } from "./engine-harness";

const big = () => limitBuy({ sz: "0.006" }); // 360 USDT > escalateAboveUsdt 300 -> PENDING 303

describe("ApprovalHandler (§4.4, INV-6)", () => {
  it("PENDING never allows by itself; owner approval re-runs and issues human_approved", async () => {
    const h = await harness();
    const { v, out } = await h.submit(big());
    expect(out.status).toBe("PENDING");
    expect(out.decision?.reasonCode).toBe(ReasonCodes.HUMAN_ABOVE_THRESHOLD);
    expect(out.authorization).toBeUndefined();
    expect(h.payment.consumed()).toBe(0);
    expect(h.payment.remaining).toBe(100); // temporary credit released while pending
    expect(h.risk.reservedNotional(h.base.policyId)).toBe("0");

    const { result } = await h.approve(v);
    expect(result).toMatchObject({ ok: true, response: { status: "ALLOWED" } });
    const auth = h.store.getAuthorization(h.base.policyId, v.request.requestId)!;
    expect(auth.basis).toBe("human_approved");
    expect(h.payment.consumed()).toBe(1);
    expect(h.outbox.pending().at(-1)).toMatchObject({ verdict: "HUMAN_APPROVED" });
  });

  it("approval does not bypass pause / changed limits", async () => {
    const h = await harness();
    const a = await h.submit(big());
    h.chain.setPaused(h.base.policyId, true);
    expect((await h.approve(a.v)).result).toMatchObject({ ok: true, response: { status: "BLOCKED", reasonCode: ReasonCodes.PAUSED } });

    const h2 = await harness();
    const b = await h2.submit(big());
    h2.riskProvider.state.openNotionalUsdt = "1900";
    expect((await h2.approve(b.v)).result).toMatchObject({ ok: true, response: { status: "BLOCKED", reasonCode: ReasonCodes.OPEN_NOTIONAL } });
    expect(h2.payment.consumed()).toBe(0);
  });

  it("reject -> REJECTED_BY_HUMAN, nothing authorized", async () => {
    const h = await harness();
    const { v } = await h.submit(big());
    expect((await h.approve(v, "reject")).result).toMatchObject({ ok: true, response: { status: "REJECTED_BY_HUMAN" } });
    expect(h.store.getAuthorization(h.base.policyId, v.request.requestId)).toBeNull();
    expect(h.outbox.pending().at(-1)).toMatchObject({ verdict: "HUMAN_REJECTED" });
  });

  it("rejects approvals not signed by the owner", async () => {
    const h = await harness();
    const { v } = await h.submit(big());
    const r = await h.approve(v, "approve", {}, privateKeyToAccount(generatePrivateKey()));
    expect(r.result).toMatchObject({ ok: false, reasonCode: ReasonCodes.INSUFFICIENT_AUTHORIZATION });
    // the agent's own key cannot approve either
    const r2 = await h.approve(v, "approve", {}, h.agent.account);
    expect(r2.result.ok).toBe(false);
    expect(h.store.getRequest(h.base.policyId, v.request.requestId)?.status).toBe("PENDING");
  });

  it("rejects a mismatched order hash, an expired approval and a replayed nonce", async () => {
    const h = await harness();
    const { v } = await h.submit(big());
    expect((await h.approve(v, "approve", { normalizedOrderHash: ("0x" + "12".repeat(32)) as `0x${string}` })).result.ok).toBe(false);
    expect((await h.approve(v, "approve", { expiresAt: h.clock() - 1 })).result.ok).toBe(false);

    const first = await h.approve(v, "reject");
    expect(first.result.ok).toBe(true);
    // replay of the exact same signed approval
    expect((await h.approvals.handle(first.signed)).ok).toBe(false);
  });

  it("an approved request cannot be approved twice (one authorization per requestId)", async () => {
    const h = await harness();
    const { v } = await h.submit(big());
    expect((await h.approve(v)).result.ok).toBe(true);
    expect((await h.approve(v)).result.ok).toBe(false);
    expect(h.payment.consumed()).toBe(1);
  });

  it("PENDING past its TTL expires (counted as BLOCK), approval then refused", async () => {
    const h = await harness();
    const { v } = await h.submit(big());
    h.advance(h.policy.pendingTtlSec + 1);
    await h.loader.load(h.base.policyId);
    expect(await h.approvals.expirePending()).toBe(1);
    expect(h.store.getRequest(h.base.policyId, v.request.requestId)?.status).toBe("EXPIRED");
    expect(h.store.getDecision(h.base.policyId, v.request.requestId)?.kind).toBe("BLOCK");
    expect((await h.approve(v)).result.ok).toBe(false);
  });

  it("approving after TTL without the sweep also expires instead of allowing", async () => {
    const h = await harness();
    const { v } = await h.submit(big());
    h.advance(h.policy.pendingTtlSec + 1);
    const r = await h.approve(v);
    expect(r.result).toMatchObject({ ok: false, response: { status: "EXPIRED" } });
  });

  it("auditor-routed PENDING can be approved (basis human_approved)", async () => {
    const h = await harness({ auditor: { mode: "enabled", maxInjectionSuspicion: "0.5", minConsistency: "0.6", minVerdictConfidence: "0.5", onUnavailable: "pending" } });
    h.auditor.mode = "throw";
    const { v, out } = await h.submit(limitBuy());
    expect(out.decision?.reasonCode).toBe(ReasonCodes.HUMAN_AUDITOR_UNAVAILABLE);
    expect((await h.approve(v)).result).toMatchObject({ ok: true, response: { status: "ALLOWED" } });
  });
});
