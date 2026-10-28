import type { DatabaseSync } from "node:sqlite";
import { canonicalJson, chainRecordSchema, type ChainRecord, type DecisionChainWriter, type Hex } from "@leashagent/shared";
import { PermanentRevert, type DecisionLogPort } from "./decisionLogPort.js";

/**
 * chain_outbox (§8) + three additive columns owned by @leashagent/chain:
 *   state            pending | submitted | confirmed | dead
 *   next_attempt_at  backoff gate for transient failures
 *   confirmed_at     when the record was seen on chain
 */
export const CHAIN_OUTBOX_DDL = `
CREATE TABLE IF NOT EXISTS chain_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  tx_hash TEXT,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','submitted','confirmed','dead')),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  confirmed_at INTEGER
);
CREATE INDEX IF NOT EXISTS chain_outbox_open ON chain_outbox(state, id);
`;

export function migrateChainOutbox(db: DatabaseSync): void {
  db.exec(CHAIN_OUTBOX_DDL);
}

type Row = {
  id: number;
  record_json: string;
  attempts: number;
  tx_hash: string | null;
  state: string;
  next_attempt_at: number;
};

export type OutboxStats = { pending: number; submitted: number; confirmed: number; dead: number };

export type OutboxEvent =
  | { type: "confirmed"; id: number; txHash: string | null; record: ChainRecord }
  | { type: "retry"; id: number; error: string; attempts: number }
  | { type: "dead"; id: number; error: string; record: ChainRecord };

export type OutboxOptions = {
  now?: () => number; // epoch seconds
  baseBackoffSec?: number;
  maxBackoffSec?: number;
  onEvent?: (e: OutboxEvent) => void;
};

/**
 * Durable, FIFO chain writer (P9, INV-15). `enqueue` is a local SQLite insert — the decision path never
 * waits on the chain. The worker sends one record at a time in insertion order so a decision always lands
 * before its executions and eventSeq stays contiguous.
 */
export class ChainOutbox implements DecisionChainWriter {
  private readonly now: () => number;
  private readonly base: number;
  private readonly max: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly port: DecisionLogPort,
    private readonly opts: OutboxOptions = {},
  ) {
    migrateChainOutbox(db);
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.base = opts.baseBackoffSec ?? 2;
    this.max = opts.maxBackoffSec ?? 300;
  }

  async enqueue(r: ChainRecord): Promise<void> {
    const parsed = chainRecordSchema.parse(r) as ChainRecord;
    this.db
      .prepare("INSERT INTO chain_outbox (record_json, created_at) VALUES (?, ?)")
      .run(canonicalJson(parsed), this.now());
  }

  stats(): OutboxStats {
    const s: OutboxStats = { pending: 0, submitted: 0, confirmed: 0, dead: 0 };
    const rows = this.db.prepare("SELECT state, COUNT(*) AS n FROM chain_outbox GROUP BY state").all() as {
      state: keyof OutboxStats;
      n: number;
    }[];
    for (const r of rows) s[r.state] = r.n;
    return s;
  }

  /**
   * Process records until the queue is empty or a transient failure hits (head-of-line wait).
   * Returns the number of rows that reached a final state (confirmed or dead).
   */
  async drain(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let done = 0;
    try {
      for (;;) {
        const row = this.db
          .prepare("SELECT * FROM chain_outbox WHERE state IN ('pending','submitted') ORDER BY id LIMIT 1")
          .get() as Row | undefined;
        if (!row || row.next_attempt_at > this.now()) return done;
        const finished = await this.processRow(row);
        if (!finished) return done;
        done++;
      }
    } finally {
      this.running = false;
    }
  }

  /** Poll-loop helper for the gateway process. */
  start(intervalMs = 2000): void {
    const tick = async () => {
      try {
        await this.drain();
      } finally {
        this.timer = setTimeout(tick, intervalMs);
      }
    };
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async processRow(row: Row): Promise<boolean> {
    const record = chainRecordSchema.parse(JSON.parse(row.record_json)) as ChainRecord;
    try {
      // Idempotent recovery: a previous attempt may have landed before we recorded it.
      if (await this.port.isApplied(record)) {
        this.markConfirmed(row.id, row.tx_hash, record);
        return true;
      }
      if (row.state === "submitted" && row.tx_hash) {
        // Sent before but not visible yet — wait for that tx instead of sending a duplicate.
        const status = await this.port.waitForReceipt(row.tx_hash as Hex);
        if (status === "success") {
          this.markConfirmed(row.id, row.tx_hash, record);
          return true;
        }
        // reverted: fall through and re-simulate to learn whether it is permanent
      }

      await this.port.simulate(record);
      const hash = await this.port.send(record);
      this.db
        .prepare("UPDATE chain_outbox SET state='submitted', tx_hash=?, attempts=attempts+1 WHERE id=?")
        .run(hash, row.id);
      const status = await this.port.waitForReceipt(hash);
      if (status === "success" || (await this.port.isApplied(record))) {
        this.markConfirmed(row.id, hash, record);
        return true;
      }
      throw new PermanentRevert("reverted on chain");
    } catch (e) {
      if (e instanceof PermanentRevert) {
        this.db
          .prepare("UPDATE chain_outbox SET state='dead', last_error=? WHERE id=?")
          .run(e.message, row.id);
        this.opts.onEvent?.({ type: "dead", id: row.id, error: e.message, record });
        return true;
      }
      const attempts = row.attempts + 1;
      const delay = Math.min(this.max, this.base * 2 ** Math.min(attempts - 1, 20));
      const msg = e instanceof Error ? e.message.slice(0, 500) : String(e);
      this.db
        .prepare("UPDATE chain_outbox SET attempts=?, last_error=?, next_attempt_at=? WHERE id=?")
        .run(attempts, msg, this.now() + delay, row.id);
      this.opts.onEvent?.({ type: "retry", id: row.id, error: msg, attempts });
      return false;
    }
  }

  private markConfirmed(id: number, txHash: string | null, record: ChainRecord) {
    this.db
      .prepare("UPDATE chain_outbox SET state='confirmed', confirmed_at=?, last_error=NULL WHERE id=?")
      .run(this.now(), id);
    this.opts.onEvent?.({ type: "confirmed", id, txHash, record });
  }
}
