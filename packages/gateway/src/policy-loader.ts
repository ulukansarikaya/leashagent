import { derivePolicyId, hashCanonical, policySchema, type Hex, type Policy } from "@bekci/shared";
import type { Clock, PolicyChainClient, PolicyDocumentFetcher } from "./ports";
import type { CachedPolicy, GatewayStore } from "./store";

export type LoadedPolicy = CachedPolicy & { paused: boolean; source: "chain" | "cache" };
export type PolicyLoadResult = { ok: true; p: LoadedPolicy } | { ok: false; reason: string };

export type PolicyLoaderDeps = {
  store: GatewayStore;
  chain: PolicyChainClient;
  docs: PolicyDocumentFetcher;
  clock: Clock;
  cacheTtlSec: number; // POLICY_CACHE_TTL_SEC
};

const eqAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * L4 PolicyLoader (§6.4). The chain record is the source of truth for hash, version, delegation,
 * revocation and pause; the JSON under policyURI must hash to the on-chain policyHash (INV-11).
 * If the chain is unreachable, a cached policy is used only within its TTL; never past it.
 * A hash/binding mismatch is never papered over by the cache.
 */
export class PolicyLoader {
  constructor(private readonly d: PolicyLoaderDeps) {}

  async load(policyId: Hex): Promise<PolicyLoadResult> {
    const now = this.d.clock();
    const cached = this.d.store.getPolicy(policyId);

    let rec;
    try {
      rec = await this.d.chain.getPolicy(policyId);
    } catch {
      if (cached && now - cached.fetchedAt <= this.d.cacheTtlSec) {
        return { ok: true, p: { ...cached, paused: cached.pausedChain || cached.pausedLocal, source: "cache" } };
      }
      return { ok: false, reason: "chain unreachable and cache expired" };
    }

    let policy: Policy;
    if (cached && cached.policyHash === rec.policyHash && cached.version === rec.version) {
      policy = cached.policy;
    } else {
      let doc: unknown;
      try {
        doc = await this.d.docs.fetch(rec.policyURI);
      } catch {
        return { ok: false, reason: "policy document unavailable" };
      }
      const parsed = policySchema.safeParse(doc);
      if (!parsed.success) return { ok: false, reason: "policy document malformed" };
      policy = parsed.data as Policy;
      if (hashCanonical(policy) !== rec.policyHash) return { ok: false, reason: "policy hash mismatch" };
    }

    const b = policy.binding;
    if (
      policy.policyVersion !== rec.version ||
      b.policyId !== policyId ||
      derivePolicyId(b.owner, b.accountRef, b.agentRegistry, b.agentRegistryId) !== policyId ||
      !eqAddr(b.owner, rec.owner) ||
      b.accountRef !== rec.accountRef ||
      !eqAddr(b.agentRegistry, rec.agentRegistry) ||
      b.agentRegistryId !== rec.agentRegistryId
    ) {
      return { ok: false, reason: "policy binding/version mismatch" };
    }

    const fresh: CachedPolicy = {
      policy,
      policyHash: rec.policyHash,
      version: rec.version,
      agentAuthAddress: rec.agentAuthAddress,
      delegationValidUntil: rec.delegationExpiresAt,
      revoked: rec.revoked,
      pausedChain: rec.paused,
      pausedLocal: cached?.pausedLocal ?? false, // local deny state survives chain refreshes (§6.7)
      fetchedAt: now,
    };
    this.d.store.upsertPolicy(fresh);
    return { ok: true, p: { ...fresh, paused: fresh.pausedChain || fresh.pausedLocal, source: "chain" } };
  }
}
