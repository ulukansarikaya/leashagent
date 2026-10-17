import { describe, expect, it } from "vitest";
import {
  NormalizationError,
  deriveClOrdId,
  hashCanonical,
  normalizeOrder,
  type Hex,
  type InstrumentInfo,
  type OrderIntent,
} from "../src";

const POLICY = ("0x" + "ab".repeat(32)) as Hex;
const REQ = "11111111-1111-4111-8111-111111111111";
const INST: InstrumentInfo = { instId: "BTC-USDT", lotSz: "0.00000001", tickSz: "0.1", minSz: "0.00001" };

const buy = (o: Partial<OrderIntent> = {}): OrderIntent => ({
  tool: "spot_place_order",
  instId: "BTC-USDT",
  side: "buy",
  ordType: "limit",
  sz: "0.5",
  px: "60000",
  ...o,
});

describe("normalizeOrder", () => {
  it("equalizes format differences", () => {
    const a = normalizeOrder(buy({ sz: "50" }), INST, REQ, POLICY);
    const b = normalizeOrder(buy({ sz: "50.0" }), INST, REQ, POLICY);
    const c = normalizeOrder(buy({ sz: "50.00000000" }), INST, REQ, POLICY);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a.sz).toBe("50.00000000");
    expect(hashCanonical(a)).toBe(hashCanonical(c));
  });

  it("rounds down to lot and tick, fixed scale", () => {
    const o = normalizeOrder(buy({ sz: "0.123456789", px: "60000.19" }), INST, REQ, POLICY);
    expect(o.sz).toBe("0.12345678");
    expect(o.px).toBe("60000.1");
  });

  it("rejects when rounding to zero or below minSz", () => {
    expect(() => normalizeOrder(buy({ sz: "0.000000001" }), INST, REQ, POLICY)).toThrow(NormalizationError);
    expect(() => normalizeOrder(buy({ sz: "0.000001" }), INST, REQ, POLICY)).toThrow(/minSz/);
    expect(() => normalizeOrder(buy({ px: "0.05" }), INST, REQ, POLICY)).toThrow(NormalizationError);
  });

  it("rejects negative / zero / malformed", () => {
    for (const sz of ["0", "-1", "1e3", "abc"]) {
      expect(() => normalizeOrder(buy({ sz }), INST, REQ, POLICY)).toThrow(NormalizationError);
    }
  });

  it("derives deterministic 32-char clOrdId", () => {
    const id = deriveClOrdId(POLICY, REQ);
    expect(id).toMatch(/^la[0-9a-f]{30}$/);
    expect(id).toBe(deriveClOrdId(POLICY, REQ));
    expect(id).not.toBe(deriveClOrdId(POLICY, "22222222-2222-4222-8222-222222222222"));
    expect(normalizeOrder(buy(), INST, REQ, POLICY).clOrdId).toBe(id);
  });

  it("market order: tgtCcy set, px forbidden", () => {
    const m = normalizeOrder(buy({ ordType: "market", px: undefined }), INST, REQ, POLICY);
    expect(m.tgtCcy).toBe("base_ccy");
    expect(m.px).toBeUndefined();
    expect(() => normalizeOrder(buy({ ordType: "market" }), INST, REQ, POLICY)).toThrow();
  });

  it("limit order requires px", () => {
    expect(() => normalizeOrder(buy({ px: undefined }), INST, REQ, POLICY)).toThrow();
  });

  it("cancel: exactly one identifier, no place fields", () => {
    const c = normalizeOrder({ tool: "spot_cancel_order", instId: "BTC-USDT", ordId: "123" }, INST, REQ, POLICY);
    expect(c).toEqual({ tool: "spot_cancel_order", instId: "BTC-USDT", cancel: { ordId: "123" } });
    expect(() => normalizeOrder({ tool: "spot_cancel_order", instId: "BTC-USDT" }, INST, REQ, POLICY)).toThrow();
    expect(() =>
      normalizeOrder({ tool: "spot_cancel_order", instId: "BTC-USDT", ordId: "1", clOrdIdToCancel: "x" }, INST, REQ, POLICY),
    ).toThrow();
    expect(() =>
      normalizeOrder({ tool: "spot_cancel_order", instId: "BTC-USDT", ordId: "1", sz: "1" }, INST, REQ, POLICY),
    ).toThrow();
  });

  it("rejects instrument mismatch", () => {
    expect(() => normalizeOrder(buy({ instId: "ETH-USDT" }), INST, REQ, POLICY)).toThrow(/instrument/);
  });
});
