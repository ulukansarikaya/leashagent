// §25.7 mechanical consistency gate: the frozen TypeScript contract (@leashagent/shared) must agree with the
// Solidity sources, the generated ABI module and the committed ABI JSON. Runs in CI on every push.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CHAIN_VERDICTS, EIP712_TYPES, EXEC_STATUSES, LEASH_DOMAIN, ORDER_STATUSES, Reason, ReasonCodes, isExecTransitionAllowed,
  type PolicyRecord,
} from "@leashagent/shared";
import { decisionLogAbi, policyRegistryAbi } from "../src/index.js";

const root = new URL("../", import.meta.url);
const sol = (name: string) => readFileSync(new URL(`contracts/${name}.sol`, root), "utf8");
const solEnum = (src: string, name: string) =>
  new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`).exec(src)![1]!.split(",").map((s) => s.trim()).filter(Boolean);
const pascal = (s: string) => s.toLowerCase().split("_").map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
const fn = (abi: readonly { type: string; name?: string }[], name: string) => abi.find((x) => x.type === "function" && x.name === name);
const ev = (abi: readonly { type: string; name?: string }[], name: string) => abi.find((x) => x.type === "event" && x.name === name);

describe("§25.7 consistency: shared ↔ Solidity ↔ ABI", () => {
  it("DecisionLog enums match shared order (index = on-chain value)", () => {
    const src = sol("DecisionLog");
    expect(solEnum(src, "Verdict")).toEqual(CHAIN_VERDICTS.map(pascal));
    expect(solEnum(src, "ExecStatus")).toEqual(EXEC_STATUSES.map(pascal));
  });

  it("execution transition table is identical in TS and Solidity", () => {
    const src = sol("DecisionLog");
    // Parse _allowedMask: prev → allowed set, using the short names declared in the contract.
    const short: Record<string, string> = {};
    for (const m of src.matchAll(/uint16 (\w{3}) = uint16\(1\) << uint8\(ExecStatus\.(\w+)\)/g)) short[m[1]!] = m[2]!;
    const names = (expr: string) => expr.split("|").map((s) => short[s.trim()]!).filter(Boolean).sort();
    const table: Record<string, string[]> = {};
    table.none = names(/if \(prev == 0\) return ([^;]+);/.exec(src)![1]!);
    for (const m of src.matchAll(/if \(p == ExecStatus\.(\w+)\) return ([^;]+);/g)) table[m[1]!] = names(m[2]!);
    for (const prev of [null, ...EXEC_STATUSES] as const) {
      const key = prev === null ? "none" : pascal(prev);
      const sol = table[key] ?? [];
      const ts = EXEC_STATUSES.filter((n) => isExecTransitionAllowed(prev, n)).map(pascal).sort();
      expect({ prev: key, allowed: ts }).toEqual({ prev: key, allowed: sol });
    }
  });

  it("PolicyRegistry / DecisionLog public surface matches §7 names", () => {
    for (const f of ["createPolicy", "setPolicy", "setDelegation", "setPaused", "getPolicy", "computePolicyId"]) expect(fn(policyRegistryAbi, f), f).toBeTruthy();
    for (const e of ["PolicyCreated", "PolicyUpdated", "DelegationChanged", "PausedChanged"]) expect(ev(policyRegistryAbi, e), e).toBeTruthy();
    for (const f of ["logDecision", "logExecution", "setLogger", "requestState"]) expect(fn(decisionLogAbi, f), f).toBeTruthy();
    for (const e of ["DecisionLogged", "ExecutionLogged"]) expect(ev(decisionLogAbi, e), e).toBeTruthy();
  });

  it("getPolicy record fields match shared PolicyRecord", () => {
    const out = (fn(policyRegistryAbi, "getPolicy") as unknown as { outputs: { components: { name: string }[] }[] }).outputs[0]!.components.map((c) => c.name);
    const ts: (keyof PolicyRecord)[] = ["owner", "accountRef", "agentRegistry", "agentRegistryId", "agentAuthAddress", "policyHash", "policyURI", "version", "delegationExpiresAt", "revoked", "paused"];
    expect(out).toEqual(ts);
  });

  it("reason codes fit DecisionLog uint16 and short names alias the canonical table", () => {
    for (const v of Object.values(ReasonCodes)) expect(v >= 0 && v <= 65535).toBe(true);
    const canonical = new Set(Object.values(ReasonCodes));
    for (const v of Object.values(Reason)) expect(canonical.has(v as never)).toBe(true);
    expect(ReasonCodes.PAYMENT_REQUIRED).toBe(4);
    expect(ReasonCodes.INSUFFICIENT_AUTHORIZATION).toBe(2);
  });

  it("EIP-712 domain and message fields are the frozen ones", () => {
    expect(LEASH_DOMAIN).toEqual({ name: "LeashAgent", version: "1", chainId: 43113 });
    expect(EIP712_TYPES.AgentIntent.map((f) => f.name)).toEqual(["requestId", "policyId", "agentId", "issuedAt", "authNonce", "intentHash", "reasonHash"]);
    expect(EIP712_TYPES.ExecutionAuthorization.map((f) => f.name)).toEqual([
      "requestId", "policyId", "policyVersion", "accountRef", "agentId", "tool", "normalizedOrderHash", "nonce", "issuedAt", "expiresAt", "guardInstanceId", "basis",
    ]);
    expect(ORDER_STATUSES).toContain("REJECTED_PAYMENT");
  });

  it("generated abi.ts and committed deployments/abi JSON match the compiled contracts", () => {
    for (const name of ["PolicyRegistry", "DecisionLog"]) {
      const committed = JSON.parse(readFileSync(new URL(`deployments/abi/${name}.json`, root), "utf8"));
      const generated = name === "PolicyRegistry" ? policyRegistryAbi : decisionLogAbi;
      expect(committed, `${name} deployments/abi drift`).toEqual(JSON.parse(JSON.stringify(generated)));
      const out = new URL(`out/${name}.sol/${name}.json`, root);
      if (existsSync(out)) {
        expect(JSON.parse(readFileSync(out, "utf8")).abi, `${name} abi.ts drift — run npm run build:contracts`).toEqual(committed);
      }
    }
  });
});
