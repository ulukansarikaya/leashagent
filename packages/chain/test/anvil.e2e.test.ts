import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, defineChain, http, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  computeAccountRef,
  computePolicyId,
  hashCanonical,
  type ChainRecord,
  type Hex,
  type Policy,
} from "@leashagent/shared";
import {
  ChainOutbox,
  createChainPolicyStateProvider,
  createDecisionLogPort,
  createPolicyChainClient,
  decisionLogAbi,
  decisionLogBytecode,
  policyRegistryAbi,
  policyRegistryBytecode,
  verifyPolicyDocument,
} from "../src/index.js";

const ANVIL = process.env.ANVIL_BIN ?? `${homedir()}/.foundry/bin/anvil`;
const PORT = 18545 + Math.floor(Math.random() * 1000);
const chain = defineChain({
  id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [`http://127.0.0.1:${PORT}`] } },
});

// Anvil's well-known dev keys (public test keys, no value).
const owner = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const logger = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const attacker = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const agentAuth = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");

let anvil: ChildProcess | undefined;
let pub: PublicClient;
let registry: Address;
let dlog: Address;

const run = existsSync(ANVIL) ? describe : describe.skip;

async function deploy(abi: readonly unknown[], bytecode: Hex, args: unknown[] = []): Promise<Address> {
  const w = createWalletClient({ account: owner, chain, transport: http() });
  const hash = await w.deployContract({ abi, bytecode, args } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  return r.contractAddress!;
}

run("chain e2e (anvil)", () => {
  beforeAll(async () => {
    anvil = spawn(ANVIL, ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    pub = createPublicClient({ chain, transport: http(), pollingInterval: 100 }) as PublicClient;
    for (let i = 0; i < 50; i++) {
      try { await pub.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    registry = await deploy(policyRegistryAbi, policyRegistryBytecode);
    dlog = await deploy(decisionLogAbi, decisionLogBytecode, [owner.address]);
    const w = createWalletClient({ account: owner, chain, transport: http() });
    await pub.waitForTransactionReceipt({
      hash: await w.writeContract({ address: dlog, abi: decisionLogAbi, functionName: "setLogger", args: [logger.address, true] }),
    });
  }, 30_000);

  afterAll(() => { anvil?.kill(); });

  it("policy round trip: create → read → verify document → pause watch → L6 state", async () => {
    const accountRef = computeAccountRef("okx-demo-account-1");
    const agentRegistry = "0x8004000000000000000000000000000000000001" as Hex;
    const policyId = computePolicyId(owner.address, accountRef, agentRegistry, "42");
    const expiresAt = Math.floor(Date.now() / 1000) + 86400;
    const policy: Policy = {
      policyVersion: 1,
      binding: { policyId, owner: owner.address, accountRef, agentRegistry, agentRegistryId: "42", agentId: "leash-demo-agent" },
      agentAuthAddress: agentAuth.address, delegationValidUntil: expiresAt,
      mandate: "Trade BTC-USDT spot conservatively", allowedInstruments: ["BTC-USDT"],
      allowedTools: ["spot_place_order", "spot_cancel_order"], forbiddenTools: ["transfer", "withdraw"],
      limits: { maxOrderNotionalUsdt: "100", maxOpenNotionalUsdt: "500", maxOrdersPerMinute: 5, maxDailyLossUsdt: "50",
        maxPriceDeviationBps: 100, marketSlippageBufferBps: 50, escalateAboveUsdt: "80" },
      freshness: { maxRiskDataAgeSec: 10, maxMarketDataAgeSec: 5 },
      auditor: { mode: "enabled", maxInjectionSuspicion: "0.5", minConsistency: "0.6", minVerdictConfidence: "0.5", onUnavailable: "pending" },
      pendingTtlSec: 600, authorizationTtlSec: 30,
    };

    const w = createWalletClient({ account: owner, chain, transport: http() });
    await pub.waitForTransactionReceipt({ hash: await w.writeContract({
      address: registry, abi: policyRegistryAbi, functionName: "createPolicy",
      args: [accountRef, agentRegistry, 42n, agentAuth.address, BigInt(expiresAt), hashCanonical(policy), "ipfs://policy-v1"],
    }) });

    const client = createPolicyChainClient(pub, registry);
    const rec = await client.getPolicy(policyId);
    expect(rec.version).toBe(1);
    expect(rec.agentRegistryId).toBe("42");

    expect(verifyPolicyDocument(policyId, policy, rec).ok).toBe(true);
    expect(verifyPolicyDocument(policyId, { ...policy, limits: { ...policy.limits, maxOrderNotionalUsdt: "1000000" } }, rec))
      .toMatchObject({ ok: false, reason: "hash_mismatch" });

    const seen: boolean[] = [];
    const unwatch = client.watchPause(policyId, (p) => seen.push(p));
    await pub.waitForTransactionReceipt({ hash: await w.writeContract({
      address: registry, abi: policyRegistryAbi, functionName: "setPaused", args: [policyId, true],
    }) });
    for (let i = 0; i < 40 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    unwatch();
    expect(seen).toEqual([true]);

    const state = await createChainPolicyStateProvider(client).getExecutionState(policyId);
    expect(state).toMatchObject({ policyVersion: 1, paused: true, revoked: false, agentAuthAddress: agentAuth.address });

    // attacker cannot pause/unpause someone else's policy
    const aw = createWalletClient({ account: attacker, chain, transport: http() });
    await expect(aw.writeContract({ address: registry, abi: policyRegistryAbi, functionName: "setPaused", args: [policyId, false] }))
      .rejects.toThrow();
  });

  it("outbox writes decision + executions to DecisionLog and is idempotent", async () => {
    const port = createDecisionLogPort({
      publicClient: pub, walletClient: createWalletClient({ account: logger, chain, transport: http() }),
      account: logger, chain, address: dlog,
    });
    const db = new DatabaseSync(":memory:");
    const outbox = new ChainOutbox(db, port);
    const rid = "0b0e7a4c-1f2e-4c7d-9a3b-5e6f7a8b9c0d";
    const H = (s: string) => hashCanonical({ s });
    const dec: ChainRecord = { kind: "decision", requestId: rid, policyId: H("p"), verdict: "ALLOW", policyHash: H("ph"),
      policyVersion: 1, normalizedOrderHash: H("o"), evidenceHash: H("e"), reasonCode: 0, authHash: H("a") };

    await outbox.enqueue(dec);
    await outbox.enqueue({ kind: "execution", requestId: rid, eventSeq: 1, status: "submitted", okxResultHash: H("r1") });
    await outbox.enqueue({ kind: "execution", requestId: rid, eventSeq: 2, status: "filled", okxResultHash: H("r2") });
    await outbox.enqueue(dec); // duplicate (e.g. retry after crash) → recognised as already applied
    await outbox.enqueue({ kind: "execution", requestId: rid, eventSeq: 3, status: "cancelled", okxResultHash: H("r3") }); // filled is terminal

    expect(await outbox.drain()).toBe(5);
    expect(outbox.stats()).toMatchObject({ confirmed: 4, dead: 1 });
    const dead = db.prepare("SELECT last_error FROM chain_outbox WHERE state='dead'").get() as { last_error: string };
    expect(dead.last_error).toContain("InvalidExecTransition");

    const logs = await pub.getContractEvents({ address: dlog, abi: decisionLogAbi, fromBlock: 0n });
    expect(logs.filter((l) => l.eventName === "DecisionLogged")).toHaveLength(1);
    expect(logs.filter((l) => l.eventName === "ExecutionLogged")).toHaveLength(2);
  }, 30_000);

  it("unauthorized logger is rejected as a permanent revert", async () => {
    const port = createDecisionLogPort({
      publicClient: pub, walletClient: createWalletClient({ account: attacker, chain, transport: http() }),
      account: attacker, chain, address: dlog,
    });
    const outbox = new ChainOutbox(new DatabaseSync(":memory:"), port);
    const H = (s: string) => hashCanonical({ s });
    await outbox.enqueue({ kind: "decision", requestId: "1b0e7a4c-1f2e-4c7d-9a3b-5e6f7a8b9c0d", policyId: H("p"), verdict: "ALLOW",
      policyHash: H("ph"), policyVersion: 1, normalizedOrderHash: H("o"), evidenceHash: H("e"), reasonCode: 0, authHash: H("a") });
    await outbox.drain();
    expect(outbox.stats().dead).toBe(1);
  });
});
