/**
 * TEST/DEMO ONLY — stand-in for Person 1's gateway (L3/L4/L5/L6).
 * Used by: offline demo, unit/integration tests, injection demo, acceptance-suite self-check.
 * It never talks to OKX (execution is simulated) and must never be a production execution path;
 * the real E2E demo connects the agent and dashboard to Person 1's gateway.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { recoverTypedDataAddress } from "viem";
import {
  APPROVAL_TYPES, EIP712_DOMAIN, PAUSE_TYPES, Reason, bindingIsConsistent, decCmp, decMul, hashCanonical,
  recoverAgentIntentSigner, signedIntentRequestSchema,
  type Auditor, type AuditEvent, type Decision, type DecisionKind, type Hex, type IntentResponse,
  type NormalizedOrder, type OrderStatus, type PolicyBinding, type ReadRecord, type RuleResult, type RuleViolation,
  type SignedApproval, type SignedIntentRequest, type SignedPauseCommand,
} from "@bekci/shared";
import { AuditorUnavailable } from "@bekci/auditor";
import { DefaultIngestService, IngestError, InMemoryReadRecorder, type ContentSource, type ReaderModel } from "@bekci/ingest";

/** Subset of §5.6 Policy the mock enforces. */
export type DemoPolicy = {
  policyVersion: number;
  binding: PolicyBinding;
  agentAuthAddress: Hex;
  delegationValidUntil: number;
  revoked: boolean;
  mandate: string;
  allowedInstruments: string[];
  allowedTools: ("spot_place_order" | "spot_cancel_order")[];
  maxOrderNotionalUsdt: string;
  escalateAboveUsdt: string;
  maxPriceDeviationBps: number;
  auditorEnabled: boolean;
  maxInjectionSuspicion: string;
  minConsistency: string;
  minVerdictConfidence: string;
  pendingTtlSec: number;
};

export type GatewayDeps = {
  policy: DemoPolicy;
  auditor: Auditor;
  source: ContentSource;
  reader: ReaderModel;
  /** Fresh reference price per call (stand-in for MarketDataProvider). */
  price: (instId: string) => string;
  /** Stand-in for Person 3's PaymentEntitlement; default: always entitled. */
  entitled?: (policyId: Hex, requestId: string) => boolean;
  dashboardDir?: string;
  /** Local-demo only: accept owner actions with signature "0x". */
  insecureOwner?: boolean;
};

type Entry = {
  req: SignedIntentRequest;
  order: NormalizedOrder;
  normalizedOrderHash: Hex;
  status: OrderStatus;
  decision?: Decision;
  pendingUntil?: number;
  authorized?: boolean;
};

const now = () => Math.floor(Date.now() / 1000);
const PLACE_KEYS = new Set(["tool", "instId", "side", "ordType", "sz", "px"]);

