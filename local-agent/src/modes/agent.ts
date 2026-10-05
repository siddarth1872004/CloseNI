/**
 * The coding agent, as a long-lived session and as a one-shot run.
 *
 * Split out of index.ts, which keeps the dispatcher.
 */
import { stopRunning, stopBackground } from "../verification/command-runner.js";
import { budgetFor } from "../context-budget.js";
import { AgentLoop, loadMemory, PermissionAnswer } from "../agent/loop.js";
import { MODES, Mode, stoppedShort } from "../agent/protocol.js";
import { rl, setSessionLineHandler, readLine, emit } from "../cli-io.js";
import { withPreamble } from "./build-step.js";
import { openChatSession, agentControls } from "./provider.js";

/**
 * The coding agent, as a long-lived session.
 *
 * One process holds the provider and the loop for as long as the Code panel
 * is open. Messages, permission answers, mode changes, interrupts, rewinds and
 * clears arrive on stdin as JSON lines; everything that happens goes out as
 * AGENT_EVENT lines. The thread is resumed where it was, so closing the app
 * does not lose the conversation - /clear is how to start over.
 */
export function agentEvent(ev: any) {
  console.log("AGENT_EVENT: " + JSON.stringify(ev));
}

export function modeOf(m: string | undefined): Mode {
  return MODES.indexOf(m as Mode) !== -1 ? (m as Mode) : "default";
}

export async function agentSessionMode(workspace: string, providerId: string, mode: string) {
  agentControls();
  const { session, config } = await openChatSession(providerId, workspace);
  const pending = new Map<string, (a: PermissionAnswer) => void>();
  const loop = new AgentLoop({
    session: session,
    workspace: workspace,
    mode: modeOf(mode),
    emit: (ev: any) => {
      // Into the app's log, where a long session's drift can be read back.
      if (ev.type === "done" && ev.drift && (ev.drift.malformed || ev.drift.missing)) console.log("AGENT_DRIFT: " + JSON.stringify(ev.drift));
      agentEvent(ev);
    },
    // The persona, skills and MCP context chosen in Settings, as every other
    // mode applies them.
    wrapFirst: withPreamble,
    // A reply that stops short of what it said it would do gets one more
    // message instead of ending the turn.
    checkFinal: async (reply) => stoppedShort(reply),
    budgetChars: budgetFor(config.contextBudgetChars),
    askPermission: (req) => new Promise<PermissionAnswer>((resolve) => {
      pending.set(req.id, resolve);
      agentEvent(Object.assign({ type: "permission" }, req));
    }),
  });
  const denyPending = () => {
    for (const [, resolve] of pending) resolve({ decision: "deny" });
    pending.clear();
  };
  const mem = loadMemory(workspace);
  agentEvent({ type: "ready", provider: config.name, workspace: workspace, mode: loop.mode, memory: mem ? mem.file : null });

  await new Promise<void>((resolve) => {
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      loop.interrupt();
      denyPending();
      // A command in flight stops now; a server it left running dies with the session.
      stopRunning();
      stopBackground();
      // Let the reply in flight finish rather than kill the browser under it.
      const wait = () => { if (!loop.busy) resolve(); else setTimeout(wait, 200); };
      wait();
    };
    setSessionLineHandler((line: string): boolean => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return false; }
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return false;
      if (closing) return true;
      switch (msg.type) {
        case "user":
          if (loop.busy) agentEvent({ type: "error", message: "Still working on the last message - wait, or press Esc to stop it." });
          else void loop.turn(String(msg.text || ""));
          break;
        case "permission": {
          const r = pending.get(msg.id);
          if (r) { pending.delete(msg.id); r({ decision: msg.decision === "always" || msg.decision === "allow" ? msg.decision : "deny", feedback: msg.feedback || undefined }); }
          break;
        }
        case "mode": loop.setMode(modeOf(msg.mode)); break;
        // Esc stops the command in flight too, rather than waiting out its
        // timeout; servers from earlier commands keep running until close.
        case "interrupt": loop.interrupt(); denyPending(); stopRunning(); agentEvent({ type: "interrupting" }); break;
        case "rewind":
          if (loop.busy) agentEvent({ type: "error", message: "Wait for the current turn to finish before rewinding." });
          else loop.rewind();
          break;
        case "clear":
          if (loop.busy) agentEvent({ type: "error", message: "Wait for the current turn to finish before clearing." });
          else void loop.clear().catch((e: any) => agentEvent({ type: "error", message: String(e && e.message ? e.message : e) }));
          break;
        case "compact":
          if (loop.busy) agentEvent({ type: "error", message: "Wait for the current turn to finish before compacting." });
          else void loop.compact()
            .then((ok) => { if (!ok) agentEvent({ type: "error", message: "This provider cannot start a new conversation." }); })
            .catch((e: any) => agentEvent({ type: "error", message: String(e && e.message ? e.message : e) }));
          break;
        case "close": close(); break;
        default: return false;
      }
      return true;
    });
    rl.on("close", close);
  });
  setSessionLineHandler(null);
  await session.close();
  agentEvent({ type: "closed" });
}

/**
 * One request from a terminal: run it to its answer and exit.
 *
 *   node local-agent/dist/index.js agent "fix the failing test" ./project deepseek [mode]
 *
 * Permission questions are asked on stdin: y to allow, a to allow for the
 * rest of the run, anything else to decline.
 */
export async function agentOnceMode(prompt: string, workspace: string, providerId: string, mode: string) {
  agentControls();
  const { session, config } = await openChatSession(providerId, workspace);
  let final = "";
  let result: any = null;
  const loop = new AgentLoop({
    session: session,
    workspace: workspace,
    mode: modeOf(mode),
    checkFinal: async (reply) => stoppedShort(reply),
    budgetChars: budgetFor(config.contextBudgetChars),
    emit: (ev: any) => {
      if (ev.type === "assistant") { final = ev.text; console.log("\n\u23fa " + ev.text.split("\n").join("\n  ")); }
      else if (ev.type === "tool" && ev.status !== "running" && ev.status !== "waiting") console.log("\u23fa " + ev.title + "\n  \u23bf  " + (ev.summary || ev.status));
      else if (ev.type === "done") result = ev;
    },
    askPermission: async (req) => {
      console.log("\n? " + req.title + (req.preview && req.preview.command ? "\n    " + req.preview.command : "") + "\n  allow? [y]es / [a]lways / [n]o");
      const answer = (await readLine()).trim().toLowerCase();
      return { decision: answer === "a" || answer === "always" ? "always" : answer === "y" || answer === "yes" ? "allow" : "deny" };
    },
  });
  try { await loop.turn(prompt); }
  finally { await session.close(); }
  emit({ success: !!result && result.reason === "complete", reason: result && result.reason, answer: final, error: result && result.error, drift: result && result.drift });
}
