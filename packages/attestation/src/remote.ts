import { attestationEvidenceSchema, type AttestationEvidence, type Hex, type TeePlatform } from "@leashagent/shared";
import type { AttestationProvider } from "./ports.js";

/**
 * Verifier-side proxy for an attested gateway on another host: sends the verifier's challenge to the gateway's
 * `POST /v1/attestation` and returns the fresh evidence. The registry still verifies everything; this class only
 * transports. It refuses evidence for any signer other than the one the executor is configured to trust.
 */
export class RemoteAttestationProvider implements AttestationProvider {
  constructor(
    private readonly gatewayUrl: string,
    readonly signer: Hex,
    readonly platform: TeePlatform,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async attest(nonce: Hex): Promise<AttestationEvidence> {
    const res = await this.fetchImpl(`${this.gatewayUrl.replace(/\/$/, "")}/v1/attestation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`attestation request failed: HTTP ${res.status}`);
    const ev = attestationEvidenceSchema.parse(await res.json()) as AttestationEvidence;
    if (ev.signer.toLowerCase() !== this.signer.toLowerCase()) throw new Error("gateway attested an unexpected signer");
    if (ev.nonce.toLowerCase() !== nonce.toLowerCase()) throw new Error("gateway answered another challenge");
    return ev;
  }
}
