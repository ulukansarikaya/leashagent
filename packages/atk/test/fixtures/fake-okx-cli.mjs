// Fake `okx` CLI: mimics @okx_ai/okx-trade-cli output (stdout JSON with --json; errors as text on stderr, exit 1).
const all = process.argv.slice(2);
const mode = all.find((a) => a.startsWith("--fake-mode="))?.split("=")[1] ?? "ok";
const args = all.filter((a) => !a.startsWith("--fake-mode="));
const get = (f) => { const i = args.indexOf(`--${f}`); return i >= 0 ? args[i + 1] : undefined; };
const fail = (lines) => { process.stderr.write(lines.join("\n") + "\nVersion: @okx_ai/okx-trade-cli@0.0.0\n"); process.exitCode = 1; };

if (args[0] === "spot" && args[1] === "place") {
  if (mode === "network") fail(["Error: fetch failed", "Hint: Please check network connectivity and retry the request in a few seconds."]);
  else if (mode === "reject") fail(["Error: Insufficient balance", "Code: 51008", "TraceId: abc"]);
  else if (mode === "weird") fail(["Error: something odd"]);
  else if (mode === "badjson") process.stdout.write("not json");
  else process.stdout.write(JSON.stringify({ endpoint: "POST /api/v5/trade/order", requestTime: "t", data: [{ ordId: "777", clOrdId: get("clOrdId"), sCode: "0", sMsg: "", argv: args }] }));
} else if (args[0] === "spot" && args[1] === "get") {
  process.stdout.write(JSON.stringify({ endpoint: "GET", requestTime: "t", data: [{ ordId: "777", clOrdId: get("clOrdId"), instId: get("instId"), state: "filled", accFillSz: "0.001" }] }));
} else {
  fail(["Error: unknown command"]);
}
