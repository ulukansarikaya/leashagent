import type { ExecutionAuthorization, Hex, UUID } from "@bekci/shared";
import type { AuditLog } from "./audit";
import { tx } from "./db";
import type { Clock, ExecutionLookup, PaymentEntitlement } from "./ports";
import type { DefaultRiskStore } from "./risk-store";
import type { GatewayStore } from "./store";

export type CreditReconcilerDeps = {
  store: GatewayStore;
  audit: AuditLog;
  risk: DefaultRiskStore;
  payment: PaymentEntitlement;
  lookup: ExecutionLookup;
  clock: Clock;
  /** Extra wait after authorization expiry before concluding it was never used. */
  graceSec: number;
};

type Candidate = { policy_id: Hex; request_id: UUID; auth_json: string; status: string };

/**
 * §4.4 step 11 / §21.2 rule 6: an authorization was issued (credit finalized, risk reserved) but
 * execution was never durably attempted — e.g. a crash before dispatch, or the executor refused it.
 * Once the authorization has expired, the executor can no longer accept it, so if its durable
 * attempt record is absent the reservation is released and the credit refunded, exactly once.
 * If the executor cannot be asked, nothing is concluded.
 */
export class CreditReconciler {
  constructor(private readonly d: CreditReconcilerDeps) {}

  async run(): Promise<{ released: UUID[]; refunded: UUID[] }> {
    const now = this.d.clock();
    const released: UUID[] = [];
    const refunded: UUID[] = [];

    const rows = this.d.store.db
      .prepare(
        `SELECT a.policy_id, a.request_id, a.auth_json, r.status FROM authorizations a
           JOIN requests r ON r.policy_id = a.policy_id AND r.request_id = a.request_id
         WHERE r.status IN ('ALLOWED', 'REVOKED', 'EXPIRED')
           AND NOT EXISTS (SELECT 1 FROM credit_refunds c WHERE c.policy_id = a.policy_id AND c.request_id = a.request_id)`,
      )
      .all() as Candidate[];

    for (const row of rows) {
      const auth = JSON.parse(row.auth_json) as ExecutionAuthorization;
      if (now <= auth.expiresAt + this.d.graceSec) continue;
      let attempted: boolean;
      try {
        attempted = await this.d.lookup.hasExecutionAttempt(row.policy_id, row.request_id);
      } catch {
        continue; // cannot prove absence; try again later
      }
      if (attempted) continue; // executor owns the outcome; its reconciliation reports it

      const decision = this.d.store.getDecision(row.policy_id, row.request_id);
      const creditUsed = !!decision?.ruleResult.derived.riskIncreasing;
      tx(this.d.store.db, () => {
        this.d.store.db
          .prepare(
            `INSERT INTO credit_refunds (policy_id, request_id, state, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(row.policy_id, row.request_id, creditUsed ? "pending" : "not_required", "authorization never executed", now, now);
        this.d.risk.releaseNow(row.request_id, row.policy_id);
        if (row.status === "ALLOWED") {
          this.d.store.updateRequest(row.policy_id, row.request_id, { status: "EXPIRED", message: "authorization expired unused" }, now);
        }
        this.d.audit.appendSync({
          ts: now, policyId: row.policy_id, requestId: row.request_id, type: "reconciliation",
          payload: { action: "release_unused_authorization", creditRefund: creditUsed },
        });
      });
      released.push(row.request_id);
    }

    // Refunds are retried until they succeed.
    const pending = this.d.store.db
      .prepare("SELECT policy_id, request_id FROM credit_refunds WHERE state = 'pending'")
      .all() as { policy_id: Hex; request_id: UUID }[];
    for (const p of pending) {
      if (!this.d.payment.refundConsumedCredit) break;
      try {
        await this.d.payment.refundConsumedCredit(p.policy_id, p.request_id, "authorization never executed");
      } catch {
        continue;
      }
      this.d.store.db
        .prepare("UPDATE credit_refunds SET state = 'done', updated_at = ? WHERE policy_id = ? AND request_id = ?")
        .run(this.d.clock(), p.policy_id, p.request_id);
      refunded.push(p.request_id);
    }
    return { released, refunded };
  }
}
