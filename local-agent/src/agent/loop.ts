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
import { parseReply, preamble, formatResults, modeNote, TURN_REMINDER, COMPACT_REQUEST, Mode, ToolCall, BadCall, isBad, describeCall, fenceFor } from "./protocol.js";
import { runTool, AgentOutcome, ToolContext, TodoItem, applyEdits, resolveInside, cap } from "./tools.js";
import { decide, remember, SessionRules, emptyRules, Autonomy } from "./permissions.js";
import { agentShell } from "../verification/command-runner.js";
import { describeMachine } from "./machine.js";
import { ConversationSize, emptySize, addTurn, describeSize } from "../context-budget.js";
import { TurnLog, PendingTurn } from "./wal.js";

/**
 * How many turns of file changes /rewind can undo. Each checkpoint holds the
 * full content of every file a turn changed, so an uncapped list grew with
 * every turn of a long session; the files changed are kept apart for /compact.
 */
export const MAX_CHECKPOINTS = 20;
/** Most calls a turn picked up in a new chat lists as done. */
export const MAX_DONE = 60;

export interface Asker {
  /** `onThinking` gets the model's reasoning, whole, each time it grows. */
  ask(prompt: string, opts?: { onThinking?: (text: string) => void }): Promise<string>;
  reset?(): Promise<void>;
  /** What the thread holds, when the transport keeps count across restarts. */
  size?(): ConversationSize | undefined;
}

export type PermissionAnswer = { decision: "allow" | "always" | "deny"; feedback?: string };

export interface LoopOptions {
  session: Asker;
  workspace: string;
  emit: (ev: any) => void;
  askPermission: (req: any) => Promise<PermissionAnswer>;
  mode?: Mode;
  /** Settings > Permissions: "auto" approves edits and commands, "never" refuses commands. */
  autonomy?: Autonomy;
  platform?: string;
  /** The shell named in the preamble; defaults to the one commands run in here. */
  shell?: string;
  /** The machine line in the preamble; defaults to this machine's. */
  machine?: string;
  run?: ToolContext["run"];
  /** Wraps the first message of a thread - persona, skills and MCP context. */
  wrapFirst?: (text: string) => string;
  /**
   * Given a reply with no tool blocks, a message sending the model back to
   * work if it stopped short of what it said it would do, or "". Asked at
   * most once a turn, and never in plan mode, where prose is the answer.
   */
  checkFinal?: (reply: string) => Promise<string>;
  /**
   * The provider's conversation size in characters, for the size /compact
   * reports. Nothing rolls over on its own: the thread grows until the user
   * starts a new chat.
   */
  budgetChars?: number;
  /** Where each step of a turn is written down, so a restart can resume it. */
  log?: TurnLog;
}

