/**
 * The agent's tools, as the model sees them: read, write, edit, bash, glob,
 * grep, ls and todo.
 *
 * Every path is resolved inside the workspace and refused outside it -
 * including through a symlink - because a model told "the project is here" will
 * still, sooner or later, write "../" or "/etc". Writing inside .git is refused
 * too: nothing a coding task needs is in there, and a corrupted index is the
 * one breakage the user cannot see.
 *
 * Outputs are capped. Everything returned here is typed into a web page as the
 * next message, and a chat composer handed half a megabyte either truncates it
 * or stops responding.
 */
import * as fs from "fs";
import * as path from "path";
import { runCommand } from "../verification/command-runner.js";
import { ToolCall, BadCall, ToolOutcome, EditSection, isBad } from "./protocol.js";

export const MAX_OUTPUT = 24000;
export const MAX_READ_LINES = 2000;
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", ".closeni", ".agent-backups", ".mypy_cache", ".pytest_cache", ".next", ".cache"]);
const MAX_WALK = 20000;

export interface TodoItem { text: string; status: "pending" | "in_progress" | "done" }

export interface ToolContext {
  workspace: string;
  /** Called with a path about to be changed, before it changes. */
  beforeChange?: (abs: string) => void;
  todos: TodoItem[];
  /** Replaces the shell for tests. */
  run?: (command: string, cwd: string, timeoutMs: number) => Promise<{ success: boolean; output: string; timedOut: boolean }>;
}

export interface AgentOutcome extends ToolOutcome {
  /** For the interface: a diff, a command's output, the todo list. */
  detail?: any;
}

export class ToolError extends Error {}

export function resolveInside(workspace: string, p: any): string {
  if (typeof p !== "string" || !p.trim()) throw new ToolError("a path is required");
  const ws = path.resolve(workspace);
  const abs = path.resolve(ws, p.trim());
  const rel = path.relative(ws, abs);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new ToolError(p + " is outside the project; only paths inside " + ws + " can be used");
  }
  // The nearest part of the path that exists must also be inside once links are
  // followed, or "link-to-home/.ssh/config" would pass the check above.
  let probe = abs;
  while (!fs.existsSync(probe) && probe !== ws) probe = path.dirname(probe);
  try {
    const realWs = fs.realpathSync(ws);
    const real = fs.realpathSync(probe);
    if (real !== realWs && !real.startsWith(realWs + path.sep)) throw new ToolError(p + " leads outside the project through a link");
  } catch (e) {
    if (e instanceof ToolError) throw e;
  }
  return abs;
}

function relOf(workspace: string, abs: string): string {
  return path.relative(path.resolve(workspace), abs).split(path.sep).join("/") || ".";
}

function refuseGitInternals(workspace: string, abs: string): void {
  const rel = relOf(workspace, abs);
  if (rel === ".git" || rel.startsWith(".git/")) throw new ToolError("files inside .git are not edited directly; use git through bash");
}

/** Head and tail of long output: errors are usually at the end, context at the start. */
export function cap(text: string, max: number = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  return text.slice(0, head) + "\n\n[... " + (text.length - max) + " characters omitted ...]\n\n" + text.slice(text.length - tail);
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function countLines(s: string): number {
  if (!s) return 0;
  return s.split("\n").length - (s.endsWith("\n") ? 1 : 0);
}

/** Every file under a directory, relative and slash-separated, skipping the usual noise. */
export function walk(root: string, workspace: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < MAX_WALK) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(path.join(dir, e.name)); }
      else if (e.isFile()) out.push(relOf(workspace, path.join(dir, e.name)));
    }
  }
  return out;
}

/** A glob as a regular expression: **, *, ?, {a,b}. Anchored at both ends. */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  const p = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  while (i < p.length) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      if (p[i + 2] === "/") { re += "(?:.*/)?"; i += 3; }
      else { re += ".*"; i += 2; }
    } else if (c === "*") { re += "[^/]*"; i++; }
    else if (c === "?") { re += "[^/]"; i++; }
    else if (c === "{") {
      const close = p.indexOf("}", i);
      if (close === -1) { re += "\\{"; i++; continue; }
      re += "(?:" + p.slice(i + 1, close).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|") + ")";
      i = close + 1;
    } else { re += c.replace(/[.+^$()|[\]\\]/g, "\\$&"); i++; }
  }
  return new RegExp("^" + re + "$");
}

