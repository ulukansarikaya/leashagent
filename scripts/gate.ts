/**
 * Full regression gate. Runs everything that can run here and reports, explicitly, what was SKIPPED and why
 * (a skipped live check is never reported as a pass).
 *
 *   npm run gate                       # development: live checks without credentials are SKIPPED
 *   npm run gate -- --require-live     # FINAL (or FINAL_GATE=1): a required live check that cannot run is a FAIL
 *
 * Live checks run when their credentials are in .env / the environment:
 *   Fuji E2E      LOGGER_PRIVATE_KEY, DEPLOYER_ADDRESS, AGENT_AUTH_KEY (delegated in the Fuji demo policy)
 *   OKX demo E2E  OKX_MODE=atk + OKX_READ_* + OKX_TRADE_* (demo account, Read+Trade, no withdraw)
 *   x402 real     X402_MODE=payai + X402_AGENT_KEY (Fuji wallet with ≥ 0.10 USDC)
 *   Jev live      JEV_ENDPOINT (+ AUDITOR_API_KEY if required)
 * In final mode the OKX E2E also requires the SELL leg (fund the demo account with BTC).
 */
import { spawn, spawnSync } from "node:child_process";

type Result = { name: string; status: "PASS" | "FAIL" | "SKIPPED"; detail: string; secs: number };
const results: Result[] = [];
const env = process.env;
const FINAL = process.argv.includes("--require-live") || env.FINAL_GATE === "1";

function run(name: string, cmd: string, args: string[], extraEnv: Record<string, string> = {}, timeoutMs = 600_000) {
  const t0 = Date.now();
  process.stdout.write(`… ${name}\n`);
  const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...env, ...extraEnv }, timeout: timeoutMs });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "");
  const tests = out.match(/Tests\s+(\d+ passed[^\n]*)/)?.[1] ?? out.match(/(\d+ tests passed, \d+ failed[^\n]*)/)?.[1]
    ?? out.match(/^(PASS|FAIL)[^\n]*/m)?.[0] ?? out.match(/steps \d+\/\d+ as expected/)?.[0] ?? "";
  results.push({ name, status: r.status === 0 ? "PASS" : "FAIL", detail: r.status === 0 ? tests : (tests || out.trim().split("\n").slice(-3).join(" | ")), secs: (Date.now() - t0) / 1000 });
}
// In final mode a required live check that cannot run fails the gate.
const skip = (name: string, why: string) =>
  results.push({ name, status: FINAL ? "FAIL" : "SKIPPED", detail: FINAL ? `REQUIRED in final mode — ${why}` : why, secs: 0 });
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

run("typecheck", npm, ["run", "-s", "typecheck"]);
run("TypeScript tests (unit, integration, invariants, attacks, acceptance vs simulated, TEE, demo)", npx, ["vitest", "run"]);
run("Solidity tests (forge)", npm, ["run", "-s", "test:contracts"]);
run("invariants + attacks (exchange-write assertions)", npx, ["vitest", "run", "tests/invariants", "tests/attacks"]);

