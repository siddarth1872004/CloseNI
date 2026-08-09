# Builder Diff View and Suggestion Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show what a build step actually changed as a diff, and let the user reply to it and have the change applied.

**Architecture:** `applyPatch` already saves the previous version of every overwritten file under `.agent-backups/<timestamp>/` and already returns `backupDir`; propagating that to the renderer gives the "before" side of every diff for free. A small dependency-free line diff runs in the renderer. A new one-shot `suggest` agent mode resumes the build's existing chat thread, sends the user's suggestion scoped to a step, and applies the reply through the same parse-apply-check path a build step uses.

**Tech Stack:** TypeScript (ES2020, CommonJS via `tsc`) for the agent, plain browser JS for the desktop renderer (loaded via `<script>` tags, no bundler), Electron IPC, plain-CJS test harness.

## Global Constraints

- Agent source is TypeScript under `local-agent/src/`, compiled by `npx tsc -p local-agent/tsconfig.json` to `local-agent/dist/`. **Every test run must be preceded by a build.**
- Desktop files are loaded as plain `<script>` tags in `desktop/index.html` (`renderer.js` then `builder.js`) — **no bundler, no ES modules, no npm imports in renderer code.**
- Tests use the existing harness helpers `section(name)` and `check(name, condition, extra)`. No test framework.
- Suite must stay green: currently **81 unit + 95 end-to-end**.
- Never run two e2e suites at once. Check with `ps -eo args= | grep run-e2e.cjs`, not `pgrep -f`, which matches the checking command itself.
- On WSL, `source scripts/wsl-env.sh` first.
- `sessions.json` is shared between the agent and `desktop/main.js`; only additive changes.
- **Suggestions must never silently start a fresh chat.** A suggestion with no build thread is refused, because a model without the build conversation will make confident, uninformed edits.

---

### Task 1: The diff function

A pure line diff, usable from both the renderer and the test harness.

**Files:**
- Create: `desktop/diff.js`
- Modify: `desktop/index.html` (load it before `builder.js`)
- Test: `local-agent/test/run-tests.cjs` (new `testDiff()` section)

**Interfaces:**
- Produces:
  - `diffLines(before: string, after: string): DiffRow[]`
  - `DiffRow = { type: "same" | "add" | "remove" | "gap", text: string }`
  - `"gap"` marks collapsed unchanged runs; its `text` is like `"… 12 unchanged lines"`.
  - Exposed as `module.exports` under Node and as `window.CNDiff` in the renderer.

- [ ] **Step 1: Write the failing test**

Add to `local-agent/test/run-tests.cjs`, immediately above `function testRelevance() {`:

```javascript
function testDiff() {
  section("line diff");
  const { diffLines } = require(path.join(__dirname, "..", "..", "desktop", "diff.js"));
  const types = (rows) => rows.map((r) => r.type).join(",");
  const texts = (rows, t) => rows.filter((r) => r.type === t).map((r) => r.text);

  check("identical files are all same", types(diffLines("a\nb", "a\nb")) === "same,same");

  const added = diffLines("a\nc", "a\nb\nc");
  check("a added line is marked add", texts(added, "add").join() === "b", JSON.stringify(added));
  check("adding does not mark removals", texts(added, "remove").length === 0, JSON.stringify(added));

  const removed = diffLines("a\nb\nc", "a\nc");
  check("a removed line is marked remove", texts(removed, "remove").join() === "b", JSON.stringify(removed));

  const changed = diffLines("a\nold\nc", "a\nnew\nc");
  check("a changed line is a remove plus an add", texts(changed, "remove").join() === "old" && texts(changed, "add").join() === "new", JSON.stringify(changed));

  // A created file has no previous version: everything is an addition.
  const created = diffLines("", "x\ny");
  check("empty before means all added", types(created) === "add,add", JSON.stringify(created));
  check("empty both sides yields nothing", diffLines("", "").length === 0);

  // Long unchanged runs collapse so a small change in a big file stays readable.
  const big = Array.from({ length: 40 }, (_, i) => "line" + i).join("\n");
  const bigChanged = big + "\nEXTRA";
  const collapsed = diffLines(big, bigChanged);
  check("long unchanged runs collapse to a gap", collapsed.some((r) => r.type === "gap"), types(collapsed).slice(0, 60));
  check("collapsing keeps the change visible", collapsed.some((r) => r.type === "add" && r.text === "EXTRA"));
  check("collapsed output is far shorter than the file", collapsed.length < 20, "rows: " + collapsed.length);

  // Trailing newlines must not invent a phantom final line.
  check("trailing newline is not a spurious line", diffLines("a\n", "a\n").every((r) => r.type === "same"), JSON.stringify(diffLines("a\n", "a\n")));
}
```

