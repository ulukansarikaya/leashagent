import { z } from "zod";
import { LIMITS } from "./constants";

const hex = (bytes?: number) =>
  z
    .string()
    .regex(bytes ? new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`) : /^0x[0-9a-fA-F]*$/)
    .transform((s) => s as `0x${string}`);

const decStr = z.string().regex(/^-?\d+(\.\d+)?$/);
const posDecStr = z.string().regex(/^\d+(\.\d+)?$/);
const uuid = z.string().uuid();
const instId = z.string().regex(/^[A-Z0-9]{2,20}-[A-Z0-9]{2,20}$/);
const epoch = z.number().int().nonnegative();
const exchangeId = z.string().regex(/^[A-Za-z0-9]{1,32}$/);

/** Tool-specific strict schemas (§6.3 step 7): extra fields rejected. */
const placeOrderIntent = z
  .object({
    tool: z.literal("spot_place_order"),
    instId,
    side: z.enum(["buy", "sell"]),
    ordType: z.enum(["market", "limit"]),
    sz: posDecStr,
    px: posDecStr.optional(),
  })
  .strict()
  .refine((o) => (o.ordType === "limit" ? o.px !== undefined : o.px === undefined), {
    message: "px is required for limit and forbidden for market",
  });

const cancelOrderIntent = z
  .object({
    tool: z.literal("spot_cancel_order"),
    instId,
    ordId: exchangeId.optional(),
    clOrdIdToCancel: exchangeId.optional(),
  })
  .strict()
  .refine((o) => (o.ordId === undefined) !== (o.clOrdIdToCancel === undefined), {
    message: "exactly one of ordId / clOrdIdToCancel",
  });

export const orderIntentSchema = z.union([placeOrderIntent, cancelOrderIntent]);

export const signedIntentRequestSchema = z
  .object({
    requestId: uuid,
    policyId: hex(32),
    agentId: z.string().min(1).max(128),
    issuedAt: epoch,
    authNonce: hex(16),
    intent: orderIntentSchema,
    agentReason: z.string().max(LIMITS.maxAgentReasonChars),
    referencedReadIds: z.array(uuid).max(LIMITS.maxReferencedReads),
    agentSignature: hex(),
  })
  .strict();

export const readRequestSchema = z
  .object({
    requestId: uuid,
    policyId: hex(32),
    source: z.enum(["news", "web", "social"]),
    query: z.string().min(1).max(LIMITS.maxReadQueryChars),
    agentSignature: hex(),
  })
  .strict();

export const signedApprovalSchema = z
  .object({
    requestId: uuid,
    policyId: hex(32),
    normalizedOrderHash: hex(32),
    decision: z.enum(["approve", "reject"]),
    nonce: hex(16),
    expiresAt: epoch,
    ownerSignature: hex(),
  })
  .strict();

export const signedPauseCommandSchema = z
  .object({
    policyId: hex(32),
    paused: z.boolean(),
    nonce: hex(16),
    issuedAt: epoch,
    ownerSignature: hex(),
  })
  .strict();

export const decSchema = decStr;

export const schemas = {
  signedIntentRequest: signedIntentRequestSchema,
  orderIntent: orderIntentSchema,
  readRequest: readRequestSchema,
  signedApproval: signedApprovalSchema,
  signedPauseCommand: signedPauseCommandSchema,
};

/** Envelope-only view used by L3 before the tool-specific intent schema runs (§6.3 steps 1-7). */
export const signedIntentEnvelopeSchema = signedIntentRequestSchema.extend({ intent: z.unknown() });

const unitDec = z.string().regex(/^(0(\.\d+)?|1(\.0+)?)$/);
const nonNegInt = z.number().int().nonnegative();
const address = hex(20);

/** Policy JSON fetched from policyURI (§5.6). Integrity comes from the on-chain hash; this checks shape. */
export const policySchema = z
  .object({
    policyVersion: z.number().int().positive(),
    binding: z
      .object({
        policyId: hex(32),
        owner: address,
        accountRef: hex(32),
        agentRegistry: address,
        agentRegistryId: z.string().regex(/^\d+$/),
        agentId: z.string().min(1).max(128),
      })
      .strict(),
    agentAuthAddress: address,
    delegationValidUntil: nonNegInt,
    mandate: z.string().max(4000),
    allowedInstruments: z.array(instId),
    allowedTools: z.array(z.enum(["spot_place_order", "spot_cancel_order"])),
    forbiddenTools: z.array(z.string()),
    limits: z
      .object({
        maxOrderNotionalUsdt: posDecStr,
        maxOpenNotionalUsdt: posDecStr,
        maxOrdersPerMinute: nonNegInt,
        maxDailyLossUsdt: posDecStr,
        maxPriceDeviationBps: nonNegInt,
        marketSlippageBufferBps: nonNegInt,
        escalateAboveUsdt: posDecStr,
      })
      .strict(),
    freshness: z.object({ maxRiskDataAgeSec: nonNegInt, maxMarketDataAgeSec: nonNegInt }).strict(),
    auditor: z
      .object({
        mode: z.enum(["disabled", "enabled"]),
        maxInjectionSuspicion: unitDec,
        minConsistency: unitDec,
        minVerdictConfidence: unitDec,
        onUnavailable: z.literal("pending"),
      })
      .strict(),
    pendingTtlSec: z.number().int().positive(),
    authorizationTtlSec: z.number().int().positive(),
  })
  .strict();

/** Auditor output validation (§10): out-of-schema -> PENDING 302. */
export const auditorOutputSchema = z.object({
  consistency: unitDec,
  injectionSuspicion: unitDec,
  verdict: z.object({ allow: unitDec, block: unitDec, askHuman: unitDec }).strict(),
  latencyMs: nonNegInt,
  provider: z.string().max(64),
  raw: z.unknown().optional(),
});

/** L6 input (§6.6): an extra field or a different value means rejection, no exchange call. */
export const executionAuthorizationSchema = z
  .object({
    requestId: uuid,
    policyId: hex(32),
    policyVersion: z.number().int().positive(),
    accountRef: hex(32),
    agentId: z.string().min(1).max(128),
    tool: z.enum(["spot_place_order", "spot_cancel_order"]),
    normalizedOrderHash: hex(32),
    nonce: hex(16),
    issuedAt: epoch,
    expiresAt: epoch,
    guardInstanceId: z.string().min(1).max(64),
    basis: z.enum(["rules_only", "rules_and_auditor", "human_approved"]),
    signature: hex(),
  })
  .strict();

export const normalizedOrderSchema = z.union([
  z
    .object({
      tool: z.literal("spot_place_order"),
      instId,
      side: z.enum(["buy", "sell"]),
      ordType: z.enum(["market", "limit"]),
      sz: posDecStr,
      px: posDecStr.optional(),
      tgtCcy: z.literal("base_ccy").optional(),
      clOrdId: z.string().regex(/^bk[0-9a-f]{30}$/),
    })
    .strict()
    .refine((o) => (o.ordType === "limit" ? o.px !== undefined && o.tgtCcy === undefined : o.px === undefined && o.tgtCcy === "base_ccy")),
  z
    .object({
      tool: z.literal("spot_cancel_order"),
      instId,
      cancel: z
        .object({ ordId: exchangeId.optional(), clOrdId: exchangeId.optional() })
        .strict()
        .refine((c) => (c.ordId === undefined) !== (c.clOrdId === undefined)),
    })
    .strict(),
]);
