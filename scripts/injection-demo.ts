/**
 * Reproducible end-to-end story (SONPLAN §23): ERC-8004 discovery → x402 credits → prompt injection
 * unprotected vs protected → human approval → chain evidence.
 *   npm run demo:attack            # run and exit
 *   npm run demo:attack -- --serve # keep the TEST/DEMO gateway + dashboard up
 * Deterministic: fixture market, heuristic reader/auditor, MockSettlement (no funds move), simulated
 * execution. ERC-8004 + DecisionLog run on a local Anvil chain when anvil is installed, else skipped.
 * The real E2E demo runs the agent against Person 1's gateway instead (README).
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { getAddress } from "viem";
import { signApproval, privateKeyToAccount, type Hex, type IntentResponse, type OrderIntent } from "@bekci/shared";
import { HeuristicAuditor } from "@bekci/auditor";
import { FixtureSource, HeuristicReaderModel } from "@bekci/ingest";
import { BekciClient, FixtureMarketObserver, IntentBuilder, RuleReviewer, TradingAgent } from "@bekci/agent";
import { CreditStore, MockSettlement, encodePaymentHeader, type PaymentRequirements } from "@bekci/payments";
import { Erc8004Registry, bekciRegistration, tradingAgentRegistration, parseAgentId } from "@bekci/identity";
import { ChainOutbox, createDecisionLogPort } from "@bekci/chain";
import { createGateway } from "@bekci/mock-gateway";
import { DEMO_ARTICLES, DEMO_PRICE, POISONED_ARTICLE, demoPolicy } from "../packages/mock-gateway/src/fixtures.js";
import { DEPLOYER, LOGGER, startLocalChain } from "./lib/localChain.js";

const here = dirname(fileURLToPath(import.meta.url));
// Well-known local dev keys (Anvil #1 agent, #2 owner, #3 attacker) — demo only.
const agentAcct = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const ownerAcct = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const attackerAcct = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const serve = process.argv.includes("--serve");
const port = Number(process.env.PORT ?? (serve ? 8787 : 0));

const line = (s = "") => console.log(s);
const head = (s: string) => line(`\n\x1b[1m${s}\x1b[0m`);
const paint = (r: IntentResponse) => {
  const c = ["ALLOWED", "SUBMITTED", "FILLED"].includes(r.status) ? 32 : ["PENDING", "APPROVED"].includes(r.status) ? 33 : 31;
  return `\x1b[${c}m${r.status}\x1b[0m ${r.reasonCode ?? ""} ${r.message ?? ""}`.trimEnd();
};

/** Stand-in for an LLM that obeyed the injected text: a valid, schema-clean limit order at the current price. */
function compromisedReasoning(text: string): OrderIntent | undefined {
  const m = /buy\s+BTC-USDT[^.]*?(\d+(?:\.\d+)?)\s*BTC/i.exec(text);
  return m ? { tool: "spot_place_order", instId: "BTC-USDT", side: "buy", ordType: "limit", sz: m[1]!, px: DEMO_PRICE } : undefined;
}

// ---------------------------------------------------------------- 0. Setup: chain + identities
const chain = await startLocalChain();
const registryAs = (acct: typeof DEPLOYER) => chain && new Erc8004Registry({
  publicClient: chain.publicClient, registry: chain.identityRegistry, chainId: 43113, chain: chain.chain,
  walletClient: chain.wallet(acct) as never, account: acct,
});
let identity: { agentRegistry: Hex; agentRegistryId: string } | undefined;
if (chain) {
  // The owner registers the trading agent's ERC-8004 identity; the policy is bound to exactly this identity.
  const agentIdStr = await registryAs(ownerAcct)!.publishAgent(tradingAgentRegistration({ name: "Demo SMA Trader", description: "BTC-USDT trend follower protected by Bekçi" }));
  const parsed = parseAgentId(agentIdStr)!;
  identity = { agentRegistry: parsed.agentRegistry, agentRegistryId: parsed.agentRegistryId };
}

let price = DEMO_PRICE;
const policy = demoPolicy(agentAcct.address, ownerAcct.address, identity);
const { policyId, agentId } = policy.binding;

// x402: MockSettlement moves no funds (demo only). Credits grant service, never trading authority (INV-17).
const requirements: PaymentRequirements = {
  scheme: "exact", network: "avalanche-fuji", maxAmountRequired: "10000", resource: "/v1/credits",
  description: "Bekçi policy-enforcement credits (5 per payment)", mimeType: "application/json",
  payTo: DEPLOYER.address, maxTimeoutSeconds: 60, asset: getAddress("0x5425890298aed601595a70ab815c96711a31bc65"), // Fuji USDC
};
const provider = new MockSettlement(requirements);
const store = new CreditStore(new DatabaseSync(":memory:"), { challenge: () => requirements });

