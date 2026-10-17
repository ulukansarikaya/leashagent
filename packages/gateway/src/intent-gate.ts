import {
  ALWAYS_FORBIDDEN_TOOLS,
  EIP712_DOMAIN,
  NormalizationError,
  ReasonCodes,
  canonicalJson,
  hashCanonical,
  normalizeOrder,
  recoverAgentIntentSigner,
  agentIdMatchesBinding,
  schemas,
  type Hex,
  type IntentResponse,
  type OrderIntent,
  type OrderStatus,
  type ReasonCode,
  type SignedIntentRequest,
  type Tool,
  type ValidatedIntent,
} from "@leashagent/shared";
import { LIMITS } from "./limits";
import type { AuditLog } from "./audit";
import { tx } from "./db";
import type { Clock, InstrumentProvider } from "./ports";
import { toIntentResponse, type CachedPolicy, type GatewayStore } from "./store";

export interface IntentGate {
  validate(req: unknown): Promise<ValidatedIntent | IntentResponse>;
}

export function isValidated(r: ValidatedIntent | IntentResponse): r is ValidatedIntent {
  return "order" in r;
}

/** Envelope-only view: everything but `intent`, which is checked after authentication (§6.3 steps 6–7). */
const envelopeSchema = schemas.signedIntentRequest.omit({ intent: true });
const KNOWN_TOOLS: readonly Tool[] = ["spot_place_order", "spot_cancel_order"];
const ZERO_POLICY = ("0x" + "00".repeat(32)) as Hex;

export type IntentGateDeps = {
  store: GatewayStore;
  audit: AuditLog;
  instruments: InstrumentProvider;
  clock: Clock;
  /**
   * §25.6 freeze gate: market BUY stays disabled until the P0 OKX demo spike has verified the
   * sz/tgtCcy semantics through the exact ATK path (scripts/atk-spike.ts). Default false.
   */
  marketBuyEnabled?: boolean;
};

/**
 * L3 Intent Gateway (§6.3). Identity, schema, tool allowlist, normalization — no policy limits.
 *
 * Ordering note (§6.3 vs §25.5): a repeated `(policyId, requestId)` whose signature verifies is
 * answered from stored state *before* the issuedAt/nonce checks, so an HTTP retry is a read of the
 * existing state rather than a replay rejection. Nothing new is processed in that case.
 */
export class DefaultIntentGate implements IntentGate {
  constructor(private readonly d: IntentGateDeps) {}

