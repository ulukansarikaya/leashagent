// x402 end-to-end through the real gateway HTTP server: POST /v1/credits (purchaseCredits + CreditStore)
// → credits are spent by risk-increasing intents (the policy engine). Payment never grants authority (INV-17).
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ReasonCodes, type Hex } from "@leashagent/shared";
import { limitBuy } from "@leashagent/mocks";
import { delegationResolver } from "@leashagent/gateway";
import { CreditStore, MockSettlement, encodePaymentHeader, fujiUsdcRequirements, purchaseCredits } from "@leashagent/payments";
import { appHarness, type AppHarness } from "../support/app-harness";

const reqs = fujiUsdcRequirements({ payTo: "0x000000000000000000000000000000000000dEaD", maxAmountRequired: "100000", resource: "/v1/credits" });
const pay = (payer: Hex, nonce: string) =>
  encodePaymentHeader({ x402Version: 1, scheme: "exact", network: "avalanche-fuji", payload: { payer, nonce } });

let h: AppHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

async function setup() {
  const store = new CreditStore(new DatabaseSync(":memory:"), { challenge: () => reqs });
  h = await appHarness({}, {
    payment: store,
    httpOptions: (app) => ({
      credits: (q) => purchaseCredits({ store, provider: new MockSettlement(reqs), delegations: delegationResolver(app.loader, app.clock) }, q),
    }),
  });
  async function buy(body: unknown, header?: string) {
    const res = await fetch(h!.url + "/v1/credits", {
      method: "POST",
      headers: { "content-type": "application/json", ...(header ? { "x-payment": header } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  return { store, h: h!, buy };
}

describe("POST /v1/credits (x402) through the gateway", () => {
  it("no credit → 402; buy 5 credits; spend one per risk-increasing intent; exhausted → 402 again", async () => {
    const { store, h, buy } = await setup();
    expect(await h.intent(limitBuy())).toMatchObject({ status: 402, body: { status: "REJECTED_PAYMENT", reasonCode: ReasonCodes.PAYMENT_REQUIRED } });

    const challenge = await buy(h.base);
    expect(challenge.status).toBe(402);
    expect(challenge.body).toMatchObject({ x402Version: 1, accepts: [{ scheme: "exact", network: "avalanche-fuji" }] });

    const bought = await buy(h.base, pay(h.agent.address, "n1"));
    expect(bought).toMatchObject({ status: 200, body: { ok: true, credit: { purchased: 5, remaining: 5 } } });
    expect(await buy(h.base, pay(h.agent.address, "n1"))).toMatchObject({ status: 409 }); // replayed payment (INV-18)

    const left = () => store.available(h.base.policyId, h.base.agentId, h.agent.address);
    // The unpaid attempt above already used 1 of the policy's 5 orders/minute (L3 counts every valid place intent).
    for (let i = 0; i < 4; i++) expect((await h.intent(limitBuy({ sz: "0.0001" }))).body.status).toBe("ACKNOWLEDGED");
    expect(left()).toBe(1);
    // A BLOCK (rate limit) does not burn a credit (§21.2 rule 5).
    expect(await h.intent(limitBuy({ sz: "0.0001" }))).toMatchObject({ body: { status: "BLOCKED", reasonCode: ReasonCodes.RATE } });
    expect(left()).toBe(1);
    h.advance(61);
    expect((await h.intent(limitBuy({ sz: "0.0001" }))).body.status).toBe("ACKNOWLEDGED");
    expect(left()).toBe(0);
    expect(await h.intent(limitBuy({ sz: "0.0001" }))).toMatchObject({ status: 402, body: { status: "REJECTED_PAYMENT" } });
  });

  it("only the delegated agent key can buy credits for the policy; other agentIds and unknown policies are refused", async () => {
    const { store, h, buy } = await setup();
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    expect(await buy(h.base, pay(stranger, "n2"))).toMatchObject({ status: 403, body: { message: "payer_not_delegated" } });
    expect(await buy({ ...h.base, agentId: "impostor" }, pay(h.agent.address, "n3"))).toMatchObject({ status: 403, body: { message: "agent_mismatch" } });
    expect(await buy({ ...h.base, policyId: `0x${"ab".repeat(32)}` }, pay(h.agent.address, "n4"))).toMatchObject({ status: 403, body: { message: "unknown_policy" } });
    expect(store.available(h.base.policyId, h.base.agentId, stranger)).toBe(0);
  });

  it("revoked delegation cannot buy credits", async () => {
    const { h, buy } = await setup();
    h.chain.setRevoked(h.base.policyId, true);
    expect(await buy(h.base, pay(h.agent.address, "n5"))).toMatchObject({ status: 403, body: { message: "delegation_inactive" } });
  });

  it("payment never overrides a policy block (INV-17)", async () => {
    const { h, buy } = await setup();
    await buy(h.base, pay(h.agent.address, "n6"));
    expect(await h.intent(limitBuy({ sz: "100" }))).toMatchObject({ body: { status: "BLOCKED", reasonCode: ReasonCodes.SINGLE_ORDER_LIMIT } });
  });

  it("rejects malformed purchase bodies", async () => {
    const { h, buy } = await setup();
    expect((await buy({ policyId: h.base.policyId })).status).toBe(400);
    expect((await buy({ ...h.base, extra: 1 })).status).toBe(400);
  });
});
