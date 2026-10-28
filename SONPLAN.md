# Leash Agent — System Architecture

> This document defines the architecture only: layers, contracts between layers, data models, state machines, storage, and interfaces.
> It is written to be implemented in parallel by multiple coding agents. Each section aims to be precise enough to implement without consulting the others.
> Points marked "Unverified" must be confirmed against external documentation during implementation.
> "Leash Agent" is the product name.

---

## 0. Summary

**Leash Agent** is a security gateway that holds the write authority to an OKX account on behalf of an AI trading agent. It validates the order intents the agent produces against the user's policy, executes only approved orders using an order-bound authorization, and makes every decision auditable.

**Core separation:** The agent *proposes what to do* (reasoning). Leash Agent *decides and performs what may be done* (authority). The two run in different processes with different credentials.

**Defensible claim:** On an account managed by Leash Agent, an order that violates the verified user policy and increases risk does not reach the exchange through Leash Agent.

**Conditions:** No other copy of the OKX write key exists; all write paths go through the gateway; the software works correctly.

**Not claimed:** Eliminating market losses, catching every attack, the chain proving the completeness of all decisions, or cryptographic verification of OKX fills.

---

## 1. Design Principles

| Code | Principle | Implementation consequence |
|---|---|---|
| P1 | Reasoning ≠ authority | The agent only produces an `OrderIntent`; it has no path to the exchange |
| P2 | Least privilege | Three separate credential sets: the agent has none, the gateway has a read key, the executor has a trade key. None can withdraw funds |
| P3 | Independent controls | Schema, rules, auditor LLM, limits, isolation are independent; if one fails the others still hold |
| P4 | Fail-closed | If validation, policy, risk data or identity fails, a risk-increasing order does not pass |
| P5 | The LLM only tightens | The auditor LLM cannot approve what the rules rejected; it can only block or route to a human |
| P6 | Untrusted input isolation | Raw externally sourced text never reaches the decision-making model |
| P7 | Order-bound authorization | An authorization is bound to a specific normalized order, account and policy version, and is single-use |
| P8 | Idempotency | The same `requestId` never produces a second exchange call; on timeout the order is not blindly resent |
| P9 | Evidence, not dependency | The chain is for evidence; the decision path does not depend on chain access |
| P10 | Plain money type | All amounts, prices and limits are decimal strings; no `number` |

---

## 2. System Context and Trust Boundaries

```text
┌───────────────────────── UNTRUSTED ZONE ───────────────────────────┐
│  External sources (news, web, social)       Trading Agent (L2)      │
│                                             - LLM + signal          │
│                                             - own signing key       │
│                                             - ATK: market only,     │
│                                               keyless               │
└───────────────┬───────────────────────────────────┬─────────────────┘
                │ raw content                       │ signed intent
┌───────────────▼───────────────────────────────────▼─────────────────┐
│              LEASH AGENT TRUST BOUNDARY (same operator)              │
│                                                                      │
│  L1 Ingest Layer ──► L3 Intent Gateway ──► L4 Policy Layer           │
│                                              │        ▲              │
│                                              ▼        │              │
│                                         L5 State/Risk                │
│                                              │                       │
│                                              ▼ (signed authorization)│
│  ┌──────── Separate process / separate credentials ─┐                │
│  │ L6 Execution Layer (OKX trade key)                │──► OKX (ATK)   │
│  └──────────────────────────────────────────────────┘                │
│                                                                      │
│  L7 Evidence & Presentation Layer ──► Avalanche, Dashboard           │
└──────────────────────────────────────────────────────────────────────┘
                 ▲
                 │ policy, pause, approval (user wallet signature)
            User (owner)
```

**Trust rules**
- Every field coming from the agent is untrusted: derivable fields such as `riskIncreasing`, `notional`, `protective` are not taken from the agent; Leash Agent computes them.
- External content is untrusted; only the structured summary produced by L1 goes to the agent.
- L6 accepts only authorizations signed by L4; it does not remake L4's decision but verifies that the authorization matches the order.
- User actions (policy, pause, approval) are valid only with the owner wallet's signature.

---

## 3. Component Responsibilities (Layer Summary)

| Layer | Name | One-sentence responsibility |
|---|---|---|
| L1 | Ingest Layer | Receives external content as untrusted, turns it into a structured summary with a tool-less reader model, and keeps a read record |
| L2 | Agent | Produces and signs order intents using a signal plus LLM reasoning |
| L3 | Intent Gateway | Identity, schema, tool allowlist, normalization |
| L4 | Policy Layer | Deterministic rules; then the auditor LLM signal; produces the decision and signed authorization |
| L5 | State and Risk | Persistent state, risk reservation, daily PnL, rate counter, reconciliation |
| L6 | Execution Layer | Verifies the authorization, writes to OKX through ATK, reports status |
| L7 | Evidence and Presentation | Append-only log, chain writing, event stream, dashboard, emergency stop entry point |
| C | Chain Layer | PolicyRegistry and DecisionLog contracts (Avalanche) |

---

## 4. Data Flow Between Layers

### 4.1 Flow matrix

| Source → Target | DTO carried | Transport | Trust |
|---|---|---|---|
| External source → L1 | `RawContent` | HTTP fetch (inside L1) | Untrusted |
| L2 → L1 | `ReadRequest` | HTTP/function | Untrusted |
| L1 → L2 | `ReadSummary` | HTTP/function | Structured, bounded fields |
| L1 → L5 | `ReadRecord` | Function / store write | Leash Agent record |
| L2 → L3 | `SignedIntentRequest` | HTTP `POST /v1/intents` | Untrusted, signed |
| L3 → L4 | `ValidatedIntent` | Function | Validated, normalized |
| L4 ↔ L5 | `RiskSnapshot`, `ReservationRequest`, `ReservationResult` | Function (same transaction) | Internal |
| L4 → Auditor | `AuditorInput` / `AuditorOutput` | Adapter | External model |
| L4 → L6 | `ExecutionAuthorization` + `NormalizedOrder` | Function / internal HTTP | Signed |
| L6 → OKX | `AtkCall` | ATK (CLI/MCP) | Privileged |
| L6 → L5 | `ExecutionEvent` | Function | Internal |
| L4, L6, L5 → L7 | `AuditEvent` | Event write | Internal |
| L7 → Chain | `ChainRecord` | Durable queue → tx | Asynchronous |
| User → L4 | `SignedPolicyUpdate` (chain), `SignedPauseCommand`, `SignedApproval` | HTTP / chain | Wallet signature |
| L7 → Dashboard | `AuditEvent` stream | SSE | Read-only |

### 4.2 Main flow (allowed order)

1. L2 produces a signal, the LLM confirms it with a rationale; it builds an `OrderIntent` and signs it with its own key.
2. L2 → L3: `SignedIntentRequest`.
3. L3 verifies the agent signature, the delegation and the schema, and normalizes the order → `ValidatedIntent`.
4. L4 loads the policy (cache + chain hash verification) and obtains a `RiskSnapshot`.
5. L4 runs the deterministic rules → `RuleResult`.
6. If the rules pass (and the policy allows it), L4 calls the auditor → `AuditorOutput`.
7. L4 + L5 make an atomic risk reservation in a single transaction.
8. L4 signs an `ExecutionAuthorization` and passes it to L6.
9. L6 verifies the authorization, performs the last check before sending, and writes the order through ATK.
10. L6 reports the result as `ExecutionEvent` to L5 and L7.
11. L7 writes the records locally, adds them to the chain queue, and broadcasts to the dashboard.
12. L3 returns an `IntentResponse` to the agent (status + `requestId`; details via `GET`).

### 4.3 Blocked order flow

Rejection at step 3, 5 or 6 → L4 produces `Decision(BLOCK)` → `AuditEvent` to L7 → L3 returns `IntentResponse(status: BLOCKED, reasonCode)` to the agent. L6 is never called.

### 4.4 Order routed to a human

`Decision(PENDING)` → order status `PENDING`, notification to the dashboard → the owner sends a `SignedApproval` → L4 reloads/verifies the current policy/delegation, refreshes risk/market state, recomputes derived fields, re-runs the state-dependent rules/auditor requirements, re-checks credit entitlement, and creates a **new atomic risk reservation**. Any earlier temporary risk/credit reservation for the pending attempt must first be released or proven absent. Only after those steps pass is the new reserved credit finalized exactly once and a `human_approved` authorization issued. If state changed unfavorably, approval does not override it. If the time expires, `EXPIRED`, counted as `BLOCK`; it never becomes `ALLOW` automatically.

---

## 5. Shared Types (DTOs)

All types are defined in `packages/shared`. Money, prices, quantities and limits are `Dec` (validated decimal string).

### 5.1 Base types

```ts
export type Hex = `0x${string}`;
export type Dec = string;          // ^-?\d+(\.\d+)?$ ; format differences like "50" and "50.0" are equalized in normalization
export type EpochSec = number;     // UNIX seconds (integer)
export type UUID = string;

export type Tool = "spot_place_order" | "spot_cancel_order";

export type ReasonCode = number;   // see Section 12
```

### 5.2 Identity and delegation

```ts
export type AgentIdentity = {
  agentId: string;                 // canonical ERC-8004 identity string used by the app
  agentRegistry: Hex;             // ERC-8004 Identity Registry contract address
  agentRegistryId: string;        // registry agent id/token id, canonical unsigned decimal string
  agentAuthAddress: Hex;           // secp256k1 address with which the agent signs requests
};

export type PolicyBinding = {
  policyId: Hex;                   // keccak256(abi.encode(owner, accountRef, agentRegistry, agentRegistryId))
  owner: Hex;                      // user wallet
  accountRef: Hex;                 // keccak256(okxAccountIdentifier); the raw account number is never written
  agentRegistry: Hex;
  agentRegistryId: string;
  agentId: string;                 // canonical display/app identifier derived from the registry identity
};
```

### 5.3 Ingest layer (L1)

