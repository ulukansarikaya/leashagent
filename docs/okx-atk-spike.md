# OKX / ATK Integration — P0 Spike

Status: **code ready, spike not yet run** (needs OKX demo API keys).
Owner: Person 1 (Security Core + OKX Execution).

## 1. What was researched (October 2026)

Source: the official [okx/agent-trade-kit](https://github.com/okx/agent-trade-kit) repository (README, `docs/configuration.md`,
`docs/cli-reference.md`, `docs/modules/spot.md`, `packages/core/src/config.ts`, `packages/core/src/client/rest-client.ts`,
`packages/core/src/tools/spot-trade.ts`, `packages/core/src/utils/errors.ts`, `packages/mcp/src/server.ts`, `packages/cli/src/index.ts`).

| Topic | Finding | Effect on Bekçi |
|---|---|---|
| Packages | `npm i -g @okx_ai/okx-trade-mcp @okx_ai/okx-trade-cli` (Node ≥ 18) | Executor host needs one of them on `PATH` |
| Credentials | Env vars `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE` **override** `~/.okx/config.toml` | Executor passes `OKX_TRADE_*` to the ATK child **only**, through a minimal env (`buildAtkEnv`) |
| Demo | `OKX_DEMO=1` / `demo = true` / `--demo` → header `x-simulated-trading: 1` | `OKX_PROFILE=demo` maps to `OKX_DEMO=1` |
| Sites | `global` · `eea` · `us` · **`tr` (tr.okx.com)**, via `OKX_SITE` | TR is supported by ATK. **Demo trading on TR is not confirmed** |
| Spot tools (MCP) | `spot_place_order`, `spot_cancel_order`, `spot_get_order`, `spot_get_open_orders` | Used by `OkxAtkClient` |
| `spot_place_order` args | `instId, tdMode(cash), side, ordType, sz, px, tgtCcy, clOrdId` (`clOrdId` max 32, passed unchanged) | We send `tdMode: "cash"`, the derived 32-char `clOrdId`, and `tgtCcy` |
| Market-buy `sz` | Tool description: *"Buy market: quote amount, all others: base amount"*; `tgtCcy`: *"base_ccy(default)"*. These two statements conflict | **We always send `tgtCcy=base_ccy` explicitly.** Spike step S5 decides |
| Confirmation | No prompt in the MCP handler or the CLI write path | Expected to be automatable. Spike step S1/S4 confirms |
| Write retries | REST client never auto-retries POST (comment: writes "must NOT auto-retry"). GET is retried once | Matches INV-9 |
| Timeout | `OKX_TIMEOUT_MS`, default 15 000 ms | Our MCP call timeout is 20–25 s, above ATK's |
| Errors | MCP returns `isError` + `{ type, code, message, … }` with type ∈ `ValidationError, ConfigError, AuthenticationError, RateLimitError, OkxApiError, NetworkError, InternalError` | Classifiable, so **MCP is the primary transport** |
| CLI errors | Plain text on stderr (`Error:`, `Code:`, `Hint:`), exit 1, **no error type** | CLI is a fallback only. Without a numeric `Code:`, a write is "uncertain" |
| Instruments | No MCP tool for instrument metadata (CLI `okx market instruments` only) | Market data reads OKX **public** REST directly, keyless (`OkxPublicMarketData`) |

## 2. What was built

```
packages/atk/                       (new; depends only on @bekci/shared)
  src/types.ts                      AtkTransport, error payload, buildAtkEnv (minimal child env)
  src/classify.ts                   write-outcome classifier — fail-safe: unknown => "uncertain"
  src/mcp-transport.ts              okx-trade-mcp over MCP stdio (primary)
  src/cli-transport.ts              okx CLI --json (fallback)
  src/okx-atk-client.ts             OkxAtkClient: implements the executor's AtkClient
  src/okx-public-market.ts          keyless ticker + instruments (demo header, TR host)
packages/executor/src/okx-env.ts    OKX_TRADE_* / OKX_PROFILE / OKX_SITE -> ATK child env
scripts/atk-spike.ts                the spike (pnpm spike:atk)
```

**Write classification** (`classify.ts`). Only these count as a definite rejection, which releases the reservation:

- `ValidationError`, `ConfigError`: refused before sending.
- `AuthenticationError`, `RateLimitError`.
- `OkxApiError` with a numeric OKX code, **except**:
  - 3-digit HTTP statuses (e.g. 502, 504)
  - `50001`, `50004`, `50013`, `50026`. OKX documents `50004` as *"does not mean that the request was successful or failed"*.
