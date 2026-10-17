import { dec, decScale, isDec } from "./dec.js";
import { deriveClOrdId } from "./ids.js";
import type { Hex, InstrumentInfo, NormalizedOrder, OrderIntent, UUID } from "./types.js";

// Order normalization (§5.5) — owned by Person 1, added to shared per PERSON3_HANDOFF.md item 7.

export class NormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NormalizationError";
  }
}

function roundField(name: string, value: string | undefined, step: string): string {
  if (value === undefined || !isDec(value)) throw new NormalizationError(`${name} missing or not a decimal`);
  const v = dec(value);
  if (v.isNegative() || v.isZero()) throw new NormalizationError(`${name} must be > 0`);
  const rounded = v.floorToStep(step);
  if (rounded.isZero()) throw new NormalizationError(`${name} rounds to 0`);
  // Fixed scale: the instrument step's scale, trailing zeros kept ("50" == "50.0" == "50.00000000").
  return rounded.toFixed(decScale(step));
}

/**
 * Deterministic normalization of an untrusted intent into exactly the order that would be sent to
 * OKX (§5.5): sz/px rounded down to lotSz/tickSz at fixed scale, clOrdId derived from requestId,
 * tgtCcy=base_ccy on market orders (Unverified until the P0 spike, §17/§25.6).
 * Throws NormalizationError -> REJECTED_SCHEMA.
 */
export function normalizeOrder(intent: OrderIntent, instrument: InstrumentInfo, requestId: UUID, policyId: Hex): NormalizedOrder {
  const instId = intent.instId;
  if (!instId) throw new NormalizationError("instId required");
  if (instId !== instrument.instId) throw new NormalizationError("instrument mismatch");

  if (intent.tool === "spot_cancel_order") {
    if (!intent.ordId && !intent.clOrdIdToCancel) throw new NormalizationError("cancel requires ordId or clOrdIdToCancel");
    if (intent.ordId && intent.clOrdIdToCancel) throw new NormalizationError("cancel takes exactly one of ordId / clOrdIdToCancel");
    if (intent.side || intent.ordType || intent.sz !== undefined || intent.px !== undefined) {
      throw new NormalizationError("unexpected place-order fields on cancel");
    }
    const cancel: { ordId?: string; clOrdId?: string } = {};
    if (intent.ordId) cancel.ordId = intent.ordId;
    if (intent.clOrdIdToCancel) cancel.clOrdId = intent.clOrdIdToCancel;
    return { tool: "spot_cancel_order", instId, cancel };
  }

  if (intent.tool !== "spot_place_order") throw new NormalizationError("unknown tool");
  if (intent.ordId || intent.clOrdIdToCancel) throw new NormalizationError("unexpected cancel fields on place order");
  if (intent.side !== "buy" && intent.side !== "sell") throw new NormalizationError("invalid side");
  if (intent.ordType !== "market" && intent.ordType !== "limit") throw new NormalizationError("invalid ordType");

  const sz = roundField("sz", intent.sz, instrument.lotSz);
  if (instrument.minSz !== undefined && dec(sz).lt(instrument.minSz)) throw new NormalizationError("sz below minSz");

  const order: NormalizedOrder = {
    tool: "spot_place_order",
    instId,
    side: intent.side,
    ordType: intent.ordType,
    sz,
    clOrdId: deriveClOrdId(policyId, requestId),
  };
  if (intent.ordType === "limit") {
    order.px = roundField("px", intent.px, instrument.tickSz);
  } else {
    if (intent.px !== undefined) throw new NormalizationError("px not allowed on market order");
    order.tgtCcy = "base_ccy";
  }
  return order;
}
