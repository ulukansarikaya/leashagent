/** ATK's serialized error (core `toToolErrorPayload`). */
export type AtkErrorPayload = {
  type: "ConfigError" | "AuthenticationError" | "RateLimitError" | "ValidationError" | "OkxApiError" | "NetworkError" | "InternalError" | string;
  code?: string;
  message: string;
  suggestion?: string;
  traceId?: string;
};

/**
 * One ATK tool call. `ok: true` carries ATK's normalized response `{ endpoint, requestTime, data }`.
 * A transport-level failure (process died, call timed out, malformed reply) is a *thrown* error:
 * for writes that always means "outcome unknown".
 */
export type AtkCallResult =
  | { ok: true; response: { endpoint?: string; requestTime?: string; data: unknown } }
  | { ok: false; error: AtkErrorPayload };

export interface AtkTransport {
  callTool(name: string, args: Record<string, unknown>): Promise<AtkCallResult>;
  close(): Promise<void>;
}

/** Credentials and environment handed to the ATK child process (never inherited wholesale). */
export type AtkProcessEnv = {
  apiKey?: string;
  secretKey?: string;
  passphrase?: string;
  /** Simulated trading (x-simulated-trading: 1). */
  demo: boolean;
  /** global | eea | us | tr */
  site: string;
  timeoutMs?: number;
};

/**
 * Build a minimal environment for the ATK process: only what Node needs to run plus the OKX
 * variables ATK reads (env takes precedence over ~/.okx/config.toml in ATK's config loader).
 * Nothing else from the parent environment — in particular no other keys — is passed through.
 */
export function buildAtkEnv(e: AtkProcessEnv, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC", "NODE_EXTRA_CA_CERTS"];
  const env: Record<string, string> = {};
  for (const k of keep) {
    const v = parent[k];
    if (v !== undefined) env[k] = v;
  }
  if (e.apiKey !== undefined) env.OKX_API_KEY = e.apiKey;
  if (e.secretKey !== undefined) env.OKX_SECRET_KEY = e.secretKey;
  if (e.passphrase !== undefined) env.OKX_PASSPHRASE = e.passphrase;
  env.OKX_DEMO = e.demo ? "1" : "0";
  env.OKX_SITE = e.site;
  if (e.timeoutMs !== undefined) env.OKX_TIMEOUT_MS = String(e.timeoutMs);
  return env;
}
