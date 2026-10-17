// Publish Bekçi + the demo trading agent on the official ERC-8004 IdentityRegistry (Avalanche Fuji).
// Idempotent: skips identities already recorded in packages/chain/deployments/fuji.json.
// Run: npx tsx --env-file=.env scripts/fuji-publish-identities.ts
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { Erc8004Registry, bekciRegistration, parseAgentId, tradingAgentRegistration, withRegistration, type Registration } from "@bekci/identity";

const MANIFEST = new URL("../packages/chain/deployments/fuji.json", import.meta.url);
// Placeholder until Person 1's gateway is hosted; update later with updateRegistration (same agentId).
const GATEWAY_BASE_URL = process.env.BEKCI_PUBLIC_URL ?? "https://bekci.invalid";
const REPO = "https://github.com/ulukansarikaya/leashagent";

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const transport = http(process.env.CHAIN_RPC_URL);
const publicClient = createPublicClient({ chain: avalancheFuji, transport, pollingInterval: 1000 }) as PublicClient;
const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex);
const registry = new Erc8004Registry({
  publicClient, registry: manifest.erc8004.identityRegistry, chainId: 43113, chain: avalancheFuji, account,
  walletClient: createWalletClient({ account, chain: avalancheFuji, transport }),
});

async function publish(key: "bekci" | "tradingAgent", card: Registration) {
  if (manifest.identities[key]) {
    console.log(`${key}: already published as ${manifest.identities[key].agentId}`);
    return;
  }
  const agentId = key === "bekci" ? await registry.publishBekci(card) : await registry.publishAgent(card);
  const { agentRegistryId } = parseAgentId(agentId)!;
  // Spec back-reference: the card names its own on-chain registration.
  const tx = await registry.updateRegistration(agentRegistryId, withRegistration(card, Number(agentRegistryId), 43113, manifest.erc8004.identityRegistry));
  manifest.identities[key] = { agentId, agentRegistryId, owner: account.address, tx };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`${key}: published ${agentId}`);
}

await publish("bekci", bekciRegistration({ baseUrl: GATEWAY_BASE_URL }));
await publish("tradingAgent", tradingAgentRegistration({
  name: "Bekci Demo Trader",
  description: "Demo BTC-USDT spot agent. Holds no exchange keys; every order goes through Bekci's policy gateway.",
  homepage: REPO,
}));
for (const k of ["bekci", "tradingAgent"] as const) {
  const r = await registry.resolve(manifest.identities[k].agentRegistryId);
  console.log(`resolve ${k}:`, r.agentId, `"${r.registration.name}"`, r.registration.bekci?.kind);
}
