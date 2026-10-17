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

const MAX_POLICY_BYTES = 64 * 1024;

/**
 * Fetch the policy JSON behind `policyURI`. Supports `data:application/json;base64,…` and `https://` (no redirects,
 * 10 s timeout, 64 KiB cap). The result is untrusted until `verifyPolicyDocument` checks it against the chain hash.
 */
export async function fetchPolicyDocument(uri: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  let text: string;
  if (uri.startsWith("data:application/json;base64,")) {
    text = Buffer.from(uri.slice("data:application/json;base64,".length), "base64").toString("utf8");
  } else if (uri.startsWith("https://")) {
    const res = await fetchImpl(uri, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!res.ok) throw new Error(`policy fetch HTTP ${res.status}`);
    text = await res.text();
  } else {
    throw new Error("unsupported policyURI scheme");
  }
  if (text.length > MAX_POLICY_BYTES) throw new Error("policy document too large");
  return JSON.parse(text);
}

export type LoadedPolicy =
  | { ok: true; policy: Policy; record: PolicyRecord }
  | {
      ok: false;
      reason: "unknown_policy" | "chain_unavailable" | "fetch_failed" | "revoked" | "expired" |
        Exclude<PolicyVerification, { ok: true }>["reason"];
    };

/**
 * L4 PolicyLoader core (§6.4 step 2, INV-11): read PolicyRegistry, fetch the document, verify hash/version/binding/
 * delegation, and check revocation/expiry. `paused` is NOT a failure here — it is returned in `record.paused` so L4 can
 * still allow a verified protective cancel. Any failure ⇒ caller must BLOCK 003 for risk-increasing orders.
 * Caching (short TTL) is the caller's job.
 */
export async function loadVerifiedPolicy(
  client: PolicyChainClient,
  policyId: Hex,
  opts: { fetchImpl?: typeof fetch; now?: EpochSec } = {},
): Promise<LoadedPolicy> {
  let record: PolicyRecord;
  try {
    record = await client.getPolicy(policyId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: /UnknownPolicy/.test(msg) ? "unknown_policy" : "chain_unavailable" };
  }
  let doc: unknown;
  try {
    doc = await fetchPolicyDocument(record.policyURI, opts.fetchImpl);
  } catch {
    return { ok: false, reason: "fetch_failed" };
  }
  const v = verifyPolicyDocument(policyId, doc, record);
  if (!v.ok) return v;
  if (record.revoked) return { ok: false, reason: "revoked" };
  if (!delegationActive(record, opts.now ?? Math.floor(Date.now() / 1000))) return { ok: false, reason: "expired" };
  return { ok: true, policy: v.policy, record };
}

/**
 * Chain-backed resolver for `@bekci/payments` purchaseCredits (structurally matches its DelegationResolver):
 * only a fully verified, active policy yields a delegation; anything else ⇒ undefined / inactive.
 */
export function createPolicyDelegationResolver(client: PolicyChainClient, opts: { fetchImpl?: typeof fetch } = {}) {
  return {
    async activeDelegation(policyId: Hex) {
      const l = await loadVerifiedPolicy(client, policyId, opts);
      if (l.ok) return { agentId: l.policy.binding.agentId, agentAuthAddress: l.policy.agentAuthAddress, active: true };
      if (l.reason === "revoked" || l.reason === "expired") {
        return { agentId: "", agentAuthAddress: "0x0000000000000000000000000000000000000000" as Hex, active: false };
      }
      return undefined;
    },
  };
}
