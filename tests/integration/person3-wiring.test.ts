import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ReasonCodes } from "@bekci/shared";
import { limitBuy } from "@bekci/mocks";
import { CreditStore } from "@bekci/payments";
import { createChainPolicyStateProvider } from "@bekci/chain";
import type { PaymentEntitlement } from "@bekci/gateway";
import type { PolicyStateProvider } from "@bekci/executor";
import { appHarness, type AppHarness } from "../support/app-harness";

// Person 1 gateway/executor wired to Person 3's real modules (payments ledger, chain state adapter).

// Compile-time contract checks: the real implementations fit Person 1's ports.
const _payment: (db: DatabaseSync) => PaymentEntitlement = (db) => new CreditStore(db);
const _state: (c: Parameters<typeof createChainPolicyStateProvider>[0]) => PolicyStateProvider = (c) => createChainPolicyStateProvider(c);
void _payment;
void _state;

let h: AppHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

async function withCredits(n: number) {
  const credits = new CreditStore(new DatabaseSync(":memory:"));
  h = await appHarness({}, { payment: credits });
  if (n > 0) credits.mint({ paymentRef: `pay-${crypto.randomUUID()}`, policyId: h.base.policyId, agentId: h.base.agentId, payer: h.agent.address, purchased: n });
  return { h, credits, left: () => credits.available(h!.base.policyId, h!.base.agentId, h!.agent.address) };
}

describe("gateway ⇄ @bekci/payments CreditStore (x402 ledger)", () => {
  it("an allowed order consumes exactly one credit; a retry consumes none", async () => {
    const { h, credits, left } = await withCredits(5);
    const r = await h.intent(limitBuy());
    expect(r.body.status).toBe("ACKNOWLEDGED");
    expect(left()).toBe(4);
    expect(credits.consumptionState(h.base.policyId, r.req.requestId)).toBe("consumed");
    await h.post("/v1/intents", r.req);
    expect(left()).toBe(4);
  });

  it("BLOCK and PENDING release the reservation (no credit burned)", async () => {
    const { h, credits, left } = await withCredits(5);
    const blocked = await h.intent(limitBuy({ sz: "1" }));
    expect(blocked.body.status).toBe("BLOCKED");
    const pending = await h.intent(limitBuy({ sz: "0.006" }));
    expect(pending.body.status).toBe("PENDING");
    expect(left()).toBe(5);
    expect(credits.consumptionState(h.base.policyId, pending.req.requestId)).toBe("released");
  });

  it("no credits -> 402 REJECTED_PAYMENT 004; protective cancel still works without credit", async () => {
    const { h } = await withCredits(0);
    expect(await h.intent(limitBuy())).toMatchObject({ status: 402, body: { status: "REJECTED_PAYMENT", reasonCode: ReasonCodes.PAYMENT_REQUIRED } });
    h.ownership.open.add("BTC-USDT:42");
    const c = await h.intent({ tool: "spot_cancel_order", instId: "BTC-USDT", ordId: "42" });
    expect(h.app.store.getDecision(h.base.policyId, c.req.requestId)?.kind).toBe("ALLOW");
  });

  it("credits bought by another payer cannot be spent by this agent (INV-19)", async () => {
    const credits = new CreditStore(new DatabaseSync(":memory:"));
    h = await appHarness({}, { payment: credits });
    credits.mint({ paymentRef: "p-other", policyId: h.base.policyId, agentId: h.base.agentId, payer: "0x4444444444444444444444444444444444444444" });
    expect((await h.intent(limitBuy())).body.status).toBe("REJECTED_PAYMENT");
  });

  it("an authorization that never reached the executor is refunded through CreditStore.refundConsumedCredit", async () => {
    const { h, left } = await withCredits(5);
    h.executorLink.down = true;
    const r = await h.intent(limitBuy());
    expect(r.body.status).toBe("ALLOWED");
    expect(left()).toBe(4);
    h.advance(h.policy.authorizationTtlSec + 31);
    await h.app.loader.load(h.base.policyId);
    expect((await h.app.tick()).refunded).toEqual([r.req.requestId]);
    expect(left()).toBe(5);
  });
});

describe("executor ⇄ @bekci/chain createChainPolicyStateProvider", () => {
  it("L6 recheck through Person 3's adapter: on-chain pause between ALLOW and dispatch -> REVOKED, no write", async () => {
    h = await appHarness();
    const original = h.executor.execute.bind(h.executor);
    h.executor.execute = async (a, o) => { h!.chain.mutate(h!.base.policyId, { paused: true }); return original(a, o); };
    const r = await h.intent(limitBuy());
    expect(r.body).toMatchObject({ status: "REVOKED", reasonCode: ReasonCodes.AUTH_POLICY_VERSION_CHANGED });
    expect(h.atk.writes.length).toBe(0);
  });
});
