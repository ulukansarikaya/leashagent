import { hashCanonical, type Policy } from "@leashagent/shared";
import { MockAgent, StaticInstruments, mockPolicy } from "@leashagent/mocks";
import { AuditLog, DefaultIntentGate, GatewayStore, openGatewayDb } from "../src";

export function setup(policyOverrides: Partial<Policy> = {}) {
  let now = Math.floor(Date.now() / 1000);
  const db = openGatewayDb(":memory:");
  const store = new GatewayStore(db);
  const audit = new AuditLog(db);
  const agent = new MockAgent();
  const instruments = new StaticInstruments();
  const policy = mockPolicy(agent.address, policyOverrides, now);
  store.upsertPolicy({
    policy,
    policyHash: hashCanonical(policy),
    version: policy.policyVersion,
    agentAuthAddress: policy.agentAuthAddress,
    delegationValidUntil: policy.delegationValidUntil,
    revoked: false,
    pausedChain: false,
    pausedLocal: false,
    fetchedAt: now,
  });
  const gate = new DefaultIntentGate({ store, audit, instruments, clock: () => now });
  const base = { policyId: policy.binding.policyId, agentId: policy.binding.agentId };
  return {
    db, store, audit, agent, instruments, policy, gate, base,
    advance: (s: number) => { now += s; },
    now: () => now,
  };
}
