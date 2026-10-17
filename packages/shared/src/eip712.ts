import { recoverTypedDataAddress, type Account } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashCanonical, hashText } from "./canonical.js";
import type { Hex, SignedIntentRequest } from "./types.js";

/** §5.9 domain (no verifyingContract; verified off-chain). */
export const EIP712_DOMAIN = { name: "Bekci", version: "1", chainId: 43113 } as const;

/** §5.4 AgentIntent type. */
export const AGENT_INTENT_TYPES = {
  AgentIntent: [
    { name: "requestId", type: "string" },
    { name: "policyId", type: "bytes32" },
    { name: "agentId", type: "string" },
    { name: "issuedAt", type: "uint64" },
    { name: "authNonce", type: "bytes16" },
    { name: "intentHash", type: "bytes32" },
    { name: "reasonHash", type: "bytes32" },
  ],
} as const;

export type UnsignedIntentRequest = Omit<SignedIntentRequest, "agentSignature">;

export function agentIntentMessage(r: UnsignedIntentRequest) {
  return {
    requestId: r.requestId,
    policyId: r.policyId,
    agentId: r.agentId,
    issuedAt: BigInt(r.issuedAt),
    authNonce: r.authNonce,
    intentHash: hashCanonical(r.intent),
    reasonHash: hashText(r.agentReason),
  };
}

export async function signAgentIntent(account: Account, r: UnsignedIntentRequest): Promise<Hex> {
  if (!account.signTypedData) throw new Error("account cannot sign typed data");
  return account.signTypedData({
    domain: EIP712_DOMAIN,
    types: AGENT_INTENT_TYPES,
    primaryType: "AgentIntent",
    message: agentIntentMessage(r),
  });
}

export async function recoverAgentIntentSigner(r: SignedIntentRequest): Promise<Hex> {
  return recoverTypedDataAddress({
    domain: EIP712_DOMAIN,
    types: AGENT_INTENT_TYPES,
    primaryType: "AgentIntent",
    message: agentIntentMessage(r),
    signature: r.agentSignature,
  });
}

export { privateKeyToAccount };

// ---- Proposed for freeze (not spelled out field-by-field in SONPLAN.md) ----

/** ReadRequest signature (§5.3 has `agentSignature` but no type); queryHash = keccak256(query). */
export const AGENT_READ_TYPES = {
  AgentRead: [
    { name: "requestId", type: "string" },
    { name: "policyId", type: "bytes32" },
    { name: "source", type: "string" },
    { name: "queryHash", type: "bytes32" },
  ],
} as const;

/** §5.10 SignedApproval → EIP-712 ApprovalDecision. */
export const APPROVAL_TYPES = {
  ApprovalDecision: [
    { name: "requestId", type: "string" },
    { name: "policyId", type: "bytes32" },
    { name: "normalizedOrderHash", type: "bytes32" },
    { name: "decision", type: "string" },
    { name: "nonce", type: "bytes16" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

/** §5.10 SignedPauseCommand → EIP-712 PauseCommand. */
export const PAUSE_TYPES = {
  PauseCommand: [
    { name: "policyId", type: "bytes32" },
    { name: "paused", type: "bool" },
    { name: "nonce", type: "bytes16" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

export function agentReadMessage(r: { requestId: string; policyId: Hex; source: string; query: string }) {
  return { requestId: r.requestId, policyId: r.policyId, source: r.source, queryHash: hashText(r.query) };
}

export async function signAgentRead(account: Account, r: { requestId: string; policyId: Hex; source: string; query: string }): Promise<Hex> {
  if (!account.signTypedData) throw new Error("account cannot sign typed data");
  return account.signTypedData({ domain: EIP712_DOMAIN, types: AGENT_READ_TYPES, primaryType: "AgentRead", message: agentReadMessage(r) });
}

export async function recoverAgentReadSigner(r: { requestId: string; policyId: Hex; source: string; query: string; agentSignature: Hex }): Promise<Hex> {
  return recoverTypedDataAddress({ domain: EIP712_DOMAIN, types: AGENT_READ_TYPES, primaryType: "AgentRead", message: agentReadMessage(r), signature: r.agentSignature });
}
