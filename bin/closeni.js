#!/usr/bin/env node
/*
 * CloseNI without a window.
 *
 *   closeni build ./project [--provider deepseek] [--autonomy auto] [--json]
 *
 * Runs a plan that already exists - the .closeni/build.json the app writes -
 * with the same scheduling, dependencies, checkpoints and resume as the
 * desktop build. Deliberately does NOT plan: the plan is the thing most worth a
 * human eye before eighteen steps run against it, and a headless command is the
 * one place nobody looks at it.
 *
 * No refactor was needed to get here, which was the surprise. desktop/
 * scheduler.js was already pure and already require()able from Node - the unit
 * suite has been loading it that way for weeks. The renderer's step loop is
 * DOM-bound and 772 lines, but the part that decides what runs next never was.
 *
 * This is also the first way the whole build path can run outside Electron,
 * which is exactly the surface nothing could test.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const sched = require(path.join(ROOT, "desktop", "scheduler.js"));
const timing = require(path.join(ROOT, "desktop", "step-timing.js"));
const buildState = require(path.join(ROOT, "local-agent", "dist", "build-state.js"));

function usage(code) {
  process.stdout.write([
    "closeni build <workspace> [options]",
    "",
    "  Runs the plan in <workspace>/.closeni/build.json with no window.",
    "  Generate the plan in the app first; this only builds it.",
    "",
    "  --provider <id>    default deepseek",
    "  --autonomy <mode>  ask | auto | never   (default: never)",
    "  --json             one JSON object per event on stdout, for scripts",
    "",
    "  Exit code is 0 only if every step finished.",
    "",
  ].join("\n"));
  process.exit(code);
}

function parseArgs(argv) {
  const out = { cmd: argv[0], workspace: argv[1], provider: "deepseek", autonomy: "never", json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--provider") out.provider = argv[++i];
    else if (a === "--autonomy") out.autonomy = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else return Object.assign(out, { bad: a });
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.cmd !== "build" || !args.workspace) usage(args.cmd ? 2 : 0);
if (args.bad) { process.stderr.write("unknown option: " + args.bad + "\n"); usage(2); }
if (["ask", "auto", "never"].indexOf(args.autonomy) === -1) {
  process.stderr.write("autonomy must be ask, auto or never\n");
  process.exit(2);
}

const workspace = path.resolve(args.workspace);

/*
 * "never" rather than "auto" by default.
 *
 * The desktop app can ask. A headless run cannot, so the choice is between
 * running whatever the model suggests unattended and running none of it. Nobody
 * is watching, so the default is the one that cannot surprise you; --autonomy
 * auto is there for when you have decided otherwise.
 */

function say(line) { if (!args.json) process.stdout.write(line + "\n"); }
function emit(obj) { if (args.json) process.stdout.write(JSON.stringify(obj) + "\n"); }
function report(obj, line) { emit(obj); say(line); }

const statePath = path.join(workspace, buildState.BUILD_STATE_DIR, buildState.BUILD_STATE_NAME);
let state;
try {
  state = buildState.parseBuildState(fs.readFileSync(statePath, "utf-8"));
} catch (e) {
  state = null;
}
if (!state) {
  process.stderr.write("No plan found at " + statePath + "\n" +
    "Generate one in the app first - this command only builds an existing plan.\n");
  process.exit(2);
}

const steps = state.steps.map(function (s) { return Object.assign({}, s); });

// Same graph the app builds, from the same module, with the same fallback.
const built = sched.graphFor(steps);
if (built.reason) report({ type: "graph", declared: false, reason: built.reason },
  "plan dependencies unusable (" + built.reason + ") - running in order");
else if (built.declared) report({ type: "graph", declared: true },
  "plan declares its own dependencies");

const st = sched.seedState(steps);
// A step that failed last time is being retried by running again, so clear it
// and anything it blocked - otherwise the whole subtree reads as settled.
st.failed.concat(st.blocked).forEach(function (i) { steps[i].status = "pending"; });
st.failed = [];
st.blocked = [];
const resuming = st.completed.length > 0;
if (resuming) report({ type: "resume", done: st.completed.length, total: steps.length },
  "resuming: " + st.completed.length + "/" + steps.length + " already done");

/* --------------------------------------------------------------- the agent -- */

const agentCmd = process.env.CLOSENI_AGENT_CMD ||
  (process.execPath + " " + JSON.stringify(path.join(ROOT, "local-agent", "dist", "index.js")));

const proc = spawn(agentCmd + " build-session " + JSON.stringify(workspace) + " " +
  args.provider + " " + args.autonomy, {
  shell: true,
  env: Object.assign({}, process.env, {
    AGENT_HEADED: "0",
    AGENT_RESUMING: resuming ? "1" : "0",
  }),
});

let waiters = { ready: null, step: {}, closed: null };
let buffer = "";
let stepTimer = null;

proc.stdout.on("data", function (chunk) {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    handle(line);
  }
});
proc.stderr.on("data", function (d) { if (!args.json) process.stderr.write(d); });

