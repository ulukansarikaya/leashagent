import { SELL_INVENTORY_REASON } from "../src/limits";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ReasonCodes, dec, type Hex, type ReservationRequest } from "@leashagent/shared";
import { MockRiskProvider } from "@leashagent/mocks";
import { DefaultRiskStore, GatewayStore, SerialQueue, openGatewayDb } from "../src";

const P = ("0x" + "ab".repeat(32)) as Hex;
const LIMITS = { maxOpenNotionalUsdt: "2000", maxDailyLossUsdt: "100" };

function setup(path = ":memory:") {
  let now = 1_760_000_000;
  const clock = () => now;
  const db = openGatewayDb(path);
  const store = new GatewayStore(db);
  const risk = new MockRiskProvider(clock);
  const rs = new DefaultRiskStore({ db, store, risk, clock });
  return { db, store, risk, rs, advance: (s: number) => { now += s; }, now: clock };
}

const req = (notionalUsdt: string, requestId: string = randomUUID()): ReservationRequest => ({
  requestId, policyId: P, notionalUsdt, limitsToEnforce: LIMITS,
});

describe("RiskStore.snapshot", () => {
  it("combines account state, active reservations and the rate window", async () => {
    const t = setup();
    t.risk.state.openNotionalUsdt = "100";
    t.risk.state.pendingOrdersNotionalUsdt = "50";
    t.risk.state.dailyPnlUsdt = "-12.5";
    await t.rs.reserve(req("200"));
    await t.rs.reserve(req("300.5"));
    t.store.recordRateEvent(P, "a", t.now() - 61); // outside window
    t.store.recordRateEvent(P, "b", t.now() - 10);
    t.store.recordRateEvent(P, "c", t.now());
    const s = await t.rs.snapshot(P);
    expect(s).toMatchObject({
      policyId: P, fetchedAt: t.now(), dailyPnlUsdt: "-12.5", openNotionalUsdt: "100",
      pendingOrdersNotionalUsdt: "50", ordersLastMinute: 2,
    });
    expect(s.reservedNotionalUsdt).toBe("500.5");
  });

  it("rejects malformed provider data (floats / junk)", async () => {
    const t = setup();
    (t.risk.state as { openNotionalUsdt: unknown }).openNotionalUsdt = 1.5;
    await expect(t.rs.snapshot(P)).rejects.toThrow(/malformed/);
  });
});

describe("RiskStore.reserve — limits", () => {
  it("allows up to the open-notional limit, inclusive", async () => {
    const t = setup();
    t.risk.state.openNotionalUsdt = "1000";
    t.risk.state.pendingOrdersNotionalUsdt = "500";
    expect((await t.rs.reserve(req("500"))).ok).toBe(true); // exactly 2000
    expect(await t.rs.reserve(req("0.01"))).toEqual({ ok: false, reasonCode: ReasonCodes.OPEN_NOTIONAL });
  });

  it("blocks risk-increasing reservations once daily loss is hit", async () => {
    const t = setup();
    t.risk.state.dailyPnlUsdt = "-100";
    expect(await t.rs.reserve(req("10"))).toEqual({ ok: false, reasonCode: ReasonCodes.DAILY_LOSS });
    t.risk.state.dailyPnlUsdt = "-99.99";
    expect((await t.rs.reserve(req("10"))).ok).toBe(true);
  });

  it("fails closed when account data is unavailable", async () => {
    const t = setup();
    t.risk.failing = true;
    expect(await t.rs.reserve(req("10"))).toEqual({ ok: false, reasonCode: ReasonCodes.STALE_DATA });
  });

  it("rejects negative / malformed notional", async () => {
    const t = setup();
    expect((await t.rs.reserve(req("-1"))).ok).toBe(false);
    expect((await t.rs.reserve(req("1e3"))).ok).toBe(false);
  });

  it("sell reservations check available inventory, not open notional", async () => {
    const t = setup();
    t.risk.state.openNotionalUsdt = "5000"; // over the limit, but a sell reduces risk
    t.risk.state.baseBalances.BTC = "0.01";
    t.risk.state.lockedBySellOrders.BTC = "0.004";
    const sell = (qty: string) => t.rs.reserve(req("0"), { instId: "BTC-USDT", sell: { ccy: "BTC", qty } });
    expect((await sell("0.005")).ok).toBe(true); // 0.01 - 0.004 = 0.006 available
    expect(await sell("0.0011")).toEqual({ ok: false, reasonCode: SELL_INVENTORY_REASON }); // 0.001 left
    expect((await sell("0.001")).ok).toBe(true);
    expect(dec((await t.rs.sellAvailable(P, "BTC")).available).isZero()).toBe(true);
  });
});