```ts
export type ReadRequest = {
  requestId: UUID;
  policyId: Hex;
  source: "news" | "web" | "social";
  query: string;                   // at most 512 characters
  agentSignature: Hex;
};

export type RawContent = {          // exists only inside L1; never leaves it
  url?: string;
  fetchedAt: EpochSec;
  body: string;
};

export type ReadSummary = {         // the only thing the agent sees
  readId: UUID;
  source: string;
  publishedAt?: EpochSec;
  topics: string[];                // at most 10, each at most 64 characters
  sentiment: "positive" | "neutral" | "negative" | "unknown";
  confidence: Dec;                 // [0,1]
  sourceUrls: string[];            // at most 5
  flags: ("contains_instructions" | "low_quality" | "duplicate")[];
};

export type ReadRecord = {          // the record Leash Agent keeps; the auditor reads from here
  readId: UUID;
  policyId: Hex;
  fetchedAt: EpochSec;
  contentHash: Hex;                // keccak256(body)
  excerpt: string;                 // at most 1000 characters, stored with an "untrusted" label
  summary: ReadSummary;
};
```

### 5.4 Agent layer (L2)

```ts
export type Signal = {              // output of the deterministic signal generator
  instId: string;
  direction: "long_bias" | "flat" | "exit_bias";
  strength: Dec;                   // [0,1]
  basis: { name: string; value: Dec }[];  // e.g. {name:"sma_spread", value:"0.0031"}
  computedAt: EpochSec;
};

export type OrderIntent = {
  tool: Tool;
  // spot_place_order
  instId?: string;                 // e.g. "BTC-USDT"
  side?: "buy" | "sell";
  ordType?: "market" | "limit";
  sz?: Dec;                        // always in base asset terms
  px?: Dec;                        // required for limit
  // spot_cancel_order
  ordId?: string;
  clOrdIdToCancel?: string;
};

export type SignedIntentRequest = {
  requestId: UUID;                 // unique within the policyId scope
  policyId: Hex;
  agentId: string;
  issuedAt: EpochSec;
  authNonce: Hex;                  // 16 random bytes; replay protection
  intent: OrderIntent;
  agentReason: string;             // at most 1000 characters; untrusted text
  referencedReadIds: UUID[];       // reads the decision was based on
  agentSignature: Hex;             // EIP-712 AgentIntent
};

export type IntentResponse = {
  requestId: UUID;
  status: OrderStatus;
  reasonCode?: ReasonCode;
  message?: string;                // short, contains no sensitive data
};
```

**Agent's EIP-712 type (`AgentIntent`):** `requestId`, `policyId`, `agentId`, `issuedAt`, `authNonce`, `intentHash` (= keccak256(canonicalJson(intent))), `reasonHash` (= keccak256(agentReason)).

### 5.5 Normalization (L3 output)

```ts
export type NormalizedOrder = {     // exact representation of what will go to OKX
  tool: Tool;
  instId: string;
  side?: "buy" | "sell";
  ordType?: "market" | "limit";
  sz?: Dec;                        // rounded to lot size, fixed scale
  px?: Dec;                        // rounded to tick size, fixed scale
  tgtCcy?: "base_ccy";             // Unverified: OKX market order unit semantics
  clOrdId?: string;                // derived from requestId
  cancel?: { ordId?: string; clOrdId?: string };
};

export type ValidatedIntent = {
  request: SignedIntentRequest;
  order: NormalizedOrder;
  normalizedOrderHash: Hex;        // keccak256(canonicalJson(order))
  receivedAt: EpochSec;
};
```

**Normalization rules**
- `sz` and `px` are rounded (down) to the instrument's `lotSz` and `tickSz`; if the result is 0, reject.
- Decimals are brought to a fixed scale without trimming trailing zeros (e.g. 8 digits if the instrument scale is 8). `"50"`, `"50.0"`, `"50.00000000"` give the same output.
- `clOrdId = "la" + hex(keccak256(policyId ‖ requestId)).slice(0, 30)`; Unverified: OKX `clOrdId` length and character constraints.
- Canonical JSON: keys alphabetical, no whitespace, UTF-8; number type is forbidden (only string and integer fields).

### 5.6 Policy

```ts
export type Policy = {
  policyVersion: number;
  binding: PolicyBinding;
  agentAuthAddress: Hex;
  delegationValidUntil: EpochSec;

  mandate: string;                       // free-text task description
  allowedInstruments: string[];          // e.g. ["BTC-USDT"]
  allowedTools: Tool[];
  forbiddenTools: string[];              // in addition, always: transfer, withdraw

  limits: {
    maxOrderNotionalUsdt: Dec;
    maxOpenNotionalUsdt: Dec;            // open position + pending orders + reservations
    maxOrdersPerMinute: number;
    maxDailyLossUsdt: Dec;               // since the start of the UTC day
    maxPriceDeviationBps: number;        // deviation of the proposed price from the live price
    marketSlippageBufferBps: number;     // notional buffer for market orders
    escalateAboveUsdt: Dec;              // above this, human approval
  };

  freshness: {
    maxRiskDataAgeSec: number;
    maxMarketDataAgeSec: number;
  };

  auditor: {
    mode: "disabled" | "enabled";
    maxInjectionSuspicion: Dec;          // above this: BLOCK
    minConsistency: Dec;                 // below this: BLOCK
    minVerdictConfidence: Dec;           // below this: PENDING
    onUnavailable: "pending";            // fixed; there is no "allow" option
  };

  pendingTtlSec: number;
  authorizationTtlSec: number;
};
```

- `policyHash = keccak256(canonicalJson(policy))`. On chain only the hash, version, owner and `paused` exist; the JSON is stored under `policyURI`. When the gateway fetches the JSON it compares the hash with the one on chain; a mismatch → policy invalid → risk-increasing orders stop.
- `auditor.mode = "disabled"` is a deliberate user choice. When `enabled`, if the auditor is unreachable the order becomes `PENDING` (`onUnavailable` cannot be changed).

### 5.7 Risk and reservation (L5)

```ts
export type RiskSnapshot = {
  policyId: Hex;
  fetchedAt: EpochSec;
  dailyPnlUsdt: Dec;                     // realized + unrealized, fees included
  openNotionalUsdt: Dec;                 // actual position
  pendingOrdersNotionalUsdt: Dec;        // open orders at the exchange
  reservedNotionalUsdt: Dec;             // not-yet-sent / uncertain reservations
  baseBalances: Record<string, Dec>;     // total balances; sell eligibility additionally subtracts open-sell locks and sell reservations
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
```

**Notional calculation (Leash Agent computes it; it is not taken from the agent)**
- `limit`: `sz × px`
- `market` buy: `sz × ask × (1 + marketSlippageBufferBps/10000)`
- `market` sell: `sz × bid` (counted as risk-reducing, see 6.4)
- `ask`/`bid` are the values L4 obtains through `MarketDataProvider`, within `maxMarketDataAgeSec`.

### 5.8 Rule and auditor results (L4)

```ts
export type RuleViolation = { rule: string; detail: string; code: ReasonCode };

export type RuleResult = {
  pass: boolean;
  violations: RuleViolation[];
  escalate: boolean;                     // within limits but human approval required
  derived: {
    riskIncreasing: boolean;             // computed by Leash Agent
    verifiedProtectiveAction: boolean;   // computed by Leash Agent
    notionalUsdt: Dec;
    referencePrice?: Dec;
    priceDeviationBps?: number;
  };
};

export type AuditorInput = {
  policyMandate: string;
  order: NormalizedOrder;
  agentReason: string;                   // passed with an "untrusted" label
  recentReads: { readId: UUID; excerpt: string; summary: ReadSummary }[];  // "untrusted"
  ruleSummary: { notionalUsdt: Dec; escalate: boolean };
};

export type AuditorOutput = {
  consistency: Dec;                      // [0,1]
  injectionSuspicion: Dec;               // [0,1]
  verdict: { allow: Dec; block: Dec; askHuman: Dec };
  latencyMs: number;
  provider: string;
  raw?: unknown;                         // for the evidence archive only
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
  evidenceHash: Hex;                     // keccak256(canonicalJson({ruleResult, auditorOutput, readIds}))
};
```

### 5.9 Authorization (L4 → L6)

```ts
export type ExecutionAuthorization = {
  requestId: UUID;
  policyId: Hex;
  policyVersion: number;
  accountRef: Hex;
  agentId: string;
  tool: Tool;
  normalizedOrderHash: Hex;
  nonce: Hex;                            // single-use, 16 bytes
  issuedAt: EpochSec;
  expiresAt: EpochSec;
  guardInstanceId: string;
  basis: "rules_only" | "rules_and_auditor" | "human_approved";
  signature: Hex;                        // gateway signing key, EIP-712
};
```

**EIP-712 domain:** `{ name: "LeashAgent", version: "1", chainId: 43113 }` (no `verifyingContract`; the signature is verified off-chain).

### 5.10 Human actions (user signatures)

```ts
export type SignedApproval = {
  requestId: UUID;
  policyId: Hex;
  normalizedOrderHash: Hex;
  decision: "approve" | "reject";
  nonce: Hex;
  expiresAt: EpochSec;
  ownerSignature: Hex;                   // EIP-712 ApprovalDecision, owner wallet
};

export type SignedPauseCommand = {
  policyId: Hex;
  paused: boolean;
  nonce: Hex;
  issuedAt: EpochSec;
  ownerSignature: Hex;                   // EIP-712 PauseCommand
};
```

### 5.11 Execution (L6)

```ts
export type ExecutionEvent = {
  requestId: UUID;
  eventSeq: number;                      // increasing from 1 per requestId
  status: ExecStatus;
  ordId?: string;
  okxCode?: string;
  okxResultHash: Hex;                    // keccak256(canonicalJson(okxResponse))
  occurredAt: EpochSec;
};

export type ExecStatus =
  | "submitted" | "acknowledged" | "filled" | "partially_filled"
  | "cancelled" | "rejected_by_okx" | "expired" | "revoked" | "unknown";
```

