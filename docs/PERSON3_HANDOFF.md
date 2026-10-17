# Person 3 — Web3 / Authorization / Payments: Handoff

Status: built, tested (87 TS + 35 Solidity tests) and **deployed to Avalanche Fuji**.

Everything public about the deployment is in **`packages/chain/deployments/fuji.json`** (also exported as
`FUJI_DEPLOYMENT` from `@bekci/chain`); plain ABI JSON for the dashboard is in `packages/chain/deployments/abi/`.

| What | Fuji |
|---|---|
| PolicyRegistry (source verified) | [`0x9d0f1e30aF144074f4A8bE191fd5DB4F1F51f68F`](https://testnet.snowtrace.io/address/0x9d0f1e30aF144074f4A8bE191fd5DB4F1F51f68F) |
| DecisionLog (source verified) | [`0xdC10FdDF2B58aeB674EBE4899A2a5C3276070d96`](https://testnet.snowtrace.io/address/0xdC10FdDF2B58aeB674EBE4899A2a5C3276070d96) |
| DecisionLog LOGGER | `0x62CA5659C4593846570a60A4d92b942863Bf7F8B` |
| ERC-8004 IdentityRegistry (official) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| Bekçi identity | `eip155:43113:0x8004A818BFB912233c491871b3d84c89A494BD9e:266` (card URL is a placeholder until the gateway is hosted) |
| Demo trading-agent identity | `eip155:43113:0x8004A818BFB912233c491871b3d84c89A494BD9e:267` |
| **Demo policy** | `0xf5486eac77e956d3290c78f3cc53afc7828bd806069cf33e1f4fa2a7a4286e50` — owner `0xCD275A6da96e4d4cE6b04025B63315A636fbE91d`, agent key `0x1A125c71553599cfBc874b982DC3511Cf66fF12a`, document in `deployments/policies/` |
| Measured confirmation (public RPC) | setPaused median 4333 ms, logDecision median 3105 ms |

Scripts (all need the local `.env`):
- `scripts/fuji-smoke.ts`: create/verify a policy and write evidence through the outbox.
- `scripts/fuji-publish-identities.ts`: publish identities (idempotent).
  Set `BEKCI_PUBLIC_URL` and call `Erc8004Registry.updateRegistration("266", bekciRegistration({ baseUrl }))` once the gateway has a URL.
- `scripts/fuji-demo-policy.ts`: create/update the demo policy. To delegate to Person 2's agent, put **their agent's
  public address** in `AGENT_AUTH_ADDRESS` and re-run (setDelegation + setPolicy). Never share private keys.
- `scripts/fuji-finality.ts`: re-measure latency.

**Person 1 — PolicyLoader in one call:** `loadVerifiedPolicy(createPolicyChainClient(pub, FUJI_DEPLOYMENT.contracts.PolicyRegistry.address), policyId)`
→ `{ ok, policy, record }` or `{ ok:false, reason }` (⇒ BLOCK 003). `record.paused` is returned, not treated as failure.
For `/v1/credits`, `createPolicyDelegationResolver(client)` is the `delegations` dependency of `purchaseCredits`.

Deployer/logger keys are testnet-only and live in the local, gitignored `.env` of Person 3.

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

## Verified on Avalanche Fuji (2026-10-17)

- **ERC-8004 IdentityRegistry**: `0x8004A818BFB912233c491871b3d84c89A494BD9e` (official erc-8004 deployment, proxy
  "AgentIdentity"). Our ABI subset matches `abis/IdentityRegistry.json`; `npx tsx scripts/erc8004-resolve.ts 5`
  resolves a live agent. Registration cards follow the EIP-8004 `registration-v1` shape (`services`, `x402Support`,
  `active`, `registrations`), Bekçi fields under `bekci`.
- **x402**: PayAI facilitator `https://facilitator.payai.network` lists `avalanche-fuji` (v1, exact). Asset: Circle
  Fuji USDC `0x5425890298aed601595a70AB815c96711a31Bc65` (EIP-3009, "USD Coin" v2, 6 decimals).
  `npx tsx scripts/x402-probe.ts` signs with `createExactPayment` and gets `invalid_exact_evm_insufficient_balance`
  from `/verify` — i.e. our wire format is accepted; only funds are missing.

## Still open

- [x] Fuji deploy of our contracts (`scripts/deploy-fuji.sh`).
- [x] Bekçi + demo trading agent published on the Fuji ERC-8004 registry.
- [ ] Update Bekçi's card with the real gateway URL once Person 1 hosts it.
- [ ] Optional: a real paid x402 settle needs Fuji USDC on the agent wallet (Circle faucet); the demo can keep
      `MockSettlement`.
- [ ] Credits are minted right after settlement in the same process; a crash between settle and mint loses that
      purchase (acceptable for hackathon, note in demo).
- TEE: roadmap only.
