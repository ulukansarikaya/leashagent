import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ReasonCodes, EIP712_DOMAIN, EIP712_TYPES, authorizationMessage, type ExecutionAuthorization } from "@bekci/shared";
import { limitBuy } from "@bekci/mocks";
import { DefaultExecutor, ExecutionRejected, openExecutorDb } from "../src";
import { setup } from "./helpers";

async function rejects(p: Promise<unknown>, code: number, outcome?: string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ExecutionRejected);
  expect((err as ExecutionRejected).reasonCode).toBe(code);
  if (outcome) expect((err as ExecutionRejected).outcome).toBe(outcome);
}

describe("Executor — happy path", () => {
  it("limit order: one OKX write, WAL before the call, submitted + acknowledged events", async () => {
    const t = setup();
    const { auth, order } = await t.authorize();
    t.atk.onWrite = () => {
      // §6.6 step 7: the dispatching record exists before the exchange call
      expect(t.executor.getOrder(auth.requestId)?.status).toBe("dispatching");
      const n = t.db.prepare("SELECT 1 FROM executor_nonces WHERE nonce = ?").get(auth.nonce.toLowerCase());
      expect(n).toBeTruthy();
    };
    const events = await t.executor.execute(auth, order);
    expect(events.map((e) => [e.eventSeq, e.status])).toEqual([[1, "submitted"], [2, "acknowledged"]]);
    expect(t.atk.writes.length).toBe(1);
    expect(t.atk.writesFor(order.clOrdId!)).toBe(1);
    expect(t.executor.getOrder(auth.requestId)).toMatchObject({ status: "acknowledged", eventSeq: 2, clOrdId: order.clOrdId });
    expect(t.executor.events(auth.requestId)).toEqual(events);
    expect(t.sinkEvents).toEqual(events);
    expect(events[0]!.okxResultHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("market order fills immediately", async () => {
    const t = setup();
    const { auth, order } = await t.authorize(limitBuy({ ordType: "market", px: undefined }));
    expect((await t.executor.execute(auth, order)).map((e) => e.status)).toEqual(["submitted", "filled"]);
  });

  it("cancel of a resting order", async () => {
    const t = setup();
    const a = await t.authorize();
    await t.executor.execute(a.auth, a.order);
    const ordId = t.executor.getOrder(a.auth.requestId)!.ordId!;
    const c = await t.authorize({ tool: "spot_cancel_order", instId: "BTC-USDT", ordId });
    // DecisionLog transition table: none -> submitted -> cancelled
    expect((await t.executor.execute(c.auth, c.order)).map((e) => e.status)).toEqual(["submitted", "cancelled"]);
  });

  it("a failing sink does not affect execution", async () => {
    const t = setup();
    const ex = new DefaultExecutor({
      db: t.db, atk: t.atk, policyState: t.chain, config: t.config, clock: t.clock,
      sink: { onEvent: () => { throw new Error("gateway down"); } },
    });
    const { auth, order } = await t.authorize();
    expect((await ex.execute(auth, order)).length).toBe(2);
  });
});

describe("Executor — authorization verification (INV-7)", () => {
  it("401 signer is not GUARD_SIGNER_ADDRESS", async () => {
    const t = setup();
    const { auth, order } = await t.authorize(limitBuy(), {}, privateKeyToAccount(generatePrivateKey()));
    await rejects(t.executor.execute(auth, order), ReasonCodes.AUTH_INVALID);
    expect(t.atk.writes.length).toBe(0);
  });

  it("401 signed under a different EIP-712 domain", async () => {
    const t = setup();
    const { auth, order } = await t.authorize();
    const { signature: _s, ...unsigned } = auth;
    const signature = await t.guard.signTypedData({
      domain: { ...EIP712_DOMAIN, chainId: 1 },
      types: { ExecutionAuthorization: EIP712_TYPES.ExecutionAuthorization },
      primaryType: "ExecutionAuthorization",
      message: authorizationMessage(unsigned),
    });
    await rejects(t.executor.execute({ ...auth, signature }, order), ReasonCodes.AUTH_INVALID);
  });

  const tamper: [string, (a: ExecutionAuthorization) => ExecutionAuthorization][] = [
    ["expiresAt extended", (a) => ({ ...a, expiresAt: a.expiresAt + 3600 })],
    ["basis changed", (a) => ({ ...a, basis: "human_approved" })],
    ["policyVersion changed", (a) => ({ ...a, policyVersion: 2 })],
    ["requestId changed", (a) => ({ ...a, requestId: "22222222-2222-4222-8222-222222222222" })],
  ];
  for (const [name, f] of tamper) {
    it(`401 tampered field after signing: ${name}`, async () => {
      const t = setup();
      const { auth, order } = await t.authorize();
      await rejects(t.executor.execute(f(auth), order), ReasonCodes.AUTH_INVALID);
      expect(t.atk.writes.length).toBe(0);
    });
  }

  it("401 extra field on the authorization", async () => {
    const t = setup();
    const { auth, order } = await t.authorize();
    await rejects(t.executor.execute({ ...auth, maxSz: "100" } as never, order), ReasonCodes.AUTH_INVALID);
  });

  it("401 wrong accountRef / guardInstanceId / tool", async () => {
    const t = setup();
    for (const patch of [
      { accountRef: ("0x" + "77".repeat(32)) as `0x${string}` },
      { guardInstanceId: "guard-2" },
      { tool: "spot_cancel_order" as const },
    ]) {
      const { auth, order } = await t.authorize(limitBuy(), patch);
      await rejects(t.executor.execute(auth, order), ReasonCodes.AUTH_INVALID);
    }
    expect(t.atk.writes.length).toBe(0);
  });

  it("403 a different order than the one authorized", async () => {
    const t = setup();
    const { auth, order } = await t.authorize();
    await rejects(t.executor.execute(auth, { ...order, sz: "1.00000000" }), ReasonCodes.AUTH_HASH_MISMATCH);
    await rejects(t.executor.execute(auth, { ...order, side: "sell" }), ReasonCodes.AUTH_HASH_MISMATCH);
    await rejects(t.executor.execute(auth, { ...order, instId: "ETH-USDT" }), ReasonCodes.AUTH_HASH_MISMATCH);
    await rejects(t.executor.execute(auth, { ...order, extra: 1 } as never), ReasonCodes.AUTH_HASH_MISMATCH);
    expect(t.atk.writes.length).toBe(0);
  });

  it("403 clOrdId not derived from (policyId, requestId), even if hash re-signed", async () => {
    const t = setup();
    const a = await t.authorize();
    const other = await t.authorize(limitBuy(), {}, t.guard, a.auth.requestId);
    // order from a different request id but correctly hashed and signed for this requestId
    const b = await t.authorize(limitBuy(), { normalizedOrderHash: other.auth.normalizedOrderHash }, t.guard);
    await rejects(t.executor.execute(b.auth, other.order), ReasonCodes.AUTH_HASH_MISMATCH);
  });

  it("402 expired authorization", async () => {
    const t = setup();
    const { auth, order } = await t.authorize();
    t.advance(31);
    await rejects(t.executor.execute(auth, order), ReasonCodes.AUTH_EXPIRED, "expired");
    expect(t.atk.writes.length).toBe(0);
  });

  it("401 issued in the future", async () => {
    const t = setup();
    const { auth, order } = await t.authorize(limitBuy(), { issuedAt: t.clock() + 600, expiresAt: t.clock() + 630 });
    await rejects(t.executor.execute(auth, order), ReasonCodes.AUTH_INVALID);
  });
});

describe("Executor — policy recheck before sending (§6.6 step 5)", () => {
  it("405 policy version changed", async () => {
    const t = setup();
    const { auth, order } = await t.authorize();
    t.chain.mutate(t.policy.binding.policyId, { version: 2 });
    await rejects(t.executor.execute(auth, order), ReasonCodes.AUTH_POLICY_VERSION_CHANGED, "revoked");
  });

  it("405 paused (buy), but a cancel still goes through", async () => {
    const t = setup();
    const a = await t.authorize();
    await t.executor.execute(a.auth, a.order);
    t.chain.setPaused(t.policy.binding.policyId, true);
    const b = await t.authorize();
    await rejects(t.executor.execute(b.auth, b.order), ReasonCodes.AUTH_POLICY_VERSION_CHANGED, "revoked");
    const c = await t.authorize({ tool: "spot_cancel_order", instId: "BTC-USDT", ordId: t.executor.getOrder(a.auth.requestId)!.ordId! });
    expect((await t.executor.execute(c.auth, c.order)).at(-1)!.status).toBe("cancelled");
  });

  it("405 revoked / expired delegation / chain unreachable", async () => {
    const t = setup();
    t.chain.setRevoked(t.policy.binding.policyId, true);
    const a = await t.authorize();
    await rejects(t.executor.execute(a.auth, a.order), ReasonCodes.AUTH_POLICY_VERSION_CHANGED);

    const t2 = setup();
    t2.chain.mutate(t2.policy.binding.policyId, { delegationExpiresAt: t2.clock() - 1 });
    const b = await t2.authorize();
    await rejects(t2.executor.execute(b.auth, b.order), ReasonCodes.AUTH_POLICY_VERSION_CHANGED);

    const t3 = setup();
    t3.chain.failing = true;
    const c = await t3.authorize();
    await rejects(t3.executor.execute(c.auth, c.order), ReasonCodes.AUTH_POLICY_VERSION_CHANGED);
    expect(t.atk.writes.length + t2.atk.writes.length + t3.atk.writes.length).toBe(0);
  });

  it("a rejected authorization does not burn its nonce", async () => {
    const t = setup();
    const { auth, order } = await t.authorize();
    t.chain.failing = true;
    await rejects(t.executor.execute(auth, order), ReasonCodes.AUTH_POLICY_VERSION_CHANGED);
    t.chain.failing = false;
    expect((await t.executor.execute(auth, order)).length).toBe(2);
  });
});

describe("Executor — at most one write per request (INV-8)", () => {
  it("replaying the same authorization -> 404, one write", async () => {
    const t = setup();
    const { auth, order } = await t.authorize();
    await t.executor.execute(auth, order);
    await rejects(t.executor.execute(auth, order), ReasonCodes.AUTH_NONCE_REUSE, "duplicate");
    expect(t.atk.writes.length).toBe(1);
  });

  it("a second, validly signed authorization for the same requestId -> 404", async () => {
    const t = setup();
    const a = await t.authorize();
    await t.executor.execute(a.auth, a.order);
    const b = await t.authorize(limitBuy(), {}, t.guard, a.auth.requestId);
    await rejects(t.executor.execute(b.auth, b.order), ReasonCodes.AUTH_NONCE_REUSE, "duplicate");
    expect(t.atk.writes.length).toBe(1);
  });

  it("10 concurrent executions of one authorization -> exactly one write", async () => {
    const t = setup();
    t.atk.latencyMs = 5;
    const { auth, order } = await t.authorize();
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => t.executor.execute(auth, order)));
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(t.atk.writes.length).toBe(1);
  });

  it("nonces survive a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bekci-exec-"));
    try {
      const path = join(dir, "executor.db");
      const t = setup({ path });
      const { auth, order } = await t.authorize();
      await t.executor.execute(auth, order);
      t.db.close();
      const db2 = openExecutorDb(path);
      const ex2 = new DefaultExecutor({ db: db2, atk: t.atk, policyState: t.chain, config: t.config, clock: t.clock });
      await rejects(ex2.execute(auth, order), ReasonCodes.AUTH_NONCE_REUSE);
      expect(t.atk.writes.length).toBe(1);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Executor — uncertain outcomes (INV-9)", () => {
  it("timeout after OKX accepted: UNKNOWN, no resend; reconcile finds the order", async () => {
    const t = setup();
    t.atk.mode = "timeout_after_accept";
    const { auth, order } = await t.authorize();
    expect((await t.executor.execute(auth, order)).map((e) => e.status)).toEqual(["unknown"]);
    t.atk.mode = "ok";
    await rejects(t.executor.execute(auth, order), ReasonCodes.AUTH_NONCE_REUSE); // retry is not a resend
    const rec = await t.executor.reconcile();
    expect(rec.map((e) => [e.eventSeq, e.status])).toEqual([[2, "acknowledged"]]);
    expect(t.atk.writesFor(order.clOrdId!)).toBe(1);
  });

  it("timeout before OKX accepted: UNKNOWN stays UNKNOWN ('not found' is not proof)", async () => {
    const t = setup();
    t.atk.mode = "timeout_before_accept";
    const { auth, order } = await t.authorize();
    await t.executor.execute(auth, order);
    expect(await t.executor.reconcile()).toEqual([]);
    expect(t.executor.getOrder(auth.requestId)?.status).toBe("unknown");
    expect(t.atk.writes.length).toBe(1);
  });

  it("clear OKX rejection -> rejected_by_okx", async () => {
    const t = setup();
    t.atk.mode = "reject";
    const { auth, order } = await t.authorize();
    const ev = await t.executor.execute(auth, order);
    expect(ev.map((e) => [e.status, e.okxCode])).toEqual([["rejected_by_okx", "51008"]]);
  });

  it("crash after WAL (dispatching) -> reconciliation marks UNKNOWN or the real state, never resends", async () => {
    const t = setup();
    const { auth, order } = await t.authorize();
    // Simulate: WAL written, process died before the OKX call returned and before recording.
    t.atk.onWrite = () => { throw new Error("process crashed"); };
    await t.executor.execute(auth, order); // the hook throw surfaces as an uncertain outcome
    expect(t.executor.getOrder(auth.requestId)?.status).toBe("unknown");
    t.atk.onWrite = undefined;
    expect(await t.executor.reconcile()).toEqual([]);
    expect(t.atk.writes.length).toBe(1);
  });

  it("reconcile follows a resting order to filled; read failures retry safely", async () => {
    const t = setup();
    const { auth, order } = await t.authorize();
    await t.executor.execute(auth, order);
    t.atk.fill(order.clOrdId!);
    t.atk.queryFailing = true;
    expect(await t.executor.reconcile()).toEqual([]);
    t.atk.queryFailing = false;
    const rec = await t.executor.reconcile();
    expect(rec.map((e) => e.status)).toEqual(["filled"]);
    expect(await t.executor.reconcile()).toEqual([]); // terminal, nothing more
    expect(t.atk.writes.length).toBe(1);
  });
});