### 5.12 Audit and chain

```ts
export type AuditEvent = {
  seq: number;                           // global, increasing
  ts: EpochSec;
  policyId: Hex;
  requestId?: UUID;
  type:
    | "intent_received" | "intent_rejected" | "decision" | "approval"
    | "authorization_issued" | "execution" | "reconciliation"
    | "pause" | "policy_loaded" | "read_recorded" | "chain_write";
  payload: unknown;                      // depends on type; no sensitive data
  prevHash: Hex;                         // hash chain
  hash: Hex;                             // keccak256(prevHash ‖ canonicalJson(event without hash))
};

export type ChainRecord =
  | { kind: "decision"; requestId: UUID; policyId: Hex; verdict: DecisionKind | "HUMAN_APPROVED" | "HUMAN_REJECTED";
      policyHash: Hex; policyVersion: number; normalizedOrderHash: Hex; evidenceHash: Hex;
      reasonCode: ReasonCode; authHash: Hex }
  | { kind: "execution"; requestId: UUID; eventSeq: number; status: ExecStatus; okxResultHash: Hex };
```

### 5.13 Order statuses

```ts
export type OrderStatus =
  | "RECEIVED"
  | "REJECTED_AUTH" | "REJECTED_SCHEMA" | "REJECTED_POLICY" | "REJECTED_PAYMENT"
  | "POLICY_CHECKED" | "BLOCKED"
  | "PENDING" | "APPROVED" | "REJECTED_BY_HUMAN" | "EXPIRED"
  | "ALLOWED" | "RECHECKED" | "REVOKED"
  | "SUBMITTED" | "ACKNOWLEDGED" | "FILLED" | "PARTIALLY_FILLED"
  | "CANCELLED" | "REJECTED_BY_OKX" | "UNKNOWN";
```

---

## 6. Layer Details

### 6.1 L1 — Ingest Layer

**Responsibility:** Isolate external content; give the agent only a bounded, structured summary; record every read.

**Sub-components**
- `Fetcher`: fetches content from allowed sources (timeout, size limit, content-type restriction).
- `Sanitizer`: HTML/tag cleanup, length limit. Sanitization is not counted as a security boundary.
- `ReaderModel`: a **tool-less** LLM call; returns only a fixed-schema `ReadSummary`. The system prompt states that the content may carry instructions and must not be obeyed; if it sees traces of instructions it sets the `contains_instructions` flag.
- `ReadRecorder`: produces a `ReadRecord` and writes it to the L5 store.

**Input:** `ReadRequest`. **Output:** `ReadSummary` (to the agent), `ReadRecord` (to the store).

**Invariants**
- `RawContent.body` does not leave L1; it does not go to the agent.
- `ReaderModel` cannot access any tool, and its output is discarded if it fails schema validation.
- Every read is recorded independently of the agent's own account of it.
- Out-of-schema fields, long text and non-URL links cannot be carried into `ReadSummary`.

### 6.2 L2 — Agent

**Responsibility:** Autonomous loop: observe → signal → reason → intent → sign.

**Sub-components**
- `MarketObserver`: reads ticker, candles and order book through ATK `market` (keyless).
- `SignalGenerator`: deterministic signal (e.g. difference of two moving averages + volume filter) → `Signal`.
- `Reviewer` (LLM): input: `Signal`, market summary, `ReadSummary`s, `mandate`. Output: `{proceed: boolean, rationale: string, proposedIntent?: OrderIntent}`.
- `IntentBuilder`: builds a `SignedIntentRequest` from `proposedIntent` and signs it with EIP-712.
- `Memory`: **off** by default. If enabled, its writable area is bounded, every entry is labeled with its source, and it is independent of the L3 contract.

**Constraints**
- No OKX key in its environment; ATK is installed with only the `market` module and `--read-only`.
- It reaches external text only through `ReadSummary`.
- Network calls other than to Leash Agent are limited by an allowlist (only ATK public market and the L1/L3 endpoints).

**Output:** `SignedIntentRequest` → L3.

### 6.3 L3 — Intent Gateway

**Responsibility:** Turn an untrusted request into a trusted, normalized `ValidatedIntent`, or reject it.

**Validation order (stops at the first failure)**
1. Request size and field-count limits.
2. Whether `policyId` is known and present in the policy cache.
3. Delegation: `agentRegistry + agentRegistryId + agentId + agentAuthAddress` match the policy binding, not expired, not revoked → otherwise `REJECTED_AUTH` (000).
4. `agentSignature` valid and `issuedAt` within ±60 s; `authNonce` not used before (persistent nonce table) → otherwise `REJECTED_AUTH`.
5. `requestId` unique (within policyId scope) → if repeated, the previous response is returned and nothing new is processed.
6. `tool` on the allowlist; `forbiddenTools` or an unknown tool → `REJECTED_SCHEMA` (001).
7. Tool-specific strict schema (zod, `strict`): extra fields rejected; `instId` format; `side`, `ordType` enums; if `ordType=limit`, `px` is required.
8. Normalization (5.5). On failure, `REJECTED_SCHEMA`.

**Output:** `ValidatedIntent` → L4. On rejection, `IntentResponse` + `AuditEvent(intent_rejected)`.

**Invariants:** L3 does not know or enforce policy limits (only identity, schema, allowlist). No request outside the allowed tool list can pass to L4.

### 6.4 L4 — Policy Layer

**Responsibility:** Make the decision and, only if `ALLOW`, produce a signed authorization.

**Sub-components**
- `PolicyLoader`: gets the policy from cache/chain, verifies the JSON hash against the on-chain `policyHash`, checks `paused` and `version`. The cache TTL is short; if the chain cannot be read and the cache TTL has expired, risk-increasing orders stop.
- `RuleEngine`: pure function `evaluate(ValidatedIntent, Policy, RiskSnapshot, Market): RuleResult` — no I/O, no LLM.
- `AuditorAdapter`: `decide(AuditorInput): Promise<AuditorOutput>`; swappable behind the provider (Jev and a fallback LLM).
- `DecisionComposer`: combines the rules and the auditor output.
- `AuthorizationSigner`: signs the `ExecutionAuthorization`.
- `ApprovalHandler`: verifies `SignedApproval` and restarts the flow.

**Derived fields**
- `riskIncreasing`: spot `buy` is always `true`. Spot `sell` is risk-reducing only when `availableSellBalance = totalBaseBalance - lockedByOpenSellOrders - reservedSellQuantity` is fresh and `availableSellBalance >= sz`; otherwise the order is invalid (`REJECTED_POLICY`) because Leash Agent does not permit a sell that could require unavailable inventory or create unintended exposure. `cancel` → `false`. Agent-provided balance/protective flags are ignored.
- `verifiedProtectiveAction`: `true` only for `spot_cancel_order` and only if an OKX query has verified that the order to be cancelled is an open order of this `accountRef`. If the data is stale, `false`. No other action is considered protective.

**Rule set (`RuleEngine`)**

| Rule | Condition | Code |
|---|---|---|
| Delegation/policy expiry | `now > delegationValidUntil` | 003 |
| Pause | `paused` and `!verifiedProtectiveAction` | 100 |
| Data freshness | `riskIncreasing` and risk/market data older than `max*AgeSec` | 110 |
| Instrument | `instId ∉ allowedInstruments` | 101 |
| Tool | `tool ∉ allowedTools` | 102 |
| Single order | `notional > maxOrderNotionalUsdt` | 103 |
| Open notional | `riskIncreasing && open + pending + reserved + notional > maxOpenNotionalUsdt` | 104 |
| Rate | `ordersLastMinute >= maxOrdersPerMinute` | 105 |
| Daily loss | `dailyPnl <= -maxDailyLossUsdt` and `riskIncreasing` | 106 |
| Price deviation | `limit` px or reference price deviation `> maxPriceDeviationBps` | 107 |
| Above threshold | `notional > escalateAboveUsdt` | `escalate = true` |

`maxOrdersPerMinute` counts unique `spot_place_order` intents that passed L3 schema validation in the last 60 s, including intents later blocked by policy/auditor. After successful L3 validation, L3 calls `L5.recordRateEvent(policyId, requestId, ts)`; the write is idempotent on `(policyId, requestId)`. L3 does not evaluate the rate limit. L4 reads `ordersLastMinute` from L5 and enforces rule 105. This intentionally makes blocked spam consume rate budget without giving L3 knowledge of policy limits.

**Decision order**
1. L3 has authenticated, schema-validated and normalized the request; L4 must not assume the policy state itself is valid yet.
2. Load and verify policy hash, version, delegation validity/revocation and required freshness. If these cannot be verified → `BLOCK 003`. A pause value from an unverified/stale policy state is never trusted.
3. Obtain fresh risk/market state and derive `riskIncreasing`, `verifiedProtectiveAction`, notional and reference price inside Leash Agent.
4. `paused` + not `verifiedProtectiveAction` → `BLOCK 100`.
5. If the request is risk-increasing, check service entitlement/credit availability through `PaymentEntitlement`. Missing entitlement → `REJECTED_PAYMENT 004`. This is a check/reservation only; no final credit is burned for `BLOCK` or `PENDING`. Verified protective cancels require no credit.
6. Run deterministic rules. Any violation → `BLOCK` (101–199); the auditor is not called. Rule 104 applies only to `riskIncreasing` orders.
7. If `auditor.mode = "enabled"`, call the auditor:
   - Unreachable/timeout/out-of-schema → `PENDING 302`.
   - `injectionSuspicion > maxInjectionSuspicion` → `BLOCK 201`.
   - `consistency < minConsistency` → `BLOCK 202`.
   - If `verdict.block` is the highest → `BLOCK 203`.
   - If `verdict.askHuman` is the highest, or the highest probability is `< minVerdictConfidence` → `PENDING 301`.
