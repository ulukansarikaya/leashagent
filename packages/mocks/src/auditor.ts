import type { AuditorInput, AuditorOutput, Dec } from "@leashagent/shared";

export type MockAuditorMode = "ok" | "timeout" | "throw" | "garbage";

/** Mock of Person 2's Jev / GenericLlm auditor adapter (§10). */
export class MockAuditor {
  mode: MockAuditorMode = "ok";
  readonly calls: AuditorInput[] = [];
  output: Omit<AuditorOutput, "latencyMs" | "provider"> = {
    consistency: "0.9",
    injectionSuspicion: "0.05",
    verdict: { allow: "0.9", block: "0.05", askHuman: "0.05" },
  };

  set(verdict: { allow: Dec; block: Dec; askHuman: Dec }, extra: Partial<{ consistency: Dec; injectionSuspicion: Dec }> = {}) {
    this.output = { ...this.output, ...extra, verdict };
  }

  async decide(input: AuditorInput, opts: { timeoutMs: number }): Promise<AuditorOutput> {
    this.calls.push(input);
    switch (this.mode) {
      case "timeout":
        await new Promise((r) => setTimeout(r, opts.timeoutMs + 50));
        return { ...this.output, latencyMs: opts.timeoutMs + 50, provider: "mock" };
      case "throw":
        throw new Error("auditor down");
      case "garbage":
        return { consistency: 0.9, verdict: "allow" } as unknown as AuditorOutput;
      default:
        return { ...this.output, latencyMs: 5, provider: "mock" };
    }
  }
}
