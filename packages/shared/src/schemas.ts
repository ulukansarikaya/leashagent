import { z } from "zod";
import { dec, DEC_RE } from "./dec.js";
import {
  AUTH_BASES,
  CHAIN_VERDICTS,
  EXEC_STATUSES,
  TOOLS,
  type AuditorOutput,
  type ChainRecord,
  type Hex,
  type ExecutionAuthorization,
  type NormalizedOrder,
  type OrderIntent,
  type Policy,
  type ReadRequest,
  type ReadSummary,
  type SignedApproval,
  type SignedIntentRequest,
  type SignedPauseCommand,
} from "./types.js";

// Strict schemas (§6.3 step 7): every object rejects unknown keys.

const hexOf = (re: RegExp, what: string) =>
  z.custom<Hex>((v) => typeof v === "string" && re.test(v), { message: `invalid ${what}` });

export const hexSchema = hexOf(/^0x[0-9a-fA-F]*$/, "hex");
export const addressSchema = hexOf(/^0x[0-9a-fA-F]{40}$/, "address");
export const bytes32Schema = hexOf(/^0x[0-9a-fA-F]{64}$/, "bytes32");
export const bytes16Schema = hexOf(/^0x[0-9a-fA-F]{32}$/, "bytes16");
export const signatureSchema = hexOf(/^0x[0-9a-fA-F]{130}$/, "signature");
export const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
export const epochSchema = z.number().int().nonnegative();
export const uintDecSchema = z.string().regex(/^(0|[1-9]\d*)$/);
export const decSchema = z.string().regex(DEC_RE);
export const positiveDecSchema = decSchema.refine((s) => dec(s).gt("0"), "must be > 0");
export const unitDecSchema = decSchema.refine((s) => dec(s).gte("0") && dec(s).lte("1"), "must be in [0,1]");
export const instIdSchema = z.string().regex(/^[A-Z0-9]{1,20}-[A-Z0-9]{1,20}$/);
export const toolSchema = z.enum(TOOLS);

const placeOrderIntent = z
  .strictObject({
    tool: z.literal("spot_place_order"),
    instId: instIdSchema,
    side: z.enum(["buy", "sell"]),
    ordType: z.enum(["market", "limit"]),
    sz: positiveDecSchema,
    px: positiveDecSchema.optional(),
  })
  .refine((o) => (o.ordType === "limit") === (o.px !== undefined), {
    message: "px is required for limit and forbidden for market",
    path: ["px"],
  });

const cancelOrderIntent = z
  .strictObject({
    tool: z.literal("spot_cancel_order"),
    instId: instIdSchema,
    ordId: z.string().regex(/^\d{1,32}$/).optional(),
    clOrdIdToCancel: z.string().regex(/^[A-Za-z0-9]{1,32}$/).optional(),
  })
  .refine((o) => (o.ordId === undefined) !== (o.clOrdIdToCancel === undefined), {
    message: "exactly one of ordId / clOrdIdToCancel",
  });

export const orderIntentSchema = z.discriminatedUnion("tool", [placeOrderIntent, cancelOrderIntent]);

export const signedIntentRequestSchema = z.strictObject({
  requestId: uuidSchema,
  policyId: bytes32Schema,
  agentId: z.string().min(1).max(256),
  issuedAt: epochSchema,
  authNonce: bytes16Schema,
  intent: orderIntentSchema,
  agentReason: z.string().max(1000),
  referencedReadIds: z.array(uuidSchema).max(20),
  agentSignature: signatureSchema,
});

export const normalizedOrderSchema = z.strictObject({
  tool: toolSchema,
  instId: instIdSchema,
  side: z.enum(["buy", "sell"]).optional(),
  ordType: z.enum(["market", "limit"]).optional(),
  sz: positiveDecSchema.optional(),
  px: positiveDecSchema.optional(),
  tgtCcy: z.literal("base_ccy").optional(),
  clOrdId: z.string().regex(/^[A-Za-z0-9]{1,32}$/).optional(),
  cancel: z.strictObject({ ordId: z.string().optional(), clOrdId: z.string().optional() }).optional(),
});

export const readRequestSchema = z.strictObject({
  requestId: uuidSchema,
  policyId: bytes32Schema,
  source: z.enum(["news", "web", "social"]),
  query: z.string().min(1).max(512),
  agentSignature: signatureSchema,
});

export const readSummarySchema = z.strictObject({
  readId: uuidSchema,
  source: z.string().max(64),
  publishedAt: epochSchema.optional(),
  topics: z.array(z.string().max(64)).max(10),
  sentiment: z.enum(["positive", "neutral", "negative", "unknown"]),
  confidence: unitDecSchema,
  sourceUrls: z.array(z.url({ protocol: /^https?$/ }).max(2048)).max(5),
  flags: z.array(z.enum(["contains_instructions", "low_quality", "duplicate"])).max(3),
});

export const executionAuthorizationSchema = z.strictObject({
  requestId: uuidSchema,
  policyId: bytes32Schema,
  policyVersion: z.number().int().positive(),
  accountRef: bytes32Schema,
  agentId: z.string().min(1).max(256),
  tool: toolSchema,
  normalizedOrderHash: bytes32Schema,
  nonce: bytes16Schema,
  issuedAt: epochSchema,
  expiresAt: epochSchema,
  guardInstanceId: z.string().min(1).max(128),
  basis: z.enum(AUTH_BASES),
  signature: signatureSchema,
});