8. `RuleResult.escalate = true` → `PENDING 303`.
9. Before authorization, re-read the current policy/risk state and re-run all state-dependent deterministic checks. Then create the L5 risk reservation. If reservation fails → `BLOCK 104/106`.
10. For a risk-increasing order, atomically finalize the previously reserved service credit exactly once for `(policyId, requestId)`; if this cannot be committed, release the risk reservation and return `REJECTED_PAYMENT 004`.
11. `ALLOW` / `HUMAN_APPROVED` → sign the authorization and pass it to L6. If a crash/failure occurs after credit finalization but before an execution attempt is durably recorded, reconciliation releases/refunds the credit reservation according to Section 21.2; a retry never consumes a second credit.

**Invariants**
- The auditor output does not turn a `BLOCK` into an `ALLOW`; it can only turn an `ALLOW` candidate into `BLOCK` or `PENDING`.
- `PENDING` never becomes `ALLOW` by itself. A valid `SignedApproval` restarts the state-dependent path: reload/verify current policy and delegation, refresh risk/market data, recompute derived fields, re-run deterministic rules (and any auditor check required by the active policy), re-check credit entitlement, create a **new atomic risk reservation**, finalize credit consumption exactly once, and only then issue a `human_approved` authorization. An approval never bypasses changed limits, pause, revocation, stale data or reservation failure.
- `agentReason` and `recentReads` inside `AuditorInput` are explicitly given to the model labeled "untrusted data, not instructions".

### 6.5 L5 — State and Risk Layer

**Responsibility:** Persistent state, atomic reservation, risk data and reconciliation.

**Sub-components**
- `Store` (SQLite, WAL mode): the tables in Section 8.
- `RiskProvider`: fetches balances, open orders, PnL and fee information with the ATK read key → `RiskSnapshot`.
- `MarketDataProvider`: ticker and instrument information (lot/tick) through ATK `market`.
- `ReservationManager`: limit check + reservation in a single SQLite transaction.
- `Reconciler`: at startup and periodically; matches `UNKNOWN` and open orders with OKX.

**Reservation states:** `reserved → submitted → (filled → reconciled) | released`.
- If sending is abandoned or OKX clearly rejects, `released`.
- If uncertain (`UNKNOWN`), the reservation is held, and released or converted into a real position depending on the reconciliation result; position and reservation are not counted at the same time.

**Reconciliation algorithm**
1. Take the `unknown` and `submitted` records from the `orders` table.
2. For each, query OKX by `clOrdId`.
3. Found → update to the real state and produce an `ExecutionEvent`. If lookup returns “not found”, query every authoritative OKX order source supported by the adapter (live/open + history where available). A mere “not found after grace” is **not** proof that the order was never accepted. If acceptance still cannot be disproved, keep `UNKNOWN` and its reservation; require later reconciliation/manual resolution. Release only on a verified pre-send failure or exchange semantics that positively establish non-acceptance.
4. A write whose outcome may have reached OKX is never retried. Read-only reconciliation queries may retry safely. The same `(policyId, requestId)` never receives a second execution authorization or a second OKX write.

**Invariants**
- Reservation and limit check are in the same transaction; no other decision can come between the two (single worker, serial queue).
- The rate counter and the daily PnL store are preserved across restarts.

### 6.6 L6 — Execution Layer

**Responsibility:** Write to the exchange only with a valid authorization, only the order in the authorization, only once.

**Credentials:** `OKX_TRADE_*` exists only in this process; L1–L5 and the agent never see it. The API key is not given withdrawal permission.

**Verification steps (all must hold)**
1. `signature` recovers exactly to configured `GUARD_SIGNER_ADDRESS`; EIP-712 domain is exact.
2. `expiresAt` has not passed; `nonce` is not in the nonce table and is marked at the moment of use (atomic).
3. When the received `NormalizedOrder` is re-normalized and hashed, it equals `normalizedOrderHash`.
4. `accountRef`, `tool`, `guardInstanceId` equal its own configuration.
5. Immediately before sending, query the executor-side `PolicyStateProvider`: policy/version/binding still match, delegation is not revoked/expired, and pause is false (except verified protective cancels). L6 never trusts L4’s cached assertion for this recheck.
6. Atomically consume the authorization nonce in L6’s persistent `executor_nonces` store and assert no prior execution row exists for `(policyId, requestId)`.
7. A `dispatching` write-ahead (WAL) record is written to the `orders` table **before the OKX call**; `submitted` is used only after an OKX submission/acknowledgement is observed.

**Sending**
- `spot_place_order` → spot order through ATK; `clOrdId` comes from the order in the authorization.
- `spot_cancel_order` → cancel through ATK.
- On failure: network/timeout → `unknown` (not resent; reconciliation takes over). Clear OKX rejection → `rejected_by_okx`.

**Output:** `ExecutionEvent`s (increasing `eventSeq`) to L5 and L7.

**Invariants**
- An extra field or a different value in the authorization → rejection, no exchange call.
- There is no second OKX write call for the same `requestId`.
- L6 does not reinterpret policy rules; it only verifies the validity and freshness of the authorization.

### 6.7 L7 — Evidence and Presentation Layer

**Sub-components**
- `AuditLog`: append-only, hash-chained (`prevHash`). After each `AuditEvent` is written it is queued for the chain.
- `ChainWriter`: reads from the `chain_outbox` table and writes to Avalanche; retries on failure; the execution flow does not depend on this write.
- `EventStream`: `GET /v1/events` (SSE); masked events for the dashboard.
- `Dashboard`: policy view, live feed, pending approvals, emergency stop button (requires a signature).
- `PauseGateway`: verifies `SignedPauseCommand`; writes a local `deny` state persistently; valid until the on-chain `Paused` event arrives, and restored on restart.

**Privacy:** The raw account number, API key and raw OKX response appear in none of the events; only hashes and masked fields.

---

## 7. Chain Layer (Avalanche C-Chain)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPolicyRegistry {
    struct PolicyRecord {
        address owner;
        bytes32 accountRef;
        address agentRegistry;
        uint256 agentRegistryId;
        address agentAuthAddress;
        bytes32 policyHash;       // keccak256(canonicalJson(policy))
        string  policyURI;
        uint64  version;
        uint64  delegationExpiresAt;
        bool    revoked;
        bool    paused;
    }

    event PolicyCreated(bytes32 indexed policyId, address indexed owner);
    event PolicyUpdated(bytes32 indexed policyId, bytes32 policyHash, uint64 version);
    event DelegationChanged(bytes32 indexed policyId, address agentAuthAddress, uint64 expiresAt, bool revoked);
    event PausedChanged(bytes32 indexed policyId, bool paused);

    // policyId = keccak256(abi.encode(msg.sender, accountRef, agentRegistry, agentRegistryId))
    function createPolicy(bytes32 accountRef, address agentRegistry, uint256 agentRegistryId, address agentAuthAddress,
                          uint64 delegationExpiresAt, bytes32 policyHash, string calldata policyURI)
        external returns (bytes32 policyId);

    // The following are owner-only; setPolicy prevents version races with expectedVersion.
    function setPolicy(bytes32 policyId, bytes32 policyHash, string calldata policyURI, uint64 expectedVersion) external;
    function setDelegation(bytes32 policyId, address agentAuthAddress, uint64 expiresAt, bool revoked) external;
    function setPaused(bytes32 policyId, bool paused) external;

    function getPolicy(bytes32 policyId) external view returns (PolicyRecord memory);
}

interface IDecisionLog {
    enum Verdict { Allow, Block, Pending, HumanApproved, HumanRejected }
    enum ExecStatus { Submitted, Acknowledged, Filled, PartiallyFilled, Cancelled, RejectedByOkx, Expired, Revoked, Unknown }

    event DecisionLogged(
        bytes32 indexed policyId, bytes32 indexed requestId, Verdict verdict,
        bytes32 policyHash, uint64 policyVersion, bytes32 normalizedOrderHash,
        bytes32 evidenceHash, uint16 reasonCode, bytes32 authHash
    );
    event ExecutionLogged(bytes32 indexed requestId, uint32 eventSeq, ExecStatus status, bytes32 okxResultHash);

    // LOGGER role (the gateway's log key); the role is assigned by the owner/deployer.
    function logDecision(bytes32 policyId, bytes32 requestId, Verdict verdict, bytes32 policyHash,
                         uint64 policyVersion, bytes32 normalizedOrderHash, bytes32 evidenceHash,
                         uint16 reasonCode, bytes32 authHash) external;

    // Preconditions: an Allow/HumanApproved decision must already be logged for the requestId;
    // eventSeq must be one more than the previous one; the status transition must be permitted.
    function logExecution(bytes32 requestId, uint32 eventSeq, ExecStatus status, bytes32 okxResultHash) external;
}
```

**Rules**
- On chain there are only hashes and identity references; no raw account data, order content or OKX response (these are kept in an off-chain archive).
- On chain, `requestId` is converted to `bytes32` as `keccak256(requestId string)`.
- `ExecutionLogged` means the gateway recorded a particular OKX response; it does not independently prove that OKX actually filled the order.
- A decision may exist that was never written to the chain; therefore "complete logging" is not claimed.

---

## 8. Storage Schema (SQLite)

```sql
-- policy cache
CREATE TABLE policies (
  policy_id TEXT PRIMARY KEY, version INTEGER NOT NULL, policy_hash TEXT NOT NULL,
  policy_json TEXT NOT NULL, agent_auth_address TEXT NOT NULL,
  delegation_valid_until INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
  paused_chain INTEGER NOT NULL DEFAULT 0, paused_local INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL
);

-- requests and their statuses
CREATE TABLE requests (
  request_id TEXT NOT NULL, policy_id TEXT NOT NULL,
  status TEXT NOT NULL, reason_code INTEGER,
  normalized_order_hash TEXT, normalized_order_json TEXT,
  received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (policy_id, request_id)
);

