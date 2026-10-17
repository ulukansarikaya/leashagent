import { z } from "zod";

const dec = z.string().regex(/^-?\d+(\.\d+)?$/);
const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);

export const orderIntentSchema = z.object({
  tool: z.enum(["spot_place_order", "spot_cancel_order"]),
  instId: z.string().regex(/^[A-Z0-9]+-[A-Z0-9]+$/).optional(),
  side: z.enum(["buy", "sell"]).optional(),
  ordType: z.enum(["market", "limit"]).optional(),
  sz: dec.optional(),
  px: dec.optional(),
  ordId: z.string().max(64).optional(),
  clOrdIdToCancel: z.string().max(64).optional(),
}).strict();

export const readSummarySchema = z.object({
  readId: z.string().uuid(),
  source: z.string().max(64),
  publishedAt: z.number().int().optional(),
  topics: z.array(z.string().max(64)).max(10),
  sentiment: z.enum(["positive", "neutral", "negative", "unknown"]),
  confidence: dec,
  sourceUrls: z.array(z.string().url().max(512)).max(5),
  flags: z.array(z.enum(["contains_instructions", "low_quality", "duplicate"])),
}).strict();

export const signedIntentRequestSchema = z.object({
  requestId: z.string().uuid(),
  policyId: hex,
  agentId: z.string().max(128),
  issuedAt: z.number().int(),
  authNonce: hex.length(34),
  intent: orderIntentSchema,
  agentReason: z.string().max(1000),
  referencedReadIds: z.array(z.string().uuid()).max(20),
  agentSignature: hex,
}).strict();
