# Avalanche, x402 and ERC-8004

The on-chain policy and evidence layer, service payments and agent discovery. Architecture:
[`SONPLAN.md`](../SONPLAN.md) §7, §21. Claims and their evidence: [`CLAIMS.md`](CLAIMS.md).

## Fuji deployment

Everything public about the deployment is in **`packages/chain/deployments/fuji.json`** (also exported as
`FUJI_DEPLOYMENT` from `@leashagent/chain`); plain ABI JSON is in `packages/chain/deployments/abi/`.

| What | Fuji |
|---|---|
| PolicyRegistry (source verified) | [`0x9d0f1e30aF144074f4A8bE191fd5DB4F1F51f68F`](https://testnet.snowtrace.io/address/0x9d0f1e30aF144074f4A8bE191fd5DB4F1F51f68F) |
| DecisionLog (source verified) | [`0xdC10FdDF2B58aeB674EBE4899A2a5C3276070d96`](https://testnet.snowtrace.io/address/0xdC10FdDF2B58aeB674EBE4899A2a5C3276070d96) |
| DecisionLog LOGGER | `0x62CA5659C4593846570a60A4d92b942863Bf7F8B` |
| ERC-8004 IdentityRegistry (official) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| Leash Agent identity | `eip155:43113:0x8004A818BFB912233c491871b3d84c89A494BD9e:266` (card URL is a placeholder until the gateway is hosted) |
| Demo trading-agent identity | `eip155:43113:0x8004A818BFB912233c491871b3d84c89A494BD9e:267` |
| Demo policy | `0xf5486eac77e956d3290c78f3cc53afc7828bd806069cf33e1f4fa2a7a4286e50` — owner `0xCD275A6da96e4d4cE6b04025B63315A636fbE91d`, agent key `0x1A125c71553599cfBc874b982DC3511Cf66fF12a`, document in `deployments/policies/` |
| Measured confirmation (public RPC) | `setPaused` median 4333 ms, `logDecision` median 3105 ms |

Deployer and logger keys are testnet-only and live in a local, git-ignored `.env`.

## Scripts (need `.env`)

- `scripts/deploy-fuji.sh` — deploy PolicyRegistry and DecisionLog, fund and enable the logger.
- `scripts/fuji-smoke.ts` — create/verify a policy and write evidence through the outbox.
- `scripts/fuji-publish-identities.ts` — sync ERC-8004 identities (publish if missing, update stale cards). Once the
  gateway is hosted: `LEASH_PUBLIC_URL=https://… npx tsx --env-file=.env scripts/fuji-publish-identities.ts`
  (the agentId stays #266).
- `scripts/fuji-demo-policy.ts` — create/update the demo policy. To delegate to another agent key, put that agent's
  **public address** in `AGENT_AUTH_ADDRESS` and re-run (`setDelegation` + `setPolicy`). Never share private keys.
- `scripts/fuji-finality.ts` — re-measure confirmation latency.
- `scripts/fuji-gateway.ts` (`npm run gateway:fuji`) — the real gateway with the Fuji policy, the executor re-check on
  Fuji, DecisionLog evidence and `POST /v1/credits` (`X402_MODE=payai` for the real facilitator).
- `scripts/fuji-e2e.ts` (`npm run e2e:fuji`) — live check: no credits → 402, x402 purchase, an allowed and a blocked
  order, then the Allow/Block verdicts and execution events read back from DecisionLog.

## Wiring into the gateway

```ts
import { createPolicyChainClient, verifyPolicyDocument, delegationActive, loadVerifiedPolicy,
         createChainPolicyStateProvider, ChainOutbox, createDecisionLogPort } from "@leashagent/chain";
import { CreditStore, purchaseCredits, FacilitatorSettlement, MockSettlement } from "@leashagent/payments";
import { agentIdMatchesBinding } from "@leashagent/identity";
```

- **Policy loading (L4):** `loadVerifiedPolicy(createPolicyChainClient(pub, FUJI_DEPLOYMENT.contracts.PolicyRegistry.address), policyId)`
  → `{ ok, policy, record }` or `{ ok: false, reason }` (⇒ `BLOCK 003`). It fetches the JSON from `policyURI` and
  checks its hash against the chain (INV-11); `record.paused` is returned, not treated as a failure.
- **Pause:** `client.watchPause(id, cb)`.
- **Executor re-check (L6):** `createChainPolicyStateProvider(client)` reads PolicyRegistry directly, never the gateway.
- **Evidence:** `new ChainOutbox(db, createDecisionLogPort({ …LOGGER key… }))`; `outbox.enqueue(record)` in the decision
  path is a local insert only; the worker sends in the background. `outbox.stats()` feeds `/v1/health → chain.outbox`.
- **Credits (§25.3 order):** `CreditStore` implements `PaymentEntitlement`. `reserveCredit` only after `riskIncreasing`
  is derived; `releaseReservedCredit` on BLOCK / PENDING; `consumeReservedCredit` after the risk reservation;
  `refundConsumedCredit` only from reconciliation when no OKX write happened. Protective cancels never touch credits.
- **`POST /v1/credits`:** `purchaseCredits({ store, provider, delegations }, { policyId, agentId, paymentHeader })`;
  `delegations` must come from the *verified* policy (`delegationResolver`).

Agent and dashboard side: intents are signed with `signAgentIntent`; approvals and pause with `signApproval` /
`signPauseCommand` (owner wallet). Discovery: `new Erc8004Registry({…}).discover("agent-security-gateway")`. Payment:
`createExactPayment` (real EIP-3009 USDC) or a mock payload → `encodePaymentHeader` → `POST /v1/credits`.

## Shared contract (`packages/shared`)

Everything public is imported from `packages/shared`, never redefined.

| What | Where | Note |
|---|---|---|
| All §5 DTOs + enums | `types.ts` | `EXEC_STATUSES` / `CHAIN_VERDICTS` array index = Solidity enum value |
| Reason codes | `reasonCodes.ts` | `004` = payment, `002` never payment |
| `canonicalJson`, `hashCanonical` | `canonical.ts` | floats / bigint throw; `undefined` props omitted |
| `computePolicyId`, `computeAccountRef`, `requestIdToBytes32`, `deriveClOrdId`, `computeIntentHash`, `computeReasonHash`, `computeEvidenceHash` | `ids.ts` | `policyId` test vector in `test-vectors.json`, asserted in TS and Solidity |
| EIP-712 domain/types, sign/verify for AgentIntent, ExecutionAuthorization, ApprovalDecision, PauseCommand; `computeAuthHash` | `eip712.ts` | `verify*` returns false (never throws) |
| `dec()` exact decimal math | `dec.ts` | `floorToStep` for lot/tick, `addBps` for slippage buffer |
| Order normalization | `normalize.ts` | shared by L3 and the executor re-check |
| Strict zod schemas | `schemas.ts` | `schemas.signedIntentRequest` = L3 step 7 |
| Execution transition table | `execTransitions.ts` | mirrors `DecisionLog` |
| TEE attestation evidence and report-data binding | `attestation.ts` | see [`TEE.md`](TEE.md) |

Design decisions:

1. `evidenceHash` excludes `auditorOutput.raw` (raw provider JSON may hold floats that `canonicalJson` rejects).
2. `clOrdId` = `"la"` + first 30 hex chars of `keccak256(policyId ‖ UTF-8 requestId)` (32 chars total).
3. `agentId` = `eip155:<chainId>:<checksummedRegistry>:<id>`; `formatAgentId` / `agentIdMatchesBinding` /
   `bindingIsConsistent` in L3 step 3.
4. EIP-712 field types: nonces `bytes16`, times `uint64`, `tool` / `basis` / `decision` are `string`.
5. `chain_outbox` has three extra columns (`state`, `next_attempt_at`, `confirmed_at`); DDL in `@leashagent/chain`
   (`migrateChainOutbox`).
6. DecisionLog decision transitions: none → Allow | Block | Pending; Pending → HumanApproved | HumanRejected | Block
   (EXPIRED is logged as Block).

## Verified on Avalanche Fuji

- **ERC-8004 IdentityRegistry** `0x8004A818BFB912233c491871b3d84c89A494BD9e` (official deployment, proxy
  "AgentIdentity"). The ABI subset matches `abis/IdentityRegistry.json`; `npx tsx scripts/erc8004-resolve.ts 5`
  resolves a live agent. Registration cards follow the EIP-8004 `registration-v1` shape (`services`, `x402Support`,
  `active`, `registrations`), Leash Agent fields under `leash`.
- **x402:** the PayAI facilitator `https://facilitator.payai.network` lists `avalanche-fuji` (v1, exact). Asset: Circle
  Fuji USDC `0x5425890298aed601595a70AB815c96711a31Bc65` (EIP-3009, "USD Coin" v2, 6 decimals).
  `npx tsx scripts/x402-probe.ts` signs with `createExactPayment` and gets `invalid_exact_evm_insufficient_balance`
  from `/verify`: the wire format is accepted, only funds are missing. Full flow: `X402_MODE=payai npm run e2e:x402`.

## Open items

- [ ] Update Leash Agent's ERC-8004 card with the real gateway URL once the gateway is hosted.
- [ ] A real paid x402 settlement needs Fuji USDC on the agent wallet (Circle faucet); demos use `MockSettlement`.
- [ ] Credits are minted right after settlement in the same process; a crash between settle and mint loses that
      purchase.
