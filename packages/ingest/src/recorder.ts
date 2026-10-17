import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ReadRecord, UUID } from "@bekci/shared";

/** Writes ReadRecords to the L5 store. The gateway owns the real (SQLite) implementation. */
export interface ReadRecorder {
  record(r: ReadRecord): Promise<void>;
  get(readId: UUID): Promise<ReadRecord | undefined>;
}

export class InMemoryReadRecorder implements ReadRecorder {
  readonly records = new Map<UUID, ReadRecord>();
  async record(r: ReadRecord) { this.records.set(r.readId, r); }
  async get(readId: UUID) { return this.records.get(readId); }
}

/** Append-only JSONL file, for local runs without the gateway store. */
export class JsonlReadRecorder extends InMemoryReadRecorder {
  constructor(private path: string) { super(); mkdirSync(dirname(path), { recursive: true }); }
  override async record(r: ReadRecord) {
    await super.record(r);
    appendFileSync(this.path, JSON.stringify({ ...r, excerptLabel: "untrusted" }) + "\n");
  }
}
