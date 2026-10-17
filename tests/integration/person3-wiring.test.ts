import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ReasonCodes, chainWritePayloadSchema, healthChainSchema } from "@leashagent/shared";
import { limitBuy } from "@leashagent/mocks";
import { CreditStore } from "@leashagent/payments";
import { ChainOutbox, createChainPolicyStateProvider, type DecisionLogPort } from "@leashagent/chain";
import type { PaymentEntitlement } from "@leashagent/gateway";
import type { PolicyStateProvider } from "@leashagent/executor";
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

describe("gateway ⇄ @leashagent/payments CreditStore (x402 ledger)", () => {
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

describe("executor ⇄ @leashagent/chain createChainPolicyStateProvider", () => {
  it("L6 recheck through Person 3's adapter: on-chain pause between ALLOW and dispatch -> REVOKED, no write", async () => {
    h = await appHarness();
    const original = h.executor.execute.bind(h.executor);
    h.executor.execute = async (a, o) => { h!.chain.mutate(h!.base.policyId, { paused: true }); return original(a, o); };
    const r = await h.intent(limitBuy());
    expect(r.body).toMatchObject({ status: "REVOKED", reasonCode: ReasonCodes.AUTH_POLICY_VERSION_CHANGED });
    expect(h.atk.writes.length).toBe(0);
  });
});

describe("gateway chain_outbox ⇄ @leashagent/chain ChainOutbox worker (dashboard contract)", () => {
  const sent: string[] = [];
  const port: DecisionLogPort = {
    isApplied: async () => false,
    simulate: async () => {},
    send: async (r) => { sent.push(r.kind); return `0x${"ab".repeat(32)}`; },
    waitForReceipt: async () => "success",
  } as DecisionLogPort;

  it("health reports \"disabled\" without a worker", async () => {
    h = await appHarness();
    const body = (await h.get("/v1/health")).body;
    expect(body.chain).toBe("disabled");
    expect(healthChainSchema.safeParse(body.chain).success).toBe(true);
  });

  it("decision + execution records go pending -> confirmed through Person 3's worker; payloads match ChainWritePayload", async () => {
    h = await appHarness({}, { chainEvidence: (db, onEvent) => new ChainOutbox(db, port, { onEvent }) });
    const r = await h.intent(limitBuy());
    expect(r.body.status).toBe("ACKNOWLEDGED");
    h.app.chainWorker!.start(5);
    await new Promise((res) => setTimeout(res, 150));
    h.app.chainWorker!.stop();

    expect(sent).toEqual(["decision", "execution", "execution"]);
    const health = (await h.get("/v1/health")).body;
    expect(healthChainSchema.safeParse(health.chain).success).toBe(true);
    expect(health.chain).toMatchObject({ outbox: { pending: 0, confirmed: 3, dead: 0 } });

    const writes = h.app.audit.all().filter((e) => e.type === "chain_write");
    for (const e of writes) {
      const p = chainWritePayloadSchema.parse(e.payload);
      expect(e.requestId).toBe(r.req.requestId);
      expect(p.kind).toBeDefined();
      expect(e.policyId).toBe(h.base.policyId);
    }
    expect(writes.map((e) => (e.payload as { state: string }).state)).toEqual(["pending", "pending", "pending", "confirmed", "confirmed", "confirmed"]);
    expect(writes.filter((e) => (e.payload as { state: string }).state === "confirmed").every((e) => (e.payload as { txHash?: string }).txHash)).toBe(true);
    expect(h.app.audit.verify()).toBeNull();
  });
});
