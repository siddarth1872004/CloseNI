#!/usr/bin/env node
/*
 * Does our hand-written MCP client agree with a real server?
 *
 *   npm run mcp:interop
 *
 * Deliberately NOT in the unit suite. That suite runs offline in milliseconds
 * against a scripted fake, which proves the framing and every failure path; this
 * downloads a real server over the network and takes tens of seconds. Two
 * different jobs, kept apart so the fast one stays fast and the honest one stays
 * honest.
 *
 * The fake proves we handle a server that misbehaves. Only this proves we speak
 * the protocol a real implementation speaks.
 */
import { createRequire } from "node:module";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const M = require_(join(ROOT, "local-agent", "dist", "mcp", "mcp-client.js"));

// The reference server from the protocol's own authors, using the official SDK.
const SERVER = { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] };
const TIMEOUT = 120000;

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log("   ok   " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "  (" + detail + ")" : "")); }
}

console.log("\n  MCP interoperability — against a real server\n  " + "-".repeat(56));

const listed = await M.listTools(SERVER, TIMEOUT);
check("tools/list completes", listed.ok, listed.error);
check("and returns tools", (listed.tools || []).length > 0, JSON.stringify(listed.tools));
check("including the echo tool we call below", (listed.tools || []).includes("echo"));

const called = await M.callTool(SERVER, "echo", { message: "closeni-interop" }, TIMEOUT);
check("tools/call completes", called.ok, called.error);
check("arguments reach the tool", /closeni-interop/.test(called.text || ""), called.text);
check("text content is extracted from the real result shape",
  typeof called.text === "string" && called.text.length > 0);

// A tool that does not exist must come back as a reported error, not a hang or
// a throw - the same contract the fake covers.
const missing = await M.callTool(SERVER, "no-such-tool-xyz", {}, TIMEOUT);
check("an unknown tool is reported rather than thrown", missing.ok === false && !!missing.error, missing.error);

console.log("  " + "-".repeat(56));
console.log("  " + (fail === 0 ? "PASS" : "FAIL") + " — " + pass + " passed, " + fail + " failed\n");
process.exit(fail === 0 ? 0 : 1);
