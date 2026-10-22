/**
 * TEE Lite wiring for the gateway scripts (SONPLAN.md §21.4, docs/TEE.md). Reads:
 *   TEE_MODE                  off (default) | simulated | tdx
 *   TEE_SERVICE_ID            expected environment identity     (default "leashagent-gateway")
 *   TEE_MAX_AGE_SEC           how long one attestation is valid (default 300)
 *   TEE_ALLOWED_MEASUREMENTS  comma-separated allow-list        (simulated: defaults to the simulated build; tdx: required)
 *   TEE_SIM_LABEL             simulated build label              (default "leashagent-gateway")
 *   TEE_TDX_ACCEPTED_TCB      comma-separated Intel TCB statuses (default "UpToDate,SWHardeningNeeded")
 * In TEE mode the executor accepts authorizations only from a signer with an accepted, fresh attestation
 * (INV-22), and the gateway refuses to start if the first attestation fails.
 */
import type { AttestationEvidence, EpochSec, Hex } from "@leashagent/shared";
import {
  AttestedSignerRegistry, DEFAULT_ACCEPTED_TCB, DstackTdxProvider, SimulatedTee, TdxDstackQuoteVerifier, keepAttested,
  type AttestationProvider, type QuoteVerifier,
} from "@leashagent/attestation";

export type TeeSetup = {
  mode: "off" | "simulated" | "tdx";
  /** Pass to the executor (`attestation`); undefined when TEE mode is off. */
  verifier?: AttestedSignerRegistry;
  /** Pass to createGatewayServer (`tee`): /v1/health, GET and POST /v1/attestation. */
  http?: { status(): unknown; evidence(): AttestationEvidence | undefined; attest(nonce: Hex): Promise<AttestationEvidence> };
  stop(): void;
};

export async function setupTee(signer: Hex, clock: () => EpochSec): Promise<TeeSetup> {
  const mode = process.env.TEE_MODE ?? "off";
  if (mode === "off") return { mode: "off", stop: () => {} };
  if (mode !== "simulated" && mode !== "tdx") throw new Error(`TEE_MODE=${mode}: supported values are off, simulated, tdx (docs/TEE.md)`);

  const serviceId = process.env.TEE_SERVICE_ID ?? "leashagent-gateway";
  const maxAgeSec = Number(process.env.TEE_MAX_AGE_SEC ?? 300);
  const allowList = (process.env.TEE_ALLOWED_MEASUREMENTS ?? "").split(",").map((m) => m.trim() as Hex).filter(Boolean);

  let provider: AttestationProvider;
  let quoteVerifier: QuoteVerifier;
  let allowed: Hex[];
  let warning: string | undefined;
  if (mode === "simulated") {
    const tee = new SimulatedTee({ label: process.env.TEE_SIM_LABEL ?? "leashagent-gateway" });
    provider = tee.provider(signer, serviceId, clock);
    quoteVerifier = tee.verifier();
    allowed = allowList.length ? allowList : [tee.measurement];
    warning = "simulated platform: protocol only, no hardware root of trust";
  } else {
    // The signing key must be born inside the TD; an injected key could exist outside it.
    if (process.env.GUARD_SIGNING_KEY) throw new Error("TEE_MODE=tdx: unset GUARD_SIGNING_KEY — the signing key must be generated inside the TD");
    provider = new DstackTdxProvider(signer, serviceId, undefined, clock);
    const tcb = process.env.TEE_TDX_ACCEPTED_TCB?.split(",").map((s) => s.trim()).filter(Boolean);
    quoteVerifier = new TdxDstackQuoteVerifier({ acceptedTcbStatuses: (tcb?.length ? tcb : DEFAULT_ACCEPTED_TCB) as never });
    if (!allowList.length) {
      // Bootstrap: report what this deployment measures, then refuse to run without an explicit allow-list.
      const ev = await provider.attest(`0x${"00".repeat(32)}`);
      const q = await quoteVerifier.verify(new Uint8Array(Buffer.from(ev.quote, "base64")));
      throw new Error(`TEE_MODE=tdx needs TEE_ALLOWED_MEASUREMENTS. This deployment measures ${q.measurement} — ` +
        "verify its compose-hash (docs/TEE.md), add it, and restart.");
    }
    allowed = allowList;
  }

  const registry = new AttestedSignerRegistry({
    serviceId, allowedMeasurements: allowed, maxAgeSec, verifiers: { [provider.platform]: quoteVerifier }, clock,
  });
  let latest: AttestationEvidence | undefined;
  let lastError: string | undefined;
  const recording: AttestationProvider = {
    platform: provider.platform, signer: provider.signer,
    attest: async (nonce) => (latest = await provider.attest(nonce)),
  };
  const loop = await keepAttested(registry, recording, {
    everySec: Math.max(10, Math.floor(maxAgeSec / 3)),
    onResult: (r) => { lastError = r.ok ? undefined : r.reason; },
  });
  if (!loop.first.ok) throw new Error(`TEE: first attestation rejected (${loop.first.reason}); refusing to start`);

  return {
    mode,
    verifier: registry,
    http: {
      status: () => ({
        mode, platform: provider.platform, ...(warning ? { warning } : {}),
        serviceId, signer, allowedMeasurements: allowed, maxAgeSec, accepted: registry.status(), lastError,
      }),
      evidence: () => latest,
      attest: (nonce) => provider.attest(nonce),
    },
    stop: loop.stop,
  };
}