Register it in the runner block:

```javascript
  testSessionStore();
  testDelta();
  testDiff();
  testRelevance();
```

- [ ] **Step 2: Run to verify it fails**

```bash
source scripts/wsl-env.sh && cd local-agent && npm test
```

Expected: FAIL — `Cannot find module '.../desktop/diff.js'`.

- [ ] **Step 3: Write the implementation**

Create `desktop/diff.js`:

```javascript
/*
 * Line diff for the Builder's file cards.
 *
 * Loaded as a plain <script> in the renderer (exposes window.CNDiff) and
 * require()d by the test harness (exposes module.exports). No bundler, so it
 * cannot use import/export.
 */
(function (root) {
  var GAP_THRESHOLD = 6; // unchanged runs longer than this collapse
  var GAP_CONTEXT = 2;   // lines kept either side of a collapsed run

  function splitLines(text) {
    if (text === "" || text === null || text === undefined) return [];
    var lines = String(text).split("\n");
    // "a\n" is one line, not two — a trailing newline is a terminator.
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }

  /** Longest common subsequence table, walked back into a row list. */
  function diffLines(before, after) {
    var a = splitLines(before);
    var b = splitLines(after);
    var n = a.length;
    var m = b.length;

    var lcs = [];
    for (var i = 0; i <= n; i++) lcs.push(new Array(m + 1).fill(0));
    for (var i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }

    var rows = [];
    var x = 0, y = 0;
    while (x < n && y < m) {
      if (a[x] === b[y]) { rows.push({ type: "same", text: a[x] }); x++; y++; }
      else if (lcs[x + 1][y] >= lcs[x][y + 1]) { rows.push({ type: "remove", text: a[x] }); x++; }
      else { rows.push({ type: "add", text: b[y] }); y++; }
    }
    while (x < n) { rows.push({ type: "remove", text: a[x] }); x++; }
    while (y < m) { rows.push({ type: "add", text: b[y] }); y++; }

    return collapse(rows);
  }

  /** Replace long runs of unchanged lines with a single gap marker. */
  function collapse(rows) {
    var out = [];
    var i = 0;
    while (i < rows.length) {
      if (rows[i].type !== "same") { out.push(rows[i]); i++; continue; }
      var start = i;
      while (i < rows.length && rows[i].type === "same") i++;
      var run = i - start;
      if (run <= GAP_THRESHOLD) {
        for (var k = start; k < i; k++) out.push(rows[k]);
        continue;
      }
      var head = start === 0 ? 0 : GAP_CONTEXT;
      var tail = i === rows.length ? 0 : GAP_CONTEXT;
      for (var k = start; k < start + head; k++) out.push(rows[k]);
      out.push({ type: "gap", text: "… " + (run - head - tail) + " unchanged lines" });
      for (var k = i - tail; k < i; k++) out.push(rows[k]);
    }
    return out;
  }

  var api = { diffLines: diffLines };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNDiff = api;
})(typeof window !== "undefined" ? window : globalThis);
```

In `desktop/index.html`, load it before the others:

```html
<script src="diff.js"></script>
<script src="renderer.js"></script>
<script src="builder.js"></script>
```

