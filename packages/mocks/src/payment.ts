import type { Hex } from "@leashagent/shared";

type CreditState = "reserved" | "consumed" | "released";

/**
 * Mock of the x402 PaymentEntitlement (§21.2). One "payment" grants `credits`.
 * Idempotent on (policyId, requestId); BLOCK/PENDING release, ALLOW consumes.
 */
export class MockPayment {
  remaining: number;
  readonly entries = new Map<string, CreditState>();
  /** Address the credits were bought by; must equal the delegated agentAuthAddress. */
  payer: Hex | null = null;
  failConsume = false;

  constructor(credits = 5) {
    this.remaining = credits;
  }

  private key(policyId: Hex, requestId: string) {
    return `${policyId}:${requestId}`;
  }

  async reserveCredit(policyId: Hex, _agentId: string, payer: Hex, requestId: string) {
    const k = this.key(policyId, requestId);
    const cur = this.entries.get(k);
    if (cur === "reserved" || cur === "consumed") return { ok: true as const, creditReservationId: k };
    if (this.payer && this.payer.toLowerCase() !== payer.toLowerCase()) {
      return { ok: false as const, paymentRequired: true as const };
    }
    if (this.remaining <= 0) return { ok: false as const, paymentRequired: true as const, paymentChallenge: { x402: "mock" } };
    this.remaining--;
    this.entries.set(k, "reserved");
    return { ok: true as const, creditReservationId: k };
  }

  async consumeReservedCredit(policyId: Hex, requestId: string): Promise<void> {
    if (this.failConsume) throw new Error("credit store unavailable");
    const k = this.key(policyId, requestId);
    const cur = this.entries.get(k);
    if (cur === "consumed") return;
    if (cur !== "reserved") throw new Error("no reserved credit");
    this.entries.set(k, "consumed");
  }

  async releaseReservedCredit(policyId: Hex, requestId: string, _reason: string): Promise<void> {
    const k = this.key(policyId, requestId);
    if (this.entries.get(k) !== "reserved") return;
    this.entries.set(k, "released");
    this.remaining++;
  }

  readonly refunds: string[] = [];
  failRefund = false;

  async refundConsumedCredit(policyId: Hex, requestId: string, _reason: string): Promise<void> {
    if (this.failRefund) throw new Error("credit store unavailable");
    const k = this.key(policyId, requestId);
    if (this.entries.get(k) !== "consumed") return;
    this.entries.set(k, "released");
    this.remaining++;
    this.refunds.push(k);
  }

  consumed(): number {
    return [...this.entries.values()].filter((s) => s === "consumed").length;
  }
}
