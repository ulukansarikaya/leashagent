/**
 * Gateway under test. The acceptance suite talks to it over HTTP only (§9), so the same
 * tests run against the TEST/DEMO mock (default) or Person 1's real gateway:
 *
 *   BEKCI_GATEWAY_URL=https://… BEKCI_AGENT_KEY=0x… BEKCI_OWNER_KEY=0x… \
 *   BEKCI_POLICY_ID=0x… BEKCI_AGENT_ID=… npm run test:acceptance
 */
import type { Account } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { privateKeyToAccount, type Hex } from "@bekci/shared";
import { HeuristicAuditor } from "@bekci/auditor";
import { HeuristicReaderModel, type ContentSource, type RawContent } from "@bekci/ingest";
import { createGateway } from "@bekci/mock-gateway";
import { BENIGN_ARTICLE, DEMO_PRICE, POISONED_ARTICLE, demoPolicy } from "../../packages/mock-gateway/src/fixtures.js";

export type Target = {
  kind: "mock" | "real";
  url: string;
  agent: Account;
  owner: Account;
  attacker: Account;
  policyId: Hex;
  agentId: string;
  order: { instId: string; px: string; smallSz: string; escalateSz: string; overLimitSz: string };
  /** State controls only the mock can offer; tests needing them are skipped on a real gateway. */
  controls?: { setPrice(px: string): void; setPoisoned(on: boolean): void; setEntitled(on: boolean): void };
  close(): Promise<void>;
};

export async function connectTarget(): Promise<Target> {
  return process.env.BEKCI_GATEWAY_URL ? realTarget() : mockTarget();
}

async function realTarget(): Promise<Target> {
  const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`acceptance against real gateway needs ${k}`); return v; };
  const instId = process.env.BEKCI_TEST_INST ?? "BTC-USDT";
  // Resting buy at the bid: inside price-deviation limits, not immediately marketable.
  const px: string = process.env.BEKCI_TEST_PX ?? await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${instId}`)
    .then((r) => r.json()).then((b: { data: { bidPx: string }[] }) => b.data[0]!.bidPx as string);
  return {
    kind: "real",
    url: need("BEKCI_GATEWAY_URL").replace(/\/$/, ""),
    agent: privateKeyToAccount(need("BEKCI_AGENT_KEY") as Hex),
    owner: privateKeyToAccount(need("BEKCI_OWNER_KEY") as Hex),
    attacker: privateKeyToAccount(generatePrivateKey()),
    policyId: need("BEKCI_POLICY_ID") as Hex,
    agentId: need("BEKCI_AGENT_ID"),
    order: {
      instId, px,
      smallSz: process.env.BEKCI_TEST_SMALL_SZ ?? "0.0001",
      escalateSz: need("BEKCI_TEST_ESCALATE_SZ"),
      overLimitSz: process.env.BEKCI_TEST_OVERLIMIT_SZ ?? "5",
    },
    close: async () => {},
  };
}

async function mockTarget(): Promise<Target> {
  // Well-known local test keys (Hardhat #1 agent, #2 owner, #3 attacker).
  const agent = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const owner = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
  const attacker = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
  let price = DEMO_PRICE, poisoned = false, entitled = true;
  const source: ContentSource = {
    async fetch(): Promise<RawContent[]> {
      return [{ url: "https://news.example/a", fetchedAt: Math.floor(Date.now() / 1000), body: poisoned ? POISONED_ARTICLE : BENIGN_ARTICLE }];
    },
  };
  const policy = demoPolicy(agent.address, owner.address);
  const gw = createGateway({
    policy, source, auditor: new HeuristicAuditor(), reader: new HeuristicReaderModel(),
    price: () => price, entitled: () => entitled,
  });
  await new Promise<void>((r) => gw.server.listen(0, "127.0.0.1", r));
  return {
    kind: "mock",
    url: `http://127.0.0.1:${(gw.server.address() as { port: number }).port}`,
    agent, owner, attacker,
    policyId: policy.binding.policyId,
    agentId: policy.binding.agentId,
    order: { instId: "BTC-USDT", px: DEMO_PRICE, smallSz: "0.0005", escalateSz: "0.001", overLimitSz: "5" },
    controls: {
      setPrice: (px) => { price = px; },
      setPoisoned: (on) => { poisoned = on; },
      setEntitled: (on) => { entitled = on; },
    },
    close: () => new Promise((r) => { gw.server.closeAllConnections(); gw.server.close(() => r()); }),
  };
}
