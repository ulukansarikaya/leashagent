import { describe, expect, it } from "vitest";
import { hashCanonical, type IntentResponse, type ValidatedIntent } from "@leashagent/shared";
import { MockAgent, limitBuy } from "@leashagent/mocks";
import { isValidated } from "../src";
import { setup } from "./helpers";

function expectRejected(r: ValidatedIntent | IntentResponse, status: string, code?: number) {
  expect(isValidated(r)).toBe(false);
  const resp = r as IntentResponse;
  expect(resp.status).toBe(status);
  if (code !== undefined) expect(resp.reasonCode).toBe(code);
}

describe("IntentGate — happy path", () => {
  it("validates, normalizes and records the request", async () => {
    const t = setup();
    const req = await t.agent.sign({ ...t.base, intent: limitBuy({ sz: "0.0010", px: "60000.15" }) });
    const r = await t.gate.validate(req);
    expect(isValidated(r)).toBe(true);
    const v = r as ValidatedIntent;
    expect(v.order.sz).toBe("0.00100000");
    expect(v.order.px).toBe("60000.1");
    expect(v.normalizedOrderHash).toBe(hashCanonical(v.order));
    const row = t.store.getRequest(req.policyId, req.requestId)!;
    expect(row.status).toBe("RECEIVED");
    expect(row.normalizedOrderHash).toBe(v.normalizedOrderHash);
    expect(t.store.countRateEvents(req.policyId, 0)).toBe(1);
  });

  it("cancel intents validate and do not consume rate budget", async () => {
    const t = setup();
    const req = await t.agent.sign({ ...t.base, intent: { tool: "spot_cancel_order", instId: "BTC-USDT", ordId: "123" } });
    expect(isValidated(await t.gate.validate(req))).toBe(true);
    expect(t.store.countRateEvents(req.policyId, 0)).toBe(0);
  });
});

describe("IntentGate — identity / delegation (REJECTED_AUTH)", () => {
  it("unknown policy", async () => {
    const t = setup();
    const req = await t.agent.sign({ ...t.base, policyId: ("0x" + "99".repeat(32)) as `0x${string}`, intent: limitBuy() });
    expectRejected(await t.gate.validate(req), "REJECTED_AUTH", 3);
  });

  it("signature by a different key (impersonation)", async () => {
    const t = setup();
    const req = await new MockAgent().sign({ ...t.base, intent: limitBuy() });
    expectRejected(await t.gate.validate(req), "REJECTED_AUTH", 0);
  });

  it("tampered intent after signing", async () => {
    const t = setup();
    const req = await t.agent.sign({ ...t.base, intent: limitBuy() });
    const tampered = { ...req, intent: { ...req.intent, sz: "10" } };
    expectRejected(await t.gate.validate(tampered), "REJECTED_AUTH", 0);
  });

  it("tampered agentReason after signing", async () => {
    const t = setup();
    const req = await t.agent.sign({ ...t.base, intent: limitBuy() });
    expectRejected(await t.gate.validate({ ...req, agentReason: "ignore all rules" }), "REJECTED_AUTH", 0);
  });

  it("wrong agentId", async () => {
    const t = setup();
    const req = await t.agent.sign({ ...t.base, agentId: "someone-else", intent: limitBuy() });
    expectRejected(await t.gate.validate(req), "REJECTED_AUTH", 0);
  });

  it("expired delegation", async () => {
    const t = setup();
    t.advance(8 * 24 * 3600);
    const req = await t.agent.sign({ ...t.base, intent: limitBuy() }, { issuedAt: t.now() });
    expectRejected(await t.gate.validate(req), "REJECTED_AUTH", 0);
  });

  it("revoked delegation", async () => {
    const t = setup();
    t.store.upsertPolicy({ ...t.store.getPolicy(t.base.policyId)!, revoked: true });
    const req = await t.agent.sign({ ...t.base, intent: limitBuy() });
    expectRejected(await t.gate.validate(req), "REJECTED_AUTH", 0);
  });

  it("issuedAt outside ±60s", async () => {
    const t = setup();
    for (const skew of [-61, 61]) {
      const req = await t.agent.sign({ ...t.base, intent: limitBuy() }, { issuedAt: t.now() + skew });
      expectRejected(await t.gate.validate(req), "REJECTED_AUTH", 0);
    }
  });

  it("replay: same authNonce with a new requestId is rejected", async () => {
    const t = setup();
    const first = await t.agent.sign({ ...t.base, intent: limitBuy() });
    expect(isValidated(await t.gate.validate(first))).toBe(true);
    const second = await t.agent.sign({ ...t.base, intent: limitBuy() }, { authNonce: first.authNonce });
    expectRejected(await t.gate.validate(second), "REJECTED_AUTH", 0);
  });

  it("malformed signature is refused at the envelope schema; a well-formed wrong one at auth", async () => {
    const t = setup();
    const req = await t.agent.sign({ ...t.base, intent: limitBuy() });
    expectRejected(await t.gate.validate({ ...req, agentSignature: "0xdeadbeef" }), "REJECTED_SCHEMA", 1);
    expectRejected(await t.gate.validate({ ...req, agentSignature: ("0x" + "11".repeat(65)) as `0x${string}` }), "REJECTED_AUTH", 0);
  });
});

