/**
 * Avalanche evidence (L7 → DecisionLog) under a chain RPC outage, on the real gateway + executor:
 * decisions and executions are never delayed or changed by the chain (INV-15); records wait in the durable
 * outbox and are written once the RPC is back, with the right verdicts. Evidence ≠ proof of an OKX fill.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DecisionLogPort } from "@leashagent/chain";
import { privateKeyToAccount, signApproval, type ChainRecord, type Hex, type IntentResponse, type OrderIntent } from "@leashagent/shared";
import { IntentBuilder, LeashClient } from "@leashagent/agent";
import { buildDevGateway } from "../../scripts/lib/devGateway";

let rpcUp = false;
const written: ChainRecord[] = [];
const port: DecisionLogPort = {
  isApplied: async () => false,
  simulate: async () => { if (!rpcUp) throw new Error("fetch failed: ECONNREFUSED (RPC down)"); },
  send: async (r) => { if (!rpcUp) throw new Error("RPC down"); written.push(r); return `0x${randomBytes(32).toString("hex")}` as Hex; },
  waitForReceipt: async () => "success",
};

let g: Awaited<ReturnType<typeof buildDevGateway>>;
let url = "";
let client: LeashClient;
let builder: IntentBuilder;
const limit = (sz: string): OrderIntent => ({ tool: "spot_place_order", instId: "BTC-USDT", side: "buy", ordType: "limit", sz, px: "60000" });
const health = async () => (await (await fetch(`${url}/v1/health`)).json()).chain.outbox as Record<string, number>;
const waitFor = async (cond: () => Promise<boolean>, ms = 15_000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 200))) if (await cond()) return true;
  return false;
};

beforeAll(async () => {
  g = await buildDevGateway({ decisionLog: port });
  url = await g.listen();
  const acct = privateKeyToAccount(g.agentKey);
  client = new LeashClient(url, acct, g.policy.binding.policyId);
  builder = new IntentBuilder(acct, g.policy.binding.policyId, g.policy.binding.agentId);
});
afterAll(() => g.close());

describe("chain RPC outage does not touch the trading hot path", () => {
  const results: IntentResponse[] = [];

  it("ALLOW, BLOCK and PENDING are decided at once while the RPC is down; the exchange write still happens", async () => {
    const t0 = Date.now();
    results.push(await client.submitIntent(await builder.build(limit("0.0001"), "x", [])));
    results.push(await client.submitIntent(await builder.build(limit("5"), "x", [])));
    results.push(await client.submitIntent(await builder.build(limit("0.006"), "x", [])));
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(results.map((r) => r.status)).toEqual([expect.stringMatching(/ACKNOWLEDGED|FILLED|SUBMITTED/), "BLOCKED", "PENDING"]);
    expect(g.atk.writes).toHaveLength(1);
  });

  it("evidence waits in the outbox (pending, never dead) — the dashboard shows it as delayed", async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const o = await health();
    expect(o.pending + o.submitted).toBeGreaterThan(0);
    expect(o.dead).toBe(0);
    expect(written).toHaveLength(0);
  });

  it("once the RPC is back every record is written, with DecisionLog verdicts and execution events", async () => {
    // Approve the pending order meanwhile → a HUMAN_APPROVED record follows its PENDING one.
    const d = await (await fetch(`${url}/v1/intents/${results[2]!.requestId}`)).json();
    const a = await signApproval(g.owner, {
      requestId: results[2]!.requestId, policyId: g.policy.binding.policyId, normalizedOrderHash: d.normalizedOrderHash,
      decision: "approve", nonce: `0x${randomBytes(16).toString("hex")}` as Hex, expiresAt: g.clock() + 60,
    });
    await fetch(`${url}/v1/approvals`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a) });
    rpcUp = true;
    expect(await waitFor(async () => { const o = await health(); return o.pending + o.submitted === 0 && o.confirmed > 0; })).toBe(true);
    const verdicts = written.filter((r) => r.kind === "decision").map((r) => (r as { verdict: string }).verdict);
    expect(verdicts).toEqual(expect.arrayContaining(["ALLOW", "BLOCK", "PENDING", "HUMAN_APPROVED"]));
    expect(written.filter((r) => r.kind === "execution").length).toBeGreaterThanOrEqual(2);
    expect((await health()).dead).toBe(0);
  }, 30_000);
});