- A per-item `sCode ≠ 0` with a business code.

Everything else (`NetworkError`, `InternalError`, a dead process, a call timeout, an unparseable reply, a missing `ordId`) becomes `AtkUncertainError`. The executor then records `UNKNOWN`, holds the reservation, and never resends.

Tests: `packages/atk/test` (31) runs a **real MCP stdio session** against `fixtures/fake-okx-mcp.mjs`, which returns ATK-shaped payloads, and drives a fake CLI. `tests/integration/executor-atk.test.ts` (8) runs the real executor → OkxAtkClient → MCP stdio path. The tests also check that only `OKX_*` variables reach the child process.

## 3. Running the spike

Requirements:

1. **An OKX demo-trading API key** with Read + Trade permission and **no Withdraw** permission (OKX → Demo trading → API).
2. Node ≥ 18 and `npm i -g @okx_ai/okx-trade-mcp @okx_ai/okx-trade-cli`.
3. Some demo USDT balance (demo accounts come funded).

Run in bash:

```bash
export OKX_TRADE_KEY=... OKX_TRADE_SECRET=... OKX_TRADE_PASSPHRASE=...
export OKX_PROFILE=demo OKX_SITE=global      # try OKX_SITE=tr as a second run
pnpm spike:atk --yes-place-demo-orders                       # MCP transport
pnpm spike:atk --yes-place-demo-orders --transport cli       # CLI fallback
pnpm spike:atk --yes-place-demo-orders --probe-default-tgtccy
```

The script refuses to run without the flag, and it refuses `OKX_PROFILE=live`. It places only minimum-size orders and resting orders at 50% below market, which it cancels. It writes `spike-results/atk-spike-<ts>.json`, with no credentials and git-ignored.

| Step | Question | Decision it drives |
|---|---|---|
| S1 | Spot write tools exposed, no confirmation step | ATK usable programmatically (§19.1) |
| S2/S3 | Instrument + demo ticker on the chosen site | `MarketDataProvider` works; TR demo availability (§19.2) |
| S4 | Market buy `sz=minSz`, `tgtCcy=base_ccy`, 32-char `clOrdId` accepted | `clOrdId` format (§19.3), latency |
| **S5** | Filled amount in **base** units? | **Market-buy freeze gate (§25.6)** |
| S6 | Market sell back in base units | Sell semantics, cleanup |
| S7 | Duplicate `clOrdId` rejected by OKX (expected `51016`) | Exchange-side backstop for INV-8 |
| S8 | 33-char `clOrdId` → *definite* rejection | Classifier code list |
| S9 | Unknown `clOrdId` query → `51603` → `null` | Reconciliation "not found" mapping |
| S10 | (optional) Market buy without `tgtCcy` | OKX default unit, documentation only |

## 4. What to change depending on the result

- **S5 PASS (base units):** keep `normalizeOrder` (`tgtCcy: "base_ccy"` on market orders) and the notional formula `sz × ask × (1 + buffer)`. Then lift the market-buy freeze (§25.6).
- **S5 FAIL (quote units despite `tgtCcy`):** keep market buys disabled. Either:
  - (a) allow only limit/IOC buys, or
  - (b) change `OrderIntent`/`NormalizedOrder` so that market-buy `sz` is quote, set `tgtCcy: "quote_ccy"`, and compute notional = `sz × (1 + buffer)`.

  Change `normalizeOrder`, the rule engine notional and the schemas together (§17, §25.6).
- **S7 accepts a duplicate:** no code change is needed. INV-8 rests on `executor_nonces` + the `dispatching` WAL. Record it as "no exchange-side backstop".
- **S8 classified uncertain:** add that OKX code to the definite set only if OKX documents it as a validation rejection.
- **S2/S3 fail on `OKX_SITE=tr` with demo:** run the demo on `global`. Keep `tr` for live, if required.

## 5. Still not covered

- `RiskProvider` on the OKX read key: balances, open orders, **daily PnL with fees** (§19.7). The mocks stand in for it today.
- The `OrderOwnershipVerifier` real implementation (`spot_get_order` by `ordId` with the read key).
- ATK `tag` field: ATK sets `tag = sourceTag` on orders. This is harmless, but means the tag is not ours to use.
- Mutual authentication on the gateway ⇄ executor channel. Today they run in one process behind `ExecutorPort`.