function mtime(workspace: string, rel: string): number {
  try { return fs.statSync(path.join(workspace, rel)).mtimeMs; } catch { return 0; }
}

async function doRead(c: ToolCall, ctx: ToolContext): Promise<AgentOutcome> {
  const abs = resolveInside(ctx.workspace, c.input.path);
  if (!fs.existsSync(abs)) throw new ToolError(c.input.path + " does not exist");
  if (fs.statSync(abs).isDirectory()) throw new ToolError(c.input.path + " is a directory; use ls");
  const buf = fs.readFileSync(abs);
  if (isBinary(buf)) return { call: c, ok: true, summary: "binary file, " + buf.length + " bytes", output: "" };
  const lines = buf.toString("utf-8").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const offset = Math.max(1, parseInt(c.input.offset, 10) || 1);
  const limit = Math.max(1, Math.min(MAX_READ_LINES, parseInt(c.input.limit, 10) || MAX_READ_LINES));
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const body = slice.map((l, k) => String(offset + k).padStart(6, " ") + "\t" + (l.length > 2000 ? l.slice(0, 2000) + " [line truncated]" : l)).join("\n");
  const more = offset - 1 + slice.length < lines.length
    ? "\n[file continues: " + lines.length + " lines in total; read again with offset " + (offset + slice.length) + "]" : "";
  return {
    call: c, ok: true,
    summary: lines.length === 0 ? "empty file" : "read " + slice.length + " line" + (slice.length === 1 ? "" : "s"),
    output: cap(body + more),
    detail: { path: relOf(ctx.workspace, abs), lines: slice.length, total: lines.length },
  };
}

async function doWrite(c: ToolCall, ctx: ToolContext): Promise<AgentOutcome> {
  const abs = resolveInside(ctx.workspace, c.input.path);
  refuseGitInternals(ctx.workspace, abs);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) throw new ToolError(c.input.path + " is a directory");
  let content = c.content || "";
  // The reply reader drops a code block's final newline; files end with one.
  if (content && !content.endsWith("\n")) content += "\n";
  const before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : null;
  if (ctx.beforeChange) ctx.beforeChange(abs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  const rel = relOf(ctx.workspace, abs);
  const n = countLines(content);
  return {
    call: c, ok: true,
    summary: (before === null ? "created " : "overwrote ") + rel + " (" + n + " line" + (n === 1 ? "" : "s") + ")",
    output: "",
    detail: { path: rel, before: before === null ? "" : cap(before, 200000), after: cap(content, 200000), created: before === null },
  };
}

/** Where a search text occurs, exactly or - failing that - ignoring trailing whitespace per line. */
function locate(content: string, search: string): { index: number; length: number; count: number } {
  if (search === "") return { index: -1, length: 0, count: 0 };
  let count = 0, first = -1, from = 0;
  for (;;) {
    const at = content.indexOf(search, from);
    if (at === -1) break;
    if (first === -1) first = at;
    count++;
    from = at + Math.max(1, search.length);
  }
  if (count) return { index: first, length: search.length, count: count };
  // Tolerate the differences a web page introduces - trailing spaces and \r -
  // but only when the match is still unique.
  const norm = (s: string) => s.split("\n").map((l) => l.replace(/[ \t\r]+$/, "")).join("\n");
  const lines = content.split("\n");
  const want = norm(search).split("\n");
  const hits: number[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < want.length; k++) if (lines[i + k].replace(/[ \t\r]+$/, "") !== want[k]) { ok = false; break; }
    if (ok) hits.push(i);
  }
  if (hits.length !== 1) return { index: -1, length: 0, count: hits.length };
  const start = lines.slice(0, hits[0]).join("\n").length + (hits[0] > 0 ? 1 : 0);
  const length = lines.slice(hits[0], hits[0] + want.length).join("\n").length;
  return { index: start, length: length, count: 1 };
}

