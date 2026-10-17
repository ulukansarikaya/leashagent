import { keccak256, stringToBytes } from "viem";
import {
  ReasonCodes,
  deriveClOrdId,
  executionAuthorizationSchema,
  hashCanonical,
  isExecTransitionAllowed,
  normalizedOrderSchema,
  recoverAuthorizationSigner,
  type ExecStatus,
  type ExecutionAuthorization,
  type ExecutionEvent,
  type Hex,
  type NormalizedOrder,
  type ReasonCode,
} from "@bekci/shared";
import { tx, type Db } from "./db";
import type { AtkClient, AtkOrderState, Clock, ExecutionSink, ExecutorConfig, PolicyStateProvider } from "./ports";

export interface Executor {
  execute(auth: ExecutionAuthorization, order: NormalizedOrder): Promise<ExecutionEvent[]>;
}

/** Thrown when an authorization is refused before any exchange call. */
export class ExecutionRejected extends Error {
  constructor(
    readonly reasonCode: ReasonCode,
    /** Order-status hint for the caller: expired / revoked authorizations vs invalid ones. */
    readonly outcome: "invalid" | "expired" | "revoked" | "duplicate",
    message: string,
  ) {
    super(message);
    this.name = "ExecutionRejected";
  }
}

/** `orders.status` holds ExecStatus values plus the write-ahead marker. */
type OrderRowStatus = ExecStatus | "dispatching";

type OrderRow = {
  request_id: string; policy_id: Hex; cl_ord_id: string; ord_id: string | null; status: OrderRowStatus;
  event_seq: number; tool: string; inst_id: string;
};

export type ExecutorDeps = {
  db: Db;
  atk: AtkClient;
  policyState: PolicyStateProvider;
  config: ExecutorConfig;
  clock: Clock;
  sink?: ExecutionSink;
};

const ATK_STATE: Record<AtkOrderState, ExecStatus> = {
  live: "acknowledged",
  partially_filled: "partially_filled",
  filled: "filled",
  canceled: "cancelled",
};

/** Statuses that may still change at the exchange and are worth reconciling. */
const OPEN_STATUSES: OrderRowStatus[] = ["dispatching", "unknown", "submitted", "acknowledged", "partially_filled"];

/** okxResultHash = keccak256(canonicalJson(okxResponse)); falls back to plain JSON if the payload has floats. */
function hashResponse(raw: unknown): Hex {
  try {
    return hashCanonical(raw ?? null);
  } catch {
    return keccak256(stringToBytes(JSON.stringify(raw ?? null)));
  }
}

/**
 * L6 Execution Layer (§6.6). Writes to OKX only with a valid, order-bound, unused, fresh
 * authorization, only the order in it, and only once per (policyId, requestId) (INV-7, INV-8).
 * It does not reinterpret policy rules. On an uncertain outcome it never resends (INV-9).
 */
export class DefaultExecutor implements Executor {
  constructor(private readonly d: ExecutorDeps) {}