export const signedApprovalSchema = z.strictObject({
  requestId: uuidSchema,
  policyId: bytes32Schema,
  normalizedOrderHash: bytes32Schema,
  decision: z.enum(["approve", "reject"]),
  nonce: bytes16Schema,
  expiresAt: epochSchema,
  ownerSignature: signatureSchema,
});

export const signedPauseCommandSchema = z.strictObject({
  policyId: bytes32Schema,
  paused: z.boolean(),
  nonce: bytes16Schema,
  issuedAt: epochSchema,
  ownerSignature: signatureSchema,
});

/** External model output — validate before mapping (§10: out-of-schema → PENDING 302). */
export const auditorOutputSchema = z.strictObject({
  consistency: unitDecSchema,
  injectionSuspicion: unitDecSchema,
  verdict: z.strictObject({ allow: unitDecSchema, block: unitDecSchema, askHuman: unitDecSchema }),
  latencyMs: z.number().int().nonnegative(),
  provider: z.string().min(1).max(64),
  raw: z.unknown().optional(),
});

export const policySchema = z.strictObject({
  policyVersion: z.number().int().positive(),
  binding: z.strictObject({
    policyId: bytes32Schema,
    owner: addressSchema,
    accountRef: bytes32Schema,
    agentRegistry: addressSchema,
    agentRegistryId: uintDecSchema,
    agentId: z.string().min(1).max(256),
  }),
  agentAuthAddress: addressSchema,
  delegationValidUntil: epochSchema,
  mandate: z.string().max(4000),
  allowedInstruments: z.array(instIdSchema).max(50),
  allowedTools: z.array(toolSchema),
  forbiddenTools: z.array(z.string().max(64)),
  limits: z.strictObject({
    maxOrderNotionalUsdt: decSchema,
    maxOpenNotionalUsdt: decSchema,
    maxOrdersPerMinute: z.number().int().nonnegative(),
    maxDailyLossUsdt: decSchema,
    maxPriceDeviationBps: z.number().int().nonnegative(),
    marketSlippageBufferBps: z.number().int().nonnegative(),
    escalateAboveUsdt: decSchema,
  }),
  freshness: z.strictObject({
    maxRiskDataAgeSec: z.number().int().positive(),
    maxMarketDataAgeSec: z.number().int().positive(),
  }),
  auditor: z.strictObject({
    mode: z.enum(["disabled", "enabled"]),
    maxInjectionSuspicion: unitDecSchema,
    minConsistency: unitDecSchema,
    minVerdictConfidence: unitDecSchema,
    onUnavailable: z.literal("pending"),
  }),
  pendingTtlSec: z.number().int().positive(),
  authorizationTtlSec: z.number().int().positive(),
});

export const chainRecordSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("decision"),
    requestId: uuidSchema,
    policyId: bytes32Schema,
    verdict: z.enum(CHAIN_VERDICTS),
    policyHash: bytes32Schema,
    policyVersion: z.number().int().nonnegative(),
    normalizedOrderHash: bytes32Schema,
    evidenceHash: bytes32Schema,
    reasonCode: z.number().int().min(0).max(65535),
    authHash: bytes32Schema,
  }),
  z.strictObject({
    kind: z.literal("execution"),
    requestId: uuidSchema,
    eventSeq: z.number().int().positive(),
    status: z.enum(EXEC_STATUSES),
    okxResultHash: bytes32Schema,
  }),
]);

// Compile-time drift guard: each schema's output must be assignable to its frozen type.
type Assert<T extends true> = T;
type Sub<A, B> = A extends B ? true : false;
export type _SchemaTypeChecks = [
  Assert<Sub<z.infer<typeof orderIntentSchema>, OrderIntent>>,
  Assert<Sub<z.infer<typeof signedIntentRequestSchema>, SignedIntentRequest>>,
  Assert<Sub<z.infer<typeof normalizedOrderSchema>, NormalizedOrder>>,
  Assert<Sub<z.infer<typeof readRequestSchema>, ReadRequest>>,
  Assert<Sub<z.infer<typeof readSummarySchema>, ReadSummary>>,
  Assert<Sub<z.infer<typeof executionAuthorizationSchema>, ExecutionAuthorization>>,
  Assert<Sub<z.infer<typeof signedApprovalSchema>, SignedApproval>>,
  Assert<Sub<z.infer<typeof signedPauseCommandSchema>, SignedPauseCommand>>,
  Assert<Sub<z.infer<typeof auditorOutputSchema>, AuditorOutput>>,
  Assert<Sub<z.infer<typeof policySchema>, Policy>>,
  Assert<Sub<z.infer<typeof chainRecordSchema>, ChainRecord>>,
];

export const schemas = {
  orderIntent: orderIntentSchema,
  signedIntentRequest: signedIntentRequestSchema,
  normalizedOrder: normalizedOrderSchema,
  readRequest: readRequestSchema,
  readSummary: readSummarySchema,
  executionAuthorization: executionAuthorizationSchema,
  signedApproval: signedApprovalSchema,
  signedPauseCommand: signedPauseCommandSchema,
  auditorOutput: auditorOutputSchema,
  policy: policySchema,
  chainRecord: chainRecordSchema,
};
