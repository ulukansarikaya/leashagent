import { randomBytes } from "node:crypto";
import {
  attestationEvidenceSchema, computeAttestationReportData,
  type AttestationEvidence, type AttestationVerifier, type EpochSec, type Hex, type TeePlatform,
} from "@leashagent/shared";
import type { QuoteVerifier } from "./ports.js";

export type RegistryConfig = {
  /** Expected service/environment identity; evidence for another service is refused. */
  serviceId: string;
  /** Allow-listed software measurements. Anything else is refused. */
  allowedMeasurements: Hex[];
  /** How long an accepted attestation keeps a signer authorized. */
  maxAgeSec: number;
  /** How long a challenge nonce can be answered. Default 60 s. */
  challengeTtlSec?: number;
  /** Tolerated clock difference for quote timestamps. Default 30 s. */
  clockSkewSec?: number;
  verifiers: Partial<Record<TeePlatform, QuoteVerifier>>;
  clock?: () => EpochSec;
};

export type AcceptedSigner = { signer: Hex; platform: TeePlatform; measurement: Hex; acceptedAt: EpochSec; expiresAt: EpochSec };

export type SubmitResult =
  | { ok: true; accepted: AcceptedSigner }
  | { ok: false; reason: AttestationRejection };

export type AttestationRejection =
  | "malformed" | "unknown_nonce" | "stale_challenge" | "wrong_service" | "unsupported_platform"
  | "quote_invalid" | "measurement_not_allowed" | "report_data_mismatch" | "stale_quote";

/**
 * L6-side verifier for TEE Lite (§21.4, INV-22). An authorization signer is accepted only after it answers
 * a fresh, single-use challenge with platform evidence that (1) verifies against the platform's root of
 * trust, (2) carries an allow-listed measurement and (3) binds exactly this signer, nonce and service.
 * Acceptance expires after `maxAgeSec`; the signer must re-attest to stay authorized.
 */
export class AttestedSignerRegistry implements AttestationVerifier {
  private readonly challenges = new Map<Hex, EpochSec>();
  private readonly accepted = new Map<string, AcceptedSigner>();
  private readonly allowed: Set<string>;
  private readonly now: () => EpochSec;

  constructor(private readonly cfg: RegistryConfig) {
    if (cfg.allowedMeasurements.length === 0) throw new Error("TEE mode needs at least one allowed measurement");
    if (!(cfg.maxAgeSec > 0)) throw new Error("maxAgeSec must be positive");
    this.allowed = new Set(cfg.allowedMeasurements.map((m) => m.toLowerCase()));
    this.now = cfg.clock ?? (() => Math.floor(Date.now() / 1000));
  }

  /** A new single-use 32-byte challenge. */
  challenge(): Hex {
    this.prune();
    const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
    this.challenges.set(nonce, this.now());
    return nonce;
  }

  async submit(input: unknown): Promise<SubmitResult> {
    const parsed = attestationEvidenceSchema.safeParse(input);
    if (!parsed.success) return { ok: false, reason: "malformed" };
    const ev = parsed.data as AttestationEvidence;
    const now = this.now();
    const skew = this.cfg.clockSkewSec ?? 30;

    // Single use: the challenge is consumed whatever the outcome.
    const nonce = ev.nonce.toLowerCase() as Hex;
    const challengedAt = this.challenges.get(nonce);
    if (challengedAt === undefined) return { ok: false, reason: "unknown_nonce" };
    this.challenges.delete(nonce);
    if (now - challengedAt > (this.cfg.challengeTtlSec ?? 60)) return { ok: false, reason: "stale_challenge" };

    if (ev.serviceId !== this.cfg.serviceId) return { ok: false, reason: "wrong_service" };
    const verifier = this.cfg.verifiers[ev.platform];
    if (!verifier) return { ok: false, reason: "unsupported_platform" };

    let q;
    try {
      q = await verifier.verify(new Uint8Array(Buffer.from(ev.quote, "base64")));
    } catch {
      return { ok: false, reason: "quote_invalid" };
    }
    if (!this.allowed.has(q.measurement.toLowerCase())) return { ok: false, reason: "measurement_not_allowed" };
    if (q.reportData.toLowerCase() !== computeAttestationReportData(ev.signer, nonce, ev.serviceId).toLowerCase()) {
      return { ok: false, reason: "report_data_mismatch" };
    }
    if (q.issuedAt !== undefined && (q.issuedAt < challengedAt - skew || q.issuedAt > now + skew)) {
      return { ok: false, reason: "stale_quote" };
    }

    const accepted: AcceptedSigner = {
      signer: ev.signer, platform: ev.platform, measurement: q.measurement, acceptedAt: now, expiresAt: now + this.cfg.maxAgeSec,
    };
    this.accepted.set(ev.signer.toLowerCase(), accepted);
    return { ok: true, accepted };
  }

  async isAuthorizedSigner(address: Hex): Promise<boolean> {
    const a = this.accepted.get(address.toLowerCase());
    return !!a && this.now() <= a.expiresAt;
  }

  revoke(address: Hex): void {
    this.accepted.delete(address.toLowerCase());
  }

  /** Currently accepted signers (for health/dashboard). */
  status(): AcceptedSigner[] {
    const now = this.now();
    return [...this.accepted.values()].filter((a) => now <= a.expiresAt);
  }

  private prune() {
    const cutoff = this.now() - (this.cfg.challengeTtlSec ?? 60);
    for (const [n, t] of this.challenges) if (t < cutoff) this.challenges.delete(n);
  }
}
