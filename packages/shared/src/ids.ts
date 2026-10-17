import { encodeAbiParameters, keccak256 } from "viem";
import type { Hex } from "./types";

/** policyId = keccak256(abi.encode(owner, accountRef, agentRegistry, agentRegistryId))  (§25.1). */
export function derivePolicyId(owner: Hex, accountRef: Hex, agentRegistry: Hex, agentRegistryId: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [owner, accountRef, agentRegistry, BigInt(agentRegistryId)],
    ),
  );
}

/** On-chain requestId = keccak256(requestId string)  (§7). */
export function requestIdToBytes32(requestId: string): Hex {
  return keccak256(new TextEncoder().encode(requestId));
}
