import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { computeAttestationReportData, type AttestationEvidence, type Hex } from "@leashagent/shared";
import { AttestedSignerRegistry, SimulatedTee, attestOnce, keepAttested, simulatedMeasurement } from "../src";

const SERVICE = "leashagent-gateway";

function setup(opts: { maxAgeSec?: number; allowed?: Hex[] } = {}) {
  let now = 1_800_000_000;
  const clock = () => now;
  const tee = new SimulatedTee({ label: "build-1" });
  const signer = privateKeyToAccount(generatePrivateKey()).address;
  const registry = new AttestedSignerRegistry({
    serviceId: SERVICE, allowedMeasurements: opts.allowed ?? [tee.measurement], maxAgeSec: opts.maxAgeSec ?? 300,
    verifiers: { simulated: tee.verifier() }, clock,
  });
  return { tee, signer, registry, clock, provider: tee.provider(signer, SERVICE, clock), advance: (s: number) => { now += s; } };
}

describe("TEE Lite — attestation verifier (INV-22 exit conditions)", () => {
  it("accepts a fresh attestation with an expected measurement for the bound signer", async () => {
    const t = setup();
    const r = await attestOnce(t.registry, t.provider);
    expect(r).toMatchObject({ ok: true, accepted: { signer: t.signer, measurement: t.tee.measurement, platform: "simulated" } });
    expect(await t.registry.isAuthorizedSigner(t.signer)).toBe(true);
  });

  it("rejects a wrong (non-allow-listed) measurement", async () => {
    const t = setup({ allowed: [simulatedMeasurement("some-other-build")] });
    expect(await attestOnce(t.registry, t.provider)).toEqual({ ok: false, reason: "measurement_not_allowed" });
    expect(await t.registry.isAuthorizedSigner(t.signer)).toBe(false);
  });

  it("stale attestation: acceptance lapses after maxAgeSec until the signer re-attests", async () => {
    const t = setup({ maxAgeSec: 60 });
    await attestOnce(t.registry, t.provider);
    t.advance(61);
    expect(await t.registry.isAuthorizedSigner(t.signer)).toBe(false);
    expect((await attestOnce(t.registry, t.provider)).ok).toBe(true);
    expect(await t.registry.isAuthorizedSigner(t.signer)).toBe(true);
  });

  it("stale challenge: an answer after the challenge TTL is refused", async () => {
    const t = setup();
    const nonce = t.registry.challenge();
    t.advance(61);
    expect(await t.registry.submit(await t.provider.attest(nonce))).toEqual({ ok: false, reason: "stale_challenge" });
  });

  it("wrong signer: a quote bound to signer A does not authorize signer B", async () => {
    const t = setup();
    const other = privateKeyToAccount(generatePrivateKey()).address;
    const ev = await t.provider.attest(t.registry.challenge());
    expect(await t.registry.submit({ ...ev, signer: other })).toEqual({ ok: false, reason: "report_data_mismatch" });
    expect(await t.registry.isAuthorizedSigner(other)).toBe(false);
    expect(await t.registry.isAuthorizedSigner(t.signer)).toBe(false);
  });

  it("nonce is single-use, and unknown nonces are refused", async () => {
    const t = setup();
    const ev = await t.provider.attest(t.registry.challenge());
    expect((await t.registry.submit(ev)).ok).toBe(true);
    expect(await t.registry.submit(ev)).toEqual({ ok: false, reason: "unknown_nonce" });
    const forged = await t.provider.attest(`0x${"11".repeat(32)}`);
    expect(await t.registry.submit(forged)).toEqual({ ok: false, reason: "unknown_nonce" });
  });

  it("a quote from another root of trust is refused even with the allowed measurement", async () => {
    const t = setup();
    const impostor = new SimulatedTee({ label: "build-1" }); // same measurement, different root key
    expect(impostor.measurement).toBe(t.tee.measurement);
    const ev = await impostor.provider(t.signer, SERVICE, t.clock).attest(t.registry.challenge());
    expect(await t.registry.submit(ev)).toEqual({ ok: false, reason: "quote_invalid" });
  });

  it("evidence for another service, an unsupported platform or a malformed body is refused", async () => {
    const t = setup();
    const ev = await t.tee.provider(t.signer, "another-service", t.clock).attest(t.registry.challenge());
    expect(await t.registry.submit(ev)).toEqual({ ok: false, reason: "wrong_service" });
    const ev2 = await t.provider.attest(t.registry.challenge());
    expect(await t.registry.submit({ ...ev2, platform: "tdx" } satisfies AttestationEvidence)).toEqual({ ok: false, reason: "unsupported_platform" });
    expect(await t.registry.submit({ ...ev2, extra: 1 })).toEqual({ ok: false, reason: "malformed" });
  });

  it("report data binds signer, nonce and service under a domain separator", () => {
    const s = privateKeyToAccount(generatePrivateKey()).address;
    const n = `0x${"ab".repeat(32)}` as Hex;
    const base = computeAttestationReportData(s, n, SERVICE);
    expect(computeAttestationReportData(s, `0x${"ac".repeat(32)}`, SERVICE)).not.toBe(base);
    expect(computeAttestationReportData(s, n, "other")).not.toBe(base);
  });

  it("keepAttested accepts the signer on the first round and reports failures", async () => {
    const t = setup();
    const results: boolean[] = [];
    const loop = await keepAttested(t.registry, t.provider, { everySec: 3600, onResult: (r) => results.push(r.ok) });
    expect(loop.first.ok).toBe(true);
    expect(results).toEqual([true]);
    loop.stop();
  });

  it("refuses to be configured without an allow-list", () => {
    expect(() => new AttestedSignerRegistry({ serviceId: SERVICE, allowedMeasurements: [], maxAgeSec: 60, verifiers: {} })).toThrow();
  });
});
