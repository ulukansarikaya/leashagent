import type { AddressInfo } from "node:net";
import { bytesToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  signApproval,
  signPauseCommand,
  type Hex,
  type OrderIntent,
  type Policy,
  type SignedIntentRequest,
} from "@bekci/shared";
import {
  BTC_USDT,
  FakeAtkClient,
  MockAgent,
  MockAuditor,
  MockMarketData,
  MockOrderOwnership,
  MockPayment,
  MockPolicyChain,
  MockRiskProvider,
  mockPolicy,
} from "@bekci/mocks";
import { DefaultExecutor, openExecutorDb } from "@bekci/executor";
import { createGateway, createGatewayServer, type PaymentEntitlement } from "@bekci/gateway";
import { createChainPolicyStateProvider } from "@bekci/chain";

const nonce16 = () => bytesToHex(crypto.getRandomValues(new Uint8Array(16)));

/**
 * The whole system as deployed for the demo, with Person 2/3 parts mocked:
 * HTTP gateway (L3–L5 + L7 server side) ⇄ executor (own DB, own config) ⇄ fake OKX.
 */
export async function appHarness(
  policyOverrides: Partial<Policy> = {},
  opts: { credits?: number; payment?: PaymentEntitlement } = {},
) {
  let now = Math.floor(Date.now() / 1000);
  const clock = () => now;

  const agent = new MockAgent();
  const owner = privateKeyToAccount(generatePrivateKey());
  const guard = privateKeyToAccount(generatePrivateKey());
  const policy = mockPolicy(agent.address, policyOverrides, now, owner.address);
  const chain = new MockPolicyChain();
  chain.publish(policy);

  const riskProvider = new MockRiskProvider(clock);
  const market = new MockMarketData(clock, [BTC_USDT]);
  const ownership = new MockOrderOwnership(clock);
  const payment = new MockPayment(opts.credits ?? 100);
  const auditor = new MockAuditor();
  const atk = new FakeAtkClient();

  const executor = new DefaultExecutor({
    db: openExecutorDb(":memory:"),
    atk,
    // Person 3's real L6 adapter (reads PolicyRegistry directly), here over the mock registry.
    policyState: createChainPolicyStateProvider(chain),
    config: {
      guardSignerAddress: guard.address,
      guardInstanceId: "guard-1",
      accountRef: policy.binding.accountRef,
      allowedTools: ["spot_place_order", "spot_cancel_order"],
      clockSkewSec: 60,
    },
    clock,
  });
  /** Simulates the executor transport being down (process/channel unavailable). */
  const executorLink = { down: false };

  const app = createGateway(
    { guardInstanceId: "guard-1", policyCacheTtlSec: 30, auditorTimeoutMs: 100, unknownGraceSec: 30 },
    {
      signer: guard,
      chain,
      docs: chain,
      risk: riskProvider,
      market,
      ownership,
      payment: opts.payment ?? payment,
      auditor,
      executor: {
        execute: (a, o) => {
          if (executorLink.down) return Promise.reject(new Error("ECONNREFUSED"));
          return executor.execute(a, o);
        },
      },
      executionLookup: executor,
      reconcileExecutor: async () => {
        for (const e of await executor.reconcile()) {
          const row = app.store.findRequest(e.requestId);
          if (row) app.executionEvents.onEvent(e, { policyId: row.policyId });
        }
      },
      clock,
    },
  );
  const reg = await app.registerPolicy(policy.binding.policyId);
  if (!reg.ok) throw new Error(reg.reason);

  const server = createGatewayServer(app, { ssePollMs: 20, sseHeartbeatMs: 60_000 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const base = { policyId: policy.binding.policyId, agentId: policy.binding.agentId };

  async function post(path: string, body: unknown) {
    const res = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  async function get(path: string) {
    const res = await fetch(url + path);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function signIntent(intent: OrderIntent | Record<string, unknown>, extra: Partial<SignedIntentRequest> = {}, signer = agent) {
    return signer.sign({ ...base, intent }, { issuedAt: now, ...extra });
  }

  async function intent(i: OrderIntent | Record<string, unknown>, extra: Partial<SignedIntentRequest> = {}) {
    const req = await signIntent(i, extra);
    return { req, ...(await post("/v1/intents", req)) };
  }

  async function pauseCmd(paused: boolean, signer = owner, patch: { issuedAt?: number; nonce?: Hex } = {}) {
    const unsigned = { policyId: base.policyId, paused, nonce: patch.nonce ?? nonce16(), issuedAt: patch.issuedAt ?? now };
    return signPauseCommand(signer, unsigned);
  }

  async function approval(requestId: string, normalizedOrderHash: Hex, decision: "approve" | "reject" = "approve", signer = owner) {
    const unsigned = { requestId, policyId: base.policyId, normalizedOrderHash, decision, nonce: nonce16(), expiresAt: now + 300 };
    return signApproval(signer, unsigned);
  }

  async function close() {
    await new Promise<void>((r) => server.close(() => r()));
    server.closeAllConnections?.();
    app.close();
  }

  return {
    url, app, server, agent, owner, guard, policy, chain, riskProvider, market, ownership, payment, auditor, atk,
    executor, executorLink, base, post, get, signIntent, intent, pauseCmd, approval, close,
    clock, advance: (s: number) => { now += s; },
  };
}

export type AppHarness = Awaited<ReturnType<typeof appHarness>>;