- [ ] **Step 4: Run to verify it passes**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:all
```

Expected: PASS — unit rises from 81 to 92; e2e stays at 95.

- [ ] **Step 5: Commit**

```bash
git add desktop/diff.js desktop/index.html local-agent/test/run-tests.cjs
git commit -m "Add a dependency-free line diff for the Builder"
```

---

### Task 2: Carry backupDir to the renderer, and read files whole

`applyPatch` already returns `backupDir`; it stops at `runBuildStep`. Also raise the read cap, because diffing a truncated file produces a confidently wrong result.

**Files:**
- Modify: `local-agent/src/index.ts` — `StepOutcome`, the success return in `runBuildStep`
- Modify: `desktop/main.js` — `read-file` handler
- Modify: `desktop/preload.js` — `readFile` signature
- Test: `local-agent/test/run-e2e.cjs`

**Interfaces:**
- Produces:
  - `StepOutcome` gains `backupDir?: string`
  - `readFile(path, opts?)` where `opts` is `{ full?: boolean }`; without it the existing 4000-char cap applies, so current callers are unchanged.

- [ ] **Step 1: Write the failing test**

Add to `run-e2e.cjs` before the final `await mock.close();`:

```javascript
  // ------------------------------- an overwrite reports where the old copy went
  section("step results carry the backup directory");
  {
    const ws = mkWorkspace();
    mock.resetThreads();

    mock.setReplies([F + 'json\n{"files":[{"path":"m.js","mode":"create","content":"const v = 1;\\n"}]}\n' + F]);
    const d0 = "Execute ONLY this step: step 0. Expected files: m.js";
    const first = await runAgent(["browser", d0, ws, "mock", "auto", "0", d0, "goal"]);
    check("create step succeeds", !!first.result && first.result.success === true, JSON.stringify(first.result));
    check("a create reports no backup dir", !first.result.backupDir, JSON.stringify(first.result));

    mock.setReplies([F + 'json\n{"files":[{"path":"m.js","mode":"overwrite","content":"const v = 2;\\n"}]}\n' + F]);
    const d1 = "Execute ONLY this step: step 1. Expected files: m.js";
    const second = await runAgent(["browser", d1, ws, "mock", "auto", "1", d1, "goal"]);
    check("overwrite step succeeds", !!second.result && second.result.success === true, JSON.stringify(second.result));
    check("an overwrite reports a backup dir", !!second.result.backupDir, JSON.stringify(second.result));
    check("the backup holds the previous content",
      !!second.result.backupDir && fs.readFileSync(path.join(second.result.backupDir, "m.js"), "utf8").includes("const v = 1"),
      second.result.backupDir);

    fs.rmSync(ws, { recursive: true, force: true });
  }
```

- [ ] **Step 2: Run to verify it fails**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:e2e
```

Expected: FAIL — `an overwrite reports a backup dir`, because `StepOutcome` drops it.

- [ ] **Step 3: Implement**

In `local-agent/src/index.ts`, add the field to `StepOutcome`:

```typescript
interface StepOutcome {
  success: boolean;
  appliedFiles?: string[];
  /** Where applyPatch copied the previous version of any overwritten file. */
  backupDir?: string;
  error?: string;
  lastError?: string;
  raw?: string;
}
```

and carry it on the success return inside `runBuildStep`:

```typescript
    if (!failed) return { success: true, appliedFiles: applyResult.appliedFiles, backupDir: applyResult.backupDir };
```

In `desktop/main.js`, let the caller ask for the whole file:

```javascript
ipcMain.handle("read-file", function (event, arg) {
  // Accepts a bare path (legacy callers, capped) or { path, full }. Diffing a
  // truncated file would produce a confidently wrong result.
  const absPath = typeof arg === "string" ? arg : arg && arg.path;
  const full = typeof arg === "object" && arg && arg.full;
  try {
    const s = fs.readFileSync(absPath, "utf-8");
    if (full) return { ok: true, text: s, truncated: false };
    return { ok: true, text: s.slice(0, 4000), truncated: s.length > 4000 };
  } catch (e) { return { ok: false, error: e.message }; }
});
```

In `desktop/preload.js`:

```javascript
  readFile: function (p, opts) { return ipcRenderer.invoke("read-file", opts ? { path: p, full: !!opts.full } : p); },
```

- [ ] **Step 4: Run to verify it passes**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:all
```

Expected: PASS — unit 92, e2e rises from 95 to 100.

- [ ] **Step 5: Commit**

```bash
git add local-agent/src/index.ts desktop/main.js desktop/preload.js local-agent/test/run-e2e.cjs
git commit -m "Carry backupDir to the renderer and allow untruncated reads"
```

---

### Task 3: The suggest mode

**Files:**
- Modify: `local-agent/src/index.ts` — new `suggestMode`, new arg branch in `main()`
- Test: `local-agent/test/run-e2e.cjs`

**Interfaces:**
- Consumes: `runBuildStep`'s pipeline, `openProviderForBuild`, `navigateToBuildThread`'s boolean.
- Produces: mode `suggest <workspace> <provider> <stepIndex> <suggestion>`, emitting the same `{ success, appliedFiles, backupDir }` shape a build step does.

- [ ] **Step 1: Write the failing test**

Add to `run-e2e.cjs` before the final `await mock.close();`:

```javascript
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
    check("an overwrite reports a backup", !!sug.result.backupDir, JSON.stringify(sug.result));

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
```

- [ ] **Step 2: Run to verify it fails**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:e2e
```

Expected: FAIL — `suggest succeeds` is false; the mode does not exist so the agent falls through to `browser` mode with nonsense arguments.

