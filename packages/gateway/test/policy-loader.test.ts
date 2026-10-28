import { describe, expect, it } from "vitest";
import { loadVerifiedPolicy } from "@leashagent/chain";
import { MockPolicyChain, mockPolicy } from "@leashagent/mocks";
import { GatewayStore, PolicyLoader, openGatewayDb } from "../src";

function setup(opts: { refreshAfterSec?: number; cacheTtlSec?: number } = {}) {
  let now = Math.floor(Date.now() / 1000);
  const clock = () => now;
  const store = new GatewayStore(openGatewayDb());
  const chain = new MockPolicyChain();
  const policy = mockPolicy("0x2222222222222222222222222222222222222222", {}, now);
  chain.publish(policy);
  let rpc = 0;
  const loader = new PolicyLoader({
    store, clock, cacheTtlSec: opts.cacheTtlSec ?? 30,
    ...(opts.refreshAfterSec !== undefined ? { refreshAfterSec: opts.refreshAfterSec } : {}),
    verify: (id) => { rpc++; return loadVerifiedPolicy(chain, id, { now: clock() }); },
  });
  return { store, chain, loader, id: policy.binding.policyId, rpcs: () => rpc, advance: (s: number) => { now += s; } };
}

describe("PolicyLoader over @leashagent/chain loadVerifiedPolicy", () => {
  it("verified cache serves orders without a live RPC inside the refresh window", async () => {
    const t = setup({ refreshAfterSec: 10 });
    expect((await t.loader.load(t.id)).ok).toBe(true);
    for (let i = 0; i < 5; i++) expect(await t.loader.load(t.id)).toMatchObject({ ok: true, p: { source: "cache" } });
    expect(t.rpcs()).toBe(1);
    t.advance(10);
    expect(await t.loader.load(t.id)).toMatchObject({ ok: true, p: { source: "chain" } });
    expect(await t.loader.load(t.id, { fresh: true })).toMatchObject({ ok: true, p: { source: "chain" } });
    expect(t.rpcs()).toBe(3);
  });

  it("chain or policyURI unreachable: verified cache within TTL, then fail closed", async () => {
    const t = setup({ refreshAfterSec: 0 });
    await t.loader.load(t.id);
    t.chain.failing = true;
    expect(await t.loader.load(t.id)).toMatchObject({ ok: true, p: { source: "cache" } });
    t.chain.failing = false;
    t.chain.docFailing = true;
    expect(await t.loader.load(t.id)).toMatchObject({ ok: true, p: { source: "cache" } });
    t.advance(31);
    expect(await t.loader.load(t.id)).toMatchObject({ ok: false, reason: "fetch_failed" });
  });

  it("no verified cache and policyURI unreachable -> fail closed", async () => {
    const t = setup();
    t.chain.docFailing = true;
    expect(await t.loader.load(t.id)).toMatchObject({ ok: false, reason: "fetch_failed" });
  });

  it("hash mismatch is never covered by the cache (INV-11)", async () => {
    const t = setup({ refreshAfterSec: 0 });
    await t.loader.load(t.id);
    t.chain.tamperDocument(t.id, (p) => { p.limits.maxOrderNotionalUsdt = "999999"; });
    expect(await t.loader.load(t.id)).toMatchObject({ ok: false, reason: "hash_mismatch" });
  });

  it("revocation marks the cached delegation inactive so L3 rejects", async () => {
    const t = setup({ refreshAfterSec: 0 });
    await t.loader.load(t.id);
    t.chain.setRevoked(t.id, true);
    expect(await t.loader.load(t.id)).toMatchObject({ ok: false, reason: "revoked" });
    expect(t.store.getPolicy(t.id)?.revoked).toBe(true);
  });

  it("unknown policy", async () => {
    const t = setup();
    expect(await t.loader.load(("0x" + "99".repeat(32)) as `0x${string}`)).toMatchObject({ ok: false, reason: "unknown_policy" });
  });
});
