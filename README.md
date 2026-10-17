# Bekçi

Mimari: `SONPLAN.md`. Bu repo **Kişi 2** (ingest, agent, auditor, dashboard, injection demo, acceptance suite) ve
**Kişi 3** (dondurulmuş `shared`, Avalanche kontratları, zincir istemcisi/outbox, x402, ERC-8004) kapsamlarını içerir.
Kişi 1 (gateway/executor) henüz yok — şimdilik `packages/mock-gateway` test/demo için onun yerini tutuyor.
Kişi 3 entegrasyon notları: [`docs/PERSON3_HANDOFF.md`](docs/PERSON3_HANDOFF.md). TEE roadmap'te.

**Gereksinimler:** Node ≥ 22.13 (24 önerilir; `node:sqlite` kullanılıyor), npm, Foundry (`forge`, `anvil`).

## Paketler

| Paket | Katman | İçerik |
|---|---|---|
| `packages/shared` | — | **Dondurulmuş, tek ortak paket.** §5 tipleri, `canonicalJson`, `policyId`/`agentId`/`clOrdId`/hash yardımcıları, EIP-712 (AgentIntent, AgentRead, ExecutionAuthorization, ApprovalDecision, PauseCommand), strict zod şemaları, `dec`, reason kodları, yürütme geçiş tablosu. Tip yeniden tanımlanmaz; değişiklik üç kişinin onayıyla. |
| `packages/chain` | C / L7 | `PolicyRegistry` + `DecisionLog` (Solidity, Foundry testleri), Fuji deploy scripti, `PolicyChainClient`, `verifyPolicyDocument` (INV-11), L6 için zincir tabanlı `PolicyStateProvider`, kalıcı `ChainOutbox`. |
| `packages/payments` | §21.2 | x402: kalıcı kredi defteri (1 ödeme → 5 kredi, `paymentRef` tek sefer), `purchaseCredits` (`POST /v1/credits`), facilitator + mock adaptör. |
| `packages/identity` | §21.3 | ERC-8004: Bekçi/agent kayıt kartları, yayınlama + keşif. |
| `packages/llm` | — | Araçsız, geçmişsiz tek-çağrı LLM istemcisi. |
| `packages/ingest` | L1 | Fetcher (allowlist/timeout/boyut), sanitizer, reader model, talimat dedektörü, `ReadRecorder`, `DefaultIngestService`. Ham içerik L1'den çıkmaz. |
| `packages/agent` | L2 | Anahtarsız piyasa gözlemcisi, SMA sinyali, LLM/kural reviewer, EIP-712 `IntentBuilder`, egress allowlist'li `BekciClient`. OKX anahtarı görürse ya da mock gateway'e bağlanırsa başlamaz. |
| `packages/auditor` | L4 adaptörü | `GenericLlmAuditor`, `JevAuditor` (§19.4 doğrulanmadı), `HeuristicAuditor`. Timeout/şema dışı → `AuditorUnavailable` (→ `PENDING 302`). |
| `packages/dashboard` | L7 UI | Yalnızca HTTP + SSE. `?policyId=0x…` ile açılır. Owner işlemleri cüzdanda EIP-712 ile imzalanır. |
| `packages/mock-gateway` | — | **SADECE TEST/DEMO.** Offline demo, unit/integration test, injection demo ve acceptance suite'in kendini doğrulaması için. OKX'e yazmaz; hiçbir üretim paketi ona bağımlı değildir (testle zorlanır). |

## Kimlik bağlama (§25.1)

`policyId = keccak256(abi.encode(owner, accountRef, agentRegistry, agentRegistryId))`
— `packages/shared/src/ids.ts` (`computePolicyId`, Solidity ile aynı test vektörü). Görev 2 başka bir formül üretmez; mock gateway de policy'yi
bu formülden türetir ve tutarsız binding ile başlamaz. Yetki `agentAuthAddress` + EIP-712 delegasyonundan gelir;
ERC-8004 kimliği tek başına yetki vermez. `agentId` biçimi dondu: `eip155:<chainId>:<checksumluRegistry>:<id>`
(`formatAgentId`, `agentIdMatchesBinding`, `bindingIsConsistent`).

## Çalıştırma

```bash
npm install
npm test                         # tüm TS testleri: unit + acceptance (mock'a karşı) + zincir e2e (anvil varsa)
npm run test:contracts           # Solidity testleri (forge)
npm run demo:attack              # offline injection demosu (mock, simüle yürütme)
npm run demo:attack -- --serve   # + dashboard
```

**Gerçek E2E demo** — agent ve dashboard Kişi 1'in gateway'ine bağlanır:

