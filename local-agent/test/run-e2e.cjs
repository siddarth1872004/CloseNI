/*
 * End-to-end tests for the agent's chat / plan / build modes.
 *
 * These spawn the real CLI (dist/index.js) against a mock chat provider, so the
 * full path runs for real: Playwright drives a browser, the reply is extracted
 * from the DOM, parsed, applied to a workspace, and syntax checked. Only the
 * model's answers are faked.
 *
 * Needs Playwright's chromium; skips cleanly if it is unavailable.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMockProvider } = require("./mock-provider.cjs");

const AGENT = path.join(__dirname, "..", "dist", "index.js");
// Unique per run. A fixed path under the repo means two suites running at once
// delete each other's provider config mid-run, which surfaces as the baffling
// "Provider not found: mock" rather than as the collision it is.
const PROVIDER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-e2e-providers-"));
const F = "```";

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log("  ok   " + name);
  } else {
    fail++;
    failures.push(name);
    console.log("  FAIL " + name + (extra ? "\n         -> " + String(extra).slice(0, 500) : ""));
  }
}

function section(name) {
  console.log("\n" + name);
}

function writeProviderConfig(baseUrl, profileDir) {
  fs.mkdirSync(PROVIDER_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(PROVIDER_DIR, "mock.json"),
    JSON.stringify(
      {
        id: "mock",
        name: "Mock Provider",
        kind: "web",
        baseUrl: baseUrl,
        requiresLogin: false,
        enabled: false,
        selectors: {
          chatInput: "#input",
          sendButton: "#send",
          stopButton: "#nonexistent-stop",
          assistantMessage: ".assistant-msg",
        },
        completionRules: { waitForStopButtonDisappear: false, maxWaitMs: 30000 },
        profileDir: profileDir,
      },
      null,
      2
    )
  );
}

/** Run the agent CLI and return its parsed AGENT_OUTPUT block plus raw logs. */
function runAgent(args, opts = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [AGENT].concat(args), {
      cwd: path.join(__dirname, "..", ".."),
      env: { ...process.env, AGENT_PROVIDER_DIR: PROVIDER_DIR, ...(opts.env || {}) },
    });
    let out = "";
    proc.stdout.on("data", (d) => {
      out += d.toString();
      // Auto-answer approval prompts so the command flow can be exercised.
      if (opts.approve !== undefined && out.includes("APPROVAL_REQUEST:") && !proc.__answered) {
        proc.__answered = true;
        proc.stdin.write(JSON.stringify({ approved: opts.approve }) + "\n");
      }
    });
    proc.stderr.on("data", (d) => (out += d.toString()));
    const timer = setTimeout(() => proc.kill(), opts.timeoutMs || 120000);
    proc.on("close", () => {
      clearTimeout(timer);
      let result = null;
      const s = out.indexOf("AGENT_OUTPUT_START");
      const e = out.indexOf("AGENT_OUTPUT_END");
      if (s !== -1 && e !== -1) {
        const lines = out
          .substring(s + 18, e)
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.startsWith("{"));
        if (lines.length) {
          try { result = JSON.parse(lines[lines.length - 1]); } catch { /* leave null */ }
        }
      }
      resolve({ result, out });
    });
  });
}

function mkWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentic-e2e-ws-"));
}