  async validate(raw: unknown): Promise<ValidatedIntent | IntentResponse> {
    const now = this.d.clock();
    const rawRequestId = typeof (raw as { requestId?: unknown })?.requestId === "string"
      ? ((raw as { requestId: string }).requestId).slice(0, 64)
      : "";

    // 1. Size and field-count limits (envelope is strict: no extra top-level fields).
    let size: number;
    try {
      size = Buffer.byteLength(JSON.stringify(raw) ?? "", "utf8");
    } catch {
      size = Infinity;
    }
    if (size > LIMITS.maxRequestBytes) {
      return this.reject(ZERO_POLICY, rawRequestId, "REJECTED_SCHEMA", ReasonCodes.SCHEMA_OR_TOOL, "request too large", now);
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !("intent" in raw)) {
      return this.reject(ZERO_POLICY, rawRequestId, "REJECTED_SCHEMA", ReasonCodes.SCHEMA_OR_TOOL, "malformed request", now);
    }
    const { intent: rawIntent, ...rest } = raw as Record<string, unknown>;
    const env = envelopeSchema.safeParse(rest);
    if (!env.success) {
      return this.reject(ZERO_POLICY, rawRequestId, "REJECTED_SCHEMA", ReasonCodes.SCHEMA_OR_TOOL, "malformed request", now);
    }
    const req = { ...env.data, intent: rawIntent } as Omit<SignedIntentRequest, "intent"> & { intent: unknown };
    const { policyId, requestId } = req;

    // 2. Known policy.
    const cached = this.d.store.getPolicy(policyId);
    if (!cached) {
      return this.reject(policyId, requestId, "REJECTED_AUTH", ReasonCodes.POLICY_UNVERIFIED, "unknown policy", now);
    }

    // 3. Delegation: binding match, not expired, not revoked.
    if (!this.delegationOk(cached, req.agentId, now)) {
      return this.reject(policyId, requestId, "REJECTED_AUTH", ReasonCodes.IDENTITY, "delegation invalid", now);
    }

    // 4a. Signature recovers to the delegated agentAuthAddress.
    let signer: Hex | null;
    try {
      signer = await recoverAgentIntentSigner(req as SignedIntentRequest);
    } catch {
      signer = null; // malformed signature, or an intent canonicalJson cannot hash (floats)
    }
    if (!signer || signer.toLowerCase() !== cached.agentAuthAddress.toLowerCase()) {
      return this.reject(policyId, requestId, "REJECTED_AUTH", ReasonCodes.IDENTITY, "bad signature", now);
    }

    // 5. Idempotency: an authenticated retry returns the stored state.
    const existing = this.d.store.getRequest(policyId, requestId);
    if (existing) return toIntentResponse(existing);

    // 4b. Freshness and persistent replay protection.
    if (Math.abs(now - req.issuedAt) > LIMITS.clockSkewSec) {
      return this.reject(policyId, requestId, "REJECTED_AUTH", ReasonCodes.IDENTITY, "stale issuedAt", now);
    }
    const accepted = tx(this.d.store.db, () => {
      if (!this.d.store.consumeNonce("agent_request", req.authNonce, now)) return false;
      this.d.store.insertRequest(policyId, requestId, "RECEIVED", now);
      this.d.audit.appendSync({ ts: now, policyId, requestId, type: "intent_received", payload: { agentId: req.agentId } });
      return true;
    });
    if (!accepted) {
      // Another request (possibly racing on the same requestId) already used this nonce.
      const raced = this.d.store.getRequest(policyId, requestId);
      if (raced) return toIntentResponse(raced);
      return this.reject(policyId, requestId, "REJECTED_AUTH", ReasonCodes.IDENTITY, "nonce reused", now);
    }

    // From here the request row exists; rejections are persisted so retries see the same answer.
    const fail = (message: string) =>
      this.rejectStored(policyId, requestId, "REJECTED_SCHEMA", ReasonCodes.SCHEMA_OR_TOOL, message, now);

    // 6. Tool allowlist; forbidden or unknown -> 001.
    const tool = (req.intent as { tool?: unknown } | null)?.tool;
    const forbidden = new Set<string>([...ALWAYS_FORBIDDEN_TOOLS, ...cached.policy.forbiddenTools]);
    if (typeof tool !== "string" || forbidden.has(tool) || !KNOWN_TOOLS.includes(tool as Tool)) {
      return fail("tool not allowed");
    }

    // 7. Tool-specific strict schema.
    const parsed = schemas.orderIntent.safeParse(req.intent);
    if (!parsed.success) return fail("intent schema violation");
    const intent = parsed.data as OrderIntent;
    if (intent.tool === "spot_place_order" && intent.ordType === "market" && intent.side === "buy" && !this.d.marketBuyEnabled) {
      return fail("market buy disabled until the P0 OKX spike verifies sz/tgtCcy (§25.6)");
    }

    // 8. Normalization.
    let instrument;
    try {
      instrument = await this.d.instruments.getInstrument(intent.instId!);
    } catch {
      return fail("instrument metadata unavailable");
    }
    if (!instrument) return fail("unknown instrument");

    let order;
    try {
      order = normalizeOrder(intent, instrument, requestId, policyId);
    } catch (e) {
      if (e instanceof NormalizationError) return fail(`normalization: ${e.message}`);
      throw e;
    }
    const normalizedOrderHash = hashCanonical(order);
    const request: SignedIntentRequest = { ...(req as Omit<SignedIntentRequest, "intent">), intent };

    tx(this.d.store.db, () => {
      this.d.store.updateRequest(policyId, requestId, {
        status: "RECEIVED",
        normalizedOrderHash,
        normalizedOrderJson: canonicalJson(order),
        requestJson: canonicalJson(request),
      }, now);
      // Rate budget is consumed by every schema-valid place intent, even if later blocked (§6.4).
      if (order.tool === "spot_place_order") this.d.store.recordRateEvent(policyId, requestId, now);
    });

    return {
      request,
      order,
      normalizedOrderHash,
      receivedAt: now,
    };
  }

  private delegationOk(c: CachedPolicy, agentId: string, now: number): boolean {
    // Delegation truth (address, expiry, revoked) comes from the chain record cached by PolicyLoader.
    // agentId must be canonical and resolve to the policy's ERC-8004 registry identity (§25.1).
    return (
      !c.revoked &&
      now <= c.delegationValidUntil &&
      c.policy.binding.agentId === agentId &&
      agentIdMatchesBinding(agentId, c.policy.binding, EIP712_DOMAIN.chainId)
    );
  }

  /** Rejection before a request row exists (unauthenticated or pre-nonce). Not persisted. */
  private reject(
    policyId: Hex, requestId: string, status: OrderStatus, reasonCode: ReasonCode, message: string, now: number,
  ): IntentResponse {
    this.d.audit.appendSync({
      ts: now, policyId, type: "intent_rejected",
      payload: { requestId, status, reasonCode, message },
    });
    return { requestId, status, reasonCode, message };
  }

  /** Rejection after the request row exists. Persisted for idempotent retries. */
  private rejectStored(
    policyId: Hex, requestId: string, status: OrderStatus, reasonCode: ReasonCode, message: string, now: number,
  ): IntentResponse {
    tx(this.d.store.db, () => {
      this.d.store.updateRequest(policyId, requestId, { status, reasonCode, message }, now);
      this.d.audit.appendSync({ ts: now, policyId, requestId, type: "intent_rejected", payload: { status, reasonCode, message } });
    });
    return { requestId, status, reasonCode, message };
  }
}
