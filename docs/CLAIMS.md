# Claims — what we can and cannot say

One source for the README, the dashboard and the pitch. If a sentence is not backed by a row here, do not say it.
Status as of the last regression gate (`npm run gate`). Update this file in the same change as any claim.

## Core claim

> On an account managed by Leash Agent, an order that violates the verified owner policy and increases risk does
> not reach the exchange through Leash Agent — even if the agent's LLM is prompt-injected or fully compromised.

Conditions: no other copy of the OKX trade key exists, every write path goes through the gateway, the software
behaves as specified. Not claimed: no market losses, every attack caught, on-chain proof that every decision was
logged, or proof of OKX fills.

## Can say — with the evidence

| Claim | Evidence | Verified how |
|---|---|---|
| The agent never holds an exchange key | Agent refuses to start with any `OKX_*KEY/SECRET/PASSPHRASE`; launcher passes an allow-listed env | `tests/integration/agent-live.test.ts`, `tests/invariants` (INV-1) |
| A blocked, revoked or rejected order makes **0** exchange writes | Exchange write counter asserted per scenario | `npm run demo:live`, `tests/attacks`, `tests/invariants` |
| Oversize / out-of-policy signed orders are blocked (e.g. `BLOCK 103`) | Deterministic rules before any auditor | `npm run demo:live`, acceptance suite |
| The auditor can only block or escalate; it never overrides a rule BLOCK | Rule violation → auditor not called; auditor errors → `PENDING 302` | `tests/integration/jev-auditor.test.ts`, INV-5 |
| Owner approval re-runs every check on fresh state; it is not a bypass | Price moves while pending → approve → `BLOCK 107` | `npm run demo:live`, INV-6 |
| An on-chain pause stops an already-authorized order at the executor | Pause lands between ALLOW and L6 → `REVOKED`, 0 writes | `npm run demo:live`, `tests/invariants/e2e-execution.test.ts` |
| Replay, tampering and impersonation are rejected | `REJECTED_AUTH`, existing state returned for a retried request | acceptance suite, `tests/attacks` |
| One request ⇒ at most one exchange write; timeouts are reconciled, never resent | `UNKNOWN` → reconcile by `clOrdId` | INV-8/9, `npm run e2e:okx-demo` (dry run here; live needs keys) |
| x402: payment buys service credits, never authority; ALLOW consumes one, BLOCK/PENDING none, replay mints nothing | Credit ledger + `POST /v1/credits` | `npm run e2e:x402` (mock settlement), `tests/integration/credits-*.test.ts` |
| Policy, delegation and pause live on Avalanche Fuji; decisions and execution events are logged to `DecisionLog` | Source-verified contracts on Fuji, example tx | README "Live deployment", `npm run e2e:fuji` |
| A chain RPC outage never changes or delays a trading decision | Evidence waits in a durable outbox | `tests/integration/evidence-outage.test.ts` (INV-15) |
| TEE: the TDX implementation is ready and was verified against a real Intel TDX quote | DCAP + RTMR3 replay + compose-hash, offline sample quote in tests | `packages/attestation/test`, `docs/TEE.md` |
| Run end to end against a real OKX account with limit orders | Team run with the real ATK path | Team run (Fuji + OKX), not reproduced by `npm run gate` without keys |

## Must not say (yet)

| Do not say | Say instead | Until |
|---|---|---|
| "Runs in a TEE" / "production TEE" / "hardware-protected" | "TEE (Intel TDX) implementation ready; real quote verification tested" | A live Phala TDX deployment with an allow-listed measurement |
| "The OKX trade key is in the TEE" | "The trade key stays outside the TD in TEE Lite" | Full TEE enforcement milestone |
| "Avalanche proves the trade was filled" | "Avalanche holds hashes of our decisions and the executor-reported execution events" | Never (OKX fills are not on-chain) |
| "AI auditor (Jev) protects every trade" | "An independent auditor can only tighten decisions; the demo runs a rule-based fallback auditor" | Jev endpoint wired (`AUDITOR_PROVIDER=jev`) and run |
| "Real USDC payments" | "x402 with mock settlement; the real PayAI/Fuji USDC path is implemented" | `X402_MODE=payai npm run e2e:x402` passes with a funded wallet |
| "Market orders supported" | "Limit orders; market buys are disabled" | OKX market-order unit semantics verified |
| "Verified on a live OKX demo account" (as a reproducible claim) | "Team run against a real OKX account; scripted demo E2E ready" | `OKX_MODE=atk npm run e2e:okx-demo` passes |
| "The OKX key cannot withdraw" (as a system guarantee) | "The trade key must be created without withdrawal permission" | Operator checks the key's permissions in OKX (the software cannot see them) |

## Operator checklist (security)

- OKX trade key: Read + Trade only, **no Withdraw**; read key: Read only. Demo account for the demo.
- `.env` is git-ignored and never committed (history audited: no keys, no `.env`).
- The agent process gets no exchange key (enforced and tested).
- Rotate every key used in the demo afterwards: OKX keys, `LOGGER_PRIVATE_KEY`, agent and owner keys, the GitHub token.
