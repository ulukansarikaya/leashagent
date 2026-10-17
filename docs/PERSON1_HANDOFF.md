# Person 1 — Security Core + OKX Execution: Handoff

Tracks `LEASH_AGENT_GOREV1_FINAL_INTEGRATION_CHECKLIST.md`. Person 1's code is on `main` (merge `f20f3c0`,
Fuji wiring `d99b1f7` by Person 3). This branch (`gorev1-final`) adds the remaining checklist items on top of
current `main`.

## Merge gate

| Gate | Status | Evidence |
|---|---|---|
| Synced with latest main | ✅ | branched from `1c694d1` |
| No old-name references in active code | ✅ | the checklist's old-name `git grep` → no matches |
| LeashAgent EIP-712 domain / `la` clOrdId | ✅ | canonical `LEASH_DOMAIN`, `deriveClOrdId` |
| Canonical shared preserved | ✅ | this branch changes nothing in `packages/shared` (108 and `normalizeOrder` are already on main) |
| Fuji PolicyRegistry wiring | ✅ | `PolicyLoader` now verifies through `loadVerifiedPolicy` (verified cache, fail closed); `npm run gateway:fuji` |
| Executor chain state re-check | ✅ | `createChainPolicyStateProvider`; pause race → REVOKED, 0 writes |
| Real OKX RiskProvider | ✅ code / ⏳ live | `@leashagent/atk` `OkxRiskProvider` (read-only ATK), `OKX_MODE=atk npm run gateway:fuji` |
| Real OrderOwnershipVerifier | ✅ code / ⏳ live | `OkxOrderOwnershipVerifier` (`spot_get_order`, read key) |
| OKX demo spike | ❌ **not run** | needs demo API keys: `npm run spike:atk -- --yes-place-demo-orders` |
| Market BUY verified or disabled | ✅ disabled | L3 gate; `MARKET_BUY_ENABLED=1` only after spike S5 |
| x402 `/v1/credits` | ✅ (Person 3) | `HttpOptions.credits` + `delegationResolver`; `tests/integration/credits-http.test.ts` |
| Chain evidence on Fuji | ✅ (Person 3, verified live) | `ChainOutbox` → DecisionLog in `scripts/lib/fujiGateway.ts` |
| Human approval fresh re-run | ✅ | fresh chain verification, auditor re-run, new reservation and credit |
| Reason 108 canonical | ✅ | `ReasonCodes.SELL_INVENTORY` in shared; no gateway-local alias |
| Over-limit → BLOCKED 103 → 0 writes | ✅ | `tests/invariants/merge-checklist.test.ts` |
| Timeout → UNKNOWN → no resend | ✅ | executor, e2e and acceptance tests |
| Replay → 0 second write | ✅ | executor + invariants |
| Pause race → REVOKED → 0 writes | ✅ | e2e + `person3-wiring` |
| BLOCK/PENDING → 0 credit burn | ✅ | `person3-wiring` + `credits-http` |
| Full test suite green | ✅ | see the commit message for counts |
| Person 2 acceptance vs real gateway | ✅ | `npm run gateway:dev` + `npm run test:acceptance` |
| Solidity tests | ⏳ | `forge` not installed here; CI (`.github/workflows/ci.yml`) runs them |

**Verdict:** the code gates are green. **Remaining live gate:** the OKX demo spike, then one
`OKX_MODE=atk npm run gateway:fuji` run on a demo account.

## Live run

```bash
# 1. OKX demo spike (Read+Trade key, NO withdraw)
OKX_TRADE_KEY=… OKX_TRADE_SECRET=… OKX_TRADE_PASSPHRASE=… OKX_PROFILE=demo OKX_SITE=global \
  npm run spike:atk -- --yes-place-demo-orders

# 2. Fuji + real OKX (demo): .env as for gateway:fuji, plus
OKX_MODE=atk OKX_READ_KEY=… OKX_READ_SECRET=… OKX_READ_PASSPHRASE=… \
OKX_TRADE_KEY=… OKX_TRADE_SECRET=… OKX_TRADE_PASSPHRASE=… OKX_PROFILE=demo npm run gateway:fuji
```

