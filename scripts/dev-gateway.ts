/**
 * Local Leash Agent gateway for demos and for running Person 2's acceptance suite against Person 1's
 * real gateway/executor code (§26.1 core checkpoint).
 *
 *   npm run gateway:dev                # prints the env block for `npm run test:acceptance`
 *
 * Real: L3/L4/L5/L7 gateway, L6 executor (own DB), HeuristicAuditor (@leashagent/auditor),
 *       DefaultIngestService + HeuristicReaderModel (@leashagent/ingest).
 *       Chain evidence: Person 3's ChainOutbox worker (@leashagent/chain) on the gateway's chain_outbox.
 * Mocked (TEST/DEMO ONLY): PolicyRegistry chain + policy document, OKX account/market data,
 *       x402 credits, and the exchange itself (FakeAtkClient — nothing reaches OKX).
 *       DecisionLog writes go to an in-memory port unless DEV_REAL_CHAIN=1 (then Fuji, with
 *       CHAIN_RPC_URL / DECISION_LOG_ADDRESS / LOGGER_PRIVATE_KEY — real transactions).
 */
import { randomBytes } from "node:crypto";
import { createPublicClient, createWalletClient, http } from "viem";
import { avalancheFuji } from "viem/chains";
import { ChainOutbox, createDecisionLogPort, type DecisionLogPort } from "@leashagent/chain";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex, ReadRecord } from "@leashagent/shared";
import {
  FakeAtkClient,
  MockMarketData,
  MockOrderOwnership,
  MockPayment,
  MockPolicyChain,
  MockRiskProvider,
  BTC_USDT,
  mockPolicy,
} from "@leashagent/mocks";
import { DefaultExecutor, openExecutorDb } from "@leashagent/executor";
import { createGateway, createGatewayServer } from "@leashagent/gateway";
import { HeuristicAuditor } from "@leashagent/auditor";
import { DefaultIngestService, FixtureSource, HeuristicReaderModel } from "@leashagent/ingest";

const PORT = Number(process.env.PORT ?? 8787);
const PRICE = process.env.DEV_PRICE ?? "60000";
const key = (name: string) => (process.env[name] as Hex | undefined) ?? generatePrivateKey();

const agentKey = key("DEV_AGENT_KEY");
const ownerKey = key("DEV_OWNER_KEY");
const guard = privateKeyToAccount(key("DEV_GUARD_KEY"));
const agent = privateKeyToAccount(agentKey);
const owner = privateKeyToAccount(ownerKey);
const clock = () => Math.floor(Date.now() / 1000);

const policy = mockPolicy(
  agent.address,
  {
    limits: {
      maxOrderNotionalUsdt: "500",
      maxOpenNotionalUsdt: "1000000", // acceptance runs many small orders back to back
      maxOrdersPerMinute: 1000,
      maxDailyLossUsdt: "100",
      maxPriceDeviationBps: 200,
      marketSlippageBufferBps: 50,
      escalateAboveUsdt: "300",
    },
    auditor: { mode: "enabled", maxInjectionSuspicion: "0.5", minConsistency: "0.6", minVerdictConfidence: "0.5", onUnavailable: "pending" },
  },
  clock(),
  owner.address,
);

const chain = new MockPolicyChain();
chain.publish(policy);
const market = new MockMarketData(clock, [BTC_USDT]);
market.quotes.set("BTC-USDT", { bid: PRICE, ask: PRICE, last: PRICE });
const atk = new FakeAtkClient();

const executor = new DefaultExecutor({
  db: openExecutorDb(process.env.DEV_EXECUTOR_DB ?? ":memory:"),
  atk,
  policyState: chain,
  config: {
    guardSignerAddress: guard.address,
    guardInstanceId: "dev-guard",
    accountRef: policy.binding.accountRef,
    allowedTools: ["spot_place_order", "spot_cancel_order"],
    clockSkewSec: 60,
  },
  clock,
});

