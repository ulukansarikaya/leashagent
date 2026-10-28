/**
 * x402 end to end against the real gateway's credit ledger:
 *   no credit → 402 / REJECTED_PAYMENT 004 → pay → 5 credits → ALLOW consumes one → BLOCK and PENDING consume none
 *   → the same payment replayed mints nothing.
 *
 *   X402_MODE=payai X402_AGENT_KEY=0x… npm run e2e:x402   # REAL: PayAI facilitator, Fuji USDC (0.10 USDC per 5 checks).
 *                                                          #   The agent wallet needs Fuji USDC (Circle faucet); no AVAX
 *                                                          #   needed (EIP-3009, the facilitator submits the transfer).
 *   npm run e2e:x402                                        # mock settlement: same flow, no funds move
 */
import { createExactPayment, encodePaymentHeader, type PaymentRequirements } from "@leashagent/payments";
import { privateKeyToAccount, type Hex, type OrderIntent } from "@leashagent/shared";
import { IntentBuilder, LeashClient } from "@leashagent/agent";
import { buildDevGateway } from "./lib/devGateway";

const real = process.env.X402_MODE === "payai";
if (real && !process.env.X402_AGENT_KEY) {
  console.error("X402_MODE=payai needs X402_AGENT_KEY: a Fuji wallet holding at least 0.10 USDC (Circle faucet). Not run.");
  process.exit(2);
}
const g = await buildDevGateway({ credits: "x402", keys: { agent: process.env.X402_AGENT_KEY as Hex | undefined } });
const url = await g.listen();
const acct = privateKeyToAccount(g.agentKey);
const { policyId, agentId } = g.policy.binding;
const client = new LeashClient(url, acct, policyId);
const builder = new IntentBuilder(acct, policyId, agentId);
const credits = () => g.credits!.available(policyId, agentId, acct.address);
const limit = (sz: string): OrderIntent => ({ tool: "spot_place_order", instId: "BTC-USDT", side: "buy", ordType: "limit", sz, px: "60000" });
let failures = 0;
const ok = (c: boolean, label: string, d = "") => { console.log(`${c ? "✓" : "✗"} ${label.padEnd(52)} credits ${credits()}  ${d}`); if (!c) failures++; };
async function pay(header?: string) {
  const r = await fetch(`${url}/v1/credits`, { method: "POST", headers: { "content-type": "application/json", ...(header ? { "x-payment": header } : {}) }, body: JSON.stringify({ policyId, agentId }) });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}

console.log(`x402 E2E — ${real ? "REAL settlement via PayAI on Avalanche Fuji" : "mock settlement (no funds move)"}  agent ${acct.address}\n`);
const r0 = await client.submitIntent(await builder.build(limit("0.0001"), "x", []));
ok(r0.status === "REJECTED_PAYMENT" && r0.reasonCode === 4, "order without credit → REJECTED_PAYMENT 004", r0.status);
const ask = await pay();
const reqs = ask.body.accepts?.[0] as PaymentRequirements;
ok(ask.status === 402 && !!reqs, "POST /v1/credits → 402 + payment requirements", `${reqs?.network} ${reqs?.maxAmountRequired} atomic ${reqs?.asset}`);
const payload = real
  ? await createExactPayment(acct, reqs)
  : { x402Version: 1, scheme: "exact" as const, network: reqs.network, payload: { payer: acct.address, nonce: `0x${crypto.randomUUID().replace(/-/g, "")}` } };
const header = encodePaymentHeader(payload);
const paid = await pay(header);
ok(paid.status === 200 && credits() === 5, "pay → 5 credits", `${paid.status} ${paid.body.credit?.paymentRef ?? paid.body.message ?? ""}`);
const a = await client.submitIntent(await builder.build(limit("0.0001"), "x", []));
ok(/ALLOWED|SUBMITTED|ACKNOWLEDGED|FILLED/.test(a.status) && credits() === 4, "ALLOW consumes exactly one credit", a.status);
const b = await client.submitIntent(await builder.build(limit("5"), "x", []));
ok(b.status === "BLOCKED" && credits() === 4, "BLOCK consumes none", `${b.status} ${b.reasonCode}`);
const p = await client.submitIntent(await builder.build(limit("0.006"), "x", []));
ok(p.status === "PENDING" && credits() === 4, "PENDING consumes none", `${p.status} ${p.reasonCode}`);
const replay = await pay(header);
// Mock: our ledger refuses the reused paymentRef (409). PayAI: the facilitator already rejects the spent EIP-3009
// nonce (402). Either way nothing is minted.
ok((replay.status === 409 || (real && replay.status === 402)) && credits() === 4, "same payment replayed → refused, no new credits",
  `${replay.status} ${replay.body.message ?? replay.body.error ?? ""}`);

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
if (failures) process.exitCode = 1;
g.close();
setTimeout(() => process.exit(), 200);