describe("RiskStore — lifecycle and idempotency", () => {
  it("same requestId reserves once and returns the same reservation", async () => {
    const t = setup();
    const id = randomUUID();
    const a = await t.rs.reserve(req("100", id));
    const b = await t.rs.reserve(req("100", id));
    expect(a).toEqual(b);
    expect(t.rs.reservedNotional(P)).toBe("100");
  });

  it("released / settled reservations stop counting; release is idempotent", async () => {
    const t = setup();
    const a = randomUUID();
    const b = randomUUID();
    await t.rs.reserve(req("100", a));
    await t.rs.reserve(req("200", b));
    expect(t.rs.markSubmitted(b, P)).toBe(true);
    expect(t.rs.markSubmitted(b, P)).toBe(false); // only from reserved
    expect(t.rs.reservedNotional(P)).toBe("300");
    await t.rs.release(a, P);
    await t.rs.release(a, P);
    expect(t.rs.getReservation(P, a)?.state).toBe("released");
    expect(t.rs.settle(b, P)).toBe(true);
    expect(t.rs.reservedNotional(P)).toBe("0");
  });

  it("after release, the same requestId may reserve again (approval re-run, §4.4)", async () => {
    const t = setup();
    const id = randomUUID();
    const first = await t.rs.reserve(req("100", id));
    await t.rs.release(id, P);
    const second = await t.rs.reserve(req("100", id));
    expect(second.ok && first.ok && second.reservationId !== first.reservationId).toBe(true);
    expect(t.rs.getReservation(P, id)?.state).toBe("reserved");
  });
});

describe("RiskStore — concurrency (INV-10)", () => {
  it("parallel reservations cannot exceed the total limit", async () => {
    const t = setup();
    t.risk.latencyMs = () => Math.floor(Math.random() * 15);
    const results = await Promise.all(Array.from({ length: 20 }, () => t.rs.reserve(req("300"))));
    const ok = results.filter((r) => r.ok).length;
    expect(ok).toBe(6); // 6 * 300 = 1800 <= 2000 < 2100
    expect(t.rs.reservedNotional(P)).toBe("1800");
  });

  it("parallel retries of one requestId produce exactly one reservation", async () => {
    const t = setup();
    t.risk.latencyMs = () => Math.floor(Math.random() * 10);
    const id = randomUUID();
    const results = await Promise.all(Array.from({ length: 10 }, () => t.rs.reserve(req("100", id))));
    const ids = new Set(results.map((r) => (r.ok ? r.reservationId : "fail")));
    expect(ids.size).toBe(1);
    expect(t.rs.reservedNotional(P)).toBe("100");
  });

  it("parallel sells cannot oversell inventory", async () => {
    const t = setup();
    t.risk.latencyMs = () => Math.floor(Math.random() * 10);
    t.risk.state.baseBalances.BTC = "0.01";
    const results = await Promise.all(
      Array.from({ length: 10 }, () => t.rs.reserve(req("0"), { sell: { ccy: "BTC", qty: "0.003" } })),
    );
    expect(results.filter((r) => r.ok).length).toBe(3);
  });

  it("SerialQueue runs tasks one at a time, in order, surviving failures", async () => {
    const q = new SerialQueue();
    const log: string[] = [];
    let active = 0;
    const task = (name: string, fail = false) => async () => {
      active++;
      expect(active).toBe(1);
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      log.push(name);
      active--;
      if (fail) throw new Error(name);
      return name;
    };
    const results = await Promise.allSettled([q.run(task("a")), q.run(task("b", true)), q.run(task("c"))]);
    expect(log).toEqual(["a", "b", "c"]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });
});

describe("RiskStore — persistence across restart", () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("reservations, rate events and daily PnL survive a reopen", async () => {
    dir = mkdtempSync(join(tmpdir(), "leashagent-"));
    const path = join(dir, "gateway.db");
    const a = setup(path);
    a.risk.state.dailyPnlUsdt = "-42";
    await a.rs.reserve(req("700"));
    a.store.recordRateEvent(P, "r1", a.now());
    await a.rs.snapshot(P);
    a.db.close();

    const b = setup(path);
    expect(b.rs.reservedNotional(P)).toBe("700");
    expect(b.store.countRateEvents(P, b.now() - 60)).toBe(1);
    const pnl = b.db.prepare("SELECT pnl_usdt FROM daily_pnl WHERE policy_id = ?").get(P) as { pnl_usdt: string };
    expect(pnl.pnl_usdt).toBe("-42");
    expect((await b.rs.reserve(req("1301"))).ok).toBe(false); // 700 + 1301 > 2000
    b.db.close();
  });
});
