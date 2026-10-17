/**
 * DEMO ONLY: a throwaway Anvil chain (chainId 43113, so agentIds match the Fuji format) with
 * Person 3's MockIdentityRegistry (ERC-8004 stand-in) and the real DecisionLog contract.
 * Returns undefined if anvil is not installed; the demo then skips the chain steps.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createPublicClient, createWalletClient, defineChain, http, type Abi, type Account, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decisionLogAbi, decisionLogBytecode, mockIdentityRegistryAbi, mockIdentityRegistryBytecode } from "@bekci/chain";

// Anvil's well-known dev keys #0 (Bekçi operator / deployer) and #4 (DecisionLog LOGGER).
export const DEPLOYER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
export const LOGGER = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");

export type LocalChain = {
  chain: ReturnType<typeof defineChain>;
  publicClient: PublicClient;
  wallet(account: Account): ReturnType<typeof createWalletClient>;
  identityRegistry: Address;
  decisionLog: Address;
  stop(): void;
};

export async function startLocalChain(): Promise<LocalChain | undefined> {
  const bin = process.env.ANVIL_BIN ?? `${homedir()}/.foundry/bin/anvil`;
  if (!existsSync(bin)) return undefined;
  const port = 18545 + Math.floor(Math.random() * 1000);
  const proc: ChildProcess = spawn(bin, ["--port", String(port), "--chain-id", "43113", "--silent"], { stdio: "ignore" });
  const chain = defineChain({
    id: 43113, name: "anvil (Fuji chainId)", nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
    rpcUrls: { default: { http: [`http://127.0.0.1:${port}`] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(), pollingInterval: 100 }) as PublicClient;
  for (let i = 0; ; i++) {
    try { await publicClient.getBlockNumber(); break; } catch {
      if (i > 60) { proc.kill(); throw new Error("anvil did not start"); }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const wallet = (account: Account) => createWalletClient({ account, chain, transport: http() });
  const deploy = async (abi: Abi, bytecode: `0x${string}`, args: unknown[] = []) => {
    const hash = await wallet(DEPLOYER).deployContract({ abi, bytecode, args } as never);
    return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
  };
  const identityRegistry = await deploy(mockIdentityRegistryAbi as Abi, mockIdentityRegistryBytecode);
  const decisionLog = await deploy(decisionLogAbi as Abi, decisionLogBytecode, [DEPLOYER.address]);
  await publicClient.waitForTransactionReceipt({
    hash: await wallet(DEPLOYER).writeContract({ address: decisionLog, abi: decisionLogAbi, functionName: "setLogger", args: [LOGGER.address, true], chain, account: DEPLOYER }),
  });
  return { chain, publicClient, wallet, identityRegistry, decisionLog, stop: () => proc.kill() };
}
