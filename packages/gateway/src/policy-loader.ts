import type { EpochSec, Hex, Policy, PolicyRecord } from "@leashagent/shared";
import type { Clock } from "./ports";
import type { CachedPolicy, GatewayStore } from "./store";

/**
 * Result of a full on-chain verification — structurally `@leashagent/chain` `loadVerifiedPolicy`
 * (PolicyRegistry read → policyURI fetch → hash/version/binding/delegation check → revoked/expiry).
 */
export type VerifiedPolicyResult =
  | { ok: true; policy: Policy; record: PolicyRecord }
  | { ok: false; reason: string };

export type LoadedPolicy = CachedPolicy & { paused: boolean; source: "chain" | "cache" };
export type PolicyLoadResult = { ok: true; p: LoadedPolicy } | { ok: false; reason: string };

export type PolicyLoaderDeps = {
  store: GatewayStore;
  clock: Clock;
  /** e.g. `(id) => loadVerifiedPolicy(chainClient, id)` from @leashagent/chain. */
  verify: (policyId: Hex) => Promise<VerifiedPolicyResult>;
  /** POLICY_CACHE_TTL_SEC: oldest verified entry still usable while the chain cannot be read. */
  cacheTtlSec: number;
  /** Serve the verified cache without any RPC while younger than this (default: cacheTtlSec). */
  refreshAfterSec?: number;
};

/** Reasons that mean the delegation itself is no longer usable (not a transport problem). */
const INACTIVE = new Set(["revoked", "expired"]);
/** Transport problems: a still-young verified cache may cover them. */
const TRANSIENT = new Set(["chain_unavailable", "fetch_failed"]);

/**
 * L4 PolicyLoader (§6.4 step 2, INV-11). Verification is @leashagent/chain's `loadVerifiedPolicy`; this class
 * only adds the verified cache:
 *  - a verified entry younger than `refreshAfterSec` is used without an RPC (no live chain read per order);
 *  - otherwise the chain is re-verified; on a transport failure the cache is used only within `cacheTtlSec`;
 *  - hash/schema/binding/delegation mismatches are never covered by the cache (fail closed);
 *  - revoked/expired marks the cached delegation inactive so L3 rejects further intents.
 * On-chain pause reaches the cache immediately through `watchPause` (PauseGateway.onChainPause), and L6
 * independently re-reads PolicyRegistry before every write (§6.6 step 5).
 */
export class PolicyLoader {
  constructor(private readonly d: PolicyLoaderDeps) {}

  async load(policyId: Hex, opts: { fresh?: boolean } = {}): Promise<PolicyLoadResult> {
    const now = this.d.clock();
    const cached = this.d.store.getPolicy(policyId);
    const age = (c: CachedPolicy) => now - c.fetchedAt;
    const fromCache = (c: CachedPolicy): PolicyLoadResult => ({
      ok: true,
      p: { ...c, paused: c.pausedChain || c.pausedLocal, source: "cache" },
    });

    const refreshAfter = this.d.refreshAfterSec ?? this.d.cacheTtlSec;
    if (cached && !cached.revoked && !opts.fresh && age(cached) < refreshAfter) return fromCache(cached);

    const r = await this.d.verify(policyId);
    if (!r.ok) {
      if (cached && INACTIVE.has(r.reason)) {
        this.d.store.upsertPolicy({ ...cached, revoked: true, fetchedAt: now });
      } else if (cached && !cached.revoked && TRANSIENT.has(r.reason) && age(cached) <= this.d.cacheTtlSec) {
        return fromCache(cached);
      }
      return { ok: false, reason: r.reason };
    }

    const { policy, record } = r;
    const fresh: CachedPolicy = {
      policy,
      policyHash: record.policyHash,
      version: record.version,
      agentAuthAddress: record.agentAuthAddress,
      delegationValidUntil: record.delegationExpiresAt as EpochSec,
      revoked: record.revoked,
      pausedChain: record.paused,
      pausedLocal: cached?.pausedLocal ?? false, // local deny state survives chain refreshes (§6.7)
      fetchedAt: now,
    };
    this.d.store.upsertPolicy(fresh);
    return { ok: true, p: { ...fresh, paused: fresh.pausedChain || fresh.pausedLocal, source: "chain" } };
  }
}

/**
 * x402 purchase guard (§21.2 rule 3): the delegated agent of a policy, read through the SAME verified loader L3/L4 use.
 * Structurally matches `@leashagent/payments` DelegationResolver (no import — §15.2).
 */
export function delegationResolver(loader: PolicyLoader, clock: Clock) {
  return {
    async activeDelegation(policyId: Hex) {
      const r = await loader.load(policyId);
      if (!r.ok) {
        // Same semantics as @leashagent/chain createPolicyDelegationResolver: a known but inactive
        // delegation is reported as inactive; anything unverifiable is unknown.
        if (r.reason === "revoked" || r.reason === "expired") {
          return { agentId: "", agentAuthAddress: "0x0000000000000000000000000000000000000000" as Hex, active: false };
        }
        return undefined;
      }
      const p = r.p;
      return {
        agentId: p.policy.binding.agentId,
        agentAuthAddress: p.agentAuthAddress as Hex,
        active: !p.revoked && clock() <= p.delegationValidUntil,
      };
    },
  };
}
