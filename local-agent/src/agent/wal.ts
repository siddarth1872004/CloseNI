/**
 * A write-ahead log of the Code turn in progress, so a restart does not lose it.
 *
 * Each step of a turn is written down before the next begins:
 *
 *   turn   the user's message
 *   sent   a prompt went to the model
 *   reply  its reply came back - the whole text, so it can be parsed again
 *   ran    one of the reply's tool calls was run, with its result
 *   end    the turn finished, however it finished
 *
 * After a crash or a closed window, the log says exactly where the turn
 * stopped. A saved reply is parsed again rather than asked for again, and a
 * call already run is not run twice: its recorded result is what the model
 * hears. Only the current turn is kept - a new one starts the file over - so
 * the log never grows past one turn's replies and results.
 *
 * It lives in the storage directory, not the project: nothing the person
 * would ever commit.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export interface RanCall {
  /** The call, as the interface names it: "edit src/app.ts". */
  title?: string;
  ok: boolean;
  summary: string;
  output: string;
}

/** A turn the log shows was started and never ended. */
export interface PendingTurn {
  user: string;
  /** The step the turn stopped on. */
  step: number;
  /** The prompt last sent: what to send again when its reply was never saved. */
  prompt: string;
  /** That step's reply, when it was saved. */
  reply: string | null;
  /** The reply's calls that ran, by their index in the parsed reply. */
  ran: Map<number, RanCall>;
  /** Every call the turn ran, in order, as "title: summary" - what it has done so far. */
  done: string[];
}

type Entry =
  | { t: "turn"; user: string; at: number }
  | { t: "sent"; step: number; prompt: string }
  | { t: "reply"; step: number; reply: string }
  | { t: "ran"; step: number; index: number; title?: string; ok: boolean; summary: string; output: string }
  | { t: "end"; reason: string };

/** Read a log's lines back into the turn they describe, or null when it ended or never began. */
export function pendingFrom(lines: string[]): PendingTurn | null {
  let turn: PendingTurn | null = null;
  for (const line of lines) {
    let e: Entry;
    try { e = JSON.parse(line); } catch { continue; } // a line cut off by the crash itself
    if (!e || typeof e !== "object") continue;
    if (e.t === "turn") turn = { user: String(e.user || ""), step: 0, prompt: "", reply: null, ran: new Map(), done: [] };
    else if (!turn) continue;
    else if (e.t === "sent") { turn.step = e.step; turn.prompt = String(e.prompt || ""); turn.reply = null; turn.ran = new Map(); }
    else if (e.t === "reply" && e.step === turn.step) turn.reply = String(e.reply || "");
    else if (e.t === "ran" && e.step === turn.step) {
      turn.ran.set(e.index, { title: e.title, ok: !!e.ok, summary: String(e.summary || ""), output: String(e.output || "") });
      turn.done.push((e.title ? e.title + ": " : "") + String(e.summary || "") + (e.ok ? "" : " (failed)"));
    }
    else if (e.t === "end") turn = null;
  }
  // A turn that never got a prompt out has nothing to resume: its message
  // can simply be sent again.
  return turn && turn.prompt ? turn : null;
}

export class TurnLog {
  constructor(readonly file: string) {}

  /** The log for this workspace under the storage directory. */
  static forWorkspace(storageRoot: string, workspace: string): TurnLog {
    const id = crypto.createHash("sha1").update(path.resolve(workspace)).digest("hex").slice(0, 16);
    return new TurnLog(path.join(storageRoot, "agent-wal", id + ".jsonl"));
  }

  pending(): PendingTurn | null {
    try {
      return pendingFrom(fs.readFileSync(this.file, "utf-8").split("\n").filter(Boolean));
    } catch {
      return null;
    }
  }

  /** A new turn: the file starts over with it. */
  begin(user: string): void { this.write({ t: "turn", user: user, at: Date.now() }, true); }
  sent(step: number, prompt: string): void { this.write({ t: "sent", step: step, prompt: prompt }); }
  reply(step: number, reply: string): void { this.write({ t: "reply", step: step, reply: reply }); }
  ran(step: number, index: number, r: RanCall): void {
    this.write({ t: "ran", step: step, index: index, title: r.title, ok: r.ok, summary: r.summary, output: r.output });
  }
  end(reason: string): void { this.write({ t: "end", reason: reason }); }

  // Synchronous on purpose: an entry is only worth anything if it is on disk
  // before the step it records is taken. A log that cannot be written must
  // never stop the turn it is logging.
  private write(e: Entry, fresh: boolean = false): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const line = JSON.stringify(e) + "\n";
      if (fresh) fs.writeFileSync(this.file, line);
      else fs.appendFileSync(this.file, line);
    } catch { /* best effort */ }
  }
}
