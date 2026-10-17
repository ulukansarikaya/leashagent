import { bytesToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { signApproval, type Hex, type OrderIntent, type Policy, type SignedApproval, type ValidatedIntent } from "@leashagent/shared";
import {
  BTC_USDT,
  MockAgent,
  MockAuditor,
  MockMarketData,
  MockOrderOwnership,
  MockPayment,
  MockPolicyChain,
  MockRiskProvider,
  mockPolicy,
} from "@leashagent/mocks";
import {
  ApprovalHandler,
  AuditLog,
  ChainQueue,
  DefaultIntentGate,
  DefaultPolicyEngine,
  DefaultRiskStore,
  GatewayStore,
  LocalAuthorizer,
  PolicyLoader,
  SerialQueue,
  isValidated,
  openGatewayDb,
  type DecisionOutcome,
} from "../src";

export const ETH_USDT = { instId: "ETH-USDT", lotSz: "0.0001", tickSz: "0.01", minSz: "0.001" };

/** Full L3 + L4 + L5 stack wired to mocks of Person 2 / Person 3 components. */
export async function harness(overrides: Partial<Policy> = {}, opts: { credits?: number } = {}) {
  let now = Math.floor(Date.now() / 1000);
  const clock = () => now;

  const db = openGatewayDb(":memory:");
  const store = new GatewayStore(db);
  const audit = new AuditLog(db);
  const outbox = new ChainQueue(db, clock);

  const agent = new MockAgent();
  const owner = privateKeyToAccount(generatePrivateKey());
  const policy = mockPolicy(agent.address, overrides, now, owner.address);
  const chain = new MockPolicyChain();
  chain.publish(policy);

  const loader = new PolicyLoader({ store, chain, docs: chain, clock, cacheTtlSec: 30 });
  const riskProvider = new MockRiskProvider(clock);
  const market = new MockMarketData(clock, [BTC_USDT, ETH_USDT]);
  market.quotes.set("ETH-USDT", { bid: "2999", ask: "3001", last: "3000" });
  const ownership = new MockOrderOwnership(clock);
  const payment = new MockPayment(opts.credits ?? 100);
  const auditor = new MockAuditor();
  const signerAccount = privateKeyToAccount(generatePrivateKey());
  const authorizer = new LocalAuthorizer(signerAccount, "guard-1", clock);
  const risk = new DefaultRiskStore({ db, store, risk: riskProvider, clock });
  const queue = new SerialQueue();

  const engine = new DefaultPolicyEngine({
    store, audit, loader, risk, market, ownership, payment, auditor, auditorTimeoutMs: 100,
    authorizer, outbox, clock, queue,
  });
  const approvals = new ApprovalHandler({ engine, store, audit, loader, outbox, clock });
  const gate = new DefaultIntentGate({ store, audit, instruments: market, clock });

  const loaded = await loader.load(policy.binding.policyId);
  if (!loaded.ok) throw new Error(`policy failed to load: ${loaded.reason}`);

  const base = { policyId: policy.binding.policyId, agentId: policy.binding.agentId };

  /** Sign → L3 → L4. Returns the L4 outcome (throws if L3 rejected). */
  async function submit(intent: OrderIntent, extra: { referencedReadIds?: string[]; agentReason?: string } = {}) {
    const req = await agent.sign({ ...base, intent }, { issuedAt: now, ...extra });
    const v = await gate.validate(req);
    if (!isValidated(v)) throw new Error(`L3 rejected: ${JSON.stringify(v)}`);
    return { v, out: await engine.decide(v) };
  }

  async function approve(
    v: ValidatedIntent,
    decision: "approve" | "reject" = "approve",
    patch: Partial<Omit<SignedApproval, "ownerSignature">> = {},
    signer = owner,
  ) {
    const unsigned = {
      requestId: v.request.requestId,
      policyId: v.request.policyId,
      normalizedOrderHash: v.normalizedOrderHash,
      decision,
      nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
      expiresAt: now + 300,
      ...patch,
    };
    const signed: SignedApproval = await signApproval(signer, unsigned);
    return { signed, result: await approvals.handle(signed) };
  }

  return {
    db, store, audit, outbox, agent, owner, policy, chain, loader, riskProvider, market, ownership, payment,
    auditor, authorizer, signerAccount, risk, engine, approvals, gate, base, submit, approve,
    clock, advance: (s: number) => { now += s; },
  };
}

export type Harness = Awaited<ReturnType<typeof harness>>;
export type { DecisionOutcome };
export type { Hex };
