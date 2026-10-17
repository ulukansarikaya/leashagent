import {
  ReasonCodes,
  auditorOutputSchema,
  computeAuthHash,
  computeEvidenceHash,
  dec,
  hashCanonical,
  recoverAgentIntentSigner,
  type AuditorInput,
  type AuditorOutput,
  type ChainRecord,
  type Decision,
  type DecisionKind,
  type ExecutionAuthorization,
  type Hex,
  type IntentResponse,
  type OrderStatus,
  type Policy,
  type ReasonCode,
  type RuleResult,
  type ValidatedIntent,
} from "@bekci/shared";
import { SELL_INVENTORY_REASON } from "./limits";
import type { AuditLog } from "./audit";
import type { Authorizer } from "./authorizer";
import { tx } from "./db";
import type { ChainOutbox } from "./outbox";
import type { LoadedPolicy, PolicyLoader } from "./policy-loader";
import type { Auditor, Clock, MarketDataProvider, OrderOwnershipVerifier, PaymentEntitlement } from "./ports";
import type { DefaultRiskStore } from "./risk-store";
import { evaluate, type RuleInputs } from "./rule-engine";
import type { SerialQueue } from "./serial";
import type { GatewayStore } from "./store";

export type DecisionOutcome = {
  requestId: string;
  status: OrderStatus;
  decision?: Decision;
  authorization?: ExecutionAuthorization;
  message?: string;
};

export interface PolicyEngine {
  decide(v: ValidatedIntent): Promise<DecisionOutcome>;
}

export type PolicyEngineDeps = {
  store: GatewayStore;
  audit: AuditLog;
  loader: PolicyLoader;
  risk: DefaultRiskStore;
  market: MarketDataProvider;
  ownership: OrderOwnershipVerifier;
  payment: PaymentEntitlement;
  auditor: Auditor;
  auditorTimeoutMs: number;
  authorizer: Authorizer;
  outbox: ChainOutbox;
  clock: Clock;
  queue: SerialQueue;
};

type Verdict = { kind: DecisionKind; status: OrderStatus; code: ReasonCode; message: string };

const ZERO_HASH = ("0x" + "00".repeat(32)) as Hex;
/** ALLOW carries no reason; 0 is used on the wire and on chain. */
const ALLOW_CODE = 0;

const block = (code: ReasonCode, message: string): Verdict => ({ kind: "BLOCK", status: "BLOCKED", code, message });
const pending = (code: ReasonCode, message: string): Verdict => ({ kind: "PENDING", status: "PENDING", code, message });
const rejectPolicy = (code: ReasonCode, message: string): Verdict => ({ kind: "BLOCK", status: "REJECTED_POLICY", code, message });
const rejectPayment = (message: string): Verdict => ({ kind: "BLOCK", status: "REJECTED_PAYMENT", code: ReasonCodes.PAYMENT_REQUIRED, message });

/** Used when the policy itself could not be verified: assume the worst. */
const UNVERIFIED_RR: RuleResult = {
  pass: false,
  violations: [],
  escalate: false,
  derived: { riskIncreasing: true, verifiedProtectiveAction: false, notionalUsdt: "0" },
};


function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function outcomeToResponse(o: DecisionOutcome): IntentResponse {
  const r: IntentResponse = { requestId: o.requestId, status: o.status };
  if (o.decision && o.decision.kind !== "ALLOW") r.reasonCode = o.decision.reasonCode;
  if (o.message) r.message = o.message;
  return r;
}

/**
 * L4 Policy Layer — DecisionComposer (§6.4, canonical order §25.3).
 * All decisions run through one SerialQueue so a limit check and its reservation are never
 * separated by another decision (§6.5).
 */
export class DefaultPolicyEngine implements PolicyEngine {
  constructor(private readonly d: PolicyEngineDeps) {}

  decide(v: ValidatedIntent): Promise<DecisionOutcome> {
    return this.d.queue.run(() => this.decideNow(v));
  }

