import { encodeAbiParameters, keccak256, toBytes } from "viem";
import type { Hex } from "./types.js";

/**
 * §5.2 / §25.1 canonical identity binding. PROVISIONAL copy: replace with the frozen
 * `packages/shared` export from Person 1/3; the formula must stay byte-identical.
 */
export type PolicyBinding = {
  policyId: Hex;
  owner: Hex;
  accountRef: Hex;
  agentRegistry: Hex;
  agentRegistryId: string;
  agentId: string;
};

/** policyId = keccak256(abi.encode(owner, accountRef, agentRegistry, agentRegistryId)) */
export function computePolicyId(b: Pick<PolicyBinding, "owner" | "accountRef" | "agentRegistry" | "agentRegistryId">): Hex {
  if (!/^\d+$/.test(b.agentRegistryId)) throw new Error("agentRegistryId must be a canonical unsigned decimal string");
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }],
    [b.owner, b.accountRef, b.agentRegistry, BigInt(b.agentRegistryId)],
  ));
}

/** accountRef = keccak256(okxAccountIdentifier); the raw account number is never stored. */
export function computeAccountRef(okxAccountIdentifier: string): Hex {
  return keccak256(toBytes(okxAccountIdentifier));
}

/**
 * agentId is display/app metadata derived from the registry identity (§25.1); it grants nothing.
 * Exact string format is not fixed in SONPLAN.md — PROVISIONAL until Person 3 freezes it.
 */
export function agentIdFor(chainId: number, agentRegistry: Hex, agentRegistryId: string): string {
  return `eip155:${chainId}:${agentRegistry.toLowerCase()}:${agentRegistryId}`;
}

/** Full binding check used by L3 stand-ins: every field must agree with the canonical derivation. */
export function bindingIsConsistent(b: PolicyBinding, chainId = 43113): boolean {
  return b.policyId === computePolicyId(b) && b.agentId === agentIdFor(chainId, b.agentRegistry, b.agentRegistryId);
}
