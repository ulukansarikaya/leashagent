/**
 * Auditor selection for the gateway scripts (SONPLAN.md §10). AUDITOR_PROVIDER:
 *   jev        Jev model at JEV_ENDPOINT (AUDITOR_API_KEY optional) — the production auditor
 *   llm        a general LLM with the same three questions (AUDITOR_API_KEY, AUDITOR_MODEL)
 *   heuristic  (default) deterministic rule-based auditor — FALLBACK / DEMO ONLY, not a model
 * Whatever the provider: timeout, unreachable or out-of-schema output → PENDING 302, and the auditor only runs
 * after the deterministic rules have passed, so it can never override a rule BLOCK (enforced in the gateway).
 */
import type { Auditor } from "@leashagent/shared";
import { GenericLlmAuditor, HeuristicAuditor, JevAuditor } from "@leashagent/auditor";
import { llmFromEnv } from "@leashagent/llm";

export type AuditorLabel = { provider: "jev" | "llm" | "heuristic"; role: "production" | "fallback/demo auditor"; endpoint?: string };

export function gatewayAuditor(env: NodeJS.ProcessEnv = process.env): { auditor: Auditor; label: AuditorLabel } {
  const provider = env.AUDITOR_PROVIDER ?? "heuristic";
  if (provider === "jev") {
    const endpoint = env.JEV_ENDPOINT;
    if (!endpoint) throw new Error("AUDITOR_PROVIDER=jev requires JEV_ENDPOINT");
    return { auditor: new JevAuditor(endpoint, env.AUDITOR_API_KEY), label: { provider: "jev", role: "production", endpoint: new URL(endpoint).origin } };
  }
  if (provider === "llm") {
    const llm = llmFromEnv("AUDITOR");
    if (!llm) throw new Error("AUDITOR_PROVIDER=llm requires AUDITOR_API_KEY");
    return { auditor: new GenericLlmAuditor(llm), label: { provider: "llm", role: "production" } };
  }
  if (provider !== "heuristic") throw new Error(`AUDITOR_PROVIDER=${provider}: use jev, llm or heuristic`);
  return { auditor: new HeuristicAuditor(), label: { provider: "heuristic", role: "fallback/demo auditor" } };
}
