/*
 * Smoke test for the native app, against the e2e suite's mock provider:
 *
 *   1. --exit-on-ready: the app starts a Code session and reports it ready.
 *   2. --bridge (no window; see native/src/Bridge.h): the real Agent and Runner
 *      services, driven as the panels drive them —
 *        - a Code session: ready, a user message, an edit that asks, allow,
 *          done, the file fixed on disk;
 *        - two one-shot runAgent calls, the second asked while the first runs:
 *          the session yields, the second run waits for the first, and a
 *          long argument is spilled to a temp file;
 *        - a program run: window request, output with its URL, input, exit
 *          code, Fix, restart and stop.
 *
 *   node native/smoke.cjs [path/to/CloseNI]
 *
 * Needs a built agent (npm run build) and Playwright's Chromium. Storage and the
 * provider config go in temporary directories, so no real profile is touched.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMockProvider } = require("../local-agent/test/mock-provider.cjs");

const root = path.join(__dirname, "..");
const exe = process.argv[2] || path.join(root, "build-native", "bin", process.platform === "win32" ? "CloseNI.exe" : "CloseNI");
const F = "```";

let failed = 0;
function check(name, cond, extra) {
  if (!cond) failed++;
  console.log((cond ? "ok   " : "FAIL ") + name + (!cond && extra ? "\n       -> " + String(extra).slice(0, 500) : ""));
}

// The app with --bridge: call(service, method, ...args) resolves with the
// method's reply; signals collect in `events` for waitFor.
function startBridge(env) {
  const proc = spawn(exe, ["--bridge"], { env: env });
  const pending = new Map();
  const events = [];
  const waiters = [];
  const lines = [];
  let nextId = 1;
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      lines.push(line);
      const m = line.match(/^BRIDGE (.*)$/);
      if (!m) continue;
      const msg = JSON.parse(m[1]);
      if (msg.signal) {
        const ev = { name: msg.signal, arg: msg.args[0] };
        events.push(ev);
        waiters.slice().forEach((w) => { if (w.test(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev.arg); } });
      } else if (pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if ("error" in msg) p.reject(new Error(msg.error)); else p.resolve(msg.result);
      }
    }
  });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  return {
    proc: proc,
    events: events,
    lines: lines,
    call(service, method, ...args) {
      const id = nextId++;
      proc.stdin.write(JSON.stringify({ id: id, service: service, method: method, args: args }) + "\n");
      return new Promise((resolve, reject) => pending.set(id, { resolve: resolve, reject: reject }));
    },
    // The first `name` signal, seen or to come, whose argument passes `test`.
    waitFor(name, test, ms) {
      const t = (ev) => ev.name === name && (!test || test(ev.arg));
      const hit = events.find(t);
      if (hit) return Promise.resolve(hit.arg);
      return new Promise((resolve) => {
        const w = { test: t, resolve: resolve };
        waiters.push(w);
        setTimeout(() => { const k = waiters.indexOf(w); if (k !== -1) { waiters.splice(k, 1); resolve(null); } }, ms || 90000);
      });
    },
    codeEvent(type, ms) {
      return this.waitFor("Agent.codeEvent", (e) => e.type === type, ms);
    },
  };
}

async function exitOnReady(env, workspace) {
  const proc = spawn(exe, ["--exit-on-ready", "--provider", "mock", "--workspace", workspace], { env: env });
  let out = "";
  proc.stdout.on("data", (d) => { out += d; });
  proc.stderr.on("data", (d) => { out += d; });
  const timer = setTimeout(() => proc.kill(), 120000);
  const code = await new Promise((resolve) => proc.on("close", resolve));
  clearTimeout(timer);
  const ready = /CloseNI: agent ready .*"provider":"Mock Provider"/.test(out);
  check("--exit-on-ready: the app starts the agent session", ready && code === 0, "exit " + code + "\n" + out.trim());
}

async function codeSession(app, mock, ws) {
  fs.writeFileSync(path.join(ws, "calc.py"), "def add(a, b):\n    return a - b\n");
  mock.setReplies([
    "Let me read it.\n\n" + F + "\n{\"tool\": \"read\", \"path\": \"calc.py\"}\n" + F,
    F + "\n{\"tool\": \"edit\", \"path\": \"calc.py\"}\n---\n<<<<<<< SEARCH\n    return a - b\n=======\n    return a + b\n>>>>>>> REPLACE\n" + F,
    "Fixed: add() now adds.",
  ]);
  const started = await app.call("Agent", "codeStart", { workspace: ws, provider: "mock", mode: "default" });
  check("codeStart: the session comes up", !!started && started.ok === true && started.mode === "default", JSON.stringify(started));
  const sent = await app.call("Agent", "codeSend", "fix the bug in calc.py");
  check("codeSend is taken", !!sent && sent.ok === true, JSON.stringify(sent));
  const perm = await app.codeEvent("permission");
  check("the edit asks, with a diff preview", !!perm && perm.tool === "edit" && /return a \+ b/.test(perm.preview.after), JSON.stringify(perm));
  if (perm) await app.call("Agent", "codePermission", perm.id, "allow", "");
  const done = await app.codeEvent("done");
  const said = app.events.some((e) => e.name === "Agent.codeEvent" && e.arg.type === "assistant" && /add\(\) now adds/.test(e.arg.text));
  check("the turn completes with the model's answer", !!done && done.reason === "complete" && said, JSON.stringify(done));
  check("the file is fixed on disk", /return a \+ b/.test(fs.readFileSync(path.join(ws, "calc.py"), "utf-8")));
  const busy = await app.call("Agent", "codeStart", { workspace: ws, provider: "mock", mode: "default" });
  check("a second codeStart joins the running session", !!busy && busy.ok === true, JSON.stringify(busy));
}

// Two runs while the Code session holds the browser, the second asked while the first runs.
async function queuedRuns(app, mock, ws) {
  mock.setReplies(["The first answer.", "The second answer."]);
  mock.setReplyDelay(1500);
  const long = "Tell me about this. " + "x".repeat(9000) + " END-OF-LONG-QUESTION";
  let promptsWhenFirstReplied = -1;
  const first = app.call("Agent", "runAgent", { args: ["chat", "first question", ws, "mock"] })
    .then((r) => { promptsWhenFirstReplied = mock.prompts().length; return r; });
  // Ask again once the first run is talking to the model.
  for (let i = 0; i < 600 && mock.prompts().length === 0; i++) await new Promise((r) => setTimeout(r, 100));
  const second = app.call("Agent", "runAgent", { args: ["chat", long, ws, "mock"] });
  const [a, b] = await Promise.all([first, second]);
  mock.setReplyDelay(0);
  check("the Code session yields to the run", !!(await app.codeEvent("closed", 1000)));
  check("runAgent: the first run answers", !!a && a.success === true && /first answer/.test(a.answer || ""), JSON.stringify(a));
  check("runAgent: the second run answers", !!b && b.success === true && /second answer/.test(b.answer || ""), JSON.stringify(b));
  check("the second run waited for the first", promptsWhenFirstReplied === 1, "prompts when the first replied: " + promptsWhenFirstReplied);
  check("the wait was reported", app.lines.some((l) => /queued: chat is waiting for the current run to finish/.test(l)));
  const prompts = mock.prompts();
  check("a long argument reaches the agent whole", /END-OF-LONG-QUESTION/.test(prompts[prompts.length - 1] || ""));
  const none = await app.call("Agent", "runAgent", {});
  check("runAgent without arguments says so", !!none && none.success === false && none.error === "No arguments for the agent.", JSON.stringify(none));
}

async function programRun(app, ws) {
  fs.writeFileSync(path.join(ws, "serve.js"), [
    "console.log('listening on http://0.0.0.0:4321/');",
    "process.stdin.once('data', (d) => { console.log('got: ' + d.toString().trim()); console.error('boom'); process.exit(3); });",
  ].join("\n"));
  fs.writeFileSync(path.join(ws, "wait.js"), "console.log('waiting'); setInterval(() => {}, 1000);\n");
  const node = JSON.stringify(process.execPath);

  const opened = await app.call("Runner", "openRunWindow", { command: node + " serve.js", cwd: ws });
  check("openRunWindow is taken", !!opened && opened.ok === true, JSON.stringify(opened));
  const win = await app.waitFor("Runner.windowRequested");
  check("it asks for a console window", !!win && win.cwd === ws && /serve\.js/.test(win.command) && /^Run - /.test(win.title), JSON.stringify(win));
  const started = await app.waitFor("Runner.started");
  check("the program starts", !!started && started.run >= 1 && started.cwd === ws, JSON.stringify(started));
  const url = await app.waitFor("Runner.output", (o) => !!o.url);
  check("its output carries the local URL", !!url && url.url === "http://localhost:4321/" && url.urlChanged === true, JSON.stringify(url));
  await app.call("Runner", "input", "hello\n");
  const exited = await app.waitFor("Runner.exited", (e) => e.run === started.run, 15000);
  check("input reaches it, and the exit code comes back", !!exited && exited.code === 3 && exited.current === true &&
    app.events.some((e) => e.name === "Runner.output" && /got: hello/.test(e.arg.text)), JSON.stringify(exited));
  const fixed = await app.call("Runner", "fix");
  const fix = await app.waitFor("Runner.runFix");
  check("Fix hands the failure to the agent", !!fixed && fixed.ok === true && !!fix && /boom/.test(fix.prompt) && fix.cwd === ws, JSON.stringify(fix));

  await app.call("Runner", "openRunWindow", { command: node + " wait.js", cwd: ws });
  const second = await app.waitFor("Runner.started", (s) => /wait\.js/.test(s.command));
  await app.waitFor("Runner.output", (o) => o.run === second.run && /waiting/.test(o.text));
  await app.call("Runner", "restart");
  const third = await app.waitFor("Runner.started", (s) => s.run > second.run);
  const replaced = await app.waitFor("Runner.exited", (e) => e.run === second.run, 15000);
  check("restart replaces the running program", !!third && !!replaced && replaced.current === false, JSON.stringify(replaced));
  await app.waitFor("Runner.output", (o) => o.run === third.run && /waiting/.test(o.text));
  await app.call("Runner", "stop");
  const stopped = await app.waitFor("Runner.exited", (e) => e.run === third.run, 15000);
  check("stop ends it with a signal", !!stopped && stopped.code === null && stopped.signal === "SIGTERM", JSON.stringify(stopped));
  await app.call("Runner", "close");
}

async function main() {
  const mock = createMockProvider();
  const baseUrl = await mock.listen();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "closeni-native-smoke-"));
  const providers = path.join(tmp, "providers");
  const workspace = path.join(tmp, "workspace");
  fs.mkdirSync(providers);
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(providers, "mock.json"), JSON.stringify({
    id: "mock",
    name: "Mock Provider",
    kind: "web",
    baseUrl: baseUrl,
    requiresLogin: false,
    enabled: false,
    selectors: { chatInput: "#input", sendButton: "#send", stopButton: "#nonexistent-stop", assistantMessage: ".assistant-msg" },
    completionRules: { waitForStopButtonDisappear: false, maxWaitMs: 30000 },
    profileDir: path.join(tmp, "profile"),
  }));

  const env = Object.assign({}, process.env, {
    AGENT_PROVIDER_DIR: providers,
    CLOSENI_STORAGE: path.join(tmp, "storage"),
    CLOSENI_NODE: process.execPath,
  });
  // No display needed unless one is asked for.
  if (!env.QT_QPA_PLATFORM) env.QT_QPA_PLATFORM = "offscreen";

  await exitOnReady(env, workspace);

  const app = startBridge(env);
  const timer = setTimeout(() => { console.log("FAIL the bridge run timed out"); app.proc.kill(); process.exit(1); }, 300000);
  try {
    await codeSession(app, mock, workspace);
    await queuedRuns(app, mock, workspace);
    await programRun(app, workspace);
  } catch (e) {
    check("the bridge run finished", false, e.stack);
  }
  app.proc.stdin.end();
  const code = await new Promise((resolve) => app.proc.on("close", resolve));
  clearTimeout(timer);
  check("the app quits cleanly when its input closes", code === 0, "exit " + code);

  await mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? failed + " failed" : "all passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
