import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildAtkEnv, type AtkCallResult, type AtkErrorPayload, type AtkProcessEnv, type AtkTransport } from "./types";

export type McpTransportOptions = {
  /** Default: "okx-trade-mcp" (npm i -g @okx_ai/okx-trade-mcp). */
  command?: string;
  /** Prepended before ATK flags (e.g. a script path when command is node). */
  commandArgs?: string[];
  /** ATK modules to load, e.g. ["spot"] for the executor, ["market"] for keyless data. */
  modules: string[];
  readOnly: boolean;
  env: AtkProcessEnv;
  /**
   * Per-call timeout. Keep it above ATK's own HTTP timeout (OKX_TIMEOUT_MS, default 15 s) so we
   * normally see ATK's NetworkError rather than cutting it off; either way a write is "uncertain".
   */
  callTimeoutMs?: number;
};

type ToolResult = { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[] };

function parsePayload(r: ToolResult): Record<string, unknown> | null {
  if (r.structuredContent && typeof r.structuredContent === "object") return r.structuredContent as Record<string, unknown>;
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * ATK over MCP stdio (`okx-trade-mcp`). Errors arrive as structured `toToolErrorPayload` objects
 * with an explicit `type`, which is what makes write outcomes classifiable.
 */
export class McpStdioTransport implements AtkTransport {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(private readonly o: McpTransportOptions) {}

  private args(): string[] {
    const a = [...(this.o.commandArgs ?? []), "--modules", this.o.modules.join(",")];
    if (this.o.readOnly) a.push("--read-only");
    return a;
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const transport = new StdioClientTransport({
          command: this.o.command ?? "okx-trade-mcp",
          args: this.args(),
          env: buildAtkEnv(this.o.env),
          stderr: "pipe",
        });
        const client = new Client({ name: "bekci", version: "0.0.0" });
        await client.connect(transport);
        transport.onclose = () => {
          this.client = null;
          this.connecting = null;
        };
        this.client = client;
        return client;
      })().catch((e) => {
        this.connecting = null;
        throw e;
      });
    }
    return this.connecting;
  }

  async listTools(): Promise<string[]> {
    const c = await this.connect();
    return (await c.listTools()).tools.map((t) => t.name);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<AtkCallResult> {
    const c = await this.connect();
    // Throws on timeout / disconnect -> caller treats a write as uncertain.
    const r = (await c.callTool({ name, arguments: args }, undefined, { timeout: this.o.callTimeoutMs ?? 20_000 })) as ToolResult;
    const payload = parsePayload(r);
    if (!payload) throw new Error("ATK returned an unparseable tool result");
    if (r.isError || payload.error === true) {
      return {
        ok: false,
        error: {
          type: String(payload.type ?? "InternalError"),
          message: String(payload.message ?? "ATK error"),
          ...(payload.code !== undefined ? { code: String(payload.code) } : {}),
          ...(payload.suggestion !== undefined ? { suggestion: String(payload.suggestion) } : {}),
          ...(payload.traceId !== undefined ? { traceId: String(payload.traceId) } : {}),
        } satisfies AtkErrorPayload,
      };
    }
    // ATK success envelope: { tool, ok: true, data: { endpoint, requestTime, data }, ... }
    const inner = payload.data as { endpoint?: string; requestTime?: string; data?: unknown } | undefined;
    if (!inner || typeof inner !== "object" || !("data" in inner)) throw new Error("ATK success result without data");
    return { ok: true, response: { endpoint: inner.endpoint, requestTime: inner.requestTime, data: inner.data } };
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.connecting = null;
    if (c) await c.close();
  }
}
