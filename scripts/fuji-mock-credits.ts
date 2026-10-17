/**
 * Buy x402 service credits on the running gateway with the MOCK settlement (no funds move — the Fuji
 * gateway uses MockSettlement unless X402_MODE=payai). Each payment = 5 risk-increasing intent checks.
 *   npx tsx --env-file=.env scripts/fuji-mock-credits.ts [payments=3]
 * Needs AGENT_AUTH_ADDRESS and LEASH_POLICY_ID / AGENT_ID (or the defaults of the separate deployment).
 */
import { encodePaymentHeader } from "@leashagent/payments";
import { activeDeployment } from "./lib/deployment";

if (process.env.X402_MODE === "payai") {
  console.error("X402_MODE=payai: this would pay real USDC — refusing. Use the agent's x402 flow instead.");
  process.exit(1);
}
const dep = activeDeployment();
const url = process.env.LEASH_GATEWAY_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`;
const policyId = process.env.LEASH_POLICY_ID ?? dep.demoPolicy?.policyId;
const payer = process.env.AGENT_AUTH_ADDRESS ?? dep.demoPolicy?.agentAuthAddress;
const agentId = process.env.AGENT_ID ?? (dep.identities.tradingAgent && `eip155:43113:${dep.erc8004.identityRegistry}:${dep.identities.tradingAgent.agentRegistryId}`);
if (!policyId || !payer || !agentId) throw new Error("need LEASH_POLICY_ID, AGENT_AUTH_ADDRESS, AGENT_ID");

const n = Number(process.argv[2] ?? 3);
for (let i = 0; i < n; i++) {
  const header = encodePaymentHeader({
    x402Version: 1, scheme: "exact", network: "avalanche-fuji", payload: { payer, nonce: crypto.randomUUID() },
  } as never);
  const r = await fetch(`${url}/v1/credits`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-payment": header },
    body: JSON.stringify({ policyId, agentId }),
  });
  const b = (await r.json()) as { credit?: { remaining: number }; error?: string; message?: string };
  console.log(r.status, b.credit ? `credits now ${b.credit.remaining} on this payment` : JSON.stringify(b).slice(0, 200));
}
