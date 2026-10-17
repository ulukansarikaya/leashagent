# Bekçi — Görev 2: Agent + AI + Dashboard/Demo

Bu repo, `SONPLAN.md` §26'daki **Kişi 2** kapsamını içerir: L1 ingest, L2 trading agent, auditor/Jev adaptörü,
prompt-injection saldırı demosu ve dashboard. Kişi 1 (gateway/executor) ve Kişi 3 (zincir/x402/ERC-8004) bölümleri burada **yok**.

## Paketler

| Paket | Katman | İçerik |
|---|---|---|
| `packages/shared` | — | §5 tipleri, `canonicalJson`, EIP-712 (`AgentIntent` + önerilen `AgentRead`/`ApprovalDecision`/`PauseCommand`), zod şemaları, ondalık yardımcıları. **Kişi 1+3 dondurduğunda onların sürümü esas alınmalı.** |
| `packages/llm` | — | Araçsız (tool-less), geçmişsiz tek-çağrı LLM istemcisi (Anthropic Messages API). |
| `packages/ingest` | L1 | `HttpFetcher` (host allowlist, timeout, boyut/content-type limiti), `sanitize`, `LlmReaderModel`/`HeuristicReaderModel`, talimat dedektörü, `ReadRecorder`, `DefaultIngestService` (agent imzası doğrulanır; ham içerik L1'den çıkmaz). |
| `packages/agent` | L2 | `OkxPublicMarketObserver` (anahtarsız), SMA + hacim filtreli `generateSignal`, `LlmReviewer`/`RuleReviewer`, EIP-712 imzalı `IntentBuilder`, egress allowlist'li `BekciClient`, `TradingAgent` döngüsü. OKX anahtarı ortamdaysa başlamayı reddeder (INV-1). |
| `packages/auditor` | L4 adaptörü | `GenericLlmAuditor`, `JevAuditor` (erişim yolu/format doğrulanmadı, §19.4), `HeuristicAuditor`. Timeout/şema dışı → `AuditorUnavailable` (gateway bunu `PENDING 302` yapar). |
| `packages/dashboard` | L7 UI | Statik HTML/JS; yalnızca HTTP + SSE. Politika görünümü, canlı akış (hash zinciri kontrolü), ALLOW/BLOCK/PENDING/REJECTED_PAYMENT, kanıt hash'i, cüzdan (EIP-712) imzalı onay/red ve acil durdurma. |
| `packages/mock-gateway` | — | **Sadece demo.** Kişi 1'in gateway'i gelene kadar §9 HTTP sözleşmesinin küçük bir taklidi. OKX'e asla yazmaz; yürütme simüledir. |

## Çalıştırma

```bash
npm install
npm test                         # birim + saldırı senaryoları
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
