import { isDec, type Dec, type NormalizedOrder } from "@bekci/shared";
import { classifyWrite, errorIsDefiniteRejection } from "./classify";
import type { AtkTransport } from "./types";

// Structurally identical to @bekci/executor's AtkClient / AtkResult / AtkOrder (no import, so the
// executor stays free of transport code and this package free of executor code).
export type AtkResult =
  | { ok: true; ordId: string; raw: unknown }
  | { ok: false; kind: "rejected"; code: string; msg: string; raw: unknown };

export type AtkOrderState = "live" | "partially_filled" | "filled" | "canceled";
export type AtkOrder = { ordId: string; clOrdId: string; instId: string; state: AtkOrderState; accFillSz: Dec; raw: unknown };

/** Thrown when a write's outcome cannot be established. The executor records UNKNOWN; no resend. */
export class AtkUncertainError extends Error {
  constructor(readonly reason: string, readonly raw: unknown) {
    super(`ATK outcome uncertain: ${reason}`);
    this.name = "AtkUncertainError";
  }
}

/** OKX "order does not exist". */
const ORDER_NOT_FOUND = new Set(["51603"]);

const STATE: Record<string, AtkOrderState> = {
  live: "live",
  partially_filled: "partially_filled",
  filled: "filled",
  canceled: "canceled",
  mmp_canceled: "canceled",
};

/**
 * AtkClient over ATK's spot tools (§17). Sends exactly the normalized order: tdMode "cash",
 * the derived clOrdId, and tgtCcy when the order carries it. Never retries a write; the
 * transport (ATK REST client) also never auto-retries POSTs.
 */
export class OkxAtkClient {
  constructor(private readonly t: AtkTransport) {}

  async placeSpotOrder(o: NormalizedOrder): Promise<AtkResult> {
    if (o.tool !== "spot_place_order" || !o.side || !o.ordType || !o.sz || !o.clOrdId) {
      // Refused locally, nothing sent.
      return { ok: false, kind: "rejected", code: "LOCAL", msg: "not a complete place order", raw: null };
    }
    const args: Record<string, unknown> = {
      instId: o.instId,
      tdMode: "cash",
      side: o.side,
      ordType: o.ordType,
      sz: o.sz,
      clOrdId: o.clOrdId,
    };
    if (o.px !== undefined) args.px = o.px;
    if (o.tgtCcy !== undefined) args.tgtCcy = o.tgtCcy;
    return this.write("spot_place_order", args);
  }

  async cancelSpotOrder(o: NormalizedOrder): Promise<AtkResult> {
    if (o.tool !== "spot_cancel_order" || !o.cancel || (!o.cancel.ordId && !o.cancel.clOrdId)) {
      return { ok: false, kind: "rejected", code: "LOCAL", msg: "not a cancel order", raw: null };
    }
    const args: Record<string, unknown> = { instId: o.instId };
    if (o.cancel.ordId) args.ordId = o.cancel.ordId;
    else args.clOrdId = o.cancel.clOrdId;
    return this.write("spot_cancel_order", args);
  }

  /** Read-only; safe to retry. Returns null only on OKX's explicit "order does not exist". */
  async getOrderByClOrdId(instId: string, clOrdId: string): Promise<AtkOrder | null> {
    const r = await this.t.callTool("spot_get_order", { instId, clOrdId });
    if (!r.ok) {
      if (r.error.code && ORDER_NOT_FOUND.has(r.error.code)) return null;
      throw new Error(`order query failed: ${r.error.type}${r.error.code ? ` ${r.error.code}` : ""}`);
    }
    const rows = r.response.data;
    const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
    if (!row) return null;
    const state = STATE[String(row.state)];
    if (!state) throw new Error(`unknown OKX order state ${String(row.state)}`);
    const accFillSz = String(row.accFillSz ?? "0");
    return {
      ordId: String(row.ordId),
      clOrdId: String(row.clOrdId ?? clOrdId),
      instId: String(row.instId ?? instId),
      state,
      accFillSz: isDec(accFillSz) ? accFillSz : "0",
      raw: row,
    };
  }

  private async write(tool: string, args: Record<string, unknown>): Promise<AtkResult> {
    let r;
    try {
      r = await this.t.callTool(tool, args);
    } catch (e) {
      throw new AtkUncertainError((e as Error).message ?? "transport failure", null);
    }
    const c = classifyWrite(r);
    if (c.kind === "accepted") return { ok: true, ordId: c.ordId, raw: c.raw };
    if (c.kind === "rejected") return { ok: false, kind: "rejected", code: c.code, msg: c.msg, raw: c.raw };
    throw new AtkUncertainError(c.reason, c.raw);
  }
}

export { errorIsDefiniteRejection };
