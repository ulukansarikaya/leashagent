# Bekçi

Mimari: `SONPLAN.md`. Bu repo **Kişi 2** (agent, ingest, auditor, dashboard, demo) ve **Kişi 3** (shared, Avalanche
kontratları, zincir istemcisi/outbox, x402, ERC-8004) kapsamlarını içerir. Kişi 1 (gateway/executor) henüz yok —
şimdilik `packages/mock-gateway` onun yerini tutuyor. Kişi 3 entegrasyon notları: `docs/PERSON3_HANDOFF.md`.

**Gereksinimler:** Node ≥ 22.13 (24 önerilir; `node:sqlite` kullanılıyor), npm, Foundry (`forge`, `anvil`).

## Paketler

| Paket | Katman | İçerik |
|---|---|---|
| `packages/shared` | — | **Tek ortak paket (dondurulmuş).** §5 tipleri, `canonicalJson`, `policyId`/`clOrdId`/hash yardımcıları, EIP-712 (AgentIntent, AgentRead, ExecutionAuthorization, ApprovalDecision, PauseCommand), strict zod şemaları, `dec` ondalık aritmetiği, reason kodları, yürütme geçiş tablosu. Tipleri yeniden tanımlamayın; buradan import edin. |
| `packages/chain` | C / L7 | `PolicyRegistry` + `DecisionLog` (Solidity, Foundry testleri), Fuji deploy scripti, `PolicyChainClient`, `verifyPolicyDocument` (INV-11), L6 için zincir tabanlı `PolicyStateProvider`, kalıcı `ChainOutbox`. |
| `packages/payments` | §21.2 | x402: kalıcı kredi defteri (1 ödeme → 5 kredi, `paymentRef` tek sefer), `purchaseCredits` (`POST /v1/credits`), facilitator + mock adaptör. |
| `packages/identity` | §21.3 | ERC-8004: Bekçi/agent kayıt kartları, yayınlama + keşif, `agentIdMatchesBinding`. |
| `packages/llm` | — | Araçsız (tool-less), geçmişsiz tek-çağrı LLM istemcisi (Anthropic Messages API). |
| `packages/ingest` | L1 | `HttpFetcher` (host allowlist, timeout, boyut/content-type limiti), `sanitize`, `LlmReaderModel`/`HeuristicReaderModel`, talimat dedektörü, `ReadRecorder`, `DefaultIngestService` (agent imzası doğrulanır; ham içerik L1'den çıkmaz). |
| `packages/agent` | L2 | `OkxPublicMarketObserver` (anahtarsız), SMA + hacim filtreli `generateSignal`, `LlmReviewer`/`RuleReviewer`, EIP-712 imzalı `IntentBuilder`, egress allowlist'li `BekciClient`, `TradingAgent` döngüsü. OKX anahtarı ortamdaysa başlamayı reddeder (INV-1). |
| `packages/auditor` | L4 adaptörü | `GenericLlmAuditor`, `JevAuditor` (erişim yolu/format doğrulanmadı, §19.4), `HeuristicAuditor`. Timeout/şema dışı → `AuditorUnavailable` (gateway bunu `PENDING 302` yapar). |
| `packages/dashboard` | L7 UI | Statik HTML/JS; yalnızca HTTP + SSE. Politika görünümü, canlı akış (hash zinciri kontrolü), ALLOW/BLOCK/PENDING/REJECTED_PAYMENT, kanıt hash'i, cüzdan (EIP-712) imzalı onay/red ve acil durdurma. |
| `packages/mock-gateway` | — | **Sadece demo.** Kişi 1'in gateway'i gelene kadar §9 HTTP sözleşmesinin küçük bir taklidi. OKX'e asla yazmaz; yürütme simüledir. |

## Çalıştırma

```bash
npm install
npm test                         # tüm TS testleri (anvil varsa zincir e2e dahil)
npm run test:contracts           # Solidity testleri (forge)
npm run demo:attack              # korumasız vs korumalı injection demosu (offline, deterministik)
npm run demo:attack -- --serve   # + dashboard: http://127.0.0.1:8787
```

Gerçek agent (mock veya gerçek gateway'e karşı):

```bash
AGENT_AUTH_KEY=0x... BEKCI_POLICY_ID=0x... AGENT_ID=... BEKCI_URL=http://127.0.0.1:8787 npm run demo:agent
```

İsteğe bağlı LLM'ler: `AGENT_LLM_API_KEY`, `READER_MODEL_API_KEY`, `AUDITOR_API_KEY` (+ `*_MODEL`).
Auditor seçimi: `AUDITOR_PROVIDER=jev|llm|heuristic` (`jev` için `JEV_ENDPOINT`).

## Demo senaryosu (`scripts/injection-demo.ts`)

1. **Korumasız:** agent zehirli haberi ham okur, gizli talimatı uygular → 5 BTC market alım doğrudan borsaya gider.
2. **Korumalı:** aynı haber L1'den geçer; agent yalnızca `ReadSummary` görür (`contains_instructions` bayraklı), dürüst reviewer geri çekilir.
3. **Agent tamamen ele geçirilse bile:** imzalı saldırı emirleri → `REJECTED_SCHEMA` (market buy kapalı, §25.6), `BLOCKED 103`, `BLOCKED 201` (auditor), `BLOCKED 101`.
4. **Meşru akış:** küçük emir `FILLED` (simüle), eşik üstü `PENDING 303` → dashboard'dan owner onayı.

## Dondurma için açık noktalar (Kişi 1/3 ile)

- `ReadRequest.agentSignature` için EIP-712 tipi planda yok; `AgentRead {requestId, policyId, source, queryHash}` önerildi.
- `ApprovalDecision` ve `PauseCommand` alan sırası §5.10'dan türetildi.
- `ReadSummary` birden çok kaynağı birleştirdiğinde tek `readId` döner; auditor ayrıca politikadaki son okumaları da görür.
