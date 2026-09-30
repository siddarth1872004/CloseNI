/**
 * The agent loop: a user message goes in, the model calls tools until it has
 * an answer, and every step is reported as an event.
 *
 * One turn is: ask the model; if its reply holds tool blocks, decide each one's
 * permission, run what is allowed, and send the results back; repeat until a
 * reply holds none. That reply is the answer. No plan is required - planning
 * is plan mode, which the user turns on when they want one.
 *
 * The transport is any ChatSession, so the same loop drives a chat site in a
 * browser and a local model.
 */
import * as fs from "fs";
import * as path from "path";
import { parseReply, preamble, formatResults, modeNote, TURN_REMINDER, Mode, ToolCall, BadCall, isBad, describeCall, fenceFor } from "./protocol.js";
import { runTool, AgentOutcome, ToolContext, TodoItem, applyEdits, resolveInside, cap } from "./tools.js";
import { decide, remember, SessionRules, emptyRules } from "./permissions.js";

export interface Asker { ask(prompt: string): Promise<string>; reset?(): Promise<void> }

export type PermissionAnswer = { decision: "allow" | "always" | "deny"; feedback?: string };

export interface LoopOptions {
  session: Asker;
  workspace: string;
  emit: (ev: any) => void;
  askPermission: (req: any) => Promise<PermissionAnswer>;
  mode?: Mode;
  maxSteps?: number;
  platform?: string;
  run?: ToolContext["run"];
  /** Wraps the first message of a thread - persona, skills and MCP context. */
  wrapFirst?: (text: string) => string;
  /**
   * Given a reply with no tool blocks, a message sending the model back to
   * work if it stopped short of what it said it would do, or "". Asked at
   * most once a turn, and never in plan mode, where prose is the answer.
   */
  checkFinal?: (reply: string) => Promise<string>;
}

const MEMORY_FILES = ["CLOSENI.md", "AGENTS.md", "CLAUDE.md"];

/** The project's standing instructions, from the first memory file that exists. */
export function loadMemory(workspace: string): { file: string; text: string } | null {
  for (const name of MEMORY_FILES) {
    const p = path.join(workspace, name);
    try {
      if (fs.statSync(p).isFile()) return { file: name, text: cap(fs.readFileSync(p, "utf-8"), 8000) };
    } catch { /* next */ }
  }
  return null;
}

/**
 * "@src/app.py" in a message attaches that file. Only paths that exist inside
 * the project count; an @ in an email address or a decorator stays as typed.
 */
