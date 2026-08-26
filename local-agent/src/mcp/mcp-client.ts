/**
 * MCP over stdio, in about a hundred lines.
 *
 * This needs exactly three methods - initialize, tools/list, tools/call -
 * against a well-specified protocol. Taking the official SDK for three methods
 * would be the larger commitment in a project whose only runtime dependencies
 * are Playwright and Electron.
 *
 * Nothing here throws at the caller. A server that will not start, one that
 * answers with an error, one that never answers at all: each comes back as
 * { ok: false } with a message. A build must not fail because an optional
 * context source was unavailable - the model simply gets less context, which is
 * the situation today.
 */
import { spawn, ChildProcess } from "child_process";

export const MCP_TIMEOUT_MS = 20000;

export interface ServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ToolResult {
  ok: boolean;
  text: string;
  error?: string;
}

/** The text blocks of an MCP tool result. Pure, so it is tested directly. */
export function textFromResult(result: any): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as any).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n");
}

/**
 * One request against a freshly started server.
 *
 * A process per call, deliberately. Keeping servers alive between calls means
 * owning their lifetime - restarting a crashed one, killing them when a build
 * ends, deciding what happens when the app closes mid-call - and these calls
 * happen once per build. A subprocess launch is cheaper than a process pool.
 */
function rpc(
  server: ServerSpec,
  method: string,
  params: any,
  timeoutMs: number,
): Promise<{ ok: boolean; result?: any; error?: string }> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    let settled = false;
    let buffer = "";
    let nextId = 1;
    const pending = new Map<number, (msg: any) => void>();

    const done = (r: { ok: boolean; result?: any; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (proc) proc.kill(); } catch { /* already gone */ }
      resolve(r);
    };

    const timer = setTimeout(
      () => done({ ok: false, error: "the MCP server timed out after " + timeoutMs + "ms" }),
      timeoutMs);

    try {
      proc = spawn(server.command, server.args || [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: Object.assign({}, process.env, server.env || {}),
      });
    } catch (e: any) {
      done({ ok: false, error: "could not start the MCP server: " + (e && e.message) });
      return;
    }

    proc.on("error", (e: any) =>
      done({ ok: false, error: "could not start the MCP server: " + (e && e.message) }));
    proc.on("close", (code) =>
      done({ ok: false, error: "the MCP server exited (code " + code + ") before answering" }));

    const send = (m: string, p: any): Promise<any> =>
      new Promise((res) => {
        const id = nextId++;
        pending.set(id, res);
        try { proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p }) + "\n"); }
        catch { /* the close handler reports it */ }
      });

    proc.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: any;
        // Malformed output is skipped rather than fatal: the timeout is what
        // eventually reports a server that only ever emits noise.
        try { msg = JSON.parse(line); } catch { continue; }
        const waiter = pending.get(msg && msg.id);
        if (waiter) { pending.delete(msg.id); waiter(msg); }
      }
    });

    void (async () => {
      const init = await send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "CloseNI", version: "0.1.0" },
      });
      if (settled) return;
      if (init && init.error) {
        done({ ok: false, error: "initialize failed: " + (init.error.message || "") });
        return;
      }
      try { proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); }
      catch { /* reported by the close handler */ }

      const answer = await send(method, params);
      if (settled) return;
      if (answer && answer.error) {
        done({ ok: false, error: answer.error.message || "the server returned an error" });
        return;
      }
      done({ ok: true, result: answer && answer.result });
    })();
  });
}

/**
 * What tools a server offers.
 *
 * The third of the three methods. callTool does not use it - a configured call
 * already names its tool - but the Settings panel needs it to show the user
 * what they can call, and a client that could not answer that would push
 * everyone back to reading a server's README.
 */
export async function listTools(
  server: ServerSpec,
  timeoutMs: number = MCP_TIMEOUT_MS,
): Promise<{ ok: boolean; tools: string[]; error?: string }> {
  const r = await rpc(server, "tools/list", {}, timeoutMs);
  if (!r.ok) return { ok: false, tools: [], error: r.error };
  const tools = r.result && Array.isArray(r.result.tools)
    ? r.result.tools.map((t: any) => (t && typeof t.name === "string" ? t.name : "")).filter(Boolean)
    : [];
  return { ok: true, tools: tools };
}

export async function callTool(
  server: ServerSpec,
  tool: string,
  args: any,
  timeoutMs: number = MCP_TIMEOUT_MS,
): Promise<ToolResult> {
  const r = await rpc(server, "tools/call", { name: tool, arguments: args || {} }, timeoutMs);
  if (!r.ok) return { ok: false, text: "", error: r.error };
  const text = textFromResult(r.result);
  return text
    ? { ok: true, text: text }
    : { ok: false, text: "", error: "the tool returned no text content" };
}
