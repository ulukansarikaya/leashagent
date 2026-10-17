import { concat, hexToBytes, keccak256, stringToBytes } from "viem";
import { canonicalJson, type AuditEvent, type Hex } from "@leashagent/shared";
import { tx, type Db } from "./db";

export const GENESIS_HASH = ("0x" + "00".repeat(32)) as Hex;

export interface AuditSink {
  append(e: Omit<AuditEvent, "seq" | "prevHash" | "hash">): Promise<void>;
}

/** hash = keccak256(prevHash ‖ canonicalJson(event without hash)) (§5.12). */
function hashEvent(e: Omit<AuditEvent, "hash">): Hex {
  return keccak256(concat([hexToBytes(e.prevHash), stringToBytes(canonicalJson(e))]));
}

type Row = {
  seq: number; ts: number; policy_id: string; request_id: string | null;
  type: string; payload_json: string; prev_hash: string; hash: string;
};

function rowToEvent(r: Row): AuditEvent {
  const e: AuditEvent = {
    seq: r.seq,
    ts: r.ts,
    policyId: r.policy_id as Hex,
    type: r.type as AuditEvent["type"],
    payload: JSON.parse(r.payload_json),
    prevHash: r.prev_hash as Hex,
    hash: r.hash as Hex,
  };
  if (r.request_id !== null) e.requestId = r.request_id;
  return e;
}

/** Append-only, hash-chained audit log (L7 AuditLog, §6.7). */
export class AuditLog implements AuditSink {
  constructor(private readonly db: Db) {}

  async append(e: Omit<AuditEvent, "seq" | "prevHash" | "hash">): Promise<void> {
    this.appendSync(e);
  }

  appendSync(e: Omit<AuditEvent, "seq" | "prevHash" | "hash">): AuditEvent {
    const write = () => {
      const last = this.db
        .prepare("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1")
        .get() as { seq: number; hash: string } | undefined;
      const unhashed: Omit<AuditEvent, "hash"> = {
        ...e,
        seq: (last?.seq ?? 0) + 1,
        prevHash: (last?.hash as Hex | undefined) ?? GENESIS_HASH,
      };
      const full: AuditEvent = { ...unhashed, hash: hashEvent(unhashed) };
      this.db
        .prepare(
          `INSERT INTO audit_log (seq, ts, policy_id, request_id, type, payload_json, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(full.seq, full.ts, full.policyId, full.requestId ?? null, full.type,
          canonicalJson(full.payload ?? null), full.prevHash, full.hash);
      return full;
    };
    // Join an enclosing transaction if one is open, otherwise open our own.
    return this.db.isTransaction ? write() : tx(this.db, write);
  }

  /** Events with seq > `afterSeq`, oldest first. */
  since(afterSeq: number, limit = 500): AuditEvent[] {
    return (this.db.prepare("SELECT * FROM audit_log WHERE seq > ? ORDER BY seq LIMIT ?").all(afterSeq, limit) as Row[]).map(rowToEvent);
  }

  all(): AuditEvent[] {
    return (this.db.prepare("SELECT * FROM audit_log ORDER BY seq").all() as Row[]).map(rowToEvent);
  }

  /** Returns the first seq whose link or hash is broken, or null if the chain is intact (INV-14). */
  verify(): number | null {
    let prev = GENESIS_HASH;
    let expectedSeq = 1;
    for (const ev of this.all()) {
      const { hash, ...rest } = ev;
      if (ev.seq !== expectedSeq || ev.prevHash !== prev || hashEvent(rest) !== hash) return ev.seq;
      prev = hash;
      expectedSeq++;
    }
    return null;
  }
}