function handle(line) {
  // The agent already reports every phase at the moment it observed it, so the
  // CLI times exactly what the app times, from the same signal.
  if (line.indexOf("PHASE:") === 0) {
    try {
      const p = JSON.parse(line.slice(6));
      if (stepTimer) timing.markPhase(stepTimer, p.phase === "idle" ? null : p.phase);
    } catch (e) { /* an unreadable phase line is not worth failing a build over */ }
    return;
  }
  if (line.indexOf("SESSION_EVENT: ") !== 0) return;
  let ev;
  try { ev = JSON.parse(line.slice(15)); } catch (e) { return; }

  if (ev.type === "ready" && waiters.ready) { const f = waiters.ready; waiters.ready = null; f(); }
  else if (ev.type === "closed" && waiters.closed) { const f = waiters.closed; waiters.closed = null; f(); }
  else if (ev.type === "health") {
    report({ type: "health", ok: ev.ok, summary: ev.summary },
      "selectors: " + ev.summary);
  } else if (ev.type === "step-result") {
    const f = waiters.step[ev.index];
    if (f) { delete waiters.step[ev.index]; f(ev); }
  }
}

function send(obj) { proc.stdin.write(JSON.stringify(obj) + "\n"); }
function waitReady() { return new Promise(function (r) { waiters.ready = r; }); }
function waitClosed() { return new Promise(function (r) { waiters.closed = r; }); }
function waitStep(i) { return new Promise(function (r) { waiters.step[i] = r; }); }

function save() {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(
      buildState.serialiseBuildState(
        { summary: state.summary, runCommand: state.runCommand },
        steps,
        { provider: args.provider, startedAt: state.startedAt }),
      null, 2) + "\n");
  } catch (e) {
    // Never fatal, for the same reason it is not in the app: a read-only
    // workspace should cost the resume, not the run.
  }
}

/* ------------------------------------------------------------------- build -- */

(async function main() {
  let exitCode = 0;
  const failedProc = new Promise(function (resolve) {
    proc.on("error", function (e) {
      process.stderr.write("could not start the agent: " + e.message + "\n");
      resolve("spawn-failed");
    });
    proc.on("close", function () { resolve("closed"); });
  });

  const ready = await Promise.race([waitReady().then(function () { return "ready"; }), failedProc]);
  if (ready !== "ready") { process.exit(1); }
  report({ type: "ready" }, "build session ready");

  while (true) {
    const runnable = sched.runnableSteps(built.graph, st, 1);
    if (!runnable.length) break;
    const i = runnable[0];

    st.running.push(i);
    steps[i].status = "running";
    save();
    report({ type: "step-start", index: i, title: steps[i].title },
      "step " + (i + 1) + "/" + steps.length + "  " + (steps[i].title || ""));

    stepTimer = timing.newTimer(Date.now());
    const detail = "Overall: " + (state.summary || "") +
      "\n\nExecute ONLY this step: " + (steps[i].title || "") + ". " + (steps[i].detail || "") +
      (steps[i].files && steps[i].files.length ? " Expected files: " + steps[i].files.join(", ") : "");

    send({ type: "step", index: i, detail: detail, prompt: detail,
           goal: state.summary || "", testable: !!steps[i].testable });

    const res = await Promise.race([waitStep(i), failedProc.then(function () { return null; })]);
    timing.finish(stepTimer, Date.now());
    steps[i].timing = timing.toRecord(stepTimer);
    stepTimer = null;

    st.running = st.running.filter(function (x) { return x !== i; });

    if (res && res.success) {
      st.completed.push(i);
      steps[i].status = "done";
      report({ type: "step-done", index: i, timing: steps[i].timing },
        "  done in " + timing.formatDuration(steps[i].timing.totalMs) + " - " +
        (res.appliedFiles || []).join(", "));
    } else {
      st.failed.push(i);
      steps[i].status = "failed";
      exitCode = 1;
      report({ type: "step-failed", index: i, error: (res && res.error) || "the agent stopped" },
        "  FAILED: " + ((res && res.error) || "the agent stopped"));
      // Blocked, not failed: these never ran, and calling them failed would
      // claim something about code nobody executed.
      sched.blockedBy(built.graph, st.failed).forEach(function (b) {
        if (st.blocked.indexOf(b) !== -1 || st.completed.indexOf(b) !== -1 ||
            st.failed.indexOf(b) !== -1) return;
        st.blocked.push(b);
        steps[b].status = "blocked";
        report({ type: "step-blocked", index: b },
          "  step " + (b + 1) + " blocked: a step it depends on failed");
      });
      if (!res) break;
    }
    save();
  }

  send({ type: "close" });
  await Promise.race([waitClosed(), failedProc, new Promise(function (r) { setTimeout(r, 30000); })]);
  try { proc.stdin.end(); } catch (e) {}

  const done = steps.filter(function (s) { return s.status === "done" || s.status === "skipped"; }).length;
  const roll = timing.summarise(steps.map(function (s) {
    return s.timing ? { totalMs: s.timing.totalMs, phases: s.timing.phases } : null;
  }));
  report({ type: "finished", done: done, total: steps.length, totalMs: roll.totalMs, phases: roll.phases },
    "\nbuild finished " + done + "/" + steps.length +
    (roll.totalMs ? "   " + timing.formatDuration(roll.totalMs) : ""));
  if (!args.json) {
    roll.phases.forEach(function (r) {
      say("  " + r.phase.padEnd(14) + timing.formatDuration(r.ms) + "  (" + r.percent + "%)");
    });
  }
  save();
  process.exit(done === steps.length ? 0 : exitCode || 1);
})();
