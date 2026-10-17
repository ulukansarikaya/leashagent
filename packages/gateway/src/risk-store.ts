import { randomUUID } from "node:crypto";
import {
  ReasonCodes,
  dec,
  isDec,
  type Dec,
  type EpochSec,
  type Hex,
  type ReservationRequest,
  type ReservationResult,
  type RiskSnapshot,
  type UUID,
} from "@leashagent/shared";
import { SELL_INVENTORY_REASON } from "./limits";
import { tx, type Db } from "./db";
import type { AccountState, Clock, RiskProvider } from "./ports";
import type { GatewayStore } from "./store";

export type ReservationState = "reserved" | "submitted" | "released" | "reconciled";

/** Extra reservation detail. Risk-reducing sells pass notionalUsdt "0" and reserve base inventory. */
export type ReserveOptions = {
  instId?: string;
  sell?: { ccy: string; qty: Dec };
};

export interface RiskStore {
  snapshot(policyId: Hex): Promise<RiskSnapshot>;
  reserve(r: ReservationRequest, opts?: ReserveOptions): Promise<ReservationResult>;
  /** `policyId` is optional to match §15.1; requestIds are UUIDs so collisions across policies are not expected. */
  release(requestId: UUID, policyId?: Hex): Promise<void>;
}

const ACTIVE = "('reserved', 'submitted')";
const RATE_WINDOW_SEC = 60;

type ReservationRow = {
  reservation_id: string; request_id: string; policy_id: string; notional_usdt: string; state: ReservationState;
  sell_ccy: string | null; sell_qty: string | null;
};

export type RiskStoreDeps = {
  db: Db;
  store: GatewayStore;
  risk: RiskProvider;
  clock: Clock;
};

/**
 * L5 risk state (§6.5). Limit check and reservation run inside one SQLite transaction; the
 * transaction body is synchronous, so concurrent async callers cannot interleave inside it (INV-10).
 *
 * Reserved notional counts `reserved` and `submitted` rows. A submitted order may also appear in the
 * exchange's pending-orders figure until `settle()` is called; that double count is deliberately
 * conservative (fail-closed).
 */
export class DefaultRiskStore implements RiskStore {
  constructor(private readonly d: RiskStoreDeps) {}

  async snapshot(policyId: Hex): Promise<RiskSnapshot> {
    const acct = await this.d.risk.getAccountState(policyId);
    assertAccountState(acct);
    const now = this.d.clock();
    this.persistDailyPnl(policyId, acct, now);
    return {
      policyId,
      fetchedAt: acct.fetchedAt,
      dailyPnlUsdt: acct.dailyPnlUsdt,
      openNotionalUsdt: acct.openNotionalUsdt,
      pendingOrdersNotionalUsdt: acct.pendingOrdersNotionalUsdt,
      reservedNotionalUsdt: this.reservedNotional(policyId),
      baseBalances: { ...acct.baseBalances },
      ordersLastMinute: this.d.store.countRateEvents(policyId, now - RATE_WINDOW_SEC),
    };
  }

  /** availableSellBalance = total - lockedByOpenSellOrders - reservedSellQuantity (§6.4). */
  async sellAvailable(policyId: Hex, ccy: string): Promise<{ available: Dec; fetchedAt: EpochSec }> {
    const acct = await this.d.risk.getAccountState(policyId);
    assertAccountState(acct);
    return { available: this.availableSell(policyId, ccy, acct), fetchedAt: acct.fetchedAt };
  }

  async reserve(r: ReservationRequest, opts: ReserveOptions = {}): Promise<ReservationResult> {
    if (!isDec(r.notionalUsdt) || dec(r.notionalUsdt).isNegative()) {
      return { ok: false, reasonCode: ReasonCodes.OPEN_NOTIONAL };
    }
    if (opts.sell && (!isDec(opts.sell.qty) || !dec(opts.sell.qty).gt("0"))) {
      return { ok: false, reasonCode: SELL_INVENTORY_REASON };
    }

    // Fresh account state; failure is fail-closed.
    let acct: AccountState;
    try {
      acct = await this.d.risk.getAccountState(r.policyId);
      assertAccountState(acct);
    } catch {
      return { ok: false, reasonCode: ReasonCodes.STALE_DATA };
    }

    const now = this.d.clock();
    return tx(this.d.db, (): ReservationResult => {
      const existing = this.activeReservation(r.policyId, r.requestId);
      if (existing) return { ok: true, reservationId: existing.reservation_id };

      const riskIncreasing = dec(r.notionalUsdt).gt("0");
      if (riskIncreasing) {
        if (dec(acct.dailyPnlUsdt).lte(dec(r.limitsToEnforce.maxDailyLossUsdt).neg().toString())) {
          return { ok: false, reasonCode: ReasonCodes.DAILY_LOSS };
        }
        const total = dec(acct.openNotionalUsdt)
          .add(acct.pendingOrdersNotionalUsdt)
          .add(this.reservedNotional(r.policyId))
          .add(r.notionalUsdt);
        if (total.gt(r.limitsToEnforce.maxOpenNotionalUsdt)) {
          return { ok: false, reasonCode: ReasonCodes.OPEN_NOTIONAL };
        }
      }
      if (opts.sell && dec(this.availableSell(r.policyId, opts.sell.ccy, acct)).lt(opts.sell.qty)) {
        return { ok: false, reasonCode: SELL_INVENTORY_REASON };
      }

      const reservationId = randomUUID();
      this.d.db
        .prepare(
          `INSERT INTO reservations (reservation_id, request_id, policy_id, notional_usdt, state, created_at, updated_at,
             inst_id, sell_ccy, sell_qty)
           VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?)`,
        )
        .run(reservationId, r.requestId, r.policyId, r.notionalUsdt, now, now,
          opts.instId ?? null, opts.sell?.ccy ?? null, opts.sell?.qty ?? null);
      return { ok: true, reservationId };
    });
  }