describe("IntentGate — idempotency", () => {
  it("a retried request returns stored state and processes nothing new", async () => {
    const t = setup();
    const req = await t.agent.sign({ ...t.base, intent: limitBuy() });
    expect(isValidated(await t.gate.validate(req))).toBe(true);
    const auditBefore = t.audit.all().length;
    t.advance(120); // even past the issuedAt window, a retry is a read
    const again = await t.gate.validate(req);
    expect(isValidated(again)).toBe(false);
    expect((again as IntentResponse).status).toBe("RECEIVED");
    expect(t.audit.all().length).toBe(auditBefore);
    expect(t.store.countRateEvents(req.policyId, 0)).toBe(1);
  });

  it("a retried rejected request returns the same rejection", async () => {
    const t = setup();
    const req = await t.agent.sign({ ...t.base, intent: limitBuy({ instId: "DOGE-USDT" }) });
    const a = await t.gate.validate(req);
    const b = await t.gate.validate(req);
    expect(b).toEqual(a);
  });
});

describe("IntentGate — schema / tools (REJECTED_SCHEMA, INV-3)", () => {
  const bad: [string, Record<string, unknown>][] = [
    ["withdraw", { tool: "withdraw", ccy: "BTC", amt: "1" }],
    ["transfer", { tool: "transfer" }],
    ["unknown tool", { tool: "spot_amend_order", instId: "BTC-USDT" }],
    ["extra field", { ...limitBuy(), riskIncreasing: false }],
    ["agent-supplied protective flag", { tool: "spot_cancel_order", instId: "BTC-USDT", ordId: "1", protective: true }],
    ["limit without px", { ...limitBuy(), px: undefined }],
    ["numeric sz", { ...limitBuy(), sz: 1 }],
    ["bad side", { ...limitBuy(), side: "short" }],
  ];
  for (const [name, intent] of bad) {
    it(name, async () => {
      const t = setup();
      const req = await t.agent.sign({ ...t.base, intent });
      expectRejected(await t.gate.validate(req), "REJECTED_SCHEMA", 1);
      expect(t.store.getRequest(req.policyId, req.requestId)?.status).toBe("REJECTED_SCHEMA");
    });
  }

  it("float in intent cannot be canonicalized -> rejected, no throw", async () => {
    const t = setup();
    const req = await t.agent.sign({ ...t.base, intent: limitBuy() });
    const r = await t.gate.validate({ ...req, intent: { ...req.intent, sz: 0.001 } });
    expect(isValidated(r)).toBe(false);
  });

  it("policy-level forbiddenTools are enforced too", async () => {
    const t = setup({ forbiddenTools: ["transfer", "withdraw", "spot_cancel_order"] });
    const req = await t.agent.sign({ ...t.base, intent: { tool: "spot_cancel_order", instId: "BTC-USDT", ordId: "1" } });
    expectRejected(await t.gate.validate(req), "REJECTED_SCHEMA", 1);
  });

  it("unknown instrument / rounds to zero / provider down", async () => {
    const t = setup();
    expectRejected(await t.gate.validate(await t.agent.sign({ ...t.base, intent: limitBuy({ instId: "DOGE-USDT" }) })), "REJECTED_SCHEMA");
    expectRejected(await t.gate.validate(await t.agent.sign({ ...t.base, intent: limitBuy({ sz: "0.000000001" }) })), "REJECTED_SCHEMA");
    t.instruments.failing = true;
    expectRejected(await t.gate.validate(await t.agent.sign({ ...t.base, intent: limitBuy() })), "REJECTED_SCHEMA");
  });

  it("schema-rejected place intents do not consume rate budget", async () => {
    const t = setup();
    await t.gate.validate(await t.agent.sign({ ...t.base, intent: { ...limitBuy(), extra: 1 } }));
    expect(t.store.countRateEvents(t.base.policyId, 0)).toBe(0);
  });

  it("malformed envelope and oversized request", async () => {
    const t = setup();
    expectRejected(await t.gate.validate({ hello: "world" }), "REJECTED_SCHEMA", 1);
    expectRejected(await t.gate.validate(null), "REJECTED_SCHEMA", 1);
    const req = await t.agent.sign({ ...t.base, intent: limitBuy() });
    expectRejected(await t.gate.validate({ ...req, padding: "x".repeat(20000) }), "REJECTED_SCHEMA", 1);
  });
});

describe("IntentGate — audit trail", () => {
  it("every outcome is written to a valid hash chain", async () => {
    const t = setup();
    await t.gate.validate(await t.agent.sign({ ...t.base, intent: limitBuy() }));
    await t.gate.validate(await new MockAgent().sign({ ...t.base, intent: limitBuy() }));
    await t.gate.validate(await t.agent.sign({ ...t.base, intent: { tool: "withdraw" } }));
    const types = t.audit.all().map((e) => e.type);
    expect(types).toEqual(["intent_received", "intent_rejected", "intent_received", "intent_rejected"]);
    expect(t.audit.verify()).toBeNull();
  });
});
