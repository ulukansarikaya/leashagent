import type { AttestationEvidence, EpochSec, Hex, TeePlatform } from "@leashagent/shared";

/** What a platform verifier extracts from a quote after checking its hardware signature chain. */
export type VerifiedQuote = {
  /** Software measurement of the environment (TDX MRTD/RTMR digest, SEV-SNP MEASUREMENT, Nitro PCRs digest). */
  measurement: Hex;
  /** The 32 bytes the environment bound into the report (see computeAttestationReportData). */
  reportData: Hex;
  /** Report generation time, when the platform provides one. */
  issuedAt?: EpochSec;
};

/** Platform-specific: verifies the quote's signature chain and returns its contents, or throws. */
export interface QuoteVerifier {
  readonly platform: TeePlatform;
  verify(quote: Uint8Array): Promise<VerifiedQuote>;
}

/** Runs inside the attested environment: answers a verifier challenge for its own signer key. */
export interface AttestationProvider {
  readonly platform: TeePlatform;
  readonly signer: Hex;
  attest(nonce: Hex): Promise<AttestationEvidence>;
}