  async execute(authIn: ExecutionAuthorization, orderIn: NormalizedOrder): Promise<ExecutionEvent[]> {
    const cfg = this.d.config;
    const invalid = (code: ReasonCode, msg: string) => new ExecutionRejected(code, "invalid", msg);

    // Strict shapes: an extra field or an unknown value is a rejection.
    const ap = executionAuthorizationSchema.safeParse(authIn);
    if (!ap.success) throw invalid(ReasonCodes.AUTH_INVALID, "authorization malformed");
    const auth = ap.data as ExecutionAuthorization;
    const op = normalizedOrderSchema.safeParse(orderIn);
    if (!op.success) throw invalid(ReasonCodes.AUTH_HASH_MISMATCH, "order malformed");
    const order = op.data as NormalizedOrder;

    // 1. Signature recovers exactly to GUARD_SIGNER_ADDRESS under the exact EIP-712 domain.
    const signer = await recoverAuthorizationSigner(auth).catch(() => null);
    if (!signer || signer.toLowerCase() !== cfg.guardSignerAddress.toLowerCase()) {
      throw invalid(ReasonCodes.AUTH_INVALID, "authorization signer not accepted");
    }

    // 4. Bound to this executor's account, instance and tool set.
    if (auth.accountRef !== cfg.accountRef) throw invalid(ReasonCodes.AUTH_INVALID, "accountRef mismatch");
    if (auth.guardInstanceId !== cfg.guardInstanceId) throw invalid(ReasonCodes.AUTH_INVALID, "guardInstanceId mismatch");
    if (auth.tool !== order.tool || !cfg.allowedTools.includes(auth.tool)) throw invalid(ReasonCodes.AUTH_INVALID, "tool mismatch");

    // 2. Freshness (nonce is consumed atomically in step 6).
    const now = this.d.clock();
    if (auth.issuedAt > now + cfg.clockSkewSec || auth.expiresAt < auth.issuedAt) {
      throw invalid(ReasonCodes.AUTH_INVALID, "authorization time window invalid");
    }
    if (now > auth.expiresAt) throw new ExecutionRejected(ReasonCodes.AUTH_EXPIRED, "expired", "authorization expired");

    // 3. The order is exactly the one that was authorized, in canonical normalized form.
    if (hashCanonical(order) !== auth.normalizedOrderHash) throw invalid(ReasonCodes.AUTH_HASH_MISMATCH, "normalized order hash mismatch");
    const expectedClOrdId = deriveClOrdId(auth.policyId, auth.requestId);
    if (order.tool === "spot_place_order" && order.clOrdId !== expectedClOrdId) {
      throw invalid(ReasonCodes.AUTH_HASH_MISMATCH, "clOrdId not derived from requestId");
    }

    // 5. Independent policy recheck immediately before sending. L4's cached view is not trusted.
    let st: Awaited<ReturnType<PolicyStateProvider["getExecutionState"]>>;
    try {
      st = await this.d.policyState.getExecutionState(auth.policyId);
    } catch {
      throw new ExecutionRejected(ReasonCodes.AUTH_POLICY_VERSION_CHANGED, "revoked", "policy state unavailable");
    }
    const revoked = (msg: string) => new ExecutionRejected(ReasonCodes.AUTH_POLICY_VERSION_CHANGED, "revoked", msg);
    if (st.policyVersion !== auth.policyVersion) throw revoked("policy version changed");
    if (st.accountRef !== auth.accountRef) throw revoked("policy account binding changed");
    if (st.revoked) throw revoked("delegation revoked");
    if (this.d.clock() > st.delegationValidUntil) throw revoked("delegation expired");
    // Cancels never add exposure; L4 already required a verified own open order while paused.
    if (st.paused && order.tool !== "spot_cancel_order") throw revoked("policy paused");
    if (this.d.clock() > auth.expiresAt) throw new ExecutionRejected(ReasonCodes.AUTH_EXPIRED, "expired", "authorization expired");

    // 6 + 7. Consume the nonce, assert no prior execution, and write the dispatching WAL record —
    // all in one transaction, before the OKX call. The body is synchronous, so concurrent callers
    // with the same authorization cannot both get past it.
    const clOrdId = order.tool === "spot_place_order" ? order.clOrdId! : expectedClOrdId;
    const claim = tx(this.d.db, (): "ok" | "nonce" | "duplicate" => {
      const t = this.d.clock();
      if (this.d.db.prepare("SELECT 1 FROM executor_nonces WHERE nonce = ?").get(auth.nonce.toLowerCase())) return "nonce";
      if (
        this.d.db.prepare("SELECT 1 FROM executor_nonces WHERE policy_id = ? AND request_id = ?").get(auth.policyId, auth.requestId) ||
        this.d.db.prepare("SELECT 1 FROM orders WHERE request_id = ? OR cl_ord_id = ?").get(auth.requestId, clOrdId)
      ) {
        return "duplicate";
      }
      this.d.db
        .prepare("INSERT INTO executor_nonces (nonce, policy_id, request_id, used_at) VALUES (?, ?, ?, ?)")
        .run(auth.nonce.toLowerCase(), auth.policyId, auth.requestId, t);
      this.d.db
        .prepare(
          `INSERT INTO orders (request_id, policy_id, cl_ord_id, status, event_seq, dispatching_at, updated_at, tool, inst_id)
           VALUES (?, ?, ?, 'dispatching', 0, ?, ?, ?, ?)`,
        )
        .run(auth.requestId, auth.policyId, clOrdId, t, t, order.tool, order.instId);
      return "ok";
    });
    if (claim === "nonce") throw new ExecutionRejected(ReasonCodes.AUTH_NONCE_REUSE, "duplicate", "authorization nonce already used");
    if (claim === "duplicate") throw new ExecutionRejected(ReasonCodes.AUTH_NONCE_REUSE, "duplicate", "request already executed");

    return this.dispatch(auth.policyId, auth.requestId, order);
  }

