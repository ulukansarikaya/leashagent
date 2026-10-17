import {
  canonicalJson,
  chainRecordSchema,
  type ChainOutboxStats,
  type ChainRecord,
  type ChainWritePayload,
  type Hex,
} from "@leashagent/shared";
import type { AuditLog } from "./audit";
import type { Db } from "./db";
import type { Clock, DecisionChainWriter } from "./ports";

const ZERO_POLICY = ("0x" + "00".repeat(32)) as Hex;

/**
 * Gateway side of the durable chain queue (§6.7, INV-15). `enqueueSync` is a local insert into
 * `chain_outbox` that runs inside the decision's own transaction, so a decision and its evidence
 * record commit together. Sending is done by Person 3's `@leashagent/chain` ChainOutbox worker over the
 * same table (see `chainEvidence` in createGateway). The decision path never waits on the chain.
 *
 * Each enqueue also appends a `chain_write` audit event with state `pending` (shared ChainWritePayload).
 */
export class ChainQueue implements DecisionChainWriter {
  constructor(private readonly db: Db, private readonly clock: Clock, private readonly audit?: AuditLog) {}

  async enqueue(r: ChainRecord): Promise<void> {
    this.enqueueSync(r);
  }

  /** `policyId` is required for execution records (they do not carry one). */
  enqueueSync(r: ChainRecord, policyId?: Hex): void {
    const record = chainRecordSchema.parse(r) as ChainRecord;
    const now = this.clock();
    this.db.prepare("INSERT INTO chain_outbox (record_json, created_at) VALUES (?, ?)").run(canonicalJson(record), now);
    if (this.audit) {
      const payload: ChainWritePayload = { state: "pending", kind: record.kind };
      if (record.kind === "execution") payload.eventSeq = record.eventSeq;
      this.audit.appendSync({
        ts: now,
        policyId: record.kind === "decision" ? record.policyId : (policyId ?? ZERO_POLICY),
        requestId: record.requestId,
        type: "chain_write",
        payload,
      });
    }
  }

  /** Records not yet confirmed or dead. */
  pending(): ChainRecord[] {
    return (this.db
      .prepare("SELECT record_json FROM chain_outbox WHERE state IN ('pending', 'submitted') ORDER BY id")
      .all() as { record_json: string }[]).map((r) => JSON.parse(r.record_json) as ChainRecord);
  }

  /** Local view of the queue, same keys as `@leashagent/chain` OutboxStats. */
  stats(): ChainOutboxStats {
    const s: ChainOutboxStats = { pending: 0, submitted: 0, confirmed: 0, dead: 0 };
    const rows = this.db.prepare("SELECT state, COUNT(*) AS n FROM chain_outbox GROUP BY state").all() as {
      state: keyof ChainOutboxStats;
      n: number;
    }[];
    for (const r of rows) s[r.state] = r.n;
    return s;
  }
}

/** Structural mirror of `@leashagent/chain` OutboxEvent (no package dependency, §15.2). */
export type ChainWorkerEvent =
  | { type: "confirmed"; id: number; txHash: string | null; record: ChainRecord }
  | { type: "retry"; id: number; error: string; attempts: number }
  | { type: "dead"; id: number; error: string; record: ChainRecord };

/** The worker that actually sends records (Person 3's ChainOutbox fits this shape). */
export type ChainEvidenceWorker = {
  stats(): ChainOutboxStats;
  start(intervalMs?: number): void;
  stop(): void;
};

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/** Turn worker events into `chain_write` audit events for the dashboard (shared ChainWritePayload). */
export function chainWriteAuditor(audit: AuditLog, clock: Clock, policyOf: (requestId: string) => Hex | undefined) {
  return (e: ChainWorkerEvent): void => {
    const ts = clock();
    if (e.type === "retry") {
      audit.appendSync({
        ts, policyId: ZERO_POLICY, type: "chain_write",
        payload: { state: "retry", error: e.error.slice(0, 500), attempts: e.attempts } satisfies ChainWritePayload,
      });
      return;
    }
    const r = e.record;
    const payload: ChainWritePayload = { state: e.type, kind: r.kind };
    if (r.kind === "execution") payload.eventSeq = r.eventSeq;
    if (e.type === "confirmed" && e.txHash && BYTES32.test(e.txHash)) payload.txHash = e.txHash as Hex;
    if (e.type === "dead") payload.error = e.error.slice(0, 500);
    audit.appendSync({
      ts,
      policyId: r.kind === "decision" ? r.policyId : (policyOf(r.requestId) ?? ZERO_POLICY),
      requestId: r.requestId,
      type: "chain_write",
      payload,
    });
  };
}
