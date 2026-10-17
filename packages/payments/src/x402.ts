import { getAddress } from "viem";
import type { Hex } from "@bekci/shared";

// x402 "exact" scheme wire types. Field names follow the public x402 spec;
// facilitator availability on Avalanche Fuji is UNVERIFIED (SONPLAN.md §24.1).

export type PaymentRequirements = {
  scheme: "exact";
  network: string; // e.g. "avalanche-fuji"
  maxAmountRequired: string; // atomic units of `asset`
  resource: string;
  description: string;
  mimeType: string;
  payTo: Hex;
  maxTimeoutSeconds: number;
  asset: Hex; // ERC-20 (EIP-3009) token address
  extra?: Record<string, unknown>;
};

export type PaymentPayload = {
  x402Version: number;
  scheme: "exact";
  network: string;
  payload: unknown;
};

export type VerifyResult = { isValid: true; payer: Hex } | { isValid: false; invalidReason: string };
export type SettleResult =
  | { success: true; paymentRef: string; payer: Hex }
  | { success: false; errorReason: string };

/** Provider boundary — core code never sees facilitator-specific types. */
export interface SettlementProvider {
  requirements(): PaymentRequirements;
  verify(p: PaymentPayload): Promise<VerifyResult>;
  settle(p: PaymentPayload): Promise<SettleResult>;
}

export function decodePaymentHeader(header: string): PaymentPayload {
  const json = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  if (json?.scheme !== "exact" || typeof json.network !== "string" || typeof json.x402Version !== "number") {
    throw new Error("malformed X-PAYMENT header");
  }
  return json as PaymentPayload;
}

export function encodePaymentHeader(p: PaymentPayload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64");
}

/** HTTP facilitator client: POST {url}/verify and {url}/settle. */
export class FacilitatorSettlement implements SettlementProvider {
  constructor(
    private readonly url: string,
    private readonly reqs: PaymentRequirements,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  requirements(): PaymentRequirements {
    return this.reqs;
  }

  private async post(path: string, p: PaymentPayload): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.url.replace(/\/$/, "")}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: p.x402Version, paymentPayload: p, paymentRequirements: this.reqs }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`facilitator ${path} HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async verify(p: PaymentPayload): Promise<VerifyResult> {
    const r = await this.post("verify", p);
    if (r.isValid === true && typeof r.payer === "string") return { isValid: true, payer: getAddress(r.payer) };
    return { isValid: false, invalidReason: String(r.invalidReason ?? "invalid") };
  }

  async settle(p: PaymentPayload): Promise<SettleResult> {
    const r = await this.post("settle", p);
    if (r.success === true && typeof r.transaction === "string" && typeof r.payer === "string") {
      // paymentRef = network:txHash — unique per settlement, replay cannot mint twice.
      return { success: true, paymentRef: `${String(r.network ?? p.network)}:${r.transaction.toLowerCase()}`, payer: getAddress(r.payer) };
    }
    return { success: false, errorReason: String(r.errorReason ?? "settle failed") };
  }
}

/**
 * Dev/demo provider: the "payment" is a payer-signed nonce, no funds move. Never enable in production.
 * payload = { payer, nonce }.
 */
export class MockSettlement implements SettlementProvider {
  constructor(private readonly reqs: PaymentRequirements) {}
  requirements() {
    return this.reqs;
  }
  async verify(p: PaymentPayload): Promise<VerifyResult> {
    const pl = p.payload as { payer?: string; nonce?: string } | null;
    if (!pl?.payer || !pl.nonce) return { isValid: false, invalidReason: "mock payload requires payer and nonce" };
    return { isValid: true, payer: getAddress(pl.payer) };
  }
  async settle(p: PaymentPayload): Promise<SettleResult> {
    const v = await this.verify(p);
    if (!v.isValid) return { success: false, errorReason: v.invalidReason };
    const nonce = (p.payload as { nonce: string }).nonce;
    return { success: true, paymentRef: `mock:${p.network}:${nonce}`, payer: v.payer };
  }
}
