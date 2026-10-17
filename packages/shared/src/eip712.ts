import { keccak256, recoverTypedDataAddress, stringToBytes } from "viem";
import type { LocalAccount } from "viem";
import { EIP712_DOMAIN } from "./constants";
import { hashCanonical } from "./canonical";
import type {
  ExecutionAuthorization,
  Hex,
  SignedApproval,
  SignedIntentRequest,
  SignedPauseCommand,
} from "./types";

// EIP-712 typed data for every Bekçi signature. Frozen with Person 3; field order matters.
// Domain: { name: "Bekci", version: "1", chainId: 43113 } — no verifyingContract (§5.9).

export const BEKCI_TYPES = {
  AgentIntent: [
    { name: "requestId", type: "string" },
    { name: "policyId", type: "bytes32" },
    { name: "agentId", type: "string" },
    { name: "issuedAt", type: "uint64" },
    { name: "authNonce", type: "bytes16" },
    { name: "intentHash", type: "bytes32" },
    { name: "reasonHash", type: "bytes32" },
  ],
  ExecutionAuthorization: [
    { name: "requestId", type: "string" },
    { name: "policyId", type: "bytes32" },
    { name: "policyVersion", type: "uint64" },
    { name: "accountRef", type: "bytes32" },
    { name: "agentId", type: "string" },
    { name: "tool", type: "string" },
    { name: "normalizedOrderHash", type: "bytes32" },
    { name: "nonce", type: "bytes16" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "guardInstanceId", type: "string" },
    { name: "basis", type: "string" },
  ],
  ApprovalDecision: [
    { name: "requestId", type: "string" },
    { name: "policyId", type: "bytes32" },
    { name: "normalizedOrderHash", type: "bytes32" },
    { name: "decision", type: "string" },
    { name: "nonce", type: "bytes16" },
    { name: "expiresAt", type: "uint64" },
  ],
  PauseCommand: [
    { name: "policyId", type: "bytes32" },
    { name: "paused", type: "bool" },
    { name: "nonce", type: "bytes16" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

/** Kept for backward compatibility with Phase 1 callers. */
export const AGENT_INTENT_TYPES = { AgentIntent: BEKCI_TYPES.AgentIntent } as const;

type PrimaryType = keyof typeof BEKCI_TYPES;

async function sign(account: LocalAccount, primaryType: PrimaryType, message: Record<string, unknown>): Promise<Hex> {
  const params = {
    domain: EIP712_DOMAIN,
    types: { [primaryType]: BEKCI_TYPES[primaryType] },
    primaryType,
    message,
  };
  return account.signTypedData(params as unknown as Parameters<LocalAccount["signTypedData"]>[0]);
}

async function recover(primaryType: PrimaryType, message: Record<string, unknown>, signature: Hex): Promise<Hex | null> {
  try {
    const params = {
      domain: EIP712_DOMAIN,
      types: { [primaryType]: BEKCI_TYPES[primaryType] },
      primaryType,
      message,
      signature,
    };
    return await recoverTypedDataAddress(params as unknown as Parameters<typeof recoverTypedDataAddress>[0]);
  } catch {
    return null;
  }
}

// ---------- AgentIntent ----------
export function agentIntentMessage(r: Omit<SignedIntentRequest, "agentSignature">) {
  return {
    requestId: r.requestId,
    policyId: r.policyId,
    agentId: r.agentId,
    issuedAt: BigInt(r.issuedAt),
    authNonce: r.authNonce,
    intentHash: hashCanonical(r.intent),
    reasonHash: keccak256(stringToBytes(r.agentReason)),
  };
}

export function signAgentIntent(account: LocalAccount, r: Omit<SignedIntentRequest, "agentSignature">): Promise<Hex> {
  return sign(account, "AgentIntent", agentIntentMessage(r));
}

/** Returns the signer address, or null if the signature (or intent) is malformed. */
export async function recoverAgentIntentSigner(r: SignedIntentRequest): Promise<Hex | null> {
  let msg;
  try {
    msg = agentIntentMessage(r);
  } catch {
    return null;
  }
  return recover("AgentIntent", msg, r.agentSignature);
}

// ---------- ExecutionAuthorization ----------
export function executionAuthorizationMessage(a: Omit<ExecutionAuthorization, "signature">) {
  return {
    requestId: a.requestId,
    policyId: a.policyId,
    policyVersion: BigInt(a.policyVersion),
    accountRef: a.accountRef,
    agentId: a.agentId,
    tool: a.tool,
    normalizedOrderHash: a.normalizedOrderHash,
    nonce: a.nonce,
    issuedAt: BigInt(a.issuedAt),
    expiresAt: BigInt(a.expiresAt),
    guardInstanceId: a.guardInstanceId,
    basis: a.basis,
  };
}

export function signExecutionAuthorization(account: LocalAccount, a: Omit<ExecutionAuthorization, "signature">): Promise<Hex> {
  return sign(account, "ExecutionAuthorization", executionAuthorizationMessage(a));
}

export function recoverExecutionAuthorizationSigner(a: ExecutionAuthorization): Promise<Hex | null> {
  return recover("ExecutionAuthorization", executionAuthorizationMessage(a), a.signature);
}

// ---------- ApprovalDecision ----------
export function approvalMessage(a: Omit<SignedApproval, "ownerSignature">) {
  return {
    requestId: a.requestId,
    policyId: a.policyId,
    normalizedOrderHash: a.normalizedOrderHash,
    decision: a.decision,
    nonce: a.nonce,
    expiresAt: BigInt(a.expiresAt),
  };
}

export function signApproval(account: LocalAccount, a: Omit<SignedApproval, "ownerSignature">): Promise<Hex> {
  return sign(account, "ApprovalDecision", approvalMessage(a));
}

export function recoverApprovalSigner(a: SignedApproval): Promise<Hex | null> {
  return recover("ApprovalDecision", approvalMessage(a), a.ownerSignature);
}

// ---------- PauseCommand ----------
export function pauseMessage(p: Omit<SignedPauseCommand, "ownerSignature">) {
  return { policyId: p.policyId, paused: p.paused, nonce: p.nonce, issuedAt: BigInt(p.issuedAt) };
}

export function signPauseCommand(account: LocalAccount, p: Omit<SignedPauseCommand, "ownerSignature">): Promise<Hex> {
  return sign(account, "PauseCommand", pauseMessage(p));
}

export function recoverPauseSigner(p: SignedPauseCommand): Promise<Hex | null> {
  return recover("PauseCommand", pauseMessage(p), p.ownerSignature);
}
