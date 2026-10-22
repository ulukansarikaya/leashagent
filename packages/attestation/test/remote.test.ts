import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "@leashagent/shared";
import { AttestedSignerRegistry, RemoteAttestationProvider, SimulatedTee, attestOnce } from "../src";

// A gateway on "another host": answers POST /v1/attestation {nonce} with fresh evidence for its own signer.
const SERVICE = "leashagent-gateway";
const tee = new SimulatedTee({ label: "remote-build" });
const gatewaySigner = privateKeyToAccount(generatePrivateKey()).address;
const inside = tee.provider(gatewaySigner, SERVICE);
let mode: "honest" | "other-signer" | "other-nonce" = "honest";
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const { nonce } = JSON.parse(body) as { nonce: Hex };
    const ev = mode === "other-signer"
      ? await tee.provider(privateKeyToAccount(generatePrivateKey()).address, SERVICE).attest(nonce)
      : await inside.attest(mode === "other-nonce" ? (`0x${"22".repeat(32)}` as Hex) : nonce);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(ev));
  });
});
let url = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

describe("remote attestation (executor on a separate host)", () => {
  const registry = () => new AttestedSignerRegistry({
    serviceId: SERVICE, allowedMeasurements: [tee.measurement], maxAgeSec: 60, verifiers: { simulated: tee.verifier() },
  });

  it("the executor challenges the gateway over HTTP and accepts its signer", async () => {
    mode = "honest";
    const reg = registry();
    expect((await attestOnce(reg, new RemoteAttestationProvider(url, gatewaySigner, "simulated"))).ok).toBe(true);
    expect(await reg.isAuthorizedSigner(gatewaySigner)).toBe(true);
  });

  it("evidence for another signer is refused before verification", async () => {
    mode = "other-signer";
    await expect(attestOnce(registry(), new RemoteAttestationProvider(url, gatewaySigner, "simulated"))).rejects.toThrow(/unexpected signer/);
  });

  it("an answer to a different challenge is refused", async () => {
    mode = "other-nonce";
    await expect(attestOnce(registry(), new RemoteAttestationProvider(url, gatewaySigner, "simulated"))).rejects.toThrow(/another challenge/);
  });
});
