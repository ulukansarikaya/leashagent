import { concat, hexToBytes, keccak256, stringToBytes } from "viem";
import { dec, decScale, isDec } from "./dec";
import type { Hex, InstrumentInfo, NormalizedOrder, OrderIntent, UUID } from "./types";

export class NormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NormalizationError";
  }
}

/** clOrdId = "bk" + hex(keccak256(policyId ‖ requestId)).slice(0, 30)  (32 chars; OKX constraints Unverified). */
export function deriveClOrdId(policyId: Hex, requestId: UUID): string {
  const digest = keccak256(concat([hexToBytes(policyId), stringToBytes(requestId)]));
  return `bk${digest.slice(2, 32)}`;
}

function roundField(name: string, value: string | undefined, step: string): string {
  if (value === undefined || !isDec(value)) {
    throw new NormalizationError(`${name} missing or not a decimal`);
  }
  const v = dec(value);
  if (v.isNegative() || v.isZero()) throw new NormalizationError(`${name} must be > 0`);
  const rounded = v.floorToStep(step);
  if (rounded.isZero()) throw new NormalizationError(`${name} rounds to 0`);
  // Fixed scale: the instrument step's scale, trailing zeros kept.
  return rounded.toFixed(decScale(step));
}

/**
 * Deterministic normalization of an untrusted intent into the exact order that
 * would be sent to OKX (§5.5). Throws NormalizationError -> REJECTED_SCHEMA.
 */
export function normalizeOrder(
  intent: OrderIntent,
  instrument: InstrumentInfo,
  requestId: UUID,
  policyId: Hex,
): NormalizedOrder {
  const instId = intent.instId;
  if (!instId) throw new NormalizationError("instId required");
  if (instId !== instrument.instId) throw new NormalizationError("instrument mismatch");

  if (intent.tool === "spot_cancel_order") {
    if (!intent.ordId && !intent.clOrdIdToCancel) {
      throw new NormalizationError("cancel requires ordId or clOrdIdToCancel");
    }
    if (intent.ordId && intent.clOrdIdToCancel) {
      throw new NormalizationError("cancel takes exactly one of ordId / clOrdIdToCancel");
    }
    if (intent.side || intent.ordType || intent.sz !== undefined || intent.px !== undefined) {
      throw new NormalizationError("unexpected place-order fields on cancel");
    }
    const cancel: { ordId?: string; clOrdId?: string } = {};
    if (intent.ordId) cancel.ordId = intent.ordId;
    if (intent.clOrdIdToCancel) cancel.clOrdId = intent.clOrdIdToCancel;
    return { tool: "spot_cancel_order", instId, cancel };
  }

  if (intent.tool !== "spot_place_order") throw new NormalizationError("unknown tool");
  if (intent.ordId || intent.clOrdIdToCancel) {
    throw new NormalizationError("unexpected cancel fields on place order");
  }
  if (intent.side !== "buy" && intent.side !== "sell") throw new NormalizationError("invalid side");
  if (intent.ordType !== "market" && intent.ordType !== "limit") {
    throw new NormalizationError("invalid ordType");
  }

  const sz = roundField("sz", intent.sz, instrument.lotSz);
  if (instrument.minSz !== undefined && dec(sz).lt(instrument.minSz)) {
    throw new NormalizationError("sz below minSz");
  }

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
    order.tgtCcy = "base_ccy"; // Unverified: confirm in P0 market-buy spike (§17, §25.6)
  }
  return order;
}
