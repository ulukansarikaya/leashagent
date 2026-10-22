import { keccak256, recoverMessageAddress, stringToBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { canonicalJson, computeAttestationReportData, type AttestationEvidence, type EpochSec, type Hex } from "@leashagent/shared";
import type { AttestationProvider, QuoteVerifier, VerifiedQuote } from "./ports.js";

/**
 * DEVELOPMENT STAND-IN — NOT A TEE. A software "platform" whose root of trust is an ordinary key in the same
 * process. It lets the full challenge → quote → verify → enforce protocol run on any machine (tests, local
 * gateway, a plain VPS), so a hardware adapter can later be swapped in without touching the rest.
 * Anyone with access to the process can forge its quotes; never present it as hardware protection.
 */
export class SimulatedTee {
  readonly root: PrivateKeyAccount;
  readonly measurement: Hex;

  constructor(opts: { label?: string; rootKey?: Hex } = {}) {
    this.root = privateKeyToAccount(opts.rootKey ?? generatePrivateKey());
    this.measurement = simulatedMeasurement(opts.label ?? "leashagent-gateway");
  }

  /** Quote producer for a signer that lives "inside" this simulated environment. */
  provider(signer: Hex, serviceId: string, clock: () => EpochSec = () => Math.floor(Date.now() / 1000)): AttestationProvider {
    const tee = this;
    return {
      platform: "simulated",
      signer,
      async attest(nonce: Hex): Promise<AttestationEvidence> {
        const issuedAt = clock();
        const body = { v: 1, measurement: tee.measurement, reportData: computeAttestationReportData(signer, nonce, serviceId), issuedAt };
        const sig = await tee.root.signMessage({ message: { raw: keccak256(stringToBytes(canonicalJson(body))) } });
        const quote = Buffer.from(JSON.stringify({ ...body, sig }), "utf8").toString("base64");
        return { platform: "simulated", quote, signer, nonce, serviceId, issuedAt };
      },
    };
  }

  verifier(): QuoteVerifier {
    return new SimulatedQuoteVerifier(this.root.address);
  }
}

/** Deterministic measurement for a simulated build label (stands in for an image/firmware digest). */
export function simulatedMeasurement(label: string): Hex {
  return keccak256(stringToBytes(`simulated-measurement:${label}`));
}

/** Verifies simulated quotes against the expected simulated root address. */
export class SimulatedQuoteVerifier implements QuoteVerifier {
  readonly platform = "simulated" as const;
  constructor(private readonly rootAddress: Hex) {}

  async verify(quote: Uint8Array): Promise<VerifiedQuote> {
    const q = JSON.parse(Buffer.from(quote).toString("utf8")) as { v: number; measurement: Hex; reportData: Hex; issuedAt: EpochSec; sig: Hex };
    if (q.v !== 1 || typeof q.sig !== "string") throw new Error("unsupported simulated quote");
    const body = { v: q.v, measurement: q.measurement, reportData: q.reportData, issuedAt: q.issuedAt };
    const signer = await recoverMessageAddress({ message: { raw: keccak256(stringToBytes(canonicalJson(body))) }, signature: q.sig });
    if (signer.toLowerCase() !== this.rootAddress.toLowerCase()) throw new Error("quote not signed by the simulated root");
    return { measurement: q.measurement, reportData: q.reportData, issuedAt: q.issuedAt };
  }
}
