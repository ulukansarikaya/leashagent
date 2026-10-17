import { decodeEventLog, getAddress, type Account, type Address, type Chain, type PublicClient, type WalletClient } from "viem";
import type { Hex, ServiceDiscovery } from "@leashagent/shared";
import { formatAgentId } from "./agentId.js";
import { loadRegistration, registrationSchema, toDataUri, type ForeignRegistration, type Registration } from "./metadata.js";

/**
 * Subset of the ERC-8004 IdentityRegistry Leash Agent uses — verified against erc-8004/erc-8004-contracts abis/IdentityRegistry.json.
 * Avalanche Fuji deployment: FUJI_IDENTITY_REGISTRY.
 */
export const FUJI_IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;

export const identityRegistryAbi = [
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "agentURI", type: "string" }], outputs: [{ name: "agentId", type: "uint256" }] },
  { type: "function", name: "setAgentURI", stateMutability: "nonpayable", inputs: [{ name: "agentId", type: "uint256" }, { name: "newURI", type: "string" }], outputs: [] },
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "agentId", type: "uint256" }], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "tokenURI", stateMutability: "view", inputs: [{ name: "agentId", type: "uint256" }], outputs: [{ name: "", type: "string" }] },
  {
    type: "event", name: "Registered", anonymous: false,
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentURI", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
    ],
  },
] as const;

export type ResolvedAgent = { agentId: string; agentRegistryId: string; owner: Hex; registration: ForeignRegistration };

type Kind = Registration["leash"]["kind"];

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

  publishLeash(metadata: unknown): Promise<string> {
    return this.publish(metadata, "agent-security-gateway");
  }

  publishAgent(metadata: unknown): Promise<string> {
    return this.publish(metadata, "trading-agent");
  }

  /** Registers a new identity and returns its canonical agentId string. */
  private async publish(metadata: unknown, kind: Kind): Promise<string> {
    const { walletClient, account, chain, publicClient, registry } = this.opts;
    if (!walletClient || !account) throw new Error("publishing requires walletClient + account");
    const reg = registrationSchema.parse(metadata);
    if (reg.leash.kind !== kind) throw new Error(`metadata kind must be ${kind}`);
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

  /** Owner-only: replace an identity's registration card (e.g. once the gateway URL is known). Returns tx hash. */
  async updateRegistration(agentRegistryId: string, metadata: unknown): Promise<Hex> {
    const { walletClient, account, chain, publicClient, registry } = this.opts;
    if (!walletClient || !account) throw new Error("updating requires walletClient + account");
    const reg = registrationSchema.parse(metadata);
    const uri = this.opts.upload ? await this.opts.upload(reg) : toDataUri(reg);
    const hash = await walletClient.writeContract({
      address: registry, abi: identityRegistryAbi, functionName: "setAgentURI",
      args: [BigInt(agentRegistryId), uri], account, chain: chain ?? null,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("setAgentURI reverted");
    return hash;
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

  /**
   * Scan Registered events and return identities of a given Leash Agent kind (e.g. find gateways).
   * Public RPCs cap log ranges, so the scan is chunked (adapting down to 100-block windows). Pass `fromBlock` (e.g. the
   * deployment block) on public networks — the default window is the last 200k blocks.
   */
  async discover(kind: Kind, opts: { fromBlock?: bigint; toBlock?: bigint; chunk?: bigint } = {}): Promise<ResolvedAgent[]> {
    const pub = this.opts.publicClient;
    // cacheTime: 0 — a cached (stale) head would silently drop the newest registrations from the scan.
    const toBlock = opts.toBlock ?? (await pub.getBlockNumber({ cacheTime: 0 }));
    const fromBlock = opts.fromBlock ?? (toBlock > 200_000n ? toBlock - 200_000n : 0n);
    let chunk = opts.chunk ?? 2_000n;
    const ids: bigint[] = [];
    for (let start = fromBlock; start <= toBlock; ) {
      const end = start + chunk - 1n > toBlock ? toBlock : start + chunk - 1n;
      let logs;
      try {
        logs = await pub.getContractEvents({
          address: this.opts.registry, abi: identityRegistryAbi, eventName: "Registered", fromBlock: start, toBlock: end,
        });
      } catch (e) {
        // Public RPCs cap the log range (Avalanche's public Fuji RPC: 100 blocks) — shrink and retry this window.
        if (chunk > 100n && /range|limit|too large|too many/i.test(e instanceof Error ? e.message : String(e))) {
          chunk = 100n;
          continue;
        }
        throw e;
      }
      for (const l of logs) if (l.args.agentId !== undefined) ids.push(l.args.agentId);
      start = end + 1n;
    }
    const out: ResolvedAgent[] = [];
    for (const id of ids) {
      try {
        const r = await this.resolve(id.toString());
        if (r.registration.leash?.kind === kind) out.push(r);
      } catch {
        // invalid/unreachable metadata is skipped, never trusted
      }
    }
    return out;
  }
}
