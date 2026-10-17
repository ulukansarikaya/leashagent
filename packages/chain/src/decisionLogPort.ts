import {
  BaseError,
  ContractFunctionRevertedError,
  type Account,
  type Address,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import { CHAIN_VERDICTS, EXEC_STATUSES, requestIdToBytes32, type ChainRecord, type Hex } from "@bekci/shared";
import { decisionLogAbi } from "./abi.js";

/** Chain I/O the outbox needs. Swappable so the outbox logic is testable without a node. */
export interface DecisionLogPort {
  /** True if the record's effect is already on chain (crash between send and bookkeeping). */
  isApplied(r: ChainRecord): Promise<boolean>;
  /** Throws PermanentRevert if the call would revert, any other error if transient. */
  simulate(r: ChainRecord): Promise<void>;
  send(r: ChainRecord): Promise<Hex>;
  waitForReceipt(hash: Hex): Promise<"success" | "reverted">;
}

export class PermanentRevert extends Error {
  constructor(public readonly errorName: string) {
    super(`contract revert: ${errorName}`);
  }
}

const verdictIndex = (v: (typeof CHAIN_VERDICTS)[number]) => CHAIN_VERDICTS.indexOf(v);
const statusIndex = (s: (typeof EXEC_STATUSES)[number]) => EXEC_STATUSES.indexOf(s);

function callFor(r: ChainRecord) {
  if (r.kind === "decision") {
    return {
      functionName: "logDecision" as const,
      args: [
        r.policyId,
        requestIdToBytes32(r.requestId),
        verdictIndex(r.verdict),
        r.policyHash,
        BigInt(r.policyVersion),
        r.normalizedOrderHash,
        r.evidenceHash,
        r.reasonCode,
        r.authHash,
      ] as const,
    };
  }
  return {
    functionName: "logExecution" as const,
    args: [requestIdToBytes32(r.requestId), r.eventSeq, statusIndex(r.status), r.okxResultHash] as const,
  };
}

export function createDecisionLogPort(opts: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  chain: Chain;
  address: Address;
}): DecisionLogPort {
  const { publicClient, walletClient, account, chain, address } = opts;

  return {
    async isApplied(r) {
      const [, decision, , lastSeq] = await publicClient.readContract({
        address,
        abi: decisionLogAbi,
        functionName: "requestState",
        args: [requestIdToBytes32(r.requestId)],
      });
      if (r.kind === "execution") return lastSeq >= r.eventSeq;
      if (decision === 0) return false;
      const onChain = decision - 1;
      const mine = verdictIndex(r.verdict);
      // Pending is superseded by any later verdict; other verdicts are terminal.
      return onChain === mine || (r.verdict === "PENDING" && onChain !== mine);
    },

    async simulate(r) {
      const c = callFor(r);
      try {
        await publicClient.simulateContract({ address, abi: decisionLogAbi, account, ...c } as never);
      } catch (e) {
        if (e instanceof BaseError) {
          const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
          if (revert instanceof ContractFunctionRevertedError) {
            throw new PermanentRevert(revert.data?.errorName ?? revert.reason ?? "unknown");
          }
        }
        throw e;
      }
    },

    async send(r) {
      const c = callFor(r);
      return walletClient.writeContract({ address, abi: decisionLogAbi, account, chain, ...c } as never);
    },

    async waitForReceipt(hash) {
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      return receipt.status;
    },
  };
}
