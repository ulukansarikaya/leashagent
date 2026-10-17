import { canonicalJson, type ChainRecord } from "@bekci/shared";
import type { Db } from "./db";
import type { Clock, DecisionChainWriter } from "./ports";

/**
 * Durable chain queue (§6.7, INV-15). Writes to `chain_outbox` only; the actual Avalanche
 * transaction is sent by Person 3's ChainWriter worker, which reads this table.
 * The decision path never waits on the chain.
 */
export class ChainOutbox implements DecisionChainWriter {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  async enqueue(r: ChainRecord): Promise<void> {
    this.enqueueSync(r);
  }

  enqueueSync(r: ChainRecord): void {
    this.db
      .prepare("INSERT INTO chain_outbox (record_json, created_at) VALUES (?, ?)")
      .run(canonicalJson(r), this.clock());
  }

  pending(): ChainRecord[] {
    return (this.db.prepare("SELECT record_json FROM chain_outbox WHERE tx_hash IS NULL ORDER BY id").all() as {
      record_json: string;
    }[]).map((r) => JSON.parse(r.record_json) as ChainRecord);
  }
}