export function applyEdits(content: string, edits: EditSection[], replaceAll: boolean): { content: string; added: number; removed: number } {
  let out = content;
  let added = 0, removed = 0;
  edits.forEach((e, n) => {
    const where = "section " + (n + 1);
    if (e.search === "") throw new ToolError(where + ": SEARCH is empty; to add to a file, include the lines around the insertion point");
    if (replaceAll && out.indexOf(e.search) !== -1) {
      const parts = out.split(e.search);
      removed += (parts.length - 1) * countLines(e.search);
      added += (parts.length - 1) * countLines(e.replace);
      out = parts.join(e.replace);
      return;
    }
    const hit = locate(out, e.search);
    if (hit.count === 0) throw new ToolError(where + ": SEARCH text not found. Read the file again and copy the lines exactly");
    if (hit.count > 1) throw new ToolError(where + ": SEARCH text matches " + hit.count + " places; include more surrounding lines so it matches once");
    out = out.slice(0, hit.index) + e.replace + out.slice(hit.index + hit.length);
    removed += countLines(e.search);
    added += countLines(e.replace);
  });
  return { content: out, added: added, removed: removed };
}

async function doEdit(c: ToolCall, ctx: ToolContext): Promise<AgentOutcome> {
  const abs = resolveInside(ctx.workspace, c.input.path);
  refuseGitInternals(ctx.workspace, abs);
  if (!fs.existsSync(abs)) throw new ToolError(c.input.path + " does not exist; use write to create it");
  const before = fs.readFileSync(abs, "utf-8");
  const r = applyEdits(before, c.edits || [], c.input.replace_all === true);
  if (r.content === before) return { call: c, ok: true, summary: "no change", output: "" };
  if (ctx.beforeChange) ctx.beforeChange(abs);
  fs.writeFileSync(abs, r.content);
  const rel = relOf(ctx.workspace, abs);
  return {
    call: c, ok: true,
    summary: "updated " + rel + " (+" + r.added + " -" + r.removed + ")",
    output: "",
    detail: { path: rel, before: cap(before, 200000), after: cap(r.content, 200000), created: false },
  };
}

async function doBash(c: ToolCall, ctx: ToolContext): Promise<AgentOutcome> {
  const command = String(c.input.command || "").trim();
  if (!command) throw new ToolError("bash needs a command");
  const secs = Math.max(1, Math.min(600, parseInt(c.input.timeout, 10) || 60));
  const run = ctx.run || ((cmd: string, cwd: string, t: number) => runCommand(cmd, cwd, t, { pipefail: true }));
  const r = await run(command, ctx.workspace, secs * 1000);
  const output = cap(r.output || "");
  return {
    call: c, ok: r.success,
    summary: r.timedOut ? "still running after " + secs + "s (left running as a server)" : r.success ? "exit 0" : "failed",
    output: output || "(no output)",
    detail: { command: command, output: output, ok: r.success, timedOut: r.timedOut },
  };
}

async function doGlob(c: ToolCall, ctx: ToolContext): Promise<AgentOutcome> {
  const pattern = String(c.input.pattern || "").trim();
  if (!pattern) throw new ToolError("glob needs a pattern");
  const base = c.input.path ? resolveInside(ctx.workspace, c.input.path) : path.resolve(ctx.workspace);
  const re = globToRegExp(pattern);
  const plain = pattern.indexOf("/") === -1;
  const baseRel = relOf(ctx.workspace, base);
  const hits = walk(base, ctx.workspace).filter((rel) => {
    const local = baseRel === "." ? rel : rel.slice(baseRel.length + 1);
    // No slash means "anywhere": *.ts finds every TypeScript file, the way a
    // person typing it means.
    return re.test(plain ? local.split("/").pop()! : local);
  });
  hits.sort((a, b) => mtime(ctx.workspace, b) - mtime(ctx.workspace, a));
  const shown = hits.slice(0, 200);
  return {
    call: c, ok: true,
    summary: hits.length + " file" + (hits.length === 1 ? "" : "s"),
    output: shown.join("\n") + (hits.length > shown.length ? "\n[" + (hits.length - shown.length) + " more]" : ""),
    detail: { files: shown, total: hits.length },
  };
}

