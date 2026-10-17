import type { Dec, Hex } from "@leashagent/shared";
import type { Db } from "./db";

/**
 * OKX **read-only** credentials for L5 (§16 OKX_READ_*). Handed to an ATK child process started with
 * `--read-only --modules account,spot`; never to the executor, never to the agent.
 */
export type ReadAtkEnv = { apiKey: string; secretKey: string; passphrase: string; demo: boolean; site: string };

const SITES = new Set(["global", "eea", "us", "tr"]);

export function readAtkEnvFromProcess(env: NodeJS.ProcessEnv = process.env): ReadAtkEnv {
  const apiKey = env.OKX_READ_KEY?.trim();
  const secretKey = env.OKX_READ_SECRET?.trim();
  const passphrase = env.OKX_READ_PASSPHRASE?.trim();
  if (!apiKey || !secretKey || !passphrase) throw new Error("OKX_READ_KEY, OKX_READ_SECRET and OKX_READ_PASSPHRASE are required");
  const profile = (env.OKX_PROFILE ?? "demo").trim();
  if (profile !== "demo" && profile !== "live") throw new Error(`OKX_PROFILE must be demo or live, got ${profile}`);
  const site = (env.OKX_SITE ?? "global").trim();
  if (!SITES.has(site)) throw new Error(`OKX_SITE must be one of ${[...SITES].join(", ")}`);
  return { apiKey, secretKey, passphrase, demo: profile === "demo", site };
}

/** Durable day-start equity for `@leashagent/atk` OkxRiskProvider (EquityBaselineStore). */
export class SqliteEquityBaseline {
  constructor(private readonly db: Db, private readonly clock: () => number = () => Math.floor(Date.now() / 1000)) {}

  setIfAbsent(policyId: Hex, utcDay: string, equityUsdt: Dec): Dec {
    this.db
      .prepare("INSERT OR IGNORE INTO equity_baseline (policy_id, utc_day, equity_usdt, recorded_at) VALUES (?, ?, ?, ?)")
      .run(policyId, utcDay, equityUsdt, this.clock());
    const r = this.db
      .prepare("SELECT equity_usdt FROM equity_baseline WHERE policy_id = ? AND utc_day = ?")
      .get(policyId, utcDay) as { equity_usdt: string };
    return r.equity_usdt;
  }
}
