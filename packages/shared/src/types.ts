// Bekçi shared types — transcribed from SONPLAN.md §5. Person 1 + 3 own the freeze;
// this copy exists so the agent/ingest/dashboard packages can build against it.
export type Hex = `0x${string}`;
export type Dec = string;
export type EpochSec = number;
export type UUID = string;
export type Tool = "spot_place_order" | "spot_cancel_order";
export type ReasonCode = number;

export type AgentIdentity = {
  agentId: string;
  agentRegistry: Hex;
  agentRegistryId: string;
  agentAuthAddress: Hex;
};

export type ReadRequest = {
  requestId: UUID;
  policyId: Hex;
  source: "news" | "web" | "social";
  query: string;
  agentSignature: Hex;
};

export type ReadSummary = {
  readId: UUID;
  source: string;
  publishedAt?: EpochSec;
  topics: string[];
  sentiment: "positive" | "neutral" | "negative" | "unknown";
  confidence: Dec;
  sourceUrls: string[];
  flags: ("contains_instructions" | "low_quality" | "duplicate")[];
};

export type ReadRecord = {
  readId: UUID;
  policyId: Hex;
  fetchedAt: EpochSec;
  contentHash: Hex;
  excerpt: string;
  summary: ReadSummary;
};

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
  authNonce: Hex;
  intent: OrderIntent;
  agentReason: string;
  referencedReadIds: UUID[];
  agentSignature: Hex;
};

export type OrderStatus =
  | "RECEIVED"
  | "REJECTED_AUTH" | "REJECTED_SCHEMA" | "REJECTED_POLICY" | "REJECTED_PAYMENT"
  | "POLICY_CHECKED" | "BLOCKED"
  | "PENDING" | "APPROVED" | "REJECTED_BY_HUMAN" | "EXPIRED"
  | "ALLOWED" | "RECHECKED" | "REVOKED"
  | "SUBMITTED" | "ACKNOWLEDGED" | "FILLED" | "PARTIALLY_FILLED"
  | "CANCELLED" | "REJECTED_BY_OKX" | "UNKNOWN";

export type IntentResponse = {
  requestId: UUID;
  status: OrderStatus;
  reasonCode?: ReasonCode;
  message?: string;
};

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

export interface Auditor {
  decide(i: AuditorInput, o: { timeoutMs: number }): Promise<AuditorOutput>;
}

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

export type AuditEvent = {
  seq: number;
  ts: EpochSec;
  policyId: Hex;
  requestId?: UUID;
  type:
    | "intent_received" | "intent_rejected" | "decision" | "approval"
    | "authorization_issued" | "execution" | "reconciliation"
    | "pause" | "policy_loaded" | "read_recorded" | "chain_write";
  payload: unknown;
  prevHash: Hex;
  hash: Hex;
};
