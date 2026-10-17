# Person 3 — Web3 / Authorization / Payments: Handoff

Status: built and tested locally (51 TS tests, 35 Solidity tests, real Anvil chain). **Not yet deployed to Fuji.**

## Setup

```bash
pnpm install
pnpm test                      # all TS tests (Anvil e2e runs if ~/.foundry/bin/anvil exists)
cd packages/chain && forge test
```

Requires **Node ≥ 22.13 (we use 24)** — the outbox and credit ledger use built-in `node:sqlite`, no native modules.

## Freeze checkpoint — Person 1 please review (§26.1 step 1)

Everything public is in `packages/shared` and must be imported from there, never redefined.

| What | Where | Note |
|---|---|---|
| All §5 DTOs + enums | `shared/src/types.ts` | `EXEC_STATUSES` / `CHAIN_VERDICTS` array index = Solidity enum value |
| Reason codes | `shared/src/reasonCodes.ts` | `004` = payment, `002` never payment |
| `canonicalJson`, `hashCanonical` | `shared/src/canonical.ts` | floats/bigint throw; `undefined` props omitted |
| `computePolicyId`, `computeAccountRef`, `requestIdToBytes32`, `deriveClOrdId`, `computeIntentHash`, `computeReasonHash`, `computeEvidenceHash` | `shared/src/ids.ts` | `policyId` test vector in `shared/test-vectors.json`, asserted in both TS and Solidity |
| EIP-712 domain/types, sign/verify for AgentIntent, ExecutionAuthorization, ApprovalDecision, PauseCommand; `computeAuthHash` | `shared/src/eip712.ts` | `verify*` returns false (never throws) |
| `dec()` exact decimal math | `shared/src/dec.ts` | `floorToStep` for lot/tick, `addBps` for slippage buffer |
| Strict zod schemas | `shared/src/schemas.ts` | `schemas.signedIntentRequest` = L3 step 7 |
| Execution transition table | `shared/src/execTransitions.ts` | mirrors `DecisionLog` — check before emitting an `ExecutionEvent` |

### Decisions I made that need agreement

1. **`evidenceHash` excludes `auditorOutput.raw`** — raw provider JSON may hold floats that `canonicalJson` rejects.
2. **`clOrdId` concatenation** = `policyId` bytes ‖ UTF-8 `requestId` bytes → `"bk" + 30 hex chars` (32 chars total).
3. **`agentId` format** = `eip155:<chainId>:<checksummedRegistry>:<id>`; use `formatAgentId` / `agentIdMatchesBinding` / `bindingIsConsistent` from `@bekci/shared` in L3 step 3.
4. **EIP-712 field types**: nonces are `bytes16`, times `uint64`, `tool`/`basis`/`decision` are `string`.
5. **`chain_outbox` gets 3 extra columns** (`state`, `next_attempt_at`, `confirmed_at`). DDL lives in `@bekci/chain` (`migrateChainOutbox`).
6. **DecisionLog decision transitions**: none → Allow|Block|Pending; Pending → HumanApproved|HumanRejected|Block (EXPIRED is logged as Block).
7. **`normalizeOrder` is NOT in shared yet** — Person 1 owns normalization; add it to shared once written.

## What Person 1 wires in (gateway / executor)

```ts
import { createPolicyChainClient, verifyPolicyDocument, delegationActive,
         createChainPolicyStateProvider, ChainOutbox, createDecisionLogPort } from "@bekci/chain";
import { CreditStore, purchaseCredits, FacilitatorSettlement, MockSettlement } from "@bekci/payments";
import { agentIdMatchesBinding } from "@bekci/identity";
```

- **PolicyLoader (L4)**: `client.getPolicy(id)` → fetch JSON from `policyURI` → `verifyPolicyDocument(id, json, record)` (INV-11) → `delegationActive(record, now)`.
- **Pause**: `client.watchPause(id, cb)`.
- **L6 `PolicyStateProvider`**: `createChainPolicyStateProvider(client)` — reads PolicyRegistry directly, never the gateway.
- **Evidence**: `new ChainOutbox(db, createDecisionLogPort({...LOGGER key...}))`, call `outbox.enqueue(record)` in the decision path (local insert only), `outbox.start()` in the background. `outbox.stats()` → dashboard "chain delayed".
- **Credits (§25.3 order)**: `CreditStore` implements `PaymentEntitlement`. Call `reserveCredit` only after `riskIncreasing` is derived; `releaseReservedCredit` on BLOCK/PENDING; `consumeReservedCredit` after risk reservation; `refundConsumedCredit` only from reconciliation when no OKX write happened. Protective cancels never touch credits.
- **`POST /v1/credits`**: mount `purchaseCredits({store, provider, delegations}, {policyId, agentId, paymentHeader: req.headers["x-payment"]})` and return its `status`. `delegations` must come from the *verified* policy.

## What Person 2 uses (agent / dashboard)

- Sign intents: `signAgentIntent(account, req)`. Approvals/pause from the dashboard: `signApproval`, `signPauseCommand` (owner wallet).
- Discovery demo: `new Erc8004Registry({...}).discover("agent-security-gateway")`; payment demo: `encodePaymentHeader(...)` → `POST /v1/credits`.

## Still open (needs real-world verification, §24)

- [ ] **Fuji deploy**: `DEPLOYER_PRIVATE_KEY=… LOGGER_ADDRESS=… forge script script/Deploy.s.sol --rpc-url fuji --broadcast` (needs Fuji AVAX) → set `POLICY_REGISTRY_ADDRESS`, `DECISION_LOG_ADDRESS`.
- [ ] **x402 facilitator** that supports Avalanche Fuji; until then use `MockSettlement` (no funds move — demo only).
- [ ] **ERC-8004 registry address + ABI on Fuji**: `identityRegistryAbi` is the assumed subset; tests run against `MockIdentityRegistry`.
- [ ] Credits are minted right after settlement in the same process; a crash between settle and mint loses that purchase (acceptable for hackathon, note in demo).
- TEE: roadmap only.
