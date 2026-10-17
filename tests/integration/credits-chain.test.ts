/**
 * Görev 2 integration with Person 3's packages through the TEST/DEMO gateway:
 * x402 credits (POST /v1/credits + CreditStore) and DecisionLog evidence (ChainOutbox).
 * Uses an in-memory DecisionLogPort; the real contract path is exercised by the demo on Anvil.
 */
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { privateKeyToAccount, signApproval, type ChainRecord, type Hex, type OrderIntent } from "@leashagent/shared";
import { HeuristicAuditor } from "@leashagent/auditor";
import { FixtureSource, HeuristicReaderModel } from "@leashagent/ingest";
import { IntentBuilder } from "@leashagent/agent";
import { CreditStore, MockSettlement, encodePaymentHeader, type PaymentRequirements } from "@leashagent/payments";
import { ChainOutbox, type DecisionLogPort } from "@leashagent/chain";
import { createGateway } from "@leashagent/mock-gateway";
import { BENIGN_ARTICLE, DEMO_PRICE, demoPolicy } from "../../packages/mock-gateway/src/fixtures.js";

const agent = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const owner = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const attacker = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const policy = demoPolicy(agent.address, owner.address);
const { policyId, agentId } = policy.binding;
const reqs: PaymentRequirements = {
  scheme: "exact", network: "avalanche-fuji", maxAmountRequired: "1", resource: "/v1/credits", description: "t",
  mimeType: "application/json", payTo: getAddress(owner.address), maxTimeoutSeconds: 60, asset: getAddress("0x5425890298aed601595a70ab815c96711a31bc65"),
};
const store = new CreditStore(new DatabaseSync(":memory:"));
const written: ChainRecord[] = [];
const port: DecisionLogPort = {
  isApplied: async () => false, simulate: async () => {},
  send: async (r) => { written.push(r); return `0x${randomBytes(32).toString("hex")}` as Hex; },
  waitForReceipt: async () => "success",
};
const outbox = new ChainOutbox(new DatabaseSync(":memory:"), port);
const gw = createGateway({
  policy, auditor: new HeuristicAuditor(), reader: new HeuristicReaderModel(),
  source: new FixtureSource([{ source: "news", body: BENIGN_ARTICLE }]), price: () => DEMO_PRICE,
  credits: { store, provider: new MockSettlement(reqs) },
  chain: { enqueue: (r) => outbox.enqueue(r), stats: () => outbox.stats() },
});
let url = "";
const builder = new IntentBuilder(agent, policyId, agentId);
const limit = (sz: string): OrderIntent => ({ tool: "spot_place_order", instId: "BTC-USDT", side: "buy", ordType: "limit", sz, px: DEMO_PRICE });
const header = (payer: Hex) => encodePaymentHeader({ x402Version: 1, scheme: "exact", network: "avalanche-fuji", payload: { payer, nonce: `0x${randomBytes(16).toString("hex")}` } });
const buy = async (h?: string) => {
  const r = await fetch(`${url}/v1/credits`, { method: "POST", headers: { "content-type": "application/json", ...(h ? { "x-payment": h } : {}) }, body: JSON.stringify({ policyId, agentId }) });
  return { status: r.status, body: await r.json() };
};
const credits = () => store.available(policyId, agentId, agent.address);
const settle = () => new Promise((r) => setTimeout(r, 120));

beforeAll(async () => {
  await new Promise<void>((r) => gw.server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(gw.server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => { gw.server.closeAllConnections(); gw.server.close(() => r()); }));

describe("x402 credits", () => {
  it("risk-increasing order without credit → REJECTED_PAYMENT 004", async () => {
    expect(await gw.submitIntent(await builder.build(limit("0.0005"), "x", []))).toMatchObject({ status: "REJECTED_PAYMENT", reasonCode: 4 });
  });

  it("402 challenge → non-delegated payer 403 → agent 200 → replay 409", async () => {
    const c = await buy();
    expect(c.status).toBe(402);
    expect(c.body.paymentRequirements.network).toBe("avalanche-fuji");
    expect((await buy(header(attacker.address))).body.error).toBe("payer_not_delegated");
    const h = header(agent.address);
    expect((await buy(h)).status).toBe(200);
    expect((await buy(h))).toMatchObject({ status: 409, body: { error: "duplicate_payment" } });
    expect(credits()).toBe(5);
  });

  it("BLOCK and PENDING release the credit; only an authorization consumes one", async () => {
    expect((await gw.submitIntent(await builder.build(limit("5"), "x", []))).status).toBe("BLOCKED");
    const pending = await gw.submitIntent(await builder.build(limit("0.001"), "x", []));
    expect(pending.status).toBe("PENDING");
    expect(credits()).toBe(5);
    expect((await gw.submitIntent(await builder.build(limit("0.0005"), "x", []))).status).toBe("ALLOWED");
    expect(credits()).toBe(4);
    const detail = await fetch(`${url}/v1/intents/${pending.requestId}`).then((r) => r.json());
    const approval = await signApproval(owner, { requestId: pending.requestId, policyId, normalizedOrderHash: detail.normalizedOrderHash, decision: "approve", nonce: `0x${randomBytes(16).toString("hex")}`, expiresAt: Math.floor(Date.now() / 1000) + 60 });
    expect((await gw.approve(approval)).status).toBe("ALLOWED");
    expect(credits()).toBe(3);
  });
});

describe("chain evidence", () => {
  it("every decision and execution reaches the outbox with DecisionLog-valid verdicts", async () => {
    await settle();
    await outbox.drain();
    const s = outbox.stats();
    expect(s.dead).toBe(0);
    expect(s.pending + s.submitted).toBe(0);
    const verdicts = written.filter((r) => r.kind === "decision").map((r) => (r as { verdict: string }).verdict);
    expect(verdicts).toEqual(["BLOCK", "BLOCK", "PENDING", "ALLOW", "HUMAN_APPROVED"]);
    const exec = written.filter((r) => r.kind === "execution") as { requestId: string; eventSeq: number; status: string }[];
    const byRequest = new Map<string, string[]>();
    for (const r of exec) byRequest.set(r.requestId, [...(byRequest.get(r.requestId) ?? []), `${r.eventSeq}:${r.status}`]);
    expect([...byRequest.values()]).toEqual([["1:submitted", "2:filled"], ["1:submitted", "2:filled"]]);
    const allow = written.find((r) => r.kind === "decision" && r.verdict === "ALLOW") as { authHash: string };
    expect(allow.authHash).not.toBe(`0x${"0".repeat(64)}`);
  });

  it("health reports outbox counters; audit stream carries chain_write states", async () => {
    const h = await fetch(`${url}/v1/health`).then((r) => r.json());
    expect(h.chain.outbox).toMatchObject({ pending: 0, submitted: 0, dead: 0 });
    expect(h.chain.outbox.confirmed).toBe(written.length);
    expect(gw.state.events.filter((e) => e.type === "chain_write").length).toBeGreaterThan(0);
  });
});
