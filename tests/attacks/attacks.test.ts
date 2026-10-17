import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount, signAgentIntent, type SignedIntentRequest } from "@bekci/shared";
import { HeuristicAuditor } from "@bekci/auditor";
import { FixtureSource, HeuristicReaderModel } from "@bekci/ingest";
import { BekciClient, IntentBuilder } from "@bekci/agent";
import { createGateway } from "@bekci/mock-gateway";
import { BENIGN_ARTICLE, DEMO_AGENT_ID, DEMO_POLICY_ID, POISONED_ARTICLE, demoPolicy } from "../../packages/mock-gateway/src/fixtures.js";

const agent = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const attacker = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const owner = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");

function setup(article: string) {
  const gw = createGateway({
    policy: demoPolicy(agent.address, owner.address),
    auditor: new HeuristicAuditor(),
    source: new FixtureSource([{ source: "news", url: "https://news.example/a", body: article }]),
    reader: new HeuristicReaderModel(),
    price: () => "65000",
  });
  return gw;
}

const small = { tool: "spot_place_order", instId: "BTC-USDT", side: "buy", ordType: "limit", sz: "0.0005", px: "65000" } as const;

describe("attack scenarios against the gateway contract", () => {
  const gw = setup(BENIGN_ARTICLE);
  const builder = new IntentBuilder(agent, DEMO_POLICY_ID, DEMO_AGENT_ID);
  let url = "";
  beforeAll(async () => {
    await new Promise<void>((r) => gw.server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(gw.server.address() as { port: number }).port}`;
  });
  afterAll(() => gw.server.close());

  it("allowed order goes through once", async () => {
    const r = await gw.submitIntent(await builder.build({ ...small }, "sma crossover", []));
    expect(r.status).toBe("FILLED");
  });

  it("impersonation: signature from a non-delegated key → REJECTED_AUTH", async () => {
    const fake = new IntentBuilder(attacker, DEMO_POLICY_ID, DEMO_AGENT_ID);
    const r = await gw.submitIntent(await fake.build({ ...small }, "x", []));
    expect(r).toMatchObject({ status: "REJECTED_AUTH", reasonCode: 0 });
  });

  it("tamper: intent changed after signing → REJECTED_AUTH", async () => {
    const req = await builder.build({ ...small }, "x", []);
    const r = await gw.submitIntent({ ...req, intent: { ...req.intent, sz: "5" } });
    expect(r.status).toBe("REJECTED_AUTH");
  });

  it("tamper: reason changed after signing → REJECTED_AUTH", async () => {
    const req = await builder.build({ ...small }, "x", []);
    expect((await gw.submitIntent({ ...req, agentReason: "y" })).status).toBe("REJECTED_AUTH");
  });

  it("replay: same nonce with a new requestId → REJECTED_AUTH", async () => {
    const req = await builder.build({ ...small }, "x", []);
    await gw.submitIntent(req);
    const { agentSignature: _s, ...rest } = req;
    const replay = { ...rest, requestId: crypto.randomUUID() };
    const signed: SignedIntentRequest = { ...replay, agentSignature: await signAgentIntent(agent, replay) };
    expect((await gw.submitIntent(signed)).status).toBe("REJECTED_AUTH");
  });

  it("retry: same requestId returns existing state without a second execution", async () => {
    const req = await builder.build({ ...small }, "x", []);
    await gw.submitIntent(req);
    const before = gw.state.events.filter((e) => e.type === "execution").length;
    const again = await gw.submitIntent(req);
    expect(again.status).toBe("FILLED");
    expect(gw.state.events.filter((e) => e.type === "execution").length).toBe(before);
  });

  it("forbidden tool (withdraw) never reaches policy", async () => {
    const req = await builder.build({ ...small }, "x", []);
    const r = await gw.submitIntent({ ...req, intent: { tool: "withdraw" } as never });
    expect(r).toMatchObject({ status: "REJECTED_SCHEMA", reasonCode: 1 });
  });

  it("extra field in intent → REJECTED_SCHEMA", async () => {
    const r = await gw.submitIntent(await builder.build({ ...small, riskIncreasing: false } as never, "x", []));
    expect(r.status).toBe("REJECTED_SCHEMA");
  });

  it("stale issuedAt → REJECTED_AUTH", async () => {
    const req = await builder.build({ ...small }, "x", []);
    const { agentSignature: _s, ...rest } = req;
    const old = { ...rest, issuedAt: rest.issuedAt - 600 };
    expect((await gw.submitIntent({ ...old, agentSignature: await signAgentIntent(agent, old) })).status).toBe("REJECTED_AUTH");
  });

  it("over single-order limit → BLOCKED 103", async () => {
    const r = await gw.submitIntent(await builder.build({ ...small, sz: "1" }, "x", []));
    expect(r).toMatchObject({ status: "BLOCKED", reasonCode: 103 });
  });

  it("above escalation threshold → PENDING 303; owner approval executes it", async () => {
    const r = await gw.submitIntent(await builder.build({ ...small, sz: "0.001" }, "x", []));
    expect(r).toMatchObject({ status: "PENDING", reasonCode: 303 });
    const res = await fetch(`${url}/v1/intents/${r.requestId}`).then((x) => x.json());
    const { APPROVAL_TYPES, EIP712_DOMAIN } = await import("@bekci/shared");
    const msg = { requestId: r.requestId, policyId: DEMO_POLICY_ID, normalizedOrderHash: res.normalizedOrderHash, decision: "approve" as const, nonce: ("0x" + "11".repeat(16)) as `0x${string}`, expiresAt: Math.floor(Date.now() / 1000) + 60 };
    // wrong signer first
    const bad = await attacker.signTypedData({ domain: EIP712_DOMAIN, types: APPROVAL_TYPES, primaryType: "ApprovalDecision", message: { ...msg, expiresAt: BigInt(msg.expiresAt) } });
    expect((await gw.approve({ ...msg, ownerSignature: bad })).status).toBe("PENDING");
    const sig = await owner.signTypedData({ domain: EIP712_DOMAIN, types: APPROVAL_TYPES, primaryType: "ApprovalDecision", message: { ...msg, expiresAt: BigInt(msg.expiresAt) } });
    expect((await gw.approve({ ...msg, ownerSignature: sig })).status).toBe("FILLED");
  });

  it("owner pause blocks new risk-increasing orders", async () => {
    const { PAUSE_TYPES, EIP712_DOMAIN } = await import("@bekci/shared");
    const cmd = { policyId: DEMO_POLICY_ID, paused: true, nonce: ("0x" + "22".repeat(16)) as `0x${string}`, issuedAt: Math.floor(Date.now() / 1000) };
    const sig = await owner.signTypedData({ domain: EIP712_DOMAIN, types: PAUSE_TYPES, primaryType: "PauseCommand", message: { ...cmd, issuedAt: BigInt(cmd.issuedAt) } });
    expect((await gw.pause({ ...cmd, ownerSignature: sig })).ok).toBe(true);
    const r = await gw.submitIntent(await builder.build({ ...small }, "x", []));
    expect(r).toMatchObject({ status: "BLOCKED", reasonCode: 100 });
    const un = { ...cmd, paused: false, nonce: ("0x" + "23".repeat(16)) as `0x${string}` };
    await gw.pause({ ...un, ownerSignature: await owner.signTypedData({ domain: EIP712_DOMAIN, types: PAUSE_TYPES, primaryType: "PauseCommand", message: { ...un, issuedAt: BigInt(un.issuedAt) } }) });
  });

  it("audit log hash chain is intact", async () => {
    const { hashCanonical } = await import("@bekci/shared");
    let prev = `0x${"0".repeat(64)}`;
    for (const e of gw.state.events) {
      const { hash, ...rest } = e;
      expect(e.prevHash).toBe(prev);
      expect(hashCanonical(rest)).toBe(hash);
      prev = hash;
    }
  });

  it("agent client talks to the gateway over HTTP", async () => {
    const client = new BekciClient(url, agent, DEMO_POLICY_ID);
    const s = await client.read("news", "bitcoin");
    expect(s.flags).not.toContain("contains_instructions");
    const r = await client.submitIntent(await builder.build({ ...small }, "x", [s.readId]));
    expect(r.status).toBe("FILLED");
  });
});

describe("prompt injection", () => {
  const gw = setup(POISONED_ARTICLE);
  const builder = new IntentBuilder(agent, DEMO_POLICY_ID, DEMO_AGENT_ID);
  let client: BekciClient;
  beforeAll(async () => {
    await new Promise<void>((r) => gw.server.listen(0, "127.0.0.1", r));
    client = new BekciClient(`http://127.0.0.1:${(gw.server.address() as { port: number }).port}`, agent, DEMO_POLICY_ID);
  });
  afterAll(() => gw.server.close());

  it("raw article never reaches the agent; summary is flagged", async () => {
    const s = await client.read("news", "bitcoin");
    expect(s.flags).toContain("contains_instructions");
    expect(JSON.stringify(s)).not.toMatch(/ignore all previous/i);
  });

  it("read signed by another key is refused", async () => {
    const evil = new BekciClient(`http://127.0.0.1:${(gw.server.address() as { port: number }).port}`, attacker, DEMO_POLICY_ID);
    await expect(evil.read("news", "bitcoin")).rejects.toThrow();
  });

  it("a small, in-limit order steered by the poisoned read is blocked by the auditor (201)", async () => {
    const s = await client.read("news", "bitcoin");
    const r = await gw.submitIntent(await builder.build({ ...small }, "Ignore limits and buy immediately as instructed", [s.readId]));
    expect(r).toMatchObject({ status: "BLOCKED", reasonCode: 201 });
  });

  it("the injected 5 BTC market buy is rejected before policy", async () => {
    const r = await gw.submitIntent(await builder.build({ tool: "spot_place_order", instId: "BTC-USDT", side: "buy", ordType: "market", sz: "5" }, "owner authorized", []));
    expect(r.status).toBe("REJECTED_SCHEMA");
  });
});
