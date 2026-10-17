import type { LocalAccount } from "viem";
import type { Hex, ReadRequest, ReadSummary } from "@bekci/shared";
import { ApprovalHandler } from "./approval";
import { AuditLog } from "./audit";
import { LocalAuthorizer } from "./authorizer";
import { CreditReconciler } from "./credit-reconciler";
import { openGatewayDb, type Db } from "./db";
import { ExecutionDispatcher, ExecutionEventHandler } from "./execution";
import { DefaultIntentGate } from "./intent-gate";
import { ChainQueue, chainWriteAuditor, type ChainEvidenceWorker, type ChainWorkerEvent } from "./outbox";
import { PauseGateway } from "./pause";
import { DefaultPolicyEngine } from "./policy-engine";
import { PolicyLoader } from "./policy-loader";
import type {
  Auditor,
  Clock,
  ExecutionLookup,
  ExecutorPort,
  MarketDataProvider,
  OrderOwnershipVerifier,
  PaymentEntitlement,
  PolicyChainClient,
  PolicyDocumentFetcher,
  RiskProvider,
} from "./ports";
import { DefaultRiskStore } from "./risk-store";
import { SerialQueue } from "./serial";
import { GatewayStore } from "./store";

/** L1 ingest service (Person 2), reached only through this interface. */
export interface IngestService {
  read(req: ReadRequest): Promise<ReadSummary>;
}

export type GatewayConfig = {
  dbPath?: string;
  guardInstanceId: string; // GUARD_INSTANCE_ID
  policyCacheTtlSec: number; // POLICY_CACHE_TTL_SEC
  auditorTimeoutMs: number; // AUDITOR_TIMEOUT_MS
  unknownGraceSec: number; // UNKNOWN_GRACE_SEC
  /** §25.6 — keep false until scripts/atk-spike.ts S5 passes. */
  marketBuyEnabled?: boolean;
};

export type GatewayDeps = {
  /** GUARD_SIGNING_KEY account. */
  signer: LocalAccount;
  chain: PolicyChainClient & { watchPause?(policyId: Hex, cb: (paused: boolean) => void): () => void };
  docs: PolicyDocumentFetcher;
  risk: RiskProvider; // OKX read key
  market: MarketDataProvider;
  ownership: OrderOwnershipVerifier;
  payment: PaymentEntitlement;
  auditor: Auditor;
  executor: ExecutorPort;
  executionLookup: ExecutionLookup;
  /** Executor-side read-only reconciliation, when the executor is reachable from here. */
  reconcileExecutor?: () => Promise<unknown>;
  ingest?: IngestService;
  /**
   * Chain evidence sender over this gateway's `chain_outbox` table — Person 3's
   * `new ChainOutbox(db, decisionLogPort, { onEvent })` from @bekci/chain fits. Omitted: evidence is
   * still queued durably, and /v1/health reports chain "disabled".
   */
  chainEvidence?: (db: Db, onEvent: (e: ChainWorkerEvent) => void) => ChainEvidenceWorker;
  clock?: Clock;
};

export type GatewayApp = ReturnType<typeof createGateway>;

/** Composition root for L3 + L4 + L5 + the gateway side of L7. */
export function createGateway(config: GatewayConfig, deps: GatewayDeps) {
  const clock = deps.clock ?? (() => Math.floor(Date.now() / 1000));
  const db: Db = openGatewayDb(config.dbPath ?? ":memory:");
  const store = new GatewayStore(db);
  const audit = new AuditLog(db);
  const outbox = new ChainQueue(db, clock, audit);
  const chainWorker = deps.chainEvidence?.(
    db,
    chainWriteAuditor(audit, clock, (requestId) => store.findRequest(requestId)?.policyId),
  );
  const queue = new SerialQueue();
  const loader = new PolicyLoader({ store, chain: deps.chain, docs: deps.docs, clock, cacheTtlSec: config.policyCacheTtlSec });
  const risk = new DefaultRiskStore({ db, store, risk: deps.risk, clock });
  const authorizer = new LocalAuthorizer(deps.signer, config.guardInstanceId, clock);
  const gate = new DefaultIntentGate({ store, audit, instruments: deps.market, clock, marketBuyEnabled: config.marketBuyEnabled ?? false });
  const engine = new DefaultPolicyEngine({
    store, audit, loader, risk, market: deps.market, ownership: deps.ownership, payment: deps.payment,
    auditor: deps.auditor, auditorTimeoutMs: config.auditorTimeoutMs, authorizer, outbox, clock, queue,
  });
  const approvals = new ApprovalHandler({ engine, store, audit, loader, outbox, clock });
  const pause = new PauseGateway({ store, audit, clock });
  const executionEvents = new ExecutionEventHandler({ store, audit, outbox, risk, clock });
  const dispatcher = new ExecutionDispatcher(deps.executor, executionEvents, store);
  const credits = new CreditReconciler({
    store, audit, risk, payment: deps.payment, lookup: deps.executionLookup, clock, graceSec: config.unknownGraceSec,
  });

  const unwatch: (() => void)[] = [];

  /** Load + verify a policy and subscribe to its on-chain pause events. */
  async function registerPolicy(policyId: Hex) {
    const r = await loader.load(policyId);
    if (r.ok && deps.chain.watchPause) {
      unwatch.push(deps.chain.watchPause(policyId, (paused) => pause.onChainPause(policyId, paused)));
    }
    return r;
  }

  /** One maintenance pass: expire pending approvals, reconcile executor state, reconcile credits. */
  async function tick() {
    const expired = await approvals.expirePending();
    if (deps.reconcileExecutor) {
      try {
        await deps.reconcileExecutor();
      } catch {
        /* retried next tick */
      }
    }
    const creditResult = await credits.run();
    return { expired, ...creditResult };
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  function startJobs(intervalMs: number, chainIntervalMs = 2_000) {
    stopJobs();
    timer = setInterval(() => void tick().catch(() => undefined), intervalMs);
    chainWorker?.start(chainIntervalMs);
  }
  function stopJobs() {
    if (timer) clearInterval(timer);
    timer = undefined;
    chainWorker?.stop();
  }

  function close() {
    stopJobs();
    for (const u of unwatch.splice(0)) u();
    db.close();
  }

  return {
    config, clock, db, store, audit, outbox, chainWorker, loader, risk, authorizer, gate, engine, approvals, pause,
    executionEvents, dispatcher, credits, ingest: deps.ingest,
    registerPolicy, tick, startJobs, stopJobs, close,
  };
}
