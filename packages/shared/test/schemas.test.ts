import { describe, expect, it } from "vitest";
import { schemas } from "../src";

const base = {
  requestId: "11111111-1111-4111-8111-111111111111",
  policyId: "0x" + "ab".repeat(32),
  agentId: "agent-1",
  issuedAt: 1_700_000_000,
  authNonce: "0x" + "cd".repeat(16),
  intent: { tool: "spot_place_order", instId: "BTC-USDT", side: "buy", ordType: "limit", sz: "0.5", px: "60000" },
  agentReason: "sma crossover",
  referencedReadIds: [],
  agentSignature: "0x" + "00".repeat(65),
};

describe("signedIntentRequest schema", () => {
  it("accepts a valid request", () => {
    expect(schemas.signedIntentRequest.safeParse(base).success).toBe(true);
  });

  it("rejects extra fields (top-level and in intent)", () => {
    expect(schemas.signedIntentRequest.safeParse({ ...base, riskIncreasing: true }).success).toBe(false);
    expect(
      schemas.signedIntentRequest.safeParse({ ...base, intent: { ...base.intent, protective: true } }).success,
    ).toBe(false);
  });

  it("rejects forbidden / unknown tools", () => {
    for (const tool of ["withdraw", "transfer", "spot_amend_order"]) {
      expect(schemas.signedIntentRequest.safeParse({ ...base, intent: { tool } }).success).toBe(false);
    }
  });

  it("limit needs px, market forbids px", () => {
    expect(schemas.orderIntent.safeParse({ ...base.intent, px: undefined }).success).toBe(false);
    expect(schemas.orderIntent.safeParse({ ...base.intent, ordType: "market" }).success).toBe(false);
    expect(schemas.orderIntent.safeParse({ ...base.intent, ordType: "market", px: undefined }).success).toBe(true);
  });

  it("rejects numbers instead of decimal strings", () => {
    expect(schemas.orderIntent.safeParse({ ...base.intent, sz: 0.5 }).success).toBe(false);
  });

  it("cancel requires exactly one identifier", () => {
    const c = { tool: "spot_cancel_order", instId: "BTC-USDT" };
    expect(schemas.orderIntent.safeParse(c).success).toBe(false);
    expect(schemas.orderIntent.safeParse({ ...c, ordId: "123" }).success).toBe(true);
    expect(schemas.orderIntent.safeParse({ ...c, ordId: "1", clOrdIdToCancel: "x" }).success).toBe(false);
  });

  it("enforces size limits and hex shapes", () => {
    expect(schemas.signedIntentRequest.safeParse({ ...base, agentReason: "x".repeat(1001) }).success).toBe(false);
    expect(schemas.signedIntentRequest.safeParse({ ...base, authNonce: "0x1234" }).success).toBe(false);
    expect(schemas.signedIntentRequest.safeParse({ ...base, requestId: "nope" }).success).toBe(false);
  });
});
