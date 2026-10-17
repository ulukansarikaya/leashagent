import { z } from "zod";

// ERC-8004 registration file ("agent card"). Exact upstream schema is UNVERIFIED (§24.2);
// this is the subset Bekçi publishes/consumes, validated strictly so nothing private leaks.

export const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

const endpointSchema = z.strictObject({
  name: z.string().min(1).max(64),
  endpoint: z.string().url().max(512),
  version: z.string().max(32).optional(),
});

export const registrationSchema = z.strictObject({
  type: z.literal(REGISTRATION_TYPE),
  name: z.string().min(1).max(64),
  description: z.string().max(1000),
  image: z.string().url().max(512).optional(),
  kind: z.enum(["agent-security-gateway", "trading-agent"]),
  capabilities: z.array(z.string().max(64)).max(20),
  endpoints: z.array(endpointSchema).max(10),
  payment: z.strictObject({ protocol: z.literal("x402"), network: z.string().max(64) }).optional(),
  network: z.strictObject({ policyEvidence: z.string().max(64) }).optional(),
  registrations: z
    .array(z.strictObject({ agentId: z.string().max(128), agentRegistry: z.string().max(128) }))
    .max(5)
    .default([]),
  supportedTrust: z.array(z.enum(["reputation", "crypto-economic", "tee-attestation", "validation"])).max(4).default([]),
});

export type Registration = z.infer<typeof registrationSchema>;

export function bekciRegistration(opts: { baseUrl: string; paymentNetwork?: string; image?: string }): Registration {
  const base = opts.baseUrl.replace(/\/$/, "");
  return registrationSchema.parse({
    type: REGISTRATION_TYPE,
    name: "Bekci",
    description: "Security gateway that enforces an owner-signed policy before an AI agent's orders reach OKX.",
    image: opts.image,
    kind: "agent-security-gateway",
    capabilities: ["okx-spot-policy-enforcement", "signed-execution-authorization", "audit-evidence"],
    endpoints: [
      { name: "intents", endpoint: `${base}/v1/intents`, version: "1" },
      { name: "credits", endpoint: `${base}/v1/credits`, version: "1" },
      { name: "health", endpoint: `${base}/v1/health`, version: "1" },
    ],
    payment: { protocol: "x402", network: opts.paymentNetwork ?? "avalanche-fuji" },
    network: { policyEvidence: "Avalanche C-Chain" },
    supportedTrust: ["validation"],
  });
}

export function tradingAgentRegistration(opts: { name: string; description: string; homepage?: string }): Registration {
  return registrationSchema.parse({
    type: REGISTRATION_TYPE,
    name: opts.name,
    description: opts.description,
    kind: "trading-agent",
    capabilities: ["okx-spot-trading", "bekci-protected"],
    endpoints: opts.homepage ? [{ name: "homepage", endpoint: opts.homepage }] : [],
  });
}

/** Self-contained data: URI so publishing works without IPFS. Swap for an uploader in production. */
export function toDataUri(r: Registration): string {
  return `data:application/json;base64,${Buffer.from(JSON.stringify(r), "utf8").toString("base64")}`;
}

/** Decode a registration from a data: URI or fetch an https: URI (size-capped). */
export async function loadRegistration(uri: string, fetchImpl: typeof fetch = fetch): Promise<Registration> {
  let text: string;
  if (uri.startsWith("data:application/json;base64,")) {
    text = Buffer.from(uri.slice("data:application/json;base64,".length), "base64").toString("utf8");
  } else if (uri.startsWith("https://")) {
    const res = await fetchImpl(uri, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`registration fetch HTTP ${res.status}`);
    text = await res.text();
  } else {
    throw new Error("unsupported registration URI scheme");
  }
  if (text.length > 64 * 1024) throw new Error("registration too large");
  return registrationSchema.parse(JSON.parse(text));
}
