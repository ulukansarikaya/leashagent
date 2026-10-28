import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import {
  ReasonCodes,
  type AuditEvent,
  type Hex,
  type IntentResponse,
  type NormalizedOrder,
  type OrderStatus,
  type ReadRequest,
  type ReasonCode,
  schemas,
} from "@leashagent/shared";
import type { GatewayApp } from "./app";
import { isValidated } from "./intent-gate";
import { toIntentResponse } from "./store";

const MAX_BODY_BYTES = 16 * 1024;

/** §9 error format. Messages carry no sensitive data. */
type ErrorBody = { requestId?: string; status: OrderStatus | "ERROR"; reasonCode?: ReasonCode; message: string };

const HTTP_STATUS: Partial<Record<OrderStatus, number>> = {
  REJECTED_AUTH: 401,
  REJECTED_SCHEMA: 400,
  REJECTED_PAYMENT: 402, // x402 "Payment Required"
};

class HttpError extends Error {
  constructor(readonly code: number, readonly body: ErrorBody) {
    super(body.message);
  }
}

function send(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, { status: "REJECTED_SCHEMA", reasonCode: ReasonCodes.SCHEMA_OR_TOOL, message: "request too large" });
    }
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, { status: "REJECTED_SCHEMA", reasonCode: ReasonCodes.SCHEMA_OR_TOOL, message: "invalid JSON" });
  }
}

/** Payload keys never sent to the dashboard, even if a future event type carries them. */
const MASKED_KEYS = new Set(["raw", "okxResponse", "apiKey", "secret", "passphrase", "accountNumber", "agentReason", "signature"]);

function mask(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(mask);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).filter(([k]) => !MASKED_KEYS.has(k)).map(([k, x]) => [k, mask(x)]),
    );
  }
  return v;
}

export function maskEvent(e: AuditEvent): AuditEvent {
  return { ...e, payload: mask(e.payload) };
}

/** Result of an x402 credit purchase (shape of `@leashagent/payments` purchaseCredits, no import — §15.2). */
export type CreditPurchaseResult =
  | { status: 200; credit: unknown }
  | { status: 402; paymentRequirements: unknown; error?: string }
  | { status: 403 | 409; error: string };

export type HttpOptions = {
  /** SSE poll interval; events are read back from the committed audit log. */
  ssePollMs?: number;
  sseHeartbeatMs?: number;
  /**
   * `POST /v1/credits` (§21.2, x402). Body `{ policyId, agentId }`, payment in the `X-PAYMENT` header.
   * Payment buys service credits only — it never grants execution authority (INV-17). Route is 404 when unset.
   */
  credits?: (q: { policyId: Hex; agentId: string; paymentHeader?: string }) => Promise<CreditPurchaseResult>;
  /** Serve the dashboard (packages/dashboard/public) for non-API GETs. */
  dashboardDir?: string;
  /**
   * TEE Lite (§21.4): attestation status for /v1/health (`tee`) and the latest evidence at GET /v1/attestation,
   * so anyone can check which signer is attested. Omitted: health reports `tee: "disabled"`, route is 404.
   */
  tee?: { status(): unknown; evidence(): unknown; attest?(nonce: Hex): Promise<unknown> };
  /** Which auditor is wired (shown in /v1/health → auditor), e.g. { provider: "heuristic", role: "fallback/demo auditor" }. */
  auditor?: unknown;
  /** Remaining x402 service credits of a policy's delegated agent (GET /v1/credits/:policyId). */
  creditBalance?: (policyId: Hex, agentId: string, payer: Hex) => number;
  /** Block explorer for DecisionLog transactions (shown in /v1/health → explorer); omit when evidence is simulated. */
  explorer?: string;
};

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

/**
 * §9 external interface. Only HTTP glue: every decision is made by the layers behind `app`.
 */
