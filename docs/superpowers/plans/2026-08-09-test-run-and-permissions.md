# Test/Run Section and Permission Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Test tab its own results and a Run Project button, and replace the hardcoded `"ask"` with a real permission policy.

**Architecture:** Two decisions that were buried in branching become pure, unit-tested functions: `decideApproval(autonomy)` in the agent, and `detectEntrypoint(paths, packageJson)` in `desktop/entrypoint.js` (dual-loaded like `desktop/diff.js`, since the desktop has no bundler). `testAllMode` gains a `results` array so the renderer can render per-check rows instead of scraping log lines. A sidebar select persisted in `localStorage` feeds `builder.js`'s two call sites.

**Tech Stack:** TypeScript (ES2020, CommonJS via `tsc`) for the agent, plain browser JS for the renderer (`<script>` tags, no bundler), Electron IPC, plain-CJS test harness.

## Global Constraints

- Agent source is TypeScript under `local-agent/src/`, compiled by `npx tsc -p local-agent/tsconfig.json` to `local-agent/dist/`. **Every test run must be preceded by a build.**
- Desktop files load as plain `<script>` tags in `desktop/index.html` — **no bundler, no ES modules, no npm imports in renderer code.**
- Tests use `section(name)` and `check(name, condition, extra)`. No test framework.
- Suite must stay green: currently **92 unit + 110 end-to-end**.
- Never run two e2e suites at once. Check with `ps -eo args= | grep run-e2e.cjs`, not `pgrep -f`.
- On WSL, `source scripts/wsl-env.sh` first.
- **`testAllMode` must keep emitting `passed` and `failed`** — existing e2e assertions depend on them. `results` is additive.
- **A command denied by policy must log `COMMAND_DENIED`**, exactly as a user denial does, so the self-heal path cannot mistake "did not run" for "failed".

---

### Task 1: The approval decision

**Files:**
- Modify: `local-agent/src/index.ts` — new `decideApproval`, `askApproval` uses it
- Test: `local-agent/test/run-tests.cjs` (new `testApprovalPolicy()`)

**Interfaces:**
- Produces: `decideApproval(autonomy: string): "allow" | "deny" | "ask"` — exported so the harness can reach it.

- [ ] **Step 1: Write the failing test**

Add to `local-agent/test/run-tests.cjs` above `function testRelevance() {`:

```javascript
function testApprovalPolicy() {
  section("approval policy");
  const { decideApproval } = require(path.join(DIST, "index.js"));

  check("auto allows without asking", decideApproval("auto") === "allow");
  check("never denies without asking", decideApproval("never") === "deny");
  check("ask prompts", decideApproval("ask") === "ask");
  // An unset or unrecognised policy must be the safe one: prompt rather than
  // silently running commands the user never approved.
  check("unknown value prompts", decideApproval("banana") === "ask");
  check("empty value prompts", decideApproval("") === "ask");
  check("undefined prompts", decideApproval(undefined) === "ask");
}
```

Register it beside the others:

```javascript
  testDiff();
  testApprovalPolicy();
  testRelevance();
```

- [ ] **Step 2: Run to verify it fails**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm test
```

Expected: FAIL — `decideApproval is not a function`.

- [ ] **Step 3: Implement**

In `local-agent/src/index.ts`, replace `askApproval` with:

```typescript
/**
 * Pure policy decision, separated from the stdin read so it can be tested.
 * Anything unrecognised prompts: silently running unapproved commands is the
 * one outcome that must never happen by accident.
 */
export function decideApproval(autonomy: string | undefined): "allow" | "deny" | "ask" {
  if (autonomy === "auto") return "allow";
  if (autonomy === "never") return "deny";
  return "ask";
}

async function askApproval(command: string, cwd: string, autonomy: string): Promise<boolean> {
  const decision = decideApproval(autonomy);
  if (decision === "allow") return true;
  if (decision === "deny") return false;
  console.log("APPROVAL_REQUEST:" + JSON.stringify({ command: command, cwd: cwd }));
  const line = await readLine();
  try { return !!JSON.parse(line).approved; } catch { return false; }
}
```

The existing call site already logs `COMMAND_DENIED` when `askApproval` returns false, so a policy denial and a user denial follow the same path with no further change.

- [ ] **Step 4: Run to verify it passes**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:all
```