async function doGrep(c: ToolCall, ctx: ToolContext): Promise<AgentOutcome> {
  const pattern = String(c.input.pattern || "");
  if (!pattern) throw new ToolError("grep needs a pattern");
  let re: RegExp;
  try { re = new RegExp(pattern, c.input.ignore_case || c.input.i ? "i" : ""); }
  catch (e: any) { throw new ToolError("invalid regular expression: " + e.message); }
  const base = c.input.path ? resolveInside(ctx.workspace, c.input.path) : path.resolve(ctx.workspace);
  const only = c.input.glob ? globToRegExp(String(c.input.glob)) : null;
  const files = fs.existsSync(base) && fs.statSync(base).isFile() ? [relOf(ctx.workspace, base)] : walk(base, ctx.workspace);
  const out: string[] = [];
  let matches = 0, filesHit = 0;
  for (const rel of files) {
    if (only && !only.test(rel) && !only.test(rel.split("/").pop()!)) continue;
    let buf: Buffer;
    try { const abs = path.join(ctx.workspace, rel); if (fs.statSync(abs).size > 1500000) continue; buf = fs.readFileSync(abs); } catch { continue; }
    if (isBinary(buf)) continue;
    const lines = buf.toString("utf-8").split("\n");
    let hitHere = false;
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      matches++; hitHere = true;
      if (out.length < 300) out.push(rel + ":" + (i + 1) + ": " + lines[i].slice(0, 300));
    }
    if (hitHere) filesHit++;
  }
  return {
    call: c, ok: true,
    summary: matches + " match" + (matches === 1 ? "" : "es") + " in " + filesHit + " file" + (filesHit === 1 ? "" : "s"),
    output: cap(out.join("\n") + (matches > out.length ? "\n[" + (matches - out.length) + " more matches]" : "")),
    detail: { matches: matches, files: filesHit },
  };
}

async function doLs(c: ToolCall, ctx: ToolContext): Promise<AgentOutcome> {
  const abs = resolveInside(ctx.workspace, c.input.path || ".");
  if (!fs.existsSync(abs)) throw new ToolError((c.input.path || ".") + " does not exist");
  if (!fs.statSync(abs).isDirectory()) throw new ToolError((c.input.path || ".") + " is a file; use read");
  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .map((e) => e.name + (e.isDirectory() ? "/" : ""))
    .sort((a, b) => (Number(b.endsWith("/")) - Number(a.endsWith("/"))) || a.localeCompare(b));
  return {
    call: c, ok: true,
    summary: entries.length + " entr" + (entries.length === 1 ? "y" : "ies"),
    output: entries.slice(0, 500).join("\n") + (entries.length > 500 ? "\n[" + (entries.length - 500) + " more]" : ""),
    detail: { entries: entries.length },
  };
}

async function doTodo(c: ToolCall, ctx: ToolContext): Promise<AgentOutcome> {
  const raw = Array.isArray(c.input.items) ? c.input.items : Array.isArray(c.input.todos) ? c.input.todos : null;
  if (!raw) throw new ToolError("todo needs items: [{text, status}]");
  const items: TodoItem[] = raw.map((it: any) => {
    const text = String((it && (it.text || it.content || it.task || it.title)) || "").trim();
    const s = String((it && it.status) || "pending").toLowerCase().replace(/[\s-]/g, "_");
    const status = s === "done" || s === "completed" || s === "complete" ? "done" : s === "in_progress" || s === "active" || s === "doing" ? "in_progress" : "pending";
    return { text: text, status: status } as TodoItem;
  }).filter((it: TodoItem) => it.text);
  ctx.todos.length = 0;
  ctx.todos.push(...items);
  const done = items.filter((i) => i.status === "done").length;
  return {
    call: c, ok: true,
    summary: done + "/" + items.length + " done",
    output: "",
    detail: { items: items },
  };
}

const RUNNERS: Record<string, (c: ToolCall, ctx: ToolContext) => Promise<AgentOutcome>> = {
  read: doRead, write: doWrite, edit: doEdit, bash: doBash, glob: doGlob, grep: doGrep, ls: doLs, todo: doTodo,
};

/** Run one call. Never throws: a failure is an outcome the model reads and recovers from. */
export async function runTool(call: ToolCall | BadCall, ctx: ToolContext): Promise<AgentOutcome> {
  if (isBad(call)) return { call: call, ok: false, summary: "error", output: "Could not use this tool block: " + call.error + "." };
  try {
    return await RUNNERS[call.tool](call, ctx);
  } catch (e: any) {
    const msg = e instanceof ToolError ? e.message : "unexpected error: " + (e && e.message ? e.message : String(e));
    return { call: call, ok: false, summary: "error", output: "Error: " + msg };
  }
}

/** Read-only tools never need permission. */
export function isReadOnly(tool: string): boolean {
  return tool === "read" || tool === "glob" || tool === "grep" || tool === "ls" || tool === "todo";
}
