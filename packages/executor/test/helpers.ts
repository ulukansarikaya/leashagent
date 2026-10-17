import { randomUUID } from "node:crypto";
import { bytesToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  hashCanonical,
  normalizeOrder,
  signAuthorization,
  type ExecutionAuthorization,
  type ExecutionEvent,
  type NormalizedOrder,
  type OrderIntent,
} from "@leashagent/shared";
import { BTC_USDT, FakeAtkClient, MockPolicyChain, limitBuy, mockPolicy } from "@leashagent/mocks";
import { DefaultExecutor, openExecutorDb } from "../src";

export function setup(opts: { path?: string } = {}) {
  let now = Math.floor(Date.now() / 1000);
  const clock = () => now;
  const db = openExecutorDb(opts.path ?? ":memory:");
  const atk = new FakeAtkClient();
  const chain = new MockPolicyChain();
  const policy = mockPolicy("0x2222222222222222222222222222222222222222", {}, now);
  chain.publish(policy);
  const guard = privateKeyToAccount(generatePrivateKey());
  const sinkEvents: ExecutionEvent[] = [];
  const config = {
    guardSignerAddress: guard.address,
    guardInstanceId: "guard-1",
    accountRef: policy.binding.accountRef,
    allowedTools: ["spot_place_order", "spot_cancel_order"] as ("spot_place_order" | "spot_cancel_order")[],
    clockSkewSec: 60,
  };
  const executor = new DefaultExecutor({
    db, atk, policyState: chain, config, clock,
    sink: { onEvent: (e) => { sinkEvents.push(e); } },
  });

  async function authorize(
    intent: OrderIntent = limitBuy(),
    patch: Partial<Omit<ExecutionAuthorization, "signature">> = {},
    signer: PrivateKeyAccount = guard,
    requestId: string = randomUUID(),
  ): Promise<{ auth: ExecutionAuthorization; order: NormalizedOrder }> {
    const order = normalizeOrder(intent, BTC_USDT, requestId, policy.binding.policyId);
    const unsigned: Omit<ExecutionAuthorization, "signature"> = {
      requestId,
      policyId: policy.binding.policyId,
      policyVersion: policy.policyVersion,
      accountRef: policy.binding.accountRef,
      agentId: policy.binding.agentId,
      tool: order.tool,
      normalizedOrderHash: hashCanonical(order),
      nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
      issuedAt: now,
      expiresAt: now + 30,
      guardInstanceId: "guard-1",
      basis: "rules_only",
      ...patch,
    };
    return { auth: await signAuthorization(signer, unsigned), order };
  }

  return { db, atk, chain, policy, guard, config, executor, sinkEvents, authorize, clock, advance: (s: number) => { now += s; } };
}
