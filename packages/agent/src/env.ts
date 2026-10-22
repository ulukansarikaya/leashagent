/**
 * INV-1: the agent process must never hold an exchange credential. A launcher builds the agent's environment from
 * an allow-list instead of inheriting its own, so an OKX key present in the parent can never leak into the agent.
 */
const ALLOWED = [/^AGENT_/, /^LEASH_/, /^(PATH|HOME|TMPDIR|TEMP|TMP|LANG|LC_ALL|TERM|NODE_OPTIONS|SYSTEMROOT)$/];
/** Anything that looks like an exchange credential — refused even if a name matches the allow-list. */
export const EXCHANGE_CREDENTIAL = /^(OKX_|.*_OKX_).*(KEY|SECRET|PASSPHRASE)$/;

export function agentProcessEnv(parent: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined || EXCHANGE_CREDENTIAL.test(k)) continue;
    if (ALLOWED.some((r) => r.test(k))) out[k] = v;
  }
  return out;
}

/** Names in `env` that are exchange credentials (the agent refuses to start if this is non-empty). */
export function exchangeCredentialsIn(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((k) => EXCHANGE_CREDENTIAL.test(k) && env[k]);
}
