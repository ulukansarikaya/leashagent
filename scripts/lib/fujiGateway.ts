/**
 * Leash Agent gateway wired to the REAL Avalanche Fuji deployment (Person 3 parts real, OKX still fake):
 *   - PolicyRegistry (Fuji) + policy document: Person 1's PolicyLoader over Person 3's PolicyChainClient/fetchPolicyDocument
 *   - L6 pre-send recheck: createChainPolicyStateProvider over the same Fuji registry
 *   - Evidence: ChainOutbox worker → DecisionLog on Fuji (LOGGER key)
 *   - x402: CreditStore + POST /v1/credits (MockSettlement by default; X402_MODE=payai uses the PayAI facilitator)
 * Mocked (TEST/DEMO ONLY): OKX account/market data and the exchange (FakeAtkClient — nothing reaches OKX).
 * Needs the local .env (CHAIN_RPC_URL, LOGGER_PRIVATE_KEY, DEPLOYER_ADDRESS); never prints keys.
 */
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createPublicClient, createWalletClient, http, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import type { Hex, ReadRecord } from "@leashagent/shared";
import {
  ChainOutbox, FUJI_DEPLOYMENT, createChainPolicyStateProvider, createDecisionLogPort, createPolicyChainClient, fetchPolicyDocument,
} from "@leashagent/chain";
import {
  CreditStore, FacilitatorSettlement, MockSettlement, PAYAI_FACILITATOR_URL, fujiUsdcRequirements, purchaseCredits,
} from "@leashagent/payments";
import { BTC_USDT, FakeAtkClient, MockMarketData, MockOrderOwnership, MockRiskProvider } from "@leashagent/mocks";
import { DefaultExecutor, openExecutorDb } from "@leashagent/executor";
import { createGateway, createGatewayServer, delegationResolver } from "@leashagent/gateway";
import { HeuristicAuditor } from "@leashagent/auditor";
import { DefaultIngestService, FixtureSource, HeuristicReaderModel } from "@leashagent/ingest";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing ${k} (run with --env-file=.env)`);
  return v;
};

export async function buildFujiGateway(opts: { price?: string; dataDir?: string } = {}) {
  const dep = FUJI_DEPLOYMENT;
  if (!dep.demoPolicy) throw new Error("no demo policy in deployments/fuji.json (scripts/fuji-demo-policy.ts)");
  const policyId = dep.demoPolicy.policyId;
  const price = opts.price ?? "60000";
  const clock = () => Math.floor(Date.now() / 1000);

  const transport = http(process.env.CHAIN_RPC_URL ?? dep.rpcUrl);
  const publicClient = createPublicClient({ chain: avalancheFuji, transport, pollingInterval: 1000 }) as PublicClient;
  const chain = createPolicyChainClient(publicClient, dep.contracts.PolicyRegistry.address);
  const record = await chain.getPolicy(policyId);

  // Gateway authorization key: ephemeral unless GUARD_SIGNING_KEY is set; the executor trusts exactly this address.
  const guard = privateKeyToAccount((process.env.GUARD_SIGNING_KEY as Hex | undefined) ?? generatePrivateKey());
  const logger = privateKeyToAccount(need("LOGGER_PRIVATE_KEY") as Hex);

  const market = new MockMarketData(clock, [BTC_USDT]);
  market.quotes.set("BTC-USDT", { bid: price, ask: price, last: price });

  const dataDir = opts.dataDir ?? "data";
  mkdirSync(dataDir, { recursive: true });
  const reqs = fujiUsdcRequirements({
    payTo: (process.env.X402_PAY_TO ?? need("DEPLOYER_ADDRESS")) as Hex,
    maxAmountRequired: process.env.X402_PRICE_ATOMIC ?? "100000", // 0.10 USDC for 5 checks
    resource: "/v1/credits",
  });
  const credits = new CreditStore(new DatabaseSync(`${dataDir}/fuji-credits.db`), { challenge: () => reqs });
  const settlement = process.env.X402_MODE === "payai" ? new FacilitatorSettlement(PAYAI_FACILITATOR_URL, reqs) : new MockSettlement(reqs);

  const executor = new DefaultExecutor({
    db: openExecutorDb(":memory:"),
    atk: new FakeAtkClient(),
    policyState: createChainPolicyStateProvider(chain),
    config: {
      guardSignerAddress: guard.address,
      guardInstanceId: "fuji-guard",
      accountRef: record.accountRef,
      allowedTools: ["spot_place_order", "spot_cancel_order"],
      clockSkewSec: 60,
    },
    clock,
  });

  const app = createGateway(
    { guardInstanceId: "fuji-guard", policyCacheTtlSec: 30, auditorTimeoutMs: 2000, unknownGraceSec: 30 },
    {
      signer: guard,
      chain,
      docs: { fetch: (uri: string) => fetchPolicyDocument(uri) },
      risk: new MockRiskProvider(clock, { baseBalances: { BTC: "1", USDT: "100000" } }),
      market,
      ownership: new MockOrderOwnership(clock),
      payment: credits,
      auditor: new HeuristicAuditor(),
      executor,
      executionLookup: executor,
      chainEvidence: (db, onEvent) =>
        new ChainOutbox(db, createDecisionLogPort({
          publicClient, walletClient: createWalletClient({ account: logger, chain: avalancheFuji, transport }),
          account: logger, chain: avalancheFuji, address: dep.contracts.DecisionLog.address,
        }), { onEvent }),
      reconcileExecutor: async () => {
        for (const e of await executor.reconcile()) {
          const row = app.store.findRequest(e.requestId);
          if (row) app.executionEvents.onEvent(e, { policyId: row.policyId });
        }
      },
      clock,
    },
  );

  app.ingest = new DefaultIngestService({
    source: new FixtureSource([
      { source: "news", url: "https://news.example/btc", body: "Bitcoin trades sideways as ETF inflows stay steady; analysts expect low volatility." },
    ]),
    reader: new HeuristicReaderModel(),
    recorder: {
      record: async (r: ReadRecord) => app.store.saveRead(r),
      get: async (id: string) => app.store.getReads(policyId, [id])[0],
    },
    agentAddressFor: async (pid: Hex) => app.store.getPolicy(pid)?.agentAuthAddress,
  });

  const reg = await app.registerPolicy(policyId);
  if (!reg.ok) throw new Error(`Fuji policy failed to verify: ${reg.reason}`);

  const server = createGatewayServer(app, {
    credits: (q) => purchaseCredits({ store: credits, provider: settlement, delegations: delegationResolver(app.loader, clock) }, q),
  });

  return { app, server, credits, executor, chain, publicClient, policyId, record, price, settlementMode: process.env.X402_MODE === "payai" ? "payai" : "mock" };
}
