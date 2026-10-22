/**
 * TEE Lite wiring for the gateway scripts (SONPLAN.md §21.4). Reads:
 *   TEE_MODE                  off (default) | simulated        — hardware platforms: see docs/TEE.md
 *   TEE_SERVICE_ID            expected environment identity     (default "leashagent-gateway")
 *   TEE_MAX_AGE_SEC           how long one attestation is valid (default 300)
 *   TEE_ALLOWED_MEASUREMENTS  comma-separated allow-list        (default: the simulated build's measurement)
 *   TEE_SIM_LABEL             simulated build label              (default "leashagent-gateway")
 * In TEE mode the executor accepts authorizations only from a signer with an accepted, fresh attestation
 * (INV-22), and the gateway refuses to start if the first attestation fails.
 */
import type { AttestationEvidence, EpochSec, Hex } from "@leashagent/shared";
import {
  AttestedSignerRegistry, SimulatedTee, keepAttested, type AttestationProvider,
} from "@leashagent/attestation";

export type TeeSetup = {
  mode: "off" | "simulated";
  /** Pass to the executor (`attestation`); undefined when TEE mode is off. */
  verifier?: AttestedSignerRegistry;
  /** Pass to createGatewayServer (`tee`) for /v1/health and /v1/attestation. */
  http?: { status(): unknown; evidence(): AttestationEvidence | undefined };
  stop(): void;
};

export async function setupTee(signer: Hex, clock: () => EpochSec): Promise<TeeSetup> {
  const mode = process.env.TEE_MODE ?? "off";
  if (mode === "off") return { mode: "off", stop: () => {} };
  if (mode !== "simulated") {
    throw new Error(`TEE_MODE=${mode}: no hardware adapter is wired yet (supported: off, simulated) — see docs/TEE.md`);
  }

  const serviceId = process.env.TEE_SERVICE_ID ?? "leashagent-gateway";
  const maxAgeSec = Number(process.env.TEE_MAX_AGE_SEC ?? 300);
  const tee = new SimulatedTee({ label: process.env.TEE_SIM_LABEL ?? "leashagent-gateway" });
  const allowed = (process.env.TEE_ALLOWED_MEASUREMENTS ?? tee.measurement).split(",").map((m) => m.trim() as Hex).filter(Boolean);
  const registry = new AttestedSignerRegistry({ serviceId, allowedMeasurements: allowed, maxAgeSec, verifiers: { simulated: tee.verifier() }, clock });

  let latest: AttestationEvidence | undefined;
  let lastError: string | undefined;
  const inner = tee.provider(signer, serviceId, clock);
  const provider: AttestationProvider = {
    platform: inner.platform, signer: inner.signer,
    attest: async (nonce) => (latest = await inner.attest(nonce)),
  };
  const loop = await keepAttested(registry, provider, {
    everySec: Math.max(10, Math.floor(maxAgeSec / 3)),
    onResult: (r) => { lastError = r.ok ? undefined : r.reason; },
  });
  if (!loop.first.ok) throw new Error(`TEE: first attestation rejected (${loop.first.reason}); refusing to start`);

  return {
    mode: "simulated",
    verifier: registry,
    http: {
      status: () => ({
        mode: "simulated",
        warning: "simulated platform: protocol only, no hardware root of trust",
        serviceId, signer, allowedMeasurements: allowed, maxAgeSec,
        accepted: registry.status(),
        lastError,
      }),
      evidence: () => latest,
    },
    stop: loop.stop,
  };
}
