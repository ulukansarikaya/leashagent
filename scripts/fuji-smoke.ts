// End-to-end smoke test against the deployed Fuji contracts. Run: npx tsx --env-file=.env scripts/fuji-smoke.ts
// Creates (or reuses) a demo policy owned by the deployer, verifies it through the chain client,
// then writes a decision + execution through the durable outbox with the LOGGER key.
import { DatabaseSync } from "node:sqlite";
import { createPublicClient, createWalletClient, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { computeAccountRef, computePolicyId, formatAgentId, hashCanonical, type Policy } from "@leashagent/shared";
import {
  ChainOutbox, createDecisionLogPort, createPolicyChainClient, policyRegistryAbi, verifyPolicyDocument, delegationActive,
} from "@leashagent/chain";
import { FUJI_IDENTITY_REGISTRY } from "@leashagent/identity";

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`missing ${k}`); return v; };
const transport = http(env("CHAIN_RPC_URL"));
const pub = createPublicClient({ chain: avalancheFuji, transport, pollingInterval: 1000 }) as PublicClient;
const owner = privateKeyToAccount(env("DEPLOYER_PRIVATE_KEY") as Hex);
const logger = privateKeyToAccount(env("LOGGER_PRIVATE_KEY") as Hex);
const registry = env("POLICY_REGISTRY_ADDRESS") as Hex;
const decisionLog = env("DECISION_LOG_ADDRESS") as Hex;

// Demo binding: agent identity on the real ERC-8004 registry (id is a placeholder until we publish).
const accountRef = computeAccountRef("okx-demo-account-leash");
const agentRegistryId = "0";
const agentAuth = privateKeyToAccount(generatePrivateKey()).address; // throwaway demo agent key
const policyId = computePolicyId(owner.address, accountRef, FUJI_IDENTITY_REGISTRY, agentRegistryId);
const expires = Math.floor(Date.now() / 1000) + 30 * 86400;

const client = createPolicyChainClient(pub, registry);
let record = await client.getPolicy(policyId).catch(() => undefined);
let policy: Policy;
if (record) {
  console.log("policy exists, version", record.version, "— reusing");
  policy = buildPolicy(record.agentAuthAddress, record.delegationExpiresAt);
} else {
  policy = buildPolicy(agentAuth, expires);
  const w = createWalletClient({ account: owner, chain: avalancheFuji, transport });
  const hash = await w.writeContract({
    address: registry, abi: policyRegistryAbi, functionName: "createPolicy",
    args: [accountRef, FUJI_IDENTITY_REGISTRY, BigInt(agentRegistryId), agentAuth, BigInt(expires), hashCanonical(policy), "data:demo"],
  });
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log("createPolicy tx", hash, r.status);
  record = await client.getPolicy(policyId);
}

const v = verifyPolicyDocument(policyId, policy, record);
console.log("policyId", policyId);
console.log("verifyPolicyDocument:", v.ok ? "OK" : v.reason, "| delegation active:", delegationActive(record, Math.floor(Date.now() / 1000)));
console.log("tampered doc:", verifyPolicyDocument(policyId, { ...policy, limits: { ...policy.limits, maxOrderNotionalUsdt: "999999" } }, record));

const outbox = new ChainOutbox(new DatabaseSync(":memory:"), createDecisionLogPort({
  publicClient: pub, walletClient: createWalletClient({ account: logger, chain: avalancheFuji, transport }),
  account: logger, chain: avalancheFuji, address: decisionLog,
}), { onEvent: (e) => console.log("outbox:", e.type, "txHash" in e ? e.txHash : (e as { error?: string }).error ?? "") });

const requestId = crypto.randomUUID();
const H = (s: string) => hashCanonical({ s, requestId });
await outbox.enqueue({ kind: "decision", requestId, policyId, verdict: "ALLOW", policyHash: record.policyHash, policyVersion: record.version,
  normalizedOrderHash: H("order"), evidenceHash: H("evidence"), reasonCode: 0, authHash: H("auth") });
await outbox.enqueue({ kind: "execution", requestId, eventSeq: 1, status: "submitted", okxResultHash: H("okx1") });
await outbox.enqueue({ kind: "execution", requestId, eventSeq: 2, status: "filled", okxResultHash: H("okx2") });
console.log("drained:", await outbox.drain(), outbox.stats());

function buildPolicy(agentAuthAddress: Hex, delegationValidUntil: number): Policy {
  return {
    policyVersion: 1,
    binding: { policyId, owner: owner.address, accountRef, agentRegistry: FUJI_IDENTITY_REGISTRY, agentRegistryId,
      agentId: formatAgentId(43113, FUJI_IDENTITY_REGISTRY, agentRegistryId) },
    agentAuthAddress, delegationValidUntil,
    mandate: "Demo: trade BTC-USDT spot conservatively", allowedInstruments: ["BTC-USDT"],
    allowedTools: ["spot_place_order", "spot_cancel_order"], forbiddenTools: ["transfer", "withdraw"],
    limits: { maxOrderNotionalUsdt: "100", maxOpenNotionalUsdt: "500", maxOrdersPerMinute: 5, maxDailyLossUsdt: "50",
      maxPriceDeviationBps: 100, marketSlippageBufferBps: 50, escalateAboveUsdt: "80" },
    freshness: { maxRiskDataAgeSec: 10, maxMarketDataAgeSec: 5 },
    auditor: { mode: "enabled", maxInjectionSuspicion: "0.5", minConsistency: "0.6", minVerdictConfidence: "0.5", onUnavailable: "pending" },
    pendingTtlSec: 600, authorizationTtlSec: 30,
  };
}
