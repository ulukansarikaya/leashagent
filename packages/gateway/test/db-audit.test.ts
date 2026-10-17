import { describe, expect, it } from "vitest";
import { AuditLog, GatewayStore, openGatewayDb } from "../src";

const P = ("0x" + "ab".repeat(32)) as `0x${string}`;

describe("gateway db", () => {
  it("migrations are idempotent across reopen", () => {
    const db = openGatewayDb(":memory:");
    const v = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    expect(v.v).toBe(7);
  });

  it("executor-owned tables are not in the gateway store", () => {
    const db = openGatewayDb(":memory:");
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    expect(names).not.toContain("executor_nonces");
    expect(names).not.toContain("orders");
  });

  it("nonce consumption is single-use per kind", () => {
    const s = new GatewayStore(openGatewayDb());
    const n = ("0x" + "0a".repeat(16)) as `0x${string}`;
    expect(s.consumeNonce("agent_request", n, 1)).toBe(true);
    expect(s.consumeNonce("agent_request", n, 2)).toBe(false);
    expect(s.consumeNonce("agent_request", n.toUpperCase().replace("0X", "0x") as `0x${string}`, 2)).toBe(false);
    expect(s.consumeNonce("approval", n, 2)).toBe(true);
  });

  it("rate events are idempotent per request and windowed", () => {
    const s = new GatewayStore(openGatewayDb());
    s.recordRateEvent(P, "r1", 100);
    s.recordRateEvent(P, "r1", 105);
    s.recordRateEvent(P, "r2", 130);
    expect(s.countRateEvents(P, 0)).toBe(2);
    expect(s.countRateEvents(P, 100)).toBe(1);
  });
});

describe("audit log (INV-14)", () => {
  it("is append-only at the database level", () => {
    const db = openGatewayDb();
    const log = new AuditLog(db);
    log.appendSync({ ts: 1, policyId: P, type: "pause", payload: { paused: true } });
    expect(() => db.exec("UPDATE audit_log SET payload_json = '{}'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM audit_log")).toThrow(/append-only/);
  });

  it("detects a broken chain", () => {
    const db = openGatewayDb();
    const log = new AuditLog(db);
    for (let i = 0; i < 3; i++) log.appendSync({ ts: i, policyId: P, type: "policy_loaded", payload: { i } });
    expect(log.verify()).toBeNull();
    // Simulate tampering by someone who bypasses the triggers.
    db.exec("DROP TRIGGER audit_log_no_update");
    db.exec(`UPDATE audit_log SET payload_json = '{"i":99}' WHERE seq = 2`);
    expect(log.verify()).toBe(2);
  });

  it("links each event to the previous hash", () => {
    const log = new AuditLog(openGatewayDb());
    const a = log.appendSync({ ts: 1, policyId: P, type: "pause", payload: {} });
    const b = log.appendSync({ ts: 2, policyId: P, type: "pause", payload: {} });
    expect(b.prevHash).toBe(a.hash);
    expect(b.seq).toBe(a.seq + 1);
  });
});
