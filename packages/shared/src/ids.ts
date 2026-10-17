import { concat, encodeAbiParameters, getAddress, keccak256, stringToHex } from "viem";
import { hashCanonical, keccakUtf8 } from "./canonical.js";
import type { AuditorOutput, Hex, OrderIntent, RuleResult, UUID } from "./types.js";

const UINT_DEC = /^(0|[1-9]\d*)$/;

/**
 * policyId = keccak256(abi.encode(owner, accountRef, agentRegistry, agentRegistryId)) — §5.2, §25.1.
 * Matches PolicyRegistry.computePolicyId on chain.
 */
export function computePolicyId(owner: Hex, accountRef: Hex, agentRegistry: Hex, agentRegistryId: string): Hex {
  if (!UINT_DEC.test(agentRegistryId)) throw new Error("agentRegistryId must be a canonical unsigned decimal string");
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [getAddress(owner), accountRef, getAddress(agentRegistry), BigInt(agentRegistryId)],
    ),
  );
}

/** accountRef = keccak256(okxAccountIdentifier). The raw identifier is never stored or written on chain. */
export function computeAccountRef(okxAccountIdentifier: string): Hex {
  return keccakUtf8(okxAccountIdentifier);
}

/** On-chain requestId: keccak256(requestId string) — §7. */
export function requestIdToBytes32(requestId: UUID): Hex {
  return keccakUtf8(requestId);
}

/** clOrdId = "bk" + hex(keccak256(policyId ‖ utf8(requestId))).slice(0, 30) — 32 alphanumeric chars (§5.5). */
export function deriveClOrdId(policyId: Hex, requestId: UUID): string {
  return "bk" + keccak256(concat([policyId, stringToHex(requestId)])).slice(2, 32);
}

/** AgentIntent.intentHash = keccak256(canonicalJson(intent)). */
export function computeIntentHash(intent: OrderIntent): Hex {
  return hashCanonical(intent);
}

/** AgentIntent.reasonHash = keccak256(agentReason). */
export function computeReasonHash(agentReason: string): Hex {
  return keccakUtf8(agentReason);
}

/**
 * Decision.evidenceHash = keccak256(canonicalJson({ruleResult, auditorOutput, readIds})).
 * Freeze decision: `auditorOutput.raw` is excluded — it is archive-only and may contain
 * provider JSON (floats) that canonicalJson rejects.
 */
export function computeEvidenceHash(ruleResult: RuleResult, auditorOutput: AuditorOutput | undefined, readIds: UUID[]): Hex {
  const auditor = auditorOutput ? { ...auditorOutput, raw: undefined } : undefined;
  return hashCanonical({ ruleResult, auditorOutput: auditor, readIds });
}
