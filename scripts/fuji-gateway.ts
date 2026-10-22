/**
 * Serve the Leash Agent gateway against the real Avalanche Fuji deployment (see scripts/lib/fujiGateway.ts).
 *   npx tsx --env-file=.env scripts/fuji-gateway.ts        # PORT=8787 by default
 * Agent side: sign intents with the delegated AGENT_AUTH_KEY (or rotate delegation with scripts/fuji-demo-policy.ts).
 */
import { activeDeployment } from "./lib/deployment";
import { buildFujiGateway } from "./lib/fujiGateway";

const PORT = Number(process.env.PORT ?? 8787);
// 127.0.0.1 by default; a container sets HOST=0.0.0.0 and sits behind a reverse proxy (docs/DEPLOY.md).
const HOST = process.env.HOST ?? "127.0.0.1";
const g = await buildFujiGateway({ price: process.env.DEV_PRICE, dataDir: process.env.LEASH_DATA_DIR });
const dep = activeDeployment();
g.app.startJobs(5_000, 2_000);
g.server.listen(PORT, HOST, () => {
  const url = process.env.PUBLIC_URL ?? `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`;
  console.log(`Leash Agent gateway on ${url} — policy + evidence on Avalanche Fuji, OKX ${g.okxMode === "atk" ? `REAL via ATK (${process.env.OKX_PROFILE ?? "demo"})` : "faked (FakeAtk)"}`);
  console.log(`policy   ${g.policyId} (v${g.record.version}, agent ${g.record.agentAuthAddress})`);
  console.log(`evidence ${dep.explorer}/address/${dep.contracts.DecisionLog.address}`);
  console.log(`x402     POST ${url}/v1/credits  (${g.settlementMode} settlement)`);
  console.log(`dashboard ${url}/?policyId=${g.policyId}`);
});
const shutdown = () => { g.server.close(); g.app.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