function decisionLogPort(): DecisionLogPort {
  if (process.env.DEV_REAL_CHAIN === "1") {
    const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`DEV_REAL_CHAIN=1 needs ${k}`); return v; };
    const transport = http(need("CHAIN_RPC_URL"));
    const account = privateKeyToAccount(need("LOGGER_PRIVATE_KEY") as Hex);
    return createDecisionLogPort({
      publicClient: createPublicClient({ chain: avalancheFuji, transport }) as never,
      walletClient: createWalletClient({ chain: avalancheFuji, transport, account }),
      account,
      chain: avalancheFuji,
      address: need("DECISION_LOG_ADDRESS") as Hex,
    });
  }
  // In-memory DecisionLog: every record "confirms" with a random tx hash.
  return {
    isApplied: async () => false,
    simulate: async () => {},
    send: async () => `0x${randomBytes(32).toString("hex")}` as Hex,
    waitForReceipt: async () => "success",
  } as DecisionLogPort;
}

const app = createGateway(
  { dbPath: process.env.DEV_GATEWAY_DB, guardInstanceId: "dev-guard", policyCacheTtlSec: 30, auditorTimeoutMs: 2000, unknownGraceSec: 30 },
  {
    signer: guard,
    chain,
    docs: chain,
    risk: new MockRiskProvider(clock, { baseBalances: { BTC: "1", USDT: "100000" } }),
    market,
    ownership: new MockOrderOwnership(clock),
    payment: new MockPayment(100_000),
    auditor: new HeuristicAuditor(),
    executor,
    executionLookup: executor,
    chainEvidence: (db, onEvent) => new ChainOutbox(db, decisionLogPort(), { onEvent }),
    reconcileExecutor: async () => {
      for (const e of await executor.reconcile()) {
        const row = app.store.findRequest(e.requestId);
        if (row) app.executionEvents.onEvent(e, { policyId: row.policyId });
      }
    },
    clock,
  },
);

// L1 ingest (Person 2) recording into the gateway store, so the auditor sees the reads.
app.ingest = new DefaultIngestService({
  source: new FixtureSource([
    { source: "news", url: "https://news.example/btc", body: "Bitcoin trades sideways as ETF inflows stay steady; analysts expect low volatility." },
  ]),
  reader: new HeuristicReaderModel(),
  recorder: {
    record: async (r: ReadRecord) => app.store.saveRead(r),
    get: async (id: string) => app.store.getReads(policy.binding.policyId, [id])[0],
  },
  agentAddressFor: async (policyId: Hex) => app.store.getPolicy(policyId)?.agentAuthAddress,
});

const reg = await app.registerPolicy(policy.binding.policyId);
if (!reg.ok) throw new Error(`policy failed to verify: ${reg.reason}`);
app.startJobs(5_000, 500);

const server = createGatewayServer(app);
server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`Leash Agent dev gateway on ${url}  (FakeAtk — nothing reaches OKX)\n`);
  console.log("# acceptance suite against this gateway:");
  console.log(`export LEASH_GATEWAY_URL=${url}`);
  console.log(`export LEASH_AGENT_KEY=${agentKey}`);
  console.log(`export LEASH_OWNER_KEY=${ownerKey}`);
  console.log(`export LEASH_POLICY_ID=${policy.binding.policyId}`);
  console.log(`export LEASH_AGENT_ID='${policy.binding.agentId}'`);
  console.log(`export LEASH_TEST_PX=${PRICE}`);
  console.log(`export LEASH_TEST_SMALL_SZ=0.0001`);
  console.log(`export LEASH_TEST_ESCALATE_SZ=0.006`);
  console.log(`export LEASH_TEST_OVERLIMIT_SZ=5`);
  console.log(`\n# dashboard: ${url}/?policyId=${policy.binding.policyId} (if served)`);
});

const shutdown = () => {
  server.close();
  app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
