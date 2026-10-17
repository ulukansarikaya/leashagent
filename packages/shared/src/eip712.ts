import { getAddress, hashTypedData, recoverTypedDataAddress } from "viem";
import type { LocalAccount } from "viem/accounts";
import { computeIntentHash, computeReasonHash } from "./ids.js";
import type {
  ExecutionAuthorization,
  Hex,
  SignedApproval,
  SignedIntentRequest,
  SignedPauseCommand,
} from "./types.js";

/** §5.9 — off-chain verification only, no verifyingContract. */
export const BEKCI_DOMAIN = { name: "Bekci", version: "1", chainId: 43113 } as const;

export const EIP712_TYPES = {
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

type Unsigned<T, K extends keyof T> = Omit<T, K>;

// ---------- message builders ----------

export function agentIntentMessage(req: Unsigned<SignedIntentRequest, "agentSignature">) {
  return {
    requestId: req.requestId,
    policyId: req.policyId,
    agentId: req.agentId,
    issuedAt: BigInt(req.issuedAt),
    authNonce: req.authNonce,
    intentHash: computeIntentHash(req.intent),
    reasonHash: computeReasonHash(req.agentReason),
  };
}

export function authorizationMessage(a: Unsigned<ExecutionAuthorization, "signature">) {
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

export function approvalMessage(a: Unsigned<SignedApproval, "ownerSignature">) {
  return {
    requestId: a.requestId,
    policyId: a.policyId,
    normalizedOrderHash: a.normalizedOrderHash,
    decision: a.decision,
    nonce: a.nonce,
    expiresAt: BigInt(a.expiresAt),
  };
}

export function pauseMessage(p: Unsigned<SignedPauseCommand, "ownerSignature">) {
  return { policyId: p.policyId, paused: p.paused, nonce: p.nonce, issuedAt: BigInt(p.issuedAt) };
}

// ---------- signing ----------

export async function signAgentIntent(
  account: LocalAccount,
  req: Unsigned<SignedIntentRequest, "agentSignature">,
): Promise<SignedIntentRequest> {
  const agentSignature = await account.signTypedData({
    domain: BEKCI_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "AgentIntent",
    message: agentIntentMessage(req),
  });
  return { ...req, agentSignature };
}

export async function signAuthorization(
  account: LocalAccount,
  a: Unsigned<ExecutionAuthorization, "signature">,
): Promise<ExecutionAuthorization> {
  const signature = await account.signTypedData({
    domain: BEKCI_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "ExecutionAuthorization",
    message: authorizationMessage(a),
  });
  return { ...a, signature };
}

export async function signApproval(
  account: LocalAccount,
  a: Unsigned<SignedApproval, "ownerSignature">,
): Promise<SignedApproval> {
  const ownerSignature = await account.signTypedData({
    domain: BEKCI_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "ApprovalDecision",
    message: approvalMessage(a),
  });
  return { ...a, ownerSignature };
}

export async function signPauseCommand(
  account: LocalAccount,
  p: Unsigned<SignedPauseCommand, "ownerSignature">,
): Promise<SignedPauseCommand> {
  const ownerSignature = await account.signTypedData({
    domain: BEKCI_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "PauseCommand",
    message: pauseMessage(p),
  });
  return { ...p, ownerSignature };
}

// ---------- recovery / verification ----------
// Recover functions throw on malformed signatures; verify* functions return false instead.

export function recoverAgentIntentSigner(req: SignedIntentRequest): Promise<Hex> {
  return recoverTypedDataAddress({
    domain: BEKCI_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "AgentIntent",
    message: agentIntentMessage(req),
    signature: req.agentSignature,
  });
}

export function recoverAuthorizationSigner(a: ExecutionAuthorization): Promise<Hex> {
  return recoverTypedDataAddress({
    domain: BEKCI_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "ExecutionAuthorization",
    message: authorizationMessage(a),
    signature: a.signature,
  });
}

export function recoverApprovalSigner(a: SignedApproval): Promise<Hex> {
  return recoverTypedDataAddress({
    domain: BEKCI_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "ApprovalDecision",
    message: approvalMessage(a),
    signature: a.ownerSignature,
  });
}

export function recoverPauseSigner(p: SignedPauseCommand): Promise<Hex> {
  return recoverTypedDataAddress({
    domain: BEKCI_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "PauseCommand",
    message: pauseMessage(p),
    signature: p.ownerSignature,
  });
}

async function matches(recover: () => Promise<Hex>, expected: Hex): Promise<boolean> {
  try {
    return getAddress(await recover()) === getAddress(expected);
  } catch {
    return false;
  }
}

export const verifyAgentIntent = (req: SignedIntentRequest, expected: Hex) =>
  matches(() => recoverAgentIntentSigner(req), expected);
export const verifyAuthorization = (a: ExecutionAuthorization, expected: Hex) =>
  matches(() => recoverAuthorizationSigner(a), expected);
export const verifyApproval = (a: SignedApproval, expected: Hex) =>
  matches(() => recoverApprovalSigner(a), expected);
export const verifyPauseCommand = (p: SignedPauseCommand, expected: Hex) =>
  matches(() => recoverPauseSigner(p), expected);

/** authHash for ChainRecord: EIP-712 digest of the authorization (zero hash when none was issued). */
export function computeAuthHash(a: Unsigned<ExecutionAuthorization, "signature"> | undefined): Hex {
  if (!a) return `0x${"0".repeat(64)}`;
  return hashTypedData({
    domain: BEKCI_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "ExecutionAuthorization",
    message: authorizationMessage(a),
  });
}