Expected: PASS — unit rises from 92 to 98; e2e stays at 110.

- [ ] **Step 5: Commit**

```bash
git add local-agent/src/index.ts local-agent/test/run-tests.cjs
git commit -m "Make the approval policy a pure, testable decision"
```

---

### Task 2: Per-check results from testall

**Files:**
- Modify: `local-agent/src/index.ts` — `testAllMode`
- Test: `local-agent/test/run-e2e.cjs`

**Interfaces:**
- Produces: `testall` emits `{ success, passed, failed, results: { command: string; success: boolean }[] }`.

- [ ] **Step 1: Write the failing test**

Add to `run-e2e.cjs` before the final `await mock.close();`:

```javascript
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
```

- [ ] **Step 2: Run to verify it fails**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:e2e
```

Expected: FAIL — `testall reports a results array`.

- [ ] **Step 3: Implement**

Replace the body of `testAllMode`:

```typescript
async function testAllMode(workspace: string) {
  const files: string[] = [];
  walk(workspace, files);
  let pass = 0;
  let fail = 0;
  const results: { command: string; success: boolean }[] = [];
  for (const f of files) {
    for (const cmd of detectSyntaxChecks(path.relative(workspace, f))) {
      const r = await runCommand(cmd, workspace);
      console.log((r.success ? "PASS " : "FAIL ") + cmd);
      results.push({ command: cmd, success: r.success });
      if (r.success) pass++; else { fail++; if (r.output) projLog(r.output.slice(0, 800)); }
    }
  }
  emit({ success: fail === 0, passed: pass, failed: fail, results: results });
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:all
```

Expected: PASS — unit 98, e2e rises from 110 to 116.

- [ ] **Step 5: Commit**

```bash
git add local-agent/src/index.ts local-agent/test/run-e2e.cjs
git commit -m "Report per-check results from testall"
```

---

### Task 3: Entry point detection

**Files:**
- Create: `desktop/entrypoint.js`
- Modify: `desktop/index.html` (load it beside `diff.js`)
- Test: `local-agent/test/run-tests.cjs` (new `testEntrypoint()`)

**Interfaces:**
- Produces: `detectEntrypoint(paths: string[], packageJson: object | null): string | null`, exposed as `window.CNEntry` and `module.exports`.

- [ ] **Step 1: Write the failing test**

Add to `run-tests.cjs` above `function testRelevance() {`:

```javascript
function testEntrypoint() {
  section("entry point detection");
  const { detectEntrypoint } = require(path.join(__dirname, "..", "..", "desktop", "entrypoint.js"));

  check("npm start wins when scripts.start exists",
    detectEntrypoint(["package.json", "index.js"], { scripts: { start: "node ." } }) === "npm start");
  check("package main is used when there is no start script",
    detectEntrypoint(["package.json", "app.js"], { main: "app.js" }) === "node app.js");
  check("a package.json with neither falls through to files",
    detectEntrypoint(["package.json", "index.js"], {}) === "node index.js");

  check("main.py at the root", detectEntrypoint(["main.py"], null) === "python3 main.py");
  check("src/main.py", detectEntrypoint(["src/main.py"], null) === "python3 src/main.py");
  check("app.py", detectEntrypoint(["app.py"], null) === "python3 app.py");
  check("index.js", detectEntrypoint(["index.js"], null) === "node index.js");
  check("src/index.js", detectEntrypoint(["src/index.js"], null) === "node src/index.js");

  check("root main.py beats src/main.py", detectEntrypoint(["src/main.py", "main.py"], null) === "python3 main.py");
  check("python beats javascript when both exist", detectEntrypoint(["index.js", "main.py"], null) === "python3 main.py");

  // Returning null is a real answer: better than running something arbitrary.
  check("nothing recognisable yields null", detectEntrypoint(["README.md", "notes.txt"], null) === null);
  check("an empty workspace yields null", detectEntrypoint([], null) === null);
}
```

Register it:

```javascript
  testApprovalPolicy();
  testEntrypoint();
  testRelevance();
```

- [ ] **Step 2: Run to verify it fails**

```bash
source scripts/wsl-env.sh && cd local-agent && npm test
```

Expected: FAIL — `Cannot find module '.../desktop/entrypoint.js'`.

- [ ] **Step 3: Implement**

Create `desktop/entrypoint.js`:

```javascript
/*
 * Works out how to run a generated project.
 *
 * Loaded as a plain <script> in the renderer (window.CNEntry) and require()d by
 * the test harness (module.exports). No bundler, so no import/export.
 */
(function (root) {
  // python3 rather than python: "python" alone does not exist on most Linux and
  // macOS installs, which already cost one whole build.
  var PY = "python3";

  var FILE_RULES = [
    { file: "main.py", command: PY + " main.py" },
    { file: "src/main.py", command: PY + " src/main.py" },
    { file: "app.py", command: PY + " app.py" },
    { file: "index.js", command: "node index.js" },
    { file: "src/index.js", command: "node src/index.js" },
  ];

  function detectEntrypoint(paths, packageJson) {
    var set = {};
    (paths || []).forEach(function (p) { set[String(p).replace(/\\/g, "/")] = true; });

    if (packageJson) {
      if (packageJson.scripts && packageJson.scripts.start) return "npm start";
      if (packageJson.main) return "node " + packageJson.main;
    }
    for (var i = 0; i < FILE_RULES.length; i++) {
      if (set[FILE_RULES[i].file]) return FILE_RULES[i].command;
    }
    return null;
  }

  var api = { detectEntrypoint: detectEntrypoint };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNEntry = api;
})(typeof window !== "undefined" ? window : globalThis);
```

In `desktop/index.html`, beside the existing diff script:

```html
<script src="diff.js"></script>
<script src="entrypoint.js"></script>
```

- [ ] **Step 4: Run to verify it passes**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:all
```

Expected: PASS — unit rises from 98 to 111; e2e stays at 116.

- [ ] **Step 5: Commit**

```bash
git add desktop/entrypoint.js desktop/index.html local-agent/test/run-tests.cjs
git commit -m "Add entry point detection for Run Project"
```

---

### Task 4: The UI

**Files:**
- Modify: `desktop/index.html` — autonomy select, Run Project button, results area
- Modify: `desktop/styles.css` — results styling
- Modify: `desktop/renderer.js` — `CN.getAutonomy`, results rendering, Run Project
- Modify: `desktop/builder.js` — use the policy at both call sites
- Modify: `desktop/main.js` — a `list-files` handler for entry point detection

**Interfaces:**
- Consumes: `detectEntrypoint` (Task 3), `results` from `testall` (Task 2).
- Produces: `CN.getAutonomy(): string`, `window.api.listFiles(workspace): Promise<{ok, files}>`.

- [ ] **Step 1: main.js — list the workspace**

The renderer needs the file list to detect an entry point. Add beside `read-file`:

```javascript
ipcMain.handle("list-files", function (event, workspace) {
  const out = [];
  const skip = ["node_modules", ".git", ".agent-backups", "__pycache__", "dist", "build", "venv", ".venv", "target"];
  function walk(dir, prefix) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (skip.indexOf(e.name) !== -1 || e.name.startsWith(".")) continue;
      const rel = prefix ? prefix + "/" + e.name : e.name;
      if (e.isDirectory()) { if (rel.split("/").length < 4) walk(path.join(dir, e.name), rel); }
      else out.push(rel);
    }
  }
  try { walk(workspace, ""); return { ok: true, files: out }; }
  catch (e) { return { ok: false, error: e.message, files: [] }; }
});
```

In `desktop/preload.js`:

```javascript
  listFiles: function (workspace) { return ipcRenderer.invoke("list-files", workspace); },
```

- [ ] **Step 2: index.html — the controls**

In the sidebar, after the provider block:

```html
    <div class="micro">Permissions</div>
    <select id="autonomy-select">
      <option value="ask">Ask each command</option>
      <option value="auto">Auto-allow</option>
      <option value="never">Never run commands</option>
    </select>
```

Replace the Test panel body with:

```html
      <div class="micro">Test</div>
      <div class="row">
        <button id="test-check" class="btn">Syntax-check all files</button>
        <button id="test-run-project" class="btn invert">Run Project</button>
      </div>
      <div class="row">
        <input id="test-cmd" placeholder="custom command, e.g. python3 src/main.py">
        <button id="test-run" class="btn">Run</button>
      </div>
      <div id="test-summary" class="micro"></div>
      <div id="test-results"></div>
```

- [ ] **Step 3: styles.css — results**

Append:

```css
#autonomy-select{width:100%;background:#050506;border:1px solid var(--line);color:var(--txt);padding:7px 8px;border-radius:3px;font-family:inherit;font-size:12px;margin-bottom:14px;}
#test-summary{margin:12px 0 6px;}
#test-results{max-height:340px;overflow-y:auto;}
.test-row{display:flex;justify-content:space-between;gap:12px;padding:5px 8px;border:1px solid var(--line);border-radius:3px;margin-bottom:4px;background:#0e0e10;font-size:11px;}
.test-row .cmd{color:var(--dim);word-break:break-all;}
.test-row .verdict{letter-spacing:.1em;text-transform:uppercase;font-size:10px;}
.test-row.pass .verdict{color:#8fe0a8;}
.test-row.fail .verdict{color:#eda1a6;}
.test-output{border:1px solid var(--line);border-radius:3px;background:#050506;padding:10px;margin-top:8px;}
.test-output pre{white-space:pre-wrap;word-break:break-word;font-size:11px;color:var(--dim);}
```

- [ ] **Step 4: renderer.js — wire it up**

Replace the two existing Test handlers and add the rest:

```javascript
function renderTestResults(rows, summary) {
  const box = $("test-results");
  const sum = $("test-summary");
  if (sum) sum.textContent = summary || "";
  if (!box) return;
  box.innerHTML = "";
  (rows || []).forEach(function (r) {
    const el = document.createElement("div");
    el.className = "test-row " + (r.success ? "pass" : "fail");
    el.innerHTML = '<span class="cmd">' + escapeHtml(r.command) + '</span><span class="verdict">' + (r.success ? "pass" : "fail") + "</span>";
    box.appendChild(el);
  });
}

function renderTestOutput(text) {
  const box = $("test-results");
  if (!box) return;
  const el = document.createElement("div");
  el.className = "test-output";
  el.innerHTML = "<pre>" + escapeHtml(text || "(no output)") + "</pre>";
  box.appendChild(el);
}

$("test-check").onclick = async function () {
  setStatus("checking");
  renderTestResults([], "running syntax checks...");
  const res = await runAgent(["testall", "", workspace, provider]);
  setStatus("idle");
  if (!res) { renderTestResults([], "check failed"); return; }
  renderTestResults(res.results || [], (res.passed || 0) + " passed, " + (res.failed || 0) + " failed");
};

$("test-run").onclick = async function () {
  const cmd = $("test-cmd").value.trim();
  if (!cmd) { toast("Type a command", "err"); return; }
  if (!workspace) { toast("Pick a workspace", "err"); return; }
  setStatus("running");
  renderTestResults([], "running: " + cmd);
  const r = await window.api.runCommand({ command: cmd, cwd: workspace });
  setStatus("idle");
  renderTestResults([{ command: cmd, success: !!(r && r.success) }], (r && r.success) ? "command succeeded" : "command failed");
  renderTestOutput(r && r.output);
};

$("test-run-project").onclick = async function () {
  if (!workspace) { toast("Pick a workspace", "err"); return; }
  const listing = await window.api.listFiles(workspace);
  const files = (listing && listing.files) || [];
  let pkg = null;
  if (files.indexOf("package.json") !== -1) {
    try {
      const r = await window.api.readFile(workspace + "/package.json", { full: true });
      if (r && r.ok) pkg = JSON.parse(r.text);
    } catch (e) { /* an unreadable package.json just means falling through */ }
  }
  const cmd = window.CNEntry ? window.CNEntry.detectEntrypoint(files, pkg) : null;
  if (!cmd) {
    renderTestResults([], "no entry point found - try a custom command");
    toast("No entry point found", "err");
    return;
  }
  $("test-cmd").value = cmd;
  setStatus("running");
  renderTestResults([], "running: " + cmd);
  const r = await window.api.runCommand({ command: cmd, cwd: workspace });
  setStatus("idle");
  renderTestResults([{ command: cmd, success: !!(r && r.success) }], (r && r.success) ? "project ran successfully" : "project exited with an error");
  renderTestOutput(r && r.output);
};
```

Add to the `window.CN` object:

```javascript
  getAutonomy: function () { const s = $("autonomy-select"); return (s && s.value) || "ask"; },
```

And persist the choice — add near the other startup wiring:

```javascript
(function () {
  const sel = $("autonomy-select");
  if (!sel) return;
  try { const saved = localStorage.getItem("closeni.autonomy"); if (saved) sel.value = saved; } catch (e) {}
  sel.onchange = function () { try { localStorage.setItem("closeni.autonomy", sel.value); } catch (e) {} };
})();
```

- [ ] **Step 5: builder.js — use the policy**

Replace the hardcoded `"ask"` in both places:

```javascript
    const args = ["browser", stepDetail, ws, CN.getProvider(), CN.getAutonomy(), String(i), stepDetail, (plan && plan.summary) || ""];
```

```javascript
    const started = await CN.startSession(CN.getWorkspace(), CN.getProvider(), CN.getAutonomy());
```

- [ ] **Step 6: Verify and drive the app**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:all
cd .. && for f in desktop/*.js; do node --check "$f" || echo "SYNTAX FAIL $f"; done
grep -n '"ask"' desktop/builder.js || echo "no hardcoded ask left"
cd desktop && npm start
```

Expected: suite unchanged at 111 unit / 116 e2e (this task is renderer-only), all desktop files parse, no hardcoded `"ask"` remains in `builder.js`, and the Test tab shows the permission select, Run Project button and results area.

- [ ] **Step 7: Commit**

```bash
git add desktop/
git commit -m "Add a permission policy and give Test/Run its own results"
```

---

### Task 5: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: README**

Add after the "Revising a step" section:

```markdown
## Permissions

The sidebar's Permissions setting controls what happens when a build wants to run
a terminal command:

- **Ask each command** (default) — a modal per command, the original behaviour.
- **Auto-allow** — commands run without prompting, so a long build finishes
  unattended.
- **Never run commands** — commands are skipped. Files are still written and
  syntax checked; nothing executes.

A command skipped by policy logs `COMMAND_DENIED`, exactly as a manual denial
does, so the self-heal path does not treat "did not run" as "failed". The choice
is stored in `localStorage`, so it is per-machine and survives a restart.

## Test and Run

Syntax-check all files reports one row per check with its command and outcome,
plus a summary. Run Project detects the entry point — `scripts.start`, then
`package.json` `main`, then `main.py`, `src/main.py`, `app.py`, `index.js`,
`src/index.js` — and runs it, reporting that it found nothing rather than
guessing. Output appears in the tab as well as the Project log.
```

- [ ] **Step 2: ROADMAP**

Change the sub-project 6 heading to `## 6 · Builder IDE experience — DONE`, update items 18 and 22 to `done`, and change the header count to **3 of 9 complete**.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/ROADMAP.md
git commit -m "Document the permission policy and Test/Run results"
```

---

## Self-Review

**Spec coverage.** Three permission modes as a pure decision (Task 1). `testall` reporting per-check results while keeping its counts (Task 2). Entry point detection as a tested pure function resolving `python3` (Task 3). Sidebar select persisted to `localStorage`, results area, Run Project button, and both `builder.js` call sites (Task 4). Documentation (Task 5).

**Gap found and closed.** The spec assumed the renderer could detect an entry point, but the renderer has no way to list a workspace — `read-file` reads one known path and there is no directory listing. Task 4 Step 1 adds `list-files`. Without it, `detectEntrypoint` would have had nothing to inspect and Run Project could never have worked.

**A second gap.** `$("test-check")` currently calls `runAgent(["testall", "", workspace, provider])`; the empty second argument is the prompt slot, which `testall` ignores. That is preserved rather than "tidied" — changing the positional layout would break the mode for the sake of appearance.

**Placeholder scan.** No TBD/TODO. Every code step carries literal code.

**Type consistency.** `decideApproval` returns `"allow" | "deny" | "ask"` in the implementation and the tests. `results` entries are `{ command, success }` in `testAllMode`, the e2e assertions and `renderTestResults`. `detectEntrypoint(paths, packageJson)` has the same signature in the module, the tests and the Run Project handler. `CN.getAutonomy()` matches both `builder.js` call sites.

**Known rough edge.** Task 4 is renderer code the suite cannot reach; Step 6's manual launch is the only check on the rendering. The two functions it depends on are unit tested, but their wiring is not.