CREATE TABLE decisions (
  request_id TEXT NOT NULL, policy_id TEXT NOT NULL, policy_version INTEGER NOT NULL,
  kind TEXT NOT NULL, reason_code INTEGER NOT NULL, evidence_hash TEXT NOT NULL,
  rule_result_json TEXT NOT NULL, auditor_output_json TEXT, decided_at INTEGER NOT NULL,
  PRIMARY KEY (policy_id, request_id)
);

-- nonces (separate kinds for agent request, authorization, approval, pause)
CREATE TABLE nonces (
  kind TEXT NOT NULL, nonce TEXT NOT NULL, used_at INTEGER NOT NULL,
  PRIMARY KEY (kind, nonce)
);

-- L6 owns this store; do not share it with the gateway request-nonce table
CREATE TABLE executor_nonces (
  nonce TEXT PRIMARY KEY, policy_id TEXT NOT NULL, request_id TEXT NOT NULL, used_at INTEGER NOT NULL,
  UNIQUE(policy_id, request_id)
);

-- risk reservations
CREATE TABLE reservations (
  reservation_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, policy_id TEXT NOT NULL,
  notional_usdt TEXT NOT NULL, state TEXT NOT NULL,   -- reserved|submitted|released|reconciled
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

-- exchange orders (execution)
CREATE TABLE orders (
  request_id TEXT PRIMARY KEY, policy_id TEXT NOT NULL, cl_ord_id TEXT NOT NULL UNIQUE,
  ord_id TEXT, status TEXT NOT NULL, event_seq INTEGER NOT NULL DEFAULT 0,
  dispatching_at INTEGER, submitted_at INTEGER, last_okx_hash TEXT, updated_at INTEGER NOT NULL
);

-- reads
CREATE TABLE reads (
  read_id TEXT PRIMARY KEY, policy_id TEXT NOT NULL, fetched_at INTEGER NOT NULL,
  content_hash TEXT NOT NULL, excerpt TEXT NOT NULL, summary_json TEXT NOT NULL
);

-- rate counter
CREATE TABLE rate_events (policy_id TEXT NOT NULL, request_id TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (policy_id, request_id));

-- append-only audit log
CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, policy_id TEXT NOT NULL,
  request_id TEXT, type TEXT NOT NULL, payload_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);

-- chain write queue
CREATE TABLE chain_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, record_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, tx_hash TEXT, created_at INTEGER NOT NULL
);
```

`UPDATE`/`DELETE` on `audit_log` is blocked with triggers.

---

## 9. External Interfaces (HTTP)

| Method and path | Caller | Request | Response |
|---|---|---|---|
| `POST /v1/reads` | Agent | `ReadRequest` | `ReadSummary` |
| `POST /v1/intents` | Agent | `SignedIntentRequest` | `IntentResponse` |
| `GET /v1/intents/:requestId` | Agent/Dashboard | — | `IntentResponse` + latest `Decision` summary |
| `POST /v1/approvals` | Dashboard (owner-signed) | `SignedApproval` | `IntentResponse` |
| `POST /v1/pause` | Dashboard (owner-signed) | `SignedPauseCommand` | `{ok}` |
| `GET /v1/policy/:policyId` | Dashboard | — | Policy + hash + chain status |
| `GET /v1/events` | Dashboard | — | SSE: masked `AuditEvent` stream |
| `GET /v1/health` | Anyone | — | Component statuses |

**Internal interface (same process or separate process):**
```ts
interface Executor {
  execute(auth: ExecutionAuthorization, order: NormalizedOrder): Promise<ExecutionEvent[]>;
}
```
If run as a separate process, the transport is a local channel with mutual authentication (shared secret or mTLS); the agent cannot reach this channel.

**Error format (all endpoints):** `{ requestId?: UUID, status: OrderStatus | "ERROR", reasonCode?: ReasonCode, message: string }`. Messages contain no sensitive data.

---

## 10. Auditor LLM Adapter

```ts
interface Auditor {
  decide(input: AuditorInput, opts: { timeoutMs: number }): Promise<AuditorOutput>;
}
```

- **Providers:** `JevAuditor` (the Jev model; Unverified: access path and output format) and `GenericLlmAuditor` (the same three questions with structured output). Mapping to the `AuditorOutput` format is the adapter's responsibility.
- **Questions:** is the order consistent with the mandate (`consistency`), is there a trace of steering in what was read (`injectionSuspicion`), the verdict (`allow/block/askHuman`).
- A **timeout** and out-of-schema output produce `PENDING 302` (P4).
- **Context separation:** the auditor call is separate from the agent's LLM context (separate prompt, separate call, no shared history).
- **Thresholds** (`maxInjectionSuspicion`, `minConsistency`, `minVerdictConfidence`) are kept in the policy and are heuristic; they are not called "calibrated" without measurement.

---

## 11. Order State Machine

```text
RECEIVED
 ├─► REJECTED_AUTH | REJECTED_SCHEMA | REJECTED_POLICY | REJECTED_PAYMENT (terminal)
 └─► POLICY_CHECKED
      ├─► BLOCKED                                                (terminal)
      ├─► PENDING ─► APPROVED ─► (rule re-check) ─► ALLOWED | BLOCKED
      │            ├► REJECTED_BY_HUMAN                          (terminal)
      │            └► EXPIRED (= BLOCK)                          (terminal)
      └─► ALLOWED ─► RECHECKED ─► SUBMITTED ─► ACKNOWLEDGED ─► FILLED | CANCELLED
                       └► PARTIALLY_FILLED ─► PARTIALLY_FILLED | FILLED | CANCELLED
                       │                    └► REJECTED_BY_OKX  (terminal)
                       ├─► REVOKED   (policy version/pause/delegation changed)
                       └─► EXPIRED   (authorization expired)
           SUBMITTED ─(timeout)─► UNKNOWN ─(reconciliation)─► ACKNOWLEDGED | FILLED | CANCELLED | REJECTED_BY_OKX | (not sent → released)
```

**Rules**
- `ALLOWED` does not mean filled on the exchange.
- Transitions are made only by L4 (decision), L6 (execution) and L5 (reconciliation), within their own areas of responsibility; every transition writes an `AuditEvent`.
- The `(policyId, requestId)` pair is processed once; a repeated request returns the existing state.

---

## 12. Reason Codes (ReasonCode)

| Range | Meaning | Examples |
|---|---|---|
| 000–099 | Identity / schema / policy / service entitlement | 000 identity/delegation; 001 schema/tool; 002 insufficient authorization; 003 policy/hash/expiry could not be verified; 004 insufficient service credit/payment entitlement |
| 100–199 | Deterministic rule violation | 100 paused; 101 instrument; 102 tool; 103 single-order limit; 104 open notional; 105 rate; 106 daily loss; 107 price deviation; 110 stale data |
| 200–299 | Auditor block | 201 injection suspicion; 202 inconsistent order; 203 auditor "block" |
| 300–399 | Routed to a human | 301 auditor "ask human"/low confidence; 302 auditor unreachable; 303 amount above threshold |
| 400–499 | Execution | 401 authorization invalid; 402 authorization expired; 403 hash mismatch; 404 nonce reuse; 405 policy version changed |
| 500–599 | Infrastructure | 501 store error; 502 OKX timeout; 503 chain write delayed |

---

## 13. Invariants (Testable Guarantees)

| Code | Invariant |
|---|---|
| INV-1 | No OKX trade/read key exists in the agent process |
| INV-2 | No component other than L6 can make an OKX write call |
| INV-3 | `forbiddenTools`, unknown tools and out-of-schema fields do not reach L4 |
| INV-4 | `riskIncreasing` and `verifiedProtectiveAction` are derived only by L4 |
| INV-5 | The auditor output cannot turn a `BLOCK` into an `ALLOW` |
| INV-6 | `PENDING` becomes `ALLOWED` only with a valid owner signature and a successful re-run of the rules |
| INV-7 | Authorization: it cannot pass L6 with a different order, account, policy version, gateway, expired, or used nonce |
| INV-8 | The same `(policyId, requestId)` produces at most one OKX write call |
| INV-9 | On timeout the order is not resent; it is only queried by `clOrdId` |
| INV-10 | Reservation and limit check are atomic; parallel requests cannot exceed the total limit |
| INV-11 | A policy is not considered valid unless its hash matches the on-chain one |
| INV-12 | If risk data, market data, policy or the auditor (where required) is missing, a risk-increasing order does not pass |
| INV-13 | The protective exception covers only the cancellation of a verified own open order |
| INV-14 | `audit_log` is append-only; a broken hash chain is detected |
| INV-15 | A chain write failure does not change the execution decision; the event waits in the durable queue |
| INV-16 | Raw external content does not enter the agent context or the L4 decision context raw |

---

## 14. Failure and Fault Behaviors

| Fault | Behavior |
|---|---|
| Policy could not be read from the chain, cache TTL expired | Risk-increasing orders `BLOCK 003`; a protective cancel passes if the policy cache is valid |
| Policy JSON hash does not match the chain | Policy invalid → `BLOCK 003` |
| Risk/market data stale | Risk-increasing order `BLOCK 110` |
| Auditor timeout/error | `PENDING 302`; no automatic `ALLOW` |
| SQLite could not be written | Request rejected (`501`); nothing is sent to the exchange |
| OKX timeout | `UNKNOWN`, reservation held, reconciliation |
| Clear OKX rejection | `REJECTED_BY_OKX`, reservation released |
| Chain write fails | Retry in `chain_outbox`; shown to the user as a delay |
| Process restart | Policy cache, nonces, reservations and the local `paused` state are loaded from disk; then reconciliation runs |
| Gateway signing key unavailable | No new authorization can be produced; no order passes |

---

## 15. Module Boundaries (For Distribution to Coding Agents)

Each package talks to the others only through the **public interfaces** below. Shared types are defined only in `shared`, and other packages import them from there; packages do not import each other's internal files.

```text
/packages
  /shared       types (Section 5), canonicalJson, hash/signature helpers, decimal arithmetic, zod schemas
  /agent        L2: MarketObserver, SignalGenerator, Reviewer, IntentBuilder
  /ingest       L1: Fetcher, Sanitizer, ReaderModel, ReadRecorder
  /gateway      L3 + L4 + L5 + server side of L7 (HTTP server, policy engine, store)
  /executor     L6: authorization verification, ATK client, reconciliation helpers
  /chain        contracts (Section 7), log/policy clients, outbox worker
  /dashboard    dashboard (consumes only HTTP/SSE)