// Acceptance suite against the REAL gateway/executor code: in-process with state controls (all tests, no skips) …
run("acceptance suite vs real gateway (in-process, all 25 incl. state-dependent)", npx, ["vitest", "run", "tests/acceptance"], { LEASH_ACCEPTANCE_TARGET: "dev" });
// … and against a gateway in a separate process, over HTTP only (state-dependent tests skip by design).
{
  const t0 = Date.now();
  const gw = spawn(process.execPath, ["--import", "tsx", "scripts/dev-gateway.ts"], { env: { ...env, PORT: "0" } });
  let log = "";
  gw.stdout.on("data", (d: Buffer) => (log += d.toString()));
  await new Promise<void>((resolve) => {
    const iv = setInterval(() => { if (/LEASH_TEST_OVERLIMIT_SZ/.test(log) || Date.now() - t0 > 60_000) { clearInterval(iv); resolve(); } }, 200);
  });
  const vars = Object.fromEntries([...log.matchAll(/^export (\w+)='?([^'\n]*)'?$/gm)].map((m) => [m[1]!, m[2]!]));
  if (vars.LEASH_GATEWAY_URL) run("acceptance suite vs real gateway in a separate process (HTTP only)", npx, ["vitest", "run", "tests/acceptance"], vars);
  else results.push({ name: "acceptance suite vs real gateway + executor", status: "FAIL", detail: "dev gateway did not start", secs: 0 });
  gw.kill();
}

run("live security demo (0 OKX writes on every rejected step)", process.execPath, ["--import", "tsx", "scripts/live-demo.ts"]);
run("OKX demo E2E — dry run (simulated exchange)", process.execPath, ["--import", "tsx", "scripts/okx-demo-e2e.ts"], { OKX_MODE: "" });

if (env.OKX_MODE === "atk" && env.OKX_TRADE_KEY && env.OKX_READ_KEY) {
  run("OKX demo E2E — LIVE (real OKX demo account)", process.execPath, ["--import", "tsx", "scripts/okx-demo-e2e.ts"], FINAL ? { OKX_E2E_REQUIRE_SELL: "1" } : {});
}
else skip("OKX demo E2E — LIVE", "needs OKX_MODE=atk + OKX_READ_* + OKX_TRADE_* (demo account)");

run("x402 E2E — mock settlement", process.execPath, ["--import", "tsx", "scripts/x402-e2e.ts"], { X402_MODE: "" });
if (env.X402_MODE === "payai" && env.X402_AGENT_KEY) run("x402 E2E — REAL (PayAI, Fuji USDC)", process.execPath, ["--import", "tsx", "scripts/x402-e2e.ts"]);
else skip("x402 E2E — REAL", "needs X402_MODE=payai + X402_AGENT_KEY (Fuji wallet with USDC)");

if (env.JEV_ENDPOINT) run("Jev live smoke (real endpoint, direct + through the gateway)", process.execPath, ["--import", "tsx", "scripts/jev-smoke.ts"]);
else skip("Jev live smoke", "needs JEV_ENDPOINT (+ AUDITOR_API_KEY)");

if (env.LOGGER_PRIVATE_KEY && env.DEPLOYER_ADDRESS && env.AGENT_AUTH_KEY) run("Fuji E2E (PolicyRegistry + DecisionLog on Avalanche Fuji)", process.execPath, ["--import", "tsx", "scripts/fuji-e2e.ts"]);
else skip("Fuji E2E", "needs LOGGER_PRIVATE_KEY, DEPLOYER_ADDRESS, AGENT_AUTH_KEY in .env");

const icon = { PASS: "\x1b[32mPASS\x1b[0m", FAIL: "\x1b[31mFAIL\x1b[0m", SKIPPED: "\x1b[33mSKIP\x1b[0m" };
const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const dirty = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" }).stdout.trim() !== "";
console.log(`\nRegression gate${FINAL ? " — FINAL (required live checks)" : ""} · commit ${head.slice(0, 12)}${dirty ? " (+ uncommitted changes)" : ""} · ${new Date().toISOString()}`);
for (const r of results) console.log(`${icon[r.status]}  ${r.name.padEnd(78)} ${r.secs ? `${r.secs.toFixed(0)}s` : ""}  ${r.detail}`);
const failed = results.filter((r) => r.status === "FAIL").length;
const skipped = results.filter((r) => r.status === "SKIPPED").length;
console.log(`\n${failed ? `\x1b[31m${failed} FAILED\x1b[0m` : "\x1b[32mall run checks passed\x1b[0m"}${skipped ? ` · ${skipped} live check(s) SKIPPED — not verified (final gate: --require-live)` : ""}`);
if (FINAL && dirty) console.log("\x1b[33mnote: uncommitted changes — a final gate result applies to a clean commit only\x1b[0m");
process.exit(failed ? 1 : 0);