  /** Run `fn` exclusively with respect to all decisions (used by ApprovalHandler / expiry). */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.d.queue.run(fn);
  }

  private async decideNow(v: ValidatedIntent): Promise<DecisionOutcome> {
    const { policyId, requestId } = v.request;
    const row = this.d.store.getRequest(policyId, requestId);
    if (!row) throw new Error("request was not registered by L3");
    if (row.status !== "RECEIVED") return this.existing(v);
    if (row.normalizedOrderHash !== v.normalizedOrderHash || hashCanonical(v.order) !== v.normalizedOrderHash) {
      return this.conclude(v, null, UNVERIFIED_RR, undefined, block(ReasonCodes.SCHEMA_OR_TOOL, "normalized order mismatch"), false);
    }
    return this.evaluateAndDecide(v, false);
  }

  /** Re-run after a valid owner approval (§4.4). Caller must hold `exclusive`. */
  decideApprovedNow(v: ValidatedIntent): Promise<DecisionOutcome> {
    return this.evaluateAndDecide(v, true);
  }

  private existing(v: ValidatedIntent): DecisionOutcome {
    const { policyId, requestId } = v.request;
    const row = this.d.store.getRequest(policyId, requestId)!;
    const out: DecisionOutcome = { requestId, status: row.status };
    const decision = this.d.store.getDecision(policyId, requestId);
    if (decision) {
      const { pendingUntil: _p, ...dd } = decision;
      out.decision = dd;
    }
    const auth = this.d.store.getAuthorization(policyId, requestId);
    if (auth) out.authorization = auth;
    if (row.message) out.message = row.message;
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Steps 2–8: verify policy, derive, pause gate, credit, rules, auditor, threshold
  // ---------------------------------------------------------------------------------------------
  private async evaluateAndDecide(v: ValidatedIntent, human: boolean): Promise<DecisionOutcome> {
    const { policyId, requestId, agentId } = v.request;
    const lp = await this.loadVerified(v);
    if ("error" in lp) return this.conclude(v, null, UNVERIFIED_RR, undefined, block(ReasonCodes.POLICY_UNVERIFIED, lp.error), human);

    const rr = evaluate(v, await this.gather(v, lp));
    const early = gateVerdict(rr);
    if (early) return this.conclude(v, lp, rr, undefined, early, human);

    // Step 5: service credit for risk-increasing requests (reservation only; nothing burned yet).
    let creditReserved = false;
    if (rr.derived.riskIncreasing) {
      const c = await this.d.payment.reserveCredit(policyId, agentId, lp.agentAuthAddress, requestId);
      if (!c.ok) return this.conclude(v, lp, rr, undefined, rejectPayment("service credit required"), human);
      creditReserved = true;
    }
    const releaseCredit = async (why: string) => {
      if (creditReserved) await this.d.payment.releaseReservedCredit(policyId, requestId, why);
    };

    // Step 6: deterministic rules. The auditor is not called on a violation.
    if (!rr.pass) {
      await releaseCredit("blocked");
      return this.conclude(v, lp, rr, undefined, firstViolation(rr), human);
    }

    let auditorOutput: AuditorOutput | undefined;
    let basis: ExecutionAuthorization["basis"] = human ? "human_approved" : "rules_only";
    // Human approval is the answer to the auditor/threshold PENDING gates (301/302/303), so the
    // approved re-run skips them; every state-dependent deterministic rule is re-run regardless.
    if (!human) {
      if (lp.policy.auditor.mode === "enabled") {
        const a = await this.runAuditor(v, lp.policy, rr);
        auditorOutput = a.output;
        if (a.verdict) {
          await releaseCredit("auditor");
          return this.conclude(v, lp, rr, auditorOutput, a.verdict, human);
        }
        basis = "rules_and_auditor";
      }
      if (rr.escalate) {
        await releaseCredit("pending human");
        return this.conclude(v, lp, rr, auditorOutput, pending(ReasonCodes.HUMAN_ABOVE_THRESHOLD, "above escalation threshold"), human);
      }
    }
    return this.finalize(v, basis, auditorOutput, creditReserved, human);
  }

  // ---------------------------------------------------------------------------------------------
  // Steps 9–11: re-read state, reserve risk, finalize credit, issue exactly one authorization
  // ---------------------------------------------------------------------------------------------
  private async finalize(
    v: ValidatedIntent,
    basis: ExecutionAuthorization["basis"],
    auditorOutput: AuditorOutput | undefined,
    creditReservedIn: boolean,
    human: boolean,
  ): Promise<DecisionOutcome> {
    const { policyId, requestId, agentId } = v.request;
    let creditReserved = creditReservedIn;
    const releaseCredit = async (why: string) => {
      if (creditReserved) await this.d.payment.releaseReservedCredit(policyId, requestId, why);
      creditReserved = false;
    };

    // 9. Fresh policy + state, re-run every state-dependent rule.
    const lp = await this.loadVerified(v);
    if ("error" in lp) {
      await releaseCredit("policy");
      return this.conclude(v, null, UNVERIFIED_RR, auditorOutput, block(ReasonCodes.POLICY_UNVERIFIED, lp.error), human);
    }
    const rr = evaluate(v, await this.gather(v, lp));
    const early = gateVerdict(rr) ?? (rr.pass ? null : firstViolation(rr));
    if (early) {
      await releaseCredit("recheck");
      return this.conclude(v, lp, rr, auditorOutput, early, human);
    }
    if (rr.derived.riskIncreasing && !creditReserved) {
      const c = await this.d.payment.reserveCredit(policyId, agentId, lp.agentAuthAddress, requestId);
      if (!c.ok) return this.conclude(v, lp, rr, auditorOutput, rejectPayment("service credit required"), human);
      creditReserved = true;
    }

    // Atomic risk reservation (cancels hold no exposure and reserve nothing).
    const order = v.order;
    let reserved = false;
    if (order.tool === "spot_place_order") {
      const res = await this.d.risk.reserve(
        {
          requestId,
          policyId,
          notionalUsdt: rr.derived.riskIncreasing ? rr.derived.notionalUsdt : "0",
          limitsToEnforce: {
            maxOpenNotionalUsdt: lp.policy.limits.maxOpenNotionalUsdt,
            maxDailyLossUsdt: lp.policy.limits.maxDailyLossUsdt,
          },
        },
        order.side === "sell"
          ? { instId: order.instId, sell: { ccy: baseCcy(order.instId), qty: order.sz! } }
          : { instId: order.instId },
      );
      if (!res.ok) {
        await releaseCredit("reservation");
        const verdict = res.reasonCode === SELL_INVENTORY_REASON
          ? rejectPolicy(res.reasonCode, "insufficient sell inventory")
          : block(res.reasonCode, "risk reservation failed");
        return this.conclude(v, lp, rr, auditorOutput, verdict, human);
      }
      reserved = true;
    }
    const releaseRisk = async () => {
      if (reserved) await this.d.risk.release(requestId, policyId);
    };

    const decision = this.makeDecision(v, lp, rr, auditorOutput, "ALLOW", ALLOW_CODE);

    // Sign first (local, side-effect free), then burn credit, then persist. A failure before
    // persisting leaves no authorization anywhere, so its nonce can never be used.
    let auth: ExecutionAuthorization;
    try {
      auth = await this.d.authorizer.sign(decision, v, {
        accountRef: lp.policy.binding.accountRef,
        ttlSec: lp.policy.authorizationTtlSec,
        basis,
      });
    } catch {
      await releaseRisk();
      await releaseCredit("signing");
      return this.conclude(v, lp, rr, auditorOutput, block(ReasonCodes.STORE_ERROR, "authorization signer unavailable"), human);
    }

    if (creditReserved) {
      try {
        await this.d.payment.consumeReservedCredit(policyId, requestId);
      } catch {
        await releaseRisk();
        await releaseCredit("consume failed");
        return this.conclude(v, lp, rr, auditorOutput, rejectPayment("service credit could not be finalized"), human);
      }
    }

    const now = this.d.clock();
    const authHash = computeAuthHash(auth);
    tx(this.d.store.db, () => {
      if (!this.d.store.saveAuthorization(auth, authHash)) throw new Error("authorization already issued");
      this.d.store.saveDecision(decision, null);
      this.d.store.updateRequest(policyId, requestId, { status: "ALLOWED" }, now);
      this.d.audit.appendSync({ ts: now, policyId, requestId, type: "decision", payload: decisionPayload(decision, human) });
      this.d.audit.appendSync({
        ts: now, policyId, requestId, type: "authorization_issued",
        payload: { authHash, basis, expiresAt: auth.expiresAt, normalizedOrderHash: auth.normalizedOrderHash },
      });
      this.d.outbox.enqueueSync(this.chainRecord(decision, lp, v, human ? "HUMAN_APPROVED" : "ALLOW", authHash));
    });
    return { requestId, status: "ALLOWED", decision, authorization: auth };
  }

  // ---------------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------------

  /** Policy must verify against the chain, delegation must be live and still match the signer. */
  private async loadVerified(v: ValidatedIntent): Promise<LoadedPolicy | { error: string }> {
    const r = await this.d.loader.load(v.request.policyId);
    if (!r.ok) return { error: r.reason };
    const lp = r.p;
    if (lp.revoked) return { error: "delegation revoked" };
    if (lp.policy.binding.agentId !== v.request.agentId) return { error: "agent binding changed" };
    const signer = await recoverAgentIntentSigner(v.request).catch(() => null);
    if (!signer || signer.toLowerCase() !== lp.agentAuthAddress.toLowerCase()) {
      return { error: "delegated agent address changed" };
    }
    return lp;
  }

  private async gather(v: ValidatedIntent, lp: LoadedPolicy): Promise<RuleInputs> {
    const { order } = v;
    const policyId = v.request.policyId;
    const attempt = async <T>(f: () => Promise<T>): Promise<T | null> => {
      try {
        return await f();
      } catch {
        return null;
      }
    };
    const risk = await attempt(() => this.d.risk.snapshot(policyId));
    const ticker = order.tool === "spot_place_order" ? await attempt(() => this.d.market.getTicker(order.instId)) : null;
    const sellAvailable = order.tool === "spot_place_order" && order.side === "sell"
      ? await attempt(() => this.d.risk.sellAvailable(policyId, baseCcy(order.instId)))
      : null;
    const ownership = order.tool === "spot_cancel_order" && order.cancel
      ? await attempt(() => this.d.ownership.isOwnOpenOrder(policyId, order.instId, order.cancel!))
      : null;
    return {
      now: this.d.clock(),
      policy: lp.policy,
      delegationValidUntil: lp.delegationValidUntil,
      paused: lp.paused,
      risk,
      ticker,
      sellAvailable,
      ownership,
    };
  }

  private async runAuditor(
    v: ValidatedIntent,
    policy: Policy,
    rr: RuleResult,
  ): Promise<{ output?: AuditorOutput; verdict?: Verdict }> {
    const reads = this.d.store
      .getReads(v.request.policyId, v.request.referencedReadIds)
      .map((r) => ({ readId: r.readId, excerpt: r.excerpt, summary: r.summary }));
    // agentReason and recentReads are untrusted; the adapter must present them as data, not instructions.
    const input: AuditorInput = {
      policyMandate: policy.mandate,
      order: v.order,
      agentReason: v.request.agentReason,
      recentReads: reads,
      ruleSummary: { notionalUsdt: rr.derived.notionalUsdt, escalate: rr.escalate },
    };
    let raw: unknown;
    try {
      raw = await withTimeout(this.d.auditor.decide(input, { timeoutMs: this.d.auditorTimeoutMs }), this.d.auditorTimeoutMs);
    } catch {
      return { verdict: pending(ReasonCodes.HUMAN_AUDITOR_UNAVAILABLE, "auditor unavailable") };
    }
    const parsed = auditorOutputSchema.safeParse(raw);
    if (!parsed.success) return { verdict: pending(ReasonCodes.HUMAN_AUDITOR_UNAVAILABLE, "auditor output out of schema") };
    const out = parsed.data as AuditorOutput;
    const A = policy.auditor;
    const { allow, block: blk, askHuman } = out.verdict;

    if (dec(out.injectionSuspicion).gt(A.maxInjectionSuspicion)) return { output: out, verdict: block(ReasonCodes.AUDITOR_INJECTION, "injection suspicion") };
    if (dec(out.consistency).lt(A.minConsistency)) return { output: out, verdict: block(ReasonCodes.AUDITOR_INCONSISTENT, "inconsistent with mandate") };
    // Ties resolve toward the more conservative outcome: block > askHuman > allow.
    if (dec(blk).gte(allow) && dec(blk).gte(askHuman)) return { output: out, verdict: block(ReasonCodes.AUDITOR_BLOCK, "auditor block") };
    if (dec(askHuman).gte(allow)) return { output: out, verdict: pending(ReasonCodes.HUMAN_AUDITOR_ASK, "auditor asks human") };
    if (dec(allow).lt(A.minVerdictConfidence)) return { output: out, verdict: pending(ReasonCodes.HUMAN_AUDITOR_ASK, "low auditor confidence") };
    return { output: out };
  }

  private makeDecision(
    v: ValidatedIntent,
    lp: LoadedPolicy | null,
    rr: RuleResult,
    auditorOutput: AuditorOutput | undefined,
    kind: DecisionKind,
    code: ReasonCode,
  ): Decision {
    const d: Decision = {
      requestId: v.request.requestId,
      policyId: v.request.policyId,
      policyVersion: lp?.version ?? 0,
      kind,
      reasonCode: code,
      ruleResult: rr,
      decidedAt: this.d.clock(),
      evidenceHash: computeEvidenceHash(rr, auditorOutput, v.request.referencedReadIds),
    };
    if (auditorOutput) d.auditorOutput = auditorOutput;
    return d;
  }

  private chainRecord(
    d: Decision,
    lp: LoadedPolicy | null,
    v: ValidatedIntent,
    verdict: Extract<ChainRecord, { kind: "decision" }>["verdict"],
    authHash: Hex,
  ): ChainRecord {
    return {
      kind: "decision",
      requestId: d.requestId,
      policyId: d.policyId,
      verdict,
      policyHash: lp?.policyHash ?? ZERO_HASH,
      policyVersion: d.policyVersion,
      normalizedOrderHash: v.normalizedOrderHash,
      evidenceHash: d.evidenceHash,
      reasonCode: d.reasonCode,
      authHash,
    };
  }

  /** Persist a non-ALLOW outcome (BLOCK / PENDING / REJECTED_*). */
  private conclude(
    v: ValidatedIntent,
    lp: LoadedPolicy | null,
    rr: RuleResult,
    auditorOutput: AuditorOutput | undefined,
    verdict: Verdict,
    human: boolean,
  ): DecisionOutcome {
    const { policyId, requestId } = v.request;
    const now = this.d.clock();
    const decision = this.makeDecision(v, lp, rr, auditorOutput, verdict.kind, verdict.code);
    const pendingUntil = verdict.kind === "PENDING" && lp ? now + lp.policy.pendingTtlSec : null;
    tx(this.d.store.db, () => {
      this.d.store.saveDecision(decision, pendingUntil);
      this.d.store.updateRequest(policyId, requestId, { status: verdict.status, reasonCode: verdict.code, message: verdict.message }, now);
      this.d.audit.appendSync({
        ts: now, policyId, requestId, type: "decision",
        payload: { ...decisionPayload(decision, human), status: verdict.status, message: verdict.message },
      });
      this.d.outbox.enqueueSync(this.chainRecord(decision, lp, v, verdict.kind, ZERO_HASH));
    });
    return { requestId, status: verdict.status, decision, message: verdict.message };
  }
}

