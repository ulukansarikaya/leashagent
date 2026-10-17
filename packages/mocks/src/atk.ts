import type { Dec, NormalizedOrder } from "@bekci/shared";

// Structurally matches @bekci/executor AtkClient / AtkResult / AtkOrder.

export type FakeAtkMode = "ok" | "reject" | "timeout_after_accept" | "timeout_before_accept";

type FakeOrder = {
  ordId: string;
  clOrdId: string;
  instId: string;
  state: "live" | "partially_filled" | "filled" | "canceled";
  accFillSz: Dec;
  order: NormalizedOrder;
};

/**
 * In-memory OKX stand-in for the executor until the real ATK path is verified (P0 spike).
 * Market orders fill immediately; limit orders rest as `live`.
 */
export class FakeAtkClient {
  mode: FakeAtkMode = "ok";
  queryFailing = false;
  /** Every write call that reached the "exchange", in order. */
  readonly writes: { kind: "place" | "cancel"; clOrdId?: string; ordId?: string }[] = [];
  readonly orders = new Map<string, FakeOrder>();
  /** Hook run at the start of each write (e.g. to assert the WAL record exists). */
  onWrite: ((o: NormalizedOrder) => void) | undefined;
  latencyMs = 0;
  private seq = 1000;

  writesFor(clOrdId: string): number {
    return this.writes.filter((w) => w.clOrdId === clOrdId).length;
  }

  private async delay() {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
  }

  async placeSpotOrder(o: NormalizedOrder) {
    this.writes.push({ kind: "place", clOrdId: o.clOrdId! });
    this.onWrite?.(o);
    await this.delay();
    if (this.mode === "timeout_before_accept") throw new Error("ETIMEDOUT");
    if (this.mode === "reject") {
      return { ok: false as const, kind: "rejected" as const, code: "51008", msg: "insufficient balance", raw: { code: "1", data: [{ sCode: "51008" }] } };
    }
    const ordId = String(++this.seq);
    this.orders.set(o.clOrdId!, {
      ordId, clOrdId: o.clOrdId!, instId: o.instId, order: o,
      state: o.ordType === "market" ? "filled" : "live",
      accFillSz: o.ordType === "market" ? o.sz! : "0",
    });
    if (this.mode === "timeout_after_accept") throw new Error("ETIMEDOUT");
    return { ok: true as const, ordId, raw: { code: "0", data: [{ ordId, clOrdId: o.clOrdId, sCode: "0" }] } };
  }

  async cancelSpotOrder(o: NormalizedOrder) {
    this.writes.push({ kind: "cancel", ...(o.cancel ?? {}) });
    this.onWrite?.(o);
    await this.delay();
    if (this.mode === "timeout_before_accept") throw new Error("ETIMEDOUT");
    const target = [...this.orders.values()].find(
      (x) => (o.cancel?.ordId && x.ordId === o.cancel.ordId) || (o.cancel?.clOrdId && x.clOrdId === o.cancel.clOrdId),
    );
    if (!target || target.state === "filled" || target.state === "canceled") {
      return { ok: false as const, kind: "rejected" as const, code: "51400", msg: "order does not exist", raw: { code: "1" } };
    }
    target.state = "canceled";
    if (this.mode === "timeout_after_accept") throw new Error("ETIMEDOUT");
    return { ok: true as const, ordId: target.ordId, raw: { code: "0", data: [{ ordId: target.ordId, sCode: "0" }] } };
  }

  async getOrderByClOrdId(instId: string, clOrdId: string) {
    if (this.queryFailing) throw new Error("query failed");
    const x = this.orders.get(clOrdId);
    if (!x || x.instId !== instId) return null;
    return { ordId: x.ordId, clOrdId: x.clOrdId, instId: x.instId, state: x.state, accFillSz: x.accFillSz, raw: { state: x.state } };
  }

  /** Test helper: simulate an exchange-side fill of a resting order. */
  fill(clOrdId: string): void {
    const x = this.orders.get(clOrdId);
    if (x) {
      x.state = "filled";
      x.accFillSz = x.order.sz ?? "0";
    }
  }
}