/tests
  /invariants   INV-1…INV-16 tests
  /attacks      injection, impersonation, tampering, replay, parallel race scenarios
```

### 15.1 Interfaces exposed by the packages

```ts
// shared
export function canonicalJson(value: unknown): string;
export function hashCanonical(value: unknown): Hex;
export function normalizeOrder(intent: OrderIntent, instrument: InstrumentInfo, requestId: UUID, policyId: Hex): NormalizedOrder;
export const schemas: { signedIntentRequest: ZodType<SignedIntentRequest>; /* ... */ };
export function dec(a: Dec): DecimalOps;   // addition, subtraction, comparison; no floats

// ingest
export interface IngestService {
  read(req: ReadRequest): Promise<ReadSummary>;
}

// gateway (internal modules)
export interface IntentGate     { validate(req: SignedIntentRequest): Promise<ValidatedIntent | IntentResponse>; }
export interface PolicyEngine   { decide(v: ValidatedIntent): Promise<Decision>; }
export interface RiskStore {
  snapshot(policyId: Hex): Promise<RiskSnapshot>;
  reserve(r: ReservationRequest): Promise<ReservationResult>;
  release(requestId: UUID): Promise<void>;
}
export interface Authorizer     { sign(d: Decision, v: ValidatedIntent): Promise<ExecutionAuthorization>; }
export interface AuditSink      { append(e: Omit<AuditEvent, "seq" | "prevHash" | "hash">): Promise<void>; }

// executor
export interface Executor { execute(auth: ExecutionAuthorization, order: NormalizedOrder): Promise<ExecutionEvent[]>; }
export interface PolicyStateProvider {
  getExecutionState(policyId: Hex): Promise<{ policyVersion: number; accountRef: Hex; agentRegistry: Hex; agentRegistryId: string; agentAuthAddress: Hex; delegationValidUntil: EpochSec; revoked: boolean; paused: boolean }>;
}
export interface AtkClient {
  placeSpotOrder(o: NormalizedOrder): Promise<AtkResult>;
  cancelSpotOrder(o: NormalizedOrder): Promise<AtkResult>;
  getOrderByClOrdId(instId: string, clOrdId: string): Promise<AtkOrder | null>;
}

// chain
export interface PolicyChainClient {
  getPolicy(policyId: Hex): Promise<PolicyRecord>;
  watchPause(policyId: Hex, cb: (paused: boolean) => void): () => void;
}
export interface DecisionChainWriter { enqueue(r: ChainRecord): Promise<void>; }

// auditor
export interface Auditor { decide(i: AuditorInput, o: { timeoutMs: number }): Promise<AuditorOutput>; }
```

### 15.2 Dependency direction between packages

```text
shared  ←  agent
shared  ←  ingest
shared  ←  chain
shared  ←  executor  ← (PolicyStateProvider through an authenticated read-only adapter)
shared  ←  gateway  ← (ingest, chain, executor, auditor only through interfaces)
shared  ←  dashboard (HTTP only)
```
- `agent` depends only on `shared` and Leash Agent's HTTP endpoints; it does not import `gateway`, `executor` or `chain`.
- `executor` uses `ExecutionAuthorization` and `NormalizedOrder` from `shared`, not `gateway`'s internal types. Its policy recheck is performed through `PolicyStateProvider` backed by an authenticated chain/read adapter; it must not call an unauthenticated gateway endpoint.
- `dashboard` imports no internal package; it uses only `shared` types and HTTP/SSE.

---

## 16. Configuration

Secret values are provided through environment variables or a secret manager; they are not written to the repository and do not enter events.

| Name | Used by | Description |
|---|---|---|
| `OKX_READ_KEY/SECRET/PASSPHRASE` | gateway (L5) | Read-only account queries |
| `OKX_TRADE_KEY/SECRET/PASSPHRASE` | **executor only** | Trade-enabled; no withdrawal permission |
| `OKX_SITE`, `OKX_PROFILE` | gateway, executor | Site and profile selection (demo/live); Unverified: demo profile name |
| `GUARD_SIGNING_KEY` | gateway (Authorizer) | Authorization signing key |
| `GUARD_SIGNER_ADDRESS` | **executor** | Only gateway signer address accepted by L6; must correspond to the configured signing key |
| `GUARD_INSTANCE_ID` | gateway, executor | Instance ID to which the authorization is bound |
| `CHAIN_RPC_URL`, `CHAIN_ID` | chain | Fuji: 43113 |
| `POLICY_REGISTRY_ADDRESS`, `DECISION_LOG_ADDRESS` | chain | Contract addresses |
| `LOGGER_PRIVATE_KEY` | chain (outbox) | `DecisionLog` LOGGER role key |
| `AUDITOR_PROVIDER`, `AUDITOR_API_KEY`, `AUDITOR_TIMEOUT_MS` | gateway | Auditor selection and access |
| `READER_MODEL_*` | ingest | Tool-less reader model settings |
| `AGENT_AUTH_KEY` | agent | The agent's request signing key (signing only) |
| `UNKNOWN_GRACE_SEC`, `POLICY_CACHE_TTL_SEC` | gateway | Reconciliation and cache durations |

---

## 17. ATK Integration

- **Agent side:** `okx-trade-mcp --modules market --read-only` (keyless). Reads only market data.
- **Gateway side (L5):** account queries with the read-enabled key (balance, open orders, ownership verification, PnL) and `market` (ticker, instrument information).
- **Executor side (L6):** writing and canceling orders with the trade-enabled key. No other component sees this key.
- **Abstraction:** the `AtkClient` interface wraps ATK (CLI or MCP); the upper layers do not know ATK's transport form.
- **Unverified:** (a) the confirmation-prompt behavior of ATK write operations under programmatic use, (b) demo account/profile selection, (c) the quantity-unit (`tgtCcy`) semantics for market orders, (d) `clOrdId` constraints, (e) TR site support. These must be tested in the `AtkClient` implementation; depending on the result, only `AtkClient` and `normalizeOrder` change.
- **P0 market-buy spike:** before relying on notional/risk calculations, place/query a minimal OKX demo spot market-buy and verify the exact `sz` unit and `tgtCcy` behavior through the actual ATK path. Leash Agent must set `tgtCcy` explicitly when required (expected candidate: `base_ccy`) and must normalize/notional-calculate from the confirmed exchange semantics. If the observed behavior differs, update `NormalizedOrder`, `normalizeOrder`, and the notional calculation together before enabling market buys.

---

## 18. Avalanche Integration

- `PolicyRegistry`: the single source of truth for the policy hash, version, ERC-8004 registry binding, delegation and pause state.
- `DecisionLog`: hashes of decision and execution events.
- A policy change and a pause are transactions of the owner wallet; the gateway watches chain events (`watchPause`) and updates its local state.
- The fast-finality advantage is shown by measuring the finality time of policy/pause transactions and log writes.

---

## 19. Unverified Assumptions and Open Points

1. How ATK's write confirmation behaves in a programmatic flow; whether it can be automated.
2. OKX demo profile/account selection and TR site support.
3. The quantity unit for market orders and `clOrdId` format constraints.
4. The access path and output format of the Jev model; if absent, `GenericLlmAuditor`.
5. Which network (Fuji/mainnet) is required for Avalanche C-Chain.
6. The agent's strategy parameters (which averages, which instrument) and the `mandate` text.
7. How PnL will be computed from OKX for risk data (which fields, fees included).
8. User account ownership verification: a wallet signature does not prove OKX account ownership; the `ownerWallet ↔ accountRef` mapping is operator configuration and is a trust assumption.

## 20. Known Limitations

- A bad trade within the limits can pass; the system limits loss, it does not eliminate it.
- The daily loss limit is not an absolute ceiling (gaps, latency, slippage).
- The auditor LLM can be wrong and is itself open to prompt injection; it is an additional signal, not a security boundary.
- The gateway server and the signing key are a trust assumption.
- The reservation guarantee holds within a single worker; multiple workers are out of scope for this version.
- The chain record does not prove that all decisions were logged completely or that the OKX fill is accurate.

---

## 21. Agentic Web3 Service Layer (Hackathon Extensions)

This section restores the product/hackathon integrations intentionally kept outside the core security boundary. None of x402, ERC-8004, or TEE may weaken or bypass Sections 1–20. The core remains usable if these extensions are disabled.

### 21.1 Boundary rule

The responsibilities are deliberately separate:

- **ERC-8004:** public discovery/identity metadata and, later, validation/reputation references. It is not runtime authentication and does not grant authority over an OKX account.
- **x402:** payment/service entitlement. It is not an execution authorization and cannot override policy, identity, risk, pause, or executor checks.
- **Agent EIP-712 signature + PolicyRegistry delegation:** runtime authentication and user authorization.
- **Leash Agent ExecutionAuthorization:** the only order-bound authorization accepted by L6.
- **TEE:** optional trust hardening for Leash Agent's own enforcement/signing boundary; not required for the core protocol to function.

The end-to-end product flow is:

```text
ERC-8004 registry
      │ discover Leash Agent service
      ▼
Trading Agent ── x402 payment ──► Service entitlement / credits
      │
      │ EIP-712 SignedIntentRequest
      ▼
L3 authentication + delegation
      ▼
L4 policy + auditor ── L5 risk/reservation
      ▼
order-bound ExecutionAuthorization
      ▼
L6 isolated executor ──► OKX
      │
      └──► L7 audit/outbox ──► Avalanche