export function createHttpHandler(app: GatewayApp, opts: HttpOptions = {}) {
  const pollMs = opts.ssePollMs ?? 500;
  const heartbeatMs = opts.sseHeartbeatMs ?? 15_000;

  async function dispatchStored(policyId: Hex, requestId: string): Promise<void> {
    const row = app.store.getRequest(policyId, requestId);
    const authorization = app.store.getAuthorization(policyId, requestId);
    if (!row || row.status !== "ALLOWED" || !authorization || !row.normalizedOrderJson) return;
    try {
      await app.dispatcher.dispatch({ requestId, status: "ALLOWED", authorization }, JSON.parse(row.normalizedOrderJson) as NormalizedOrder);
    } catch {
      /* uncertain transport: state stays ALLOWED, reconciliation decides */
    }
  }

  function current(policyId: Hex, requestId: string): IntentResponse {
    return toIntentResponse(app.store.getRequest(policyId, requestId)!);
  }

  async function postIntent(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req);
    const v = await app.gate.validate(body);
    if (!isValidated(v)) return send(res, HTTP_STATUS[v.status] ?? 200, v);
    const out = await app.engine.decide(v);
    if (out.status === "ALLOWED") await dispatchStored(v.request.policyId, v.request.requestId);
    const r = current(v.request.policyId, v.request.requestId);
    send(res, HTTP_STATUS[r.status] ?? 200, r);
  }

  function getIntent(res: ServerResponse, requestId: string) {
    const row = app.store.findRequest(requestId);
    if (!row) throw new HttpError(404, { requestId, status: "ERROR", message: "unknown request" });
    const d = app.store.getDecision(row.policyId, requestId);
    const body: Record<string, unknown> = { ...toIntentResponse(row) };
    if (row.normalizedOrderHash) body.normalizedOrderHash = row.normalizedOrderHash;
    // The exact order L6 will send (no secrets); the dashboard shows it. agentReason stays masked.
    if (row.normalizedOrderJson) body.order = JSON.parse(row.normalizedOrderJson) as NormalizedOrder;
    if (d) {
      body.decision = {
        kind: d.kind, reasonCode: d.reasonCode, policyVersion: d.policyVersion, decidedAt: d.decidedAt,
        evidenceHash: d.evidenceHash, riskIncreasing: d.ruleResult.derived.riskIncreasing,
        notionalUsdt: d.ruleResult.derived.notionalUsdt, violations: d.ruleResult.violations.map((x) => x.code),
        ...(d.pendingUntil ? { pendingUntil: d.pendingUntil } : {}),
      };
    }
    send(res, 200, body);
  }

  async function postApproval(req: IncomingMessage, res: ServerResponse) {
    const body = (await readJson(req)) as { policyId?: Hex; requestId?: string };
    const r = await app.approvals.handle(body);
    if (!r.ok) {
      const err: ErrorBody = { status: r.response?.status ?? "ERROR", reasonCode: r.reasonCode, message: r.message };
      if (typeof body?.requestId === "string") err.requestId = body.requestId;
      return send(res, 403, err);
    }
    if (r.response.status === "ALLOWED") await dispatchStored(body.policyId!, r.response.requestId);
    send(res, 200, current(body.policyId!, r.response.requestId));
  }

  async function postPause(req: IncomingMessage, res: ServerResponse) {
    const r = await app.pause.handle(await readJson(req));
    if (!r.ok) return send(res, 403, { ok: false, status: "ERROR", reasonCode: r.reasonCode, message: r.message });
    send(res, 200, { ok: true, paused: r.paused });
  }

  async function getPolicy(res: ServerResponse, policyId: Hex) {
    const r = await app.loader.load(policyId);
    const cached = app.store.getPolicy(policyId);
    if (!cached) throw new HttpError(404, { status: "ERROR", message: "unknown policy" });
    send(res, 200, {
      policy: cached.policy,
      policyHash: cached.policyHash,
      version: cached.version,
      chain: r.ok ? { verified: true, source: r.p.source } : { verified: false, reason: r.reason },
      paused: cached.pausedChain || cached.pausedLocal,
      pausedChain: cached.pausedChain,
      pausedLocal: cached.pausedLocal,
      revoked: cached.revoked,
      delegationValidUntil: cached.delegationValidUntil,
      fetchedAt: cached.fetchedAt,
    });
  }

  async function postRead(req: IncomingMessage, res: ServerResponse) {
    if (!app.ingest) throw new HttpError(501, { status: "ERROR", message: "ingest not configured" });
    const parsed = schemas.readRequest.safeParse(await readJson(req));
    if (!parsed.success) throw new HttpError(400, { status: "REJECTED_SCHEMA", reasonCode: ReasonCodes.SCHEMA_OR_TOOL, message: "malformed read request" });
    try {
      send(res, 200, await app.ingest.read(parsed.data as ReadRequest));
    } catch {
      // bad agent signature, unknown policy or source failure: no detail leaves the gateway
      throw new HttpError(403, { status: "ERROR", reasonCode: ReasonCodes.INSUFFICIENT_AUTHORIZATION, message: "read refused" });
    }
  }

  function health(res: ServerResponse) {
    let storeOk = true;
    try {
      app.db.prepare("SELECT 1").get();
    } catch {
      storeOk = false;
    }
    const outboxPending = storeOk ? app.outbox.pending().length : null;
    const auditIntact = storeOk ? app.audit.verify() === null : false;
    send(res, storeOk && auditIntact ? 200 : 503, {
      status: storeOk && auditIntact ? "ok" : "degraded",
      components: {
        store: storeOk ? "ok" : "error",
        auditChain: auditIntact ? "intact" : "broken",
        signer: app.authorizer.signerAddress,
        chainOutboxPending: outboxPending,
      },
      // shared HealthChainStatus (dashboard contract)
      chain: app.chainWorker ? { outbox: app.chainWorker.stats() } : "disabled",
      tee: opts.tee ? opts.tee.status() : "disabled",
      ...(opts.auditor ? { auditor: opts.auditor } : {}),
      ...(opts.explorer ? { explorer: opts.explorer } : {}),
    });
  }

  /** SSE: masked AuditEvent stream (§6.7). Resumable via Last-Event-ID or ?since=<seq>. */
  function events(req: IncomingMessage, res: ServerResponse, url: URL) {
    const lastId = Number(req.headers["last-event-id"] ?? url.searchParams.get("since") ?? 0);
    let cursor = Number.isFinite(lastId) && lastId > 0 ? lastId : 0;
    const policyFilter = url.searchParams.get("policyId");
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": leashagent event stream\n\n");
    const pump = () => {
      for (const e of app.audit.since(cursor)) {
        cursor = e.seq;
        if (policyFilter && e.policyId !== policyFilter) continue;
        res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(maskEvent(e))}\n\n`);
      }
    };
    pump();
    const poll = setInterval(pump, pollMs);
    const beat = setInterval(() => res.write(": ping\n\n"), heartbeatMs);
    req.on("close", () => {
      clearInterval(poll);
      clearInterval(beat);
    });
  }

  async function postCredits(req: IncomingMessage, res: ServerResponse) {
    const body = (await readJson(req)) as { policyId?: unknown; agentId?: unknown };
    if (
      !body || typeof body !== "object" || Object.keys(body).some((k) => k !== "policyId" && k !== "agentId") ||
      typeof body.policyId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.policyId) ||
      typeof body.agentId !== "string" || body.agentId.length === 0 || body.agentId.length > 256
    ) {
      return send(res, 400, { status: "REJECTED_SCHEMA", reasonCode: ReasonCodes.SCHEMA_OR_TOOL, message: "expected { policyId, agentId }" } satisfies ErrorBody);
    }
    const header = req.headers["x-payment"];
    const r = await opts.credits!({
      policyId: body.policyId.toLowerCase() as Hex,
      agentId: body.agentId,
      paymentHeader: typeof header === "string" && header.length <= 8192 ? header : undefined,
    });
    if (r.status === 402) {
      // x402 Payment Required response body.
      return send(res, 402, { x402Version: 1, error: r.error ?? "payment required", accepts: [r.paymentRequirements] });
    }
    if (r.status === 200) return send(res, 200, { ok: true, credit: r.credit });
    send(res, r.status, { status: "ERROR", message: r.error } satisfies ErrorBody);
  }

  return async function handler(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const m = req.method ?? "GET";
    try {
      if (m === "POST" && path === "/v1/intents") return await postIntent(req, res);
      if (m === "GET" && path.startsWith("/v1/intents/")) return getIntent(res, decodeURIComponent(path.slice("/v1/intents/".length)));
      if (m === "POST" && path === "/v1/approvals") return await postApproval(req, res);
      if (m === "POST" && path === "/v1/pause") return await postPause(req, res);
      if (m === "GET" && path.startsWith("/v1/policy/")) return await getPolicy(res, path.slice("/v1/policy/".length) as Hex);
      if (m === "GET" && path === "/v1/events") return events(req, res, url);
      if (m === "GET" && path === "/v1/health") return health(res);
      if (m === "GET" && path === "/v1/attestation" && opts.tee) return send(res, 200, { status: opts.tee.status(), evidence: opts.tee.evidence() ?? null });
      if (m === "POST" && path === "/v1/attestation" && opts.tee?.attest) {
        // A remote verifier's challenge: answer with fresh evidence for this gateway's signer.
        const body = (await readJson(req)) as { nonce?: unknown };
        if (!body || typeof body.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.nonce) || Object.keys(body).length !== 1) {
          return send(res, 400, { status: "ERROR", message: "expected { nonce: bytes32 }" } satisfies ErrorBody);
        }
        try {
          return send(res, 200, await opts.tee.attest(body.nonce as Hex));
        } catch {
          return send(res, 503, { status: "ERROR", message: "attestation unavailable" } satisfies ErrorBody);
        }
      }
      if (m === "POST" && path === "/v1/reads") return await postRead(req, res);
      if (m === "POST" && path === "/v1/credits" && opts.credits) return await postCredits(req, res);
      if (m === "GET" && path.startsWith("/v1/credits/") && opts.creditBalance) {
        const policyId = path.slice("/v1/credits/".length).toLowerCase() as Hex;
        const p = app.store.getPolicy(policyId);
        if (!p) throw new HttpError(404, { status: "ERROR", message: "unknown policy" });
        return send(res, 200, { policyId, agentId: p.policy.binding.agentId, available: opts.creditBalance(policyId, p.policy.binding.agentId, p.agentAuthAddress) });
      }
      if (m === "GET" && opts.dashboardDir && !path.startsWith("/v1/")) {
        const root = resolve(opts.dashboardDir);
        const file = resolve(root, "." + (path === "/" ? "/index.html" : decodeURIComponent(path)));
        if ((file === root || file.startsWith(root + sep)) && existsSync(file) && statSync(file).isFile()) {
          res.writeHead(200, { "content-type": STATIC_TYPES[extname(file)] ?? "application/octet-stream" });
          return res.end(readFileSync(file));
        }
      }
      send(res, 404, { status: "ERROR", message: "not found" } satisfies ErrorBody);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.code, e.body);
      // §14: store failure -> rejected (501), nothing sent to the exchange.
      send(res, 500, { status: "ERROR", reasonCode: ReasonCodes.STORE_ERROR, message: "internal error" } satisfies ErrorBody);
    }
  };
}

export function createGatewayServer(app: GatewayApp, opts: HttpOptions = {}): Server {
  const handler = createHttpHandler(app, opts);
  return createServer((req, res) => void handler(req, res));
}
