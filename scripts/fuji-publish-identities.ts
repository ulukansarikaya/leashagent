// Sync Leash Agent + the demo trading agent with the official ERC-8004 IdentityRegistry (Avalanche Fuji).
// Publishes an identity if missing; if it exists but its on-chain card differs from the current card
// (rename, gateway URL now known, …) it updates the card in place — the agentId never changes.
// Run: npx tsx --env-file=.env scripts/fuji-publish-identities.ts   (LEASH_PUBLIC_URL=https://… once the gateway is hosted)
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import {
  Erc8004Registry, identityRegistryAbi, leashRegistration, loadRegistration, parseAgentId, toDataUri,
  tradingAgentRegistration, withRegistration, type Registration,
} from "@leashagent/identity";

const MANIFEST = new URL("../packages/chain/deployments/fuji.json", import.meta.url);
// Placeholder until Person 1's gateway is hosted.
const GATEWAY_BASE_URL = process.env.LEASH_PUBLIC_URL ?? "https://leashagent.invalid";
const REPO = "https://github.com/ulukansarikaya/leashagent";

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const identityRegistry = manifest.erc8004.identityRegistry as Hex;
const transport = http(process.env.CHAIN_RPC_URL);
const publicClient = createPublicClient({ chain: avalancheFuji, transport, pollingInterval: 1000 }) as PublicClient;
const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex);
const registry = new Erc8004Registry({
  publicClient, registry: identityRegistry, chainId: 43113, chain: avalancheFuji, account,
  walletClient: createWalletClient({ account, chain: avalancheFuji, transport }),
});

async function sync(key: "leash" | "tradingAgent", card: Registration) {
  const known = manifest.identities[key];
  if (!known) {
    const agentId = key === "leash" ? await registry.publishLeash(card) : await registry.publishAgent(card);
    const { agentRegistryId } = parseAgentId(agentId)!;
    const tx = await registry.updateRegistration(agentRegistryId, withRegistration(card, Number(agentRegistryId), 43113, identityRegistry));
    manifest.identities[key] = { agentId, agentRegistryId, owner: account.address, tx };
    console.log(`${key}: published ${agentId}`);
    return;
  }
  const desired = withRegistration(card, Number(known.agentRegistryId), 43113, identityRegistry);
  const uri = await publicClient.readContract({ address: identityRegistry, abi: identityRegistryAbi, functionName: "tokenURI", args: [BigInt(known.agentRegistryId)] });
  if (uri === toDataUri(desired)) {
    console.log(`${key}: ${known.agentId} up to date`);
    return;
  }
  known.tx = await registry.updateRegistration(known.agentRegistryId, desired);
  console.log(`${key}: ${known.agentId} card updated`);
}

await sync("leash", leashRegistration({ baseUrl: GATEWAY_BASE_URL }));
await sync("tradingAgent", tradingAgentRegistration({
  name: "Leash Agent Demo Trader",
  description: "Demo BTC-USDT spot agent. Holds no exchange keys; every order goes through Leash Agent's policy gateway.",
  homepage: REPO,
}));
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

for (const k of ["leash", "tradingAgent"] as const) {
  const r = await registry.resolve(manifest.identities[k].agentRegistryId);
  console.log(`resolve ${k}:`, r.agentId, `"${r.registration.name}"`, r.registration.leash?.kind);
}
const found = await registry.discover("agent-security-gateway", { fromBlock: BigInt(manifest.contracts.PolicyRegistry.deployBlock) });
console.log("discover(agent-security-gateway):", found.map((f) => `${f.agentId} "${f.registration.name}"`));
