import fuji from "../deployments/fuji.json" with { type: "json" };
import type { Hex } from "@bekci/shared";

export type Deployment = {
  network: string;
  chainId: number;
  rpcUrl: string;
  explorer: string;
  contracts: Record<"PolicyRegistry" | "DecisionLog", { address: Hex; deployTx: Hex; deployBlock: number }>;
  roles: { decisionLogOwner: Hex; decisionLogLogger: Hex };
  erc8004: { identityRegistry: Hex; reputationRegistry: Hex };
  x402: { facilitator: string; network: string; asset: Hex; assetName: string; assetVersion: string; assetDecimals: number };
  identities: Partial<Record<"bekci" | "tradingAgent", { agentId: string; agentRegistryId: string; owner: Hex; tx: Hex }>>;
  demoPolicy: null | { policyId: Hex; owner: Hex; agentAuthAddress: Hex; policyURI: string; policyHash: Hex; version: number };
};

/** Avalanche Fuji deployment manifest (packages/chain/deployments/fuji.json). Public data only — no keys. */
export const FUJI_DEPLOYMENT = fuji as Deployment;
