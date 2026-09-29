/**
 * How a chat-site model calls tools.
 *
 * A web chat has no function-calling API: what goes in is text typed into a
 * page, and what comes out is text read off it. So tool use is a convention
 * written into the conversation. The model answers with fenced blocks whose
 * first line is a JSON object naming a tool, the agent runs them, and the
 * results go back as the next message. A reply with no tool blocks is the
 * model's final answer for the turn.
 *
 * Fenced blocks are the carrier because they are the one thing every provider
 * renders and the reply reader returns verbatim - prose around them is
 * reflowed, lists lose their numbers, but a code block comes back as written.
 *
 * Write and edit carry their payload raw after a `---` line rather than inside
 * the JSON: a whole source file escaped into a JSON string is exactly what
 * web models get wrong most often (unescaped quotes, real newlines), and
 * search/replace sections are a format they already know.
 */
import { robustParseJson } from "../parser/json-repair.js";

export type ToolName = "read" | "write" | "edit" | "bash" | "glob" | "grep" | "ls" | "todo";

export const TOOL_NAMES: ToolName[] = ["read", "write", "edit", "bash", "glob", "grep", "ls", "todo"];

export interface EditSection { search: string; replace: string }

export interface ToolCall {
  tool: ToolName;
  input: Record<string, any>;
  /** write: the file content. */
  content?: string;
  /** edit: the search/replace pairs, in order. */
  edits?: EditSection[];
}

export interface BadCall {
  error: string;
  /** The block as the model wrote it, for the error sent back. */
  raw: string;
}

export interface ParsedReply {
  /** The reply with every tool block removed - what the user reads. */
  text: string;
  calls: Array<ToolCall | BadCall>;
}

interface Fence { info: string; body: string; start: number; end: number }

/** Fenced code blocks, in order, with the line range each one spans. */
export function fences(text: string): Fence[] {
  const lines = text.split(/\r?\n/);
  const out: Fence[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(/^\s{0,3}(`{3,}|~{3,})\s*([^`]*)$/);
    if (!open) { i++; continue; }
    const marker = open[1];
    const info = open[2].trim();
    let j = i + 1;
    const body: string[] = [];
    let closed = false;
    for (; j < lines.length; j++) {
      const m = lines[j].match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
      if (m && m[1][0] === marker[0] && m[1].length >= marker.length) { closed = true; break; }
      body.push(lines[j]);
    }
    // An unclosed fence runs to the end of the reply: a truncated reply is
    // still worth reading, and the parse below decides whether it is usable.
    out.push({ info: info, body: body.join("\n"), start: i, end: closed ? j : lines.length - 1 });
    i = closed ? j + 1 : lines.length;
  }
  return out;
}

const NAME_KEYS = ["tool", "name", "action", "tool_name"];
const ARG_KEYS = ["input", "args", "arguments", "parameters", "params"];

/** The header of a tool block: everything before a line that is exactly `---`. */
function splitHeader(body: string): { header: string; payload: string | null } {
  const lines = body.split("\n");
  const sep = lines.findIndex((l) => l.trim() === "---");
  if (sep === -1) return { header: body, payload: null };
  return { header: lines.slice(0, sep).join("\n"), payload: lines.slice(sep + 1).join("\n") };
}

/**
 * The tool a block names. A block labelled ```tool may use any of the usual
 * keys; an unlabelled one must say "tool" outright, because {"name": "server"}
 * is how half of all package.json snippets begin.
 */
function toolNameOf(obj: any, labelled: boolean): string | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  for (const k of labelled ? NAME_KEYS : ["tool"]) {
    if (typeof obj[k] === "string" && obj[k].trim()) return obj[k].trim().toLowerCase();
  }
  return null;
}

function argsOf(obj: any): Record<string, any> {
  for (const k of ARG_KEYS) if (obj[k] && typeof obj[k] === "object" && !Array.isArray(obj[k])) return Object.assign({}, obj[k]);
  const out: Record<string, any> = {};
  for (const k of Object.keys(obj)) if (NAME_KEYS.indexOf(k) === -1) out[k] = obj[k];
  return out;
}

const ALIASES: Record<string, ToolName> = {
  read: "read", read_file: "read", cat: "read", view: "read", open: "read",
  write: "write", write_file: "write", create: "write", create_file: "write",
  edit: "edit", edit_file: "edit", str_replace: "edit", replace: "edit", patch: "edit",
  bash: "bash", shell: "bash", run: "bash", exec: "bash", command: "bash", terminal: "bash",
  glob: "glob", find: "glob", find_files: "glob",
  grep: "grep", search: "grep", rg: "grep",
  ls: "ls", list: "ls", list_dir: "ls", list_files: "ls",
  todo: "todo", todos: "todo", todo_write: "todo", plan: "todo",
};

