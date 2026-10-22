// The live security demo (scripts/live-demo.ts) is part of the regression gate: every step must match and
// no BLOCK / REVOKED / REJECTED step may write to the exchange.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("live security demo", () => {
  it("runs end to end with 0 exchange writes on every rejected step", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/live-demo.ts"], { encoding: "utf8", timeout: 120_000 });
    const out = r.stdout.replace(/\x1b\[[0-9;]*m/g, "");
    expect(out).toMatch(/steps (\d+)\/\1 as expected/);
    expect(out).toContain("Every BLOCK / REVOKED / REJECTED step: 0 OKX writes");
    expect(r.status).toBe(0);
  }, 150_000);
});