Optional hardening:
L4 signer and, later, L6 trade credential ──► attested TEE boundary
```

### 21.2 x402 — Service Payment and Credits (P1)

**Purpose:** allow an autonomous agent to purchase Leash Agent security checks without turning payment into security authority.

For the hackathon, the product model is **one settled x402 payment → 5 risk-increasing intent credits**. The exact facilitator/network integration is an implementation-time dependency and remains **Unverified** until tested.

```ts
export type ServiceCredit = {
  paymentRef: string;               // unique settlement/payment reference
  policyId: Hex;
  agentId: string;
  payer: Hex;                       // must equal the active delegated agentAuthAddress
  purchased: number;
  remaining: number;
  createdAt: EpochSec;
};
```

**Rules**

1. No credit is created until the payment adapter reports successful settlement according to the selected x402 flow.
2. `paymentRef` is unique; replaying the same payment cannot mint credits twice.
3. Credits are bound to `policyId + agentId + payer`; settlement is accepted for that entitlement only when `payer == activeDelegation.agentAuthAddress`. A copied `agentId`, payment reference or credit row is insufficient.
4. L3 performs no credit decision because `riskIncreasing` is an L4-derived field. After L3 authentication/normalization, L4 verifies policy/state, computes the derived fields, and only then checks credit entitlement for a risk-increasing request.
5. The credit lifecycle is `available → reserved → consumed | released`. Entitlement may be reserved after `riskIncreasing` is known, but final consumption happens only after deterministic/auditor/human gates pass, fresh state is re-checked, and the risk reservation succeeds. `BLOCK` and `PENDING` do not burn a credit.
6. Consumption is idempotent on `(policyId, requestId)`. A repeated request returns the stored state and never consumes a second credit. If execution cannot be durably attempted after finalization, reconciliation releases/refunds the reserved entitlement according to the persisted credit state.
7. Running out of credits never grants a bypass. A risk-increasing request becomes `REJECTED_PAYMENT` / reason code `004`.
8. A verified protective `spot_cancel_order` does **not** require credit; safety actions must remain available when credits are exhausted or the policy is paused.
9. Payment success cannot turn a deterministic `BLOCK`, `PENDING`, invalid delegation, stale policy, or invalid authorization into `ALLOW`.

**Adapter boundary**

```ts
export interface PaymentEntitlement {
  reserveCredit(policyId: Hex, agentId: string, payer: Hex, requestId: UUID): Promise<
    | { ok: true; creditReservationId: string }
    | { ok: false; paymentRequired: true; paymentChallenge?: unknown }
  >;
  consumeReservedCredit(policyId: Hex, requestId: UUID): Promise<void>;
  releaseReservedCredit(policyId: Hex, requestId: UUID, reason: string): Promise<void>;
}
```

The concrete x402 facilitator/provider lives behind this interface. Core packages do not depend on provider-specific types.

### 21.3 ERC-8004 — Discovery, Identity Metadata and Validation (P1/P2)

**P1 purpose:** publish Leash Agent and the trading agent as discoverable agent/service identities. The runtime authentication address used by L3 remains the authority for signed requests.

Leash Agent service metadata should expose only public information, for example:

```json
{
  "name": "Leash Agent",
  "kind": "agent-security-gateway",
  "capabilities": ["okx-spot-policy-enforcement", "signed-execution-authorization", "audit-evidence"],
  "endpoints": { "intents": "/v1/intents", "health": "/v1/health" },
  "payment": { "protocol": "x402" },
  "network": { "policyEvidence": "Avalanche C-Chain" }
}
```

The concrete ERC-8004 registry addresses, metadata format and SDK/API are **Unverified** until implementation-time documentation checks.

**Security rule:** an ERC-8004 identity record is not sufficient to pass L3. L3 still verifies the `agentAuthAddress`, EIP-712 request signature, nonce, delegation and policy binding defined in Sections 5–7.

**P2 validation:** an independent validator may replay the deterministic portion of a decision using the referenced policy version, normalized order, risk evidence and rule result. The validator should distinguish:

- deterministic policy replay, which can be recomputed;
- auditor/Jev semantic judgment, which is heuristic and must not be represented as deterministic proof.

Reputation, if later used, must come from external feedback/validators; Leash Agent's own blocked-order counters are not independent reputation.

### 21.4 TEE — Optional Attested Enforcement Hardening (P2)

TEE is not part of the hackathon's minimum security claim. The current architecture explicitly trusts the gateway process and `GUARD_SIGNING_KEY`. TEE narrows that trust assumption.

**TEE Lite target:** move the deterministic policy decision core and `AuthorizationSigner` into a measured environment. The authorization signing private key is generated inside, or cryptographically bound to, that attested environment and is not exportable.

Attestation verification must bind at least:

- an allowlisted software measurement/version;
- freshness via a verifier challenge/nonce;
- the Leash Agent authorization public key;
- the expected service/environment identity.

L6 accepts an authorization signer only when the signer key is associated with a currently acceptable attestation. Tests must reject a wrong measurement, stale attestation and invalid signature.

**Critical limitation:** if `OKX_TRADE_*` remains outside the TEE in L6, the executor/operator is still trusted not to bypass Leash Agent. Therefore TEE Lite must not be described as "all execution is protected by TEE."

**Production target:** move the policy/risk enforcement path and OKX trade credential access into the attested enforcement boundary, with key rotation and revocation. TEE does not prove that policy code is bug-free, the auditor is correct, market data is truthful, OKX fills are accurate, or chain logging is complete.

### 21.5 Extension Storage

If x402 is implemented, add a durable entitlement table:

```sql
CREATE TABLE service_credits (
  payment_ref TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  payer TEXT NOT NULL,
  purchased INTEGER NOT NULL,
  remaining INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE credit_consumptions (
  policy_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payment_ref TEXT NOT NULL,
  state TEXT NOT NULL,              -- reserved|consumed|released
  reserved_at INTEGER NOT NULL,
  consumed_at INTEGER,
  released_at INTEGER,
  PRIMARY KEY (policy_id, request_id)
);
```

Credit reservation/finalization and the corresponding row transition must be transactional and idempotent. `BLOCK`/`PENDING` release any temporary entitlement reservation. A duplicate request never decrements twice. The payer stored for the payment must match the active delegated `agentAuthAddress`.

### 21.6 Extension Interfaces

Optional integrations are exposed through interfaces so the core remains provider-independent:

```ts
export interface ServiceDiscovery {
  publishLeash(metadata: unknown): Promise<string>;
  publishAgent(metadata: unknown): Promise<string>;
}

export interface PaymentEntitlement {
  reserveCredit(policyId: Hex, agentId: string, payer: Hex, requestId: UUID): Promise<
    | { ok: true; creditReservationId: string }
    | { ok: false; paymentRequired: true; paymentChallenge?: unknown }
  >;
  consumeReservedCredit(policyId: Hex, requestId: UUID): Promise<void>;
  releaseReservedCredit(policyId: Hex, requestId: UUID, reason: string): Promise<void>;
}

export interface AttestationVerifier {
  isAuthorizedSigner(address: Hex): Promise<boolean>;
}
```

Suggested package additions:

```text
/packages
  /payments      x402 adapter + durable entitlement logic
  /identity      ERC-8004 discovery/metadata adapter
  /attestation   optional TEE attestation verifier
```

The gateway depends on these only through interfaces. L6 may depend on `AttestationVerifier` only when TEE mode is enabled.

### 21.7 Additional Reason Codes and Invariants

Use reason code `004` for missing service entitlement on a risk-increasing request. Reason code `002` remains reserved for insufficient authorization and must never be used for payment/credit failures.

Additional testable invariants:

| Code | Invariant |
|---|---|
| INV-17 | An x402 payment/credit cannot bypass identity, delegation, policy, risk, pause, auditor or L6 authorization checks |
| INV-18 | The same payment reference cannot create credits twice; the same request cannot consume credit twice |
| INV-19 | Credits are bound to the authenticated `policyId + agentId`; another agent cannot spend them |
| INV-20 | ERC-8004 identity/discovery metadata is never accepted as runtime authorization by itself |
| INV-21 | A verified protective cancel remains available without credit, subject to the existing ownership/freshness checks |
| INV-22 | In TEE mode, an authorization from a signer without an accepted fresh attestation is rejected by L6 |

---

## 22. Hackathon Scope and Integration Order

The engineering architecture above is the source of truth for implementation. The following priority order prevents optional Web3 integrations from destabilizing the enforcement core.

### P0-A — End-to-end core

- L2 trading agent produces and signs a real intent.
- L3 authenticates and normalizes it.
- L4 applies a minimal deterministic spot policy.
- L5 obtains risk state and persists state.
- L6 executes one allowed order in the OKX demo environment.
- L7 produces local audit evidence and queues Avalanche evidence.

**Exit condition:** one allowed order traverses the entire real path.

### P0-B — Security guarantees

- EIP-712 agent authentication and owner delegation.
- Strict schema/tool allowlist and deterministic normalization.
- Order-bound `ExecutionAuthorization`.
- Persistent nonce/replay protection.
- Policy version/pause/delegation recheck immediately before execution.
- Atomic persistent risk reservation.
- WAL/idempotency/UNKNOWN reconciliation.
- PolicyRegistry + DecisionLog on Fuji.
- INV-1 through INV-16 passing.

**Exit condition:** allowed order executes; tampered, unauthorized, stale, repeated and limit-violating orders do not reach OKX.

### P1 — Agentic Web3 differentiation

- Auditor/Jev adapter and attack scenarios.
- x402 payment → durable service credits.
- ERC-8004 Leash Agent + trading-agent discovery identities.
- Dashboard/live evidence feed and emergency pause.
- INV-17 through INV-21 passing for implemented extensions.

**Exit condition:** the agent can discover Leash Agent, obtain service entitlement, authenticate, request an order, and receive a policy-enforced result without weakening P0.

### P2 — Trust hardening / polish

- TEE Lite only if a working attestation path is already available and P0/P1 are stable.
- ERC-8004 independent deterministic validation.
- Human approval notification UX.
- UI polish and richer evidence presentation.

**TEE exit condition:** fresh expected measurement + signer accepted; wrong measurement, stale attestation and wrong signer rejected (INV-22).

### Cut rules

- If P0-A is not working end-to-end, do not work on x402, ERC-8004 or TEE.
- If P0-B is not stable, freeze new integrations and finish security invariants.
- TEE never displaces time needed for the real OKX demo, negative security tests, or presentation rehearsal.

---

## 23. Final Product Story and Demo Path

The architecture and hackathon story are intentionally aligned:

1. The trading agent discovers Leash Agent through ERC-8004 metadata (when P1 is enabled).
2. It obtains service entitlement through x402; payment creates credits but grants no trading authority.
3. The authenticated agent signs an `OrderIntent`; the user's on-chain policy/delegation determines what that agent may request.
4. Leash Agent normalizes the order, applies deterministic policy/risk checks, and optionally tightens the decision with the auditor.
5. An allowed order receives a single-use, order-bound EIP-712 `ExecutionAuthorization`.
6. The isolated executor re-verifies the authorization and current policy state immediately before the OKX write.
7. Local append-only evidence is produced and asynchronously anchored to Avalanche.
8. A tampered order, replay, impersonation, forbidden request or over-limit request is rejected before the exchange write.
9. If TEE Lite is enabled, the executor additionally verifies that the authorization signer belongs to the accepted attested Leash Agent environment.

**Final defensible claim remains unchanged:**

> On an account managed by Leash Agent, an order that violates the verified user policy and increases risk does not reach the exchange through Leash Agent.

x402, ERC-8004 and TEE strengthen the product story, distribution/economics and trust model respectively; none expands this claim beyond the conditions and limitations in Sections 0 and 20.

---

## 24. Additional Unverified Integration Points

Add these to the implementation-time verification list:

1. The selected x402 facilitator/provider, settlement semantics, replay/idempotency identifier and Avalanche Fuji support.
2. ERC-8004 registry addresses, supported network, metadata schema and SDK/API used for service/agent publication and discovery.
3. If TEE is attempted: selected platform availability, hardware/attestation type, verifier API, measurement semantics, freshness mechanism and signer-key binding.
4. Whether the chosen x402 and ERC-8004 implementations can be demonstrated reliably within hackathon network/account constraints.

Until verified, these integrations must stay behind adapters and must not be required for P0 execution safety.


---

## 25. Canonical Consistency Freeze

This section resolves cross-section ambiguities. If an older sentence conflicts with this section, this section wins until `shared/types.ts` and deployed contract ABIs are imported and mechanically checked.

### 25.1 Canonical identity and policy binding

- Runtime authority is `agentAuthAddress` + EIP-712 delegation; ERC-8004 alone grants no authority.
- The policy identity is bound to the ERC-8004 registry identity: `policyId = keccak256(abi.encode(owner, accountRef, agentRegistry, agentRegistryId))`.
- `agentId` is application/display metadata and must resolve to the same `(agentRegistry, agentRegistryId)`; it is not independently trusted for policy identity.
- x402 payer must equal the currently delegated `agentAuthAddress`.

### 25.2 Canonical status and reason vocabulary

- Payment/credit failure: `REJECTED_PAYMENT`, reason `004`.
- `002` is authorization-only and is never used for payment.
- Contract pause mutator is `setPaused`; HTTP entry point remains `POST /v1/pause`; both produce the same canonical pause state/event.
- Execution spelling is canonicalized as TypeScript `PARTIALLY_FILLED`, adapter/store `partially_filled`, Solidity `PartiallyFilled`. Mapping is explicit; these are the same semantic state.
- `PARTIALLY_FILLED` may transition to another `PARTIALLY_FILLED`, `FILLED`, or `CANCELLED` event with strictly increasing `eventSeq`.

### 25.3 Canonical decision / reservation / credit order

```text
L3 authenticate + schema + normalize
  -> L5 idempotent rate event
  -> L4 verify policy/delegation/hash/version
  -> fresh state + derive riskIncreasing/protective/notional
  -> pause/protective gate
  -> reserve/check credit if riskIncreasing
  -> deterministic rules
  -> auditor / human threshold
  -> if PENDING: release temporary reservations; wait for owner
  -> on fresh allow/human approval: re-read state + re-run state-dependent rules
  -> atomic risk reservation
  -> finalize credit exactly once
  -> issue exactly one ExecutionAuthorization for requestId
  -> L6 PolicyStateProvider recheck + executor nonce consume + dispatching WAL
  -> OKX write once
  -> reconcile; never blind-retry an uncertain write
```

### 25.4 Canonical ownership of mutable state

| State | Owner | Rule |
|---|---|---|
| agent request nonce | L3/gateway | persistent; replay rejects |
| rate event | L5, written after successful L3 validation | blocked post-L3 place intents count; duplicate request does not |
| risk reservation | L5 | atomic with limit check |
| credit reservation/consumption | payment entitlement store coordinated by L4 | BLOCK/PENDING do not consume |
| authorization nonce | L6/executor | separate persistent `executor_nonces`; never shared with gateway |
| policy/pause/delegation truth | PolicyRegistry + authenticated cache | L4 and L6 independently recheck |
| execution write idempotency | L6 | unique `(policyId, requestId)` + deterministic `clOrdId`; at most one OKX write |

### 25.5 Retry rule

A retry of the HTTP request with the same `(policyId, requestId)` is a **read of the existing state**, not a new attempt. It does not mint a new authorization nonce, reserve another credit, create another risk reservation, or call OKX again. Only read-only reconciliation calls may retry. `UNKNOWN` remains `UNKNOWN` until positive exchange evidence resolves it; “not found” alone is not sufficient to infer “never sent” unless the OKX adapter has verified that semantic.

### 25.6 Market-buy freeze gate

Market buy remains disabled until the P0 OKX demo spike verifies `sz`/`tgtCcy` semantics through the exact ATK path used by L6. The observed semantics must be reflected together in `OrderIntent`, `NormalizedOrder`, `normalizeOrder`, and notional calculation.

### 25.7 Mechanical consistency gate before merge

Before implementation branches merge, CI must compare/compile the architecture-facing constants and types against `packages/shared/types.ts` and contract ABIs. At minimum: `OrderStatus`, `ExecStatus`, `ReasonCode`, EIP-712 fields/domain, `PolicyBinding`, `policyId` derivation, `PolicyRegistry` function/event names, `DecisionLog` enums/transitions, and policy field names. **The actual repository files are the implementation source of truth once frozen; this document must be updated in the same PR when those public types change.**

---

## 26. Component Boundaries and Integration Checkpoints

Components are split to minimize overlapping files. `packages/shared/types.ts`, EIP-712 schemas, contract ABIs, reason codes and state enums are frozen first; after that, a change to them is a cross-component change made in one reviewed commit with all callers updated.

| Component | Scope | Deliverables | Must not / depends on | Done when |
|---|---|---|---|---|
| **Security core + OKX execution** (`gateway`, `executor`, `atk`) | L3/L4/L5/L6, SQLite, policy/risk engine, normalization, reservation, rate counter, executor, OKX/ATK | DB migrations; deterministic rules; `PolicyStateProvider`; `GUARD_SIGNER_ADDRESS`; executor nonce store; `clOrdId`; UNKNOWN reconciliation; market-buy spike; invariant tests for auth/order tamper/replay/race | Does not implement x402/ERC-8004 contracts or the agent LLM; consumes the frozen shared types and the chain client | Allowed demo order reaches OKX once; forbidden/tampered/replayed/over-limit orders never do; timeout never causes blind resend |
| **Agent, AI and dashboard** (`agent`, `ingest`, `auditor`, `llm`, `dashboard`) | L1/L2, agent loop, Jev/auditor adapter, attack scenarios, dashboard/SSE UX | Ingest isolation; signal/reason/intent creation; EIP-712 intent signing with the shared helper; Jev adapter; protected vs unprotected injection demo; policy/decision/execution UI; human approval + emergency-pause UI; end-to-end demo script | No OKX key; no policy-rule duplication in the UI or agent; no contract schema changes | Agent autonomously produces signed intents; injection demo is reproducible; dashboard shows ALLOW/BLOCK/PENDING/REJECTED_PAYMENT and evidence |
| **Web3, authorization and payments** (`shared`, `chain`, `payments`, `identity`, `attestation`) | Avalanche contracts/client, EIP-712 shared crypto, x402, ERC-8004, durable chain outbox, TEE Lite attestation | Frozen `shared` auth/types; `PolicyRegistry`, `DecisionLog`, Fuji deploy/tests; ERC-8004 identity binding; x402 payer/credit lifecycle; chain writer/outbox; contract ABI/client; negative contract tests; attested-signer verifier (§21.4) | Does not change L4 risk semantics or the L6 OKX execution path | Unauthorized/duplicate/invalid transitions revert; policyId matches the shared helper; payer == delegated auth address; x402 duplicate cannot mint/consume twice; agent/Leash Agent identities discoverable |

### 26.1 Integration checkpoints

1. **Freeze checkpoint:** `types.ts` + EIP-712 + contract ABI + `policyId` test vector are verified against each other (TS and Solidity); every component consumes them without redefining them.
2. **Core checkpoint:** the gateway exposes `/v1/intents`, status/SSE and the executor path; the agent can send a signed intent; the chain client provides a real policy.
3. **Web3 checkpoint:** x402 and ERC-8004 sit behind adapters; entitlement is wired into the L4 position defined in §25.3; payment and discovery appear in the demo.
4. **Attack checkpoint:** one acceptance suite runs against the real gateway: impersonation, signature tamper, replay, policy pause/version change, no credit, duplicate payment, limit race, prompt injection, OKX timeout/UNKNOWN.
5. **TEE:** only after P0/P1 pass. TEE Lite (attested signer, INV-22) is implemented with a simulated platform and an Intel TDX adapter; running it on live TDX hardware is a deployment step (docs/TEE.md).
