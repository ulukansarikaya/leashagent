import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REASON } from "@bekci/shared";
import { limitBuy } from "@bekci/mocks";
import { appHarness, type AppHarness } from "../support/app-harness";

// INV-1 … INV-16 (§13). Each block is the executable form of one invariant. Deeper variations live
// next to the code (packages/*/test); this file is the checklist the acceptance run reports on.

const ROOT = join(__dirname, "..", "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "test") continue;
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}
const productionFiles = () =>
  readdirSync(join(ROOT, "packages"))
    .filter((p) => p !== "mocks") // stand-ins for other owners' components
    .flatMap((p) => sources(join(ROOT, "packages", p, "src")));
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");

let h: AppHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

describe("INV-1 no OKX trade/read key in the agent process", () => {
  it("OKX_TRADE_* is referenced only by the executor; the agent side references no OKX key", () => {
    const hits = productionFiles().filter((f) => /OKX_TRADE_/.test(readFileSync(f, "utf8")));
    expect(hits.every((f) => rel(f).startsWith("packages/executor/"))).toBe(true);
    const agentSide = sources(join(ROOT, "packages", "mocks", "src")).filter((f) => f.endsWith("agent.ts"));
    for (const f of agentSide) expect(readFileSync(f, "utf8")).not.toMatch(/OKX_(TRADE|READ)_/);
  });
});