function decisionPayload(d: Decision, human: boolean) {
  return {
    kind: d.kind,
    reasonCode: d.reasonCode,
    policyVersion: d.policyVersion,
    evidenceHash: d.evidenceHash,
    riskIncreasing: d.ruleResult.derived.riskIncreasing,
    notionalUsdt: d.ruleResult.derived.notionalUsdt,
    violations: d.ruleResult.violations.map((x) => x.code),
    human,
  };
}

/** §25.3 ordering: policy/expiry (003), pause (100), invalid sell (108) come before credit. */
function gateVerdict(rr: RuleResult): Verdict | null {
  const has = (code: number) => rr.violations.find((x) => x.code === code);
  const p = has(ReasonCodes.POLICY_UNVERIFIED);
  if (p) return block(p.code, p.detail);
  const pause = has(ReasonCodes.PAUSED);
  if (pause) return block(pause.code, pause.detail);
  const sell = has(SELL_INVENTORY_REASON);
  if (sell) return rejectPolicy(sell.code, sell.detail);
  return null;
}

function firstViolation(rr: RuleResult): Verdict {
  const v = [...rr.violations].sort((a, b) => a.code - b.code)[0]!;
  return block(v.code, v.detail);
}

function baseCcy(instId: string): string {
  return instId.split("-")[0]!;
}
