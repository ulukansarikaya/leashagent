import { getAddress } from "viem";
import type { Hex, PolicyBinding } from "./types.js";

/**
 * Canonical agentId string: "eip155:<chainId>:<registryAddress>:<registryAgentId>" (CAIP-10 style + token id).
 * §25.1: agentId is display/app metadata and must resolve to the policy's (agentRegistry, agentRegistryId).
 */
const AGENT_ID_RE = /^eip155:(\d+):(0x[0-9a-fA-F]{40}):(0|[1-9]\d*)$/;

export type ParsedAgentId = { chainId: number; agentRegistry: Hex; agentRegistryId: string };

export function formatAgentId(chainId: number, agentRegistry: Hex, agentRegistryId: string | bigint): string {
  const id = agentRegistryId.toString();
  if (!/^(0|[1-9]\d*)$/.test(id)) throw new Error("agentRegistryId must be a canonical unsigned decimal");
  return `eip155:${chainId}:${getAddress(agentRegistry)}:${id}`;
}

export function parseAgentId(agentId: string): ParsedAgentId | undefined {
  const m = AGENT_ID_RE.exec(agentId);
  if (!m) return undefined;
  return { chainId: Number(m[1]), agentRegistry: getAddress(m[2]!), agentRegistryId: m[3]! };
}

/** L3 helper: true only if agentId is canonical and resolves to exactly the binding's registry identity. */
export function agentIdMatchesBinding(agentId: string, binding: Pick<PolicyBinding, "agentRegistry" | "agentRegistryId">, chainId: number): boolean {
  const p = parseAgentId(agentId);
  if (!p) return false;
  return (
    p.chainId === chainId &&
    p.agentRegistry === getAddress(binding.agentRegistry) &&
    p.agentRegistryId === binding.agentRegistryId &&
    agentId === formatAgentId(chainId, binding.agentRegistry, binding.agentRegistryId)
  );
}
