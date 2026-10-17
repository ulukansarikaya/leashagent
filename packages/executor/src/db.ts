import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/**
 * Executor-owned store (§8, §25.4). Lives in the executor process only; never shared with the
 * gateway's request-nonce table.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE executor_nonces (
    nonce TEXT PRIMARY KEY, policy_id TEXT NOT NULL, request_id TEXT NOT NULL, used_at INTEGER NOT NULL,
    UNIQUE (policy_id, request_id)
  );

  CREATE TABLE orders (
    request_id TEXT PRIMARY KEY, policy_id TEXT NOT NULL, cl_ord_id TEXT NOT NULL UNIQUE,
    ord_id TEXT, status TEXT NOT NULL, event_seq INTEGER NOT NULL DEFAULT 0,
    dispatching_at INTEGER, submitted_at INTEGER, last_okx_hash TEXT, updated_at INTEGER NOT NULL,
    tool TEXT NOT NULL, inst_id TEXT NOT NULL
  );

  CREATE TABLE execution_events (
    request_id TEXT NOT NULL, event_seq INTEGER NOT NULL, status TEXT NOT NULL, ord_id TEXT, okx_code TEXT,
    okx_result_hash TEXT NOT NULL, occurred_at INTEGER NOT NULL,
    PRIMARY KEY (request_id, event_seq)
  );
  `,
];

export function openExecutorDb(path = ":memory:"): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
  for (let i = row.v ?? 0; i < MIGRATIONS.length; i++) {
    tx(db, () => {
      db.exec(MIGRATIONS[i]!);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(i + 1);
    });
  }
  return db;
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