  /** Exactly one OKX write for this request. */
  private async dispatch(policyId: Hex, requestId: string, order: NormalizedOrder): Promise<ExecutionEvent[]> {
    const events: ExecutionEvent[] = [];
    let res;
    try {
      res = order.tool === "spot_place_order"
        ? await this.d.atk.placeSpotOrder(order)
        : await this.d.atk.cancelSpotOrder(order);
    } catch (e) {
      // Network / timeout: the order may or may not have reached OKX. Never resend; reconcile.
      events.push(this.record(policyId, requestId, "unknown", { raw: { error: (e as Error).message ?? "error" } }));
      return this.emit(policyId, events);
    }

    if (!res.ok) {
      events.push(this.record(policyId, requestId, "rejected_by_okx", { raw: res.raw, okxCode: res.code }));
      return this.emit(policyId, events);
    }

    if (order.tool === "spot_cancel_order") {
      // DecisionLog transitions (shared EXEC_TRANSITIONS): none -> submitted -> cancelled.
      events.push(this.record(policyId, requestId, "submitted", { raw: res.raw, ordId: res.ordId }));
      events.push(this.record(policyId, requestId, "cancelled", { raw: res.raw, ordId: res.ordId }));
      return this.emit(policyId, events);
    }

    events.push(this.record(policyId, requestId, "submitted", { raw: res.raw, ordId: res.ordId }));
    // One read-only follow-up to learn the current state; failures are fine (reconciliation later).
    try {
      const q = await this.d.atk.getOrderByClOrdId(order.instId, order.clOrdId!);
      if (q && ATK_STATE[q.state] !== "submitted") {
        const ev = this.recordIfAllowed(policyId, requestId, ATK_STATE[q.state], { raw: q.raw, ordId: q.ordId });
        if (ev) events.push(ev);
      }
    } catch {
      /* reconciliation will pick it up */
    }
    return this.emit(policyId, events);
  }

  /**
   * Read-only reconciliation (§6.5): matches open/uncertain orders with OKX by clOrdId.
   * Never writes to OKX. "Not found" is not proof of non-acceptance, so UNKNOWN stays UNKNOWN.
   */
  async reconcile(opts: { retries?: number } = {}): Promise<ExecutionEvent[]> {
    const rows = this.d.db
      .prepare(`SELECT * FROM orders WHERE status IN (${OPEN_STATUSES.map(() => "?").join(",")}) AND tool = 'spot_place_order'`)
      .all(...OPEN_STATUSES) as OrderRow[];
    const out: ExecutionEvent[] = [];
    for (const row of rows) {
      let q = undefined as Awaited<ReturnType<AtkClient["getOrderByClOrdId"]>> | undefined;
      for (let attempt = 0; attempt <= (opts.retries ?? 2) && q === undefined; attempt++) {
        try {
          q = await this.d.atk.getOrderByClOrdId(row.inst_id, row.cl_ord_id);
        } catch {
          q = undefined;
        }
      }
      const events: ExecutionEvent[] = [];
      if (q) {
        const status = ATK_STATE[q.state];
        if (status !== row.status) {
          const ev = this.recordIfAllowed(row.policy_id, row.request_id, status, { raw: q.raw, ordId: q.ordId });
          if (ev) events.push(ev);
        }
      } else if (q === null && row.status === "dispatching") {
        // A crash between the WAL write and the result: outcome unknown, hold the reservation.
        events.push(this.record(row.policy_id, row.request_id, "unknown", { raw: { reconciled: "not_found" } }));
      }
      out.push(...(await this.emit(row.policy_id, events)));
    }
    return out;
  }

