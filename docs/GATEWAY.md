# Gateway, executor and OKX

How the enforcement path (L3–L6) behaves, how it connects to OKX, and what is verified. Architecture:
[`SONPLAN.md`](../SONPLAN.md). Claims and their evidence: [`CLAIMS.md`](CLAIMS.md).

## Status

| Area | Status | Evidence |
|---|---|---|
| EIP-712 domain `LeashAgent`, `la` clOrdId prefix | ✅ | `LEASH_DOMAIN`, `deriveClOrdId` in `@leashagent/shared` |
| PolicyRegistry verification on Fuji | ✅ | `PolicyLoader` → `loadVerifiedPolicy` (verified cache, fail closed); `npm run gateway:fuji` |
| Executor re-checks the chain before every write | ✅ | `createChainPolicyStateProvider`; pause race → `REVOKED`, 0 writes |
| OKX risk data and order ownership (read key) | ✅ code, run against a real OKX account | `OkxRiskProvider`, `OkxOrderOwnershipVerifier` via ATK |
| OKX writes (trade key, executor only) | ✅ code, run against a real OKX account | `OkxAtkClient` + `McpStdioTransport`; `npm run e2e:okx-demo` |
| Market buy | ❌ disabled | L3 gate; enable (`MARKET_BUY_ENABLED=1`) only after the market-order spike (S5) |
| x402 `POST /v1/credits` | ✅ | `HttpOptions.credits` + `delegationResolver`; `tests/integration/credits-http.test.ts` |
| Chain evidence on Fuji | ✅ live | `ChainOutbox` → `DecisionLog` in `scripts/lib/fujiGateway.ts` |
| Human approval re-runs everything on fresh state | ✅ | fresh chain verification, auditor re-run, new reservation and credit |
| Over-limit → `BLOCKED 103`, timeout → `UNKNOWN` without resend, replay → no second write | ✅ | `tests/invariants`, `tests/attacks` |
| BLOCK / PENDING consume no credit | ✅ | `tests/integration/web3-wiring.test.ts`, `credits-http.test.ts` |
| Acceptance suite against the real gateway | ✅ | `npm run gateway:dev` + `npm run test:acceptance` (also part of `npm run gate`) |

Remaining live checks: the market-order spike (only if market orders are ever needed) and a scripted run on an OKX
demo account (`OKX_MODE=atk npm run e2e:okx-demo`).

## Running against OKX

```bash
# Market-order spike (only needed before enabling market buys): Read+Trade key, NO withdraw
OKX_TRADE_KEY=… OKX_TRADE_SECRET=… OKX_TRADE_PASSPHRASE=… OKX_PROFILE=demo OKX_SITE=global \
  npm run spike:atk -- --yes-place-demo-orders

# Limit-order E2E through the real gateway and executor on an OKX demo account
OKX_MODE=atk npm run e2e:okx-demo

# Fuji + real OKX (demo): .env as for gateway:fuji, plus
OKX_MODE=atk OKX_READ_KEY=… OKX_READ_SECRET=… OKX_READ_PASSPHRASE=… \
OKX_TRADE_KEY=… OKX_TRADE_SECRET=… OKX_TRADE_PASSPHRASE=… OKX_PROFILE=demo npm run gateway:fuji
```

The Fuji demo policy's `accountRef` must be `keccak256(okx account identifier)` of the account that owns both keys.
ATK details and the spike's findings: [`okx-atk-spike.md`](okx-atk-spike.md).

## Behaviour

- **Policy cache:**
  - A verified policy is served from cache without RPC for `POLICY_CACHE_TTL_SEC`.
  - When the chain or `policyURI` is unreachable, the cache is used only within that TTL; past it, the gateway fails
    closed.
  - Hash, schema, binding or delegation mismatches are never covered by the cache.
  - Revocation marks the cached delegation inactive.
  - An on-chain pause arrives immediately via `watchPause`; the executor re-reads PolicyRegistry before **every** write.
- **Human approval** is a re-evaluation, not "execute". Each approval re-verifies the policy on chain, re-reads market
  and risk state, re-derives fields, re-runs the rules and the auditor (block verdicts 201/202/203 block,
  unavailability 302 stays PENDING), checks credit and makes a new risk reservation. Only "ask human" (301) and the
  escalation threshold (303) are satisfied by the approval itself.
- **Daily PnL:** `totalEq` now − `totalEq` at UTC day start. The baseline is persisted (`equity_baseline`), so it
  survives restarts; fees and unrealized PnL are included. Caveats: a deposit or transfer during the day moves it, and
  USD is treated as ≈ USDT (§19.7).
- **Available sell:** `cashBal − Σ remaining open sells − active sell reservations`. Agent-provided balances are never used.
- **Retries:** an authenticated retry is answered from stored state before the `issuedAt` / nonce check (§25.5).
- **Authorization order:** the authorization is signed, then the credit is consumed, then the result is persisted.
- **Rate rule:** rule 105 counts the current request.
- **Executor:** emits only `isExecTransitionAllowed` transitions; a cancel is `submitted → cancelled`. Uncertain ATK
  outcomes (network, 5xx, `50004`, timeouts) → `UNKNOWN`, never resent; reconciliation queries by `clOrdId`.
- **Executor re-check:** the executor refuses when PolicyRegistry cannot be read (fail closed, §6.6 step 5).
- **Pause:** an owner-signed dashboard pause takes effect in the gateway at once and is also enforced at dispatch; the
  executor itself only sees the on-chain pause (`PolicyRegistry.setPaused`), so an authorization already handed to a
  remote executor is stopped by the on-chain pause.
- **Delegation rotation:** `setDelegation` does not bump the policy version; revocation is caught (`revoked`). A stricter
  executor could also compare `agentAuthAddress`. Bounded by the 30 s authorization TTL.
- **Chain evidence:** Avalanche stores Leash Agent's decision and executor-reported execution evidence; **it does not
  prove OKX fills.**

## Mocks and their real counterparts

| Mock (tests, local runs) | Real module | Status |
|---|---|---|
| `MockPayment` | `CreditStore` (`@leashagent/payments`) | done |
| executor `PolicyStateProvider` | `createChainPolicyStateProvider` | done |
| policy chain + document | `createPolicyChainClient` + `loadVerifiedPolicy` | done |
| local chain queue | `ChainOutbox` + `createDecisionLogPort` | done, live on Fuji |
| `/v1/credits` | `purchaseCredits` via `HttpOptions.credits` | done |
| `MockRiskProvider`, `MockOrderOwnership` | `OkxRiskProvider`, `OkxOrderOwnershipVerifier` | done (`OKX_MODE=atk`) |
| `MockMarketData` | `OkxPublicMarketData` | done |
| `FakeAtkClient` | `OkxAtkClient` + `McpStdioTransport` | done (`OKX_MODE=atk`) |
| `MockAuditor` | `@leashagent/auditor` (`AUDITOR_PROVIDER=jev\|llm\|heuristic`) | heuristic fallback by default |

## Commands

```bash
npm run gateway:dev       # real gateway/executor, mocked chain/OKX/credits; prints LEASH_* exports for the acceptance suite
npm run gateway:fuji      # Fuji PolicyRegistry + DecisionLog, OKX faked; OKX_MODE=atk for real OKX
npm run e2e:okx-demo      # limit-order E2E on an OKX demo account (dry run without keys)
npm run spike:atk         # market-order spike
npm run gate              # full regression gate
```

Windows: `npm install --no-save @rollup/rollup-win32-x64-msvc @esbuild/win32-x64` (the macOS lockfile lacks them).
