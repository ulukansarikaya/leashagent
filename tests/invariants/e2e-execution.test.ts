import { describe, expect, it } from "vitest";
import { ReasonCodes, dec } from "@bekci/shared";
import { FakeAtkClient, limitBuy } from "@bekci/mocks";
import { DefaultExecutor, openExecutorDb } from "@bekci/executor";
import { ExecutionDispatcher, ExecutionEventHandler } from "@bekci/gateway";
import { harness } from "../../packages/gateway/test/engine-harness";

/** Gateway (L3–L5, L7 local) + separate executor DB/process boundary (L6) + fake OKX. */
async function stack(...args: Parameters<typeof harness>) {
  const h = await harness(...args);
  const atk = new FakeAtkClient();
  const handler = new ExecutionEventHandler({ store: h.store, audit: h.audit, outbox: h.outbox, risk: h.risk, clock: h.clock });
  const executor = new DefaultExecutor({
    db: openExecutorDb(":memory:"), // L6 owns its own store
    atk,
    policyState: h.chain,
    config: {
      guardSignerAddress: h.signerAccount.address,
      guardInstanceId: "guard-1",
      accountRef: h.policy.binding.accountRef,
      allowedTools: ["spot_place_order", "spot_cancel_order"],
      clockSkewSec: 60,
    },
    clock: h.clock,
    sink: { onEvent: (e, ctx) => handler.onEvent(e, ctx) },
  });
  const dispatcher = new ExecutionDispatcher(executor, handler);
  async function run(intent: Parameters<typeof h.submit>[0]) {
    const { v, out } = await h.submit(intent);
    const events = await dispatcher.dispatch(out, v.order);
    return { v, out, events };
  }
  return { ...h, atk, executor, handler, dispatcher, run };
}

describe("E2E: P0-A exit condition — one allowed order traverses the whole path", () => {
  it("signed intent -> ALLOW -> exactly one OKX write -> events back into L5/L7", async () => {
    const s = await stack();
    const { v, out, events } = await s.run(limitBuy({ sz: "0.001", px: "60000" }));
    expect(out.status).toBe("ALLOWED");
    expect(events.map((e) => e.status)).toEqual(["submitted", "acknowledged"]);
    expect(s.atk.writes.length).toBe(1);

    // L5: the exchange now shows the order, so the reservation stops counting (no double count).
    expect(s.risk.getReservation(s.base.policyId, v.request.requestId)?.state).toBe("reconciled");
    // Request status follows the newest event; events delivered twice (sink + dispatcher) are deduped.
    expect(s.store.getRequest(s.base.policyId, v.request.requestId)?.status).toBe("ACKNOWLEDGED");
    const types = s.audit.all().map((e) => e.type);
    expect(types).toEqual(["intent_received", "decision", "authorization_issued", "execution", "execution"]);
    expect(s.audit.verify()).toBeNull();
    expect(s.outbox.pending().map((r) => r.kind)).toEqual(["decision", "execution", "execution"]);
  });
});

describe("E2E: P0-B exit condition — bad orders never reach OKX", () => {
  it("over-limit, forbidden, stale and replayed orders produce zero writes", async () => {
    const s = await stack();
    expect((await s.run(limitBuy({ sz: "1" }))).out.decision?.reasonCode).toBe(ReasonCodes.SINGLE_ORDER_LIMIT);
    s.riskProvider.staleBySec = 999;
    expect((await s.run(limitBuy())).out.decision?.reasonCode).toBe(ReasonCodes.STALE_DATA);
    s.riskProvider.staleBySec = 0;

    const req = await s.agent.sign({ ...s.base, intent: { tool: "withdraw" } as never }, { issuedAt: s.clock() });
    expect(await s.gate.validate(req)).toMatchObject({ status: "REJECTED_SCHEMA" });

    const ok = await s.run(limitBuy());
    expect(ok.events.length).toBe(2);
    // replaying the executed authorization
    await expect(s.executor.execute(ok.out.authorization!, ok.v.order)).rejects.toMatchObject({ reasonCode: ReasonCodes.AUTH_NONCE_REUSE });
    expect(s.atk.writes.length).toBe(1);
  });

  it("pause lands between L4 ALLOW and L6: executor refuses, reservation released, request REVOKED", async () => {
    const s = await stack();
    const { v, out } = await s.submit(limitBuy());
    expect(out.status).toBe("ALLOWED");
    s.chain.setPaused(s.base.policyId, true);
    expect(await s.dispatcher.dispatch(out, v.order)).toEqual([]);
    expect(s.atk.writes.length).toBe(0);
    expect(s.store.getRequest(s.base.policyId, v.request.requestId)?.status).toBe("REVOKED");
    expect(s.risk.getReservation(s.base.policyId, v.request.requestId)?.state).toBe("released");
  });

  it("authorization expires before dispatch -> EXPIRED, no write", async () => {
    const s = await stack();
    const { v, out } = await s.submit(limitBuy());
    s.advance(s.policy.authorizationTtlSec + 1);
    await s.dispatcher.dispatch(out, v.order);
    expect(s.atk.writes.length).toBe(0);
    expect(s.store.getRequest(s.base.policyId, v.request.requestId)?.status).toBe("EXPIRED");
  });

  it("OKX rejection releases the reservation", async () => {
    const s = await stack();
    s.atk.mode = "reject";
    const { v } = await s.run(limitBuy());
    expect(s.store.getRequest(s.base.policyId, v.request.requestId)?.status).toBe("REJECTED_BY_OKX");
    expect(s.risk.getReservation(s.base.policyId, v.request.requestId)?.state).toBe("released");
  });

  it("OKX timeout: UNKNOWN, reservation held and still counted, no resend", async () => {
    const s = await stack();
    s.atk.mode = "timeout_before_accept";
    const { v } = await s.run(limitBuy());
    expect(s.store.getRequest(s.base.policyId, v.request.requestId)?.status).toBe("UNKNOWN");
    expect(s.risk.getReservation(s.base.policyId, v.request.requestId)?.state).toBe("reserved");
    expect(dec(s.risk.reservedNotional(s.base.policyId)).eq("60")).toBe(true);
    await s.executor.reconcile();
    expect(s.atk.writes.length).toBe(1);
  });

  it("timeout after accept, then reconciliation settles the reservation", async () => {
    const s = await stack();
    s.atk.mode = "timeout_after_accept";
    const { v } = await s.run(limitBuy());
    expect(s.store.getRequest(s.base.policyId, v.request.requestId)?.status).toBe("UNKNOWN");
    await s.executor.reconcile();
    expect(s.store.getRequest(s.base.policyId, v.request.requestId)?.status).toBe("ACKNOWLEDGED");
    expect(s.risk.getReservation(s.base.policyId, v.request.requestId)?.state).toBe("reconciled");
    expect(s.atk.writes.length).toBe(1);
  });
});
