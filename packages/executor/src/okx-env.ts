/**
 * The executor's OKX trade credentials (§16). OKX_TRADE_* exists only in this process; it is handed
 * to the ATK child process as OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE (ATK gives env
 * precedence over ~/.okx/config.toml) and to nothing else.
 */
export type TradeAtkEnv = {
  apiKey: string;
  secretKey: string;
  passphrase: string;
  demo: boolean;
  site: string;
  timeoutMs?: number;
};

const SITES = new Set(["global", "eea", "us", "tr"]);

export function tradeAtkEnvFromProcess(env: NodeJS.ProcessEnv = process.env): TradeAtkEnv {
  const apiKey = env.OKX_TRADE_KEY?.trim();
  const secretKey = env.OKX_TRADE_SECRET?.trim();
  const passphrase = env.OKX_TRADE_PASSPHRASE?.trim();
  if (!apiKey || !secretKey || !passphrase) {
    throw new Error("OKX_TRADE_KEY, OKX_TRADE_SECRET and OKX_TRADE_PASSPHRASE are required");
  }
  const profile = (env.OKX_PROFILE ?? "demo").trim();
  if (profile !== "demo" && profile !== "live") throw new Error(`OKX_PROFILE must be demo or live, got ${profile}`);
  const site = (env.OKX_SITE ?? "global").trim();
  if (!SITES.has(site)) throw new Error(`OKX_SITE must be one of ${[...SITES].join(", ")}`);
  const out: TradeAtkEnv = { apiKey, secretKey, passphrase, demo: profile === "demo", site };
  const t = env.OKX_TIMEOUT_MS ? Number(env.OKX_TIMEOUT_MS) : undefined;
  if (t !== undefined && Number.isInteger(t) && t > 0) out.timeoutMs = t;
  return out;
}
