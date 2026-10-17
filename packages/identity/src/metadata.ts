import { z } from "zod";

// ERC-8004 registration file, aligned with the EIP-8004 "registration-v1" format
// (type, name, description, image, services[], x402Support, active, registrations[], supportedTrust[]).
// Leash Agent-specific fields live under the namespaced `leash` object so generic 8004 tooling can read our cards.

export const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

const serviceSchema = z.object({
  name: z.string().min(1).max(64),
  endpoint: z.string().min(1).max(512),
  version: z.string().max(32).optional(),
});

const leashExtSchema = z.strictObject({
  kind: z.enum(["agent-security-gateway", "trading-agent"]),
  capabilities: z.array(z.string().max(64)).max(20),
  paymentNetwork: z.string().max(64).optional(),
  policyEvidence: z.string().max(64).optional(),
});

/** Strict shape for cards WE publish — no unknown fields can leak. */
export const registrationSchema = z.strictObject({
  type: z.literal(REGISTRATION_TYPE),
  name: z.string().min(1).max(64),
  description: z.string().max(1000),
  image: z.string().url().max(512).optional(),
  services: z.array(serviceSchema.strict()).max(10),
  x402Support: z.boolean(),
  active: z.boolean(),
  registrations: z
    .array(z.strictObject({ agentId: z.number().int().nonnegative(), agentRegistry: z.string().max(128) }))
    .max(5)
    .default([]),
  supportedTrust: z.array(z.string().max(64)).max(8).default([]),
  leash: leashExtSchema,
});

/** Lenient shape for cards OTHERS publish — unknown fields ignored, `leash` optional. */
export const foreignRegistrationSchema = z.object({
  type: z.literal(REGISTRATION_TYPE),
  name: z.string().min(1).max(256),
  description: z.string().max(4000).default(""),
  services: z.array(serviceSchema).max(50).default([]),
  x402Support: z.boolean().optional(),
  active: z.boolean().optional(),
  leash: leashExtSchema.optional(),
});

export type Registration = z.infer<typeof registrationSchema>;
export type ForeignRegistration = z.infer<typeof foreignRegistrationSchema>;

export function leashRegistration(opts: { baseUrl: string; paymentNetwork?: string; image?: string }): Registration {
  const base = opts.baseUrl.replace(/\/$/, "");
  return registrationSchema.parse({
    type: REGISTRATION_TYPE,
    name: "Leash Agent",
    description: "Security gateway that enforces an owner-signed policy before an AI agent's orders reach OKX.",
    image: opts.image,
    services: [
      { name: "web", endpoint: base },
      { name: "intents", endpoint: `${base}/v1/intents`, version: "v1" },
      { name: "credits", endpoint: `${base}/v1/credits`, version: "v1" },
      { name: "health", endpoint: `${base}/v1/health`, version: "v1" },
    ],
    x402Support: true,
    active: true,
    supportedTrust: ["validation"],
    leash: {
      kind: "agent-security-gateway",
      capabilities: ["okx-spot-policy-enforcement", "signed-execution-authorization", "audit-evidence"],
      paymentNetwork: opts.paymentNetwork ?? "avalanche-fuji",
      policyEvidence: "Avalanche C-Chain",
    },
  });
}

export function tradingAgentRegistration(opts: { name: string; description: string; homepage?: string }): Registration {
  return registrationSchema.parse({
    type: REGISTRATION_TYPE,
    name: opts.name,
    description: opts.description,
    services: opts.homepage ? [{ name: "web", endpoint: opts.homepage }] : [],
    x402Support: false,
    active: true,
    leash: { kind: "trading-agent", capabilities: ["okx-spot-trading", "leash-protected"] },
  });
}

/** Adds the on-chain registration back-reference once the agentId is known (spec `registrations`). */
export function withRegistration(r: Registration, agentRegistryId: number, chainId: number, registry: string): Registration {
  return registrationSchema.parse({
    ...r,
    registrations: [{ agentId: agentRegistryId, agentRegistry: `eip155:${chainId}:${registry}` }],
  });
}

/** Self-contained data: URI so publishing works without IPFS. */
export function toDataUri(r: Registration): string {
  return `data:application/json;base64,${Buffer.from(JSON.stringify(r), "utf8").toString("base64")}`;
}

/** Decode a registration from a data: URI or fetch an https: URI (size-capped). Never trusted as authority. */
export async function loadRegistration(uri: string, fetchImpl: typeof fetch = fetch): Promise<ForeignRegistration> {
  let text: string;
  if (uri.startsWith("data:application/json;base64,")) {
    text = Buffer.from(uri.slice("data:application/json;base64,".length), "base64").toString("utf8");
  } else if (uri.startsWith("https://")) {
    const res = await fetchImpl(uri, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!res.ok) throw new Error(`registration fetch HTTP ${res.status}`);
    text = await res.text();
  } else {
    throw new Error("unsupported registration URI scheme");
  }
  if (text.length > 64 * 1024) throw new Error("registration too large");
  return foreignRegistrationSchema.parse(JSON.parse(text));
}
