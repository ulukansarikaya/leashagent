import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { ChainRecord, Hex } from "@leashagent/shared";
import { ChainOutbox, PermanentRevert, type DecisionLogPort, type OutboxEvent } from "../src/index.js";

const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const RID = "123e4567-e89b-42d3-a456-426614174000";

const decision: ChainRecord = {
  kind: "decision", requestId: RID, policyId: H(1), verdict: "ALLOW", policyHash: H(2), policyVersion: 1,
  normalizedOrderHash: H(3), evidenceHash: H(4), reasonCode: 0, authHash: H(5),
};
const exec = (seq: number): ChainRecord => ({ kind: "execution", requestId: RID, eventSeq: seq, status: "submitted", okxResultHash: H(seq) });

/** In-memory fake chain with scriptable failures. */
function fakePort() {
  const applied = new Set<string>();
  const key = (r: ChainRecord) => JSON.stringify(r);
  const state = { failNext: 0, revertKeys: new Set<string>(), sends: [] as ChainRecord[], landSilently: false };
  const port: DecisionLogPort = {
    async isApplied(r) { return applied.has(key(r)); },
    async simulate(r) {
      if (state.failNext > 0) { state.failNext--; throw new Error("ECONNRESET"); }
      if (state.revertKeys.has(key(r))) throw new PermanentRevert("InvalidExecTransition");
    },
    async send(r) {
      state.sends.push(r);
      applied.add(key(r));
      if (state.landSilently) { state.landSilently = false; throw new Error("timeout after broadcast"); }
      return H(state.sends.length);
    },
    async waitForReceipt() { return "success"; },
  };
  return { port, state, applied };
}

function setup() {
  const db = new DatabaseSync(":memory:");
  const f = fakePort();
  let t = 1000;
  const events: OutboxEvent[] = [];
  const outbox = new ChainOutbox(db, f.port, { now: () => t, onEvent: (e) => events.push(e) });
  return { db, outbox, f, events, advance: (s: number) => (t += s) };
}

describe("ChainOutbox", () => {
  it("enqueue is local-only and validates records", async () => {
    const { outbox, f } = setup();
    await outbox.enqueue(decision);
    expect(f.state.sends).toHaveLength(0);
    expect(outbox.stats().pending).toBe(1);
    await expect(outbox.enqueue({ ...decision, reasonCode: 70000 })).rejects.toThrow();
    await expect(outbox.enqueue({ ...decision, extra: 1 } as unknown as ChainRecord)).rejects.toThrow();
  });

  it("drains FIFO", async () => {
    const { outbox, f } = setup();
    await outbox.enqueue(decision);
    await outbox.enqueue(exec(1));
    expect(await outbox.drain()).toBe(2);
    expect(f.state.sends.map((r) => r.kind)).toEqual(["decision", "execution"]);
    expect(outbox.stats()).toMatchObject({ confirmed: 2, pending: 0 });
  });

  it("backs off on transient errors and blocks the head of line", async () => {
    const { outbox, f, events, advance } = setup();
    await outbox.enqueue(decision);
    await outbox.enqueue(exec(1));
    f.state.failNext = 2;
    expect(await outbox.drain()).toBe(0);
    expect(f.state.sends).toHaveLength(0);
    expect(await outbox.drain()).toBe(0); // still in backoff window, nothing attempted
    advance(2);
    expect(await outbox.drain()).toBe(0); // second failure, backoff doubles to 4s
    advance(3);
    expect(await outbox.drain()).toBe(0);
    advance(1);
    expect(await outbox.drain()).toBe(2);
    expect(events.filter((e) => e.type === "retry").map((e) => (e as { attempts: number }).attempts)).toEqual([1, 2]);
  });

  it("marks permanent reverts dead and keeps going", async () => {
    const { outbox, f, events } = setup();
    f.state.revertKeys.add(JSON.stringify(exec(1)));
    await outbox.enqueue(exec(1));
    await outbox.enqueue(decision);
    expect(await outbox.drain()).toBe(2);
    expect(outbox.stats()).toMatchObject({ dead: 1, confirmed: 1 });
    expect(events.find((e) => e.type === "dead")).toBeTruthy();
  });

  it("never resends a record that already landed (crash after broadcast)", async () => {
    const { outbox, f, advance } = setup();
    await outbox.enqueue(decision);
    f.state.landSilently = true;
    expect(await outbox.drain()).toBe(0); // send threw, but tx actually landed
    advance(10);
    expect(await outbox.drain()).toBe(1);
    expect(f.state.sends).toHaveLength(1);
  });

  it("survives restart: state is on disk", async () => {
    const { db, f } = setup();
    const a = new ChainOutbox(db, f.port);
    await a.enqueue(decision);
    const b = new ChainOutbox(db, f.port); // migration is idempotent
    expect(b.stats().pending).toBe(1);
    expect(await b.drain()).toBe(1);
  });
});
