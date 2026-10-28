import type { DatabaseSync } from "node:sqlite";
import { getAddress } from "viem";
import type { CreditReserveResult, EpochSec, Hex, PaymentEntitlement, ServiceCredit, UUID } from "@leashagent/shared";

/** §21.5 tables, owned by this package; the gateway runs `migrateCredits` on its SQLite handle. */
export const CREDITS_DDL = `
CREATE TABLE IF NOT EXISTS service_credits (
  payment_ref TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  payer TEXT NOT NULL,
  purchased INTEGER NOT NULL CHECK (purchased > 0),
  remaining INTEGER NOT NULL CHECK (remaining >= 0 AND remaining <= purchased),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS service_credits_owner ON service_credits(policy_id, agent_id, payer, created_at);
CREATE TABLE IF NOT EXISTS credit_consumptions (
  policy_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payment_ref TEXT NOT NULL REFERENCES service_credits(payment_ref),
  state TEXT NOT NULL CHECK (state IN ('reserved','consumed','released')),
  reserved_at INTEGER NOT NULL,
  consumed_at INTEGER,
  released_at INTEGER,
  PRIMARY KEY (policy_id, request_id)
);
`;

export function migrateCredits(db: DatabaseSync): void {
  db.exec(CREDITS_DDL);
}

export const CREDITS_PER_PAYMENT = 5;

export type MintResult =
  | { ok: true; credit: ServiceCredit }
  | { ok: false; reason: "duplicate_payment" };

export class CreditError extends Error {}

type ConsumptionRow = { payment_ref: string; state: "reserved" | "consumed" | "released" };

const norm = (h: string) => h.toLowerCase();

/**
 * Durable credit ledger (§21.2). Lifecycle per (policyId, requestId): reserved → consumed | released.
 * `remaining` is decremented at reservation time so parallel requests cannot oversubscribe a payment.
 * All transitions run inside BEGIN IMMEDIATE and are idempotent.
 */
