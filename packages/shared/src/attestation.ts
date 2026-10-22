import { encodeAbiParameters, keccak256 } from "viem";
import { z } from "zod";
import type { EpochSec, Hex } from "./types.js";

// TEE Lite (SONPLAN.md §21.4, INV-22): the authorization signer lives in an attested environment and the
// executor accepts its signatures only while a fresh attestation for that signer has been accepted.

// The verifier interface L6 depends on in TEE mode is `AttestationVerifier` in types.ts (§21.6).

/**
 * Platforms an attestation can come from. `simulated` is a development stand-in with no hardware root of
 * trust; it exercises the protocol only and must never be presented as TEE protection.
 */
export const TEE_PLATFORMS = ["simulated", "tdx", "sev-snp", "nitro"] as const;
export type TeePlatform = (typeof TEE_PLATFORMS)[number];

/** What the attested environment hands to a verifier in answer to a challenge. */
export type AttestationEvidence = {
  platform: TeePlatform;
  /** Base64 platform evidence (TDX quote, SEV-SNP report, Nitro attestation document, or simulated quote). */
  quote: string;
  /** The authorization signer address this environment claims to hold. */
  signer: Hex;
  /** The verifier's single-use challenge (32 bytes). */
  nonce: Hex;
  /** Expected service/environment identity, e.g. "leashagent-gateway". */
  serviceId: string;
  issuedAt: EpochSec;
};

/** Domain separator so a report-data value cannot be confused with any other hash in the system. */
export const ATTESTATION_REPORT_DOMAIN = "LeashAgent-TEE-v1";

/**
 * The 32-byte value the environment must place in its hardware report (TDX `report_data`, SEV-SNP
 * `REPORT_DATA`, Nitro `user_data`). It binds the quote to exactly this signer, this challenge and this
 * service, so a quote cannot be replayed for another key, another challenge or another deployment.
 *
 * reportData = keccak256(abi.encode(string domain, address signer, bytes32 nonce, string serviceId))
 */
export function computeAttestationReportData(signer: Hex, nonce: Hex, serviceId: string): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "string" }, { type: "address" }, { type: "bytes32" }, { type: "string" }],
    [ATTESTATION_REPORT_DOMAIN, signer, nonce, serviceId],
  ));
}

export const attestationEvidenceSchema = z.strictObject({
  platform: z.enum(TEE_PLATFORMS),
  quote: z.string().min(1).max(64_000).regex(/^[A-Za-z0-9+/=]+$/),
  signer: z.custom<Hex>((v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)),
  nonce: z.custom<Hex>((v) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v)),
  serviceId: z.string().min(1).max(128),
  issuedAt: z.number().int().nonnegative(),
});

type Assert<T extends true> = T;
export type _AttestationSchemaCheck = Assert<z.infer<typeof attestationEvidenceSchema> extends AttestationEvidence ? true : false>;
