import { keccak256 } from "viem";
import { computePolicyId, formatAgentId, hashCanonical, type Hex, type Policy } from "@bekci/shared";

export { computePolicyId };

export const MOCK_OWNER = "0x1111111111111111111111111111111111111111" as Hex;
export const MOCK_REGISTRY = "0x8004000000000000000000000000000000008004" as Hex;
export const MOCK_ACCOUNT_REF = keccak256(new TextEncoder().encode("okx-demo-account-1"));

export function mockPolicy(
  agentAuthAddress: Hex,
  overrides: Partial<Policy> = {},
  now = Math.floor(Date.now() / 1000),
  owner: Hex = MOCK_OWNER,
): Policy {
  const agentRegistryId = "42";
  const policyId = computePolicyId(owner, MOCK_ACCOUNT_REF, MOCK_REGISTRY, agentRegistryId);
  return {
    policyVersion: 1,
    binding: {
      policyId,
      owner,
      accountRef: MOCK_ACCOUNT_REF,
      agentRegistry: MOCK_REGISTRY,
      agentRegistryId,
      agentId: formatAgentId(43113, MOCK_REGISTRY, agentRegistryId),
    },
    agentAuthAddress,
    delegationValidUntil: now + 7 * 24 * 3600,
    mandate: "Trade BTC-USDT spot with a trend-following strategy; small sizes only.",
    allowedInstruments: ["BTC-USDT"],
    allowedTools: ["spot_place_order", "spot_cancel_order"],
    forbiddenTools: ["transfer", "withdraw"],
    limits: {
      maxOrderNotionalUsdt: "500",
      maxOpenNotionalUsdt: "2000",
      maxOrdersPerMinute: 5,
      maxDailyLossUsdt: "100",
      maxPriceDeviationBps: 200,
      marketSlippageBufferBps: 50,
      escalateAboveUsdt: "300",
    },
    freshness: { maxRiskDataAgeSec: 30, maxMarketDataAgeSec: 10 },
    auditor: {
      mode: "disabled",
      maxInjectionSuspicion: "0.5",
      minConsistency: "0.6",
      minVerdictConfidence: "0.5",
      onUnavailable: "pending",
    },
    pendingTtlSec: 900,
    authorizationTtlSec: 30,
    ...overrides,
  };
}

/** What the PolicyRegistry would report for this policy (mock of Person 3's chain client). */
export function mockChainRecord(p: Policy) {
  return {
    policyHash: hashCanonical(p),
    version: p.policyVersion,
    agentAuthAddress: p.agentAuthAddress,
    delegationValidUntil: p.delegationValidUntil,
    revoked: false,
    paused: false,
  };
}
