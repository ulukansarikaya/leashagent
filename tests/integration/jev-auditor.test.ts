/**
 * Jev as the auditor on the real gateway (AUDITOR_PROVIDER=jev): it can only tighten. Timeout, unreachable or
 * out-of-schema answers → PENDING 302; a deterministic rule BLOCK is final and Jev is not even asked.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount, type OrderIntent } from "@leashagent/shared";
import { IntentBuilder, LeashClient } from "@leashagent/agent";
import { buildDevGateway } from "../../scripts/lib/devGateway";

type Mode = "allow" | "block" | "slow" | "garbage" | "down";
let mode: Mode = "allow";
let calls = 0;
const jev: Server = createServer((req, res) => {
  calls++;
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (mode === "down") { res.statusCode = 503; return res.end("unavailable"); }
    if (mode === "slow") return setTimeout(() => res.end("{}"), 5_000);
    res.setHeader("content-type", "application/json");
    if (mode === "garbage") return res.end(JSON.stringify({ result: { verdict: "looks fine to me" } }));
    const v = mode === "allow" ? { allow: "0.9", block: "0.05", askHuman: "0.05" } : { allow: "0.05", block: "0.9", askHuman: "0.05" };
    res.end(JSON.stringify({ result: { consistency: "0.9", injectionSuspicion: mode === "block" ? "0.1" : "0.05", verdict: v } }));
  });
});

let g: Awaited<ReturnType<typeof buildDevGateway>>;
let client: LeashClient;
let builder: IntentBuilder;
const limit = (sz: string): OrderIntent => ({ tool: "spot_place_order", instId: "BTC-USDT", side: "buy", ordType: "limit", sz, px: "60000" });
const submit = async (sz = "0.0001") => client.submitIntent(await builder.build(limit(sz), "sma crossover", []));

beforeAll(async () => {
  await new Promise<void>((r) => jev.listen(0, "127.0.0.1", r));
  process.env.AUDITOR_PROVIDER = "jev";
  process.env.JEV_ENDPOINT = `http://127.0.0.1:${(jev.address() as { port: number }).port}/audit`;
  process.env.AUDITOR_TIMEOUT_MS = "1500";
  g = await buildDevGateway();
  const url = await g.listen();
  const acct = privateKeyToAccount(g.agentKey);
  client = new LeashClient(url, acct, g.policy.binding.policyId);
  builder = new IntentBuilder(acct, g.policy.binding.policyId, g.policy.binding.agentId);
  expect((await (await fetch(`${url}/v1/health`)).json()).auditor).toMatchObject({ provider: "jev", role: "production" });
});
afterAll(() => {
  g.close(); jev.close();
  delete process.env.AUDITOR_PROVIDER; delete process.env.JEV_ENDPOINT; delete process.env.AUDITOR_TIMEOUT_MS;
});

describe("Jev auditor on the real gateway", () => {
  it("Jev allows → the order is authorized and written once", async () => {
    mode = "allow";
    expect((await submit()).status).toMatch(/ALLOWED|SUBMITTED|ACKNOWLEDGED|FILLED/);
    expect(g.atk.writes).toHaveLength(1);
  });

  it("Jev blocks → BLOCKED 203, no write", async () => {
    mode = "block";
    expect(await submit()).toMatchObject({ status: "BLOCKED", reasonCode: 203 });
    expect(g.atk.writes).toHaveLength(1);
  });

  it.each(["slow", "garbage", "down"] as const)("Jev %s → PENDING 302, never an automatic ALLOW", async (m) => {
    mode = m;
    expect(await submit()).toMatchObject({ status: "PENDING", reasonCode: 302 });
    expect(g.atk.writes).toHaveLength(1);
  });

  it("a deterministic rule BLOCK is final: Jev is not consulted and cannot override it", async () => {
    mode = "allow";
    const before = calls;
    expect(await submit("5")).toMatchObject({ status: "BLOCKED", reasonCode: 103 });
    expect(calls).toBe(before);
    expect(g.atk.writes).toHaveLength(1);
  });
});