- [ ] **Step 3: Implement**

Add to `index.ts`, directly above `buildMode`:

```typescript
/**
 * Revise one step of a finished or in-flight build. Resumes the build's thread
 * so the model still has the whole build in view, then applies the reply through
 * the same path a step uses.
 */
async function suggestMode(workspace: string, providerId: string, stepIndex: number, suggestion: string) {
  const registry = new ProviderRegistry();
  registry.loadProviders();
  const config = registry.getProvider(providerId);
  if (!config) { emit({ success: false, error: "Provider not found: " + providerId }); return; }

  const controller = new PlaywrightController(config);
  controller.setWorkspace(workspace);
  controller.setThreadKind("build");

  if (!controller.getBuildThreadUrl()) {
    emit({ success: false, error: "No build thread for this workspace. Run a build before suggesting changes." });
    return;
  }

  await controller.launch(config);
  try {
    // A fresh chat would answer confidently with none of the build in view, so
    // a failed resume is a refusal rather than a fallback.
    const resumed = await controller.navigateToBuildThread(config);
    if (!resumed) {
      emit({ success: false, error: "The build thread could not be reopened, so there is no context to revise against." });
      return;
    }
    await controller.waitForLogin();

    const detail =
      "Revise ONLY what step " + (stepIndex + 1) + " produced. Change requested:\n" + suggestion +
      "\n\nReply with the full updated contents of any file you change, using mode \"overwrite\".";

    emit(await runBuildStep(controller, config, {
      prompt: suggestion,
      workspace: workspace,
      autonomy: "auto",
      stepIndex: stepIndex,
      stepDetail: detail,
      goalSummary: "",
    }));
  } finally {
    await controller.close();
  }
}
```

In `main()`, add beside the other modes:

```typescript
    // Positional layout: workspace, provider, step index, suggestion text.
    else if (mode === "suggest") await suggestMode(args[1] || path.resolve(process.cwd()), args[2] || "deepseek", args[3] ? parseInt(args[3]) : 0, resolveArg(args[4]));
```

`stepIndex` is passed through to `runBuildStep`, and a non-zero index means it reads the existing ledger rather than resetting — which is right, since the thread already holds the build.

- [ ] **Step 4: Run to verify it passes**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:all
```

Expected: PASS — unit 92, e2e rises from 100 to 109.

- [ ] **Step 5: Commit**

```bash
git add local-agent/src/index.ts local-agent/test/run-e2e.cjs
git commit -m "Add a suggest mode that revises a step in its build thread"
```

---

### Task 4: The Builder UI

**Files:**
- Modify: `desktop/index.html` — the suggestion bar markup
- Modify: `desktop/styles.css` — diff and suggestion styles
- Modify: `desktop/renderer.js` — expose `CN.suggest`
- Modify: `desktop/preload.js` — expose `suggest`
- Modify: `desktop/main.js` — `suggest` IPC handler
- Modify: `desktop/builder.js` — render diffs, wire the suggestion bar

**Interfaces:**
- Consumes: `CNDiff.diffLines` (Task 1), `backupDir` on step results (Task 2), the `suggest` mode (Task 3).
- Produces: `CN.suggest(stepIndex, text): Promise<StepOutcome>`.

- [ ] **Step 1: main.js — the IPC handler**

Add beside `run-agent`, reusing its process plumbing shape:

```javascript
ipcMain.handle("suggest", function (event, payload) {
  return new Promise(function (resolve) {
    const proc = spawn("node", [agentPath(), "suggest", payload.workspace, payload.provider, String(payload.stepIndex), payload.text],
      { cwd: path.join(__dirname, ".."), env: Object.assign({}, process.env, { AGENT_HEADED: payload.headed ? "1" : "0" }) });
    agentProc = proc;
    let output = "";
    let lineBuf = "";
    proc.stdout.on("data", function (d) {
      const text = d.toString();
      output += text;
      lineBuf += text;
      let idx;
      while ((idx = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.substring(0, idx).replace(/\r$/, "");
        lineBuf = lineBuf.substring(idx + 1);
        routeLine(line);
      }
    });
    proc.stderr.on("data", function (d) { routeLine(d.toString()); });
    proc.on("close", function () {
      agentProc = null;
      const start = output.indexOf("AGENT_OUTPUT_START");
      const end = output.indexOf("AGENT_OUTPUT_END");
      let result = null;
      if (start !== -1 && end !== -1) {
        const lines = output.substring(start + 18, end).split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l.indexOf("{") === 0; });
        if (lines.length) { try { result = JSON.parse(lines[lines.length - 1]); } catch (e) {} }
      }
      resolve(result || { success: false, error: "No structured output from agent." });
    });
    proc.on("error", function (e) { agentProc = null; resolve({ success: false, error: String(e) }); });
  });
});
```

- [ ] **Step 2: preload.js and renderer.js — expose it**

In `desktop/preload.js`:

```javascript
  suggest: function (payload) { return ipcRenderer.invoke("suggest", payload); },
