// Shared DTOs — SONPLAN.md §5, §7, §21. Frozen: changes require agreement of all three owners
// and must update SONPLAN.md in the same PR (§25.7).

// ---------- 5.1 Base ----------
export type Hex = `0x${string}`;
export type Dec = string; // ^-?\d+(\.\d+)?$
export type EpochSec = number; // UNIX seconds (integer)
export type UUID = string;

export const TOOLS = ["spot_place_order", "spot_cancel_order"] as const;
export type Tool = (typeof TOOLS)[number];

/** Tools that are always forbidden regardless of policy (§5.6). */
export const ALWAYS_FORBIDDEN_TOOLS = ["transfer", "withdraw"] as const;

export type ReasonCode = number;

// ---------- 5.2 Identity ----------
export type AgentIdentity = {
  agentId: string;
  agentRegistry: Hex;
  agentRegistryId: string; // canonical unsigned decimal string
  agentAuthAddress: Hex;
};

export type PolicyBinding = {
  policyId: Hex; // keccak256(abi.encode(owner, accountRef, agentRegistry, agentRegistryId))
  owner: Hex;
  accountRef: Hex; // keccak256(okxAccountIdentifier)
  agentRegistry: Hex;
  agentRegistryId: string;
  agentId: string;
};

// ---------- 5.3 Ingest ----------
export type ReadSource = "news" | "web" | "social";

export type ReadRequest = {
  requestId: UUID;
  policyId: Hex;
  source: ReadSource;
  query: string; // ≤ 512 chars
  agentSignature: Hex;
};

export type RawContent = {
  url?: string;
  fetchedAt: EpochSec;
  body: string;
};

export type ReadFlag = "contains_instructions" | "low_quality" | "duplicate";

export type ReadSummary = {
  readId: UUID;
  source: string;
  publishedAt?: EpochSec;
  topics: string[]; // ≤ 10, each ≤ 64 chars
  sentiment: "positive" | "neutral" | "negative" | "unknown";
  confidence: Dec; // [0,1]
  sourceUrls: string[]; // ≤ 5
  flags: ReadFlag[];
};

export type ReadRecord = {
  readId: UUID;
  policyId: Hex;
  fetchedAt: EpochSec;
  contentHash: Hex;
  excerpt: string; // ≤ 1000 chars, "untrusted"
  summary: ReadSummary;
};

// ---------- 5.4 Agent ----------
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
  authNonce: Hex; // 16 bytes
  intent: OrderIntent;
  agentReason: string; // ≤ 1000 chars
  referencedReadIds: UUID[];
  agentSignature: Hex; // EIP-712 AgentIntent
};

export type IntentResponse = {
  requestId: UUID;
  status: OrderStatus;
  reasonCode?: ReasonCode;
  message?: string;
};

// ---------- 5.5 Normalization ----------
export type NormalizedOrder = {
  tool: Tool;
  instId: string;
  side?: "buy" | "sell";
  ordType?: "market" | "limit";
  sz?: Dec;
  px?: Dec;
  tgtCcy?: "base_ccy";
  clOrdId?: string;
  cancel?: { ordId?: string; clOrdId?: string };
};

export type ValidatedIntent = {
  request: SignedIntentRequest;
  order: NormalizedOrder;
  normalizedOrderHash: Hex;
  receivedAt: EpochSec;
};