export class CreditStore implements PaymentEntitlement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly opts: { now?: () => EpochSec; challenge?: () => unknown } = {},
  ) {
    migrateCredits(db);
  }

  private now(): EpochSec {
    return this.opts.now?.() ?? Math.floor(Date.now() / 1000);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Create credits for a settled payment. A paymentRef can mint exactly once (INV-18). */
  mint(input: { paymentRef: string; policyId: Hex; agentId: string; payer: Hex; purchased?: number }): MintResult {
    const purchased = input.purchased ?? CREDITS_PER_PAYMENT;
    if (!Number.isSafeInteger(purchased) || purchased <= 0) throw new CreditError("purchased must be a positive integer");
    if (!input.paymentRef) throw new CreditError("paymentRef required");
    return this.tx(() => {
      const res = this.db
        .prepare(
          `INSERT INTO service_credits (payment_ref, policy_id, agent_id, payer, purchased, remaining, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(payment_ref) DO NOTHING`,
        )
        .run(input.paymentRef, norm(input.policyId), input.agentId, getAddress(input.payer), purchased, purchased, this.now());
      if (res.changes === 0) return { ok: false, reason: "duplicate_payment" } as const;
      return { ok: true, credit: this.getCredit(input.paymentRef)! } as const;
    });
  }

  getCredit(paymentRef: string): ServiceCredit | undefined {
    const r = this.db.prepare("SELECT * FROM service_credits WHERE payment_ref = ?").get(paymentRef) as
      | Record<string, string | number>
      | undefined;
    if (!r) return undefined;
    return {
      paymentRef: r.payment_ref as string,
      policyId: r.policy_id as Hex,
      agentId: r.agent_id as string,
      payer: r.payer as Hex,
      purchased: r.purchased as number,
      remaining: r.remaining as number,
      createdAt: r.created_at as number,
    };
  }

  /** Credits available to exactly this (policyId, agentId, payer) — INV-19. */
  available(policyId: Hex, agentId: string, payer: Hex): number {
    const r = this.db
      .prepare(
        "SELECT COALESCE(SUM(remaining), 0) AS n FROM service_credits WHERE policy_id = ? AND agent_id = ? AND payer = ?",
      )
      .get(norm(policyId), agentId, getAddress(payer)) as { n: number };
    return Number(r.n);
  }

  consumptionState(policyId: Hex, requestId: UUID): ConsumptionRow["state"] | undefined {
    return this.row(policyId, requestId)?.state;
  }

  private row(policyId: Hex, requestId: UUID): ConsumptionRow | undefined {
    return this.db
      .prepare("SELECT payment_ref, state FROM credit_consumptions WHERE policy_id = ? AND request_id = ?")
      .get(norm(policyId), requestId) as ConsumptionRow | undefined;
  }

  async reserveCredit(policyId: Hex, agentId: string, payer: Hex, requestId: UUID): Promise<CreditReserveResult> {
    const pid = norm(policyId);
    const payerAddr = getAddress(payer);
    return this.tx(() => {
      const existing = this.row(policyId, requestId);
      if (existing && existing.state !== "released") {
        // Idempotent: a repeated request never takes a second credit (§25.5).
        return { ok: true, creditReservationId: `${pid}:${requestId}` } as const;
      }
      const credit = this.db
        .prepare(
          `SELECT payment_ref FROM service_credits
           WHERE policy_id = ? AND agent_id = ? AND payer = ? AND remaining > 0
           ORDER BY created_at, payment_ref LIMIT 1`,
        )
        .get(pid, agentId, payerAddr) as { payment_ref: string } | undefined;
      if (!credit) {
        return { ok: false, paymentRequired: true, paymentChallenge: this.opts.challenge?.() } as const;
      }
      this.db.prepare("UPDATE service_credits SET remaining = remaining - 1 WHERE payment_ref = ?").run(credit.payment_ref);
      this.db
        .prepare(
          `INSERT INTO credit_consumptions (policy_id, request_id, payment_ref, state, reserved_at)
           VALUES (?, ?, ?, 'reserved', ?)
           ON CONFLICT(policy_id, request_id) DO UPDATE SET
             payment_ref = excluded.payment_ref, state = 'reserved', reserved_at = excluded.reserved_at,
             consumed_at = NULL, released_at = NULL`,
        )
        .run(pid, requestId, credit.payment_ref, this.now());
      return { ok: true, creditReservationId: `${pid}:${requestId}` } as const;
    });
  }

  /** Finalize exactly once. Idempotent on consumed; throws if nothing is reserved. */
  async consumeReservedCredit(policyId: Hex, requestId: UUID): Promise<void> {
    this.tx(() => {
      const r = this.row(policyId, requestId);
      if (r?.state === "consumed") return;
      if (r?.state !== "reserved") throw new CreditError(`no reserved credit for ${requestId}`);
      this.db
        .prepare("UPDATE credit_consumptions SET state = 'consumed', consumed_at = ? WHERE policy_id = ? AND request_id = ?")
        .run(this.now(), norm(policyId), requestId);
    });
  }

  /** BLOCK / PENDING / failed risk reservation: return the credit. No-op if absent, released or consumed. */
  async releaseReservedCredit(policyId: Hex, requestId: UUID, _reason: string): Promise<void> {
    this.tx(() => {
      const r = this.row(policyId, requestId);
      if (r?.state !== "reserved") return;
      this.restore(policyId, requestId, r.payment_ref);
    });
  }

  /**
   * Reconciliation only (§21.2 rule 6): credit was finalized but no execution attempt was durably recorded.
   * The caller must have verified that no OKX write happened for this request.
   */
  refundConsumedCredit(policyId: Hex, requestId: UUID): void {
    this.tx(() => {
      const r = this.row(policyId, requestId);
      if (r?.state !== "consumed") return;
      this.restore(policyId, requestId, r.payment_ref);
    });
  }

  private restore(policyId: Hex, requestId: UUID, paymentRef: string) {
    this.db.prepare("UPDATE service_credits SET remaining = remaining + 1 WHERE payment_ref = ?").run(paymentRef);
    this.db
      .prepare("UPDATE credit_consumptions SET state = 'released', released_at = ? WHERE policy_id = ? AND request_id = ?")
      .run(this.now(), norm(policyId), requestId);
  }
}
