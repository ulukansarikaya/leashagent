import {
  canonicalJson,
  type AuditorOutput,
  type Decision,
  type EpochSec,
  type ExecutionAuthorization,
  type Hex,
  type IntentResponse,
  type OrderStatus,
  type Policy,
  type ReadRecord,
  type ReasonCode,
  type RuleResult,
  type UUID,
} from "@bekci/shared";
import type { Db } from "./db";

export type NonceKind = "agent_request" | "approval" | "pause";

export type CachedPolicy = {
  policy: Policy;
  policyHash: Hex;
  version: number;
  agentAuthAddress: Hex;
  delegationValidUntil: EpochSec;
  revoked: boolean;
  pausedChain: boolean;
  pausedLocal: boolean;
  fetchedAt: EpochSec;
};

export type RequestRow = {
  requestId: UUID;
  policyId: Hex;
  status: OrderStatus;
  reasonCode?: ReasonCode;
  message?: string;
  normalizedOrderHash?: Hex;
  normalizedOrderJson?: string;
  requestJson?: string;
  receivedAt: EpochSec;
  updatedAt: EpochSec;
};

export type RequestPatch = {
  status: OrderStatus;
  reasonCode?: ReasonCode;
  message?: string;
  normalizedOrderHash?: Hex;
  normalizedOrderJson?: string;
  requestJson?: string;
};

/** Thin synchronous accessors over the gateway tables (§8). */
export class GatewayStore {
  constructor(readonly db: Db) {}

  // ---------- policy cache ----------
  upsertPolicy(p: CachedPolicy): void {
    this.db
      .prepare(
        `INSERT INTO policies (policy_id, version, policy_hash, policy_json, agent_auth_address,
           delegation_valid_until, revoked, paused_chain, paused_local, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(policy_id) DO UPDATE SET version=excluded.version, policy_hash=excluded.policy_hash,
           policy_json=excluded.policy_json, agent_auth_address=excluded.agent_auth_address,
           delegation_valid_until=excluded.delegation_valid_until, revoked=excluded.revoked,
           paused_chain=excluded.paused_chain, paused_local=excluded.paused_local, fetched_at=excluded.fetched_at`,
      )
      .run(p.policy.binding.policyId, p.version, p.policyHash, JSON.stringify(p.policy), p.agentAuthAddress,
        p.delegationValidUntil, p.revoked ? 1 : 0, p.pausedChain ? 1 : 0, p.pausedLocal ? 1 : 0, p.fetchedAt);
  }

  getPolicy(policyId: Hex): CachedPolicy | null {
    const r = this.db.prepare("SELECT * FROM policies WHERE policy_id = ?").get(policyId) as
      | Record<string, string | number>
      | undefined;
    if (!r) return null;
    return {
      policy: JSON.parse(r.policy_json as string) as Policy,
      policyHash: r.policy_hash as Hex,
      version: r.version as number,
      agentAuthAddress: r.agent_auth_address as Hex,
      delegationValidUntil: r.delegation_valid_until as number,
      revoked: r.revoked === 1,
      pausedChain: r.paused_chain === 1,
      pausedLocal: r.paused_local === 1,
      fetchedAt: r.fetched_at as number,
    };
  }

  setLocalPause(policyId: Hex, paused: boolean): void {
    this.db.prepare("UPDATE policies SET paused_local = ? WHERE policy_id = ?").run(paused ? 1 : 0, policyId);
  }

  // ---------- nonces ----------
  /** Atomically marks a nonce used. Returns false if it was already used. */
  consumeNonce(kind: NonceKind, nonce: Hex, now: EpochSec): boolean {
    const res = this.db
      .prepare("INSERT OR IGNORE INTO nonces (kind, nonce, used_at) VALUES (?, ?, ?)")
      .run(kind, nonce.toLowerCase(), now);
    return Number(res.changes) === 1;
  }

  // ---------- requests ----------
  getRequest(policyId: Hex, requestId: UUID): RequestRow | null {
    const r = this.db
      .prepare("SELECT * FROM requests WHERE policy_id = ? AND request_id = ?")
      .get(policyId, requestId) as Record<string, string | number | null> | undefined;
    if (!r) return null;
    const row: RequestRow = {
      requestId: r.request_id as string,
      policyId: r.policy_id as Hex,
      status: r.status as OrderStatus,
      receivedAt: r.received_at as number,
      updatedAt: r.updated_at as number,
    };
    if (r.reason_code !== null) row.reasonCode = r.reason_code as number;
    if (r.message !== null) row.message = r.message as string;
    if (r.normalized_order_hash !== null) row.normalizedOrderHash = r.normalized_order_hash as Hex;
    if (r.normalized_order_json !== null) row.normalizedOrderJson = r.normalized_order_json as string;
    if (r.request_json !== null && r.request_json !== undefined) row.requestJson = r.request_json as string;
    return row;
  }

  /** requestIds are UUIDs; §9 `GET /v1/intents/:requestId` carries no policyId. */
  findRequest(requestId: UUID): RequestRow | null {
    const r = this.db.prepare("SELECT policy_id FROM requests WHERE request_id = ? LIMIT 1").get(requestId) as
      | { policy_id: Hex }
      | undefined;
    return r ? this.getRequest(r.policy_id, requestId) : null;
  }

