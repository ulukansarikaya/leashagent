import { getAddress } from "viem";
import type { Hex, ServiceCredit } from "@bekci/shared";
import type { CreditStore } from "./creditStore.js";
import { decodePaymentHeader, type PaymentRequirements, type SettlementProvider } from "./x402.js";

/** Resolves the *verified* active delegation for a policy (gateway backs this with PolicyRegistry + verified policy JSON). */
export interface DelegationResolver {
  activeDelegation(policyId: Hex): Promise<{ agentId: string; agentAuthAddress: Hex; active: boolean } | undefined>;
}

export type PurchaseResult =
  | { status: 200; credit: ServiceCredit }
  | { status: 402; paymentRequirements: PaymentRequirements; error?: string }
  | { status: 403; error: "payer_not_delegated" | "agent_mismatch" | "delegation_inactive" | "unknown_policy" }
  | { status: 409; error: "duplicate_payment" };

/**
 * x402 purchase flow for `POST /v1/credits` (framework-agnostic; the gateway mounts it).
 * Order matters: verify → check payer is the delegated agent key → settle → mint.
 * Payer is checked BEFORE settle so an ineligible payer is never charged.
 * Payment grants credits only — never execution authority (INV-17).
 */
export async function purchaseCredits(
  deps: { store: CreditStore; provider: SettlementProvider; delegations: DelegationResolver },
  req: { policyId: Hex; agentId: string; paymentHeader?: string },
): Promise<PurchaseResult> {
  const requirements = deps.provider.requirements();
  if (!req.paymentHeader) return { status: 402, paymentRequirements: requirements };

  let payload;
  try {
    payload = decodePaymentHeader(req.paymentHeader);
  } catch {
    return { status: 402, paymentRequirements: requirements, error: "malformed_payment" };
  }
  if (payload.network !== requirements.network) {
    return { status: 402, paymentRequirements: requirements, error: "wrong_network" };
  }

  const d = await deps.delegations.activeDelegation(req.policyId);
  if (!d) return { status: 403, error: "unknown_policy" };
  if (!d.active) return { status: 403, error: "delegation_inactive" };
  if (d.agentId !== req.agentId) return { status: 403, error: "agent_mismatch" };

  const v = await deps.provider.verify(payload);
  if (!v.isValid) return { status: 402, paymentRequirements: requirements, error: v.invalidReason };
  if (getAddress(v.payer) !== getAddress(d.agentAuthAddress)) return { status: 403, error: "payer_not_delegated" };

  const s = await deps.provider.settle(payload);
  if (!s.success) return { status: 402, paymentRequirements: requirements, error: s.errorReason };
  if (getAddress(s.payer) !== getAddress(d.agentAuthAddress)) return { status: 403, error: "payer_not_delegated" };

  const m = deps.store.mint({ paymentRef: s.paymentRef, policyId: req.policyId, agentId: req.agentId, payer: s.payer });
  if (!m.ok) return { status: 409, error: "duplicate_payment" };
  return { status: 200, credit: m.credit };
}
