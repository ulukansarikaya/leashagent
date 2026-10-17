import { hashCanonical, type ChainRecord, type Hex, type Policy, type PolicyRecord } from "@bekci/shared";

/**
 * Mock of Person 3's PolicyRegistry client + policyURI storage.
 * `publish()` mimics the owner's createPolicy/setPolicy transaction.
 */
export class MockPolicyChain {
  private readonly records = new Map<Hex, PolicyRecord>();
  private readonly docs = new Map<string, unknown>();
  failing = false;
  docFailing = false;

  publish(policy: Policy, opts: { paused?: boolean; revoked?: boolean } = {}): PolicyRecord {
    const uri = `mock://policy/${policy.binding.policyId}/v${policy.policyVersion}`;
    this.docs.set(uri, structuredClone(policy));
    const rec: PolicyRecord = {
      owner: policy.binding.owner,
      accountRef: policy.binding.accountRef,
      agentRegistry: policy.binding.agentRegistry,
      agentRegistryId: policy.binding.agentRegistryId,
      agentAuthAddress: policy.agentAuthAddress,
      policyHash: hashCanonical(policy),
      policyURI: uri,
      version: policy.policyVersion,
      delegationExpiresAt: policy.delegationValidUntil,
      revoked: opts.revoked ?? false,
      paused: opts.paused ?? false,
    };
    this.records.set(policy.binding.policyId, rec);
    return rec;
  }

  private readonly pauseWatchers = new Map<Hex, Set<(paused: boolean) => void>>();

  setPaused(policyId: Hex, paused: boolean): void {
    this.mutate(policyId, { paused });
    for (const cb of this.pauseWatchers.get(policyId) ?? []) cb(paused);
  }

  /** PolicyChainClient.watchPause (§15.1). */
  watchPause(policyId: Hex, cb: (paused: boolean) => void): () => void {
    const set = this.pauseWatchers.get(policyId) ?? new Set();
    set.add(cb);
    this.pauseWatchers.set(policyId, set);
    return () => set.delete(cb);
  }

  setRevoked(policyId: Hex, revoked: boolean): void {
    this.mutate(policyId, { revoked });
  }

  /** Simulates a tampered document behind an unchanged on-chain hash. */
  tamperDocument(policyId: Hex, mutate: (p: Policy) => void): void {
    const rec = this.records.get(policyId)!;
    const doc = structuredClone(this.docs.get(rec.policyURI)) as Policy;
    mutate(doc);
    this.docs.set(rec.policyURI, doc);
  }

  mutate(policyId: Hex, patch: Partial<PolicyRecord>): void {
    const rec = this.records.get(policyId);
    if (!rec) throw new Error("unknown policy");
    this.records.set(policyId, { ...rec, ...patch });
  }

  // PolicyChainClient
  async getPolicy(policyId: Hex): Promise<PolicyRecord> {
    if (this.failing) throw new Error("rpc unavailable");
    const rec = this.records.get(policyId);
    if (!rec) throw new Error("policy not found");
    return { ...rec };
  }

  /** Executor-side PolicyStateProvider (authenticated read adapter in production). */
  async getExecutionState(policyId: Hex) {
    const r = await this.getPolicy(policyId);
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
  }

  // PolicyDocumentFetcher
  async fetch(uri: string): Promise<unknown> {
    if (this.docFailing) throw new Error("document unavailable");
    if (!this.docs.has(uri)) throw new Error("document not found");
    return structuredClone(this.docs.get(uri));
  }
}

/** Mock DecisionChainWriter that just records what would be written. */
export class MockChainWriter {
  readonly records: ChainRecord[] = [];
  async enqueue(r: ChainRecord): Promise<void> {
    this.records.push(r);
  }
}