  async release(requestId: UUID, policyId?: Hex): Promise<void> {
    this.releaseNow(requestId, policyId);
  }

  /** Synchronous release, usable inside an enclosing transaction. */
  releaseNow(requestId: UUID, policyId?: Hex): boolean {
    return this.transition(requestId, policyId, "released");
  }

  /** reserved -> submitted (executor observed an OKX submission). */
  markSubmitted(requestId: UUID, policyId?: Hex): boolean {
    return this.transition(requestId, policyId, "submitted", "('reserved')");
  }

  /** Exchange state now reflects the order (filled / open at OKX); stop counting the reservation. */
  settle(requestId: UUID, policyId?: Hex): boolean {
    return this.transition(requestId, policyId, "reconciled");
  }

  getReservation(policyId: Hex, requestId: UUID): { reservationId: UUID; state: ReservationState; notionalUsdt: Dec } | null {
    const r = this.d.db
      .prepare(
        `SELECT * FROM reservations WHERE policy_id = ? AND request_id = ?
         ORDER BY CASE WHEN state IN ${ACTIVE} THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
      )
      .get(policyId, requestId) as ReservationRow | undefined;
    return r ? { reservationId: r.reservation_id, state: r.state, notionalUsdt: r.notional_usdt } : null;
  }

  reservedNotional(policyId: Hex): Dec {
    const rows = this.d.db
      .prepare(`SELECT notional_usdt FROM reservations WHERE policy_id = ? AND state IN ${ACTIVE}`)
      .all(policyId) as { notional_usdt: string }[];
    return rows.reduce((acc, r) => dec(acc).add(r.notional_usdt).toString(), "0");
  }

  private reservedSell(policyId: Hex, ccy: string): Dec {
    const rows = this.d.db
      .prepare(`SELECT sell_qty FROM reservations WHERE policy_id = ? AND sell_ccy = ? AND state IN ${ACTIVE}`)
      .all(policyId, ccy) as { sell_qty: string }[];
    return rows.reduce((acc, r) => dec(acc).add(r.sell_qty).toString(), "0");
  }

  private availableSell(policyId: Hex, ccy: string, acct: AccountState): Dec {
    return dec(acct.baseBalances[ccy] ?? "0")
      .sub(acct.lockedBySellOrders[ccy] ?? "0")
      .sub(this.reservedSell(policyId, ccy))
      .toString();
  }

  private activeReservation(policyId: Hex, requestId: UUID): ReservationRow | undefined {
    return this.d.db
      .prepare(`SELECT * FROM reservations WHERE policy_id = ? AND request_id = ? AND state IN ${ACTIVE}`)
      .get(policyId, requestId) as ReservationRow | undefined;
  }

  private transition(requestId: UUID, policyId: Hex | undefined, to: ReservationState, from = ACTIVE): boolean {
    const now = this.d.clock();
    const res = policyId
      ? this.d.db
          .prepare(`UPDATE reservations SET state = ?, updated_at = ? WHERE policy_id = ? AND request_id = ? AND state IN ${from}`)
          .run(to, now, policyId, requestId)
      : this.d.db
          .prepare(`UPDATE reservations SET state = ?, updated_at = ? WHERE request_id = ? AND state IN ${from}`)
          .run(to, now, requestId);
    return Number(res.changes) > 0;
  }

  private persistDailyPnl(policyId: Hex, acct: AccountState, now: EpochSec): void {
    const day = new Date(acct.fetchedAt * 1000).toISOString().slice(0, 10);
    this.d.db
      .prepare(
        `INSERT INTO daily_pnl (policy_id, utc_day, pnl_usdt, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(policy_id, utc_day) DO UPDATE SET pnl_usdt = excluded.pnl_usdt, updated_at = excluded.updated_at`,
      )
      .run(policyId, day, acct.dailyPnlUsdt, now);
  }
}

function assertAccountState(a: AccountState): void {
  const decs = [a.dailyPnlUsdt, a.openNotionalUsdt, a.pendingOrdersNotionalUsdt,
    ...Object.values(a.baseBalances), ...Object.values(a.lockedBySellOrders)];
  if (!Number.isInteger(a.fetchedAt) || !decs.every(isDec)) throw new Error("malformed account state");
}
