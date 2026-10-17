import { REASON, type ExecStatus, type ExecutionEvent, type Hex, type OrderStatus, type ReasonCode, type UUID } from "@bekci/shared";
import type { AuditLog } from "./audit";
import { tx } from "./db";
import type { ChainOutbox } from "./outbox";
import type { DecisionOutcome } from "./policy-engine";
import type { Clock, ExecutorPort } from "./ports";
import type { DefaultRiskStore } from "./risk-store";
import type { GatewayStore } from "./store";

const STATUS: Record<ExecStatus, OrderStatus> = {
  submitted: "SUBMITTED",
  acknowledged: "ACKNOWLEDGED",
  filled: "FILLED",
  partially_filled: "PARTIALLY_FILLED",
  cancelled: "CANCELLED",
  rejected_by_okx: "REJECTED_BY_OKX",
  expired: "EXPIRED",
  revoked: "REVOKED",
  unknown: "UNKNOWN",
};

export type ExecutionHandlerDeps = {
  store: GatewayStore;
  audit: AuditLog;
  outbox: ChainOutbox;
  risk: DefaultRiskStore;
  clock: Clock;
};

/**
 * L5/L7 intake of L6 ExecutionEvents (§4.2 step 10–11). Idempotent on (requestId, eventSeq).
 *
 * Reservation lifecycle (§6.5): submitted -> markSubmitted; once the exchange itself reflects the
 * order (acknowledged / partially_filled / filled / cancelled) -> settle, so position and
 * reservation are not counted twice; rejected_by_okx -> release; unknown -> hold.
 */
export class ExecutionEventHandler {
  constructor(private readonly d: ExecutionHandlerDeps) {}

  onEvent(e: ExecutionEvent, ctx: { policyId: Hex }): void {
    const now = this.d.clock();
    tx(this.d.store.db, () => {
      const fresh = this.d.store.db
        .prepare("INSERT OR IGNORE INTO execution_events_seen (request_id, event_seq, status, received_at) VALUES (?, ?, ?, ?)")
        .run(e.requestId, e.eventSeq, e.status, now);
      if (Number(fresh.changes) === 0) return;

      const { policyId } = ctx;
      const lastSeq = this.d.store.db
        .prepare("SELECT MAX(event_seq) AS s FROM execution_events_seen WHERE request_id = ?")
        .get(e.requestId) as { s: number };
      // Only the newest event drives the request status; late duplicates are audit-only.
      if (lastSeq.s === e.eventSeq) {
        this.d.store.updateRequest(policyId, e.requestId, { status: STATUS[e.status] }, now);
      }
      switch (e.status) {
        case "submitted":
          this.d.risk.markSubmitted(e.requestId, policyId);
          break;
        case "acknowledged":
        case "partially_filled":
        case "filled":
        case "cancelled":
          this.d.risk.settle(e.requestId, policyId);
          break;
        case "rejected_by_okx":
        case "expired":
        case "revoked":
          this.d.risk.releaseNow(e.requestId, policyId);
          break;
        case "unknown":
          break; // reservation held until reconciliation resolves it
      }
      const payload: Record<string, unknown> = { eventSeq: e.eventSeq, status: e.status, okxResultHash: e.okxResultHash };
      if (e.okxCode) payload.okxCode = e.okxCode;
      this.d.audit.appendSync({ ts: now, policyId, requestId: e.requestId, type: "execution", payload });
      this.d.outbox.enqueueSync({
        kind: "execution", requestId: e.requestId, eventSeq: e.eventSeq, status: e.status, okxResultHash: e.okxResultHash,
      });
    });
  }

  /** The executor refused the authorization before any exchange call. */
  onRejected(policyId: Hex, requestId: UUID, outcome: string, reasonCode: ReasonCode, message: string): void {
    if (outcome === "duplicate") return; // the original execution owns the state
    const now = this.d.clock();
    const status: OrderStatus = outcome === "expired" ? "EXPIRED" : "REVOKED";
    tx(this.d.store.db, () => {
      this.d.store.updateRequest(policyId, requestId, { status, reasonCode, message }, now);
      this.d.risk.releaseNow(requestId, policyId);
      this.d.audit.appendSync({
        ts: now, policyId, requestId, type: "execution",
        payload: { rejectedByExecutor: true, outcome, reasonCode, message },
      });
    });
  }
}

type RejectedLike = { name: string; reasonCode: ReasonCode; outcome: string; message: string };
const isRejected = (e: unknown): e is RejectedLike =>
  typeof e === "object" && e !== null && (e as { name?: string }).name === "ExecutionRejected";

/** Hands an ALLOWED outcome to L6 and feeds the result back. Never retries a write. */
export class ExecutionDispatcher {
  constructor(
    private readonly executor: ExecutorPort,
    private readonly handler: ExecutionEventHandler,
    private readonly store?: GatewayStore,
  ) {}

  async dispatch(outcome: DecisionOutcome, order: Parameters<ExecutorPort["execute"]>[1]): Promise<ExecutionEvent[]> {
    if (outcome.status !== "ALLOWED" || !outcome.authorization) return [];
    const auth = outcome.authorization;
    // The executor rechecks the chain; a local (dashboard) pause is only known here, so it is
    // enforced on the gateway side before handing over an already-issued authorization.
    const cached = this.store?.getPolicy(auth.policyId);
    if (cached?.pausedLocal && order.tool !== "spot_cancel_order") {
      this.handler.onRejected(auth.policyId, auth.requestId, "revoked", REASON.PAUSED, "paused locally before dispatch");
      return [];
    }
    try {
      const events = await this.executor.execute(auth, order);
      for (const e of events) this.handler.onEvent(e, { policyId: auth.policyId });
      return events;
    } catch (e) {
      if (isRejected(e)) {
        this.handler.onRejected(auth.policyId, auth.requestId, e.outcome, e.reasonCode, e.message);
        return [];
      }
      // Transport failure to the executor: the write may or may not have happened. Do not retry;
      // the request stays ALLOWED with its reservation held until reconciliation.
      throw e;
    }
  }
}