The Fuji demo policy's `accountRef` must be `keccak256(okx account identifier)` of the account that owns both keys.

## Behaviour decisions (review)

- **Policy cache:**
  - A verified policy is served from cache without RPC for `POLICY_CACHE_TTL_SEC`.
  - When the chain or policyURI is unreachable, the cache is used only within that TTL; past it, the gateway fails closed.
  - Hash, schema, binding or delegation mismatches are never covered by the cache.
  - Revocation marks the cached delegation inactive.
  - On-chain pause arrives immediately via `watchPause`. L6 re-reads PolicyRegistry before **every** write.
- **Human approval:** a re-evaluation, not "execute". Each approval:
  - re-verifies the policy on chain (fresh);
  - re-reads market and risk state, re-derives fields and re-runs the rules;
  - **re-runs the auditor**: block verdicts (201/202/203) block and unavailability (302) stays PENDING;
  - checks credit and makes a new risk reservation.

  Only "ask human" (301) and the escalation threshold (303) are satisfied by the approval itself.
- **Daily PnL:** computed as `totalEq` now − `totalEq` at UTC day start. The baseline is persisted (`equity_baseline`), so it survives restarts, and fees and unrealized PnL are included. **Caveats:** a deposit or transfer during the day moves it, and USD is treated as ≈ USDT (§19.7).
- **Available sell:** `cashBal − Σ remaining open sells − active sell reservations`. Agent-provided balances are never used.
- **Retries:** an authenticated retry is answered from stored state before the `issuedAt`/nonce check (§25.5).
- **Authorization order:** the authorization is signed, then the credit is consumed, then the result is persisted.
- **Rate rule:** rule 105 counts the current request.
- **Executor:** emits only `isExecTransitionAllowed` transitions; a cancel is `submitted → cancelled`. Uncertain ATK outcomes (network, 5xx, `50004`, timeouts) → `UNKNOWN`, never resent.
- **Executor recheck:** L6 refuses when PolicyRegistry cannot be read. This is fail-closed, per §6.6 step 5.
- **Local pause:** a local (dashboard) pause is also enforced at dispatch.
- **Chain evidence:** the claim is that Avalanche stores Leash Agent's recorded decision/execution evidence; **it does not prove OKX fills.**

## Mock → real mapping

| Person 1 mock | Real module | Status |
|---|---|---|
| `MockPayment` | `CreditStore` | done |
| L6 `PolicyStateProvider` | `createChainPolicyStateProvider` | done |
| policy chain + document | `createPolicyChainClient` + `loadVerifiedPolicy` | done |
| local chain queue | `ChainOutbox` + `createDecisionLogPort` | done (Person 3, live on Fuji) |
| `/v1/credits` | `purchaseCredits` via `HttpOptions.credits` | done (Person 3) |
| `MockRiskProvider`, `MockOrderOwnership` | `OkxRiskProvider`, `OkxOrderOwnershipVerifier` | code done, `OKX_MODE=atk`; live run pending |
| `MockMarketData` | `OkxPublicMarketData` | code done, `OKX_MODE=atk` |
| `FakeAtkClient` | `OkxAtkClient` + `McpStdioTransport` | code done; live run awaits the spike |
| `MockAuditor` | `@leashagent/auditor` | `HeuristicAuditor` in `gateway:dev` / `gateway:fuji` |

## P2 / roadmap

- Live Jev integration (`AUDITOR_PROVIDER=jev`). The gateway treats the auditor as defense in depth only.
- Gateway ⇄ executor process isolation with mutual auth. `OKX_TRADE_*` only reaches the executor's ATK child today.
- TEE: roadmap only.

## Commands

```bash
npm test
npm run gateway:dev                    # real gateway/executor, mocked chain/OKX/credits; prints LEASH_* exports
npm run gateway:fuji                   # Fuji (Person 3) + fake OKX; OKX_MODE=atk for real OKX
npm run spike:atk                      # OKX demo spike
```

Windows: `npm install --no-save @rollup/rollup-win32-x64-msvc @esbuild/win32-x64` (the macOS lockfile lacks them).
