import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Hex } from "@leashagent/shared";
import {
  CreditStore,
  MockSettlement,
  encodePaymentHeader,
  purchaseCredits,
  type DelegationResolver,
  type PaymentRequirements,
} from "../src/index.js";

const PID = `0x${"ab".repeat(32)}` as Hex;
const PID2 = `0x${"cd".repeat(32)}` as Hex;
const AGENT = "leash-demo-agent";
const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Hex;
const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Hex;
const rid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

const reqs: PaymentRequirements = {
  scheme: "exact", network: "avalanche-fuji", maxAmountRequired: "100000", resource: "/v1/credits",
  description: "5 Leash Agent risk-increasing intent checks", mimeType: "application/json",
  payTo: "0x0000000000000000000000000000000000000B0C", maxTimeoutSeconds: 60,
  asset: "0x5425890298aed601595a70AB815c96711a31Bc65",
};

function store() {
  return new CreditStore(new DatabaseSync(":memory:"), { challenge: () => reqs });
}

describe("CreditStore", () => {
  it("one payment mints exactly 5 credits, once (INV-18)", () => {
    const s = store();
    const a = s.mint({ paymentRef: "fuji:0x1", policyId: PID, agentId: AGENT, payer: PAYER });
    expect(a).toMatchObject({ ok: true, credit: { purchased: 5, remaining: 5 } });
    expect(s.mint({ paymentRef: "fuji:0x1", policyId: PID, agentId: AGENT, payer: PAYER })).toEqual({ ok: false, reason: "duplicate_payment" });
    expect(s.mint({ paymentRef: "fuji:0x1", policyId: PID2, agentId: "x", payer: OTHER })).toEqual({ ok: false, reason: "duplicate_payment" });
    expect(s.available(PID, AGENT, PAYER)).toBe(5);
  });

  it("no credit → payment required with challenge (never a bypass)", async () => {
    const s = store();
    expect(await s.reserveCredit(PID, AGENT, PAYER, rid(1))).toEqual({ ok: false, paymentRequired: true, paymentChallenge: reqs });
  });

  it("reserve → consume burns one credit; repeat request never burns twice", async () => {
    const s = store();
    s.mint({ paymentRef: "p1", policyId: PID, agentId: AGENT, payer: PAYER });
    expect((await s.reserveCredit(PID, AGENT, PAYER, rid(1))).ok).toBe(true);
    expect((await s.reserveCredit(PID, AGENT, PAYER, rid(1))).ok).toBe(true); // retry
    expect(s.available(PID, AGENT, PAYER)).toBe(4);
    await s.consumeReservedCredit(PID, rid(1));
    await s.consumeReservedCredit(PID, rid(1)); // idempotent
    expect((await s.reserveCredit(PID, AGENT, PAYER, rid(1))).ok).toBe(true); // already consumed → same state
    expect(s.available(PID, AGENT, PAYER)).toBe(4);
    expect(s.consumptionState(PID, rid(1))).toBe("consumed");
  });

  it("BLOCK/PENDING release returns the credit; re-reserve after approval works", async () => {
    const s = store();
    s.mint({ paymentRef: "p1", policyId: PID, agentId: AGENT, payer: PAYER });
    await s.reserveCredit(PID, AGENT, PAYER, rid(1));
    await s.releaseReservedCredit(PID, rid(1), "PENDING");
    await s.releaseReservedCredit(PID, rid(1), "PENDING"); // idempotent
    expect(s.available(PID, AGENT, PAYER)).toBe(5);
    await s.reserveCredit(PID, AGENT, PAYER, rid(1)); // human approved → new reservation
    await s.consumeReservedCredit(PID, rid(1));
    expect(s.available(PID, AGENT, PAYER)).toBe(4);
  });

  it("cannot consume without a reservation; release does not refund a consumed credit", async () => {
    const s = store();
    s.mint({ paymentRef: "p1", policyId: PID, agentId: AGENT, payer: PAYER });
    await expect(s.consumeReservedCredit(PID, rid(9))).rejects.toThrow();
    await s.reserveCredit(PID, AGENT, PAYER, rid(1));
    await s.consumeReservedCredit(PID, rid(1));
    await s.releaseReservedCredit(PID, rid(1), "late");
    expect(s.available(PID, AGENT, PAYER)).toBe(4);
    s.refundConsumedCredit(PID, rid(1)); // reconciliation: no OKX write happened
    expect(s.available(PID, AGENT, PAYER)).toBe(5);
  });

  it("credits are bound to policyId + agentId + payer (INV-19)", async () => {
    const s = store();
    s.mint({ paymentRef: "p1", policyId: PID, agentId: AGENT, payer: PAYER });
    expect((await s.reserveCredit(PID, AGENT, OTHER, rid(1))).ok).toBe(false);
    expect((await s.reserveCredit(PID, "other-agent", PAYER, rid(2))).ok).toBe(false);
    expect((await s.reserveCredit(PID2, AGENT, PAYER, rid(3))).ok).toBe(false);
    expect((await s.reserveCredit(PID, AGENT, PAYER.toLowerCase() as Hex, rid(4))).ok).toBe(true); // case-insensitive
  });

  it("exhausts after 5 and spills over across payments in FIFO order", async () => {
    const s = store();
    s.mint({ paymentRef: "p1", policyId: PID, agentId: AGENT, payer: PAYER });
    for (let i = 1; i <= 5; i++) expect((await s.reserveCredit(PID, AGENT, PAYER, rid(i))).ok).toBe(true);
    expect((await s.reserveCredit(PID, AGENT, PAYER, rid(6))).ok).toBe(false);
    s.mint({ paymentRef: "p2", policyId: PID, agentId: AGENT, payer: PAYER });
    expect((await s.reserveCredit(PID, AGENT, PAYER, rid(6))).ok).toBe(true);
    expect(s.getCredit("p2")!.remaining).toBe(4);
  });

  it("parallel reservations cannot oversubscribe", async () => {
    const s = store();
    s.mint({ paymentRef: "p1", policyId: PID, agentId: AGENT, payer: PAYER });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => s.reserveCredit(PID, AGENT, PAYER, rid(i + 1))));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(s.getCredit("p1")!.remaining).toBe(0);
  });

  it("schema enforces remaining bounds", () => {
    const db = new DatabaseSync(":memory:");
    const s = new CreditStore(db);
    s.mint({ paymentRef: "p1", policyId: PID, agentId: AGENT, payer: PAYER });
    expect(() => db.prepare("UPDATE service_credits SET remaining = -1").run()).toThrow();
    expect(() => db.prepare("UPDATE service_credits SET remaining = 6").run()).toThrow();
  });
});