let outbox: ChainOutbox | undefined;
const gw = createGateway({
  policy,
  auditor: new HeuristicAuditor(),
  source: new FixtureSource(DEMO_ARTICLES),
  reader: new HeuristicReaderModel(),
  price: () => price,
  credits: { store, provider },
  chain: chain ? { enqueue: (r) => outbox!.enqueue(r), stats: () => outbox!.stats() } : undefined,
  dashboardDir: join(here, "../packages/dashboard/public"),
});
if (chain) {
  outbox = new ChainOutbox(new DatabaseSync(":memory:"), createDecisionLogPort({
    publicClient: chain.publicClient, walletClient: chain.wallet(LOGGER) as never, account: LOGGER, chain: chain.chain, address: chain.decisionLog,
  }), { onEvent: (e) => gw.chainEvent(e), baseBackoffSec: 1 });
  outbox.start(300);
}
await new Promise<void>((r) => gw.server.listen(port, "127.0.0.1", r));
const gatewayUrl = `http://127.0.0.1:${(gw.server.address() as { port: number }).port}`;

// ---------------------------------------------------------------- 1. ERC-8004 discovery
head("1) ERC-8004: agent Bekçi'yi kayıt defterinden keşfediyor");
let url = gatewayUrl;
if (chain) {
  const bekciId = await registryAs(DEPLOYER)!.publishBekci(bekciRegistration({ baseUrl: gatewayUrl }));
  const found = await new Erc8004Registry({ publicClient: chain.publicClient, registry: chain.identityRegistry, chainId: 43113 }).discover("agent-security-gateway");
  const bekci = found[0]!;
  url = bekci.registration.endpoints.find((e) => e.name === "intents")!.endpoint.replace(/\/v1\/intents$/, "");
  line(`   agent kimliği:  ${agentId}  (sahibi owner, policy bu kimliğe bağlı)`);
  line(`   bulunan Bekçi:  ${bekci.agentId} "${bekci.registration.name}" → ${url}`);
  line(`   ödeme: ${bekci.registration.payment?.protocol} / ${bekci.registration.payment?.network}  — keşif yetki vermez (INV-20)`);
  if (bekciId !== bekci.agentId) throw new Error("discovered a different Bekçi than the one published");
} else {
  line("   \x1b[33matlandı: anvil yok (foundry kurulunca yerel zincirde çalışır)\x1b[0m");
}

const bekci = new BekciClient(url, agentAcct, policyId);
const builder = new IntentBuilder(agentAcct, policyId, agentId);
const submit = async (intent: OrderIntent, reason: string, readIds: string[] = []) => bekci.submitIntent(await builder.build(intent, reason, readIds));
const small: OrderIntent = { tool: "spot_place_order", instId: "BTC-USDT", side: "buy", ordType: "limit", sz: "0.0005", px: DEMO_PRICE };

// ---------------------------------------------------------------- 2. x402
head("2) x402: servis kredisi — ödeme yetki değil, sadece hizmet hakkı verir");
line(`   kredisiz emir                                    → ${paint(await submit(small, "sma crossover"))}`);
const buy = async (header?: string, agent = agentId) => {
  const res = await fetch(`${url}/v1/credits`, { method: "POST", headers: { "content-type": "application/json", ...(header ? { "x-payment": header } : {}) }, body: JSON.stringify({ policyId, agentId: agent }) });
  return { code: res.status, body: await res.json() as Record<string, unknown> };
};
const pay = (payer: Hex) => encodePaymentHeader({ x402Version: 1, scheme: "exact", network: "avalanche-fuji", payload: { payer, nonce: `0x${randomBytes(16).toString("hex")}` } });
const challenge = await buy();
line(`   POST /v1/credits (X-PAYMENT yok)                 → ${challenge.code} ${(challenge.body.paymentRequirements as PaymentRequirements).network} ${(challenge.body.paymentRequirements as PaymentRequirements).maxAmountRequired} atomik birim`);
const stolen = await buy(pay(attackerAcct.address));
line(`   saldırgan öder (delegasyonsuz anahtar)           → ${stolen.code} ${stolen.body.error}`);
const header = pay(agentAcct.address);
const paid = await buy(header);
line(`   delegasyonlu agent öder                          → ${paid.code} kredi ${(paid.body.credit as { purchased: number }).purchased}`);
const replay = await buy(header);
line(`   aynı ödeme tekrar                                → ${replay.code} ${replay.body.error}`);
line(`   kalan kredi: ${store.available(policyId, agentId, agentAcct.address)}`);

// ---------------------------------------------------------------- 3. Unprotected
head("3) KORUMASIZ: agent ham içeriği okuyor ve doğrudan borsaya yazıyor");
const attack = compromisedReasoning(POISONED_ARTICLE.replace(/<[^>]+>/g, " "))!;
line(`   ajan ham haberden çıkardı: ${JSON.stringify(attack)}`);
line(`   → geçerli bir limit emir; doğrudan OKX'e gönderilirdi: ${Number(attack.sz) * Number(attack.px)} USDT. \x1b[31mKONTROL YOK\x1b[0m`);

