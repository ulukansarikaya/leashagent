// Fake `okx-trade-mcp`: speaks MCP over stdio and answers with ATK-shaped payloads
// (success: { tool, ok, data: { endpoint, requestTime, data } }; error: isError + toToolErrorPayload).
// Behaviour is selected with FAKE_MODE (read from the env the transport passes — which also lets
// tests check that only OKX_* variables reach the child).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const argv = process.argv.slice(2);
const mode = (argv.find((a) => a.startsWith("--fake-mode="))?.split("=")[1]) ?? "ok";
const readOnly = argv.includes("--read-only");
const modules = argv[argv.indexOf("--modules") + 1] ?? "";

const orders = new Map(); // clOrdId -> order
let seq = 5000;

const ok = (tool, endpoint, data) => {
  const payload = { tool, ok: true, data: { endpoint, requestTime: new Date().toISOString(), data } };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
};
const err = (tool, type, message, code) => {
  const payload = { error: true, type, code, message, tool, timestamp: new Date().toISOString() };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
};

const tools = ["spot_get_order", "debug_env"];
if (!readOnly) tools.push("spot_place_order", "spot_cancel_order");

const server = new Server({ name: "fake-okx-trade-mcp", version: "0.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params;
  const a = req.params.arguments ?? {};
  if (name === "debug_env") {
    return ok(name, "debug", [{
      keys: Object.keys(process.env).filter((k) => k.startsWith("OKX_") || k.startsWith("SECRET") || k === "LEAKED_SECRET").sort(),
      demo: process.env.OKX_DEMO, site: process.env.OKX_SITE, hasKey: !!process.env.OKX_API_KEY, modules, readOnly,
    }]);
  }
  if (!tools.includes(name)) return err(name, "InternalError", `tool ${name} not available`);

  if (name === "spot_place_order") {
    if (mode === "hang") return new Promise(() => {});
    if (mode === "network") return err(name, "NetworkError", "fetch failed");
    if (mode === "http502") return err(name, "OkxApiError", "Bad Gateway", "502");
    if (mode === "timeout50004") return err(name, "OkxApiError", "API endpoint request timeout", "50004");
    if (mode === "reject") return err(name, "OkxApiError", "All operations failed", "1");
    if (mode === "crash") process.exit(1);
    if (a.tdMode !== "cash") return err(name, "ValidationError", "tdMode must be cash for this fake");
    if (typeof a.clOrdId !== "string" || a.clOrdId.length > 32) return err(name, "OkxApiError", "clOrdId invalid", "51000");
    if (orders.has(a.clOrdId)) return err(name, "OkxApiError", "Duplicated clOrdId", "51016");
    const ordId = String(++seq);
    orders.set(a.clOrdId, { ordId, clOrdId: a.clOrdId, instId: a.instId, state: a.ordType === "market" ? "filled" : "live",
      accFillSz: a.ordType === "market" ? a.sz : "0", tgtCcy: a.tgtCcy, sz: a.sz });
    return ok(name, "POST /api/v5/trade/order", [{ ordId, clOrdId: a.clOrdId, sCode: "0", sMsg: "Order placed", tag: "MCP" }]);
  }
  if (name === "spot_cancel_order") {
    const o = [...orders.values()].find((x) => x.ordId === a.ordId || x.clOrdId === a.clOrdId);
    if (!o || o.state !== "live") return err(name, "OkxApiError", "Order does not exist", "51400");
    o.state = "canceled";
    return ok(name, "POST /api/v5/trade/cancel-order", [{ ordId: o.ordId, clOrdId: o.clOrdId, sCode: "0", sMsg: "" }]);
  }
  if (name === "spot_get_order") {
    if (mode === "queryfail") return err(name, "NetworkError", "fetch failed");
    const o = orders.get(a.clOrdId);
    if (!o) return err(name, "OkxApiError", "Order does not exist", "51603");
    return ok(name, "GET /api/v5/trade/order", [{ ...o }]);
  }
  return err(name, "InternalError", "unhandled");
});

await server.connect(new StdioServerTransport());