  /** Durable attempt marker: true once the nonce was claimed (an OKX write may have happened). */
  async hasExecutionAttempt(policyId: Hex, requestId: string): Promise<boolean> {
    return !!this.d.db.prepare("SELECT 1 FROM executor_nonces WHERE policy_id = ? AND request_id = ?").get(policyId, requestId);
  }

  getOrder(requestId: string): { status: OrderRowStatus; eventSeq: number; ordId: string | null; clOrdId: string } | null {
    const r = this.d.db.prepare("SELECT * FROM orders WHERE request_id = ?").get(requestId) as OrderRow | undefined;
    return r ? { status: r.status, eventSeq: r.event_seq, ordId: r.ord_id, clOrdId: r.cl_ord_id } : null;
  }

  events(requestId: string): ExecutionEvent[] {
    return (this.d.db
      .prepare("SELECT * FROM execution_events WHERE request_id = ? ORDER BY event_seq")
      .all(requestId) as Record<string, string | number | null>[]).map((r) => {
      const e: ExecutionEvent = {
        requestId: r.request_id as string,
        eventSeq: r.event_seq as number,
        status: r.status as ExecStatus,
        okxResultHash: r.okx_result_hash as Hex,
        occurredAt: r.occurred_at as number,
      };
      if (r.ord_id) e.ordId = r.ord_id as string;
      if (r.okx_code) e.okxCode = r.okx_code as string;
      return e;
    });
  }

  /**
   * Emit only transitions DecisionLog accepts (shared `isExecTransitionAllowed`), so the chain
   * write can never revert. A disallowed observation (e.g. OKX reports an older state) is skipped.
   */
  private recordIfAllowed(
    policyId: Hex,
    requestId: string,
    status: ExecStatus,
    info: { raw: unknown; ordId?: string; okxCode?: string },
  ): ExecutionEvent | null {
    const row = this.d.db.prepare("SELECT status, event_seq FROM orders WHERE request_id = ?").get(requestId) as
      | { status: OrderRowStatus; event_seq: number }
      | undefined;
    const prev = !row || row.event_seq === 0 || row.status === "dispatching" ? null : (row.status as ExecStatus);
    return isExecTransitionAllowed(prev, status) ? this.record(policyId, requestId, status, info) : null;
  }

  private record(
    _policyId: Hex,
    requestId: string,
    status: ExecStatus,
    info: { raw: unknown; ordId?: string; okxCode?: string },
  ): ExecutionEvent {
    return tx(this.d.db, () => {
      const now = this.d.clock();
      const row = this.d.db.prepare("SELECT * FROM orders WHERE request_id = ?").get(requestId) as OrderRow;
      const event: ExecutionEvent = {
        requestId,
        eventSeq: row.event_seq + 1,
        status,
        okxResultHash: hashResponse(info.raw),
        occurredAt: now,
      };
      const ordId = info.ordId ?? row.ord_id ?? undefined;
      if (ordId) event.ordId = ordId;
      if (info.okxCode) event.okxCode = info.okxCode;
      this.d.db
        .prepare(
          `UPDATE orders SET status = ?, event_seq = ?, ord_id = COALESCE(?, ord_id), last_okx_hash = ?,
             submitted_at = CASE WHEN ? = 'submitted' THEN ? ELSE submitted_at END, updated_at = ?
           WHERE request_id = ?`,
        )
        .run(status, event.eventSeq, ordId ?? null, event.okxResultHash, status, now, now, requestId);
      this.d.db
        .prepare(
          `INSERT INTO execution_events (request_id, event_seq, status, ord_id, okx_code, okx_result_hash, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(requestId, event.eventSeq, status, ordId ?? null, info.okxCode ?? null, event.okxResultHash, now);
      return event;
    });
  }

  private async emit(policyId: Hex, events: ExecutionEvent[]): Promise<ExecutionEvent[]> {
    if (this.d.sink) {
      for (const e of events) {
        try {
          await this.d.sink.onEvent(e, { policyId });
        } catch {
          /* reporting must never affect execution; the event is persisted locally */
        }
      }
    }
    return events;
  }
}
