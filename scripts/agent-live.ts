/**
 * One command, the real path end to end:
 *   agent (own process, NO exchange credentials) → L1 ingest → signal → LLM/rule reviewer → EIP-712 intent
 *   → real gateway (L3–L5, L7) → real executor (L6) → OKX write counter (FakeAtk, nothing reaches OKX).
 *
 *   npm run agent:live                       # live OKX public prices, x402 mock credits, rule reviewer
 *   AGENT_LLM_API_KEY=… npm run agent:live   # Claude as the agent's reviewer
 *   AGENT_SIGNAL_MIN_SPREAD=0.0002 …         # make the SMA signal fire more often for a demo
 *
 * The agent child process gets an allow-listed environment (packages/agent/src/env.ts): even if this shell holds
 * OKX keys, the agent never sees them (INV-1). Open the printed dashboard URL to watch decisions live.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { agentProcessEnv } from "@leashagent/agent";
import { buildDevGateway } from "./lib/devGateway";

const g = await buildDevGateway({ port: Number(process.env.PORT ?? 8787), market: "okx", credits: "x402" });
const url = await g.listen();
const { policyId, agentId } = g.policy.binding;
console.log(`gateway   ${url}  (real gateway + executor; exchange is FakeAtk, nothing reaches OKX)`);
console.log(`dashboard ${url}/?policyId=${policyId}`);
console.log(`agent     ${g.agent.address} — own process, allow-listed env, no exchange key\n`);

const env = agentProcessEnv({
  ...process.env,
  LEASH_URL: url,
  LEASH_POLICY_ID: policyId,
  AGENT_ID: agentId,
  AGENT_AUTH_KEY: g.agentKey,
  AGENT_X402: process.env.AGENT_X402 ?? "mock",
  AGENT_INTERVAL_SEC: process.env.AGENT_INTERVAL_SEC ?? "20",
});
const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../packages/agent/src/main.ts", import.meta.url))], {
  env, stdio: ["ignore", "pipe", "inherit"],
});
child.stdout.on("data", (d: Buffer) => {
  for (const line of d.toString().split("\n").filter(Boolean)) console.log(`[agent] ${line}   (OKX writes so far: ${g.atk.writes.length})`);
});
const stop = () => { child.kill(); g.close(); process.exit(0); };
child.on("exit", (code) => { console.log(`agent exited (${code})`); g.close(); process.exit(code ?? 0); });
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
