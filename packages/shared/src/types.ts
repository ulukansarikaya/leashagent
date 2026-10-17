// Bekçi shared types — transcribed from architecture §5, §7, §21, §25.
// Money, prices, quantities and limits are Dec (decimal strings). Never `number`.

// ---------- 5.1 Base ----------
export type Hex = `0x${string}`;
export type Dec = string; // ^-?\d+(\.\d+)?$
export type EpochSec = number; // UNIX seconds (integer)
export type UUID = string;

export type Tool = "spot_place_order" | "spot_cancel_order";
export type ReasonCode = number;

// ---------- 5.2 Identity and delegation ----------
export type AgentIdentity = {
  agentId: string;
  agentRegistry: Hex;
  agentRegistryId: string; // canonical unsigned decimal string
  agentAuthAddress: Hex;
};

export type PolicyBinding = {
  policyId: Hex; // keccak256(abi.encode(owner, accountRef, agentRegistry, agentRegistryId))
  owner: Hex;
  accountRef: Hex;
  agentRegistry: Hex;
  agentRegistryId: string;
  agentId: string;
};

// ---------- 5.3 Ingest (L1) ----------
export type ReadRequest = {
  requestId: UUID;
  policyId: Hex;
  source: "news" | "web" | "social";
  query: string; // <= 512 chars
  agentSignature: Hex;
};

export type RawContent = {
  url?: string;
  fetchedAt: EpochSec;
  body: string;
};

export type ReadSummary = {
  readId: UUID;
  source: string;
  publishedAt?: EpochSec;
  topics: string[]; // <= 10, each <= 64 chars
  sentiment: "positive" | "neutral" | "negative" | "unknown";
  confidence: Dec; // [0,1]
  sourceUrls: string[]; // <= 5
  flags: ("contains_instructions" | "low_quality" | "duplicate")[];
};

export type ReadRecord = {
  readId: UUID;
  policyId: Hex;
  fetchedAt: EpochSec;
  contentHash: Hex;
  excerpt: string; // <= 1000 chars
  summary: ReadSummary;
};

// ---------- 5.4 Agent (L2) ----------
export type Signal = {
  instId: string;
  direction: "long_bias" | "flat" | "exit_bias";
  strength: Dec;
  basis: { name: string; value: Dec }[];
  computedAt: EpochSec;
};

export type OrderIntent = {
  tool: Tool;
  instId?: string;
  side?: "buy" | "sell";
  ordType?: "market" | "limit";
  sz?: Dec;
  px?: Dec;
  ordId?: string;
  clOrdIdToCancel?: string;
};

export type SignedIntentRequest = {
  requestId: UUID;
  policyId: Hex;
  agentId: string;
  issuedAt: EpochSec;
  authNonce: Hex; // 16 random bytes
  intent: OrderIntent;
  agentReason: string; // <= 1000 chars, untrusted
  referencedReadIds: UUID[];
  agentSignature: Hex; // EIP-712 AgentIntent
};

export type IntentResponse = {
  requestId: UUID;
  status: OrderStatus;
  reasonCode?: ReasonCode;
  message?: string;
};

// ---------- 5.5 Normalization (L3 output) ----------
export type NormalizedOrder = {
  tool: Tool;
  instId: string;
  side?: "buy" | "sell";
  ordType?: "market" | "limit";
  sz?: Dec;
  px?: Dec;
  tgtCcy?: "base_ccy"; // Unverified: OKX market order unit semantics (P0 spike)
  clOrdId?: string;
  cancel?: { ordId?: string; clOrdId?: string };
};

export type ValidatedIntent = {
  request: SignedIntentRequest;
  order: NormalizedOrder;
  normalizedOrderHash: Hex;
  receivedAt: EpochSec;
};

/** Instrument metadata needed for normalization (from MarketDataProvider). */
export type InstrumentInfo = {
  instId: string;
  lotSz: Dec; // size step
  tickSz: Dec; // price step
  minSz?: Dec;
};

// ---------- 5.6 Policy ----------
export type Policy = {
  policyVersion: number;
  binding: PolicyBinding;
  agentAuthAddress: Hex;
  delegationValidUntil: EpochSec;

  mandate: string;
  allowedInstruments: string[];
  allowedTools: Tool[];
  forbiddenTools: string[];

  limits: {
    maxOrderNotionalUsdt: Dec;
    maxOpenNotionalUsdt: Dec;
    maxOrdersPerMinute: number;
    maxDailyLossUsdt: Dec;
    maxPriceDeviationBps: number;
    marketSlippageBufferBps: number;
    escalateAboveUsdt: Dec;
  };

  freshness: {
    maxRiskDataAgeSec: number;
    maxMarketDataAgeSec: number;
  };

  auditor: {
    mode: "disabled" | "enabled";
    maxInjectionSuspicion: Dec;
    minConsistency: Dec;
    minVerdictConfidence: Dec;
    onUnavailable: "pending";
  };

  pendingTtlSec: number;
  authorizationTtlSec: number;
};

// ---------- 5.7 Risk and reservation (L5) ----------
export type RiskSnapshot = {
  policyId: Hex;
  fetchedAt: EpochSec;
  dailyPnlUsdt: Dec;
  openNotionalUsdt: Dec;
  pendingOrdersNotionalUsdt: Dec;
  reservedNotionalUsdt: Dec;
  baseBalances: Record<string, Dec>;
  ordersLastMinute: number;
};

export type ReservationRequest = {
  requestId: UUID;
  policyId: Hex;
  notionalUsdt: Dec;
  limitsToEnforce: {
    maxOpenNotionalUsdt: Dec;
    maxDailyLossUsdt: Dec;
  };
};

