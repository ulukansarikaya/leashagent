// TEST/DEMO ONLY. Starts the mock gateway for offline demos. Never point a production agent here.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { privateKeyToAccount, type Hex } from "@bekci/shared";
import { auditorFromEnv } from "@bekci/auditor";
import { FixtureSource, HeuristicReaderModel, LlmReaderModel } from "@bekci/ingest";
import { llmFromEnv } from "@bekci/llm";
import { createGateway } from "./index.js";
import { DEMO_ARTICLES, DEMO_PRICE, demoPolicy } from "./fixtures.js";

if (process.env.NODE_ENV === "production") {
  console.error("mock gateway refuses to run with NODE_ENV=production");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
// Well-known local test keys (Hardhat accounts #2/#1) — never used outside demos.
const agentKey = (process.env.AGENT_AUTH_KEY ?? "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a") as Hex;
const owner = (process.env.OWNER_ADDRESS ?? "0x70997970C51812dc3A010C7d01b50e0d17dc79C8") as Hex;
const reader = llmFromEnv("READER_MODEL");
const policy = demoPolicy(privateKeyToAccount(agentKey).address, owner);

const gw = createGateway({
  policy,
  auditor: auditorFromEnv(llmFromEnv("AUDITOR")),
  source: new FixtureSource(DEMO_ARTICLES),
  reader: reader ? new LlmReaderModel(reader) : new HeuristicReaderModel(),
  price: () => process.env.DEMO_PRICE ?? DEMO_PRICE,
  dashboardDir: join(here, "../../dashboard/public"),
  insecureOwner: process.env.INSECURE_OWNER === "1",
});
const port = Number(process.env.PORT ?? 8787);
gw.server.listen(port, "127.0.0.1", () => {
  console.log("*** MOCK GATEWAY — TEST/DEMO ONLY, execution is simulated, no OKX ***");
  console.log(`policyId ${policy.binding.policyId}  agentId ${policy.binding.agentId}`);
  console.log(`dashboard: http://127.0.0.1:${port}/?policyId=${policy.binding.policyId}`);
});
