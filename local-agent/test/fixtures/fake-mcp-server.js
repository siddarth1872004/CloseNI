/*
 * An MCP server that speaks just enough JSON-RPC to test the client, and does
 * nothing else. FAKE_MCP_MODE selects the failure being exercised.
 *
 * A fake proves the framing and the failure handling. It does NOT prove this
 * client and a real server agree - that is recorded as unverified.
 */
const readline = require("readline");
const mode = process.env.FAKE_MCP_MODE || "ok";

if (mode === "exit") process.exit(3);

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

readline.createInterface({ input: process.stdin }).on("line", function (line) {
  if (mode === "silent") return;
  if (mode === "garbage") { process.stdout.write("not json at all\n"); return; }
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "fake" } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "fetch" }, { name: "search" }] } });
  } else if (msg.method === "tools/call") {
    if (mode === "error") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "tool exploded" } });
    } else {
      send({ jsonrpc: "2.0", id: msg.id,
        result: { content: [{ type: "text", text: "ARGS:" + JSON.stringify(msg.params.arguments) }] } });
    }
  }
});
