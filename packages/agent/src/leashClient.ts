import { randomUUID } from "node:crypto";
import type { Account } from "viem";
import { signAgentRead, type Hex, type IntentResponse, type ReadSummary, type SignedIntentRequest } from "@leashagent/shared";

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