```

In `desktop/renderer.js`, inside the `window.CN` object beside `runAgent`:

```javascript
  suggest: function (stepIndex, text) {
    try {
      const cb = $("show-browser");
      return window.api.suggest({
        workspace: workspace, provider: provider, stepIndex: stepIndex,
        text: text, headed: cb ? cb.checked : false,
      }).catch(function (e) { return { success: false, error: String(e) }; });
    } catch (e) { return Promise.resolve({ success: false, error: String(e) }); }
  },
```

- [ ] **Step 3: index.html and styles.css — the suggestion bar**

In `desktop/index.html`, inside `#step-detail`, after `#step-detail-body`:

```html
            <div id="suggest-bar">
              <input id="suggest-input" placeholder="Suggest a change to this step..." />
              <button id="suggest-send" class="btn invert">Send</button>
            </div>
```

Append to `desktop/styles.css`:

```css
#suggest-bar{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--line);background:#0b0b0d;}
#suggest-input{flex:1;background:#050506;border:1px solid var(--line);color:var(--txt);padding:8px 10px;border-radius:3px;font-family:inherit;font-size:12px;}
#suggest-input:disabled{opacity:.5;}
.diff-line{display:block;white-space:pre-wrap;word-break:break-word;padding:0 4px;}
.diff-line.add{background:#0d2416;color:#8fe0a8;}
.diff-line.remove{background:#2a1214;color:#eda1a6;}
.diff-line.same{color:var(--dim);}
.diff-line.gap{color:var(--mut);font-style:italic;background:#0a0a0c;}
```

- [ ] **Step 4: builder.js — render diffs and wire the bar**

Replace the file-body construction inside the `s.result.files.forEach` block:

```javascript
        const bb = document.createElement("div");
        bb.className = "file-body";
        if (f.diff && f.diff.length) {
          bb.innerHTML = "<pre>" + f.diff.map(function (r) {
            const mark = r.type === "add" ? "+" : r.type === "remove" ? "-" : r.type === "gap" ? " " : " ";
            return '<span class="diff-line ' + r.type + '">' + CN.escapeHtml(mark + " " + r.text) + "</span>";
          }).join("") + "</pre>";
        } else {
          bb.innerHTML = "<pre>" + CN.escapeHtml(f.content || "") + "</pre>";
        }
```

Replace the file-loading loop inside `runOne` so it builds diffs:

```javascript
      const filesArr = [];
      for (const af of (res.appliedFiles || [])) {
        let after = "";
        let before = "";
        try {
          const fr = await CN.readFile(ws + "/" + af, { full: true });
          if (fr && fr.ok) after = fr.text;
        } catch (e) {}
        if (res.backupDir) {
          try {
            const br = await CN.readFile(res.backupDir + "/" + af, { full: true });
            if (br && br.ok) before = br.text;
          } catch (e) { /* no backup entry means the file was created */ }
        }
        filesArr.push({
          path: af,
          mode: before ? "overwrite" : "create",
          content: after,
          diff: window.CNDiff ? window.CNDiff.diffLines(before, after) : null,
        });
      }
```

Add the suggestion handler at the end of the file, beside the other button handlers:

