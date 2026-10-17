import { decodeEventLog, getAddress, type Account, type Address, type Chain, type PublicClient, type WalletClient } from "viem";
import type { Hex, ServiceDiscovery } from "@bekci/shared";
import { formatAgentId } from "./agentId.js";
import { loadRegistration, registrationSchema, toDataUri, type Registration } from "./metadata.js";

/** Subset of the ERC-8004 Identity Registry Bekçi uses. UNVERIFIED against the deployed registry (§24.2). */
export const identityRegistryAbi = [
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "uri", type: "string" }], outputs: [{ name: "agentId", type: "uint256" }] },
  { type: "function", name: "setAgentURI", stateMutability: "nonpayable", inputs: [{ name: "agentId", type: "uint256" }, { name: "uri", type: "string" }], outputs: [] },
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "agentId", type: "uint256" }], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "tokenURI", stateMutability: "view", inputs: [{ name: "agentId", type: "uint256" }], outputs: [{ name: "", type: "string" }] },
  {
    type: "event", name: "Registered", anonymous: false,
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "tokenURI", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
    ],
  },
] as const;

export type ResolvedAgent = { agentId: string; agentRegistryId: string; owner: Hex; registration: Registration };

/**
 * ERC-8004 discovery adapter. Discovery/metadata only — INV-20: nothing returned here is ever runtime
 * authorization. L3 still verifies agentAuthAddress + EIP-712 + delegation from PolicyRegistry.
 */
export class Erc8004Registry implements ServiceDiscovery {
  constructor(
    private readonly opts: {
      publicClient: PublicClient;
      registry: Address;
      chainId: number;
      walletClient?: WalletClient;
      account?: Account;
      chain?: Chain;
      /** Turns a registration into a URI (default: data: URI). */
      upload?: (r: Registration) => Promise<string>;
      fetchImpl?: typeof fetch;
    },
  ) {}

  publishBekci(metadata: unknown): Promise<string> {
    return this.publish(metadata, "agent-security-gateway");
  }

  publishAgent(metadata: unknown): Promise<string> {
    return this.publish(metadata, "trading-agent");
  }

  /** Registers a new identity and returns its canonical agentId string. */
  private async publish(metadata: unknown, kind: Registration["kind"]): Promise<string> {
    const { walletClient, account, chain, publicClient, registry } = this.opts;
    if (!walletClient || !account) throw new Error("publishing requires walletClient + account");
    const reg = registrationSchema.parse(metadata);
    if (reg.kind !== kind) throw new Error(`metadata kind must be ${kind}`);
    const uri = this.opts.upload ? await this.opts.upload(reg) : toDataUri(reg);

    const hash = await walletClient.writeContract({
      address: registry, abi: identityRegistryAbi, functionName: "register", args: [uri], account, chain: chain ?? null,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("register reverted");
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== getAddress(registry)) continue;
      try {
        const ev = decodeEventLog({ abi: identityRegistryAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "Registered") return formatAgentId(this.opts.chainId, registry, ev.args.agentId);
      } catch {
        // not our event
      }
    }
    throw new Error("Registered event not found");
  }

  async resolve(agentRegistryId: string): Promise<ResolvedAgent> {
    const { publicClient, registry } = this.opts;
    const id = BigInt(agentRegistryId);
    const [owner, uri] = await Promise.all([
      publicClient.readContract({ address: registry, abi: identityRegistryAbi, functionName: "ownerOf", args: [id] }),
      publicClient.readContract({ address: registry, abi: identityRegistryAbi, functionName: "tokenURI", args: [id] }),
    ]);
    const registration = await loadRegistration(uri, this.opts.fetchImpl);
    return {
      agentId: formatAgentId(this.opts.chainId, registry, id),
      agentRegistryId: id.toString(),
      owner: getAddress(owner),
      registration,
    };
  }

  /** Scan Registered events and return identities of a given kind (e.g. find Bekçi gateways). */
  async discover(kind: Registration["kind"], fromBlock: bigint = 0n): Promise<ResolvedAgent[]> {
    const logs = await this.opts.publicClient.getContractEvents({
      address: this.opts.registry, abi: identityRegistryAbi, eventName: "Registered", fromBlock,
    });
    const out: ResolvedAgent[] = [];
    for (const l of logs) {
      try {
        const r = await this.resolve(l.args.agentId!.toString());
        if (r.registration.kind === kind) out.push(r);
      } catch {
        // invalid/unreachable metadata is skipped, never trusted
      }
    }
    return out;
  }
}
