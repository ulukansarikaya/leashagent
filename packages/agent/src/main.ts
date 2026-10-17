import { privateKeyToAccount, type Hex } from "@bekci/shared";
import { llmFromEnv } from "@bekci/llm";
import { BekciClient, guardedFetch } from "./bekciClient.js";
import { IntentBuilder } from "./intentBuilder.js";
import { TradingAgent } from "./loop.js";
import { OkxPublicMarketObserver } from "./market.js";
import { LlmReviewer, RuleReviewer } from "./reviewer.js";

// INV-1: refuse to start if any OKX credential leaked into the agent environment.
const leaked = Object.keys(process.env).filter((k) => /^OKX_(READ|TRADE)_/.test(k));
if (leaked.length) {
  console.error(`refusing to start: OKX credentials present in agent env (${leaked.join(", ")})`);
  process.exit(1);
}

const need = (k: string) => process.env[k] ?? (console.error(`missing ${k}`), process.exit(1));
const account = privateKeyToAccount(need("AGENT_AUTH_KEY") as Hex);
// Must point at Person 1's real gateway. No default, so a demo URL is never picked up silently.
const bekciUrl = need("BEKCI_URL");
const okxBase = process.env.OKX_PUBLIC_BASE ?? "https://www.okx.com";
const http = guardedFetch([new URL(bekciUrl).origin, new URL(okxBase).origin]);
globalThis.fetch = http; // every outbound call in this process goes through the allowlist

// The mock gateway is test/demo only: refuse it unless explicitly running a demo.
const health = (await http(`${bekciUrl}/v1/health`).then((r) => r.json()).catch(() => ({}))) as { gateway?: string };
if (health.gateway === "mock" && process.env.AGENT_ALLOW_MOCK !== "1") {
  console.error("BEKCI_URL points at the TEST/DEMO mock gateway; set AGENT_ALLOW_MOCK=1 only for offline demos");
  process.exit(1);
}

const llm = llmFromEnv("AGENT_LLM");
const agent = new TradingAgent(
  {
    instId: process.env.AGENT_INST_ID ?? "BTC-USDT",
    mandate: process.env.AGENT_MANDATE ?? "Trade BTC-USDT spot trend-following with small limit orders.",
    orderSizeBase: process.env.AGENT_ORDER_SZ ?? "0.0001",
    readQueries: [{ source: "news", query: process.env.AGENT_NEWS_QUERY ?? "bitcoin" }],
  },
  new OkxPublicMarketObserver(okxBase),
  llm ? new LlmReviewer(llm) : new RuleReviewer(),
  new IntentBuilder(account, need("BEKCI_POLICY_ID") as Hex, need("AGENT_ID")),
  new BekciClient(bekciUrl, account, need("BEKCI_POLICY_ID") as Hex, http),
);

const intervalSec = Number(process.env.AGENT_INTERVAL_SEC ?? "60");
console.log(`agent ${account.address} → ${bekciUrl} every ${intervalSec}s (reviewer: ${llm ? "llm" : "rules"})`);
for (;;) {
  try {
    const r = await agent.tick();
    console.log(JSON.stringify({ signal: r.signal.direction, reads: r.reads.length, review: r.review?.proceed, response: r.response }));
  } catch (e) {
    console.error("tick failed:", (e as Error).message);
  }
  if (process.env.AGENT_ONCE) break;
  await new Promise((r) => setTimeout(r, intervalSec * 1000));
}