```javascript
  $("suggest-send").onclick = async function () {
    const input = $("suggest-input");
    const text = (input.value || "").trim();
    if (!text) return;
    if (selected < 0 || !steps[selected]) { CN.toast("Select a step first", "err"); return; }
    if (steps[selected].status === "pending" || steps[selected].status === "running") {
      CN.toast("That step has not finished yet", "err"); return;
    }
    input.disabled = true;
    $("suggest-send").disabled = true;
    CN.log("suggesting on step " + (selected + 1) + ": " + text, "step");
    const res = await CN.suggest(selected, text);
    input.disabled = false;
    $("suggest-send").disabled = false;
    if (res && res.success) {
      input.value = "";
      const ws = CN.getWorkspace();
      const filesArr = [];
      for (const af of (res.appliedFiles || [])) {
        let after = "", before = "";
        try { const fr = await CN.readFile(ws + "/" + af, { full: true }); if (fr && fr.ok) after = fr.text; } catch (e) {}
        if (res.backupDir) {
          try { const br = await CN.readFile(res.backupDir + "/" + af, { full: true }); if (br && br.ok) before = br.text; } catch (e) {}
        }
        filesArr.push({ path: af, mode: before ? "overwrite" : "create", content: after, diff: window.CNDiff ? window.CNDiff.diffLines(before, after) : null });
      }
      steps[selected].result = { files: filesArr };
      selectStep(selected);
      CN.log("suggestion applied: " + (res.appliedFiles || []).join(", "), "ok");
      CN.toast("Change applied");
    } else {
      CN.log("suggestion failed: " + ((res && res.error) || "unknown"), "err");
      CN.toast((res && res.error) || "Suggestion failed", "err");
    }
  };
  $("suggest-input").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); $("suggest-send").click(); }
  });
```

- [ ] **Step 5: Verify and drive the app**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:all
cd .. && for f in desktop/*.js; do node --check "$f" || echo "SYNTAX FAIL $f"; done
cd desktop && npm start
```

Expected: suite unchanged at 92 unit / 109 e2e (this task is renderer-only), every desktop file parses, and the app opens on the Chat tab with no errors beyond the `viz_main_impl.cc` GPU lines. Switch to the Builder tab and confirm the suggestion bar renders at the bottom of the step detail pane.

- [ ] **Step 6: Commit**

```bash
git add desktop/index.html desktop/styles.css desktop/main.js desktop/preload.js desktop/renderer.js desktop/builder.js
git commit -m "Show diffs in the Builder and let the user suggest changes"
```

---

### Task 5: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: README**

Add a section after `## How a build step runs`:

```markdown
## Revising a step

The Builder shows what each step changed as a diff. `applyPatch` copies the
previous version of every overwritten file into
`<workspace>/.agent-backups/<timestamp>/` and reports that directory, so the
renderer reads both versions and diffs them; a created file has no backup and
renders as entirely added.

The suggestion box under a selected step sends `suggest <workspace> <provider>
<stepIndex> <text>`, which resumes that build's chat thread and applies the
reply through the same parse-apply-check path a build step uses. Because the
thread is still open, the model has the whole build in view.

Suggestions do not cascade: revising step 2 does not re-run steps 3 onward.
Starting a new build clears the thread, and with it the ability to revise the
previous one.
```

- [ ] **Step 2: ROADMAP**

Under `## 6 · Builder IDE experience`, change items 16 and 17 to:

```markdown
- **16. IDE-like diff view in Builder** — `done`. File cards show a line diff
  against the backup `applyPatch` already writes.
- **17. Suggestion / fix chat after generation and after tests** — `done`. Any
  completed step can be revised through its build thread; changes do not cascade
  to later steps.
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/ROADMAP.md
git commit -m "Document the Builder diff view and suggestions"
```

---

## Self-Review

**Spec coverage.** Diffs replacing full contents in the existing cards (Task 1 + Task 4). Suggestion box pinned to the bottom of the detail pane (Task 4, Step 3). Any completed step revisable at any time (Task 4's handler checks only that the step is not pending or running). Suggestions not cascading (nothing re-runs later steps; documented in Task 5). `backupDir` propagation (Task 2). The `suggest` mode resuming the thread (Task 3). Refusing rather than falling back to a fresh chat (Task 3, both the missing-thread guard and the `resumed` check, each with a test). Diff unit coverage including the created-file and collapsing cases (Task 1).

**Gap found and closed.** The spec did not mention that `read-file` truncates at 4000 characters. Diffing a truncated file would produce a confidently wrong diff — lines beyond the cap would read as deletions. Task 2 adds an opt-in `full` flag rather than changing the default, so existing callers are untouched.

**Placeholder scan.** No TBD/TODO. Every code step carries literal code.

**Type consistency.** `DiffRow.type` is `"same" | "add" | "remove" | "gap"` in the module, the tests and the renderer's class names, which the CSS matches. `backupDir` is spelled identically in `applyPatch`, `StepOutcome`, the e2e assertions and `builder.js`. `CN.suggest(stepIndex, text)` matches the `suggest` IPC payload and the agent's positional arguments.

**Known rough edge.** Task 4 is renderer code and the suite does not reach it; Step 5's manual launch is the only check. The diff *function* is unit tested, but its *rendering* is not — a mistake in the HTML assembly would reach a user before a test caught it.
