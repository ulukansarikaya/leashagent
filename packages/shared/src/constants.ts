import type { ReasonCode } from "./types";

/** Reason codes (architecture §12, §21.7). 002 is authorization-only; payment is 004. */
export const REASON = {
  // 000–099 identity / schema / policy / entitlement
  IDENTITY_DELEGATION: 0,
  SCHEMA_OR_TOOL: 1,
  INSUFFICIENT_AUTHORIZATION: 2,
  POLICY_UNVERIFIED: 3,
  PAYMENT_REQUIRED: 4,
  // 100–199 deterministic rules
  PAUSED: 100,
  INSTRUMENT: 101,
  TOOL: 102,
  SINGLE_ORDER_LIMIT: 103,
  OPEN_NOTIONAL: 104,
  RATE: 105,
  DAILY_LOSS: 106,
  PRICE_DEVIATION: 107,
  /** PROPOSED (not in §12): sell exceeds available base inventory (§6.4). Needs freeze agreement. */
  SELL_INVENTORY: 108,
  STALE_DATA: 110,
  // 200–299 auditor block
  AUDITOR_INJECTION: 201,
  AUDITOR_INCONSISTENT: 202,
  AUDITOR_BLOCK: 203,
  // 300–399 human
  ASK_HUMAN: 301,
  AUDITOR_UNREACHABLE: 302,
  ABOVE_THRESHOLD: 303,
  // 400–499 execution
  AUTH_INVALID: 401,
  AUTH_EXPIRED: 402,
  HASH_MISMATCH: 403,
  NONCE_REUSE: 404,
  POLICY_VERSION_CHANGED: 405,
  // 500–599 infrastructure
  STORE_ERROR: 501,
  OKX_TIMEOUT: 502,
  CHAIN_DELAYED: 503,
} as const satisfies Record<string, ReasonCode>;

/** EIP-712 domain shared by every Bekçi signature (§5.9). No verifyingContract. */
export const EIP712_DOMAIN = {
  name: "Bekci",
  version: "1",
  chainId: 43113,
} as const;

/** Always-forbidden tools in addition to policy.forbiddenTools (§5.6). */
export const ALWAYS_FORBIDDEN_TOOLS = ["transfer", "withdraw"] as const;

export const LIMITS = {
  maxAgentReasonChars: 1000,
  maxReadQueryChars: 512,
  maxReferencedReads: 32,
  clockSkewSec: 60,
} as const;