export function expandMentions(text: string, workspace: string): { text: string; attached: string[] } {
  const attached: string[] = [];
  const blocks: string[] = [];
  const re = /(^|[\s(])@([\w./-]+[\w/])/g;
  let m: RegExpExecArray | null;
  let budget = 40000;
  while ((m = re.exec(text)) !== null) {
    const rel = m[2];
    if (attached.indexOf(rel) !== -1) continue;
    let abs: string;
    try { abs = resolveInside(workspace, rel); } catch { continue; }
    if (!fs.existsSync(abs)) continue;
    const st = fs.statSync(abs);
    let body: string;
    if (st.isDirectory()) body = fs.readdirSync(abs).sort().join("\n");
    else if (st.size > 400000) continue;
    else body = fs.readFileSync(abs, "utf-8");
    body = cap(body, Math.min(12000, budget));
    budget -= body.length;
    const f = fenceFor(body);
    blocks.push("Contents of " + rel + (st.isDirectory() ? "/" : "") + ":\n" + f + "\n" + body + "\n" + f);
    attached.push(rel);
    if (budget <= 0) break;
  }
  return { text: blocks.length ? text + "\n\n" + blocks.join("\n\n") : text, attached: attached };
}

export class AgentLoop {
  mode: Mode;
  readonly rules: SessionRules = emptyRules();
  readonly todos: TodoItem[] = [];
  private started = false;
  private lastSentMode: Mode | null = null;
  private stopRequested = false;
  private running = false;
  private nextId = 1;
  private notes: string[] = [];
  private checkpoints: Array<Map<string, string | null>> = [];
  private maxSteps: number;
  /**
   * How often this thread's replies broke the tool convention: a block that
   * would not parse, or none where one was due (the reply that earned a
   * nudge). `at` is which reply each happened on, counted from the start of
   * the thread, so a rise with length shows up - which is the question
   * before re-sending the tool list or starting a fresh chat.
   */
  readonly drift = { replies: 0, malformed: 0, missing: 0, at: [] as number[] };

  constructor(private o: LoopOptions) {
    this.mode = o.mode || "default";
    this.maxSteps = o.maxSteps || 30;
  }

  get busy(): boolean { return this.running; }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.o.emit({ type: "mode", mode: mode });
  }

  /** Stop after the reply or tool currently in progress. */
  interrupt(): void {
    if (this.running) this.stopRequested = true;
  }

  /** A new conversation: the thread, the todo list and pending notes go. */
  async clear(): Promise<void> {
    if (this.o.session.reset) await this.o.session.reset();
    this.started = false;
    this.lastSentMode = null;
    this.drift.replies = this.drift.malformed = this.drift.missing = 0;
    this.drift.at.length = 0;
    this.notes = [];
    this.todos.length = 0;
    this.o.emit({ type: "todos", items: [] });
    this.o.emit({ type: "cleared" });
  }

  /**
   * Undo the file changes of the most recent turn that made any. The
   * conversation cannot be un-said, so the model is told on the next message.
   */
  rewind(): string[] {
    while (this.checkpoints.length) {
      const cp = this.checkpoints.pop()!;
      if (!cp.size) continue;
      const files: string[] = [];
      for (const [abs, before] of cp) {
        try {
          if (before === null) { if (fs.existsSync(abs)) fs.unlinkSync(abs); }
          else fs.writeFileSync(abs, before);
          files.push(path.relative(this.o.workspace, abs).split(path.sep).join("/"));
        } catch { /* keep going: restore what can be restored */ }
      }
      this.notes.push("(The user reverted every file change from your previous turn: " + files.join(", ") + ". Those files are back as they were before it.)");
      this.o.emit({ type: "rewound", files: files });
      return files;
    }
    this.o.emit({ type: "rewound", files: [] });
    return [];
  }

  private compose(userText: string): string {
    const parts: string[] = [];
    if (!this.started) {
      const mem = loadMemory(this.o.workspace);
      parts.push(preamble({
        workspace: this.o.workspace,
        platform: this.o.platform || process.platform,
        mode: this.mode,
        memory: mem ? mem.text : "",
        date: new Date().toISOString().slice(0, 10),
      }));
      this.lastSentMode = this.mode;
    } else if (this.lastSentMode !== this.mode) {
      parts.push(modeNote(this.mode));
      this.lastSentMode = this.mode;
    }
    if (this.notes.length) { parts.push(this.notes.join("\n\n")); this.notes = []; }
    const expanded = expandMentions(userText, this.o.workspace);
    if (expanded.attached.length) this.o.emit({ type: "attached", files: expanded.attached });
    parts.push((this.started ? "User: " : "User request:\n") + expanded.text);
    parts.push(TURN_REMINDER);
    const text = parts.join("\n\n");
    return !this.started && this.o.wrapFirst ? this.o.wrapFirst(text) : text;
  }

  private preview(call: ToolCall): any {
    if (call.tool === "bash") return { command: String(call.input.command || "") };
    try {
      const abs = resolveInside(this.o.workspace, call.input.path);
      const before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : null;
      if (call.tool === "write") {
        let after = call.content || "";
        if (after && !after.endsWith("\n")) after += "\n";
        return { path: String(call.input.path), before: before || "", after: after, created: before === null };
      }
      if (call.tool === "edit" && before !== null) {
        const r = applyEdits(before, call.edits || [], call.input.replace_all === true);
        return { path: String(call.input.path), before: before, after: r.content, created: false };
      }
    } catch (e: any) {
      return { error: e && e.message ? e.message : String(e) };
    }
    return {};
  }

  /** One user message, run to its answer. */
  async turn(userText: string): Promise<void> {
    if (this.running) { this.o.emit({ type: "error", message: "still working on the previous message" }); return; }
    this.running = true;
    this.stopRequested = false;
    const checkpoint = new Map<string, string | null>();
    this.checkpoints.push(checkpoint);
    const ctx: ToolContext = {
      workspace: this.o.workspace,
      todos: this.todos,
      run: this.o.run,
      beforeChange: (abs) => {
        if (checkpoint.has(abs)) return;
        checkpoint.set(abs, fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : null);
      },
    };
    this.o.emit({ type: "turn-start" });
    let prompt = this.compose(userText);
    let reason = "complete";
    let errorText = "";
    let nudged = false;
    try {
      for (let step = 0; ; step++) {
        if (step >= this.maxSteps) { reason = "step-limit"; break; }
        this.o.emit({ type: "thinking", step: step });
        const reply = await this.o.session.ask(prompt);
        this.started = true;
        if (!reply || !reply.trim()) { reason = "error"; errorText = "No reply could be read from the provider."; break; }
        const parsed = parseReply(reply);
        this.drift.replies++;
        if (parsed.calls.some(isBad)) { this.drift.malformed++; this.drift.at.push(this.drift.replies); }
        if (parsed.text) this.o.emit({ type: "assistant", text: parsed.text });
        if (!parsed.calls.length) {
          if (!nudged && this.o.checkFinal && this.mode !== "plan" && !this.stopRequested) {
            nudged = true;
            let nudge = "";
            try { nudge = await this.o.checkFinal(reply); } catch { /* the reply stands as the answer */ }
            if (nudge) { this.drift.missing++; this.drift.at.push(this.drift.replies); }
            if (nudge && !this.stopRequested) { prompt = nudge; continue; }
          }
          break;
        }
        if (this.stopRequested) { reason = "interrupted"; break; }

        const outcomes: AgentOutcome[] = [];
        let halted = "";
        for (const call of parsed.calls) {
          if (this.stopRequested) { halted = "interrupted"; break; }
          const id = "t" + this.nextId++;
          const title = describeCall(call);
          if (isBad(call)) {
            const out = await runTool(call, ctx);
            this.o.emit({ type: "tool", id: id, name: "invalid", title: title, status: "error", summary: out.summary, output: out.output });
            outcomes.push(out);
            continue;
          }
          const d = decide(call, this.mode, this.rules);
          if (d.action === "deny") {
            outcomes.push({ call: call, ok: false, summary: "refused", output: "Not run: " + d.reason + "." });
            this.o.emit({ type: "tool", id: id, name: call.tool, title: title, input: call.input, status: "denied", summary: d.reason });
            continue;
          }
          if (d.action === "ask") {
            const pv = this.preview(call);
            if (pv && pv.error) {
              // An edit that cannot apply is not worth a question: report the
              // error to the model and let it try again.
              outcomes.push({ call: call, ok: false, summary: "error", output: "Error: " + pv.error });
              this.o.emit({ type: "tool", id: id, name: call.tool, title: title, input: call.input, status: "error", summary: pv.error });
              continue;
            }
            this.o.emit({ type: "tool", id: id, name: call.tool, title: title, input: call.input, status: "waiting" });
            const answer = await this.o.askPermission({
              id: id, tool: call.tool, title: title, input: call.input, preview: pv,
              alwaysAsk: d.alwaysAsk, rememberAs: d.rememberAs || "",
            });
            if (answer.decision === "deny") {
              this.o.emit({ type: "tool", id: id, name: call.tool, title: title, input: call.input, status: "denied", summary: "declined by the user" });
              outcomes.push({ call: call, ok: false, summary: "declined", output: "The user declined this." + (answer.feedback ? " They said: " + answer.feedback : "") });
              halted = "denied";
              break;
            }
            if (answer.decision === "always" && !d.alwaysAsk) remember(call, this.rules);
          }
          this.o.emit({ type: "tool", id: id, name: call.tool, title: title, input: call.input, status: "running" });
          const out = await runTool(call, ctx);
          outcomes.push(out);
          this.o.emit({ type: "tool", id: id, name: call.tool, title: title, input: call.input, status: out.ok ? "done" : "error", summary: out.summary, output: call.tool === "read" ? "" : cap(out.output, 6000), detail: out.detail });
          if (call.tool === "todo") this.o.emit({ type: "todos", items: this.todos.slice() });
        }

        if (halted) {
          // What did run is not lost: the model hears about it with the user's
          // next message, alongside what they want done instead.
          if (outcomes.length) this.notes.push(formatResults(outcomes, halted === "denied"
            ? "The user stopped you here and will say what to do instead."
            : "The user interrupted you here."));
          reason = halted;
          break;
        }
        prompt = formatResults(outcomes);
      }
    } catch (e: any) {
      reason = "error";
      errorText = e && e.message ? e.message : String(e);
    } finally {
      this.running = false;
      if (!checkpoint.size) this.checkpoints.pop();
      this.o.emit({ type: "done", reason: reason, error: errorText || undefined, canRewind: this.checkpoints.some((c) => c.size > 0),
        drift: { replies: this.drift.replies, malformed: this.drift.malformed, missing: this.drift.missing, at: this.drift.at.slice() } });
    }
  }
}
