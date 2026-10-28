/**
 * x402 facilitator outage on the real gateway: timeout, HTTP 500 and malformed answers → clean 502
 * payment_provider_unavailable; the gateway keeps serving, no credit is minted and no execution authority exists.
 */
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExactPayment, encodePaymentHeader, FacilitatorSettlement, fujiUsdcRequirements } from "@leashagent/payments";
import { privateKeyToAccount, type OrderIntent } from "@leashagent/shared";
import { IntentBuilder, LeashClient } from "@leashagent/agent";
import { buildDevGateway } from "../../scripts/lib/devGateway";

type Mode = "hang" | "http500" | "garbage" | "ok";
let mode: Mode = "hang";
const facilitator: Server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (mode === "hang") return; // never answers
    if (mode === "http500") { res.statusCode = 500; return res.end("upstream exploded"); }
    if (mode === "garbage") { res.setHeader("content-type", "application/json"); return res.end("{not json"); }
    const { paymentPayload } = JSON.parse(body);
    const payer = paymentPayload.payload.authorization.from;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url?.endsWith("/verify")
      ? { isValid: true, payer }
      : { success: true, transaction: `0x${randomBytes(32).toString("hex")}`, network: "avalanche-fuji", payer }));
  });
});

let g: Awaited<ReturnType<typeof buildDevGateway>>;
let url = "";
let header = "";
const limit: OrderIntent = { tool: "spot_place_order", instId: "BTC-USDT", side: "buy", ordType: "limit", sz: "0.0001", px: "60000" };

beforeAll(async () => {
  await new Promise<void>((r) => facilitator.listen(0, "127.0.0.1", r));
  const fUrl = `http://127.0.0.1:${(facilitator.address() as { port: number }).port}`;
  const reqs = fujiUsdcRequirements({ payTo: "0x000000000000000000000000000000000000dEaD", maxAmountRequired: "100000", resource: "/v1/credits" });
  // Short client timeout so a hanging facilitator is detected quickly.
  const fetchShort: typeof fetch = (u, init) => fetch(u, { ...init, signal: AbortSignal.timeout(400) });
  g = await buildDevGateway({ credits: "x402", settlement: new FacilitatorSettlement(fUrl, reqs, fetchShort) });
  url = await g.listen();
  header = encodePaymentHeader(await createExactPayment(privateKeyToAccount(g.agentKey), reqs));
});
afterAll(() => { g.close(); facilitator.closeAllConnections(); facilitator.close(); });

const buy = async (h: string) => {
  const res = await fetch(`${url}/v1/credits`, { method: "POST", headers: { "content-type": "application/json", "x-payment": h }, body: JSON.stringify({ policyId: g.policy.binding.policyId, agentId: g.policy.binding.agentId }) });
  return { status: res.status, body: await res.json() };
};
const credits = () => g.credits!.available(g.policy.binding.policyId, g.policy.binding.agentId, privateKeyToAccount(g.agentKey).address);

describe("x402 facilitator outage", () => {
  it.each(["hang", "http500", "garbage"] as const)("facilitator %s → 502 payment_provider_unavailable, nothing minted", async (m) => {
    mode = m;
    expect(await buy(header)).toEqual({ status: 502, body: { status: "ERROR", message: "payment_provider_unavailable" } });
    expect(credits()).toBe(0);
  });

  it("the gateway keeps serving and no execution authority exists without credit", async () => {
    const acct = privateKeyToAccount(g.agentKey);
    const client = new LeashClient(url, acct, g.policy.binding.policyId);
    const r = await client.submitIntent(await new IntentBuilder(acct, g.policy.binding.policyId, g.policy.binding.agentId).build(limit, "x", []));
    expect(r).toMatchObject({ status: "REJECTED_PAYMENT", reasonCode: 4 });
    expect(g.app.store.getAuthorization(g.policy.binding.policyId, r.requestId)).toBeNull();
    expect(g.atk.writes).toHaveLength(0);
    expect((await fetch(`${url}/v1/health`)).status).toBe(200);
  });

  it("once the facilitator is back, the same signed payment settles and mints 5 credits", async () => {
    mode = "ok";
    expect((await buy(header)).status).toBe(200);
    expect(credits()).toBe(5);
  });
});
