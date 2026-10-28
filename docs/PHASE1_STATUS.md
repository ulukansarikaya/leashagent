# Phase 1 (testnet + OKX demo) — gate status

Each item of the Phase 1 checklist, with what closes it. **Phase 1 is DONE only when
`npm run gate -- --require-live` passes on a clean, pushed `main` commit and CI on that commit is green.**
Claims allowed before/after: [`CLAIMS.md`](CLAIMS.md).

Legend: ✅ verified in code/CI · 🔑 needs credentials (run it, then record the result here) · 👤 manual operator check

## P0 — blockers

| # | Item | Status | How it is closed |
|---|---|---|---|
| 1 | HEAD CI green (typecheck, TS, Forge, ABI/shared consistency, invariants/attacks, acceptance) | ✅ | CI job steps: contracts, ABI up to date, typecheck, tests, **acceptance vs real gateway**, **final attack regression**. Check the run of the final commit on GitHub Actions. |
| 2 | Final gate fails on required live SKIPs | ✅ | `npm run gate -- --require-live` (or `FINAL_GATE=1`): OKX demo, x402 PayAI, Jev, Fuji are required; a missing credential is a FAIL. |
| 3 | OKX demo E2E: BUY, retry → 0 second write, CANCEL, SELL, SELL CANCEL, lost reply → UNKNOWN → reconcile, no resend, 1 write per placement | 🔑 | `OKX_MODE=atk npm run e2e:okx-demo` (dry run passes in CI/gate). |
| 4 | SELL must really pass | 🔑 + ✅ strict mode | Fund the demo account with BTC; `OKX_E2E_REQUIRE_SELL=1` (automatic in the final gate) makes a missing balance a FAIL. |
| 5 | Real x402 via PayAI / Fuji USDC | 🔑 | `X402_MODE=payai X402_AGENT_KEY=0x… npm run e2e:x402` (mock settlement passes). |
| 6 | Real Jev endpoint smoke | 🔑 | `JEV_ENDPOINT=… npm run smoke:jev`: schema, scores, reachable → no 302, rule BLOCK not sent to Jev, timeout/HTTP failure → 302. Invalid JSON/schema → 302 is covered offline by `tests/integration/jev-auditor.test.ts`. |
| 7 | Final Fuji E2E (policy read + hash + delegation + pause, credits, ALLOW, BLOCK, DecisionLog + execution readback, tx hashes) | 🔑 | `npm run e2e:fuji`; record the decision and execution tx hashes below. |
| 8 | Attack regression on the final commit, exchange writes asserted | ✅ | `tests/attacks/final-regression.test.ts` (8 scenarios: ALLOW = 1 write; oversize BLOCK 103 = 0; injection = 0; approval after state change → BLOCK = 0; pause race → REVOKED = 0; same requestId ×2 → 1 write, 1 credit; lost reply → UNKNOWN → 1 placement; tampered authorized order → 403 = 0). Also `npm run demo:live`. |
| 9 | Secret / history audit (all branches) | ✅ | 41 commits across `main`, `gorev1-final`, `gorev1-integration`, `gorev1-security-core`: no `.env`, no API keys/tokens, no private keys other than public Anvil/Hardhat test keys. Rotation plan: [`CLAIMS.md`](CLAIMS.md) → operator checklist. |

## P1

| # | Item | Status | How it is closed |
|---|---|---|---|
| 10 | OKX key permissions (read = Read; trade = Read + Trade; Withdraw OFF; demo account) | 👤 | Check in the OKX UI; software cannot see key permissions. |
| 11 | Market BUY stays off | ✅ | `MARKET_BUY_ENABLED` unset → L3 rejects market buys; E2E uses limit orders only. |
| 12 | x402 facilitator outage | ✅ | `tests/integration/x402-outage.test.ts`: timeout, HTTP 500, malformed → `502 payment_provider_unavailable`, no credit minted, no authority, gateway keeps serving. |
| 13 | Auditor provider shown truthfully | ✅ | `/v1/health → auditor` and the dashboard pill: `jev (production)` or `heuristic (fallback/demo auditor)`. |
| 14 | Avalanche RPC outage | ✅ | `tests/integration/evidence-outage.test.ts`. |
| 15 | Dashboard on the real stack | ✅ + 👤 | Checked in the browser against the real gateway (pipeline, OKX state, evidence, credits, TEE, named SSE, L6 REVOKED not counted as ALLOW). Wallet approve/pause on Fuji: operator check. |
| 16 | Daily PnL = equity delta since UTC day start | 👤 | Fund the demo account before; no deposits/transfers during the demo. |
| 17 | USD ≈ USDT valuation | — | Known limitation, not a Phase 1 blocker. |
| 18 | Old branches | ✅ checked | `gorev1-final`, `gorev1-integration`: no commits outside `main`. `gorev1-security-core`: one pre-rename snapshot of the gateway, superseded by the merge `f20f3c0`; nothing needed from it. Archive/delete is the owner's decision. Deploy only from a `main` tag. |

## Results to record (final run)

```text
Commit:            (clean main HEAD)
Tag:
CI run:
Final gate:        npm run gate -- --require-live → PASS / FAIL
OKX demo E2E:
x402 PayAI:
Jev smoke:
Fuji decision tx:
Fuji execution tx:
Date:
```