describe("purchaseCredits (x402)", () => {
  const delegations = (over: Partial<{ agentId: string; agentAuthAddress: Hex; active: boolean }> = {}): DelegationResolver => ({
    activeDelegation: async (pid) => (pid === PID ? { agentId: AGENT, agentAuthAddress: PAYER, active: true, ...over } : undefined),
  });
  const header = (payer: Hex, nonce: string, network = "avalanche-fuji") =>
    encodePaymentHeader({ x402Version: 1, scheme: "exact", network, payload: { payer, nonce } });

  it("no header → 402 with requirements", async () => {
    const r = await purchaseCredits({ store: store(), provider: new MockSettlement(reqs), delegations: delegations() }, { policyId: PID, agentId: AGENT });
    expect(r).toEqual({ status: 402, paymentRequirements: reqs });
  });

  it("delegated payer → 5 credits; replayed payment → 409", async () => {
    const deps = { store: store(), provider: new MockSettlement(reqs), delegations: delegations() };
    const r = await purchaseCredits(deps, { policyId: PID, agentId: AGENT, paymentHeader: header(PAYER, "n1") });
    expect(r).toMatchObject({ status: 200, credit: { remaining: 5, payer: PAYER } });
    expect(await purchaseCredits(deps, { policyId: PID, agentId: AGENT, paymentHeader: header(PAYER, "n1") })).toEqual({ status: 409, error: "duplicate_payment" });
  });

  it("payer must equal delegated agentAuthAddress", async () => {
    const deps = { store: store(), provider: new MockSettlement(reqs), delegations: delegations() };
    expect(await purchaseCredits(deps, { policyId: PID, agentId: AGENT, paymentHeader: header(OTHER, "n1") })).toEqual({ status: 403, error: "payer_not_delegated" });
    expect(deps.store.available(PID, AGENT, OTHER)).toBe(0);
  });

  it("rejects inactive delegation, wrong agent, unknown policy, wrong network, garbage", async () => {
    const p = new MockSettlement(reqs);
    const h = header(PAYER, "n1");
    expect(await purchaseCredits({ store: store(), provider: p, delegations: delegations({ active: false }) }, { policyId: PID, agentId: AGENT, paymentHeader: h })).toMatchObject({ status: 403, error: "delegation_inactive" });
    expect(await purchaseCredits({ store: store(), provider: p, delegations: delegations() }, { policyId: PID, agentId: "impostor", paymentHeader: h })).toMatchObject({ status: 403, error: "agent_mismatch" });
    expect(await purchaseCredits({ store: store(), provider: p, delegations: delegations() }, { policyId: PID2, agentId: AGENT, paymentHeader: h })).toMatchObject({ status: 403, error: "unknown_policy" });
    expect(await purchaseCredits({ store: store(), provider: p, delegations: delegations() }, { policyId: PID, agentId: AGENT, paymentHeader: header(PAYER, "n", "base") })).toMatchObject({ status: 402, error: "wrong_network" });
    expect(await purchaseCredits({ store: store(), provider: p, delegations: delegations() }, { policyId: PID, agentId: AGENT, paymentHeader: "!!" })).toMatchObject({ status: 402, error: "malformed_payment" });
  });

  it("ineligible payer is never settled (not charged)", async () => {
    let settled = 0;
    const p = new MockSettlement(reqs);
    const spy = Object.assign(Object.create(p), { settle: async (x: never) => { settled++; return p.settle(x); } });
    await purchaseCredits({ store: store(), provider: spy, delegations: delegations() }, { policyId: PID, agentId: AGENT, paymentHeader: header(OTHER, "n1") });
    expect(settled).toBe(0);
  });
});

