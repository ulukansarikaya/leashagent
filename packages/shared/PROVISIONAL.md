# packages/shared — PROVISIONAL

Bu paket Görev 2'nin (agent / ingest / auditor / dashboard) Kişi 1/3'ün dondurduğu
canonical `packages/shared` gelene kadar derlenebilmesi için SONPLAN.md §5'ten kopyalandı.
**Kaynak doğrusu değildir.** Final merge'de bu dosyalar silinir ve Görev 2 doğrudan
canonical paketi import eder; Görev 2'de alternatif/duplicate tip tanımı kalmaz.

| Bu kopyada | Canonical karşılığıyla birebir eşitlenecek |
|---|---|
| `types.ts` | `SignedIntentRequest`, `OrderIntent`, `OrderStatus`, `ReadRequest`, `ReadSummary`, `IntentResponse`, `SignedApproval`, `SignedPauseCommand`, `AuditEvent`, `AuditorInput/Output` |
| `eip712.ts` | domain `{name:"Bekci",version:"1",chainId:43113}`, `AgentIntent`, `ApprovalDecision`, `PauseCommand`; `AgentRead` yalnızca öneri (planda alan listesi yok) |
| `identity.ts` | `policyId = keccak256(abi.encode(owner, accountRef, agentRegistry, agentRegistryId))`, `accountRef`, `agentId` türetimi (format henüz dondurulmadı) |
| `reasons.ts` | §12 reason code'ları; `REJECTED_PAYMENT = 004`, `002` yalnızca yetki |
| `schemas.ts` | zod `strict` şemaları |
| `canonical.ts`, `decimal.ts` | `canonicalJson`, `hashCanonical`, `dec` |

Geçiş adımları:
1. Canonical paket geldiğinde `packages/shared/src/*` silinir, `@bekci/shared` canonical pakete işaret eder.
2. `npm run typecheck && npm test` — derleme hataları Görev 2'nin uyum noktalarıdır; tip **Görev 2 tarafında** düzeltilir.
3. `tests/acceptance` gerçek gateway'e karşı çalıştırılır (README).