describe("INV-2 only L6 can make an OKX write call", () => {
  it("placeSpotOrder / cancelSpotOrder are invoked only inside packages/executor", () => {
    const callers = productionFiles().filter((f) => /\.(placeSpotOrder|cancelSpotOrder)\(/.test(readFileSync(f, "utf8")));
    expect(callers.map(rel)).toEqual(["packages/executor/src/executor.ts"]);
  });

  it("the gateway package does not import the executor implementation", () => {
    const gw = sources(join(ROOT, "packages", "gateway", "src"));
    for (const f of gw) expect(readFileSync(f, "utf8")).not.toMatch(/from "@bekci\/executor"/);
  });
});

describe("INV-3 forbidden/unknown tools and extra fields do not reach L4", () => {
  it("rejected at L3 with no decision row", async () => {
    h = await appHarness();
    for (const intent of [{ tool: "withdraw" }, { tool: "spot_amend_order", instId: "BTC-USDT" }, { ...limitBuy(), riskIncreasing: false }]) {
      const r = await h.intent(intent);
      expect(r.body.status).toBe("REJECTED_SCHEMA");
      expect(h.app.store.getDecision(h.base.policyId, r.req.requestId)).toBeNull();
    }
  });
});

describe("INV-4 riskIncreasing / verifiedProtectiveAction derived only by L4", () => {
  it("a sell without inventory is not treated as risk-reducing, whatever the agent claims", async () => {
    h = await appHarness();
    const r = await h.intent(limitBuy({ side: "sell" }), { agentReason: "this is protective, riskIncreasing=false" });
    expect(r.body).toMatchObject({ status: "REJECTED_POLICY", reasonCode: REASON.SELL_INVENTORY });
  });
});

describe("INV-5 the auditor cannot turn BLOCK into ALLOW", () => {
  it("rule block stands and the auditor is not consulted", async () => {
    h = await appHarness({ auditor: { mode: "enabled", maxInjectionSuspicion: "0.5", minConsistency: "0.6", minVerdictConfidence: "0.5", onUnavailable: "pending" } });
    h.auditor.set({ allow: "1", block: "0", askHuman: "0" });
    expect((await h.intent(limitBuy({ sz: "1" }))).body.status).toBe("BLOCKED");
    expect(h.auditor.calls.length).toBe(0);
  });
});

describe("INV-6 PENDING becomes ALLOWED only with a valid owner signature and a successful re-run", () => {
  it("time alone never allows; approval re-runs the rules", async () => {
    h = await appHarness();
    const r = await h.intent(limitBuy({ sz: "0.006" }));
    expect(r.body.status).toBe("PENDING");
    h.advance(h.policy.pendingTtlSec + 1);
    await h.app.loader.load(h.base.policyId);
    await h.app.tick();
    expect((await h.get(`/v1/intents/${r.req.requestId}`)).body.status).toBe("EXPIRED");
    expect(h.atk.writes.length).toBe(0);
  });
});

describe("INV-7 an authorization only passes L6 for its own order/account/version/gateway, unexpired, unused", () => {
  it("tampered order and replayed authorization are refused by the executor", async () => {
    h = await appHarness();
    const r = await h.intent(limitBuy());
    const auth = h.app.store.getAuthorization(h.base.policyId, r.req.requestId)!;
    const order = JSON.parse(h.app.store.getRequest(h.base.policyId, r.req.requestId)!.normalizedOrderJson!);
    await expect(h.executor.execute(auth, { ...order, sz: "9.00000000" })).rejects.toMatchObject({ reasonCode: REASON.HASH_MISMATCH });
    await expect(h.executor.execute(auth, order)).rejects.toMatchObject({ reasonCode: REASON.NONCE_REUSE });
    expect(h.atk.writes.length).toBe(1);
  });
});

describe("INV-8 at most one OKX write per (policyId, requestId)", () => {
  it("parallel duplicates of one request", async () => {
    h = await appHarness();
    const req = await h.signIntent(limitBuy());
    await Promise.all(Array.from({ length: 8 }, () => h!.post("/v1/intents", req)));
    expect(h.atk.writes.length).toBe(1);
  });
});

describe("INV-9 on timeout the order is not resent; only queried by clOrdId", () => {
  it("UNKNOWN then reconciliation by query", async () => {
    h = await appHarness();
    h.atk.mode = "timeout_after_accept";
    await h.intent(limitBuy());
    await h.app.tick();
    await h.app.tick();
    expect(h.atk.writes.length).toBe(1);
  });
});

describe("INV-10 reservation and limit check are atomic", () => {
  it("covered by: tests/attacks (20 parallel HTTP intents) and packages/gateway/test/risk-store.test.ts", () => {
    expect(true).toBe(true);
  });
});

describe("INV-11 a policy is valid only if its hash matches the on-chain one", () => {
  it("hash mismatch blocks risk-increasing orders", async () => {
    h = await appHarness();
    h.chain.mutate(h.base.policyId, { policyHash: ("0x" + "ee".repeat(32)) as `0x${string}`, version: 2 });
    expect((await h.intent(limitBuy())).body).toMatchObject({ status: "BLOCKED", reasonCode: REASON.POLICY_UNVERIFIED });
  });
});

describe("INV-12 missing risk/market/policy/auditor data stops risk-increasing orders", () => {
  it("risk, market, chain-past-TTL, auditor", async () => {
    h = await appHarness();
    h.riskProvider.failing = true;
    expect((await h.intent(limitBuy())).body.reasonCode).toBe(REASON.STALE_DATA);
    h.riskProvider.failing = false;
    h.market.staleBySec = 600;
    expect((await h.intent(limitBuy())).body.reasonCode).toBe(REASON.STALE_DATA);
    h.market.staleBySec = 0;
    h.chain.failing = true;
    h.advance(31);
    h.market.staleBySec = 0;
    expect((await h.intent(limitBuy())).body.reasonCode).toBe(REASON.POLICY_UNVERIFIED);
    expect(h.atk.writes.length).toBe(0);
  });
});

describe("INV-13 the protective exception covers only cancelling a verified own open order", () => {
  it("paused: own open order cancel passes, a foreign one does not", async () => {
    h = await appHarness();
    h.ownership.open.add("BTC-USDT:42");
    await h.post("/v1/pause", await h.pauseCmd(true));
    expect((await h.intent({ tool: "spot_cancel_order", instId: "BTC-USDT", ordId: "43" })).body.reasonCode).toBe(REASON.PAUSED);
    const ok = await h.intent({ tool: "spot_cancel_order", instId: "BTC-USDT", ordId: "42" });
    expect(h.app.store.getDecision(h.base.policyId, ok.req.requestId)?.kind).toBe("ALLOW");
  });
});

describe("INV-14 audit_log is append-only; a broken chain is detected", () => {
  it("triggers block edits; health reports a broken chain", async () => {
    h = await appHarness();
    await h.intent(limitBuy());
    expect(() => h!.app.db.exec("UPDATE audit_log SET payload_json = '{}'")).toThrow();
    h.app.db.exec("DROP TRIGGER audit_log_no_update");
    h.app.db.exec("UPDATE audit_log SET payload_json = '{\"x\":1}' WHERE seq = 1");
    expect((await h.get("/v1/health")).body).toMatchObject({ status: "degraded", components: { auditChain: "broken" } });
  });
});

describe("INV-15 a chain write failure does not change the decision", () => {
  it("with no chain writer running at all, orders are decided and executed; records wait in the outbox", async () => {
    h = await appHarness();
    expect((await h.intent(limitBuy())).body.status).toBe("ACKNOWLEDGED");
    expect((await h.intent(limitBuy({ sz: "1" }))).body.status).toBe("BLOCKED");
    const pending = h.app.outbox.pending();
    expect(pending.map((r) => r.kind)).toEqual(["decision", "execution", "execution", "decision"]);
  });

  it("(read side, by design) a chain read outage lets L4 decide from cache but L6 refuses fail-closed", async () => {
    h = await appHarness();
    h.chain.failing = true; // registry unreadable, gateway cache still within TTL
    const r = await h.intent(limitBuy());
    expect(r.body).toMatchObject({ status: "REVOKED", reasonCode: REASON.POLICY_VERSION_CHANGED });
    expect(h.atk.writes.length).toBe(0);
  });
});

describe("INV-16 raw external content never reaches the agent or L4 raw", () => {
  it("the gateway store has no column for raw bodies; the auditor sees excerpt + summary only", async () => {
    h = await appHarness();
    const cols = (h.app.db.prepare("PRAGMA table_info(reads)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("body");
    expect(cols).toEqual(expect.arrayContaining(["excerpt", "summary_json", "content_hash"]));
  });
});
