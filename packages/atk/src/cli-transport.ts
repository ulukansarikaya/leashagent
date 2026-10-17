import type { spawn as nodeSpawn } from "node:child_process";
import { createRequire } from "node:module";
import { buildAtkEnv, type AtkCallResult, type AtkProcessEnv, type AtkTransport } from "./types";

export type CliTransportOptions = {
  /** Default: "okx" (npm i -g @okx_ai/okx-trade-cli). */
  command?: string;
  commandArgs?: string[];
  env: AtkProcessEnv;
  /** Kill the CLI after this long; a killed write is "uncertain". */
  timeoutMs?: number;
};

// cross-spawn (as used by the MCP SDK's stdio transport): resolves `okx` to npm's `okx.cmd` on Windows and
// escapes arguments correctly. Plain child_process.spawn refuses .cmd files there (EINVAL).
const spawn = createRequire(import.meta.url)("cross-spawn") as typeof nodeSpawn;

/** Tool name -> CLI argv (flags as read by packages/cli/src/commands/spot.ts). */
function argv(name: string, a: Record<string, unknown>): string[] {
  const flag = (k: string) => (a[k] !== undefined && a[k] !== null ? [`--${k}`, String(a[k])] : []);
  switch (name) {
    case "spot_place_order":
      return ["spot", "place", ...flag("instId"), ...flag("side"), ...flag("ordType"), ...flag("sz"), ...flag("tdMode"),
        ...flag("tgtCcy"), ...flag("px"), ...flag("clOrdId")];
    case "spot_cancel_order":
      return ["spot", "cancel", ...flag("instId"), ...flag("ordId"), ...flag("clOrdId")];
    case "spot_get_order":
      return ["spot", "get", ...flag("instId"), ...flag("ordId"), ...flag("clOrdId")];
    case "market_get_ticker":
      return ["market", "ticker", String(a.instId)];
    default:
      throw new Error(`no CLI mapping for ${name}`);
  }
}

/**
 * Fallback transport over `okx ... --json`. Weaker than MCP: the CLI prints errors as text
 * ("Error: …", "Code: …", "Hint: …") without the error type, so a failure is only classified as an
 * OKX rejection when a numeric `Code:` line is present; everything else surfaces as NetworkError /
 * InternalError and therefore as "uncertain" for writes.
 */
export class CliTransport implements AtkTransport {
  constructor(private readonly o: CliTransportOptions) {}

  callTool(name: string, args: Record<string, unknown>): Promise<AtkCallResult> {
    const fullArgs = [...(this.o.commandArgs ?? []), ...argv(name, args), "--json"];
    return new Promise((resolve, reject) => {
      const child = spawn(this.o.command ?? "okx", fullArgs, { env: buildAtkEnv(this.o.env), stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("ATK CLI timed out"));
      }, this.o.timeoutMs ?? 20_000);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          try {
            const parsed = JSON.parse(out) as unknown;
            // okx-trade-cli 1.4.x prints the raw `data` array with --json; older builds printed
            // `{ endpoint, requestTime, data }`. Anything else is not a recognizable result.
            if (Array.isArray(parsed)) return resolve({ ok: true, response: { data: parsed } });
            const o = parsed as { endpoint?: string; requestTime?: string; data?: unknown } | null;
            if (!o || typeof o !== "object" || !("data" in o)) return reject(new Error("ATK CLI output without data"));
            return resolve({ ok: true, response: { endpoint: o.endpoint, requestTime: o.requestTime, data: o.data } });
          } catch {
            return reject(new Error("ATK CLI output is not JSON"));
          }
        }
        const line = (p: string) => err.split(/\r?\n/).find((l) => l.startsWith(p))?.slice(p.length).trim();
        const message = line("Error:") ?? "ATK CLI failed";
        const okxCode = line("Code:");
        const hint = line("Hint:") ?? "";
        const type = /network connectivity/i.test(hint) ? "NetworkError" : okxCode && /^\d+$/.test(okxCode) ? "OkxApiError" : "InternalError";
        resolve({ ok: false, error: { type, message, ...(okxCode ? { code: okxCode } : {}), ...(hint ? { suggestion: hint } : {}) } });
      });
    });
  }

  async close(): Promise<void> {}
}
