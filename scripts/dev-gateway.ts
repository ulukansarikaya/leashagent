/**
 * Local Leash Agent gateway for demos and for running the acceptance suite against the real gateway/executor
 * code (§26.1 core checkpoint). See scripts/lib/devGateway.ts for what is real and what is mocked.
 *
 *   npm run gateway:dev                 # prints the env block for `npm run test:acceptance`
 *   DEV_MARKET=okx  …                   # live public OKX prices (keyless) instead of a fixed quote
 *   DEV_CREDITS=x402 …                  # real credit ledger + POST /v1/credits instead of unlimited credits
 *   TEE_MODE=simulated / AUDITOR_PROVIDER=jev|llm|heuristic — see docs/TEE.md, scripts/lib/auditor.ts
 */
import type { Hex } from "@leashagent/shared";
import { buildDevGateway } from "./lib/devGateway";

const PRICE = process.env.DEV_PRICE ?? "60000";
const g = await buildDevGateway({
  port: Number(process.env.PORT ?? 8787),
  price: PRICE,
  market: process.env.DEV_MARKET === "okx" ? "okx" : "mock",
  credits: process.env.DEV_CREDITS === "x402" ? "x402" : "unlimited",
  keys: { agent: process.env.DEV_AGENT_KEY as Hex | undefined, owner: process.env.DEV_OWNER_KEY as Hex | undefined, guard: process.env.DEV_GUARD_KEY as Hex | undefined },
});
const url = await g.listen();
const { policyId, agentId } = g.policy.binding;
console.log(`Leash Agent dev gateway on ${url}  (FakeAtk — nothing reaches OKX)\n`);
console.log("# acceptance suite against this gateway:");
console.log(`export LEASH_GATEWAY_URL=${url}`);
console.log(`export LEASH_AGENT_KEY=${g.agentKey}`);
console.log(`export LEASH_OWNER_KEY=${g.ownerKey}`);
console.log(`export LEASH_POLICY_ID=${policyId}`);
console.log(`export LEASH_AGENT_ID='${agentId}'`);
console.log(`export LEASH_TEST_PX=${PRICE}`);
console.log(`export LEASH_TEST_SMALL_SZ=0.0001`);
console.log(`export LEASH_TEST_ESCALATE_SZ=0.006`);
console.log(`export LEASH_TEST_OVERLIMIT_SZ=5`);
console.log(`\n# dashboard: ${url}/?policyId=${policyId}`);
