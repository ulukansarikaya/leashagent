import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import vectors from "../test-vectors.json";
import {
  canonicalJson,
  computeAccountRef,
  computeAuthHash,
  computeEvidenceHash,
  computePolicyId,
  dec,
  deriveClOrdId,
  hashCanonical,
  recoverAuthorizationSigner,
  requestIdToBytes32,
  schemas,
  signAgentIntent,
  signApproval,
  signAuthorization,
  signPauseCommand,
  verifyAgentIntent,
  verifyApproval,
  verifyAuthorization,
  verifyPauseCommand,
  type ExecutionAuthorization,
  type Hex,
  type RuleResult,
  type SignedIntentRequest,
} from "../src/index.js";

const agent = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const guard = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const owner = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const other = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");

const policyId = vectors.policyId.expected as Hex;
const nonce16 = "0x000102030405060708090a0b0c0d0e0f" as Hex;

const baseReq: Omit<SignedIntentRequest, "agentSignature"> = {
  requestId: "123e4567-e89b-42d3-a456-426614174000",
  policyId,
  agentId: "eip155:43113:0x8004000000000000000000000000000000000001:42",
  issuedAt: 1_760_000_000,
  authNonce: nonce16,
  intent: { tool: "spot_place_order", instId: "BTC-USDT", side: "buy", ordType: "limit", sz: "0.001", px: "60000" },
  agentReason: "sma cross",
  referencedReadIds: [],
};

describe("canonicalJson", () => {
  it("sorts keys recursively and has no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: "x", c: [true, null] } })).toBe('{"a":{"c":[true,null],"d":"x"},"b":1}');
  });
  it("is key-order independent", () => {
    expect(hashCanonical({ x: "1", y: "2" })).toBe(hashCanonical({ y: "2", x: "1" }));
  });
  it("omits undefined properties", () => {
    expect(canonicalJson({ a: undefined, b: "1" })).toBe('{"b":"1"}');
  });
  it("rejects non-integer numbers, bigint and class instances", () => {
    expect(() => canonicalJson({ px: 1.5 })).toThrow(/Dec/);
    expect(() => canonicalJson({ n: 1n })).toThrow();
    expect(() => canonicalJson({ d: new Date() })).toThrow();
    expect(() => canonicalJson([undefined])).toThrow();
    expect(() => canonicalJson(Number.NaN)).toThrow();
  });
});

describe("ids", () => {
  it("matches the frozen policyId test vector (also asserted in Solidity)", () => {
    const v = vectors.policyId;
    expect(computeAccountRef(v.accountIdentifier)).toBe(v.accountRef);
    expect(computePolicyId(v.owner as Hex, v.accountRef as Hex, v.agentRegistry as Hex, v.agentRegistryId)).toBe(v.expected);
  });
  it("is checksum-insensitive on addresses", () => {
    const v = vectors.policyId;
    expect(computePolicyId(v.owner.toUpperCase().replace("0X", "0x") as Hex, v.accountRef as Hex, v.agentRegistry as Hex, "42")).toBe(v.expected);
  });
  it("rejects non-canonical registry ids", () => {
    const v = vectors.policyId;
    for (const bad of ["042", "-1", "1.0", ""]) {
      expect(() => computePolicyId(v.owner as Hex, v.accountRef as Hex, v.agentRegistry as Hex, bad)).toThrow();
    }
  });
  it("derives requestId bytes32 and a 32-char alphanumeric clOrdId", () => {
    expect(requestIdToBytes32(vectors.requestId.requestId)).toBe(vectors.requestId.bytes32);
    const c = deriveClOrdId(policyId, vectors.requestId.requestId);
    expect(c).toBe(vectors.requestId.clOrdId);
    expect(c).toMatch(/^la[0-9a-f]{30}$/);
  });
  it("evidenceHash ignores auditor raw payload (may hold floats)", () => {
    const rr: RuleResult = {
      pass: true, violations: [], escalate: false,
      derived: { riskIncreasing: true, verifiedProtectiveAction: false, notionalUsdt: "60" },
    };
    const out = { consistency: "0.9", injectionSuspicion: "0", verdict: { allow: "0.9", block: "0", askHuman: "0.1" }, latencyMs: 5, provider: "x" };
    expect(computeEvidenceHash(rr, { ...out, raw: { score: 0.93 } }, [])).toBe(computeEvidenceHash(rr, out, []));
  });
});

describe("dec", () => {
  it("does exact arithmetic", () => {
    expect(dec("0.1").add("0.2").toString()).toBe("0.3");
    expect(dec("0.001").mul("60000").toString()).toBe("60");
    expect(dec("10").sub("10.5").toString()).toBe("-0.5");
    expect(dec("100").addBps(50).toString()).toBe("100.5");
    expect(dec("1").div("3", 4).toString()).toBe("0.3333");
  });
  it("equalizes format differences", () => {
    expect(dec("50").eq("50.00000000")).toBe(true);
    expect(dec("50.0").toFixed(8)).toBe("50.00000000");
    expect(dec("-0.000").toString()).toBe("0");
  });
  it("floors to step and truncates", () => {
    expect(dec("0.123456789").floorToStep("0.00001").toFixed(5)).toBe("0.12345");
    expect(dec("61234.56").floorToStep("0.1").toString()).toBe("61234.5");
    expect(dec("1.999").toFixed(2)).toBe("1.99");
  });
  it("rejects malformed input", () => {
    for (const bad of ["1e3", "1.", ".5", "+1", "", " 1", "NaN"]) expect(() => dec(bad)).toThrow();
  });
});

