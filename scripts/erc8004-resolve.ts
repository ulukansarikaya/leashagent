// Read-only: resolve an ERC-8004 agent on Avalanche Fuji.  Usage: npx tsx scripts/erc8004-resolve.ts <agentRegistryId>
import { createPublicClient, http, type PublicClient } from "viem";
import { avalancheFuji } from "viem/chains";
import { Erc8004Registry, FUJI_IDENTITY_REGISTRY } from "@leashagent/identity";

const id = process.argv[2] ?? "1";
const publicClient = createPublicClient({ chain: avalancheFuji, transport: http(process.env.CHAIN_RPC_URL) }) as PublicClient;
const registry = new Erc8004Registry({ publicClient, registry: FUJI_IDENTITY_REGISTRY, chainId: 43113 });
const a = await registry.resolve(id);
console.log(JSON.stringify({ agentId: a.agentId, owner: a.owner, name: a.registration.name, services: a.registration.services, leash: a.registration.leash ?? null }, null, 2));
