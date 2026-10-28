/**
 * The real agent path against the real gateway/executor, and INV-1 at the process boundary.
 */
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { FixtureMarketObserver, IntentBuilder, LeashClient, RuleReviewer, TradingAgent, agentProcessEnv, exchangeCredentialsIn } from "@leashagent/agent";
import { privateKeyToAccount } from "@leashagent/shared";
import { buildDevGateway } from "../../scripts/lib/devGateway";

describe("INV-1: the agent process holds no exchange credential", () => {
  const parent = {
    PATH: "/usr/bin", HOME: "/home/x",
    OKX_TRADE_KEY: "t", OKX_TRADE_SECRET: "s", OKX_TRADE_PASSPHRASE: "p", OKX_READ_KEY: "r", OKX_API_KEY: "a", OKX_SECRET_KEY: "b", OKX_PASSPHRASE: "c",
    AGENT_OKX_API_KEY: "sneaky", LEASH_OKX_SECRET: "sneaky",
    LOGGER_PRIVATE_KEY: "0xlog", GUARD_SIGNING_KEY: "0xguard", DEPLOYER_PRIVATE_KEY: "0xdep", ANTHROPIC_API_KEY: "sk",
    AGENT_AUTH_KEY: "0xagent", AGENT_LLM_API_KEY: "llm", LEASH_URL: "http://g", OKX_PUBLIC_BASE: "https://www.okx.com",
  };

  it("the launcher's allow-list drops every exchange key and unrelated secret", () => {
    const env = agentProcessEnv(parent);
    expect(exchangeCredentialsIn(env)).toEqual([]);
    expect(Object.keys(env).filter((k) => k.includes("OKX"))).toEqual([]);
    for (const k of ["LOGGER_PRIVATE_KEY", "GUARD_SIGNING_KEY", "DEPLOYER_PRIVATE_KEY", "ANTHROPIC_API_KEY"]) expect(env[k]).toBeUndefined();
    expect(env).toMatchObject({ AGENT_AUTH_KEY: "0xagent", AGENT_LLM_API_KEY: "llm", LEASH_URL: "http://g", PATH: "/usr/bin" });
  });

  it.each(["OKX_TRADE_KEY", "OKX_READ_SECRET", "OKX_API_KEY", "OKX_PASSPHRASE"])("the agent refuses to start with %s in its env", (name) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "packages/agent/src/main.ts"], {
      env: { PATH: process.env.PATH, [name]: "x", AGENT_AUTH_KEY: generatePrivateKey(), LEASH_URL: "http://127.0.0.1:9", LEASH_POLICY_ID: "0x00", AGENT_ID: "a" },
      encoding: "utf8", timeout: 30_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refusing to start: .*credentials/);
  });
});

describe("agent loop → real gateway: 402 → x402 credits → ALLOW → one exchange write", () => {
  let g: Awaited<ReturnType<typeof buildDevGateway>>;
  let url = "";
  beforeAll(async () => {
    g = await buildDevGateway({ credits: "x402", price: "60000" });
    url = await g.listen();
  });
  afterAll(() => g.close());

  it("buys credits once, then the new signed intent is authorized and written once", async () => {
    const acct = privateKeyToAccount(g.agentKey);
    const { policyId, agentId } = g.policy.binding;
    const client = new LeashClient(url, acct, policyId);
    const rising = [...Array(20)].map((_, i) => 59400 + i * 20).concat([59800, 59900, 60000, 60000, 60000]);
    const agent = new TradingAgent(
      { instId: "BTC-USDT", mandate: "trend", orderSizeBase: "0.0001", readQueries: [{ source: "news", query: "bitcoin" }], x402: "mock" },
      new FixtureMarketObserver(rising, 0), new RuleReviewer(), new IntentBuilder(acct, policyId, agentId), client,
    );
    expect(g.credits!.available(policyId, agentId, acct.address)).toBe(0);
    const r = await agent.tick();
    expect(r.payment).toMatchObject({ ok: true });
    expect(["ALLOWED", "SUBMITTED", "ACKNOWLEDGED", "FILLED"]).toContain(r.response?.status);
    expect(g.atk.writes).toHaveLength(1);
    expect(g.credits!.available(policyId, agentId, acct.address)).toBe(4); // 5 bought, the ALLOW consumed one
  });
});