describe("EIP-712", () => {
  it("agent intent round-trips and binds intent + reason", async () => {
    const signed = await signAgentIntent(agent, baseReq);
    expect(await verifyAgentIntent(signed, agent.address)).toBe(true);
    expect(await verifyAgentIntent(signed, other.address)).toBe(false);
    expect(await verifyAgentIntent({ ...signed, intent: { ...signed.intent, sz: "0.002" } }, agent.address)).toBe(false);
    expect(await verifyAgentIntent({ ...signed, agentReason: "ignore all rules" }, agent.address)).toBe(false);
    expect(await verifyAgentIntent({ ...signed, agentSignature: "0x1234" }, agent.address)).toBe(false);
  });

  it("authorization binds every field", async () => {
    const auth = await signAuthorization(guard, {
      requestId: baseReq.requestId, policyId, policyVersion: 1, accountRef: vectors.policyId.accountRef as Hex,
      agentId: baseReq.agentId, tool: "spot_place_order", normalizedOrderHash: hashCanonical({ x: "1" }),
      nonce: nonce16, issuedAt: 1_760_000_000, expiresAt: 1_760_000_030, guardInstanceId: "guard-1", basis: "rules_only",
    });
    expect(await recoverAuthorizationSigner(auth)).toBe(guard.address);
    const tampered: Partial<ExecutionAuthorization>[] = [
      { policyVersion: 2 }, { expiresAt: 1_760_009_999 }, { guardInstanceId: "guard-2" }, { basis: "human_approved" },
      { normalizedOrderHash: hashCanonical({ x: "2" }) }, { tool: "spot_cancel_order" },
    ];
    for (const t of tampered) expect(await verifyAuthorization({ ...auth, ...t }, guard.address)).toBe(false);
    expect(computeAuthHash(auth)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(computeAuthHash(undefined)).toBe(`0x${"0".repeat(64)}`);
  });

  it("approval and pause are owner-signed", async () => {
    const ap = await signApproval(owner, {
      requestId: baseReq.requestId, policyId, normalizedOrderHash: hashCanonical({}), decision: "approve", nonce: nonce16, expiresAt: 1,
    });
    expect(await verifyApproval(ap, owner.address)).toBe(true);
    expect(await verifyApproval({ ...ap, decision: "reject" }, owner.address)).toBe(false);
    const pz = await signPauseCommand(owner, { policyId, paused: true, nonce: nonce16, issuedAt: 1 });
    expect(await verifyPauseCommand(pz, owner.address)).toBe(true);
    expect(await verifyPauseCommand({ ...pz, paused: false }, owner.address)).toBe(false);
  });

  it("domains are separated between message types", async () => {
    const pz = await signPauseCommand(owner, { policyId, paused: true, nonce: nonce16, issuedAt: 1 });
    // a pause signature must not verify as an approval
    expect(await verifyApproval({
      requestId: baseReq.requestId, policyId, normalizedOrderHash: hashCanonical({}), decision: "approve",
      nonce: nonce16, expiresAt: 1, ownerSignature: pz.ownerSignature,
    }, owner.address)).toBe(false);
  });
});

describe("schemas", () => {
  it("accepts a valid signed request", async () => {
    const signed = await signAgentIntent(agent, baseReq);
    expect(schemas.signedIntentRequest.safeParse(signed).success).toBe(true);
  });
  it("rejects extra fields, forbidden tools and inconsistent px", async () => {
    const signed = await signAgentIntent(agent, baseReq);
    const s = schemas.signedIntentRequest;
    expect(s.safeParse({ ...signed, extra: 1 }).success).toBe(false);
    expect(s.safeParse({ ...signed, intent: { ...signed.intent, riskIncreasing: false } }).success).toBe(false);
    expect(s.safeParse({ ...signed, intent: { tool: "withdraw", ccy: "USDT" } }).success).toBe(false);
    expect(s.safeParse({ ...signed, intent: { ...signed.intent, px: undefined } }).success).toBe(false);
    expect(s.safeParse({ ...signed, intent: { ...signed.intent, ordType: "market" } }).success).toBe(false);
    expect(s.safeParse({ ...signed, intent: { ...signed.intent, sz: 0.001 } }).success).toBe(false);
    expect(s.safeParse({ ...signed, intent: { ...signed.intent, sz: "0" } }).success).toBe(false);
    expect(s.safeParse({ ...signed, agentReason: "x".repeat(1001) }).success).toBe(false);
  });
  it("cancel requires exactly one target", () => {
    const o = schemas.orderIntent;
    expect(o.safeParse({ tool: "spot_cancel_order", instId: "BTC-USDT", ordId: "123" }).success).toBe(true);
    expect(o.safeParse({ tool: "spot_cancel_order", instId: "BTC-USDT" }).success).toBe(false);
    expect(o.safeParse({ tool: "spot_cancel_order", instId: "BTC-USDT", ordId: "1", clOrdIdToCancel: "a" }).success).toBe(false);
  });
  it("read summary blocks non-http links and overlong fields", () => {
    const ok = { readId: baseReq.requestId, source: "news", topics: ["btc"], sentiment: "neutral", confidence: "0.5", sourceUrls: ["https://a.example/x"], flags: [] };
    expect(schemas.readSummary.safeParse(ok).success).toBe(true);
    expect(schemas.readSummary.safeParse({ ...ok, sourceUrls: ["javascript:alert(1)"] }).success).toBe(false);
    expect(schemas.readSummary.safeParse({ ...ok, topics: ["x".repeat(65)] }).success).toBe(false);
    expect(schemas.readSummary.safeParse({ ...ok, confidence: "1.5" }).success).toBe(false);
  });
});
