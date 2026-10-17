// Live wire-format check against the PayAI facilitator on Avalanche Fuji. Moves NO funds:
// signs a payment from a fresh empty wallet and calls /verify only (expected: rejected for insufficient funds).
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { FacilitatorSettlement, PAYAI_FACILITATOR_URL, createExactPayment, fujiUsdcRequirements } from "@bekci/payments";

const payer = privateKeyToAccount(generatePrivateKey());
const reqs = fujiUsdcRequirements({ payTo: "0x000000000000000000000000000000000000dEaD", maxAmountRequired: "10000", resource: "https://bekci.example/v1/credits" });
const payment = await createExactPayment(payer, reqs);
const raw = await fetch(`${PAYAI_FACILITATOR_URL}/verify`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ x402Version: 1, paymentPayload: payment, paymentRequirements: reqs }),
});
console.log("HTTP", raw.status, await raw.text());
console.log("adapter:", await new FacilitatorSettlement(PAYAI_FACILITATOR_URL, reqs).verify(payment));
