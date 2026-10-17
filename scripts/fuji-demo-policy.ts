// Create — or bring up to date — the on-chain demo policy on Avalanche Fuji, bound to the published ERC-8004 trading
// agent. Idempotent. To delegate to another agent key (e.g. Person 2's), set AGENT_AUTH_ADDRESS and re-run: the owner
// calls setDelegation then setPolicy (new version) so document and chain stay consistent (INV-11).
// Run: npx tsx --env-file=.env scripts/fuji-demo-policy.ts
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, getAddress, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { canonicalJson, computeAccountRef, computePolicyId, formatAgentId, hashCanonical, type Policy } from "@leashagent/shared";
import { createPolicyChainClient, loadVerifiedPolicy, policyRegistryAbi } from "@leashagent/chain";

import { pathToFileURL } from "node:url";
import { manifestPath } from "./lib/deployment";
const MANIFEST = pathToFileURL(manifestPath()); // LEASH_DEPLOYMENT or the team manifest
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`missing ${k}`); return v; };

const transport = http(process.env.CHAIN_RPC_URL);
const pub = createPublicClient({ chain: avalancheFuji, transport, pollingInterval: 1000 }) as PublicClient;
const owner = privateKeyToAccount(env("DEPLOYER_PRIVATE_KEY") as Hex);
const wallet = createWalletClient({ account: owner, chain: avalancheFuji, transport });
const registry = manifest.contracts.PolicyRegistry.address as Hex;
const client = createPolicyChainClient(pub, registry);

const agent = manifest.identities.tradingAgent;
if (!agent) throw new Error("publish identities first (scripts/fuji-publish-identities.ts)");
const agentRegistry = manifest.erc8004.identityRegistry as Hex;
const accountRef = computeAccountRef(process.env.OKX_ACCOUNT_IDENTIFIER ?? "okx-demo-account");
const agentAuthAddress = getAddress(env("AGENT_AUTH_ADDRESS"));
const policyId = computePolicyId(owner.address, accountRef, agentRegistry, agent.agentRegistryId);
const DAYS = 30;

function build(version: number, delegationValidUntil: number): Policy {
  return {
    policyVersion: version,
    binding: { policyId, owner: owner.address, accountRef, agentRegistry, agentRegistryId: agent.agentRegistryId,
      agentId: formatAgentId(43113, agentRegistry, agent.agentRegistryId) },
    agentAuthAddress, delegationValidUntil,
    mandate: "Trade BTC-USDT spot trend-following with small limit orders. Never chase news hype.",
    allowedInstruments: ["BTC-USDT"],
    allowedTools: ["spot_place_order", "spot_cancel_order"],
    forbiddenTools: ["transfer", "withdraw"],
    // Overridable for small live runs, e.g. LEASH_POLICY_MAX_ORDER_USDT=10 LEASH_POLICY_ESCALATE_USDT=5
    limits: {
      maxOrderNotionalUsdt: process.env.LEASH_POLICY_MAX_ORDER_USDT ?? "100",
      maxOpenNotionalUsdt: process.env.LEASH_POLICY_MAX_OPEN_USDT ?? "300",
      maxOrdersPerMinute: Number(process.env.LEASH_POLICY_MAX_ORDERS_PER_MIN ?? 5),
      maxDailyLossUsdt: process.env.LEASH_POLICY_MAX_DAILY_LOSS_USDT ?? "50",
      maxPriceDeviationBps: 50,
      marketSlippageBufferBps: 50,
      escalateAboveUsdt: process.env.LEASH_POLICY_ESCALATE_USDT ?? "50",
    },
    freshness: { maxRiskDataAgeSec: 15, maxMarketDataAgeSec: 10 },
    auditor: { mode: "enabled", maxInjectionSuspicion: "0.5", minConsistency: "0.5", minVerdictConfidence: "0.5", onUnavailable: "pending" },
    pendingTtlSec: 600,
    authorizationTtlSec: 30,
  };
}
const dataUri = (p: Policy) => `data:application/json;base64,${Buffer.from(canonicalJson(p)).toString("base64")}`;
async function tx(functionName: string, args: unknown[]) {
  const hash = await wallet.writeContract({ address: registry, abi: policyRegistryAbi, functionName, args } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  console.log(`${functionName}: ${hash}`);
}

const existing = await client.getPolicy(policyId).catch(() => undefined);
let policy: Policy;
if (!existing) {
  const until = Math.floor(Date.now() / 1000) + DAYS * 86400;
  policy = build(1, until);
  await tx("createPolicy", [accountRef, agentRegistry, BigInt(agent.agentRegistryId), agentAuthAddress, BigInt(until), hashCanonical(policy), dataUri(policy)]);
} else if (getAddress(existing.agentAuthAddress) !== agentAuthAddress || existing.revoked) {
  const until = Math.floor(Date.now() / 1000) + DAYS * 86400;
  await tx("setDelegation", [policyId, agentAuthAddress, BigInt(until), false]);
  policy = build(existing.version + 1, until);
  await tx("setPolicy", [policyId, hashCanonical(policy), dataUri(policy), BigInt(existing.version)]);
} else {
  policy = build(existing.version, existing.delegationExpiresAt);
  if (hashCanonical(policy) !== existing.policyHash.toLowerCase()) {
    policy = build(existing.version + 1, existing.delegationExpiresAt);
    await tx("setPolicy", [policyId, hashCanonical(policy), dataUri(policy), BigInt(existing.version)]);
  } else {
    console.log("policy already up to date");
  }
}

const loaded = await loadVerifiedPolicy(client, policyId);
if (!loaded.ok) throw new Error(`verification failed: ${loaded.reason}`);
writeFileSync(new URL(`../packages/chain/deployments/policies/${policyId}.json`, import.meta.url), JSON.stringify(policy, null, 2) + "\n");
manifest.demoPolicy = { policyId, owner: owner.address, agentAuthAddress, policyURI: "data:… (see policies/<policyId>.json)",
  policyHash: loaded.record.policyHash, version: loaded.record.version };
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
console.log("verified on chain ✓", { policyId, version: loaded.record.version, agentId: loaded.policy.binding.agentId, agentAuthAddress });
