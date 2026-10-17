import {
  ReasonCodes,
  recoverApprovalSigner,
  schemas,
  type IntentResponse,
  type NormalizedOrder,
  type ReasonCode,
  type SignedApproval,
  type SignedIntentRequest,
  type ValidatedIntent,
} from "@bekci/shared";
import type { AuditLog } from "./audit";
import { tx } from "./db";
import type { ChainOutbox } from "./outbox";
import { outcomeToResponse, type DefaultPolicyEngine } from "./policy-engine";
import type { PolicyLoader } from "./policy-loader";
import type { Clock } from "./ports";
import type { GatewayStore } from "./store";

export type ApprovalResult =
  | { ok: true; response: IntentResponse }
  | { ok: false; reasonCode: ReasonCode; message: string; response?: IntentResponse };

export type ApprovalHandlerDeps = {
  engine: DefaultPolicyEngine;
  store: GatewayStore;
  audit: AuditLog;
  loader: PolicyLoader;
  outbox: ChainOutbox;
  clock: Clock;
};

const ZERO_HASH = ("0x" + "00".repeat(32)) as `0x${string}`;

/**
 * L4 ApprovalHandler (§4.4, INV-6). A valid owner-signed approval never authorizes by itself:
 * it restarts the full state-dependent path (fresh policy, risk, rules, new reservation, credit).
 */
export class ApprovalHandler {
  constructor(private readonly d: ApprovalHandlerDeps) {}

  handle(raw: unknown): Promise<ApprovalResult> {
    return this.d.engine.exclusive(() => this.handleNow(raw));
  }

  private async handleNow(raw: unknown): Promise<ApprovalResult> {
    const fail = (message: string, response?: IntentResponse): ApprovalResult => {
      const r: ApprovalResult = { ok: false, reasonCode: ReasonCodes.INSUFFICIENT_AUTHORIZATION, message };
      if (response) r.response = response;
      return r;
    };

    const parsed = schemas.signedApproval.safeParse(raw);
    if (!parsed.success) return fail("malformed approval");
    const a = parsed.data as SignedApproval;
    const now = this.d.clock();

    const row = this.d.store.getRequest(a.policyId, a.requestId);
    if (!row) return fail("unknown request");
    const current: IntentResponse = { requestId: row.requestId, status: row.status };
    if (row.status !== "PENDING") return fail("request is not pending", current);

    const lp = await this.d.loader.load(a.policyId);
    if (!lp.ok) return { ok: false, reasonCode: ReasonCodes.POLICY_UNVERIFIED, message: lp.reason, response: current };

    const signer = await recoverApprovalSigner(a).catch(() => null);
    if (!signer || signer.toLowerCase() !== lp.p.policy.binding.owner.toLowerCase()) return fail("not signed by owner", current);
    if (a.expiresAt < now) return fail("approval expired", current);
    if (a.normalizedOrderHash !== row.normalizedOrderHash) return fail("order hash mismatch", current);

    const decision = this.d.store.getDecision(a.policyId, a.requestId);
    if (!decision || decision.pendingUntil === null || decision.pendingUntil < now) {
      this.expireOne(a.policyId, a.requestId, now);
      return fail("pending request expired", { requestId: a.requestId, status: "EXPIRED" });
    }
    if (!this.d.store.consumeNonce("approval", a.nonce, now)) return fail("approval nonce reused", current);

    this.d.audit.appendSync({
      ts: now, policyId: a.policyId, requestId: a.requestId, type: "approval",
      payload: { decision: a.decision, normalizedOrderHash: a.normalizedOrderHash },
    });

    if (a.decision === "reject") {
      tx(this.d.store.db, () => {
        this.d.store.updateRequest(a.policyId, a.requestId, { status: "REJECTED_BY_HUMAN", message: "rejected by owner" }, now);
        this.d.outbox.enqueueSync({
          kind: "decision",
          requestId: a.requestId,
          policyId: a.policyId,
          verdict: "HUMAN_REJECTED",
          policyHash: lp.p.policyHash,
          policyVersion: lp.p.version,
          normalizedOrderHash: a.normalizedOrderHash,
          evidenceHash: decision.evidenceHash,
          reasonCode: decision.reasonCode,
          authHash: ZERO_HASH,
        });
      });
      return { ok: true, response: { requestId: a.requestId, status: "REJECTED_BY_HUMAN" } };
    }

    this.d.store.updateRequest(a.policyId, a.requestId, { status: "APPROVED" }, now);
    const v: ValidatedIntent = {
      request: JSON.parse(row.requestJson!) as SignedIntentRequest,
      order: JSON.parse(row.normalizedOrderJson!) as NormalizedOrder,
      normalizedOrderHash: row.normalizedOrderHash!,
      receivedAt: row.receivedAt,
    };
    const outcome = await this.d.engine.decideApprovedNow(v);
    return { ok: true, response: outcomeToResponse(outcome) };
  }

  /** PENDING past its TTL becomes EXPIRED, counted as BLOCK; never ALLOW (§4.4). */
  expirePending(): Promise<number> {
    return this.d.engine.exclusive(async () => {
      const now = this.d.clock();
      const due = this.d.store.listExpiredPending(now);
      for (const r of due) this.expireOne(r.policyId, r.requestId, now);
      return due.length;
    });
  }

  private expireOne(policyId: `0x${string}`, requestId: string, now: number): void {
    const row = this.d.store.getRequest(policyId, requestId);
    const d = this.d.store.getDecision(policyId, requestId);
    if (!row || row.status !== "PENDING" || !d) return;
    tx(this.d.store.db, () => {
      this.d.store.saveDecision({ ...d, kind: "BLOCK", decidedAt: now }, null);
      this.d.store.updateRequest(policyId, requestId, { status: "EXPIRED", message: "pending approval expired" }, now);
      this.d.audit.appendSync({ ts: now, policyId, requestId, type: "decision", payload: { kind: "BLOCK", expired: true } });
      const cached = this.d.store.getPolicy(policyId);
      this.d.outbox.enqueueSync({
        kind: "decision",
        requestId,
        policyId,
        verdict: "BLOCK",
        policyHash: cached?.policyHash ?? ZERO_HASH,
        policyVersion: d.policyVersion,
        normalizedOrderHash: row.normalizedOrderHash ?? ZERO_HASH,
        evidenceHash: d.evidenceHash,
        reasonCode: d.reasonCode,
        authHash: ZERO_HASH,
      });
    });
  }
}