export type InstrumentInfo = {
  instId: string;
  lotSz: Dec;
  tickSz: Dec;
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

// ---------- 5.7 Risk ----------
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

// ---------- 5.8 Rules / auditor ----------
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

export const DECISION_KINDS = ["ALLOW", "BLOCK", "PENDING"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

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

// ---------- 5.9 Authorization ----------
export const AUTH_BASES = ["rules_only", "rules_and_auditor", "human_approved"] as const;
export type AuthorizationBasis = (typeof AUTH_BASES)[number];

export type ExecutionAuthorization = {
  requestId: UUID;
  policyId: Hex;
  policyVersion: number;
  accountRef: Hex;
  agentId: string;
  tool: Tool;
  normalizedOrderHash: Hex;
  nonce: Hex; // 16 bytes
  issuedAt: EpochSec;
  expiresAt: EpochSec;
  guardInstanceId: string;
  basis: AuthorizationBasis;
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

// ---------- 5.11 Execution ----------
/** Order matches Solidity `IDecisionLog.ExecStatus` — index is the on-chain enum value. */
export const EXEC_STATUSES = [
  "submitted",
  "acknowledged",
  "filled",
  "partially_filled",
  "cancelled",
  "rejected_by_okx",
  "expired",
  "revoked",
  "unknown",
] as const;
export type ExecStatus = (typeof EXEC_STATUSES)[number];

export type ExecutionEvent = {
  requestId: UUID;
  eventSeq: number;
  status: ExecStatus;
  ordId?: string;
  okxCode?: string;
  okxResultHash: Hex;
  occurredAt: EpochSec;
};

// ---------- 5.12 Audit / chain ----------
export const AUDIT_EVENT_TYPES = [
  "intent_received",
  "intent_rejected",
  "decision",
  "approval",
  "authorization_issued",
  "execution",
  "reconciliation",
  "pause",
  "policy_loaded",
  "read_recorded",
  "chain_write",
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

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

/** Order matches Solidity `IDecisionLog.Verdict` — index is the on-chain enum value. */
export const CHAIN_VERDICTS = ["ALLOW", "BLOCK", "PENDING", "HUMAN_APPROVED", "HUMAN_REJECTED"] as const;
export type ChainVerdict = (typeof CHAIN_VERDICTS)[number];

export type ChainRecord =
  | {
      kind: "decision";
      requestId: UUID;
      policyId: Hex;
      verdict: ChainVerdict;
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

/** On-chain PolicyRegistry.PolicyRecord (§7). */
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

// ---------- 5.13 Order status ----------
export const ORDER_STATUSES = [
  "RECEIVED",
  "REJECTED_AUTH",
  "REJECTED_SCHEMA",
  "REJECTED_POLICY",
  "REJECTED_PAYMENT",
  "POLICY_CHECKED",
  "BLOCKED",
  "PENDING",
  "APPROVED",
  "REJECTED_BY_HUMAN",
  "EXPIRED",
  "ALLOWED",
  "RECHECKED",
  "REVOKED",
  "SUBMITTED",
  "ACKNOWLEDGED",
  "FILLED",
  "PARTIALLY_FILLED",
  "CANCELLED",
  "REJECTED_BY_OKX",
  "UNKNOWN",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

// ---------- 21 Extensions ----------
export type ServiceCredit = {
  paymentRef: string;
  policyId: Hex;
  agentId: string;
  payer: Hex;
  purchased: number;
  remaining: number;
  createdAt: EpochSec;
};

export type CreditReserveResult =
  | { ok: true; creditReservationId: string }
  | { ok: false; paymentRequired: true; paymentChallenge?: unknown };

export interface PaymentEntitlement {
  reserveCredit(policyId: Hex, agentId: string, payer: Hex, requestId: UUID): Promise<CreditReserveResult>;
  consumeReservedCredit(policyId: Hex, requestId: UUID): Promise<void>;
  releaseReservedCredit(policyId: Hex, requestId: UUID, reason: string): Promise<void>;
}

export interface ServiceDiscovery {
  publishBekci(metadata: unknown): Promise<string>;
  publishAgent(metadata: unknown): Promise<string>;
}

export interface AttestationVerifier {
  isAuthorizedSigner(address: Hex): Promise<boolean>;
}

// ---------- 15.1 Chain-facing interfaces ----------
export interface PolicyChainClient {
  getPolicy(policyId: Hex): Promise<PolicyRecord>;
  watchPause(policyId: Hex, cb: (paused: boolean) => void): () => void;
}

export interface DecisionChainWriter {
  enqueue(r: ChainRecord): Promise<void>;
}
