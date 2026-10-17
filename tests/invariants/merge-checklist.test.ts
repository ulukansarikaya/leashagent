import { afterEach, describe, expect, it } from "vitest";
import { ReasonCodes } from "@leashagent/shared";
import { limitBuy } from "@leashagent/mocks";
import { appHarness, type AppHarness } from "../support/app-harness";

// LEASH_AGENT_GOREV1_FINAL_INTEGRATION_CHECKLIST.md — "P1 Security invariants", over HTTP.
// Replay, HTTP retry, timeout, pause race, expiry and credit cases are in tests/attacks,
// tests/invariants/e2e-execution.test.ts and tests/integration/person3-wiring.test.ts.

let h: AppHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

describe("checklist: over-limit", () => {
  it("valid signature + delegation + schema, BUY 5 BTC LIMIT @ 65000 -> BLOCKED 103, executor never called, 0 OKX writes", async () => {
    h = await appHarness();
    const r = await h.intent(limitBuy({ sz: "5", px: "65000" }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "BLOCKED", reasonCode: ReasonCodes.SINGLE_ORDER_LIMIT });
    expect(h.app.store.getAuthorization(h.base.policyId, r.req.requestId)).toBeNull();
    expect(h.atk.writes.length).toBe(0);
  });
});

describe("checklist: sell inventory", () => {
  it("qty > verified balance − open/locked sells − active sell reservations -> REJECTED_POLICY", async () => {
    h = await appHarness();
    h.riskProvider.state.baseBalances.BTC = "0.01";
    h.riskProvider.state.lockedBySellOrders.BTC = "0.004"; // open sell orders at OKX
    h.atk.mode = "timeout_before_accept"; // keep the first sell's reservation active (UNKNOWN)
    const first = await h.intent(limitBuy({ side: "sell", sz: "0.005" })); // 0.006 available -> ok
    expect(first.body.status).toBe("UNKNOWN");
    const second = await h.intent(limitBuy({ side: "sell", sz: "0.002" })); // 0.001 left
    expect(second.body).toMatchObject({ status: "REJECTED_POLICY", reasonCode: ReasonCodes.SELL_INVENTORY });
    expect(h.atk.writes.length).toBe(1);
  });
});
