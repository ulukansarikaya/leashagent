import { randomUUID } from "node:crypto";
import type { Account } from "viem";
import { signAgentRead, type Hex, type IntentResponse, type ReadSummary, type SignedIntentRequest } from "@leashagent/shared";
import { createExactPayment, encodePaymentHeader, type PaymentPayload, type PaymentRequirements } from "@leashagent/payments";

/** How the agent pays for service credits: "mock" moves no funds (demo), "exact" signs a real EIP-3009 USDC transfer. */
export type X402Mode = "mock" | "exact";
export type CreditPurchase = { ok: true; credit: unknown } | { ok: false; status: number; error?: string };

/** Egress allowlist (§6.2): the agent may only talk to Leash Agent and public market data. */
export function guardedFetch(allowedOrigins: string[], inner: typeof fetch = globalThis.fetch): typeof fetch {
  // `inner` is captured now so replacing globalThis.fetch with the guard cannot recurse.
  return (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!allowedOrigins.includes(url.origin)) return Promise.reject(new Error(`egress blocked: ${url.origin}`));
    return inner(input, init);
  };
}

export class LeashClient {
  constructor(private baseUrl: string, private account: Account, private policyId: Hex, private http: typeof fetch = fetch) {}

  async read(source: "news" | "web" | "social", query: string): Promise<ReadSummary> {
    const base = { requestId: randomUUID(), policyId: this.policyId, source, query: query.slice(0, 512) };
    const agentSignature = await signAgentRead(this.account, base);
    const res = (await this.post("/v1/reads", { ...base, agentSignature })) as ReadSummary & { status?: string; message?: string };
    if (res.status === "ERROR") throw new Error(`read refused: ${res.message}`);
    return res;
  }

  async submitIntent(req: SignedIntentRequest): Promise<IntentResponse> {
    return this.post("/v1/intents", req) as Promise<IntentResponse>;
  }

  /**
   * x402 (§21.2): ask for the payment requirements (402), pay, and receive service credits. Payment buys checks,
   * never authority — every intent still goes through identity, policy, risk and the executor.
   */
  async buyCredits(agentId: string, mode: X402Mode): Promise<CreditPurchase> {
    const ask = await this.credits(agentId);
    const b = ask.body as { accepts?: PaymentRequirements[]; paymentRequirements?: PaymentRequirements; error?: string };
    const reqs = b.accepts?.[0] ?? b.paymentRequirements;
    if (ask.status !== 402 || !reqs) return { ok: false, status: ask.status, error: b.error ?? "no payment requirements" };
    const payment: PaymentPayload = mode === "exact"
      ? await createExactPayment(this.account, reqs)
      : { x402Version: 1, scheme: "exact", network: reqs.network, payload: { payer: this.account.address, nonce: `0x${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}` } };
    const paid = await this.credits(agentId, encodePaymentHeader(payment));
    const pb = paid.body as { credit?: unknown; error?: string; message?: string };
    return paid.status === 200 ? { ok: true, credit: pb.credit } : { ok: false, status: paid.status, error: pb.error ?? pb.message };
  }

  private async credits(agentId: string, paymentHeader?: string): Promise<{ status: number; body: unknown }> {
    const res = await this.http(`${this.baseUrl}/v1/credits`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(paymentHeader ? { "x-payment": paymentHeader } : {}) },
      body: JSON.stringify({ policyId: this.policyId, agentId }),
      signal: AbortSignal.timeout(60_000),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  async getIntent(requestId: string): Promise<IntentResponse> {
    const res = await this.http(`${this.baseUrl}/v1/intents/${encodeURIComponent(requestId)}`);
    return res.json() as Promise<IntentResponse>;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.http(this.baseUrl + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const json = await res.json();
    if (!res.ok && !(json as { status?: string }).status) throw new Error(`leash ${path} http ${res.status}`);
    return json;
  }
}
