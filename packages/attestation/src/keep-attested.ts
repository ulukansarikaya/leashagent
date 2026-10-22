import type { AttestationProvider } from "./ports.js";
import type { AttestedSignerRegistry, SubmitResult } from "./registry.js";

/** One challenge → attest → verify round for `provider`'s signer. */
export async function attestOnce(registry: AttestedSignerRegistry, provider: AttestationProvider): Promise<SubmitResult> {
  const nonce = registry.challenge();
  return registry.submit(await provider.attest(nonce));
}

/**
 * Keep a signer attested: re-run the challenge round every `everySec` (well below the registry's maxAgeSec).
 * Resolves after the first round so a caller can refuse to start without an accepted attestation.
 * If re-attestation keeps failing, acceptance lapses and the executor stops accepting that signer (fail closed).
 */
export async function keepAttested(
  registry: AttestedSignerRegistry,
  provider: AttestationProvider,
  opts: { everySec: number; onResult?: (r: SubmitResult | { ok: false; reason: "provider_error"; error: string }) => void },
): Promise<{ first: SubmitResult; stop: () => void }> {
  const round = async () => {
    try {
      const r = await attestOnce(registry, provider);
      opts.onResult?.(r);
      return r;
    } catch (e) {
      const r = { ok: false as const, reason: "provider_error" as const, error: (e as Error).message };
      opts.onResult?.(r);
      return { ok: false as const, reason: "quote_invalid" as const };
    }
  };
  const first = await round();
  const timer = setInterval(() => void round(), opts.everySec * 1000);
  timer.unref?.();
  return { first, stop: () => clearInterval(timer) };
}