describe("x402 exact payment (EIP-3009)", () => {
  it("signs a TransferWithAuthorization the token domain will accept", async () => {
    const { verifyTypedData } = await import("viem");
    const { privateKeyToAccount } = await import("viem/accounts");
    const { createExactPayment, fujiUsdcRequirements, FUJI_USDC } = await import("../src/index.js");
    const acct = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const r = fujiUsdcRequirements({ payTo: "0x000000000000000000000000000000000000dEaD", maxAmountRequired: "100000", resource: "/v1/credits" });
    const p = await createExactPayment(acct, r, { now: 1_760_000_000 });
    const { signature, authorization: a } = p.payload as { signature: Hex; authorization: Record<string, string> };
    expect(p).toMatchObject({ x402Version: 1, scheme: "exact", network: "avalanche-fuji" });
    expect(a).toMatchObject({ from: acct.address, value: "100000", validAfter: "1759999940", validBefore: "1760000120" });
    expect(await verifyTypedData({
      address: acct.address, signature,
      domain: { name: "USD Coin", version: "2", chainId: 43113, verifyingContract: FUJI_USDC },
      types: { TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
      primaryType: "TransferWithAuthorization",
      message: { ...a, value: BigInt(a.value!), validAfter: BigInt(a.validAfter!), validBefore: BigInt(a.validBefore!) } as never,
    })).toBe(true);
    expect(() => fujiUsdcRequirements({ payTo: "0x000000000000000000000000000000000000dEaD", maxAmountRequired: "0.1", resource: "/" })).toThrow();
  });
});
