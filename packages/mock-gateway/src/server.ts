import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { privateKeyToAccount, type Hex } from "@bekci/shared";
import { auditorFromEnv } from "@bekci/auditor";
import { FixtureSource, HeuristicReaderModel, LlmReaderModel } from "@bekci/ingest";
import { llmFromEnv } from "@bekci/llm";
import { createGateway } from "./index.js";
import { DEMO_ARTICLES, DEMO_PRICE, demoPolicy } from "./fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const agentKey = (process.env.AGENT_AUTH_KEY ?? "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d") as Hex;
const owner = (process.env.OWNER_ADDRESS ?? "0x70997970C51812dc3A010C7d01b50e0d17dc79C8") as Hex;
const reader = llmFromEnv("READER_MODEL");
const auditorLlm = llmFromEnv("AUDITOR");

const gw = createGateway({
  policy: demoPolicy(privateKeyToAccount(agentKey).address, owner),
  auditor: auditorFromEnv(auditorLlm),
  source: new FixtureSource(DEMO_ARTICLES),
  reader: reader ? new LlmReaderModel(reader) : new HeuristicReaderModel(),
  price: () => process.env.DEMO_PRICE ?? DEMO_PRICE,
  dashboardDir: join(here, "../../dashboard/public"),
  insecureOwner: process.env.INSECURE_OWNER === "1",
});
const port = Number(process.env.PORT ?? 8787);
gw.server.listen(port, "127.0.0.1", () => console.log(`mock Bekçi gateway on http://127.0.0.1:${port} (dashboard at /)`));