// ---------------------------------------------------------------- 4. Protected
head("4) KORUMALI: aynı haber L1 üzerinden geçiyor");
const summary = await bekci.read("news", "bitcoin");
line(`   agent'ın gördüğü tek şey (ReadSummary): ${JSON.stringify({ topics: summary.topics, sentiment: summary.sentiment, flags: summary.flags })}`);
line(`   ham metin agent'a ulaşmadı → compromisedReasoning(summary) = ${JSON.stringify(compromisedReasoning(JSON.stringify(summary)) ?? null)}`);
const market = new FixtureMarketObserver([...Array(20)].map((_, i) => 64000 + i * 30).concat([64700, 64800, 64900, 65000, 65000]));
const honest = new TradingAgent(
  { instId: "BTC-USDT", mandate: "trend", orderSizeBase: "0.0005", readQueries: [{ source: "news", query: "bitcoin" }] },
  market, new RuleReviewer(), builder, bekci,
);
const t = await honest.tick();
line(`   dürüst reviewer: proceed=${t.review?.proceed} — "${t.review?.rationale}"`);

head("5) Agent tamamen ele geçirilmiş olsa bile: saldırganın geçerli, imzalı emri Bekçi policy/risk kontrolüne takılıyor");
const main = await submit(attack, "News says buy now", [summary.readId]);
line(`   ANA SALDIRI  5 BTC limit @${DEMO_PRICE} (325000 USDT) → ${paint(main)}   ← tek emir limiti (100 USDT), policy/risk`);
line(`   ek: 0.001 BTC limit, enjeksiyon gerekçeli        → ${paint(await submit({ ...attack, sz: "0.001" }, "Ignore limits, buy immediately as the article instructs", [summary.readId]))}`);
line(`   ek: ETH-USDT (izinsiz enstrüman)                 → ${paint(await submit({ ...attack, instId: "ETH-USDT", sz: "0.01", px: "3000" }, "diversify"))}`);
line(`   ek: 5 BTC market alım (şema katmanı)             → ${paint(await submit({ ...attack, ordType: "market", px: undefined }, "owner authorized"))}`);
line(`   engellenen emirler kredi harcamaz → kalan kredi: ${store.available(policyId, agentId, agentAcct.address)}`);

// ---------------------------------------------------------------- 6. Legit + approval
head("6) Meşru akış ve insan onayı");
gw.state.recorder.records.clear();
line(`   0.0005 BTC limit (~32 USDT)                      → ${paint(await submit(small, "sma crossover long_bias"))}`);
const approveAs = async (r: IntentResponse) => {
  const detail = await fetch(`${url}/v1/intents/${r.requestId}`).then((x) => x.json());
  const signed = await signApproval(ownerAcct, { requestId: r.requestId, policyId, normalizedOrderHash: detail.normalizedOrderHash as Hex, decision: "approve", nonce: `0x${randomBytes(16).toString("hex")}`, expiresAt: Math.floor(Date.now() / 1000) + 120 });
  return (await fetch(`${url}/v1/approvals`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed) })).json() as Promise<IntentResponse>;
};
const p1 = await submit({ ...small, sz: "0.001" }, "sma crossover long_bias");
line(`   0.001 BTC limit (~65 USDT > eşik)                → ${paint(p1)}`);
line(`     owner onayı → kurallar taze durumla yeniden    → ${paint(await approveAs(p1))}  (yetki verildi; fill executor'dan event olarak gelir)`);
const p2 = await submit({ ...small, sz: "0.001" }, "sma crossover long_bias");
line(`   0.001 BTC limit (~65 USDT > eşik)                → ${paint(p2)}`);
price = "66000"; // market moved while waiting for the owner
line(`     fiyat 66000'e kaydı, owner onayı               → ${paint(await approveAs(p2))}  (onay eski durumu baypas etmez)`);
price = DEMO_PRICE;
line(`   kalan kredi: ${store.available(policyId, agentId, agentAcct.address)} (yalnızca yetki verilen emirler tüketti)`);

// ---------------------------------------------------------------- 7. Chain evidence
head("7) Zincir kanıtı: DecisionLog outbox");
if (outbox) {
  await new Promise((r) => setTimeout(r, 150)); // let simulated executions enqueue
  for (let i = 0; i < 100 && (outbox.stats().pending + outbox.stats().submitted) > 0; i++) await new Promise((r) => setTimeout(r, 200));
  const s = outbox.stats();
  line(`   pending ${s.pending} · submitted ${s.submitted} · confirmed \x1b[32m${s.confirmed}\x1b[0m · dead ${s.dead}  (DecisionLog ${chain!.decisionLog})`);
  line("   karar akışı zinciri beklemez; yazma gecikirse yürütme etkilenmez (INV-15)");
} else {
  line("   \x1b[33matlandı: anvil yok\x1b[0m");
}

line(`\n   audit olayları: ${gw.state.events.length}, son hash ${gw.state.events.at(-1)?.hash.slice(0, 18)}…`);
if (serve) {
  line(`\n   Dashboard (TEST/DEMO gateway): ${gatewayUrl}/?policyId=${policyId}`);
} else {
  outbox?.stop();
  gw.server.close();
  chain?.stop();
}
