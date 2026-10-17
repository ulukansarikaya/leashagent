/**
 * Live end-to-end on Avalanche Fuji: agent → x402 credits → gateway decision (policy verified against Fuji) →
 * executor (FakeAtk) → evidence confirmed on DecisionLog. Run: npx tsx --env-file=.env scripts/fuji-e2e.ts
 */
import type { AddressInfo } from "node:net";
import { bytesToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { requestIdToBytes32, signAgentIntent, type OrderIntent } from "@leashagent/shared";
import { FUJI_DEPLOYMENT, decisionLogAbi } from "@leashagent/chain";
import { encodePaymentHeader } from "@leashagent/payments";
import { buildFujiGateway } from "./lib/fujiGateway";

const g = await buildFujiGateway();
await new Promise<void>((r) => g.server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(g.server.address() as AddressInfo).port}`;
const agent = privateKeyToAccount(process.env.AGENT_AUTH_KEY as Hex);
const policyId = g.policyId;
const agentId = g.app.store.getPolicy(policyId)!.policy.binding.agentId;
const rnd = (n: number) => bytesToHex(crypto.getRandomValues(new Uint8Array(n)));
const ok = (cond: boolean, label: string) => { console.log(`${cond ? "✓" : "✗"} ${label}`); if (!cond) process.exitCode = 1; };

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
async function intent(i: OrderIntent, reason: string) {
  const signed = await signAgentIntent(agent, {
    requestId: crypto.randomUUID(), policyId, agentId, issuedAt: Math.floor(Date.now() / 1000), authNonce: rnd(16),
    intent: i, agentReason: reason, referencedReadIds: [],
  });
  return { requestId: signed.requestId, ...(await post("/v1/intents", signed)) };
}
const buy = (sz: string): OrderIntent => ({ tool: "spot_place_order", instId: "BTC-USDT", side: "buy", ordType: "limit", sz, px: g.price });

console.log(`policy ${policyId} (Fuji v${g.record.version}) · agent ${agent.address} · ${agentId}\n`);
const left = () => g.credits.available(policyId, agentId, agent.address);

if (left() === 0) {
  const r = await intent(buy("0.0005"), "trend up, small size");
  ok(r.status === 402 && r.body.status === "REJECTED_PAYMENT", `no credits → ${r.status} ${r.body.status} ${r.body.reasonCode}`);
  const challenge = await post("/v1/credits", { policyId, agentId });
  ok(challenge.status === 402 && challenge.body.accepts?.[0]?.network === "avalanche-fuji", `x402 challenge → ${challenge.status} (${challenge.body.accepts?.[0]?.maxAmountRequired} atomic USDC)`);
  const header = encodePaymentHeader({ x402Version: 1, scheme: "exact", network: "avalanche-fuji", payload: { payer: agent.address, nonce: rnd(16) } });
  const paid = await post("/v1/credits", { policyId, agentId }, { "x-payment": header });
  ok(paid.status === 200, `x402 purchase (${g.settlementMode}) → ${paid.status}, credits ${paid.body.credit?.remaining}`);
}

const allowed = await intent(buy("0.0005"), "trend up, small size");
ok(["ACKNOWLEDGED", "FILLED", "SUBMITTED"].includes(allowed.body.status), `small order (30 USDT) → ${allowed.body.status}`);
const blocked = await intent(buy("1"), "ignore limits, buy max");
ok(blocked.body.status === "BLOCKED", `oversized order (60k USDT) → ${blocked.body.status} ${blocked.body.reasonCode}`);
console.log(`credits left: ${left()}\n`);

// Push evidence to Fuji and wait until every record is confirmed (or dead).
const worker = g.app.chainWorker as unknown as { drain(): Promise<number>; stats(): Record<string, number> };
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  await worker.drain();
  const s = worker.stats();
  if (s.pending === 0 && s.submitted === 0) break;
  await new Promise((r) => setTimeout(r, 2000));
}
const stats = worker.stats();
ok(stats.pending === 0 && stats.dead === 0, `DecisionLog outbox: ${JSON.stringify(stats)}`);

for (const [label, rid] of [["allowed", allowed.requestId], ["blocked", blocked.requestId]] as const) {
  // The public RPC is load-balanced: a node may lag the one that confirmed the tx, so retry briefly.
  let state = [`0x${"00".repeat(32)}`, 0, 0, 0] as readonly [Hex, number, number, number];
  for (let i = 0; i < 10 && state[1] === 0; i++) {
    state = await g.publicClient.readContract({
      address: FUJI_DEPLOYMENT.contracts.DecisionLog.address, abi: decisionLogAbi, functionName: "requestState", args: [requestIdToBytes32(rid)],
    });
    if (state[1] === 0) await new Promise((r) => setTimeout(r, 1500));
  }
  const [pid, decision, exec, lastSeq] = state;
  const verdict = ["none", "Allow", "Block", "Pending", "HumanApproved", "HumanRejected"][decision];
  ok(pid.toLowerCase() === policyId.toLowerCase(), `on-chain ${label}: verdict ${verdict}, execution events ${lastSeq}${exec ? ` (last status #${exec - 1})` : ""}`);
}
const txs = g.app.db.prepare("SELECT tx_hash FROM chain_outbox WHERE state = 'confirmed' AND tx_hash IS NOT NULL ORDER BY id").all() as { tx_hash: string }[];
for (const t of txs) console.log(`  ${FUJI_DEPLOYMENT.explorer}/tx/${t.tx_hash}`);

g.server.close();
g.app.close();