export function createGateway(d: GatewayDeps) {
  const p = d.policy;
  const policyId = p.binding.policyId;
  if (!bindingIsConsistent(p.binding)) throw new Error("mock policy binding does not match canonical policyId/agentId derivation");

  const intents = new Map<string, Entry>();
  const usedNonces = new Set<string>();
  const usedOwnerNonces = new Set<string>();
  const recorder = new InMemoryReadRecorder();
  const events: AuditEvent[] = [];
  const subscribers = new Set<ServerResponse>();
  let paused = false;

  function audit(type: AuditEvent["type"], payload: unknown, requestId?: string) {
    const prevHash = (events.at(-1)?.hash ?? `0x${"0".repeat(64)}`) as Hex;
    const base = { seq: events.length + 1, ts: now(), policyId, requestId, type, payload, prevHash };
    const ev: AuditEvent = { ...base, hash: hashCanonical(base) };
    events.push(ev);
    const line = `id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const s of subscribers) s.write(line);
  }

  const ingest = new DefaultIngestService({
    source: d.source, reader: d.reader, recorder,
    agentAddressFor: async (id) => (id === policyId ? p.agentAuthAddress : undefined),
    onRecorded: (r) => audit("read_recorded", { readId: r.readId, contentHash: r.contentHash, summary: r.summary }),
  });

  const respond = (e: Entry, reasonCode?: number, message?: string): IntentResponse =>
    ({ requestId: e.req.requestId, status: e.status, reasonCode: reasonCode ?? e.decision?.reasonCode, message });

  function reject(req: SignedIntentRequest | undefined, status: OrderStatus, reasonCode: number, message: string): IntentResponse {
    audit("intent_rejected", { status, reasonCode, message }, req?.requestId);
    return { requestId: req?.requestId ?? "", status, reasonCode, message };
  }

  function normalize(req: SignedIntentRequest): NormalizedOrder | string {
    const i = req.intent;
    if (i.tool === "spot_cancel_order") {
      if (!i.instId || (!i.ordId && !i.clOrdIdToCancel)) return "cancel needs instId and ordId|clOrdIdToCancel";
      return { tool: i.tool, instId: i.instId, cancel: { ordId: i.ordId, clOrdId: i.clOrdIdToCancel } };
    }
    if (Object.keys(i).some((k) => !PLACE_KEYS.has(k))) return "unexpected field for spot_place_order";
    if (!i.instId || !i.side || !i.ordType || !i.sz) return "missing field";
    if (i.ordType === "limit" && !i.px) return "limit requires px";
    if (i.ordType === "market" && i.side === "buy") return "market buy disabled until spike (§25.6)";
    const fix = (x: string) => decMul(x, "1");
    return {
      tool: i.tool, instId: i.instId, side: i.side, ordType: i.ordType, sz: fix(i.sz),
      px: i.px ? fix(i.px) : undefined, clOrdId: "bk" + hashCanonical([policyId, req.requestId]).slice(2, 32),
    };
  }

  /** §6.4 decision order, re-run in full from fresh state on every evaluation (initial and post-approval). */
  async function evaluate(e: Entry, humanApproved: boolean): Promise<Decision> {
    const v: RuleViolation[] = [];
    const o = e.order;
    const decision = (kind: DecisionKind, code: number, rr: RuleResult, auditorOutput?: Decision["auditorOutput"]): Decision => ({
      requestId: e.req.requestId, policyId, policyVersion: p.policyVersion, kind, reasonCode: code, ruleResult: rr, auditorOutput, decidedAt: now(),
      evidenceHash: hashCanonical({ ruleResult: rr, auditorOutput: auditorOutput ? { ...auditorOutput, raw: undefined } : null, readIds: e.req.referencedReadIds }),
    });

    // 2. policy / delegation verification (fresh)
    const policyOk = bindingIsConsistent(p.binding) && !p.revoked && now() <= p.delegationValidUntil;
    // 3. fresh market state + derived fields (computed here, never taken from the agent)
    const ref = d.price(o.instId);
    const riskIncreasing = o.tool === "spot_place_order" && o.side === "buy";
    const notional = o.tool === "spot_cancel_order" ? "0" : decMul(o.sz!, o.px ?? ref);
    const dev = o.px ? Math.round(Math.abs(Number(o.px) - Number(ref)) / Number(ref) * 10000) : undefined;
    const rr = (pass: boolean, escalate = false): RuleResult => ({
      pass, violations: v, escalate,
      derived: { riskIncreasing, verifiedProtectiveAction: false, notionalUsdt: notional, referencePrice: ref, priceDeviationBps: dev },
    });
    if (!policyOk) { v.push({ rule: "policy", detail: "policy/delegation not verifiable", code: Reason.POLICY_UNVERIFIED }); return decision("BLOCK", Reason.POLICY_UNVERIFIED, rr(false)); }
    // 4. pause gate
    if (paused) { v.push({ rule: "pause", detail: "policy paused", code: Reason.PAUSED }); return decision("BLOCK", Reason.PAUSED, rr(false)); }
    // 5. entitlement check (Person 3 owns the real one); payment failure is always 004
    if (riskIncreasing && d.entitled && !d.entitled(policyId, e.req.requestId)) return decision("BLOCK", Reason.NO_CREDIT, rr(false));
    // 6. deterministic rules
    if (!p.allowedInstruments.includes(o.instId)) v.push({ rule: "instrument", detail: o.instId, code: Reason.INSTRUMENT });
    if (!p.allowedTools.includes(o.tool)) v.push({ rule: "tool", detail: o.tool, code: Reason.TOOL });
    if (decCmp(notional, p.maxOrderNotionalUsdt) > 0) v.push({ rule: "single_order", detail: `${notional} > ${p.maxOrderNotionalUsdt}`, code: Reason.SINGLE_ORDER });
    if (dev !== undefined && dev > p.maxPriceDeviationBps) v.push({ rule: "price_deviation", detail: `${dev}bps`, code: Reason.PRICE_DEVIATION });
    const escalate = decCmp(notional, p.escalateAboveUsdt) > 0;
    if (v.length) return decision("BLOCK", v[0]!.code, rr(false, escalate));
    // 7. auditor
    let auditorOutput: Decision["auditorOutput"];
    if (p.auditorEnabled) {
      const cited = (await Promise.all(e.req.referencedReadIds.map((id) => recorder.get(id)))).filter(Boolean) as ReadRecord[];
      const recent = [...recorder.records.values()].filter((r) => r.policyId === policyId).slice(-5);
      const reads = [...new Map([...cited, ...recent].map((r) => [r.readId, r])).values()];
      try {
        auditorOutput = await d.auditor.decide({
          policyMandate: p.mandate, order: o, agentReason: e.req.agentReason,
          recentReads: reads.map((r) => ({ readId: r.readId, excerpt: r.excerpt, summary: r.summary })),
          ruleSummary: { notionalUsdt: notional, escalate },
        }, { timeoutMs: Number(process.env.AUDITOR_TIMEOUT_MS ?? 15000) });
      } catch (err) {
        if (!(err instanceof AuditorUnavailable)) throw err;
        return decision("PENDING", Reason.AUDITOR_UNAVAILABLE, rr(true, escalate));
      }
      const vd = auditorOutput.verdict;
      const top = Math.max(+vd.allow, +vd.block, +vd.askHuman);
      if (decCmp(auditorOutput.injectionSuspicion, p.maxInjectionSuspicion) > 0) return decision("BLOCK", Reason.AUDITOR_INJECTION, rr(true, escalate), auditorOutput);
      if (decCmp(auditorOutput.consistency, p.minConsistency) < 0) return decision("BLOCK", Reason.AUDITOR_INCONSISTENT, rr(true, escalate), auditorOutput);
      if (+vd.block === top) return decision("BLOCK", Reason.AUDITOR_BLOCK, rr(true, escalate), auditorOutput);
      // "ask human" is satisfied by a valid owner approval; nothing else is
      if (!humanApproved && (+vd.askHuman === top || top < +p.minVerdictConfidence)) return decision("PENDING", Reason.AUDITOR_ASK_HUMAN, rr(true, escalate), auditorOutput);
    }
    // 8. human threshold (satisfied by approval)
    if (escalate && !humanApproved) return decision("PENDING", Reason.ABOVE_THRESHOLD, rr(true, escalate), auditorOutput);
    // 9–10. fresh risk reservation + credit finalization belong to the real L5 / payment store;
    // the mock holds no reservations, so nothing from an earlier attempt can be reused.
    return decision("ALLOW", 0, rr(true, escalate), auditorOutput);
  }

  /** 11. authorization → executor. The response is ALLOWED; fills arrive later as execution events. */
  function authorize(e: Entry, basis: "rules_only" | "rules_and_auditor" | "human_approved") {
    if (e.authorized) return; // exactly one authorization per requestId
    e.authorized = true;
    e.status = "ALLOWED";
    audit("authorization_issued", { basis, normalizedOrderHash: e.normalizedOrderHash, simulated: true }, e.req.requestId);
    setTimeout(() => {
      e.status = "SUBMITTED";
      audit("execution", { status: "submitted", eventSeq: 1, clOrdId: e.order.clOrdId, simulated: true }, e.req.requestId);
      setTimeout(() => {
        e.status = "FILLED";
        audit("execution", { status: "filled", eventSeq: 2, clOrdId: e.order.clOrdId, simulated: true }, e.req.requestId);
      }, 20);
    }, 20);
  }

  function applyDecision(e: Entry, dec: Decision, basis: "rules_only" | "rules_and_auditor" | "human_approved") {
    e.decision = dec;
    audit("decision", dec, e.req.requestId);
    if (dec.reasonCode === Reason.NO_CREDIT) e.status = "REJECTED_PAYMENT";
    else if (dec.kind === "BLOCK") e.status = "BLOCKED";
    else if (dec.kind === "PENDING") { e.status = "PENDING"; e.pendingUntil = now() + p.pendingTtlSec; }
    else authorize(e, basis);
  }

  async function submitIntent(body: unknown): Promise<IntentResponse> {
    const parsed = signedIntentRequestSchema.safeParse(body);
    const raw = body as SignedIntentRequest | undefined;
    if (!parsed.success) return reject(raw, "REJECTED_SCHEMA", Reason.SCHEMA, parsed.error.issues[0]?.message ?? "schema");
    const req = parsed.data as SignedIntentRequest;
    if (req.policyId !== policyId || req.agentId !== p.binding.agentId) return reject(req, "REJECTED_AUTH", Reason.IDENTITY, "unknown policy or agent");
    const signer = await recoverAgentIntentSigner(req).catch(() => undefined);
    if (!signer || signer.toLowerCase() !== p.agentAuthAddress.toLowerCase()) return reject(req, "REJECTED_AUTH", Reason.IDENTITY, "bad signature");
    if (Math.abs(now() - req.issuedAt) > 60) return reject(req, "REJECTED_AUTH", Reason.IDENTITY, "issuedAt out of window");
    const existing = intents.get(req.requestId);
    if (existing) return respond(existing, undefined, "duplicate requestId; existing state");
    if (usedNonces.has(req.authNonce)) return reject(req, "REJECTED_AUTH", Reason.IDENTITY, "nonce reused");
    usedNonces.add(req.authNonce);

    const order = normalize(req);
    if (typeof order === "string") return reject(req, "REJECTED_SCHEMA", Reason.SCHEMA, order);
    const e: Entry = { req, order, normalizedOrderHash: hashCanonical(order), status: "RECEIVED" };
    intents.set(req.requestId, e);
    audit("intent_received", { order, agentReason: req.agentReason, referencedReadIds: req.referencedReadIds }, req.requestId);
    e.status = "POLICY_CHECKED";
    applyDecision(e, await evaluate(e, false), p.auditorEnabled ? "rules_and_auditor" : "rules_only");
    return respond(e);
  }

  async function verifyOwner(types: object, primaryType: string, message: Record<string, unknown>, sig: Hex): Promise<boolean> {
    if (d.insecureOwner && sig === "0x") return true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const addr = await recoverTypedDataAddress({ domain: EIP712_DOMAIN, types, primaryType, message, signature: sig } as any).catch(() => undefined);
    return !!addr && addr.toLowerCase() === p.binding.owner.toLowerCase();
  }

  /** Approval is only permission to continue: the full decision path is re-run from fresh state. */
  async function approve(a: SignedApproval): Promise<IntentResponse> {
    const e = intents.get(a.requestId);
    const refuse = (message: string): IntentResponse => ({ requestId: a.requestId, status: e?.status ?? "RECEIVED", reasonCode: Reason.INSUFFICIENT_AUTH, message });
    if (!e || e.status !== "PENDING") return refuse("not pending");
    if (a.normalizedOrderHash !== e.normalizedOrderHash || a.policyId !== policyId) return refuse("approval does not match order");
    if (usedOwnerNonces.has(a.nonce) || a.expiresAt < now()) return refuse("stale approval");
    const { ownerSignature, ...msg } = a;
    if (!(await verifyOwner(APPROVAL_TYPES, "ApprovalDecision", { ...msg, expiresAt: BigInt(a.expiresAt) }, ownerSignature))) return refuse("bad owner signature");
    usedOwnerNonces.add(a.nonce);
    audit("approval", { decision: a.decision }, a.requestId);
    if (e.pendingUntil! < now()) { e.status = "EXPIRED"; return respond(e); }
    if (a.decision === "reject") { e.status = "REJECTED_BY_HUMAN"; return respond(e); }
    e.status = "APPROVED";
    applyDecision(e, await evaluate(e, true), "human_approved");
    return respond(e);
  }

  async function pause(c: SignedPauseCommand): Promise<{ ok: boolean; message?: string }> {
    if (c.policyId !== policyId || usedOwnerNonces.has(c.nonce) || Math.abs(now() - c.issuedAt) > 300) return { ok: false, message: "invalid command" };
    const { ownerSignature, ...msg } = c;
    if (!(await verifyOwner(PAUSE_TYPES, "PauseCommand", { ...msg, issuedAt: BigInt(c.issuedAt) }, ownerSignature))) return { ok: false, message: "bad owner signature" };
    usedOwnerNonces.add(c.nonce);
    paused = c.paused;
    audit("pause", { paused });
    return { ok: true };
  }

  function expirePending() {
    for (const e of intents.values()) if (e.status === "PENDING" && e.pendingUntil! < now()) { e.status = "EXPIRED"; audit("decision", { kind: "BLOCK", expired: true }, e.req.requestId); }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const json = async () => {
      let s = ""; for await (const c of req) { s += c; if (s.length > 64_000) throw new Error("too large"); }
      return JSON.parse(s);
    };
    try {
      expirePending();
      if (req.method === "POST" && url.pathname === "/v1/intents") return send(200, await submitIntent(await json()));
      if (req.method === "POST" && url.pathname === "/v1/reads") {
        try { return send(200, await ingest.read(await json())); }
        catch (e) { return send(e instanceof IngestError ? 401 : 500, { status: "ERROR", message: (e as Error).message }); }
      }
      if (req.method === "POST" && url.pathname === "/v1/approvals") return send(200, await approve(await json()));
      if (req.method === "POST" && url.pathname === "/v1/pause") return send(200, await pause(await json()));
      if (req.method === "GET" && url.pathname.startsWith("/v1/intents/")) {
        const e = intents.get(decodeURIComponent(url.pathname.slice(12)));
        if (!e) return send(404, { status: "ERROR", message: "not found" });
        return send(200, { ...respond(e), normalizedOrderHash: e.normalizedOrderHash, order: e.order, decision: e.decision && { kind: e.decision.kind, reasonCode: e.decision.reasonCode, evidenceHash: e.decision.evidenceHash, auditorOutput: e.decision.auditorOutput && { ...e.decision.auditorOutput, raw: undefined } }, pendingUntil: e.pendingUntil });
      }
      if (req.method === "GET" && url.pathname === `/v1/policy/${policyId}`) {
        return send(200, { policy: { ...p, policyId }, policyHash: hashCanonical(p), paused, chain: "mock (not anchored)" });
      }
      if (req.method === "GET" && url.pathname === "/v1/health") return send(200, { gateway: "mock", testOnly: true, policyId, auditor: p.auditorEnabled ? "enabled" : "disabled", paused });
      if (req.method === "GET" && url.pathname === "/v1/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const since = Number(req.headers["last-event-id"] ?? url.searchParams.get("since") ?? 0);
        for (const ev of events) if (ev.seq > since) res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
        subscribers.add(res);
        req.on("close", () => subscribers.delete(res));
        return;
      }
      if (req.method === "GET" && d.dashboardDir) {
        const file = join(d.dashboardDir, url.pathname === "/" ? "index.html" : url.pathname.replace(/\.\./g, ""));
        if (existsSync(file)) {
          const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
          res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
          return res.end(readFileSync(file));
        }
      }
      send(404, { status: "ERROR", message: "not found" });
    } catch (e) {
      send(400, { status: "ERROR", message: (e as Error).message });
    }
  }

  return {
    server: createServer((q, s) => void handle(q, s)),
    submitIntent, approve, pause, ingest,
    state: { intents, events, recorder, isPaused: () => paused },
  };
}