export type ReservationResult =
  | { ok: true; reservationId: UUID }
  | { ok: false; reasonCode: ReasonCode };

// ---------- 5.8 Rule and auditor results (L4) ----------
export type RuleViolation = { rule: string; detail: string; code: ReasonCode };

export type RuleResult = {
  pass: boolean;
  violations: RuleViolation[];
  escalate: boolean;
  derived: {
    riskIncreasing: boolean;
    verifiedProtectiveAction: boolean;
    notionalUsdt: Dec;
    referencePrice?: Dec;
    priceDeviationBps?: number;
  };
};

export type AuditorInput = {
  policyMandate: string;
  order: NormalizedOrder;
  agentReason: string;
  recentReads: { readId: UUID; excerpt: string; summary: ReadSummary }[];
  ruleSummary: { notionalUsdt: Dec; escalate: boolean };
};

export type AuditorOutput = {
  consistency: Dec;
  injectionSuspicion: Dec;
  verdict: { allow: Dec; block: Dec; askHuman: Dec };
  latencyMs: number;
  provider: string;
  raw?: unknown;
};

export type DecisionKind = "ALLOW" | "BLOCK" | "PENDING";

export type Decision = {
  requestId: UUID;
  policyId: Hex;
  policyVersion: number;
  kind: DecisionKind;
  reasonCode: ReasonCode;
  ruleResult: RuleResult;
  auditorOutput?: AuditorOutput;
  decidedAt: EpochSec;
  evidenceHash: Hex;
};

// ---------- 5.9 Authorization (L4 -> L6) ----------
export type ExecutionAuthorization = {
  requestId: UUID;
  policyId: Hex;
  policyVersion: number;
  accountRef: Hex;
  agentId: string;
  tool: Tool;
  normalizedOrderHash: Hex;
  nonce: Hex; // single-use, 16 bytes
  issuedAt: EpochSec;
  expiresAt: EpochSec;
  guardInstanceId: string;
  basis: "rules_only" | "rules_and_auditor" | "human_approved";
  signature: Hex;
};

// ---------- 5.10 Human actions ----------
export type SignedApproval = {
  requestId: UUID;
  policyId: Hex;
  normalizedOrderHash: Hex;
  decision: "approve" | "reject";
  nonce: Hex;
  expiresAt: EpochSec;
  ownerSignature: Hex;
};

export type SignedPauseCommand = {
  policyId: Hex;
  paused: boolean;
  nonce: Hex;
  issuedAt: EpochSec;
  ownerSignature: Hex;
};

// ---------- 5.11 Execution (L6) ----------
export type ExecStatus =
  | "submitted"
  | "acknowledged"
  | "filled"
  | "partially_filled"
  | "cancelled"
  | "rejected_by_okx"
  | "expired"
  | "revoked"
  | "unknown";

export type ExecutionEvent = {
  requestId: UUID;
  eventSeq: number; // increasing from 1 per requestId
  status: ExecStatus;
  ordId?: string;
  okxCode?: string;
  okxResultHash: Hex;
  occurredAt: EpochSec;
};

// ---------- 5.12 Audit and chain ----------
export type AuditEventType =
  | "intent_received"
  | "intent_rejected"
  | "decision"
  | "approval"
  | "authorization_issued"
  | "execution"
  | "reconciliation"
  | "pause"
  | "policy_loaded"
  | "read_recorded"
  | "chain_write";

export type AuditEvent = {
  seq: number;
  ts: EpochSec;
  policyId: Hex;
  requestId?: UUID;
  type: AuditEventType;
  payload: unknown;
  prevHash: Hex;
  hash: Hex;
};

export type ChainRecord =
  | {
      kind: "decision";
      requestId: UUID;
      policyId: Hex;
      verdict: DecisionKind | "HUMAN_APPROVED" | "HUMAN_REJECTED";
      policyHash: Hex;
      policyVersion: number;
      normalizedOrderHash: Hex;
      evidenceHash: Hex;
      reasonCode: ReasonCode;
      authHash: Hex;
    }
  | {
      kind: "execution";
      requestId: UUID;
      eventSeq: number;
      status: ExecStatus;
      okxResultHash: Hex;
    };

// ---------- 5.13 Order statuses ----------
export type OrderStatus =
  | "RECEIVED"
  | "REJECTED_AUTH"
  | "REJECTED_SCHEMA"
  | "REJECTED_POLICY"
  | "REJECTED_PAYMENT"
  | "POLICY_CHECKED"
  | "BLOCKED"
  | "PENDING"
  | "APPROVED"
  | "REJECTED_BY_HUMAN"
  | "EXPIRED"
  | "ALLOWED"
  | "RECHECKED"
  | "REVOKED"
  | "SUBMITTED"
  | "ACKNOWLEDGED"
  | "FILLED"
  | "PARTIALLY_FILLED"
  | "CANCELLED"
  | "REJECTED_BY_OKX"
  | "UNKNOWN";

// ---------- 21 Extensions (consumed through interfaces) ----------
export type ServiceCredit = {
  paymentRef: string;
  policyId: Hex;
  agentId: string;
  payer: Hex;
  purchased: number;
  remaining: number;
  createdAt: EpochSec;
};

/** On-chain policy record (§7), as returned by the chain client. */
export type PolicyRecord = {
  owner: Hex;
  accountRef: Hex;
  agentRegistry: Hex;
  agentRegistryId: string;
  agentAuthAddress: Hex;
  policyHash: Hex;
  policyURI: string;
  version: number;
  delegationExpiresAt: EpochSec;
  revoked: boolean;
  paused: boolean;
};
