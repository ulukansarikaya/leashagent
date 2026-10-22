/**
 * Leash Agent gateway wired to the REAL Avalanche Fuji deployment (Person 3 parts real, OKX still fake):
 *   - PolicyRegistry (Fuji) + policy document: Person 1's PolicyLoader over Person 3's PolicyChainClient/fetchPolicyDocument
 *   - L6 pre-send recheck: createChainPolicyStateProvider over the same Fuji registry
 *   - Evidence: ChainOutbox worker → DecisionLog on Fuji (LOGGER key)
 *   - x402: CreditStore + POST /v1/credits (MockSettlement by default; X402_MODE=payai uses the PayAI facilitator)
 * OKX (OKX_MODE):
 *   - unset / "fake" (default): mocked account/market data and FakeAtkClient — nothing reaches OKX.
 *   - "atk": real OKX through ATK (Person 1): read-only key → OkxRiskProvider + OkxOrderOwnershipVerifier,
 *     public market data, trade key → executor's okx-trade-mcp child. Needs OKX_READ_*, OKX_TRADE_*,
 *     OKX_PROFILE (demo|live), OKX_SITE. The on-chain policy's accountRef must be that OKX account.
 *     Market BUY stays disabled unless MARKET_BUY_ENABLED=1 (only after docs/okx-atk-spike.md S5).
 * Needs the local .env (CHAIN_RPC_URL, LOGGER_PRIVATE_KEY, DEPLOYER_ADDRESS); never prints keys.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createPublicClient, createWalletClient, http, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import type { Hex, ReadRecord } from "@leashagent/shared";
import {
  ChainOutbox, createChainPolicyStateProvider, createDecisionLogPort, createPolicyChainClient, loadVerifiedPolicy,
} from "@leashagent/chain";
import {
  CreditStore, FacilitatorSettlement, MockSettlement, PAYAI_FACILITATOR_URL, fujiUsdcRequirements, purchaseCredits,
} from "@leashagent/payments";
import { BTC_USDT, FakeAtkClient, MockMarketData, MockOrderOwnership, MockRiskProvider } from "@leashagent/mocks";
import { DefaultExecutor, openExecutorDb, tradeAtkEnvFromProcess } from "@leashagent/executor";
import {
  SqliteEquityBaseline, createGateway, createGatewayServer, delegationResolver, openGatewayDb, readAtkEnvFromProcess,
} from "@leashagent/gateway";
import { activeDeployment } from "./deployment";
import { McpStdioTransport, OkxAtkClient, OkxOrderOwnershipVerifier, OkxPublicMarketData, OkxRiskProvider } from "@leashagent/atk";
import { gatewayAuditor } from "./auditor";
import { setupTee } from "./tee";
import { DefaultIngestService, FixtureSource, HeuristicReaderModel } from "@leashagent/ingest";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing ${k} (run with --env-file=.env)`);
  return v;
};

export async function buildFujiGateway(opts: { price?: string; dataDir?: string } = {}) {
  const dep = activeDeployment();
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
  // TEE Lite: with TEE_MODE set, the executor only accepts this signer while its attestation is fresh (INV-22).
  const tee = await setupTee(guard.address, clock);
  const auditor = gatewayAuditor();
  const logger = privateKeyToAccount(need("LOGGER_PRIVATE_KEY") as Hex);

  const dataDir = opts.dataDir ?? "data";
  mkdirSync(dataDir, { recursive: true });
  const gatewayDb = openGatewayDb(`${dataDir}/fuji-gateway.db`);

  // ---- OKX: fake (default) or real through ATK ----
  const okxMode = process.env.OKX_MODE === "atk" ? "atk" : "fake";
  let okx;
  if (okxMode === "atk") {
    const readEnv = readAtkEnvFromProcess();
    const readAtk = new McpStdioTransport({ env: readEnv, modules: ["account", "spot"], readOnly: true, callTimeoutMs: 20_000 });
    const tradeAtk = new McpStdioTransport({ env: tradeAtkEnvFromProcess(), modules: ["spot"], readOnly: false, callTimeoutMs: 25_000 });
    okx = {
      market: new OkxPublicMarketData({ site: readEnv.site, demo: readEnv.demo }),
      risk: new OkxRiskProvider(readAtk, { baseline: new SqliteEquityBaseline(gatewayDb) }),
      ownership: new OkxOrderOwnershipVerifier(readAtk),
      atk: new OkxAtkClient(tradeAtk),
      executorDb: `${dataDir}/fuji-executor.db`,
      close: () => Promise.allSettled([readAtk.close(), tradeAtk.close()]),
    };
  } else {
    const market = new MockMarketData(clock, [BTC_USDT]);
    market.quotes.set("BTC-USDT", { bid: price, ask: price, last: price });
    okx = {
      market,
      risk: new MockRiskProvider(clock, { baseBalances: { BTC: "1", USDT: "100000" } }),
      ownership: new MockOrderOwnership(clock),
      atk: new FakeAtkClient(),
      executorDb: ":memory:",
      close: async () => [],
    };
  }
  const reqs = fujiUsdcRequirements({
    payTo: (process.env.X402_PAY_TO ?? need("DEPLOYER_ADDRESS")) as Hex,
    maxAmountRequired: process.env.X402_PRICE_ATOMIC ?? "100000", // 0.10 USDC for 5 checks
    resource: "/v1/credits",
  });
  const credits = new CreditStore(new DatabaseSync(`${dataDir}/fuji-credits.db`), { challenge: () => reqs });
  const settlement = process.env.X402_MODE === "payai" ? new FacilitatorSettlement(PAYAI_FACILITATOR_URL, reqs) : new MockSettlement(reqs);

  const executor = new DefaultExecutor({
    attestation: tee.verifier,
    db: openExecutorDb(okx.executorDb),
    atk: okx.atk,
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
    {
      guardInstanceId: "fuji-guard", policyCacheTtlSec: 30, auditorTimeoutMs: 2000, unknownGraceSec: 30,
      marketBuyEnabled: process.env.MARKET_BUY_ENABLED === "1",
    },
    {
      db: gatewayDb,
      signer: guard,
      chain,
      verifyPolicy: (id) => loadVerifiedPolicy(chain, id),
      risk: okx.risk,
      market: okx.market,
      ownership: okx.ownership,
      payment: credits,
      auditor: auditor.auditor,
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
    tee: tee.http,
    auditor: auditor.label,
    credits: (q) => purchaseCredits({ store: credits, provider: settlement, delegations: delegationResolver(app.loader, clock) }, q),
    dashboardDir: join(dirname(fileURLToPath(import.meta.url)), "../../packages/dashboard/public"),
  });

  return { tee,
    app, server, credits, executor, chain, publicClient, policyId, record, price, okxMode, closeOkx: okx.close,
    settlementMode: process.env.X402_MODE === "payai" ? "payai" : "mock",
  };
}
