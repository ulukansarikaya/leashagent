import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, defineChain, http, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mockIdentityRegistryAbi, mockIdentityRegistryBytecode } from "@bekci/chain";
import type { Hex } from "@bekci/shared";
import {
  Erc8004Registry,
  agentIdMatchesBinding,
  bekciRegistration,
  formatAgentId,
  loadRegistration,
  parseAgentId,
  registrationSchema,
  toDataUri,
  tradingAgentRegistration,
} from "../src/index.js";

const REG = "0x8004000000000000000000000000000000000001" as Hex;

describe("agentId", () => {
  it("formats and parses canonically", () => {
    const id = formatAgentId(43113, REG.toLowerCase() as Hex, "42");
    expect(id).toBe("eip155:43113:0x8004000000000000000000000000000000000001:42");
    expect(parseAgentId(id)).toEqual({ chainId: 43113, agentRegistry: REG, agentRegistryId: "42" });
  });
  it("binds to exactly the policy's registry identity", () => {
    const b = { agentRegistry: REG, agentRegistryId: "42" };
    const id = formatAgentId(43113, REG, "42");
    expect(agentIdMatchesBinding(id, b, 43113)).toBe(true);
    expect(agentIdMatchesBinding(formatAgentId(43113, REG, "43"), b, 43113)).toBe(false);
    expect(agentIdMatchesBinding(id, b, 1)).toBe(false);
    const mixed = { agentRegistry: "0xabcdef000000000000000000000000000000beef" as Hex, agentRegistryId: "1" };
    const canon = formatAgentId(43113, mixed.agentRegistry, "1");
    expect(canon).not.toBe(canon.toLowerCase());
    expect(agentIdMatchesBinding(canon, mixed, 43113)).toBe(true);
    expect(agentIdMatchesBinding(canon.toLowerCase(), mixed, 43113)).toBe(false); // non-canonical spelling
    expect(agentIdMatchesBinding("eip155:43113:0x8004000000000000000000000000000000000001:042", b, 43113)).toBe(false);
    expect(agentIdMatchesBinding("bekci-demo-agent", b, 43113)).toBe(false);
  });
});

describe("registration metadata", () => {
  it("builds valid Bekci and agent cards", () => {
    const b = bekciRegistration({ baseUrl: "https://bekci.example/" });
    expect(b.endpoints.map((e) => e.endpoint)).toContain("https://bekci.example/v1/intents");
    expect(b.payment).toEqual({ protocol: "x402", network: "avalanche-fuji" });
    expect(tradingAgentRegistration({ name: "Demo", description: "d" }).kind).toBe("trading-agent");
  });
  it("rejects extra fields (no private data can ride along)", () => {
    const b = bekciRegistration({ baseUrl: "https://bekci.example" });
    expect(registrationSchema.safeParse({ ...b, okxApiKey: "secret" }).success).toBe(false);
  });
  it("round-trips through data: URI and rejects other schemes", async () => {
    const b = bekciRegistration({ baseUrl: "https://bekci.example" });
    expect(await loadRegistration(toDataUri(b))).toEqual(b);
    await expect(loadRegistration("file:///etc/passwd")).rejects.toThrow();
    await expect(loadRegistration("http://insecure.example/x.json")).rejects.toThrow();
  });
});

const ANVIL = process.env.ANVIL_BIN ?? `${homedir()}/.foundry/bin/anvil`;
const PORT = 19545 + Math.floor(Math.random() * 1000);
const chain = defineChain({
  id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [`http://127.0.0.1:${PORT}`] } },
});
const deployer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const agentOwner = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

(existsSync(ANVIL) ? describe : describe.skip)("ERC-8004 discovery (anvil)", () => {
  let anvil: ChildProcess | undefined;
  let pub: PublicClient;
  let registry: Address;

  beforeAll(async () => {
    anvil = spawn(ANVIL, ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    pub = createPublicClient({ chain, transport: http(), pollingInterval: 100 }) as PublicClient;
    for (let i = 0; i < 50; i++) {
      try { await pub.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const w = createWalletClient({ account: deployer, chain, transport: http() });
    const hash = await w.deployContract({ abi: mockIdentityRegistryAbi, bytecode: mockIdentityRegistryBytecode });
    registry = (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  }, 30_000);
  afterAll(() => { anvil?.kill(); });

  it("publishes Bekci + agent and discovers Bekci by kind", async () => {
    const asDeployer = new Erc8004Registry({
      publicClient: pub, registry, chainId: 31337, chain,
      walletClient: createWalletClient({ account: deployer, chain, transport: http() }), account: deployer,
    });
    const asAgent = new Erc8004Registry({
      publicClient: pub, registry, chainId: 31337, chain,
      walletClient: createWalletClient({ account: agentOwner, chain, transport: http() }), account: agentOwner,
    });

    const bekciId = await asDeployer.publishBekci(bekciRegistration({ baseUrl: "https://bekci.example" }));
    const agentId = await asAgent.publishAgent(tradingAgentRegistration({ name: "Demo Trader", description: "SMA bot" }));
    expect(bekciId).toBe(formatAgentId(31337, registry, "1"));
    expect(agentId).toBe(formatAgentId(31337, registry, "2"));

    await expect(asAgent.publishBekci(tradingAgentRegistration({ name: "x", description: "y" }))).rejects.toThrow(/kind/);

    const found = await asAgent.discover("agent-security-gateway");
    expect(found).toHaveLength(1);
    expect(found[0]!.registration.name).toBe("Bekci");
    expect(found[0]!.owner).toBe(deployer.address);

    const resolved = await asDeployer.resolve("2");
    expect(resolved.owner).toBe(agentOwner.address);
    expect(agentIdMatchesBinding(resolved.agentId, { agentRegistry: registry, agentRegistryId: "2" }, 31337)).toBe(true);
  });

  it("skips identities with junk metadata", async () => {
    const w = createWalletClient({ account: agentOwner, chain, transport: http() });
    await pub.waitForTransactionReceipt({ hash: await w.writeContract({
      address: registry, abi: mockIdentityRegistryAbi, functionName: "register", args: ["data:application/json;base64,e30="],
    }) });
    const r = new Erc8004Registry({ publicClient: pub, registry, chainId: 31337 });
    expect((await r.discover("agent-security-gateway")).map((x) => x.agentRegistryId)).toEqual(["1"]);
  });
});