  insertRequest(policyId: Hex, requestId: UUID, status: OrderStatus, now: EpochSec): void {
    this.db
      .prepare(
        `INSERT INTO requests (request_id, policy_id, status, received_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(requestId, policyId, status, now, now);
  }

  updateRequest(policyId: Hex, requestId: UUID, patch: RequestPatch, now: EpochSec): void {
    this.db
      .prepare(
        `UPDATE requests SET status = ?, reason_code = COALESCE(?, reason_code), message = COALESCE(?, message),
           normalized_order_hash = COALESCE(?, normalized_order_hash),
           normalized_order_json = COALESCE(?, normalized_order_json),
           request_json = COALESCE(?, request_json), updated_at = ?
         WHERE policy_id = ? AND request_id = ?`,
      )
      .run(patch.status, patch.reasonCode ?? null, patch.message ?? null, patch.normalizedOrderHash ?? null,
        patch.normalizedOrderJson ?? null, patch.requestJson ?? null, now, policyId, requestId);
  }

  // ---------- rate events (L5-owned table; §6.4, §25.4) ----------
  recordRateEvent(policyId: Hex, requestId: UUID, ts: EpochSec): void {
    this.db
      .prepare("INSERT OR IGNORE INTO rate_events (policy_id, request_id, ts) VALUES (?, ?, ?)")
      .run(policyId, requestId, ts);
  }

  countRateEvents(policyId: Hex, sinceTs: EpochSec): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM rate_events WHERE policy_id = ? AND ts > ?")
      .get(policyId, sinceTs) as { n: number };
    return r.n;
  }

  // ---------- decisions ----------
  saveDecision(d: Decision, pendingUntil: EpochSec | null): void {
    this.db
      .prepare(
        `INSERT INTO decisions (request_id, policy_id, policy_version, kind, reason_code, evidence_hash,
           rule_result_json, auditor_output_json, decided_at, pending_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(policy_id, request_id) DO UPDATE SET policy_version=excluded.policy_version, kind=excluded.kind,
           reason_code=excluded.reason_code, evidence_hash=excluded.evidence_hash,
           rule_result_json=excluded.rule_result_json, auditor_output_json=excluded.auditor_output_json,
           decided_at=excluded.decided_at, pending_until=excluded.pending_until`,
      )
      .run(d.requestId, d.policyId, d.policyVersion, d.kind, d.reasonCode, d.evidenceHash,
        JSON.stringify(d.ruleResult), d.auditorOutput ? JSON.stringify(d.auditorOutput) : null, d.decidedAt, pendingUntil);
  }

  getDecision(policyId: Hex, requestId: UUID): (Decision & { pendingUntil: EpochSec | null }) | null {
    const r = this.db
      .prepare("SELECT * FROM decisions WHERE policy_id = ? AND request_id = ?")
      .get(policyId, requestId) as Record<string, string | number | null> | undefined;
    if (!r) return null;
    const d: Decision & { pendingUntil: EpochSec | null } = {
      requestId: r.request_id as string,
      policyId: r.policy_id as Hex,
      policyVersion: r.policy_version as number,
      kind: r.kind as Decision["kind"],
      reasonCode: r.reason_code as number,
      ruleResult: JSON.parse(r.rule_result_json as string) as RuleResult,
      decidedAt: r.decided_at as number,
      evidenceHash: r.evidence_hash as Hex,
      pendingUntil: (r.pending_until as number | null) ?? null,
    };
    if (r.auditor_output_json) d.auditorOutput = JSON.parse(r.auditor_output_json as string) as AuditorOutput;
    return d;
  }

  listExpiredPending(now: EpochSec): { policyId: Hex; requestId: UUID }[] {
    const rows = this.db
      .prepare(
        `SELECT d.policy_id, d.request_id FROM decisions d JOIN requests r
           ON r.policy_id = d.policy_id AND r.request_id = d.request_id
         WHERE r.status = 'PENDING' AND d.pending_until IS NOT NULL AND d.pending_until < ?`,
      )
      .all(now) as { policy_id: Hex; request_id: string }[];
    return rows.map((r) => ({ policyId: r.policy_id, requestId: r.request_id }));
  }

  // ---------- authorizations (one per request, §25.3) ----------
  /** Returns false if an authorization already exists for this request. */
  saveAuthorization(a: ExecutionAuthorization, authHash: Hex): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO authorizations (policy_id, request_id, auth_json, auth_hash, issued_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(a.policyId, a.requestId, canonicalJson(a), authHash, a.issuedAt);
    return Number(res.changes) === 1;
  }

  getAuthorization(policyId: Hex, requestId: UUID): ExecutionAuthorization | null {
    const r = this.db
      .prepare("SELECT auth_json FROM authorizations WHERE policy_id = ? AND request_id = ?")
      .get(policyId, requestId) as { auth_json: string } | undefined;
    return r ? (JSON.parse(r.auth_json) as ExecutionAuthorization) : null;
  }

  // ---------- reads (written by L1; read for the auditor) ----------
  saveRead(r: ReadRecord): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO reads (read_id, policy_id, fetched_at, content_hash, excerpt, summary_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(r.readId, r.policyId, r.fetchedAt, r.contentHash, r.excerpt, JSON.stringify(r.summary));
  }

  /** Only reads recorded for this policy are returned; foreign readIds are silently ignored. */
  getReads(policyId: Hex, readIds: UUID[]): ReadRecord[] {
    if (readIds.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT * FROM reads WHERE policy_id = ? AND read_id IN (${readIds.map(() => "?").join(",")})`)
      .all(policyId, ...readIds) as Record<string, string | number>[];
    return rows.map((r) => ({
      readId: r.read_id as string,
      policyId: r.policy_id as Hex,
      fetchedAt: r.fetched_at as number,
      contentHash: r.content_hash as Hex,
      excerpt: r.excerpt as string,
      summary: JSON.parse(r.summary_json as string),
    }));
  }
}

export function toIntentResponse(r: RequestRow): IntentResponse {
  const out: IntentResponse = { requestId: r.requestId, status: r.status };
  if (r.reasonCode !== undefined) out.reasonCode = r.reasonCode;
  if (r.message !== undefined) out.message = r.message;
  return out;
}