/** What the app is told about a turn that can be resumed. */
export function resumableEvent(p: PendingTurn): any {
  return { type: "resumable", user: p.user.slice(0, 200), step: p.step, saved: p.reply !== null, ran: p.ran.size };
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
  /** Every file changed in this session, workspace-relative, for /compact's note. */
  private changed = new Set<string>();
  /** Each file as this chat last saw it, so a read again sends only what changed. */
  private seen = new Map<string, string>();
  /** Notes taken into a message not yet answered: put back if it fails. */
  private unsent: string[] = [];
  /**
   * How often this thread's replies broke the tool convention: a block that
   * would not parse, or none where one was due (the reply that earned a
   * nudge). `at` is which reply each happened on, counted from the start of
   * the thread, so a rise with length shows up - which is the question
   * before re-sending the tool list or starting a fresh chat.
   */
  readonly drift = { replies: 0, malformed: 0, missing: 0, at: [] as number[] };
  /** This thread's traffic, for a transport that does not count it itself. */
  private local: ConversationSize = emptySize();

  constructor(private o: LoopOptions) {
    this.mode = o.mode || "default";
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

  /** Notes sent with a message that got no answer go out with the next one. */
  private restoreUnsent(): void {
    if (!this.unsent.length) return;
    this.notes = this.unsent.concat(this.notes);
    this.unsent = [];
  }

  /** A new conversation: the thread, the todo list and pending notes go. */
  async clear(): Promise<void> {
    if (this.o.session.reset) await this.o.session.reset();
    this.newThread();
    this.notes = [];
    this.unsent = [];
    this.todos.length = 0;
    this.o.emit({ type: "todos", items: [] });
    this.o.emit({ type: "cleared" });
  }

  /**
   * The chat moved somewhere that has not seen it - another route. The next
   * prompt carries the preamble again; an unfinished turn stays resumable.
   */
  chatChanged(): void {
    this.started = false;
    this.seen.clear();
    this.lastSentMode = null;
    this.local = emptySize();
  }

  /** What starting over in a new chat resets. */
  private newThread(): void {
    // A turn from the old thread cannot be resumed into a new one.
    if (this.o.log) this.o.log.end("new thread");
    this.started = false;
    this.lastSentMode = null;
    this.local = emptySize();
    this.seen.clear();
    this.drift.replies = this.drift.malformed = this.drift.missing = 0;
    this.drift.at.length = 0;
  }

  private size(): ConversationSize {
    return (this.o.session.size && this.o.session.size()) || this.local;
  }

  /**
   * Continue in a new chat, from /compact, because the user asked. Nothing
   * else calls this: a long thread stays where it is.
   *
   * Nothing shortens a provider's conversation, so this starts another. The
   * model first writes down where things stand; the new chat gets the
   * preamble, that summary, the todo list and the files changed, and is told
   * to read a file again before editing it. Returns false when the transport
   * cannot start a new chat.
   */
  async compact(): Promise<boolean> {
    if (!this.o.session.reset) return false;
    // From /compact it runs on its own, and a message must wait for it.
    const own = !this.running;
    this.running = true;
    try { return await this.rollOver(); } finally { if (own) this.running = false; }
  }

  private async rollOver(): Promise<boolean> {
    const before = this.size();
    this.o.emit({ type: "compacting", size: describeSize(before, this.o.budgetChars || 0) });
    let summary = "";
    // Asked in the old thread, which is the only place that remembers it. A
    // summary that fails still leaves the todos and files to go on.
    try { summary = parseReply((await this.o.session.ask(COMPACT_REQUEST)) || "").text.trim(); } catch { /* go on without */ }
    if (this.o.session.reset) await this.o.session.reset();
    this.newThread();
    const files = this.changed;
    const parts = ["This conversation continues an earlier one that grew too long for the chat. Nothing from it is visible here except what follows."];
    if (summary) { const f = fenceFor(summary); parts.push("Your summary of it:\n" + f + "\n" + cap(summary, 8000) + "\n" + f); }
    if (this.todos.length) parts.push("Your todo list:\n" + this.todos.map((t) => "- [" + t.status + "] " + t.text).join("\n"));
    if (files.size) parts.push("Files you changed: " + Array.from(files).sort().join(", ") + ". Read a file again before editing it - what you remember of it is from the old chat.");
    this.notes.unshift(parts.join("\n\n"));
    this.o.emit({ type: "compacted", summary: !!summary, files: files.size });
    return true;
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
    const parts = this.opening();
    const expanded = expandMentions(userText, this.o.workspace);
    if (expanded.attached.length) this.o.emit({ type: "attached", files: expanded.attached });
    parts.push((this.started ? "User: " : "User request:\n") + expanded.text);
    parts.push(TURN_REMINDER);
    return this.wrap(parts);
  }

  /** What leads a message: the preamble in a new thread, else a mode change; then pending notes. */
  private opening(): string[] {
    const parts: string[] = [];
    if (!this.started) {
      const mem = loadMemory(this.o.workspace);
      parts.push(preamble({
        workspace: this.o.workspace,
        platform: this.o.platform || process.platform,
        shell: this.o.shell || agentShell(),
        machine: this.o.machine ?? describeMachine(this.o.platform || process.platform),
        mode: this.mode,
        memory: mem ? mem.text : "",
        date: new Date().toISOString().slice(0, 10),
      }));
      this.lastSentMode = this.mode;
    } else if (this.lastSentMode !== this.mode) {
      parts.push(modeNote(this.mode));
      this.lastSentMode = this.mode;
    }
    if (this.notes.length) {
      parts.push(this.notes.join("\n\n"));
      // Kept until the message is answered: a /compact summary sent into a
      // reply that failed (8 October: a 9146-char seed came back INCOMPLETE)
      // was otherwise gone for good, and the next message started from nothing.
      this.unsent = this.unsent.concat(this.notes);
      this.notes = [];
    }
    return parts;
  }

  /**
   * A prompt from partway through a turn, made to stand on its own in a new
   * chat - after a restart, or on another route: the preamble and the request
   * first, then where the turn stopped.
   * The log keeps the prompt as it was, so a second restart wraps it once.
   */
  private reopened(userText: string, prompt: string, done: string[]): string {
    const parts = this.opening();
    parts.push("User request:\n" + userText);
    // A running summary of the work, from the log: the new chat saw none of it.
    const steps = done.length > MAX_DONE ? ["(" + (done.length - MAX_DONE) + " earlier calls)"].concat(done.slice(-MAX_DONE)) : done;
    if (steps.length) parts.push("Done so far for this request:\n" + steps.map((d) => "- " + d).join("\n"));
    if (this.todos.length) parts.push("Your todo list:\n" + this.todos.map((t) => "- [" + t.status + "] " + t.text).join("\n"));
    parts.push("This request was cut off partway through and continues here, in a new chat. "
      + "The files on disk already hold the changes made so far. What follows is where the work stopped; carry on from there. "
      + "A file it calls unchanged, or shows only as a diff, was seen in the earlier chat: read it again before relying on it.");
    parts.push(prompt);
    return this.wrap(parts);
  }

  private wrap(parts: string[]): string {
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
  /**
   * Continue the turn the log shows was cut off - by a restart, or by an error
   * such as a rate limit. A saved reply is parsed again rather than asked for
   * again, and its calls that already ran are not run twice.
   */
  async resume(): Promise<void> {
    const p = this.o.log ? this.o.log.pending() : null;
    if (!p) { this.o.emit({ type: "error", message: "There is no unfinished turn to resume." }); return; }
    await this.turn(p.user, p);
  }

  async turn(userText: string, resume?: PendingTurn): Promise<void> {
    if (this.running) { this.o.emit({ type: "error", message: "still working on the previous message" }); return; }
    const log = this.o.log;
    this.running = true;
    this.stopRequested = false;
    const checkpoint = new Map<string, string | null>();
    this.checkpoints.push(checkpoint);
    const ctx: ToolContext = {
      workspace: this.o.workspace,
      todos: this.todos,
      seen: this.seen,
      run: this.o.run,
      beforeChange: (abs) => {
        if (checkpoint.has(abs)) return;
        checkpoint.set(abs, fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : null);
        this.changed.add(path.relative(this.o.workspace, abs).split(path.sep).join("/"));
      },
    };
    this.o.emit({ type: "turn-start" });
    if (!resume && log) log.begin(userText);
    // A restart lost the chat the turn was in. A first prompt that never got
    // its reply is simply composed again; anything later goes out with the
    // preamble and the request it belongs to (see reopened).
    const fresh = !!resume && !this.started;
    const recompose = fresh && resume!.step === 0 && resume!.reply === null;
    let prompt = resume && !recompose ? resume.prompt : this.compose(userText);
    let reopen = fresh && !recompose;
    // What this turn has run, for a new chat that picks it up partway.
    const done = resume ? resume.done.slice() : [];
    let reason = "complete";
    let errorText = "";
    let nudged = false;
    try {
      for (let step = resume ? resume.step : 0; ; step++) {
        const carried = resume && step === resume.step ? resume : null;
        this.o.emit({ type: "thinking", step: step });
        let reply: string;
        if (carried && carried.reply !== null) {
          reply = carried.reply;
          this.o.emit({ type: "resumed", step: step, ran: carried.ran.size });
        } else {
          if (carried) this.o.emit({ type: "resumed", step: step, ran: 0 });
          if (log) log.sent(step, prompt);
          const out = reopen ? this.reopened(userText, prompt, done) : prompt;
          reopen = false;
          // A full conversation (the provider's own count) ends the turn with
          // its message, in this chat: starting another is the user's call.
          reply = await this.o.session.ask(out, { onThinking: (text) => this.o.emit({ type: "reasoning", step: step, text: text }) });
          if (log && reply && reply.trim()) log.reply(step, reply);
        }
        this.unsent = [];
        this.local = addTurn(this.local, prompt.length, reply ? reply.length : 0);
        // A saved reply was never in this chat: it stays unstarted until a
        // prompt really goes out.
        if (!carried || carried.reply === null) this.started = true;
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
        for (let ci = 0; ci < parsed.calls.length; ci++) {
          const call = parsed.calls[ci];
          if (this.stopRequested) { halted = "interrupted"; break; }
          const id = "t" + this.nextId++;
          const title = describeCall(call);
          // Run before the restart: its result is what the model hears.
          const before = carried ? carried.ran.get(ci) : undefined;
          if (before) {
            outcomes.push({ call: call, ok: before.ok, summary: before.summary, output: before.output });
            this.o.emit({ type: "tool", id: id, name: isBad(call) ? "invalid" : call.tool, title: title, status: before.ok ? "done" : "error", summary: before.summary + " (run before the restart)" });
            continue;
          }
          const record = (out: AgentOutcome) => {
            outcomes.push(out);
            done.push(title + ": " + out.summary + (out.ok ? "" : " (failed)"));
            if (log) log.ran(step, ci, { title: title, ok: out.ok, summary: out.summary, output: out.output });
          };
          if (isBad(call)) {
            const out = await runTool(call, ctx);
            this.o.emit({ type: "tool", id: id, name: "invalid", title: title, status: "error", summary: out.summary, output: out.output });
            record(out);
            continue;
          }
          const d = decide(call, this.mode, this.rules, this.o.autonomy);
          if (d.action === "deny") {
            record({ call: call, ok: false, summary: "refused", output: "Not run: " + d.reason + "." });
            this.o.emit({ type: "tool", id: id, name: call.tool, title: title, input: call.input, status: "denied", summary: d.reason });
            continue;
          }
          if (d.action === "ask") {
            const pv = this.preview(call);
            if (pv && pv.error) {
              // An edit that cannot apply is not worth a question: report the
              // error to the model and let it try again.
              record({ call: call, ok: false, summary: "error", output: "Error: " + pv.error });
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
              record({ call: call, ok: false, summary: "declined", output: "The user declined this." + (answer.feedback ? " They said: " + answer.feedback : "") });
              halted = "denied";
              break;
            }
            if (answer.decision === "always" && !d.alwaysAsk) remember(call, this.rules);
          }
          this.o.emit({ type: "tool", id: id, name: call.tool, title: title, input: call.input, status: "running" });
          const out = await runTool(call, ctx);
          record(out);
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
      this.restoreUnsent();
    } finally {
      this.running = false;
      if (!checkpoint.size) this.checkpoints.pop();
      if (this.checkpoints.length > MAX_CHECKPOINTS) this.checkpoints.splice(0, this.checkpoints.length - MAX_CHECKPOINTS);
      // An error leaves the turn open in the log, so /resume can pick it up
      // once the provider is back; any other ending closes it.
      if (log && reason !== "error") log.end(reason);
      this.o.emit({ type: "done", reason: reason, error: errorText || undefined, canRewind: this.checkpoints.some((c) => c.size > 0),
        drift: { replies: this.drift.replies, malformed: this.drift.malformed, missing: this.drift.missing, at: this.drift.at.slice() } });
      const open = log && reason === "error" ? log.pending() : null;
      if (open) this.o.emit(resumableEvent(open));
    }
  }
}
