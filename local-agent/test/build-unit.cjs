/*
 * Unit tests: The planned build: plans and their graph, scheduling, sessions, resume,
 * rollback, conversation rollover, export and the headless CLI.
 *
 * Run by run-tests.cjs (npm test), against the compiled output.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const DIST = path.join(__dirname, "..", "dist");
const { parsePlanRobust } = require(path.join(DIST, "parser/json-repair.js"));
const { applyPatch } = require(path.join(DIST, "patch/patch-applier.js"));
const F = "```";

// Handed in by run-tests.cjs, which keeps the one count.
let check, section, skipped;

function testSessionStore() {
  section("session store");
  const store = require(path.join(DIST, "session-store.js"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sess-"));
  const file = path.join(dir, "sessions.json");

  check("missing file reads as empty", JSON.stringify(store.readSessions(file)) === "{}");

  // The build used to keep a thread of its own; chat, plan and build now share
  // activeChat, so getBuildThread / setBuildThread / clearBuildThread are gone.
  // What those tests were really protecting is kept here against the API that
  // survived.
  store.writeSessions(file, {
    "/ws": {
      chats: [{ url: "https://chat.example.com/c/zzz", title: "T", createdAt: "2026-01-01" }],
      activeChat: "https://chat.example.com/c/zzz",
      activeChatProvider: "deepseek",
    },
  });
  const after = store.readSessions(file);
  check("activeChat round-trips", after["/ws"].activeChat === "https://chat.example.com/c/zzz");
  check("chats round-trip", after["/ws"].chats.length === 1);
  check("the provider that owns the thread is recorded", after["/ws"].activeChatProvider === "deepseek");

  // THE invariant of the one-conversation design: starting a build resets the
  // ledger, and must not take the conversation with it. If this ever regresses,
  // every build silently starts a new thread and every step prompt grows back
  // to carrying the whole project.
  store.setBuildLedger(file, "/ws", { "a.py": { hash: "h1", step: 0 } });
  store.resetBuildRun(file, "/ws");
  const reset = store.readSessions(file);
  check("a build reset clears the ledger",
    JSON.stringify(reset["/ws"].buildLedger) === "{}", JSON.stringify(reset["/ws"].buildLedger));
  check("a build reset leaves the conversation alone",
    reset["/ws"].activeChat === "https://chat.example.com/c/zzz", reset["/ws"].activeChat);
  check("a build reset leaves the chat list alone", reset["/ws"].chats.length === 1);

  // Session files carry live conversation URLs and must not be world-readable.
  if (process.platform !== "win32") {
    check("the session file is written 0600",
      (fs.statSync(file).mode & 0o777) === 0o600, "0" + (fs.statSync(file).mode & 0o777).toString(8));
  }

  fs.writeFileSync(file, "{ this is not json");
  check("corrupt file reads as empty", JSON.stringify(store.readSessions(file)) === "{}");

  check("workspaces are independent", (() => {
    store.setBuildLedger(file, "/a", { "x.py": { hash: "1", step: 0 } });
    store.setBuildLedger(file, "/b", { "y.py": { hash: "2", step: 0 } });
    const s = store.readSessions(file);
    return !!s["/a"].buildLedger["x.py"] && !s["/a"].buildLedger["y.py"] && !!s["/b"].buildLedger["y.py"];
  })());

  // --- build ledger
  const lf = path.join(dir, "ledger.json");
  check("missing ledger reads as empty", JSON.stringify(store.getBuildLedger(lf, "/ws")) === "{}");

  store.setBuildLedger(lf, "/ws", { "a.py": { hash: "h1", step: 0 }, "b.py": { hash: null, step: 0 } });
  const led = store.getBuildLedger(lf, "/ws");
  check("ledger round-trips", led["a.py"].hash === "h1" && led["b.py"].hash === null, JSON.stringify(led));
  check("ledger records the step", led["a.py"].step === 0);

  store.setBuildLedger(lf, "/ws", { "a.py": { hash: "h2", step: 1 } });
  check("ledger updates in place", store.getBuildLedger(lf, "/ws")["a.py"].hash === "h2");

  store.resetBuildRun(lf, "/ws");
  check("resetBuildRun clears the ledger", JSON.stringify(store.getBuildLedger(lf, "/ws")) === "{}");
  // Legacy field from when the build had a thread of its own. Still cleared, so
  // an upgraded install does not keep a stale one in its session file forever.
  check("resetBuildRun clears the legacy build thread",
    (store.readSessions(lf)["/ws"].activeBuildThread ?? null) === null);

  // The desktop app's fields must survive a reset.
  const s2 = store.readSessions(lf);
  s2["/ws"].activeChat = "https://chat.example.com/c/keepme";
  store.writeSessions(lf, s2);
  store.setBuildLedger(lf, "/ws", { "z.py": { hash: "h9", step: 3 } });
  store.resetBuildRun(lf, "/ws");
  check("resetBuildRun leaves activeChat alone", store.readSessions(lf)["/ws"].activeChat === "https://chat.example.com/c/keepme");

  fs.rmSync(dir, { recursive: true, force: true });
}

function testCompletion() {
  section("completion decision");
  const { isComplete } = require(path.join(DIST, "providers/completion.js"));
  const s = (o) => Object.assign({ started: false, stopSeen: false, stopGone: false, stableTicks: 0 }, o);

  // Nothing completes before the response has started.
  check("not started never completes", isComplete(s({ stopSeen: true, stopGone: true, stableTicks: 99 }), true, 4) === false);

  // Stop button path.
  check("started plus stop gone completes", isComplete(s({ started: true, stopSeen: true, stopGone: true }), true, 4) === true);
  check("stop seen but still present does not complete", isComplete(s({ started: true, stopSeen: true, stopGone: false }), true, 4) === false);
  // A stop button that never appeared tells us nothing; fall through to stability.
  check("stop never seen falls through to stability", isComplete(s({ started: true, stableTicks: 4 }), true, 4) === true);
  check("stop never seen and not stable does not complete", isComplete(s({ started: true, stableTicks: 2 }), true, 4) === false);

  // Stability path when the provider has no stop button.
  check("without stop button, stability completes", isComplete(s({ started: true, stableTicks: 4 }), false, 4) === true);
  check("without stop button, short stability does not", isComplete(s({ started: true, stableTicks: 3 }), false, 4) === false);
  // The stop-button signal must be ignored entirely when not configured.
  check("stop signal ignored when not configured", isComplete(s({ started: true, stopSeen: true, stopGone: true, stableTicks: 0 }), false, 4) === false);
}

function testPlanScale() {
  section("plan scale");
  const { estimateDuration, MAX_PLAN_STEPS } = require(path.join(DIST, "plan-scale.js"));

  check("the bound is 40", MAX_PLAN_STEPS === 40);

  // Each step is a browser round-trip of a minute or two, so a long plan is a
  // long build. The estimate exists so that is a choice, not a surprise.
  check("a short plan reads in minutes", /min/.test(estimateDuration(3)), estimateDuration(3));
  check("a long plan reads differently", estimateDuration(30) !== estimateDuration(3));
  check("zero steps is survivable", typeof estimateDuration(0) === "string");

  const mk = (n) => {
    const steps = [];
    for (let i = 0; i < n; i++) steps.push({ title: "s" + i, detail: "d", files: ["f" + i + ".py"] });
    return F + "json\n" + JSON.stringify({ summary: "x", steps: steps }) + "\n" + F;
  };

  // The eight-step cap was the complaint. Anything up to the bound must parse.
  check("a nine-step plan parses", (parsePlanRobust(mk(9)) || {}).steps.length === 9);
  check("a twenty-step plan parses", (parsePlanRobust(mk(20)) || {}).steps.length === 20);
  check("exactly forty parses", (parsePlanRobust(mk(40)) || {}).steps.length === 40);

  // Rejecting rather than truncating: a truncated plan silently loses the end
  // of the project - deployment, tests - while looking like it worked.
  check("forty-one is rejected, not truncated", parsePlanRobust(mk(41)) === null);

  // runCommand is optional so older and hand-written plans still parse.
  const withRun = F + 'json\n{"summary":"x","runCommand":"python3 app.py","steps":[{"title":"t","detail":"d","files":["a.py"]}]}\n' + F;
  check("a plan may declare how to run itself", parsePlanRobust(withRun).runCommand === "python3 app.py");
  check("a plan without runCommand still parses",
    !!parsePlanRobust(F + 'json\n{"summary":"x","steps":[{"title":"t","detail":"d","files":["a.py"]}]}\n' + F));

  // The renderer cannot require the agent's module - no bundler, no require -
  // so the estimate is duplicated in desktop/plan-scale.js. Duplication is only
  // acceptable while something proves the copies agree.
  const ui = require(path.join(__dirname, "..", "..", "desktop", "plan-scale.js"));
  [0, 1, 3, 8, 20, 40, 100].forEach(function (n) {
    check("both copies agree at " + n + " steps",
      ui.estimateDuration(n) === estimateDuration(n),
      "ui=" + ui.estimateDuration(n) + " agent=" + estimateDuration(n));
  });
}

function testRunManifest() {
  section("run manifest");
  const m = require(path.join(DIST, "run-manifest.js"));

  check("the manifest has a stable name", m.MANIFEST_NAME === "closeni.run.json");

  // --- resolution order. This is the logic behind the original complaint:
  // "no entry point found" when the app already knew the answer.
  const man = { version: 1, run: "python3 src/app/server.py" };
  check("the manifest wins", m.resolveRun(man, "python3 other.py", "python3 main.py").command === "python3 src/app/server.py");
  check("and says so", m.resolveRun(man, "x", "y").source === "manifest");
  check("the plan wins over detection", m.resolveRun(null, "python3 plan.py", "python3 main.py").command === "python3 plan.py");
  check("and says so", m.resolveRun(null, "python3 plan.py", "y").source === "plan");
  check("detection is the fallback", m.resolveRun(null, undefined, "python3 main.py").source === "detected");
  // "none" rather than a broken command: the panel says it found nothing.
  check("nothing found is reported", m.resolveRun(null, undefined, null).source === "none");
  check("and yields no command", m.resolveRun(null, undefined, null).command === null);
  // An empty run must fall through, not resolve to "".
  check("an empty manifest run falls through",
    m.resolveRun({ version: 1, run: "" }, undefined, "python3 main.py").source === "detected");
  check("a whitespace run falls through",
    m.resolveRun({ version: 1, run: "  " }, "python3 plan.py", null).source === "plan");

  // --- an edited command survives a rebuild. Watching the next build undo your
  // correction is how people stop trusting a tool.
  const edited = m.mergeManifest({ version: 1, run: "python3 mine.py", userEdited: true }, "python3 generated.py");
  check("an edited command is kept", edited.run === "python3 mine.py");
  check("and stays flagged", edited.userEdited === true);
  const fresh = m.mergeManifest({ version: 1, run: "python3 old.py", userEdited: false }, "python3 new.py");
  check("an unedited command is replaced", fresh.run === "python3 new.py");
  check("editing sets the flag",
    m.mergeManifest(null, "python3 x.py", { userEdited: true }).userEdited === true);
  check("a new manifest carries a version", m.mergeManifest(null, "python3 x.py").version === 1);
  check("extra fields are kept",
    m.mergeManifest(null, "python3 x.py", { install: "pip install -r requirements.txt" }).install === "pip install -r requirements.txt");

  // --- scripts
  const sh = m.renderRunScript({ version: 1, run: "python3 app.py", install: "pip install -r requirements.txt" }, "posix");
  check("the shell script has a shebang", sh.indexOf("#!/bin/sh") === 0, sh.slice(0, 20));
  check("the shell script installs first", sh.indexOf("pip install") < sh.indexOf("python3 app.py"));
  check("the shell script runs the command", sh.indexOf("python3 app.py") !== -1);
  const bat = m.renderRunScript({ version: 1, run: "python app.py" }, "win32");
  check("the batch file suppresses echo", bat.indexOf("@echo off") === 0, bat.slice(0, 20));
  check("the batch file runs the command", bat.indexOf("python app.py") !== -1);
  // A command with quotes must survive verbatim - mangling it produces a script
  // that fails in a way nobody can explain.
  const quoted = m.renderRunScript({ version: 1, run: 'python3 -c "print(1)"' }, "posix");
  check("quotes survive", quoted.indexOf('python3 -c "print(1)"') !== -1, quoted);
}

function testRunTarget() {
  section("run target");
  const { venvCommand, looksGraphical, fixPrompt } = require(path.join(__dirname, "..", "..", "desktop", "run-target.js"));
  check("python runs from the project's venv", venvCommand("python3 game.py", "/p/.venv/bin/python") === "/p/.venv/bin/python game.py");
  check("a path with spaces is quoted", venvCommand("python main.py", "/my p/.venv/bin/python") === '"/my p/.venv/bin/python" main.py');
  check("no venv leaves the command alone", venvCommand("python3 game.py", null) === "python3 game.py");
  check("nor does a command that is not python", venvCommand("npm start", "/p/.venv/bin/python") === "npm start");
  check("python3x is not python3", venvCommand("python3x a.py", "/v") === "python3x a.py");
  check("a pygame program opens a window", looksGraphical(["import sys\nimport pygame\n"]));
  check("so does a tkinter one", looksGraphical(["from tkinter import ttk"]));
  check("a console program does not", !looksGraphical(["import sys\nprint('pygame')\n"]));
  const RT = require(path.join(__dirname, "..", "..", "desktop", "run-target.js"));
  check("a pygame or Qt program is checked unseen", RT.checkableHeadless(["import sys\nimport pygame\n"]) && RT.checkableHeadless(["from PySide6.QtWidgets import QApplication"]));
  check("a console script is never started on its own", !RT.checkableHeadless(["import os\nfor f in os.listdir(): os.rename(f, f + '.bak')\n"]));
  check("nor one with a toolkit that needs a screen", !RT.checkableHeadless(["import tkinter"]) && !RT.checkableHeadless(["import pygame", "import turtle"]));
  check("still up at the limit, or a clean exit, is a start", RT.startedOk({ timedOut: true, code: null }) && RT.startedOk({ code: 0 }) && !RT.startedOk({ code: 1 }) && !RT.startedOk({ code: null, signal: "SIGSEGV" }));
  check("the check runs SDL and Qt without a screen", RT.HEADLESS.SDL_VIDEODRIVER === "dummy" && RT.HEADLESS.QT_QPA_PLATFORM === "offscreen");
  const crash = fixPrompt({ command: "python game.py", output: "Traceback\nNameError: x\n\n", code: 1, signal: null, gui: false });
  check("a fix request names the command and how it ended", crash.indexOf("`python game.py` exited with code 1") !== -1, crash);
  check("and carries the error", crash.indexOf("```\nTraceback\nNameError: x\n```") !== -1, crash);
  check("a console program is rerun as it is", crash.indexOf("headless") === -1);
  check("a windowed one is checked headless and time-limited", /SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy timeout 5 python game\.py/.test(fixPrompt({ command: "python game.py", output: "", code: 1, gui: true })));
  const long = fixPrompt({ command: "p", output: "BANNER\n" + "line\n".repeat(3000) + "KeyError: 'end'\n", code: 1 });
  check("long output keeps its end", long.indexOf("KeyError: 'end'") !== -1 && long.indexOf("BANNER") === -1 && long.length < 7000, long.length);
  check("from a line start", long.indexOf("```\n...\nline\n") !== -1);
}

function testPreviewTarget() {
  section("preview target");
  const { previewTarget } = require(path.join(__dirname, "..", "..", "desktop", "preview-target.js"));

  // Real output from the servers these projects actually produce.
  const flask = " * Running on http://127.0.0.1:5000\n * Press CTRL+C to quit";
  check("a flask url is found", previewTarget(flask, []).url === "http://127.0.0.1:5000");
  check("and is a server", previewTarget(flask, []).kind === "server");
  const vite = "  VITE v5.0.0  ready in 300 ms\n  Local:   http://localhost:5173/";
  check("a vite url is found", previewTarget(vite, []).url === "http://localhost:5173/");
  const py = "Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...";
  check("a python http.server url is found", previewTarget(py, []).url.indexOf("8000") !== -1);
  // The last url wins: a server that reprints its address as it restarts should
  // not pin the preview to the first line it ever wrote.
  check("the last url wins",
    previewTarget("http://localhost:1111\nhttp://localhost:2222", []).url === "http://localhost:2222");

  // No server: a static page is the next best thing.
  check("index.html is used when there is no url", previewTarget("", ["index.html"]).kind === "file");
  check("and points at the file", previewTarget("", ["index.html"]).url.indexOf("index.html") !== -1);
  check("a nested index.html is found", previewTarget("", ["public/index.html"]).url.indexOf("public/index.html") !== -1);
  check("a root index.html beats a nested one",
    previewTarget("", ["public/index.html", "index.html"]).url.indexOf("public") === -1);

  // Nothing to show means the toggle hides, rather than an empty frame.
  check("no url and no html yields nothing", previewTarget("", ["main.py"]) === null);
  check("empty input is survivable", previewTarget("", []) === null);
  check("missing input is survivable", previewTarget(null, null) === null);
  // A documentation link in a traceback is not a server, and pointing the
  // preview at the open internet is not what anyone asked for.
  check("an external doc link is ignored", previewTarget("see https://docs.python.org/3/", []) === null);
}

function testPlanGraph() {
  section("plan graph");
  const g = require(path.join(DIST, "plan-graph.js"));
  const steps = (deps) => deps.map(function (d) { return d === null ? {} : { dependsOn: d }; });

  check("an empty graph is fine", g.validateGraph([]).ok === true);
  check("a valid graph passes", g.validateGraph(steps([[], [0], [0], [1, 2]])).ok === true);

  // Rejected at parse time rather than discovered at deadlock.
  check("a self-reference is rejected", g.validateGraph(steps([[0]])).ok === false);
  check("and says why", /self/i.test(g.validateGraph(steps([[0]])).reason || ""));
  check("a two-step cycle is rejected", g.validateGraph(steps([[1], [0]])).ok === false);
  check("a long cycle is rejected", g.validateGraph(steps([[2], [0], [1]])).ok === false);
  check("a forward reference is rejected", g.validateGraph(steps([[1], []])).ok === false);
  check("an index past the end is rejected", g.validateGraph(steps([[], [9]])).ok === false);
  check("a negative index is rejected", g.validateGraph(steps([[], [-1]])).ok === false);
  check("a non-integer index is rejected", g.validateGraph([{ dependsOn: ["a"] }]).ok === false);
  check("dependsOn that is not an array is rejected", g.validateGraph([{ dependsOn: 3 }]).ok === false);

  // Absent means serial. Every plan that exists today is such a plan, and this
  // is the rule that keeps them behaving exactly as they do now.
  check("no graph at all becomes a chain",
    JSON.stringify(g.normaliseGraph(steps([null, null, null]))) === JSON.stringify([[], [0], [1]]));
  check("serialGraph builds the same chain",
    JSON.stringify(g.serialGraph(3)) === JSON.stringify([[], [0], [1]]));
  check("serialGraph of one has no dependencies",
    JSON.stringify(g.serialGraph(1)) === JSON.stringify([[]]));
  check("serialGraph of zero is empty", JSON.stringify(g.serialGraph(0)) === "[]");

  // A partially-declared plan is treated as declared: a model that answered the
  // question at all is trusted, and an empty list is a real answer.
  check("a declared empty list stays empty",
    JSON.stringify(g.normaliseGraph(steps([[], []]))) === JSON.stringify([[], []]));
  check("mixed declaration keeps what was declared",
    JSON.stringify(g.normaliseGraph([{ dependsOn: [] }, {}, { dependsOn: [0] }])) ===
    JSON.stringify([[], [], [0]]));
}

function testScheduler() {
  section("scheduler");
  const { runnableSteps, blockedBy } = require(path.join(__dirname, "..", "..", "desktop", "scheduler.js"));
  const S = (o) => Object.assign({ completed: [], failed: [], blocked: [], skipped: [], running: [] }, o);
  const serial = [[], [0], [1], [2]];
  const diamond = [[], [0], [0], [1, 2]];

  // The guarantee that nothing regresses: a chain yields one step at a time
  // however high the limit.
  check("a chain starts only the first", JSON.stringify(runnableSteps(serial, S({}), 4)) === "[0]");
  check("a chain stays one at a time",
    JSON.stringify(runnableSteps(serial, S({ completed: [0] }), 4)) === "[1]");

  // Independent steps run together, up to the limit.
  check("a diamond starts one, then two",
    JSON.stringify(runnableSteps(diamond, S({ completed: [0] }), 4)) === "[1,2]");
  check("the limit caps them",
    JSON.stringify(runnableSteps(diamond, S({ completed: [0] }), 1)) === "[1]");
  check("steps already running count against the limit",
    JSON.stringify(runnableSteps(diamond, S({ completed: [0], running: [1] }), 2)) === "[2]");
  check("a full pipeline starts nothing",
    JSON.stringify(runnableSteps(diamond, S({ completed: [0], running: [1, 2] }), 2)) === "[]");

  // A join waits for every dependency. Step 2 is still offered here - it only
  // needs step 0 - so the assertion is about step 3 specifically.
  check("a join waits for both",
    runnableSteps(diamond, S({ completed: [0, 1] }), 4).indexOf(3) === -1,
    JSON.stringify(runnableSteps(diamond, S({ completed: [0, 1] }), 4)));
  check("a join with one branch running still waits",
    JSON.stringify(runnableSteps(diamond, S({ completed: [0, 1], running: [2] }), 4)) === "[]");
  check("and starts once both are done",
    JSON.stringify(runnableSteps(diamond, S({ completed: [0, 1, 2] }), 4)) === "[3]");

  // Nothing left to do returns nothing, rather than looping forever.
  check("everything complete yields nothing",
    JSON.stringify(runnableSteps(diamond, S({ completed: [0, 1, 2, 3] }), 4)) === "[]");
  check("a running step is not offered twice",
    runnableSteps(diamond, S({ completed: [0], running: [1, 2] }), 9).indexOf(1) === -1);
  check("a completed step is not offered again",
    runnableSteps(serial, S({ completed: [0, 1] }), 9).indexOf(0) === -1);

  // A skipped step counts as satisfied - the user chose to move past it, and
  // blocking everything downstream would make Skip useless.
  check("a skipped dependency unblocks its dependent",
    JSON.stringify(runnableSteps(serial, S({ skipped: [0] }), 4)) === "[1]");

  // --- failure fans out, and blocked is not failed
  check("a failed step blocks its direct dependent",
    JSON.stringify(blockedBy(serial, [1])) === "[2,3]");
  check("failure blocks transitively", JSON.stringify(blockedBy(diamond, [0])) === "[1,2,3]");
  check("a failed branch blocks only its own side",
    JSON.stringify(blockedBy(diamond, [1])) === "[3]");
  check("a failure at the end blocks nothing", JSON.stringify(blockedBy(diamond, [3])) === "[]");
  check("nothing failed blocks nothing", JSON.stringify(blockedBy(diamond, [])) === "[]");
  check("a blocked step is never runnable",
    JSON.stringify(runnableSteps(serial, S({ failed: [0], blocked: [1, 2, 3] }), 4)) === "[]");
  check("a failed step does not unblock its dependent",
    JSON.stringify(runnableSteps(serial, S({ failed: [0] }), 4)) === "[]");

  // --- resuming. Without this, pressing Build after a partial run re-runs
  // every completed step from the beginning, which is what made recovering
  // from a failure feel like starting over.
  const { seedState } = require(path.join(__dirname, "..", "..", "desktop", "scheduler.js"));
  const St = (statuses) => statuses.map(function (x) { return { status: x }; });

  const fresh = seedState(St(["pending", "pending", "pending"]));
  check("a fresh plan seeds nothing done", JSON.stringify(fresh.completed) === "[]");
  const part = seedState(St(["done", "done", "failed", "pending"]));
  check("finished steps are remembered", JSON.stringify(part.completed) === "[0,1]");
  check("a failure is remembered", JSON.stringify(part.failed) === "[2]");
  check("pending steps stay runnable", part.completed.indexOf(3) === -1 && part.failed.indexOf(3) === -1);
  check("skipped is remembered",
    JSON.stringify(seedState(St(["skipped", "pending"])).skipped) === "[0]");
  check("blocked is remembered",
    JSON.stringify(seedState(St(["failed", "blocked"])).blocked) === "[1]");

  // A step left "running" when the app closed is not running now. Treating it
  // as in-flight would wedge the scheduler waiting for something that will
  // never report back.
  const interrupted = seedState(St(["done", "running", "pending"]));
  check("an interrupted step is not still running", JSON.stringify(interrupted.running) === "[]");
  check("and becomes runnable again",
    JSON.stringify(runnableSteps([[], [0], [1]], interrupted, 2)) === "[1]");

  // Seeded state must drive the scheduler straight to the next unfinished step.
  check("a resumed build continues rather than restarting",
    JSON.stringify(runnableSteps([[], [0], [1], [2]], seedState(St(["done", "done", "pending", "pending"])), 1)) === "[2]");
}

async function testAsyncPool() {
  section("async primitives");
  const { createMutex, createPool } = require(path.join(DIST, "async-pool.js"));
  const wait = (ms) => new Promise(function (r) { setTimeout(r, ms); });

  // The mutex is what makes "parallel conversations, serialised applies" true.
  // If two bodies ever overlap, two workers could interleave writes to the
  // ledger, or - worse - both prompt for command approval, and the replies
  // arrive on one stdin queue with nothing saying which command they answer.
  const m = createMutex();
  let inside = 0;
  let maxInside = 0;
  const order = [];
  await Promise.all([1, 2, 3, 4].map(function (n) {
    return m.run(async function () {
      inside++;
      maxInside = Math.max(maxInside, inside);
      await wait(20);
      order.push(n);
      inside--;
      return n;
    });
  }));
  check("only one body runs at a time", maxInside === 1, "max=" + maxInside);
  check("all four ran", order.length === 4);
  check("they ran in the order they queued", JSON.stringify(order) === "[1,2,3,4]");
  check("the result is returned", (await m.run(async function () { return 7; })) === 7);

  // A throwing body must release the lock, or the whole build stops dead.
  let threw = false;
  try { await m.run(async function () { throw new Error("boom"); }); } catch (e) { threw = true; }
  check("a throwing body propagates", threw === true);
  check("and does not wedge the mutex", (await m.run(async function () { return "after"; })) === "after");

  // The pool hands out the workers.
  const pool = createPool(["a", "b"]);
  check("the pool reports its size", pool.size() === 2);
  const first = await pool.acquire();
  const second = await pool.acquire();
  check("two acquires give different items", first !== second);

  let third = null;
  const pending = pool.acquire().then(function (v) { third = v; });
  await wait(10);
  check("a third acquire waits", third === null);
  pool.release(first);
  await pending;
  check("and is served on release", third === first);
}

async function testAgentQueue() {
  section("agent run queue");

  // Mirrors queueAgentRun in desktop/main.js. Every agent run opens the same
  // Chromium profile directory, and Chromium locks it - two runs at once means
  // the second gets a profile it cannot own, an empty page, and a "Chat input
  // not found" that looks like a broken selector. So runs must not overlap.
  let agentQueue = Promise.resolve();
  function queueAgentRun(task) {
    const run = agentQueue.then(function () { return task(); }, function () { return task(); });
    agentQueue = run.then(function () {}, function () {});
    return run;
  }

  const events = [];
  function job(name, ms, shouldFail) {
    return function () {
      return new Promise(function (resolve, reject) {
        events.push(name + ":start");
        setTimeout(function () {
          events.push(name + ":end");
          shouldFail ? reject(new Error(name)) : resolve(name);
        }, ms);
      });
    };
  }

  // A slow run first, then a fast one: without a queue the fast one finishes
  // inside the slow one, which is exactly the failure that was observed.
  const runs = [
    queueAgentRun(job("chat", 40)),
    queueAgentRun(job("plan", 5)),
    queueAgentRun(job("boom", 5, true)),
    queueAgentRun(job("after", 5)),
  ];
  await Promise.all(runs.map(function (p) { return p.catch(function () {}); }));

  let depth = 0;
  let overlapped = false;
  events.forEach(function (e) {
    if (e.indexOf(":start") !== -1) { depth++; if (depth > 1) overlapped = true; } else depth--;
  });

  check("agent runs never overlap", !overlapped, events.join(" "));
  check("runs execute in the order they were queued",
    events.join(",") === "chat:start,chat:end,plan:start,plan:end,boom:start,boom:end,after:start,after:end");
  // One rejected run must not wedge the queue for everything behind it.
  check("a failed run does not stall the queue", events.indexOf("after:end") !== -1);

  // --- session handoff -----------------------------------------------------
  // Mirrors end-session / start-session in desktop/main.js. end-session used to
  // null the handle and return at once, so starting another build immediately
  // spawned a second agent onto a Chromium profile the first still held. The
  // dying session's in-flight step then failed with "Target page, context or
  // browser has been closed" and the new one reported "no session".
  function fakeProc(name, exitAfterMs, log) {
    const handlers = {};
    const proc = {
      name: name,
      once: function (e, f) { (handlers[e] = handlers[e] || []).push(f); },
      stdin: {
        writable: true,
        write: function () {
          setTimeout(function () {
            log.push(name + ":exited");
            (handlers.close || []).forEach(function (f) { f(); });
          }, exitAfterMs);
        },
      },
      kill: function () {},
    };
    return proc;
  }

  async function handoff() {
    const log = [];
    let sessionProc = fakeProc("A", 40, log);
    let sessionClosing = null;

    // end-session
    const proc = sessionProc;
    sessionProc = null;
    sessionClosing = new Promise(function (resolve) {
      let done = false;
      const finish = function () { if (done) return; done = true; sessionClosing = null; resolve(); };
      proc.once("close", finish);
      try { proc.stdin.write("{}"); } catch (e) {}
      setTimeout(finish, 15000);
    });

    // start-session, immediately after
    if (sessionClosing) await sessionClosing;
    log.push("B:spawns");
    sessionProc = fakeProc("B", 10, log);
    return log;
  }

  const order = await handoff();
  check("a new session waits for the old one to exit",
    order.join(",") === "A:exited,B:spawns", order.join(","));

  // The old close handler nulled the handle unconditionally, so a late close
  // from a replaced session wiped the live one.
  let live = { id: "B" };
  const stale = { id: "A" };
  (function onCloseOfStale(p) { if (live === p) live = null; })(stale);
  check("a stale session closing does not clear its replacement", live !== null);
}

function testSchedulerGraph() {
  section("a plan's declared dependencies reach the scheduler");
  const sched = require(path.join(__dirname, "..", "..", "desktop", "scheduler.js"));

  function withDeps(list) { return list.map(function (d) { return { dependsOn: d }; }); }

  // The regression this exists for. The renderer built its step list without
  // dependsOn, so every plan looked undeclared, became a chain, and one
  // failure blocked everything behind it.
  const declared = sched.graphFor(withDeps([[], [0], [], [1, 2]]));
  check("declared dependencies are used", declared.declared === true);
  check("and kept exactly", JSON.stringify(declared.graph) === JSON.stringify([[], [0], [], [1, 2]]));
  check("no reason is reported for a good graph", !declared.reason);

  const none = sched.graphFor([{}, {}, {}]);
  check("an undeclared plan is still a chain",
    JSON.stringify(none.graph) === JSON.stringify([[], [0], [1]]));
  check("and says it was not declared", none.declared === false);
  check("an empty plan yields an empty graph", JSON.stringify(sched.graphFor([]).graph) === "[]");
  check("a null plan does not throw", JSON.stringify(sched.graphFor(null).graph) === "[]");

  // An empty list is an answer, not a silence: step 1 declaring [] means it
  // genuinely waits for nothing.
  const empties = sched.graphFor(withDeps([[], []]));
  check("an all-empty declaration is honoured, not treated as absent",
    empties.declared === true && JSON.stringify(empties.graph) === JSON.stringify([[], []]));

  // Anything unschedulable falls back to the chain rather than hanging the
  // build with nothing running and nothing able to start.
  const cyclic = sched.graphFor(withDeps([[1], [0]]));
  check("a cycle falls back to the chain",
    JSON.stringify(cyclic.graph) === JSON.stringify([[], [0]]) && cyclic.declared === false);
  check("and says why", /later/.test(cyclic.reason || ""), cyclic.reason);
  check("a self-reference falls back", sched.graphFor(withDeps([[], [1]])).declared === false);
  check("an out-of-range index falls back", sched.graphFor(withDeps([[], [9]])).declared === false);
  check("a negative index falls back", sched.graphFor(withDeps([[], [-1]])).declared === false);
  check("a non-number falls back", sched.graphFor(withDeps([[], ["a"]])).declared === false);
  check("a fractional index falls back", sched.graphFor(withDeps([[], [0.5]])).declared === false);
  check("the reason names a human step number, not an index",
    /step 2/.test(sched.graphFor(withDeps([[], [9]])).reason || ""),
    sched.graphFor(withDeps([[], [9]])).reason);

  // The point of all of it: an unrelated step must survive a failure.
  const graph = sched.graphFor(withDeps([[], [0], [], [2]])).graph;
  const blocked = sched.blockedBy(graph, [0]);
  check("a failure blocks only what depended on it",
    JSON.stringify(blocked) === JSON.stringify([1]), JSON.stringify(blocked));
  const state = { completed: [], failed: [0], blocked: [1], skipped: [], running: [] };
  check("an independent step is still runnable after that failure",
    JSON.stringify(sched.runnableSteps(graph, state, 1)) === JSON.stringify([2]));

  // And under the old chain it would not have been - the assertion that this
  // change is doing something.
  const chain = sched.graphFor([{}, {}, {}, {}]).graph;
  check("under a chain that same failure blocks everything after it",
    JSON.stringify(sched.blockedBy(chain, [0])) === JSON.stringify([1, 2, 3]));
}

function testBuildState() {
  section("a build survives closing the app");
  const B = require(path.join(DIST, "build-state.js"));

  const plan = { summary: "Flask habit tracker", runCommand: "python app.py" };
  const steps = [
    { title: "Scaffold", detail: "make dirs", files: ["app.py"], dependsOn: [], status: "done" },
    { title: "Schema", detail: "sqlite", files: ["db.py"], dependsOn: [0], status: "failed" },
    { title: "Routes", detail: "crud", files: ["routes.py"], dependsOn: [0], status: "pending" },
  ];

  const state = B.serialiseBuildState(plan, steps, { provider: "deepseek", now: "2026-08-11T10:00:00.000Z" });
  check("the summary is kept", state.summary === "Flask habit tracker");
  check("so is the run command", state.runCommand === "python app.py");
  check("and the provider", state.provider === "deepseek");
  check("startedAt defaults to now", state.startedAt === "2026-08-11T10:00:00.000Z");

  // The regression that ate the last feature: dependsOn dropped in a map.
  check("dependsOn survives serialising",
    JSON.stringify(state.steps.map(function (s) { return s.dependsOn; })) === JSON.stringify([[], [0], [0]]));

  const back = B.parseBuildState(JSON.stringify(state));
  check("it round-trips", JSON.stringify(back.steps) === JSON.stringify(state.steps), JSON.stringify(back.steps));
  check("statuses come back", back.steps[0].status === "done" && back.steps[1].status === "failed");

  // A step that was running when the app closed is not running now. Restoring
  // it as running would seed the scheduler with a step it waits on forever.
  const mid = B.parseBuildState(JSON.stringify(
    B.serialiseBuildState(plan, [{ title: "x", detail: "", files: [], status: "running" }], {})));
  check("a step caught mid-run comes back pending", mid.steps[0].status === "pending");

  // Anything unreadable means "no build here", never a crash: refusing to open
  // a workspace because a state file is malformed is worse than no resume.
  check("garbage is no build", B.parseBuildState("{{{") === null);
  check("null is no build", B.parseBuildState(null) === null);
  check("an array is no build", B.parseBuildState("[1,2]") === null);
  check("a wrong version is no build", B.parseBuildState('{"version":99,"steps":[{}]}') === null);
  check("no steps is no build", B.parseBuildState('{"version":1,"steps":[]}') === null);
  check("a non-object step is no build", B.parseBuildState('{"version":1,"steps":[5]}') === null);
  check("an unknown status reads as pending",
    B.parseBuildState('{"version":1,"steps":[{"status":"exploded"}]}').steps[0].status === "pending");
  check("a missing files array becomes empty",
    JSON.stringify(B.parseBuildState('{"version":1,"steps":[{"title":"a"}]}').steps[0].files) === "[]");
  check("a non-string in files is dropped",
    JSON.stringify(B.parseBuildState('{"version":1,"steps":[{"files":["a",7,null]}]}').steps[0].files) === '["a"]');

  const prog = B.describeProgress(back);
  check("progress counts done steps", prog.done === 1 && prog.total === 3);
  check("and knows it is unfinished", prog.unfinished === true);
  // A skipped step is finished as far as the user is concerned - the scheduler
  // already treats it as a satisfied dependency.
  const allDone = B.parseBuildState(JSON.stringify(B.serialiseBuildState(plan,
    [{ title: "a", status: "done" }, { title: "b", status: "skipped" }], {})));
  check("a skipped step counts as finished", B.describeProgress(allDone).unfinished === false);
  check("no state is not unfinished", B.describeProgress(null).unfinished === false);

  // Where it goes. The workspace, beside closeni.run.json - so the answer
  // survives this install rather than living in app state.

  // Timing round-trips with the rest of a build, and is re-validated on read:
  // this is JSON on disk a person can edit, and a NaN reaching formatDuration
  // would print "NaNms" in the report.
  const timed = B.serialiseBuildState(plan,
    [{ title: "a", status: "done", timing: { totalMs: 104100, phases: { writing: 78000, checking: 23400 } } }], {});
  check("timing is stored", timed.steps[0].timing.totalMs === 104100);
  check("and its phases", timed.steps[0].timing.phases.writing === 78000);
  const readBack = B.parseBuildState(JSON.stringify(timed));
  check("timing survives a restart", readBack.steps[0].timing.phases.checking === 23400);
  check("a NaN total is dropped",
    B.parseBuildState('{"version":1,"steps":[{"timing":{"totalMs":"soon"}}]}').steps[0].timing === undefined);
  check("a negative phase is dropped",
    JSON.stringify(B.parseBuildState('{"version":1,"steps":[{"timing":{"totalMs":5,"phases":{"a":-3,"b":7}}}]}')
      .steps[0].timing.phases) === '{"b":7}');
  check("a step with no timing stays without one",
    B.parseBuildState('{"version":1,"steps":[{"title":"a"}]}').steps[0].timing === undefined);

  check("it is stored in the workspace", B.BUILD_STATE_DIR === ".closeni" && B.BUILD_STATE_NAME === "build.json");
}

function testCheckpoints() {
  section("undoing a step");
  const C = require(path.join(DIST, "checkpoint.js"));

  // A step that created streaks.py and overwrote app.py.
  let cp4 = C.mergeCheckpoint(null, 3, { "streaks.py": null, "app.py": "APP v3" }, { at: "T1" });
  check("a created file records no prior", cp4.files["streaks.py"].prior === null);
  check("an overwritten one records its contents", cp4.files["app.py"].prior === "APP v3");

  // The repair loop applies again. The second apply sees app.py as the FIRST
  // one left it - recording that would restore the middle of the step.
  cp4 = C.mergeCheckpoint(cp4, 3, { "app.py": "APP v4-broken", "util.py": null });
  check("the first prior wins within a step", cp4.files["app.py"].prior === "APP v3");
  check("a file first seen in the retry is still recorded", cp4.files["util.py"].prior === null);
  check("the step number is kept", cp4.step === 3);

  const sealed4 = C.sealCheckpoint(cp4, { "app.py": "APP v4", "streaks.py": "S", "util.py": "U" });
  check("sealing records what the step left", sealed4.files["app.py"].after === C.hash("APP v4"));
  check("and keeps the prior", sealed4.files["app.py"].prior === "APP v3");

  const sealed5 = C.sealCheckpoint(
    C.mergeCheckpoint(null, 4, { "app.py": "APP v4", "routes.py": null }, { at: "T2" }),
    { "app.py": "APP v5", "routes.py": "R" });

  // Rolling back to before step 4 (index 3) undoes 4 and 5 together.
  const plan = C.planRollback([sealed4, sealed5], 3,
    { "app.py": "APP v5", "streaks.py": "S", "util.py": "U", "routes.py": "R" });

  check("both steps are undone", JSON.stringify(plan.steps) === JSON.stringify([3, 4]));
  // Step 5 also touched app.py, but step 4 saw it first - and step 4's prior is
  // the state before the rollback target, which is the whole point.
  check("a file touched twice restores to the earliest prior", plan.restore["app.py"] === "APP v3");
  check("files created by the undone steps are removed",
    JSON.stringify(plan.remove.sort()) === JSON.stringify(["routes.py", "streaks.py", "util.py"]));
  check("nothing drifted when the files are as the build left them",
    plan.drifted.length === 0, JSON.stringify(plan.drifted));

  // A hand edit since the build wrote it must be named, not silently lost.
  const edited = C.planRollback([sealed4, sealed5], 3,
    { "app.py": "APP v5 + my fix", "streaks.py": "S", "util.py": "U", "routes.py": "R" });
  check("an edit made since is reported as drift",
    JSON.stringify(edited.drifted) === JSON.stringify(["app.py"]), JSON.stringify(edited.drifted));
  check("drift is judged against the LAST step to write the file",
    edited.restore["app.py"] === "APP v3");
  const deleted = C.planRollback([sealed4, sealed5], 3,
    { "app.py": "APP v5", "streaks.py": null, "util.py": "U", "routes.py": "R" });
  check("a file deleted by hand also counts as drift",
    deleted.drifted.indexOf("streaks.py") !== -1, JSON.stringify(deleted.drifted));
  // Claiming drift over a file nobody looked at would block a good rollback.
  const unknown = C.planRollback([sealed4, sealed5], 3, {});
  check("a file the caller did not read is not called drifted", unknown.drifted.length === 0);

  // Rolling back to a later step leaves the earlier ones alone.
  const later = C.planRollback([sealed4, sealed5], 4, { "app.py": "APP v5", "routes.py": "R" });
  check("only steps at or after the target are undone",
    JSON.stringify(later.steps) === JSON.stringify([4]));
  check("and the file goes back to what step 5 found", later.restore["app.py"] === "APP v4");
  check("step 4's creations are untouched", later.remove.indexOf("streaks.py") === -1);

  // A file too large to have been stored is admitted to, not half-restored.
  const big = C.mergeCheckpoint(null, 0, { "data.bin": "x".repeat(C.MAX_PRIOR_BYTES + 1) });
  check("an oversized prior is not stored", big.files["data.bin"].prior === null);
  check("and is flagged", big.files["data.bin"].tooLarge === true);
  const bigPlan = C.planRollback([C.sealCheckpoint(big, { "data.bin": "y" })], 0, { "data.bin": "y" });
  check("it is reported as unrestorable",
    JSON.stringify(bigPlan.unrestorable) === JSON.stringify(["data.bin"]));
  check("and is neither restored nor removed",
    !bigPlan.restore["data.bin"] && bigPlan.remove.indexOf("data.bin") === -1);

  // Reading back.
  const round = C.parseCheckpoint(JSON.stringify(sealed4));
  check("a checkpoint round-trips", JSON.stringify(round.files) === JSON.stringify(sealed4.files));
  check("garbage is no checkpoint", C.parseCheckpoint("{{") === null);
  check("a wrong version is no checkpoint", C.parseCheckpoint('{"version":9,"step":0,"files":{}}') === null);
  check("a missing step number is no checkpoint", C.parseCheckpoint('{"version":1,"files":{}}') === null);
  check("a negative step is no checkpoint", C.parseCheckpoint('{"version":1,"step":-2,"files":{}}') === null);
  check("no checkpoints means nothing to undo", C.planRollback([], 0, {}).steps.length === 0);
  check("the file name sorts in step order",
    C.checkpointName(0) === "step-001.json" && C.checkpointName(11) === "step-012.json");
}

function testRollbackOnDisk() {
  section("a rollback returns a real workspace to where it was");
  const C = require(path.join(DIST, "checkpoint.js"));
  const { applyPatch } = require(path.join(DIST, "patch/patch-applier.js"));

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-rollback-"));
  fs.writeFileSync(path.join(ws, "app.py"), "print('v3')\n");

  function priors(paths) {
    const o = {};
    paths.forEach(function (r) {
      try { o[r] = fs.readFileSync(path.join(ws, r), "utf-8"); } catch (e) { o[r] = null; }
    });
    return o;
  }
  function afters(cp) { return priors(Object.keys(cp.files)); }

  // Step 4 rewrites app.py and adds streaks.py.
  const cp3 = C.mergeCheckpoint(null, 3, priors(["app.py", "streaks.py"]));
  applyPatch(ws, { changes: [
    { filePath: "app.py", mode: "overwrite", newContent: "print('v4')\n" },
    { filePath: "streaks.py", mode: "create", newContent: "S=1\n" }] });
  const s3 = C.sealCheckpoint(cp3, afters(cp3));

  // Step 5 rewrites app.py again and adds routes.py.
  const cp4 = C.mergeCheckpoint(null, 4, priors(["app.py", "routes.py"]));
  applyPatch(ws, { changes: [
    { filePath: "app.py", mode: "overwrite", newContent: "print('v5')\n" },
    { filePath: "routes.py", mode: "create", newContent: "R=1\n" }] });
  const s4 = C.sealCheckpoint(cp4, afters(cp4));

  const plan = C.planRollback([s3, s4], 3, priors(["app.py", "streaks.py", "routes.py"]));
  check("the plan sees no drift on an untouched workspace", plan.drifted.length === 0, JSON.stringify(plan.drifted));

  Object.keys(plan.restore).forEach(function (r) { fs.writeFileSync(path.join(ws, r), plan.restore[r]); });
  plan.remove.forEach(function (r) { fs.rmSync(path.join(ws, r), { force: true }); });

  check("the overwritten file is back to before step 4",
    fs.readFileSync(path.join(ws, "app.py"), "utf8") === "print('v3')\n",
    fs.readFileSync(path.join(ws, "app.py"), "utf8"));
  check("the file step 4 created is gone", !fs.existsSync(path.join(ws, "streaks.py")));
  check("so is the one step 5 created", !fs.existsSync(path.join(ws, "routes.py")));

  fs.rmSync(ws, { recursive: true, force: true });
}

function testContextBudget() {
  section("a build moves to a new conversation before it outgrows one");
  const B = require(path.join(DIST, "context-budget.js"));

  check("a new thread starts empty", B.emptySize().chars === 0 && B.emptySize().turns === 0);

  let size = B.addTurn(B.emptySize(), 1000, 4000);
  check("a turn counts both directions", size.chars === 5000 && size.turns === 1);
  size = B.addTurn(size, 500, 2500);
  check("turns accumulate", size.chars === 8000 && size.turns === 2);
  check("a reply that could not be read still counts its prompt",
    B.addTurn(B.emptySize(), 900, 0).chars === 900);
  check("negative and NaN inputs do not corrupt the count",
    B.addTurn(B.emptySize(), -5, NaN).chars === 0);

  const budget = 100000;
  check("a half-full thread keeps going", !B.shouldRollOver({ chars: 50000, turns: 5 }, budget));
  check("one at the threshold rolls over", B.shouldRollOver({ chars: 80000, turns: 9 }, budget));
  check("and just under it does not", !B.shouldRollOver({ chars: 79999, turns: 9 }, budget));

  // The decision is about whether the COMING exchange fits. A thread at 70%
  // about to be sent a large prompt should move now, while it is free to.
  check("a large next prompt brings the rollover forward",
    B.shouldRollOver({ chars: 70000, turns: 8 }, budget, 15000));
  check("a small one does not", !B.shouldRollOver({ chars: 70000, turns: 8 }, budget, 500));

  // Rolling over a thread that has said nothing would loop: there is nowhere
  // cheaper to send the prompt than the empty conversation it is already in.
  check("a fresh thread never rolls over, however large the prompt",
    !B.shouldRollOver({ chars: 0, turns: 0 }, budget, 10 * 1000 * 1000));

  check("a missing budget falls back to the default",
    B.budgetFor(undefined) === B.DEFAULT_BUDGET_CHARS && B.budgetFor(0) === B.DEFAULT_BUDGET_CHARS);
  check("a configured budget is used", B.budgetFor(42000) === 42000);
  check("a nonsense budget falls back", B.budgetFor("lots") === B.DEFAULT_BUDGET_CHARS);

  // Storage round-trips through JSON, so anything can come back.
  check("a malformed stored size reads as a new thread",
    B.readSize(null).chars === 0 && B.readSize("x").turns === 0 &&
    B.readSize({ chars: "many" }).chars === 0);
  check("a valid stored size survives", B.readSize({ chars: 12, turns: 3 }).chars === 12);

  check("the description is in percent, not raw characters",
    /50% of the conversation budget/.test(B.describeSize({ chars: 50000, turns: 4 }, budget)),
    B.describeSize({ chars: 50000, turns: 4 }, budget));
  check("one turn is not pluralised", /^1 turn,/.test(B.describeSize({ chars: 1, turns: 1 }, budget)));

  // Every provider config has to carry a budget, or the one that does not gets
  // the default silently and nobody finds out until a build fifteen steps in.
  const dir = path.join(__dirname, "..", "config", "providers");
  fs.readdirSync(dir).filter(function (f) { return f.endsWith(".json"); }).forEach(function (f) {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    check(f + " declares a context budget", typeof cfg.contextBudgetChars === "number" && cfg.contextBudgetChars > 0);
  });
}

function testExportBranch() {
  section("a build replayed as one commit per step");
  const E = require(path.join(DIST, "export-branch.js"));
  const C = require(path.join(DIST, "checkpoint.js"));

  check("a branch name is slugged", E.branchName("Flask Habit Tracker!") === "closeni/flask-habit-tracker");
  check("an empty summary still names a branch", E.branchName("") === "closeni/build");
  check("punctuation only still names a branch", E.branchName("!!!") === "closeni/build");
  check("a long summary is trimmed without a trailing dash",
    !/-$/.test(E.branchName("a very long project summary that goes on and on and on and on")));
  check("a commit subject is one line", E.commitMessage(5, "Streak\ncalculation") === "step 6: Streak calculation");
  check("an untitled step still says something", E.commitMessage(0, "") === "step 1: changes");

  // Step 4 creates streaks.py and rewrites app.py; step 5 rewrites app.py again
  // and creates routes.py. The content after step 4 is nowhere stored - it is
  // recovered from what step 5 recorded as its prior.
  function cp(step, files, title) { return { version: 1, step: step, title: title, at: "", files: files }; }
  const checkpoints = [
    cp(3, { "app.py": { prior: "v3", after: "h4" }, "streaks.py": { prior: null, after: "hs" } }, "Streaks"),
    cp(4, { "app.py": { prior: "v4", after: "h5" }, "routes.py": { prior: null, after: "hr" } }, "Routes"),
  ];
  const current = { "app.py": "v5", "streaks.py": "S", "routes.py": "R" };
  const plan = E.planCommits(checkpoints, current);

  check("one commit per step", plan.commits.length === 2);
  check("commits are in step order", plan.commits[0].step === 3 && plan.commits[1].step === 4);
  // The whole trick: step 5's prior IS step 4's result.
  check("a file's after-state comes from the next step that touched it",
    plan.commits[0].writes["app.py"] === "v4", JSON.stringify(plan.commits[0].writes));
  check("a file nothing touched again takes its content from disk",
    plan.commits[0].writes["streaks.py"] === "S");
  check("the last step's file also comes from disk", plan.commits[1].writes["app.py"] === "v5");
  check("a file created later is not in an earlier commit",
    !("routes.py" in plan.commits[0].writes));
  check("titles are carried", plan.commits[0].title === "Streaks");
  check("titles can be overridden from the plan",
    E.planCommits(checkpoints, current, { 3: "Better name" }).commits[0].title === "Better name");
  check("a clean build warns about nothing", plan.warnings.length === 0, JSON.stringify(plan.warnings));

  // The bug that only showed up by running it against a real repository.
  //
  // The export refuses on a dirty tree, so the user commits the finished build
  // first - which means HEAD already holds every file. Staging only the paths a
  // step touched leaves the rest at HEAD's version, so step 4's commit contained
  // routes.py, which step 5 created. Every commit stages every build path at its
  // state as of that step, so a file that does not exist yet is a deletion.
  check("a file a later step creates is deleted in earlier commits",
    plan.commits[0].deletes.indexOf("routes.py") !== -1, JSON.stringify(plan.commits[0].deletes));
  check("and is written once its step arrives", plan.commits[1].writes["routes.py"] === "R");
  check("a file an earlier step created stays written later",
    plan.commits[1].writes["streaks.py"] === "S");


  // A file deleted since the build must be represented as absent, not written.
  const gone = E.planCommits(checkpoints, { "app.py": "v5", "streaks.py": null, "routes.py": "R" });
  check("a file gone from disk becomes a delete",
    gone.commits[0].deletes.indexOf("streaks.py") !== -1, JSON.stringify(gone.commits[0].deletes));
  check("and is not also written", !("streaks.py" in gone.commits[0].writes));

  // Unreadable is not the same as absent. Treating it as a delete would turn an
  // export into data loss.
  const unread = E.planCommits(checkpoints, { "app.py": "v5", "routes.py": "R" });
  check("an unreadable file is neither written nor deleted",
    !("streaks.py" in unread.commits[0].writes) &&
    unread.commits[0].deletes.indexOf("streaks.py") === -1);
  check("and it is warned about", /streaks\.py/.test(unread.warnings.join(" ")), JSON.stringify(unread.warnings));

  // A prior we never stored means the history is approximate, and says so.
  const big = E.planCommits(
    [cp(0, { "data.bin": { prior: null, after: null, tooLarge: true } })], { "data.bin": "x" });
  check("an unrecorded prior is warned about", /too large/.test(big.warnings.join(" ")), JSON.stringify(big.warnings));

  check("no checkpoints means no commits", E.planCommits([], {}).commits.length === 0);
  check("null input does not throw", E.planCommits(null, null).commits.length === 0);
}

function testPlanEdit() {
  section("editing a plan without breaking its graph");
  const P = require(path.join(__dirname, "..", "..", "desktop", "plan-edit.js"));
  const sched = require(path.join(__dirname, "..", "..", "desktop", "scheduler.js"));

  function mk(deps) { return deps.map(function (d, i) { return { title: "s" + (i + 1), dependsOn: d }; }); }
  function depsOf(r) { return r.steps.map(function (s) { return s.dependsOn; }); }

  // 1 <- 2 <- 3 <- 4, and 5 independent.
  const plan = mk([[], [0], [1], [2], []]);

  // Deleting a step hands its dependents what IT needed. Dropping the
  // reference instead would lose an ordering the model stated.
  const del = P.deleteStep(plan, 2);
  check("the step is gone", del.steps.length === 4);
  check("its dependents inherit its dependencies",
    JSON.stringify(depsOf(del)) === JSON.stringify([[], [0], [1], []]), JSON.stringify(depsOf(del)));
  check("and the change is explained", /now depends on step 2/.test(del.notes.join(" ")), JSON.stringify(del.notes));
  check("the result still schedules", sched.graphFor(del.steps).declared === true);

  // Deleting step 1, which nothing depended through.
  const delFirst = P.deleteStep(plan, 0);
  check("deleting the first step shifts everything down",
    JSON.stringify(depsOf(delFirst)) === JSON.stringify([[], [0], [1], []]), JSON.stringify(depsOf(delFirst)));
  check("a one-step plan refuses deletion", !!P.deleteStep(mk([[]]), 0).refused);
  check("an out-of-range delete is refused", !!P.deleteStep(plan, 9).refused);

  // undefined and [] mean different things to the scheduler, so an undeclared
  // step must not become a declared one.
  const undeclared = [{ title: "a" }, { title: "b" }, { title: "c" }];
  check("an undeclared step stays undeclared",
    P.deleteStep(undeclared, 1).steps.every(function (s) { return s.dependsOn === undefined; }));
  check("and the plan still reads as a chain",
    sched.graphFor(P.deleteStep(undeclared, 1).steps).declared === false);

  // Moving is refused when it would invert a real dependency.
  const bad = P.moveStep(plan, 3, 0);
  check("moving a step above its dependency is refused", !!bad.refused, bad.refused);
  check("the refusal names both steps", /step 4 depends on step 3/.test(bad.refused), bad.refused);
  check("and the plan is untouched", bad.steps === bad.steps && JSON.stringify(depsOf(bad)) === JSON.stringify([[], [0], [1], [2], []]));

  // The case a naive check misses: the step being dragged is fine, but moving
  // it strands something that depended on it.
  const stranded = P.moveStep(plan, 1, 4);
  check("moving a step below its dependents is also refused", !!stranded.refused, stranded.refused);

  // A legal move remaps every index.
  const ok = P.moveStep(plan, 4, 0);
  check("a legal move succeeds", !ok.refused, ok.refused);
  check("every dependency index moves with the step it points at",
    JSON.stringify(depsOf(ok)) === JSON.stringify([[], [], [1], [2], [3]]), JSON.stringify(depsOf(ok)));
  check("the moved step is first", ok.steps[0].title === "s5");
  check("the result still schedules", sched.graphFor(ok.steps).declared === true);
  check("moving to the same place changes nothing", JSON.stringify(P.moveStep(plan, 2, 2).steps) === JSON.stringify(plan));

  // Merging folds a step into the one above it.
  const rich = [
    { title: "Schema", detail: "tables", files: ["db.py"], dependsOn: [] },
    { title: "Migrations", detail: "alembic", files: ["mig.py"], dependsOn: [0], testable: true },
    { title: "Routes", detail: "crud", files: ["r.py"], dependsOn: [1] },
  ];
  const merged = P.mergeStepUp(rich, 1);
  check("two steps become one", merged.steps.length === 2);
  check("titles are joined", merged.steps[0].title === "Schema + Migrations");
  check("details are kept", /tables[\s\S]*alembic/.test(merged.steps[0].detail));
  check("files are unioned", JSON.stringify(merged.steps[0].files) === JSON.stringify(["db.py", "mig.py"]));
  check("testable survives if either half had it", merged.steps[0].testable === true);
  check("the merged step does not depend on itself",
    JSON.stringify(merged.steps[0].dependsOn) === "[]", JSON.stringify(merged.steps[0].dependsOn));
  check("what followed now depends on the merged step",
    JSON.stringify(merged.steps[1].dependsOn) === "[0]", JSON.stringify(merged.steps[1].dependsOn));
  check("merging the first step is refused", !!P.mergeStepUp(rich, 0).refused);
  check("the result still schedules", sched.graphFor(merged.steps).declared === true);
}

function testStepTiming() {
  section("where a build's time went");
  const T = require(path.join(__dirname, "..", "..", "desktop", "step-timing.js"));

  // A step: 2s before the first phase is reported, then sending, writing,
  // applying, checking - and 1s after the last phase closes.
  let t = T.newTimer(0);
  T.markPhase(t, "sending", 2000);
  T.markPhase(t, "writing", 2400);
  T.markPhase(t, "applying", 80400);
  T.markPhase(t, "checking", 80700);
  T.finish(t, 104100);

  check("the total is wall clock for the step", t.totalMs === 104100, String(t.totalMs));
  check("the model wait is attributed to writing", t.phases.writing === 78000, String(t.phases.writing));
  check("sending is its own line", t.phases.sending === 400);
  check("applying is separated from checking", t.phases.applying === 300 && t.phases.checking === 23400);

  // Time before any phase is reported belongs to nothing, and saying so beats
  // folding it into a neighbour - a timing report that guesses starts lying.
  check("time before the first phase is unattributed", t.phases[T.UNATTRIBUTED] === 2000, JSON.stringify(t.phases));
  check("every millisecond is accounted for",
    Object.keys(t.phases).reduce(function (a, k) { return a + t.phases[k]; }, 0) === t.totalMs);

  const rows = T.phaseRows(t);
  check("phases are listed longest first", rows[0].phase === "writing" && rows[1].phase === "checking");
  check("zero-length phases are dropped", rows.every(function (r) { return r.ms > 0; }));

  check("finishing twice does not double-count", T.finish(t, 999999).totalMs === 104100);

  // A build rolls its steps together.
  let u = T.newTimer(0);
  T.markPhase(u, "writing", 0);
  T.finish(u, 10000);
  const sum = T.summarise([t, u]);
  check("every step is counted", sum.steps === 2);
  check("totals add up", sum.totalMs === 114100);
  check("writing dominates", sum.phases[0].phase === "writing" && sum.phases[0].ms === 88000);
  check("percentages are of counted time, not the clock",
    sum.phases.reduce(function (a, r) { return a + r.percent; }, 0) >= 99);
  check("an empty build does not throw", T.summarise([]).totalMs === 0);
  check("nulls are ignored", T.summarise([null, undefined]).steps === 0);

  // Durations someone can read at a glance.
  check("sub-second is milliseconds", T.formatDuration(400) === "400ms");
  check("seconds keep one decimal", T.formatDuration(23400) === "23.4s");
  check("minutes drop it", T.formatDuration(102000) === "1m 42s");
  check("seconds are zero-padded", T.formatDuration(64000) === "1m 04s");
  // 59.6s rounds to 60 and would otherwise read as "3m 60s".
  check("a rounding carry rolls the minute", T.formatDuration(239600) === "4m 00s");
  check("zero is zero", T.formatDuration(0) === "0ms");
  check("nonsense does not throw", T.formatDuration(NaN) === "0ms" && T.formatDuration(-5) === "0ms");

  // Only the durable half is stored.
  const rec = T.toRecord(t);
  check("a record keeps the total and the phases", rec.totalMs === 104100 && rec.phases.writing === 78000);
  check("and drops the live cursor", !("phaseAt" in rec) && !("phase" in rec));
  check("no timer means no record", T.toRecord(null) === undefined);
}

async function testHeadlessCli() {
  section("a build with no window");
  const cp = require("child_process");
  const B = require(path.join(DIST, "build-state.js"));
  const ROOT = path.join(__dirname, "..", "..");
  const fake = "node " + JSON.stringify(path.join(__dirname, "fixtures", "fake-agent.js"));

  function makeWorkspace(steps) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-cli-"));
    fs.mkdirSync(path.join(ws, ".closeni"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".closeni", "build.json"),
      JSON.stringify(B.serialiseBuildState({ summary: "Demo" }, steps, {}), null, 2));
    return ws;
  }
  function run(ws, env) {
    return cp.spawnSync("node", [path.join(ROOT, "bin", "closeni.js"), "build", ws, "--json"], {
      encoding: "utf8", timeout: 60000,
      env: Object.assign({}, process.env, { CLOSENI_AGENT_CMD: fake }, env || {}),
    });
  }
  function events(out) {
    return String(out || "").split("\n").filter(Boolean).map(function (l) {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
  }
  function readState(ws) {
    return B.parseBuildState(fs.readFileSync(path.join(ws, ".closeni", "build.json"), "utf8"));
  }

  // 1 <- 2 <- 3, and 4 depending on nothing. Step 2 fails.
  const plan = [
    { title: "Scaffold", detail: "d", files: [], dependsOn: [], status: "pending" },
    { title: "Schema", detail: "d", files: [], dependsOn: [0], status: "pending" },
    { title: "Routes", detail: "d", files: [], dependsOn: [1], status: "pending" },
    { title: "Docs", detail: "d", files: [], dependsOn: [], status: "pending" },
  ];

  let ws = makeWorkspace(plan);
  let r = run(ws, { FAKE_FAIL_STEPS: "1" });
  let ev = events(r.stdout);
  function has(type, index) {
    return ev.some(function (e) { return e.type === type && (index === undefined || e.index === index); });
  }

  check("the declared graph is used", has("graph") && ev[0].declared === true, JSON.stringify(ev[0]));
  check("step 1 runs and finishes", has("step-done", 0));
  check("step 2 fails", has("step-failed", 1));
  check("step 3 is blocked, not failed", has("step-blocked", 2) && !has("step-failed", 2));
  // §2's whole point, executing for real rather than in a unit test: step 4
  // depends on nothing, so a failure at step 2 must not stop it.
  check("step 4 still runs, because nothing it needed failed", has("step-done", 3));
  check("a build with a failed step exits non-zero", r.status === 1, String(r.status));

  let st = readState(ws);
  check("the statuses are written to disk",
    st.steps.map(function (s) { return s.status; }).join(",") === "done,failed,blocked,done",
    st.steps.map(function (s) { return s.status; }).join(","));
  check("timing is recorded per step", st.steps[0].timing.totalMs >= 0 && st.steps[0].timing.phases.writing > 0,
    JSON.stringify(st.steps[0].timing));

  // Running again resumes: what succeeded is kept, what failed is retried.
  r = run(ws);
  ev = events(r.stdout);
  check("a second run resumes rather than restarting", ev.some(function (e) { return e.type === "resume" && e.done === 2; }),
    JSON.stringify(ev.filter(function (e) { return e.type === "resume"; })));
  check("the completed steps are not run again", !has("step-start", 0) && !has("step-start", 3));
  check("the failed step is retried", has("step-start", 1));
  check("and what it blocked runs too", has("step-done", 2));
  check("a completed build exits zero", r.status === 0, String(r.status));
  check("every step ends done", readState(ws).steps.every(function (s) { return s.status === "done"; }));

  fs.rmSync(ws, { recursive: true, force: true });

  // A plan whose graph cannot be scheduled falls back to the chain rather than
  // refusing, exactly as the app does.
  ws = makeWorkspace([
    { title: "a", detail: "d", files: [], dependsOn: [1], status: "pending" },
    { title: "b", detail: "d", files: [], dependsOn: [], status: "pending" },
  ]);
  ev = events(run(ws).stdout);
  check("an unschedulable graph falls back to the chain",
    ev[0].type === "graph" && ev[0].declared === false && /later/.test(ev[0].reason || ""),
    JSON.stringify(ev[0]));
  fs.rmSync(ws, { recursive: true, force: true });

  // Refusals, which are the paths a script hits first.
  const noPlan = cp.spawnSync("node", [path.join(ROOT, "bin", "closeni.js"), "build", os.tmpdir()],
    { encoding: "utf8", timeout: 20000 });
  check("no plan exits 2 and says where it looked", noPlan.status === 2 && /build\.json/.test(noPlan.stderr));
  const badAuto = cp.spawnSync("node", [path.join(ROOT, "bin", "closeni.js"), "build", os.tmpdir(), "--autonomy", "yolo"],
    { encoding: "utf8", timeout: 20000 });
  check("an unknown autonomy is refused", badAuto.status === 2, String(badAuto.status));
  const help = cp.spawnSync("node", [path.join(ROOT, "bin", "closeni.js")], { encoding: "utf8", timeout: 20000 });
  check("no arguments prints usage", /closeni build/.test(help.stdout));
}

async function run(c, s, sk) {
  check = c; section = s; skipped = sk;
  testSessionStore();
  testCompletion();
  testPlanScale();
  testPlanGraph();
  testScheduler();
  await testAsyncPool();
  testRunManifest();
  testPreviewTarget();
  testRunTarget();
  await testAgentQueue();
  testSchedulerGraph();
  testBuildState();
  testCheckpoints();
  testRollbackOnDisk();
  testContextBudget();
  testExportBranch();
  testPlanEdit();
  testStepTiming();
  await testHeadlessCli();
}

module.exports = { run };
