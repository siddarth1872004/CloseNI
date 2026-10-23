/**
 * The MCP calls a build should make, and their results.
 *
 * Once per build, not per step. A schema or a page of documentation does not
 * change while a build runs, and re-fetching it twenty times would cost twenty
 * subprocess launches for identical text.
 *
 * Planning is split from running, as check-planner splits, so every decision
 * about what to call is tested without launching anything.
 */
import { callTool, ServerSpec } from "./mcp-client.js";

export interface McpCall {
  server: string;
  tool: string;
  args: any;
}

export interface McpConfig {
  servers: Record<string, ServerSpec>;
  calls: McpCall[];
}

/** Anything unreadable is "no MCP configured", which is the common case. */
export function parseMcpConfig(raw: any): McpConfig {
  let obj = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch { return { servers: {}, calls: [] }; }
  }
  if (!obj || typeof obj !== "object") return { servers: {}, calls: [] };

  const servers: Record<string, ServerSpec> = {};
  const src = obj.servers && typeof obj.servers === "object" ? obj.servers : {};
  for (const name of Object.keys(src)) {
    const s = src[name];
    if (!s || typeof s.command !== "string" || !s.command.trim()) continue;
    servers[name] = {
      command: s.command.trim(),
      args: Array.isArray(s.args) ? s.args.filter((a: any) => typeof a === "string") : [],
      env: s.env && typeof s.env === "object" ? s.env : {},
    };
  }

  const calls: McpCall[] = [];
  for (const c of Array.isArray(obj.calls) ? obj.calls : []) {
    if (!c || typeof c.server !== "string" || typeof c.tool !== "string") continue;
    calls.push({ server: c.server, tool: c.tool, args: c.args || {} });
  }
  return { servers: servers, calls: calls };
}

/** Only calls whose server actually exists. */
export function planCalls(config: McpConfig): (McpCall & { spec: ServerSpec })[] {
  const cfg = config || { servers: {}, calls: [] };
  return (cfg.calls || [])
    .filter((c) => !!(cfg.servers || {})[c.server])
    .map((c) => Object.assign({}, c, { spec: cfg.servers[c.server] }));
}

/**
 * Run every planned call and collect the text.
 *
 * `run` is injectable so the decisions here are tested without a subprocess.
 * Nothing propagates: a failure becomes a note, and the build gets less context
 * rather than no build.
 */
export async function gatherContext(
  config: McpConfig,
  run: typeof callTool = callTool,
): Promise<{ texts: string[]; notes: string[] }> {
  const texts: string[] = [];
  const notes: string[] = [];
  for (const call of planCalls(config)) {
    try {
      const r = await run(call.spec, call.tool, call.args);
      if (r && r.ok && r.text) texts.push(r.text);
      else notes.push(call.server + "/" + call.tool + ": " + ((r && r.error) || "no text returned"));
    } catch (e: any) {
      notes.push(call.server + "/" + call.tool + ": " + (e && e.message ? e.message : String(e)));
    }
  }
  return { texts: texts, notes: notes };
}