/**
 * Search/replace sections, in the markers models already use for merge
 * conflicts and aider-style edits:
 *
 *   <<<<<<< SEARCH
 *   old
 *   =======
 *   new
 *   >>>>>>> REPLACE
 */
export function parseEditSections(payload: string): EditSection[] {
  const lines = payload.split("\n");
  const out: EditSection[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!/^<{5,9}\s*(SEARCH|ORIGINAL|OLD)?\s*$/i.test(lines[i].trim())) { i++; continue; }
    const search: string[] = [];
    let j = i + 1;
    while (j < lines.length && !/^={5,9}\s*$/.test(lines[j].trim())) search.push(lines[j++]);
    if (j >= lines.length) break;
    const replace: string[] = [];
    let k = j + 1;
    while (k < lines.length && !/^>{5,9}\s*(REPLACE|UPDATED|NEW)?\s*$/i.test(lines[k].trim())) replace.push(lines[k++]);
    out.push({ search: search.join("\n"), replace: replace.join("\n") });
    i = k + 1;
  }
  return out;
}

function str(v: any): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** One fenced block as a tool call, a malformed one, or null if it is just code. */
export function readBlock(f: Fence): ToolCall | BadCall | null {
  const labelled = /^tool\b/i.test(f.info);
  const { header, payload } = splitHeader(f.body);
  const trimmed = header.trim();
  // An unlabelled block counts only if it opens with a JSON object that names
  // a tool. Code the model is merely showing - a JSON config, a Python dict -
  // must never be executed because it happened to start with a brace.
  if (!labelled && !/^\{/.test(trimmed)) return null;
  let obj: any = null;
  try { obj = JSON.parse(trimmed); } catch { obj = robustParseJson(trimmed); }
  const rawName = toolNameOf(obj, labelled);
  if (!rawName) return labelled ? { error: "the block has no JSON object with a \"tool\" field", raw: f.body.slice(0, 300) } : null;
  const tool = ALIASES[rawName];
  if (!tool) return { error: "unknown tool \"" + rawName + "\". Tools: " + TOOL_NAMES.join(", "), raw: f.body.slice(0, 300) };
  const input = argsOf(obj);
  const call: ToolCall = { tool: tool, input: input };
  if (tool === "write") {
    const content = payload !== null ? payload : (str(input.content) ?? str(input.text) ?? str(input.contents));
    if (content === undefined) return { error: "write needs the file content after a line containing only ---", raw: f.body.slice(0, 300) };
    call.content = content;
    delete input.content; delete input.text; delete input.contents;
  }
  if (tool === "edit") {
    let edits: EditSection[] = payload !== null ? parseEditSections(payload) : [];
    if (!edits.length) {
      const old = str(input.old) ?? str(input.old_string) ?? str(input.search) ?? str(input.find);
      const neu = str(input.new) ?? str(input.new_string) ?? str(input.replace) ?? str(input.replacement);
      if (old !== undefined && neu !== undefined) edits = [{ search: old, replace: neu }];
      else if (Array.isArray(input.edits)) {
        edits = input.edits
          .map((e: any) => ({ search: str(e && (e.old ?? e.old_string ?? e.search)), replace: str(e && (e.new ?? e.new_string ?? e.replace)) }))
          .filter((e: any) => e.search !== undefined && e.replace !== undefined) as EditSection[];
      }
    }
    if (!edits.length) return { error: "edit needs SEARCH/REPLACE sections after a line containing only ---", raw: f.body.slice(0, 300) };
    call.edits = edits;
    for (const k of ["old", "new", "old_string", "new_string", "search", "replace", "find", "replacement", "edits"]) delete input[k];
  }
  return call;
}

export function parseReply(reply: string): ParsedReply {
  const text = typeof reply === "string" ? reply : String(reply ?? "");
  const lines = text.split(/\r?\n/);
  const calls: Array<ToolCall | BadCall> = [];
  const drop = new Set<number>();
  for (const f of fences(text)) {
    const c = readBlock(f);
    if (!c) continue;
    calls.push(c);
    for (let i = f.start; i <= f.end; i++) drop.add(i);
  }
  const visible = lines.filter((_, i) => !drop.has(i)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: visible, calls: calls };
}

export function isBad(c: ToolCall | BadCall): c is BadCall {
  return (c as BadCall).error !== undefined;
}

/** A fence long enough that nothing inside it can close it early. */
export function fenceFor(content: string): string {
  let longest = 0;
  const re = /`+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

export type Mode = "default" | "acceptEdits" | "plan" | "auto";
export const MODES: Mode[] = ["default", "acceptEdits", "plan", "auto"];

export function modeNote(mode: Mode): string {
  if (mode === "plan") {
    return "PLAN MODE is on: you may only use read, glob, grep, ls and todo. Investigate as needed, then reply " +
      "with a concrete, numbered plan and no tool blocks. Do not change any file or run any command.";
  }
  return "Plan mode is off: you may use every tool.";
}

export interface PreambleOptions {
  workspace: string;
  platform: string;
  mode: Mode;
  memory?: string;
  date?: string;
}

export function preamble(o: PreambleOptions): string {
  const T = "```";
  const parts = [
    "You are CloseNI, a coding agent working inside the user's project on their machine.",
    "Working directory: " + o.workspace + " (paths are relative to it). Platform: " + o.platform + "." + (o.date ? " Date: " + o.date + "." : ""),
    "You cannot see files or run anything yourself. You act through tools: CloseNI runs them and sends the results back as the next message.",
    "",
    "To call a tool, reply with a fenced block whose first line is a JSON object naming it:",
    "",
    T + "tool",
    "{\"tool\": \"read\", \"path\": \"src/app.py\"}",
    T,
    "",
    "write and edit put the JSON first, then a line containing only ---, then the payload exactly as it should be:",
    "",
    T + "tool",
    "{\"tool\": \"write\", \"path\": \"hello.py\"}",
    "---",
    "print(\"hello\")",
    T,
    "",
    T + "tool",
    "{\"tool\": \"edit\", \"path\": \"hello.py\"}",
    "---",
    "<<<<<<< SEARCH",
    "print(\"hello\")",
    "=======",
    "print(\"hello, world\")",
    ">>>>>>> REPLACE",
    T,
    "",
    "Tools:",
    "- read {path, offset?, limit?}: a file with line numbers.",
    "- write {path} + payload: create or overwrite a whole file.",
    "- edit {path} + SEARCH/REPLACE sections: each SEARCH must match the file exactly, once. Several sections may follow each other.",
    "- bash {command, timeout?}: run a shell command in the working directory (timeout in seconds, default 60).",
    "- glob {pattern}: files matching a pattern such as src/**/*.ts.",
    "- grep {pattern, path?, glob?, ignore_case?}: search file contents with a regular expression.",
    "- ls {path?}: list a directory.",
    "- todo {items: [{text, status}]}: your task list for multi-step work; status is pending, in_progress or done. Send the whole list each time.",
    "",
    "Rules:",
    "- Read a file before editing it, and prefer edit to write for files that exist.",
    "- After your tool blocks, stop. Never guess a result - it arrives in the next message.",
    "- Independent tool calls can go in one reply.",
    "- When the task is finished, reply with a short summary for the user and no tool blocks.",
    "- Be concise. Do not repeat file contents back unless asked.",
    "",
    modeNote(o.mode),
  ];
  if (o.memory && o.memory.trim()) {
    parts.push("", "Project instructions from the user (follow them):", o.memory.trim());
  }
  return parts.join("\n");
}

/** Said with every user message: web models drift from a convention over a long thread. */
export const TURN_REMINDER = "(Act with ```tool blocks; a reply without them is your final answer.)";

export interface ToolOutcome {
  call: ToolCall | BadCall;
  ok: boolean;
  /** One line: what happened. */
  summary: string;
  /** The body sent back to the model. */
  output: string;
}

export function describeCall(c: ToolCall | BadCall): string {
  if (isBad(c)) return "invalid tool block";
  const i = c.input;
  switch (c.tool) {
    case "read": return "read " + (i.path || "?");
    case "write": return "write " + (i.path || "?");
    case "edit": return "edit " + (i.path || "?");
    case "bash": return "bash `" + String(i.command || "").slice(0, 120) + "`";
    case "glob": return "glob " + (i.pattern || "?");
    case "grep": return "grep " + JSON.stringify(String(i.pattern || "")) + (i.path ? " in " + i.path : "");
    case "ls": return "ls " + (i.path || ".");
    case "todo": return "todo";
  }
}

/** The message that carries tool results back to the model. */
export function formatResults(outcomes: ToolOutcome[], trailer?: string): string {
  const parts: string[] = ["Tool results (" + outcomes.length + "):"];
  outcomes.forEach((o, n) => {
    const head = "[" + (n + 1) + "] " + describeCall(o.call) + " - " + o.summary;
    parts.push("");
    if (!o.output) { parts.push(head); return; }
    const f = fenceFor(o.output);
    parts.push(head, f, o.output, f);
  });
  parts.push("", trailer || "Continue: call more tools, or reply with your final answer and no tool blocks.");
  return parts.join("\n");
}
