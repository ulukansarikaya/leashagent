# Person 1 — Security Core + OKX Execution: Handoff

Status: integrated onto `main` with the frozen `@leashagent/shared`. Tested locally: the full suite passes
(Person 1 + Person 2 + Person 3 tests), and **Person 2's acceptance suite passes against the real
gateway** (`npm run gateway:dev`). The OKX demo spike has **not been run yet**, because it needs demo API keys.

## What is in the repo

| Package | Layer | Notes |
|---|---|---|
| `packages/gateway` | L3, L4, L5, L7 server side | see README table; composition root `createGateway()` in `src/app.ts` |
| `packages/executor` | L6 | own SQLite DB (`orders`, `executor_nonces`, `execution_events`); `OKX_TRADE_*` only here |
| `packages/atk` | L6 adapter | ATK over MCP stdio / CLI; findings in `docs/okx-atk-spike.md` |
| `packages/mocks` | test/demo | stand-ins for chain, OKX account/market, credits, auditor, exchange (`FakeAtkClient`) |
| `scripts/dev-gateway.ts` | demo | real gateway + executor + Person 2 auditor/ingest; chain, OKX and credits are mocked |
| `scripts/atk-spike.ts` | P0 spike | places minimum-size orders on an OKX **demo** account; refuses a live profile |
| `tests/invariants`, `tests/attacks`, `tests/integration` | | INV-1…16, the §26.1 acceptance suite over HTTP, executor⇄ATK, and wiring to Person 3's modules |

## Changes to shared code (please review — §25.7)

| Change | Why | Kind |
|---|---|---|
| `shared/src/normalize.ts`: `normalizeOrder`, `NormalizationError` | Requested in PERSON3_HANDOFF item 7. Built only on existing shared helpers (`dec`, `deriveClOrdId`) | Additive |
| `tests/acceptance`: the "forbidden tool" case now **signs** the `withdraw` intent | It used to swap the intent after signing. §6.3 checks the signature (step 4) before the tool (step 6), so the real gateway correctly answered `REJECTED_AUTH`. Signature tampering already has its own test | Test fix (Person 2) |

Nothing in `shared` was renamed or redefined. Person 1 code imports from `@leashagent/shared` only.

## Proposals that need agreement (not in shared yet)

1. **Reason code `108`: sell exceeds available inventory.** §6.4 assigns `REJECTED_POLICY` but no code. It lives in `gateway/src/limits.ts` as `SELL_INVENTORY_REASON` until agreed.
2. **`PaymentEntitlement.refundConsumedCredit`.** The gateway calls it from `CreditReconciler` only when an issued authorization provably never reached the executor (`executor_nonces` absent after expiry plus a grace period). `CreditStore` already implements it, and the wiring test covers it.

## Decisions made in Person 1 code

- **Retries:** an authenticated retry with the same `(policyId, requestId)` is answered from stored state **before** the `issuedAt`/nonce check (§25.5).
- **Human approval:** it re-runs every deterministic rule, a new risk reservation and credit. The auditor and the threshold gates are not re-run, because the approval *is* the answer to 301/302/303.
- **Authorization order:** the authorization is signed first, then the credit is consumed, then the result is persisted. A failure before persisting leaves no usable authorization.
- **Rate rule:** L3 records the rate event before L4 runs, so rule 105 is `count(including this request) > max`.
- **Executor recheck:** L6 refuses when PolicyRegistry cannot be read. A chain RPC outage therefore halts execution even while L4 still has a valid cache. This is fail-closed, per §6.6 step 5.
- **Event transitions:** L6 emits only transitions allowed by `isExecTransitionAllowed`. A cancel request emits `submitted → cancelled`.
- **Local pause:** a local (dashboard) pause is also enforced at dispatch, because the executor only sees the on-chain pause.
- **Market buy:** it stays **disabled** in L3 (`marketBuyEnabled: false`) until spike step S5 passes (§25.6).

## Mock → real mapping (wiring still to do)

| Person 1 mock | Real module | Status |
|---|---|---|
| `MockPayment` | `@leashagent/payments` `CreditStore` | **verified** in `tests/integration/person3-wiring.test.ts` |
| `MockPolicyChain` as L6 `PolicyStateProvider` | `@leashagent/chain` `createChainPolicyStateProvider` | **verified** in the wiring test and the acceptance harness |
| `MockPolicyChain` as `PolicyChainClient` + docs fetcher | `createPolicyChainClient` + fetch of `policyURI` | todo (Fuji deploy pending). `PolicyLoader` could reuse `verifyPolicyDocument` |
| gateway `ChainOutbox` (local insert) | `@leashagent/chain` `ChainOutbox` + `createDecisionLogPort` worker | todo. Same `chain_outbox` table and columns; records already pass `chainRecordSchema` |
| `MockAuditor` | `@leashagent/auditor` (`HeuristicAuditor` / `GenericLlmAuditor` / `JevAuditor`) | `HeuristicAuditor` is used in `gateway:dev` |
| ingest port | `@leashagent/ingest` `DefaultIngestService` | used in `gateway:dev` (recorder → gateway `reads` table) |
| `MockRiskProvider`, `MockOrderOwnership` | OKX read key (balances, open orders, **daily PnL with fees**) | todo (§19.7) |
| `MockMarketData` | `@leashagent/atk` `OkxPublicMarketData` | implemented and unit-tested; not wired in `gateway:dev` |
| `FakeAtkClient` | `@leashagent/atk` `OkxAtkClient` + `McpStdioTransport` | implemented and tested against a fake MCP server; real OKX awaits the spike |
| `POST /v1/credits` | `@leashagent/payments` `purchaseCredits` | todo: mount in `http.ts` |

## Running

```bash
npm install
npm test                                   # everything
npm run gateway:dev                        # prints LEASH_* exports
# in a second shell, paste the exports, then:
npm run test:acceptance                    # Person 2 suite against the real gateway
```

**Windows note:** `package-lock.json` was generated on macOS and lacks the Windows rollup/esbuild
binaries (npm optional-dependency bug). Install them without touching the lock:

```bash
npm install --no-save @rollup/rollup-win32-x64-msvc @esbuild/win32-x64
```
