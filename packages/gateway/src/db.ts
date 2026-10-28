import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/** Ordered migrations. Never edit an applied migration; append a new one. */
const MIGRATIONS: string[] = [
  // 001 — architecture §8
  `
  CREATE TABLE policies (
    policy_id TEXT PRIMARY KEY, version INTEGER NOT NULL, policy_hash TEXT NOT NULL,
    policy_json TEXT NOT NULL, agent_auth_address TEXT NOT NULL,
    delegation_valid_until INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
    paused_chain INTEGER NOT NULL DEFAULT 0, paused_local INTEGER NOT NULL DEFAULT 0,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE requests (
    request_id TEXT NOT NULL, policy_id TEXT NOT NULL,
    status TEXT NOT NULL, reason_code INTEGER, message TEXT,
    normalized_order_hash TEXT, normalized_order_json TEXT,
    received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (policy_id, request_id)
  );

  CREATE TABLE decisions (
    request_id TEXT NOT NULL, policy_id TEXT NOT NULL, policy_version INTEGER NOT NULL,
    kind TEXT NOT NULL, reason_code INTEGER NOT NULL, evidence_hash TEXT NOT NULL,
    rule_result_json TEXT NOT NULL, auditor_output_json TEXT, decided_at INTEGER NOT NULL,
    PRIMARY KEY (policy_id, request_id)
  );

  CREATE TABLE nonces (
    kind TEXT NOT NULL, nonce TEXT NOT NULL, used_at INTEGER NOT NULL,
    PRIMARY KEY (kind, nonce)
  );

  CREATE TABLE reservations (
    reservation_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, policy_id TEXT NOT NULL,
    notional_usdt TEXT NOT NULL, state TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );

  CREATE TABLE reads (
    read_id TEXT PRIMARY KEY, policy_id TEXT NOT NULL, fetched_at INTEGER NOT NULL,
    content_hash TEXT NOT NULL, excerpt TEXT NOT NULL, summary_json TEXT NOT NULL
  );

  CREATE TABLE rate_events (
    policy_id TEXT NOT NULL, request_id TEXT NOT NULL, ts INTEGER NOT NULL,
    PRIMARY KEY (policy_id, request_id)
  );
  CREATE INDEX rate_events_ts ON rate_events (policy_id, ts);

  CREATE TABLE audit_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, policy_id TEXT NOT NULL,
    request_id TEXT, type TEXT NOT NULL, payload_json TEXT NOT NULL,
    prev_hash TEXT NOT NULL, hash TEXT NOT NULL
  );
  CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

  CREATE TABLE chain_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT, record_json TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, tx_hash TEXT, created_at INTEGER NOT NULL
  );
  `,
  // 002 — L5 reservation details, active-reservation uniqueness, persisted daily PnL
  `
  ALTER TABLE reservations ADD COLUMN inst_id TEXT;
  ALTER TABLE reservations ADD COLUMN sell_ccy TEXT;
  ALTER TABLE reservations ADD COLUMN sell_qty TEXT;
  CREATE UNIQUE INDEX reservations_active ON reservations (policy_id, request_id)
    WHERE state IN ('reserved', 'submitted');
  CREATE INDEX reservations_policy_state ON reservations (policy_id, state);

  CREATE TABLE daily_pnl (
    policy_id TEXT NOT NULL, utc_day TEXT NOT NULL, pnl_usdt TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (policy_id, utc_day)
  );
  `,
  // 003 — at most one ExecutionAuthorization per (policyId, requestId) (§25.3); approval/decision bookkeeping
  `
  CREATE TABLE authorizations (
    policy_id TEXT NOT NULL, request_id TEXT NOT NULL, auth_json TEXT NOT NULL, auth_hash TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    PRIMARY KEY (policy_id, request_id)
  );
  ALTER TABLE decisions ADD COLUMN pending_until INTEGER;
  ALTER TABLE requests ADD COLUMN request_json TEXT;
  `,
  // 004 — idempotent intake of executor events (in-process sink and HTTP callback may both deliver)
  `
  CREATE TABLE execution_events_seen (
    request_id TEXT NOT NULL, event_seq INTEGER NOT NULL, status TEXT NOT NULL, received_at INTEGER NOT NULL,
    PRIMARY KEY (request_id, event_seq)
  );
  `,
  // 005 — §21.2 reconciliation of finalized credits whose authorization was never executed
  `
  CREATE TABLE credit_refunds (
    policy_id TEXT NOT NULL, request_id TEXT NOT NULL, state TEXT NOT NULL, -- pending|done|not_required
    reason TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (policy_id, request_id)
  );
  `,
  // 006 — the chain_outbox columns of @leashagent/chain (CHAIN_OUTBOX_DDL), so its worker can run
  // on this table. Their DDL is CREATE IF NOT EXISTS and would not add columns to an existing table.
  `
  ALTER TABLE chain_outbox ADD COLUMN state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','submitted','confirmed','dead'));
  ALTER TABLE chain_outbox ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE chain_outbox ADD COLUMN confirmed_at INTEGER;
  CREATE INDEX IF NOT EXISTS chain_outbox_open ON chain_outbox(state, id);
  `,
  // 007 — account equity at UTC day start, so daily PnL from the OKX read key survives restarts (§6.5)
  `
  CREATE TABLE equity_baseline (
    policy_id TEXT NOT NULL, utc_day TEXT NOT NULL, equity_usdt TEXT NOT NULL, recorded_at INTEGER NOT NULL,
    PRIMARY KEY (policy_id, utc_day)
  );
  `,
];

/**
 * Opens the gateway store. `orders` and `executor_nonces` belong to the executor (L6)
 * and live in its own database; they are not created here (§8, §25.4).
 */
export function openGatewayDb(path = ":memory:"): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
  const current = row.v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    tx(db, () => {
      db.exec(MIGRATIONS[i]!);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(i + 1);
    });
  }
}

/** Run `fn` inside a single IMMEDIATE transaction; rolls back on throw. */
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