```bash
BEKCI_URL=https://<gateway> AGENT_AUTH_KEY=0x… BEKCI_POLICY_ID=0x… AGENT_ID=… npm run agent
# dashboard: gateway'in sunduğu adreste ?policyId=0x…
```

İsteğe bağlı LLM'ler: `AGENT_LLM_API_KEY`, `READER_MODEL_API_KEY`, `AUDITOR_API_KEY` (+ `*_MODEL`);
`AUDITOR_PROVIDER=jev|llm|heuristic` (`jev` için `JEV_ENDPOINT`).

## Acceptance suite (`tests/acceptance`)

Testler gateway ile yalnızca HTTP üzerinden konuşur; aynı suite mock'a ve gerçek gateway'e karşı çalışır:

```bash
BEKCI_GATEWAY_URL=https://<gateway> BEKCI_AGENT_KEY=0x… BEKCI_OWNER_KEY=0x… \
BEKCI_POLICY_ID=0x… BEKCI_AGENT_ID=… BEKCI_TEST_ESCALATE_SZ=… npm run test:acceptance
```

Gerçek gateway'de OKX **demo** hesabına bid fiyatında küçük limit emirler gönderilir. İsteğe bağlı:
`BEKCI_TEST_INST`, `BEKCI_TEST_PX`, `BEKCI_TEST_SMALL_SZ`, `BEKCI_TEST_OVERLIMIT_SZ`.

| Senaryo | Beklenen |
|---|---|
| policyId binding | `computePolicyId(policy.binding) == policyId` |
| izinli emir / aynı requestId tekrar | yetkilendirilir, tam bir kez `authorization_issued` |
| yanlış imzacı, intent/agentReason değişikliği, nonce replay, eski `issuedAt` | `REJECTED_AUTH` |
| yasak araç, fazladan alan, market buy (§25.6) | `REJECTED_SCHEMA` |
| tek emir limiti üstü geçerli limit emir | `BLOCKED 103` |
| kredi yok (mock) | `REJECTED_PAYMENT 004` |
| owner pause / owner olmayan pause | `BLOCKED 100` / reddedilir |
| eşik üstü → onay; yanlış imzacı; red | `PENDING 303` → yetkilendirilir; `PENDING` kalır; `REJECTED_BY_HUMAN` |
| bekleme sırasında pause / fiyat değişimi (mock) sonra onay | `BLOCKED 100` / `BLOCKED 107` |
| enjeksiyon gerekçeli emir; zehirli kaynak (mock) | yürütmeye ulaşmaz / `BLOCKED 201` |
| audit olay akışı | kırılmamış hash zinciri |

"(mock)" işaretli testler mock'un durum kontrolüne ihtiyaç duyar ve gerçek gateway'de atlanır.
Gerçek auditor'ın kararına bağlı yerlerde kesin kod yerine "yürütmeye ulaşmaz" doğrulanır.

## İnsan onayı (§4.4)

Onay yalnızca devam izni verir. `SignedApproval` → taze policy doğrulama → taze piyasa/risk durumu → türetilmiş alanlar
→ deterministik kurallar → gerekiyorsa auditor → yeni risk rezervasyonu → kredi → yetki → executor → OKX → reconciliation.
Eski snapshot/rezervasyon kullanılmaz; durum değiştiyse sonuç `BLOCKED`/`PENDING` olabilir. Onay yanıtı en fazla `ALLOWED`'dır;
fill'ler executor'dan `execution` olayı olarak gelir. Mock bunu rezervasyon/kredi adımları olmadan sadeleştirir;
tam davranış gerçek gateway'e karşı acceptance suite ile doğrulanır.

## Injection demosu (`scripts/injection-demo.ts`)

1. **Korumasız:** agent zehirli haberi ham okur → geçerli `5 BTC limit @65000` emri doğrudan borsaya gider.
2. **Korumalı:** haber L1'den geçer; agent yalnızca bayraklı `ReadSummary` görür, dürüst reviewer geri çekilir.
3. **Agent ele geçirilse bile — ana saldırı:** aynı geçerli, imzalı limit emir → **`BLOCKED 103`** (policy/risk).
   Ek: enjeksiyon gerekçeli küçük emir `BLOCKED 201`, izinsiz enstrüman `BLOCKED 101`, market buy `REJECTED_SCHEMA`.
4. **Meşru akış:** küçük emir `ALLOWED`; eşik üstü `PENDING 303` → owner onayı → `ALLOWED`; onay beklerken fiyat kayarsa → `BLOCKED 107`.
