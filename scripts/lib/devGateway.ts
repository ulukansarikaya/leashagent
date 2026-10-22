/**
 * The real Leash Agent gateway (L3–L5, L7) and executor (L6) on mocked infrastructure, for local runs,
 * demos and the acceptance suite. Used by scripts/dev-gateway.ts, scripts/agent-live.ts, scripts/live-demo.ts.
 *
 * Real: gateway, executor, auditor adapter, ingest, chain-evidence outbox worker, TEE wiring, x402 purchase flow.
 * Mocked (TEST/DEMO ONLY): the PolicyRegistry chain + policy document, OKX account data, and the exchange itself
 *   (FakeAtkClient: every would-be OKX write is recorded in `atk.writes` — the "OKX write counter").
 * Options pick real market data (OKX public, keyless) and a real x402 credit ledger.
 */
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { createPublicClient, createWalletClient, http } from "viem";
import { avalancheFuji } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ChainOutbox, createChainPolicyStateProvider, createDecisionLogPort, loadVerifiedPolicy, type DecisionLogPort } from "@leashagent/chain";
import type { Hex, Policy, ReadRecord } from "@leashagent/shared";
import {
  FakeAtkClient, MockMarketData, MockOrderOwnership, MockPayment, MockPolicyChain, MockRiskProvider, BTC_USDT, mockPolicy,
} from "@leashagent/mocks";
import { DefaultExecutor, openExecutorDb } from "@leashagent/executor";
import { createGateway, createGatewayServer, delegationResolver } from "@leashagent/gateway";
import { OkxPublicMarketData } from "@leashagent/atk";
import { CreditStore, FacilitatorSettlement, MockSettlement, PAYAI_FACILITATOR_URL, fujiUsdcRequirements, purchaseCredits } from "@leashagent/payments";
import { DefaultIngestService, FixtureSource, HeuristicReaderModel } from "@leashagent/ingest";
import { gatewayAuditor } from "./auditor";
import { setupTee } from "./tee";

export type DevGatewayOptions = {
  port?: number;
  host?: string;
  /** "mock" (default): fixed quote at `price`. "okx": live public OKX market data (keyless). */
  market?: "mock" | "okx";
  price?: string;
  /** "unlimited" (default): credit gate always satisfied. "x402": real credit ledger + POST /v1/credits, starting at 0. */
  credits?: "unlimited" | "x402";
  /** Demo only: latency between the gateway and the executor, so an on-chain pause can land in between. */
  executorDelayMs?: number;
  /** Fixture news served by the ingest layer. */
  news?: { url?: string; body: string }[];
  keys?: { agent?: Hex; owner?: Hex; guard?: Hex };
  limits?: Partial<Policy["limits"]>;
};

