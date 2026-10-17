import { getAddress, type Address, type PublicClient } from "viem";
import {
  computePolicyId,
  hashCanonical,
  policySchema,
  type EpochSec,
  type Hex,
  type Policy,
  type PolicyChainClient,
  type PolicyRecord,
} from "@bekci/shared";
import { policyRegistryAbi } from "./abi.js";

export function createPolicyChainClient(publicClient: PublicClient, registryAddress: Address): PolicyChainClient {
  return {
    async getPolicy(policyId: Hex): Promise<PolicyRecord> {
      const r = await publicClient.readContract({
        address: registryAddress,
        abi: policyRegistryAbi,
        functionName: "getPolicy",
        args: [policyId],
      });
      return {
        owner: r.owner,
        accountRef: r.accountRef,
        agentRegistry: r.agentRegistry,
        agentRegistryId: r.agentRegistryId.toString(),
        agentAuthAddress: r.agentAuthAddress,
        policyHash: r.policyHash,
        policyURI: r.policyURI,
        version: Number(r.version),
        delegationExpiresAt: Number(r.delegationExpiresAt),
        revoked: r.revoked,
        paused: r.paused,
      };
    },

    watchPause(policyId: Hex, cb: (paused: boolean) => void): () => void {
      return publicClient.watchContractEvent({
        address: registryAddress,
        abi: policyRegistryAbi,
        eventName: "PausedChanged",
        args: { policyId },
        onLogs: (logs) => {
          for (const l of logs) if (l.args.paused !== undefined) cb(l.args.paused);
        },
      });
    },
  };
}

export type PolicyVerification =
  | { ok: true; policy: Policy }
  | { ok: false; reason: "schema" | "hash_mismatch" | "version_mismatch" | "binding_mismatch" | "delegation_mismatch" };

/**
 * INV-11: a policy document is valid only if it parses strictly, its canonical hash equals the on-chain
 * policyHash, its version matches, and its binding/delegation match the on-chain record.
 * Freshness (revoked / expired / paused) is a separate check — see `delegationActive`.
 */
export function verifyPolicyDocument(policyId: Hex, doc: unknown, record: PolicyRecord): PolicyVerification {
  const parsed = policySchema.safeParse(doc);
  if (!parsed.success) return { ok: false, reason: "schema" };
  const policy = parsed.data as Policy;

  if (hashCanonical(policy) !== record.policyHash.toLowerCase()) return { ok: false, reason: "hash_mismatch" };
  if (policy.policyVersion !== record.version) return { ok: false, reason: "version_mismatch" };

  const b = policy.binding;
  const derived = computePolicyId(record.owner, record.accountRef, record.agentRegistry, record.agentRegistryId);
  if (
    derived !== policyId.toLowerCase() ||
    b.policyId.toLowerCase() !== derived ||
    getAddress(b.owner) !== getAddress(record.owner) ||
    b.accountRef.toLowerCase() !== record.accountRef.toLowerCase() ||
    getAddress(b.agentRegistry) !== getAddress(record.agentRegistry) ||
    b.agentRegistryId !== record.agentRegistryId
  ) {
    return { ok: false, reason: "binding_mismatch" };
  }
  if (
    getAddress(policy.agentAuthAddress) !== getAddress(record.agentAuthAddress) ||
    policy.delegationValidUntil !== record.delegationExpiresAt
  ) {
    return { ok: false, reason: "delegation_mismatch" };
  }
  return { ok: true, policy };
}

/** Delegation is usable only if not revoked and not expired. */
export function delegationActive(record: PolicyRecord, now: EpochSec): boolean {
  return !record.revoked && now <= record.delegationExpiresAt;
}

/** Chain-backed source for L6's PolicyStateProvider (§6.6 step 5) — reads PolicyRegistry directly, never the gateway. */
export function createChainPolicyStateProvider(client: PolicyChainClient) {
  return {
    async getExecutionState(policyId: Hex) {
      const r = await client.getPolicy(policyId);
      return {
        policyVersion: r.version,
        accountRef: r.accountRef,
        agentRegistry: r.agentRegistry,
        agentRegistryId: r.agentRegistryId,
        agentAuthAddress: r.agentAuthAddress,
        delegationValidUntil: r.delegationExpiresAt,
        revoked: r.revoked,
        paused: r.paused,
      };
    },
  };
}
