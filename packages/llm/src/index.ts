/**
 * Minimal, tool-less LLM client. Every call is a single stateless request:
 * no tools, no shared history — callers get text back and must schema-validate it.
 */
export interface LlmClient {
  complete(req: { system: string; user: string; maxTokens?: number; timeoutMs?: number }): Promise<string>;
}

export type AnthropicConfig = { apiKey: string; model?: string; baseUrl?: string };

export class AnthropicClient implements LlmClient {
  constructor(private cfg: AnthropicConfig) {}

  async complete(req: { system: string; user: string; maxTokens?: number; timeoutMs?: number }): Promise<string> {
    const res = await fetch(`${this.cfg.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      signal: AbortSignal.timeout(req.timeoutMs ?? 20_000),
      headers: {
        "content-type": "application/json",
        "x-api-key": this.cfg.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.cfg.model ?? "claude-sonnet-5-5",
        max_tokens: req.maxTokens ?? 1024,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
      }),
    });
    if (!res.ok) throw new Error(`llm http ${res.status}`);
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    return (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  }
}

/** Extract the first JSON object from a model reply. Throws if none parses. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(text.slice(start, end + 1));
}

/** Build a client from env (`<PREFIX>_API_KEY`, `<PREFIX>_MODEL`), or undefined if no key. */
export function llmFromEnv(prefix: string): LlmClient | undefined {
  const apiKey = process.env[`${prefix}_API_KEY`];
  if (!apiKey) return undefined;
  return new AnthropicClient({ apiKey, model: process.env[`${prefix}_MODEL`], baseUrl: process.env[`${prefix}_BASE_URL`] });
}