export async function buildDevGateway(o: DevGatewayOptions = {}) {
  const clock = () => Math.floor(Date.now() / 1000);
  const agentKey = o.keys?.agent ?? generatePrivateKey();
  const ownerKey = o.keys?.owner ?? generatePrivateKey();
  const agent = privateKeyToAccount(agentKey);
  const owner = privateKeyToAccount(ownerKey);
  const guard = privateKeyToAccount(o.keys?.guard ?? generatePrivateKey());

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
        ...o.limits,
      },
      auditor: { mode: "enabled", maxInjectionSuspicion: "0.5", minConsistency: "0.6", minVerdictConfidence: "0.5", onUnavailable: "pending" },
    },
    clock(),
    owner.address,
  );

  const chain = new MockPolicyChain();
  chain.publish(policy);
  const price = o.price ?? "60000";
  const mockMarket = new MockMarketData(clock, [BTC_USDT]);
  mockMarket.quotes.set("BTC-USDT", { bid: price, ask: price, last: price });
  const market = o.market === "okx" ? new OkxPublicMarketData({ site: "global", demo: false }) : mockMarket;
  const atk = new FakeAtkClient();

  const tee = await setupTee(guard.address, clock);
  const executor = new DefaultExecutor({
    attestation: tee.verifier,
    db: openExecutorDb(process.env.DEV_EXECUTOR_DB ?? ":memory:"),
    atk,
    policyState: createChainPolicyStateProvider(chain),
    config: {
      guardSignerAddress: guard.address, guardInstanceId: "dev-guard", accountRef: policy.binding.accountRef,
      allowedTools: ["spot_place_order", "spot_cancel_order"], clockSkewSec: 60,
    },
    clock,
  });
  const delay = o.executorDelayMs ?? 0;
  const executorPort = delay > 0
    ? { execute: async (a: Parameters<DefaultExecutor["execute"]>[0], ord: Parameters<DefaultExecutor["execute"]>[1]) => {
        await new Promise((r) => setTimeout(r, delay));
        return executor.execute(a, ord);
      } }
    : executor;

  // x402: real credit ledger; MockSettlement moves no funds (X402_MODE=payai uses the PayAI facilitator on Fuji).
  const reqs = fujiUsdcRequirements({ payTo: owner.address, maxAmountRequired: "100000", resource: "/v1/credits" });
  const credits = o.credits === "x402" ? new CreditStore(new DatabaseSync(":memory:"), { challenge: () => reqs }) : undefined;
  const settlement = process.env.X402_MODE === "payai" ? new FacilitatorSettlement(PAYAI_FACILITATOR_URL, reqs) : new MockSettlement(reqs);

  const auditor = gatewayAuditor();
  const app = createGateway(
    { dbPath: process.env.DEV_GATEWAY_DB, guardInstanceId: "dev-guard", policyCacheTtlSec: 30, auditorTimeoutMs: Number(process.env.AUDITOR_TIMEOUT_MS ?? 8000), unknownGraceSec: 30 },
    {
      signer: guard,
      chain,
      verifyPolicy: (id) => loadVerifiedPolicy(chain, id),
      risk: new MockRiskProvider(clock, { baseBalances: { BTC: "1", USDT: "100000" } }),
      market,
      ownership: new MockOrderOwnership(clock),
      payment: credits ?? new MockPayment(100_000),
      auditor: auditor.auditor,
      executor: executorPort,
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
  app.ingest = new DefaultIngestService({
    source: new FixtureSource((o.news ?? [{ url: "https://news.example/btc", body: "Bitcoin trades sideways as ETF inflows stay steady; analysts expect low volatility." }])
      .map((n) => ({ source: "news" as const, url: n.url, body: n.body }))),
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

  const server = createGatewayServer(app, {
    tee: tee.http,
    auditor: auditor.label,
    dashboardDir: fileURLToPath(new URL("../../packages/dashboard/public", import.meta.url)),
    ...(credits ? { credits: (q) => purchaseCredits({ store: credits, provider: settlement, delegations: delegationResolver(app.loader, clock) }, q) } : {}),
  });

  return {
    app, server, atk, chain, mockMarket, policy, agent, owner, agentKey, ownerKey, guard, credits, tee, clock,
    settlementMode: process.env.X402_MODE === "payai" ? "payai" : "mock",
    async listen(): Promise<string> {
      await new Promise<void>((r) => server.listen(o.port ?? 0, o.host ?? "127.0.0.1", r));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    close() { tee.stop(); server.closeAllConnections?.(); server.close(); app.close(); },
  };
}

function decisionLogPort(): DecisionLogPort {
  if (process.env.DEV_REAL_CHAIN === "1") {
    const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`DEV_REAL_CHAIN=1 needs ${k}`); return v; };
    const transport = http(need("CHAIN_RPC_URL"));
    const account = privateKeyToAccount(need("LOGGER_PRIVATE_KEY") as Hex);
    return createDecisionLogPort({
      publicClient: createPublicClient({ chain: avalancheFuji, transport }) as never,
      walletClient: createWalletClient({ chain: avalancheFuji, transport, account }),
      account, chain: avalancheFuji, address: need("DECISION_LOG_ADDRESS") as Hex,
    });
  }
  // In-memory DecisionLog: every record "confirms" with a random tx hash.
  return {
    isApplied: async () => false, simulate: async () => {},
    send: async () => `0x${randomBytes(32).toString("hex")}` as Hex, waitForReceipt: async () => "success",
  } as DecisionLogPort;
}
