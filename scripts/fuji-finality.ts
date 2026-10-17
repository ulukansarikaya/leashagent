// Measure Avalanche Fuji confirmation latency for Bekçi's on-chain actions (SONPLAN §18):
// owner pause/unpause (PolicyRegistry.setPaused) and evidence writes (DecisionLog.logDecision).
// Latency = wall time from broadcast to receipt (Avalanche finality is single-confirmation).
// Run: npx tsx --env-file=.env scripts/fuji-finality.ts [samples=5]
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, keccak256, toHex, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { decisionLogAbi, policyRegistryAbi } from "@bekci/chain";

const MANIFEST = new URL("../packages/chain/deployments/fuji.json", import.meta.url);
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const N = Number(process.argv[2] ?? 5);
const transport = http(process.env.CHAIN_RPC_URL);
const pub = createPublicClient({ chain: avalancheFuji, transport, pollingInterval: 100 }) as PublicClient;
const owner = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex);
const logger = privateKeyToAccount(process.env.LOGGER_PRIVATE_KEY as Hex);
const ownerW = createWalletClient({ account: owner, chain: avalancheFuji, transport });
const loggerW = createWalletClient({ account: logger, chain: avalancheFuji, transport });
const policyId = manifest.demoPolicy.policyId as Hex;

async function timed(send: () => Promise<Hex>): Promise<number> {
  const t0 = performance.now();
  const hash = await send();
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100 });
  if (r.status !== "success") throw new Error("tx reverted");
  return performance.now() - t0;
}
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { samples: s.length, medianMs: Math.round(s[Math.floor(s.length / 2)]!), minMs: Math.round(s[0]!), maxMs: Math.round(s.at(-1)!) };
};

const pause: number[] = [];
for (let i = 0; i < N; i++) {
  for (const p of [true, false]) {
    pause.push(await timed(() => ownerW.writeContract({ address: manifest.contracts.PolicyRegistry.address, abi: policyRegistryAbi, functionName: "setPaused", args: [policyId, p] })));
  }
}
const log: number[] = [];
for (let i = 0; i < N; i++) {
  const rid = keccak256(toHex(`finality-probe-${Date.now()}-${i}`));
  const z = `0x${"00".repeat(32)}` as Hex;
  log.push(await timed(() => loggerW.writeContract({ address: manifest.contracts.DecisionLog.address, abi: decisionLogAbi, functionName: "logDecision", args: [policyId, rid, 1, z, 0n, z, z, 0, z] })));
}
const paused = (await pub.readContract({ address: manifest.contracts.PolicyRegistry.address, abi: policyRegistryAbi, functionName: "getPolicy", args: [policyId] })).paused;
const result = { measuredAt: new Date().toISOString(), rpc: "public Fuji RPC", setPaused: stats(pause), logDecision: stats(log), demoPolicyPausedAfter: paused };
manifest.finality = result;
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