function spawnSyncNode(args, cwd) {
  const { spawnSync } = require("child_process");
  const r = spawnSync(process.execPath, args, { cwd: cwd, encoding: "utf8", timeout: 20000 });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

async function main() {
  const mock = createMockProvider();
  const baseUrl = await mock.listen();
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-e2e-profile-"));
  writeProviderConfig(baseUrl, path.join(profileRoot, "profiles", "mock"));
  console.log("mock provider at " + baseUrl);

  // Probe: if chromium can't launch here, skip the whole suite rather than
  // reporting a wall of failures unrelated to the code under test.
  const probeWs = mkWorkspace();
  mock.setReplies([F + 'json\n{"summary":"probe","steps":[{"title":"t","detail":"d","files":["a.py"]}]}\n' + F]);
  const probe = await runAgent(["plan", "probe", probeWs, "mock"], { timeoutMs: 90000 });
  if (!probe.result && /Executable doesn't exist|error while loading shared libraries/.test(probe.out)) {
    console.log("\n  skip (chromium unavailable)");
    await mock.close();
    fs.rmSync(probeWs, { recursive: true, force: true });
    fs.rmSync(profileRoot, { recursive: true, force: true });
    console.log("\nPASS — 0 passed, 0 failed (skipped)");
    return 0;
  }
  fs.rmSync(probeWs, { recursive: true, force: true });

  // ---------------------------------------------------------------- plan mode
  section("plan mode");
  {
    const ws = mkWorkspace();
    mock.setReplies([
      F +
        'json\n{"summary":"Build a todo API","steps":[' +
        '{"title":"Model","detail":"Create the model","files":["models.py"]},' +
        '{"title":"Routes","detail":"Create the routes","files":["routes.py"]}' +
        "]}\n" +
        F,
    ]);
    const { result } = await runAgent(["plan", "make me a todo api", ws, "mock"]);
    check("returns a plan", !!result && result.success === true, JSON.stringify(result));
    check("plan has both steps", !!result && result.plan && result.plan.steps.length === 2, JSON.stringify(result && result.plan));
    check("plan keeps the summary", !!result && result.plan && result.plan.summary === "Build a todo API");
    const sent = mock.prompts();
    check("prompt carries the user request", sent.length > 0 && sent[0].includes("make me a todo api"));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // -------------------------------------------------- plan mode: re-ask path
  section("plan mode — re-ask when the first reply is prose");
  {
    const ws = mkWorkspace();
    mock.setReplies([
      "Sure! I'd love to help you build that. What database would you like to use?",
      F + 'json\n{"summary":"after reask","steps":[{"title":"S","detail":"D","files":["x.py"]}]}\n' + F,
    ]);
    const { result } = await runAgent(["plan", "build a thing", ws, "mock"]);
    check("recovers a plan after re-asking", !!result && result.success === true && !!result.plan && result.plan.summary === "after reask", JSON.stringify(result));
    const sent = mock.prompts();
    check("a second prompt was actually sent", sent.length === 2, "sent " + sent.length);
    check("second prompt is the re-ask", sent.length === 2 && sent[1].includes("machine-readable"));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // --------------------------------------------------------------- build mode
  section("build mode — writes files to the workspace");
  {
    const ws = mkWorkspace();
    mock.setReplies([
      F +
        'json\n{"files":[' +
        '{"path":"app/models.py","mode":"create","content":"class Todo:\\n    def __init__(self, title):\\n        self.title = title\\n"},' +
        '{"path":"app/routes.py","mode":"create","content":"from app.models import Todo\\n\\ndef index():\\n    return []\\n"}' +
        "]}\n" +
        F,
    ]);
    const { result } = await runAgent(["browser", "build it", ws, "mock", "auto", "0", "Create the model layer", "Todo API"]);
    check("build reports success", !!result && result.success === true, JSON.stringify(result));
    check("models.py written to disk", fs.existsSync(path.join(ws, "app/models.py")));
    check("routes.py written to disk", fs.existsSync(path.join(ws, "app/routes.py")));
    check(
      "file content is real code, not escaped junk",
      fs.readFileSync(path.join(ws, "app/models.py"), "utf8").includes("def __init__(self, title):")
    );
    check("appliedFiles reported back", !!result && Array.isArray(result.appliedFiles) && result.appliedFiles.length === 2, JSON.stringify(result && result.appliedFiles));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ------------------------------------------------- build mode: cross-step context
  section("build mode — later steps see earlier files");
  {
    const ws = mkWorkspace();
    fs.mkdirSync(path.join(ws, "app"), { recursive: true });
    fs.writeFileSync(path.join(ws, "app/models.py"), "class Todo:\n    def __init__(self, title):\n        self.title = title\n");
    mock.setReplies([F + 'json\n{"files":[{"path":"app/routes.py","mode":"create","content":"from app.models import Todo\\n"}]}\n' + F]);
    const { result } = await runAgent(["browser", "step 2", ws, "mock", "auto", "1", "Add routes. Expected files: app/routes.py", "Todo API"]);
    check("step 2 succeeds", !!result && result.success === true, JSON.stringify(result));
    const sent = mock.prompts();
    check("prompt mentions the existing file", sent.length > 0 && sent[0].includes("app/models.py"), sent[0] && sent[0].slice(0, 300));
    check("prompt includes its signature", sent.length > 0 && sent[0].includes("class Todo:"));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ------------------------------------------------------ build mode: self-heal
  section("build mode — self-heals broken code");
  {
    const ws = mkWorkspace();
    mock.setReplies([
      // Invalid Python: the syntax check must catch this and trigger a follow-up.
      F + 'json\n{"files":[{"path":"broken.py","mode":"create","content":"def f(:\\n    return 1\\n"}]}\n' + F,
      F + 'json\n{"files":[{"path":"broken.py","mode":"overwrite","content":"def f():\\n    return 1\\n"}]}\n' + F,
    ]);
    const { result, out } = await runAgent(["browser", "make f", ws, "mock", "auto", "0", "Write f", "goal"], { timeoutMs: 150000 });
    check("recovers and reports success", !!result && result.success === true, JSON.stringify(result));
    check("a failure was detected first", out.includes("TEST_FAILED"), "no TEST_FAILED in log");
    check("a follow-up was sent", out.includes("FOLLOW_UP"), "no FOLLOW_UP in log");
    check("final file on disk is the fixed version", fs.readFileSync(path.join(ws, "broken.py"), "utf8").includes("def f():"));
    const sent = mock.prompts();
    check("follow-up prompt carries the error", sent.length >= 2 && /SyntaxError|failed when tested/i.test(sent[1]), sent[1] && sent[1].slice(0, 200));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // -------------------------------------------------- build mode: gives up cleanly
  section("build mode — gives up after repeated failures");
  {
    const ws = mkWorkspace();
    mock.setReplies([F + 'json\n{"files":[{"path":"bad.py","mode":"overwrite","content":"def f(:\\n"}]}\n' + F]);
    const { result } = await runAgent(["browser", "x", ws, "mock", "auto", "0", "Write f", "goal"], { timeoutMs: 180000 });
    check("reports failure rather than hanging", !!result && result.success === false, JSON.stringify(result));
    check("failure message mentions the attempts", !!result && /fix attempts/i.test(result.error || ""), result && result.error);
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ------------------------------------------------------- command approval flow
  section("build mode — command approval");
  {
    const ws = mkWorkspace();
    // Uses node rather than python so the test does not depend on a Python install.
    const reply =
      F + 'json\n{"files":[{"path":"ok.js","mode":"create","content":"console.log(1);\\n"}],"commands":["node -e \\"console.log(42)\\""]}\n' + F;

    mock.setReplies([reply]);
    const denied = await runAgent(["browser", "x", ws, "mock", "ask", "0", "Write ok", "goal"], { approve: false, timeoutMs: 150000 });
    check("asks for approval before running a command", denied.out.includes("APPROVAL_REQUEST:"), "no APPROVAL_REQUEST");
    check("respects a denial", denied.out.includes("COMMAND_DENIED"), "command was not denied");
    check("still succeeds when the command is skipped", !!denied.result && denied.result.success === true, JSON.stringify(denied.result));

    mock.setReplies([reply]);
    const approved = await runAgent(["browser", "y", ws, "mock", "ask", "0", "Write ok", "goal"], { approve: true, timeoutMs: 150000 });
    check("runs the command once approved", approved.out.includes("RUNNING_COMMAND"), "command never ran");
    check("command output is reported", approved.out.includes("42"), "no command output");
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // --------------------------------------------------------------- chat mode
  section("chat mode");
  {
    const ws = mkWorkspace();
    mock.setReplies(["You should use Flask with SQLite for a small project like this."]);
    const { result } = await runAgent(["chat", "what stack should I use?", ws, "mock"]);
    check("returns an answer", !!result && result.success === true, JSON.stringify(result));
    check("answer carries the reply text", !!result && /Flask with SQLite/.test(result.answer || ""), result && result.answer);
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ------------------------------------------------------------- headed mode
  section("headed mode (AGENT_HEADED)");
  {
    const ws = mkWorkspace();
    mock.setReplies([F + 'json\n{"summary":"h","steps":[{"title":"t","detail":"d","files":["a.py"]}]}\n' + F]);
    const headless = await runAgent(["plan", "x", ws, "mock"], { env: { AGENT_HEADED: "0" } });
    check("defaults to headless", headless.out.includes("(headless)"), "launch line: " + (headless.out.match(/Launching browser.*/) || [""])[0]);

    mock.setReplies([F + 'json\n{"summary":"h","steps":[{"title":"t","detail":"d","files":["a.py"]}]}\n' + F]);
    const headed = await runAgent(["plan", "x", ws, "mock"], { env: { AGENT_HEADED: "1" } });
    check("AGENT_HEADED=1 launches headed", headed.out.includes("HEADED"), "launch line: " + (headed.out.match(/Launching browser.*/) || [""])[0]);
    check("headed run still returns a plan", !!headed.result && headed.result.success === true, JSON.stringify(headed.result));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ------------------------------------------------------------ revise mode
  section("revise mode");
  {
    const ws = mkWorkspace();
    mock.setReplies([F + 'json\n{"summary":"revised","steps":[{"title":"A","detail":"a","files":["a.py"]},{"title":"B","detail":"b","files":["b.py"]}]}\n' + F]);
    const { result } = await runAgent(["revise", "split step 1 into two", ws, "mock"]);
    check("returns a revised plan", !!result && result.success === true && !!result.plan && result.plan.summary === "revised", JSON.stringify(result));
    check("revision request reaches the model", mock.prompts()[0].includes("split step 1 into two"));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ----------------------------------------------------------- testall mode
  section("testall mode");
  {
    const ws = mkWorkspace();
    fs.writeFileSync(path.join(ws, "good.js"), "const a = 1;\nconsole.log(a);\n");
    const okRun = await runAgent(["testall", "x", ws, "mock"]);
    check("passes on valid files", !!okRun.result && okRun.result.success === true, JSON.stringify(okRun.result));
    check("counts the checks it ran", !!okRun.result && okRun.result.passed >= 1, JSON.stringify(okRun.result));

    fs.writeFileSync(path.join(ws, "bad.js"), "function ( {\n");
    const badRun = await runAgent(["testall", "x", ws, "mock"]);
    check("fails when a file is broken", !!badRun.result && badRun.result.success === false, JSON.stringify(badRun.result));
    check("reports the failure count", !!badRun.result && badRun.result.failed >= 1, JSON.stringify(badRun.result));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ------------------------------------------- oversized args spilled to a file
  section("oversized prompt spilled to a temp file");
  {
    const ws = mkWorkspace();
    // The desktop app writes args over 8000 chars to a temp file and passes the
    // path; the agent has to read it back or the model receives a filename.
    const marker = "SPILLED_MARKER_" + Date.now();
    const bigDetail = "Build the thing. " + marker + " " + "x".repeat(9000);
    const spill = path.join(os.tmpdir(), "agent-prompt-" + Date.now() + "-6.txt");
    fs.writeFileSync(spill, bigDetail, "utf-8");

    mock.setReplies([F + 'json\n{"files":[{"path":"spilled.js","mode":"create","content":"console.log(1);\\n"}]}\n' + F]);
    const { result } = await runAgent(["browser", "short", ws, "mock", "auto", "0", spill, "goal"]);
    check("build succeeds with a spilled arg", !!result && result.success === true, JSON.stringify(result));
    const sent = mock.prompts()[0] || "";
    check("model receives the file contents, not the path", sent.includes(marker), sent.slice(0, 200));
    check("the temp path itself is not sent as the prompt", !sent.includes(path.basename(spill)));
    fs.rmSync(spill, { force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ------------------------------------ back-to-back runs on the same profile
  section("consecutive runs reuse the browser profile cleanly");
  {
    const ws = mkWorkspace();
    let allOk = true;
    let detail = "";
    for (let i = 0; i < 3; i++) {
      mock.setReplies([F + 'json\n{"files":[{"path":"step' + i + '.js","mode":"create","content":"console.log(' + i + ');\\n"}]}\n' + F]);
      const { result } = await runAgent(["browser", "s" + i, ws, "mock", "auto", String(i), "Write step " + i, "goal"]);
      if (!result || result.success !== true) { allOk = false; detail = "step " + i + ": " + JSON.stringify(result); break; }
    }
    check("three consecutive steps all succeed", allOk, detail);
    check("all three files exist", [0, 1, 2].every((i) => fs.existsSync(path.join(ws, "step" + i + ".js"))));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ------------------------------------- full plan -> multi-step build -> run
  section("full run: plan, build every step, execute the result");
  {
    const ws = mkWorkspace();

    const plan = {
      summary: "Build a small todo library",
      steps: [
        { title: "Store", detail: "Create the store", files: ["src/store.js"] },
        { title: "Todo", detail: "Create the todo service", files: ["src/todo.js"] },
        { title: "Entry", detail: "Create the entrypoint", files: ["src/index.js"] },
      ],
    };
    mock.setReplies([F + "json\n" + JSON.stringify(plan) + "\n" + F]);
    const planRun = await runAgent(["plan", "build a todo library", ws, "mock"]);
    // Guarded rather than dereferenced: plan mode has been seen, rarely, to
    // return a result with no plan at all. Without the guard that surfaces as a
    // bare TypeError with none of the evidence needed to chase it.
    check("plan comes back with 3 steps", !!planRun.result && !!planRun.result.plan && planRun.result.plan.steps.length === 3, JSON.stringify(planRun.result));

    // Each step's code depends on what the previous step exported.
    const stepReplies = [
      '{"files":[{"path":"src/store.js","mode":"create","content":"class Store {\\n  constructor() { this.items = []; }\\n  add(item) { this.items.push(item); return item; }\\n  all() { return this.items; }\\n}\\n\\nmodule.exports = { Store };\\n"}]}',
      '{"files":[{"path":"src/todo.js","mode":"create","content":"const { Store } = require(\'./store\');\\n\\nclass TodoService {\\n  constructor() { this.store = new Store(); }\\n  create(title) { return this.store.add({ title, done: false }); }\\n  list() { return this.store.all(); }\\n}\\n\\nmodule.exports = { TodoService };\\n"}]}',
      '{"files":[{"path":"src/index.js","mode":"create","content":"const { TodoService } = require(\'./todo\');\\n\\nconst svc = new TodoService();\\nsvc.create(\'write tests\');\\nsvc.create(\'ship it\');\\nconsole.log(JSON.stringify(svc.list()));\\n"}]}',
    ];

    const built = [];
    // Everything the build thread has been told, accumulated as the steps run.
    let conversation = "";
    for (let i = 0; i < plan.steps.length; i++) {
      const s = plan.steps[i];
      const stepDetail =
        "Overall: " + plan.summary + "\n\nExecute ONLY this step: " + s.title + ". " + s.detail +
        " Expected files: " + s.files.join(", ");
      mock.setReplies([F + "json\n" + stepReplies[i] + "\n" + F]);
      const { result } = await runAgent(["browser", stepDetail, ws, "mock", "auto", String(i), stepDetail, plan.summary]);
      built.push(!!result && result.success === true);
      conversation += "\n" + (mock.prompts()[0] || "");
      if (i > 0) {
        // A step must know what earlier steps produced. That knowledge used to be
        // re-pasted into every prompt; now it lives in the shared thread, so this
        // asserts against the conversation so far rather than the latest prompt.
        // Checking only that the newest prompt omits the file would pass even if
        // the model had never been told about it at all.
        const priorFile = plan.steps[i - 1].files[0];
        check("step " + (i + 1) + " can see prior file " + priorFile + " in the thread", conversation.includes(priorFile), conversation.slice(-300));
      }
    }
    check("all 3 build steps succeed", built.every(Boolean), JSON.stringify(built));

    // The real proof: the generated project runs and behaves.
    const run = spawnSyncNode(["src/index.js"], ws);
    check("generated project executes", run.status === 0, run.stderr);
    let parsed = null;
    try { parsed = JSON.parse((run.stdout || "").trim()); } catch { /* leave null */ }
    check("cross-step imports resolved at runtime", Array.isArray(parsed) && parsed.length === 2, run.stdout + run.stderr);
    check("output is the expected data", !!parsed && parsed[0].title === "write tests" && parsed[1].done === false, JSON.stringify(parsed));

    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ------------------------------------------- timeout comes from the config
  section("response timeout honours provider config");
  {
    const ws = mkWorkspace();
    // Rewrite the config with a short ceiling and make the provider never answer,
    // so the run has to hit that ceiling rather than a hardcoded 120s.
    const cfgPath = path.join(PROVIDER_DIR, "mock.json");
    const original = fs.readFileSync(cfgPath, "utf8");
    const cfg = JSON.parse(original);
    cfg.completionRules.maxWaitMs = 15000;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    mock.setReplies(["never delivered"]);
    mock.setReplyDelay(60000); // longer than the configured ceiling
    const started = Date.now();
    const { out } = await runAgent(["plan", "x", ws, "mock"], { timeoutMs: 90000 });
    const elapsed = Date.now() - started;
    mock.setReplyDelay(0);

    check("log announces the configured timeout", out.includes("(15s timeout)"), (out.match(/Waiting for AI response.*/) || [""])[0]);
    check("gives up near the configured ceiling, not 120s", elapsed < 70000, "took " + Math.round(elapsed / 1000) + "s");
    check("reports the configured value on timeout", out.includes("Timeout after 15s"), (out.match(/Timeout after.*/) || [""])[0]);

    fs.writeFileSync(cfgPath, original);
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // --------------------------------- short follow-up reply, re-rendered in place
  section("detects a follow-up reply that is shorter than the one before it");
  {
    const ws = mkWorkspace();
    // Reproduces a real hang: the chat UI re-renders the last bubble instead of
    // adding one (so the message count never grows) and the fix reply is shorter
    // than the answer it replaces. Detection used to need "50 chars longer", so
    // the agent sat in "AI is thinking" until it timed out, then extracted the
    // reply that had been sitting there the whole time.
    mock.setRenderMode("replace");
    const longBroken =
      "Here is a thorough implementation with extensive commentary. ".repeat(12) +
      "\n" + F + 'json\n{"files":[{"path":"m.js","mode":"create","content":"function f( {\\n"}]}\n' + F;
    const shortFix = F + 'json\n{"files":[{"path":"m.js","mode":"overwrite","content":"function f() {}\\n"}]}\n' + F;
    mock.setReplies([longBroken, shortFix]);

    const started = Date.now();
    const { result, out } = await runAgent(["browser", "x", ws, "mock", "auto", "0", "Write f", "goal"], { timeoutMs: 180000 });
    const elapsed = Date.now() - started;
    mock.setRenderMode("append");

    check("build recovers", !!result && result.success === true, JSON.stringify(result));
    check("both replies were detected as they arrived", (out.match(/Response started!/g) || []).length === 2, "started count: " + (out.match(/Response started!/g) || []).length);
    check("never fell back to the timeout path", !out.includes("Timeout after"), (out.match(/Timeout after.*/) || [""])[0]);
    check("did not sit in 'AI is thinking'", !out.includes("AI is thinking"), "thinking lines: " + (out.match(/AI is thinking/g) || []).length);
    check("finished promptly", elapsed < 90000, "took " + Math.round(elapsed / 1000) + "s");
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ------------------------------------- model-suggested `python` gets rewritten
  section("rewrites a suggested `python` command to the interpreter that exists");
  {
    const ws = mkWorkspace();
    mock.setReplies([
      F + 'json\n{"files":[{"path":"hello.py","mode":"create","content":"print(\'hi\')\\n"}],"commands":["python hello.py"]}\n' + F,
    ]);
    const { result, out } = await runAgent(["browser", "x", ws, "mock", "auto", "0", "Write hello", "goal"], { timeoutMs: 150000 });

    const hasRealPython = require("child_process").spawnSync("python --version", { shell: true, stdio: "ignore" }).status === 0;
    if (hasRealPython) {
      check("skipped: this machine has a real `python`", true);
    } else {
      check("command was normalized", out.includes("NORMALIZED_COMMAND"), (out.match(/REQUESTING_COMMAND.*/) || [""])[0]);
      check("no 'python: not found' failure", !out.includes("python: not found"), (out.match(/.*not found.*/) || [""])[0]);
      check("step succeeds first time, no retry burned", !!result && result.success === true && !out.includes("FOLLOW_UP"), JSON.stringify(result));
    }
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ------------------------- root-level step gets the modules it must import from
  section("a step writing a root-level file still sees the package it imports");
  {
    const ws = mkWorkspace();
    // Mirrors the real run: earlier steps built models/storage/services, the most
    // recent step built the cli package, and now main.py has to import from it.
    const write = (rel, body) => {
      const p = path.join(ws, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
      return p;
    };
    write("src/models/task.py", "class Task:\n    def __init__(self, title):\n        self.title = title\n");
    write("src/storage/json_storage.py", "import json\n\nclass JsonStorage:\n    def load(self):\n        pass\n");
    write("src/services/task_service.py", "class TaskService:\n    def add(self, t):\n        pass\n");
    const handlers = write("src/cli/handlers.py", "def handle_add(a):\n    pass\ndef handle_remove(a):\n    pass\n");
    // Make the cli package unambiguously the newest work.
    const now = Date.now();
    fs.utimesSync(handlers, new Date(now), new Date(now));

    mock.setReplies([F + 'json\n{"files":[{"path":"main.py","mode":"create","content":"print(1)\\n"}]}\n' + F]);
    const stepDetail = "Overall: Build a to-do CLI\n\nExecute ONLY this step: Implement Main Entry Point. Expected files: main.py";
    const { result } = await runAgent(["browser", stepDetail, ws, "mock", "auto", "4", stepDetail, "Build a to-do CLI"]);

    check("step succeeds", !!result && result.success === true, JSON.stringify(result));
    const sent = mock.prompts()[0] || "";
    check("prompt includes the handlers module", sent.includes("src/cli/handlers.py"), sent.slice(0, 400));
    check("prompt exposes the real handler names", sent.includes("handle_remove"), "handler names missing from prompt");
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // -------------------------------------------------- mock models real threads
  section("mock provider models threads");
  {
    mock.resetThreads();
    check("starts with no threads", mock.threadCount() === 0, "threads: " + mock.threadCount());
    check("promptsForThread is empty for an unknown id", mock.promptsForThread("nope").length === 0);
  }

  // ------------------------------------- every step of a build shares a thread
  section("build steps share one chat thread");
  {
    const ws = mkWorkspace();
    mock.resetThreads();

    for (let i = 0; i < 3; i++) {
      mock.setReplies([F + 'json\n{"files":[{"path":"s' + i + '.js","mode":"create","content":"console.log(' + i + ');\\n"}]}\n' + F]);
      const detail = "Execute ONLY this step: step " + i + ". Expected files: s" + i + ".js";
      const { result } = await runAgent(["browser", detail, ws, "mock", "auto", String(i), detail, "goal"]);
      check("step " + i + " succeeds", !!result && result.success === true, JSON.stringify(result));
    }

    check("all three steps used ONE thread", mock.threadCount() === 1, "threads: " + mock.threadCount());
    check("that thread saw three prompts", mock.promptsForThread("1").length === 3, "prompts: " + mock.promptsForThread("1").length);

    // A new build (step 0 again) must NOT reuse the previous run's thread.
    mock.setReplies([F + 'json\n{"files":[{"path":"fresh.js","mode":"create","content":"console.log(9);\\n"}]}\n' + F]);
    const d0 = "Execute ONLY this step: step 0. Expected files: fresh.js";
    await runAgent(["browser", d0, ws, "mock", "auto", "0", d0, "goal"]);
    check("a new build starts a new thread", mock.threadCount() === 2, "threads: " + mock.threadCount());

    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ------------------------------- a later step can see an earlier step's reply
  section("a resumed thread carries earlier messages");
  {
    const ws = mkWorkspace();
    mock.resetThreads();
    const MARKER = "ZEBRAFISH_TOKEN";

    mock.setReplies([
      "I will remember " + MARKER + ".\n" + F + 'json\n{"files":[{"path":"a.js","mode":"create","content":"console.log(1);\\n"}]}\n' + F,
    ]);
    const d0 = "Execute ONLY this step: step 0. Expected files: a.js";
    await runAgent(["browser", d0, ws, "mock", "auto", "0", d0, "goal"]);

    mock.setReplies([F + 'json\n{"files":[{"path":"b.js","mode":"create","content":"console.log(2);\\n"}]}\n' + F]);
    const d1 = "Execute ONLY this step: step 1. Expected files: b.js";
    const { result, out } = await runAgent(["browser", d1, ws, "mock", "auto", "1", d1, "goal"]);

    check("step 1 succeeds", !!result && result.success === true, JSON.stringify(result));
    check("step 1 resumed rather than starting fresh", out.includes("Resuming build thread:"), (out.match(/Starting fresh chat.*/) || [""])[0]);
    check("step 1 landed in the same thread", mock.threadCount() === 1, "threads: " + mock.threadCount());
    check("the thread holds both prompts", mock.promptsForThread("1").length === 2, "thread prompts: " + mock.promptsForThread("1").length);

    fs.rmSync(ws, { recursive: true, force: true });
  }

  // --------------------------------- later steps are not re-told what they know
  section("later steps receive only the delta");
  {
    const ws = mkWorkspace();
    mock.resetThreads();

    // Step 0: two files created. Its prompt is the full-context baseline.
    mock.setReplies([F + 'json\n{"files":[' +
      '{"path":"src/alpha.js","mode":"create","content":"function alpha() {}\\nmodule.exports = { alpha };\\n"},' +
      '{"path":"src/beta.js","mode":"create","content":"function beta() {}\\nmodule.exports = { beta };\\n"}' +
      ']}\n' + F]);
    const d0 = "Execute ONLY this step: step 0. Expected files: src/alpha.js, src/beta.js";
    await runAgent(["browser", d0, ws, "mock", "auto", "0", d0, "goal"]);
    const step0Prompt = mock.prompts()[0] || "";

    // Step 1: nothing on disk changed, so the thread already has both files.
    mock.setReplies([F + 'json\n{"files":[{"path":"src/gamma.js","mode":"create","content":"const { alpha } = require(\'./alpha\');\\n"}]}\n' + F]);
    const d1 = "Execute ONLY this step: step 1. Expected files: src/gamma.js";
    const { result } = await runAgent(["browser", d1, ws, "mock", "auto", "1", d1, "goal"]);
    const step1Prompt = mock.prompts()[0] || "";

    check("step 1 succeeds", !!result && result.success === true, JSON.stringify(result));
    check("step 1 does not resend alpha's signatures", !step1Prompt.includes("module.exports = { alpha }"), step1Prompt.slice(0, 400));
    // Asserted semantically rather than by length: when nothing has changed the
    // two prompts differ by only a few dozen characters, so a size comparison
    // would be decided by the step's wording rather than by the delta.
    check("step 1 carries no file signatures at all", !/^--- /m.test(step1Prompt), (step1Prompt.match(/^--- .*/gm) || []).join(" "));
    check("step 1 does not repeat the project structure", !step1Prompt.includes("Project Structure:"), step1Prompt.slice(0, 300));

    // Step 2: a file the thread was shown has been rewritten on disk behind its
    // back. That must be re-sent or the model works from a stale belief.
    fs.writeFileSync(path.join(ws, "src/alpha.js"), "function alpha(x) { return x; }\nmodule.exports = { alpha, RENAMED };\n");
    mock.setReplies([F + 'json\n{"files":[{"path":"src/delta.js","mode":"create","content":"console.log(1);\\n"}]}\n' + F]);
    const d2 = "Execute ONLY this step: step 2. Expected files: src/delta.js";
    await runAgent(["browser", d2, ws, "mock", "auto", "2", d2, "goal"]);
    const step2Prompt = mock.prompts()[0] || "";
    check("a file changed on disk is re-sent", step2Prompt.includes("RENAMED"), step2Prompt.slice(0, 400));

    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ------------------------------------ the delta actually shrinks the prompt
  section("prompt size stays bounded as a build grows");
  {
    const ws = mkWorkspace();
    mock.resetThreads();
    const sizes = [];

    for (let i = 0; i < 4; i++) {
      mock.setReplies([F + 'json\n{"files":[{"path":"src/mod' + i + '.js","mode":"create","content":"function m' + i + '() { return ' + i + '; }\\nmodule.exports = { m' + i + ' };\\n"}]}\n' + F]);
      const detail = "Execute ONLY this step: step " + i + ". Expected files: src/mod" + i + ".js";
      const { result } = await runAgent(["browser", detail, ws, "mock", "auto", String(i), detail, "goal"]);
      check("step " + i + " succeeds", !!result && result.success === true, JSON.stringify(result));
      sizes.push((mock.prompts()[0] || "").length);
    }

    check("prompts recorded for all four steps", sizes.length === 4 && sizes.every((s) => s > 0), sizes.join(","));
    // Without the delta each prompt grows as the project does, because every step
    // re-listed the whole workspace. With it, a step is told only about what its
    // predecessor just wrote, so the last step is no heavier than the second.
    check("step 4 is no larger than step 2", sizes[3] <= sizes[1], "sizes: " + sizes.join(","));
    check("prompts stay bounded as the project grows", Math.max(...sizes) - Math.min(...sizes) < 2500, "sizes: " + sizes.join(","));

    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ----------------------------- one browser for a whole build, not one per step
  section("build session opens the browser once");
  {
    const ws = mkWorkspace();
    mock.resetThreads();

    const proc = spawn(process.execPath, [AGENT, "build-session", ws, "mock", "auto"], {
      cwd: path.join(__dirname, "..", ".."),
      env: { ...process.env, AGENT_PROVIDER_DIR: PROVIDER_DIR },
    });
    let out = "";
    const events = [];
    const absorb = (d) => {
      out += d.toString();
      for (const line of d.toString().split(/\r?\n/)) {
        const m = line.match(/^SESSION_EVENT: (.*)$/);
        if (m) { try { events.push(JSON.parse(m[1])); } catch { /* ignore */ } }
      }
    };
    proc.stdout.on("data", absorb);
    proc.stderr.on("data", (d) => (out += d.toString()));

    const waitFor = (pred, ms) => new Promise((res) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (pred() || Date.now() - t0 > ms) { clearInterval(iv); res(!!pred()); }
      }, 200);
    });

    check("session reports ready", await waitFor(() => events.some((e) => e.type === "ready"), 90000), out.slice(-300));

    for (let i = 0; i < 3; i++) {
      mock.setReplies([F + 'json\n{"files":[{"path":"src/s' + i + '.js","mode":"create","content":"module.exports = { i: ' + i + ' };\\n"}]}\n' + F]);
      const detail = "Execute ONLY this step: step " + i + ". Expected files: src/s" + i + ".js";
      proc.stdin.write(JSON.stringify({ type: "step", index: i, detail: detail, goal: "goal", prompt: detail }) + "\n");
      check("step " + i + " returns a result", await waitFor(() => events.some((e) => e.type === "step-result" && e.index === i), 120000), out.slice(-400));
    }

    proc.stdin.write(JSON.stringify({ type: "close" }) + "\n");
    await waitFor(() => proc.exitCode !== null, 30000);

    const launches = (out.match(/Launching browser/g) || []).length;
    check("browser launched exactly once for three steps", launches === 1, "launches: " + launches);
    check("all three steps succeeded", events.filter((e) => e.type === "step-result" && e.success).length === 3, JSON.stringify(events.filter((e) => e.type === "step-result")));
    check("all three files exist", [0, 1, 2].every((i) => fs.existsSync(path.join(ws, "src/s" + i + ".js"))));

    try { proc.kill(); } catch { /* already gone */ }
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ------------------------------- an overwrite reports where the old copy went
  section("step results carry the backup directory");
  {
    const ws = mkWorkspace();
    mock.resetThreads();

    mock.setReplies([F + 'json\n{"files":[{"path":"m.js","mode":"create","content":"const v = 1;\\n"}]}\n' + F]);
    const d0 = "Execute ONLY this step: step 0. Expected files: m.js";
    const first = await runAgent(["browser", d0, ws, "mock", "auto", "0", d0, "goal"]);
    check("create step succeeds", !!first.result && first.result.success === true, JSON.stringify(first.result));
    check("a create reports no backup dir", !!first.result && !first.result.backupDir, JSON.stringify(first.result));

    mock.setReplies([F + 'json\n{"files":[{"path":"m.js","mode":"overwrite","content":"const v = 2;\\n"}]}\n' + F]);
    const d1 = "Execute ONLY this step: step 1. Expected files: m.js";
    const second = await runAgent(["browser", d1, ws, "mock", "auto", "1", d1, "goal"]);
    check("overwrite step succeeds", !!second.result && second.result.success === true, JSON.stringify(second.result));
    check("an overwrite reports a backup dir", !!second.result && !!second.result.backupDir, JSON.stringify(second.result));
    check("the backup holds the previous content",
      !!second.result && !!second.result.backupDir && fs.readFileSync(path.join(second.result.backupDir, "m.js"), "utf8").includes("const v = 1"),
      second.result && second.result.backupDir);

    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ------------------------------------ revising a step through its build thread
  section("suggest revises a step in the build thread");
  {
    const ws = mkWorkspace();
    mock.resetThreads();

    mock.setReplies([F + 'json\n{"files":[{"path":"src/store.js","mode":"create","content":"function add(x) { items.push(x); }\\n"}]}\n' + F]);
    const d0 = "Execute ONLY this step: step 0. Expected files: src/store.js";
    await runAgent(["browser", d0, ws, "mock", "auto", "0", d0, "goal"]);
    check("the build created one thread", mock.threadCount() === 1, "threads: " + mock.threadCount());

    mock.setReplies([F + 'json\n{"files":[{"path":"src/store.js","mode":"overwrite","content":"function add(x) { items.push(x); return x; }\\n"}]}\n' + F]);
    const sug = await runAgent(["suggest", ws, "mock", "0", "make add() return the item"]);

    check("suggest succeeds", !!sug.result && sug.result.success === true, JSON.stringify(sug.result));
    check("suggest reuses the build thread", mock.threadCount() === 1, "threads: " + mock.threadCount());
    check("suggest resumed rather than starting fresh", sug.out.includes("Resuming build thread:"), (sug.out.match(/Starting fresh chat.*/) || [""])[0]);
    check("the suggestion text reached the model", (mock.prompts()[0] || "").includes("make add() return the item"), (mock.prompts()[0] || "").slice(0, 200));
    check("the change was applied", fs.readFileSync(path.join(ws, "src/store.js"), "utf8").includes("return x"), fs.readFileSync(path.join(ws, "src/store.js"), "utf8"));
    check("an overwrite reports a backup", !!sug.result && !!sug.result.backupDir, JSON.stringify(sug.result));

    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ----------------------------------- refusing rather than guessing blind
  section("suggest refuses without a build thread");
  {
    const ws = mkWorkspace();
    mock.resetThreads();
    mock.setReplies([F + 'json\n{"files":[{"path":"x.js","mode":"create","content":"1;\\n"}]}\n' + F]);
    const sug = await runAgent(["suggest", ws, "mock", "0", "change something"]);
    check("suggest fails when there is no build thread", !!sug.result && sug.result.success === false, JSON.stringify(sug.result));
    check("the reason names the missing thread", !!sug.result && /build/i.test(sug.result.error || ""), sug.result && sug.result.error);
    check("no thread was created", mock.threadCount() === 0, "threads: " + mock.threadCount());
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ------------------------------------- testall reports each check, not a count
  section("testall reports per-check results");
  {
    const ws = mkWorkspace();
    fs.writeFileSync(path.join(ws, "good.js"), "const a = 1;\nconsole.log(a);\n");
    fs.writeFileSync(path.join(ws, "bad.js"), "function ( {\n");
    const run = await runAgent(["testall", "x", ws, "mock"]);

    check("testall still reports counts", !!run.result && run.result.passed >= 1 && run.result.failed >= 1, JSON.stringify(run.result));
    check("testall reports a results array", !!run.result && Array.isArray(run.result.results), JSON.stringify(run.result));
    check("results has one entry per check", !!run.result && run.result.results.length === run.result.passed + run.result.failed, JSON.stringify(run.result && run.result.results));
    check("each result names its command", !!run.result && run.result.results.every((r) => typeof r.command === "string" && r.command.length > 0), JSON.stringify(run.result && run.result.results));
    check("the broken file is marked failed", !!run.result && run.result.results.some((r) => r.success === false && r.command.includes("bad.js")), JSON.stringify(run.result && run.result.results));
    check("the good file is marked passed", !!run.result && run.result.results.some((r) => r.success === true && r.command.includes("good.js")), JSON.stringify(run.result && run.result.results));

    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ------------------------- an unparseable plan must say what it actually got
  section("plan mode reports the reply it could not parse");
  {
    const ws = mkWorkspace();
    // A build reply where a plan was expected: what a cross-suite provider-config
    // collision produced, and the failure that was mistaken for a race.
    mock.setReplies([F + 'json\n{"files":[{"path":"a.js","mode":"create","content":"1;\\n"}]}\n' + F]);
    const r = await runAgent(["plan", "build a todo library", ws, "mock"]);

    check("plan mode fails rather than inventing a plan", !!r.result && r.result.success === false, JSON.stringify(r.result));
    check("no plan field is fabricated", !!r.result && !r.result.plan, JSON.stringify(r.result));
    check("the reply it could not parse is reported", !!r.result && typeof r.result.raw === "string" && r.result.raw.indexOf("files") !== -1, JSON.stringify(r.result && r.result.raw));
    check("it re-asked before giving up", r.out.includes("Plan parse failed"), (r.out.match(/Plan parse.*/) || [""])[0]);

    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ------------------------- the stop button ends a wait sooner than stability
  section("stop button completes a reply without the stability wait");
  {
    const ws = mkWorkspace();
    const cfgPath = path.join(PROVIDER_DIR, "mock.json");
    const original = fs.readFileSync(cfgPath, "utf8");

    // sendPrompt sleeps 2s after clicking to capture the thread URL, then
    // waitForResponse waits 3s before its first poll. A reply faster than that
    // combined blind window lets the stop button appear and vanish unobserved,
    // so the delay has to comfortably outlast it.
    mock.setReplyDelay(12000);

    const withStop = JSON.parse(original);
    withStop.selectors.stopButton = "#stop";
    withStop.completionRules.waitForStopButtonDisappear = true;
    fs.writeFileSync(cfgPath, JSON.stringify(withStop, null, 2));

    mock.setReplies([F + 'json\n{"summary":"s","steps":[{"title":"t","detail":"d","files":["a.py"]}]}\n' + F]);
    const t0 = Date.now();
    const fast = await runAgent(["plan", "x", ws, "mock"], { timeoutMs: 120000 });
    const fastMs = Date.now() - t0;

    check("plan succeeds with the stop button", !!fast.result && fast.result.success === true, JSON.stringify(fast.result));
    check("the stop-button path was used", fast.out.includes("stop button"), (fast.out.match(/Response complete.*/) || [""])[0]);

    // Same provider, stop button disabled: must still complete, via stability.
    const noStop = JSON.parse(original);
    noStop.selectors.stopButton = "#nonexistent-stop";
    noStop.completionRules.waitForStopButtonDisappear = false;
    fs.writeFileSync(cfgPath, JSON.stringify(noStop, null, 2));

    mock.setReplies([F + 'json\n{"summary":"s","steps":[{"title":"t","detail":"d","files":["a.py"]}]}\n' + F]);
    const t1 = Date.now();
    const slow = await runAgent(["plan", "x", ws, "mock"], { timeoutMs: 120000 });
    const slowMs = Date.now() - t1;

    check("plan still succeeds without a stop button", !!slow.result && slow.result.success === true, JSON.stringify(slow.result));
    check("stability path still reports completion", slow.out.includes("stable for"), (slow.out.match(/Response complete.*/) || [""])[0]);
    check("the stop button finished sooner", fastMs < slowMs, "withStop=" + fastMs + "ms withoutStop=" + slowMs + "ms");

    mock.setReplyDelay(0);
    fs.writeFileSync(cfgPath, original);
    fs.rmSync(ws, { recursive: true, force: true });
  }

  await mock.close();
  fs.rmSync(profileRoot, { recursive: true, force: true });
  fs.rmSync(PROVIDER_DIR, { recursive: true, force: true });

  console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + " — " + pass + " passed, " + fail + " failed");
  if (failures.length) console.log("failed: " + failures.join(", "));
  return fail === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("e2e runner threw:", e);
    process.exit(1);
  });
