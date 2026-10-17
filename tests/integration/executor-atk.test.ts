import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bytesToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hashCanonical, normalizeOrder, signAuthorization, type ExecutionAuthorization } from "@leashagent/shared";
import { BTC_USDT, MockPolicyChain, limitBuy, mockPolicy } from "@leashagent/mocks";
import { DefaultExecutor, openExecutorDb, tradeAtkEnvFromProcess } from "@leashagent/executor";
import { McpStdioTransport, OkxAtkClient } from "@leashagent/atk";

const FAKE_MCP = join(__dirname, "..", "..", "packages", "atk", "test", "fixtures", "fake-okx-mcp.mjs");

/** Real executor + real OkxAtkClient + real MCP stdio transport; only OKX itself is faked. */
async function setup(mode = "ok") {
  const now = Math.floor(Date.now() / 1000);
  const chain = new MockPolicyChain();
  const policy = mockPolicy("0x2222222222222222222222222222222222222222", {}, now);
  chain.publish(policy);
  const guard = privateKeyToAccount(generatePrivateKey());
  const transport = new McpStdioTransport({
    command: process.execPath,
    commandArgs: [FAKE_MCP, `--fake-mode=${mode}`],
    modules: ["spot"],
    readOnly: false,
    env: tradeAtkEnvFromProcess({ OKX_TRADE_KEY: "k", OKX_TRADE_SECRET: "s", OKX_TRADE_PASSPHRASE: "p", OKX_PROFILE: "demo" }),
    callTimeoutMs: 1500,
  });
  const executor = new DefaultExecutor({
    db: openExecutorDb(),
    atk: new OkxAtkClient(transport),
    policyState: chain,
    config: { guardSignerAddress: guard.address, guardInstanceId: "g", accountRef: policy.binding.accountRef, allowedTools: ["spot_place_order", "spot_cancel_order"], clockSkewSec: 60 },
    clock: () => Math.floor(Date.now() / 1000),
  });
  async function authorize(intent = limitBuy()) {
    const requestId = crypto.randomUUID();
    const order = normalizeOrder(intent, BTC_USDT, requestId, policy.binding.policyId);
    const unsigned: Omit<ExecutionAuthorization, "signature"> = {
      requestId, policyId: policy.binding.policyId, policyVersion: 1, accountRef: policy.binding.accountRef,
      agentId: policy.binding.agentId, tool: order.tool, normalizedOrderHash: hashCanonical(order),
      nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(16))), issuedAt: now, expiresAt: now + 30,
      guardInstanceId: "g", basis: "rules_only",
    };
    return { auth: await signAuthorization(guard, unsigned), order };
  }
  return { executor, transport, authorize };
}

let s: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => { await s?.transport.close(); s = undefined; });

describe("executor ⇄ OkxAtkClient ⇄ MCP stdio ⇄ (fake) okx-trade-mcp", () => {
  it("limit order: submitted then acknowledged via clOrdId query", async () => {
    s = await setup();
    const { auth, order } = await s.authorize();
    expect((await s.executor.execute(auth, order)).map((e) => e.status)).toEqual(["submitted", "acknowledged"]);
  });

  it("market order: submitted then filled", async () => {
    s = await setup();
    const { auth, order } = await s.authorize(limitBuy({ ordType: "market", px: undefined }));
    expect((await s.executor.execute(auth, order)).map((e) => e.status)).toEqual(["submitted", "filled"]);
  });

  it("OKX rejection -> rejected_by_okx", async () => {
    s = await setup("reject");
    const { auth, order } = await s.authorize();
    expect((await s.executor.execute(auth, order)).map((e) => [e.status, e.okxCode])).toEqual([["rejected_by_okx", "1"]]);
  });

  it.each(["network", "http502", "timeout50004", "hang"])("%s -> unknown (never resent)", async (mode) => {
    s = await setup(mode);
    const { auth, order } = await s.authorize();
    expect((await s.executor.execute(auth, order)).map((e) => e.status)).toEqual(["unknown"]);
    await expect(s.executor.execute(auth, order)).rejects.toMatchObject({ name: "ExecutionRejected" });
  }, 10_000);

  it("tradeAtkEnvFromProcess refuses missing keys and bad profile/site", () => {
    expect(() => tradeAtkEnvFromProcess({})).toThrow();
    expect(() => tradeAtkEnvFromProcess({ OKX_TRADE_KEY: "k", OKX_TRADE_SECRET: "s", OKX_TRADE_PASSPHRASE: "p", OKX_PROFILE: "prod" })).toThrow();
    expect(() => tradeAtkEnvFromProcess({ OKX_TRADE_KEY: "k", OKX_TRADE_SECRET: "s", OKX_TRADE_PASSPHRASE: "p", OKX_SITE: "mars" })).toThrow();
    expect(tradeAtkEnvFromProcess({ OKX_TRADE_KEY: "k", OKX_TRADE_SECRET: "s", OKX_TRADE_PASSPHRASE: "p", OKX_SITE: "tr" })).toMatchObject({ demo: true, site: "tr" });
  });
});
