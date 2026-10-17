import type {
  AuditorInput,
  AuditorOutput,
  ChainRecord,
  Dec,
  EpochSec,
  ExecutionAuthorization,
  ExecutionEvent,
  Hex,
  InstrumentInfo,
  NormalizedOrder,
  PolicyRecord,
  UUID,
} from "@leashagent/shared";

/** Instrument metadata source (L5 MarketDataProvider). Real impl wraps ATK `market`. */
export interface InstrumentProvider {
  getInstrument(instId: string): Promise<InstrumentInfo | null>;
}

export type Ticker = {
  instId: string;
  bid: Dec;
  ask: Dec;
  last: Dec;
  ts: EpochSec; // exchange timestamp of the quote
};

/** Ticker + instrument info through ATK `market` (keyless). */
export interface MarketDataProvider extends InstrumentProvider {
  getTicker(instId: string): Promise<Ticker>;
}

/** Account state read with the OKX read-only key (L5 RiskProvider, §6.5). */
export type AccountState = {
  fetchedAt: EpochSec;
  dailyPnlUsdt: Dec; // realized + unrealized since UTC day start, fees included
  openNotionalUsdt: Dec; // actual position
  pendingOrdersNotionalUsdt: Dec; // open orders at the exchange
  baseBalances: Record<string, Dec>; // total balances per currency
  lockedBySellOrders: Record<string, Dec>; // base quantity locked by open sell orders
};

export interface RiskProvider {
  /** policyId -> accountRef mapping is operator configuration (§19.8). */
  getAccountState(policyId: Hex): Promise<AccountState>;
}

// ---------- Person 3: chain / policy registry ----------

/** PolicyRegistry read client (§15.1 PolicyChainClient). */
export interface PolicyChainClient {
  getPolicy(policyId: Hex): Promise<PolicyRecord>;
}

/** Fetches the policy JSON stored under `policyURI`. Integrity is checked against the on-chain hash. */
export interface PolicyDocumentFetcher {
  fetch(policyURI: string): Promise<unknown>;
}

/** Durable chain queue (§15.1 DecisionChainWriter). */
export interface DecisionChainWriter {
  enqueue(r: ChainRecord): Promise<void>;
}

// ---------- Person 3: x402 entitlement (§21.2) ----------
export interface PaymentEntitlement {
  reserveCredit(policyId: Hex, agentId: string, payer: Hex, requestId: UUID): Promise<
    | { ok: true; creditReservationId: string }
    | { ok: false; paymentRequired: true; paymentChallenge?: unknown }
  >;
  consumeReservedCredit(policyId: Hex, requestId: UUID): Promise<void>;
  releaseReservedCredit(policyId: Hex, requestId: UUID, reason: string): Promise<void>;
  /**
   * PROPOSED extension (needs agreement with Person 3): refund a consumed credit whose
   * authorization provably never reached execution (§4.4 step 11, §21.2 rule 6). Idempotent.
   */
  refundConsumedCredit?(policyId: Hex, requestId: UUID, reason?: string): Promise<void> | void;
}

/** Read-only view of the executor's durable attempt record (executor_nonces). Throws if unreachable. */
export interface ExecutionLookup {
  hasExecutionAttempt(policyId: Hex, requestId: UUID): Promise<boolean>;
}

// ---------- Person 2: auditor (§10) ----------
export interface Auditor {
  decide(input: AuditorInput, opts: { timeoutMs: number }): Promise<AuditorOutput>;
}

// ---------- Own: OKX read-key ownership check (§6.4 verifiedProtectiveAction) ----------
export interface OrderOwnershipVerifier {
  /** Is the order an open order of this policy's accountRef? */
  isOwnOpenOrder(
    policyId: Hex,
    instId: string,
    ref: { ordId?: string; clOrdId?: string },
  ): Promise<{ open: boolean; fetchedAt: EpochSec }>;
}

// ---------- Own: L6 executor, reached only through this interface (§15.2) ----------
export interface ExecutorPort {
  execute(auth: ExecutionAuthorization, order: NormalizedOrder): Promise<ExecutionEvent[]>;
}

export type Clock = () => EpochSec;

export const systemClock: Clock = () => Math.floor(Date.now() / 1000);
