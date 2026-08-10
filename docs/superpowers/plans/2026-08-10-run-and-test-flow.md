# Run & Test Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it obvious what a built project is, how to run it, and why it broke.

**Architecture:** The project carries its own run instructions in a file the app writes and reads. The Test panel becomes a run bar, an output column and a chat that already knows the last run. Every decision behind those — which command wins, what to preview, how long a plan will take — is a pure function with its own tests, because none of it can be checked by looking at the app.

**Tech Stack:** TypeScript compiled by `tsc` for the agent, UMD-style modules in `desktop/` for renderer logic (no bundler), Electron `<webview>` for the preview, CSS `steps()` timing for pixel motion.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-10-run-and-test-flow-design.md`. Read it before starting.
- **The app writes the run manifest, not the model.** A model that forgets is a failure mode this project has already hit.
- **An edited run command is never overwritten.** `userEdited: true` survives every later build. Watching the next build undo your correction is how people stop trusting a tool.
- **The step bound rejects, it does not truncate.** Truncating silently drops the end of a project — the deployment step, the tests — while looking like it worked.
- **Motion is event-driven only.** Ambient animation was built, reviewed and rejected. Everything sits behind `prefers-reduced-motion` and `data-decor="off"`.
- **The preview gets its own `<webview>` partition, `nodeintegration` off, `contextIsolation` on.** The default partition holds live provider session cookies; a generated page must never share them.
- **No colour literals outside theme blocks** — `styles.css` is linted, and any new rule must use tokens.
- Run tests with `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`.
- Never commit `local-agent/storage/sessions.json` or anything under `local-agent/storage/browser-profiles/`.

## File Structure

| File | Responsibility |
|---|---|
| `local-agent/src/run-manifest.ts` (create) | `resolveRun`, `manifestFrom`, `renderRunScript` — pure |
| `local-agent/src/plan-scale.ts` (create) | `estimateDuration`, `MAX_PLAN_STEPS` — pure |
| `local-agent/src/parser/json-repair.ts` (modify) | Reject an over-long plan |
| `local-agent/src/index.ts` (modify) | Prompts, `allowNoChanges`, `askMode`, manifest writing |
| `desktop/preview-target.js` (create) | `previewTarget(output, files)` — pure, UMD |
| `desktop/index.html`, `renderer.js`, `builder.js`, `styles.css` (modify) | Panel, chat, preview, motion |
| `desktop/main.js`, `preload.js` (modify) | Manifest IPC, `ask` spawn |
| `local-agent/test/run-tests.cjs` (modify) | New unit sections |

**Phases:** 1 (tasks 1–2) prompts · 2 (tasks 3–4) manifest · 3 (tasks 5–6) panel and chat · 4 (task 7) preview · 5 (task 8) motion · task 9 docs and merge. The app works after every task.

---

### Task 1: Let the plan be as long as the work

**Files:**
- Create: `local-agent/src/plan-scale.ts`
- Modify: `local-agent/src/parser/json-repair.ts`, `local-agent/src/index.ts:122-124` and `:146`
- Test: `local-agent/test/run-tests.cjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `MAX_PLAN_STEPS = 40`, `estimateDuration(stepCount: number): string`

- [ ] **Step 1: Write the failing test**

Add to `local-agent/test/run-tests.cjs`, above `function testToolchain()`:

```javascript
function testPlanScale() {
  section("plan scale");
  const { estimateDuration, MAX_PLAN_STEPS } = require(path.join(DIST, "plan-scale.js"));
  const { parsePlanRobust } = require(path.join(DIST, "parser/json-repair.js"));

  check("the bound is 40", MAX_PLAN_STEPS === 40);

  // Each step is a browser round-trip of a minute or two, so a long plan is a
  // long build. The estimate exists so that is a choice, not a surprise.
  check("a short plan reads in minutes", /min/.test(estimateDuration(3)), estimateDuration(3));
  check("a long plan reads in a bigger unit", estimateDuration(30) !== estimateDuration(3));
  check("zero steps is survivable", typeof estimateDuration(0) === "string");

  const mk = (n) => {
    const steps = [];
    for (let i = 0; i < n; i++) steps.push({ title: "s" + i, detail: "d", files: ["f" + i + ".py"] });
    return "```json\n" + JSON.stringify({ summary: "x", steps: steps }) + "\n```";
  };

  // The eight-step cap was the complaint. Anything up to the bound must parse.
  check("a nine-step plan parses", (parsePlanRobust(mk(9)) || {}).steps.length === 9);
  check("a twenty-step plan parses", (parsePlanRobust(mk(20)) || {}).steps.length === 20);
  check("exactly forty parses", (parsePlanRobust(mk(40)) || {}).steps.length === 40);

  // Rejecting rather than truncating: a truncated plan silently loses the end
  // of the project - deployment, tests - while looking like it worked.
  check("forty-one is rejected, not truncated", parsePlanRobust(mk(41)) === null);

  // runCommand is optional so older and hand-written plans still parse.
  const withRun = '```json\n{"summary":"x","runCommand":"python3 app.py","steps":[{"title":"t","detail":"d","files":["a.py"]}]}\n```';
  check("a plan may declare how to run itself", parsePlanRobust(withRun).runCommand === "python3 app.py");
  check("a plan without runCommand still parses",
    !!parsePlanRobust('```json\n{"summary":"x","steps":[{"title":"t","detail":"d","files":["a.py"]}]}\n```'));
}
```

Register it in `main()`:

```javascript
  testStoragePaths();
  testPlanScale();
  testBrowserCheck();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: FAIL — `Cannot find module '.../dist/plan-scale.js'`

- [ ] **Step 3: Write the pure module**

Create `local-agent/src/plan-scale.ts`:

```typescript
/**
 * How big is a plan, and how long will it take?
 *
 * Every step is a browser round-trip: send a prompt, wait for a model to write
 * files, apply and syntax-check them. That is a minute or two each, so a
 * twenty-step plan is a long build. The estimate exists so the user chooses
 * that rather than discovering it.
 */

/**
 * Upper bound on plan length.
 *
 * Not a design cap - it is a guard against a malformed reply proposing hundreds
 * of steps and starting a build that runs for a day. A plan over this is
 * rejected and re-asked, never truncated: truncating drops the end of the
 * project, which is worse than asking again.
 */
export const MAX_PLAN_STEPS = 40;

/** Measured against real builds: roughly 90 seconds per step, door to door. */
const SECONDS_PER_STEP = 90;

export function estimateDuration(stepCount: number): string {
  const minutes = Math.round((Math.max(0, stepCount) * SECONDS_PER_STEP) / 60);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return "roughly " + minutes + " min";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return "roughly " + hours + "h" + (rest ? " " + rest + "m" : "");
}
```

- [ ] **Step 4: Enforce the bound in the parser**

In `local-agent/src/parser/json-repair.ts`, add the import at the top:

```typescript
import { MAX_PLAN_STEPS } from "../plan-scale.js";
```

Then replace `parsePlanRobust`:

```typescript
export function parsePlanRobust(text: string): any {
  const plan = parsePlanShape(text);
  // Over the bound, treat the reply as unparseable so the caller re-asks.
  // Truncating to the bound would silently drop the end of the project.
  if (plan && plan.steps && plan.steps.length > MAX_PLAN_STEPS) return null;
  return plan;
}

function parsePlanShape(text: string): any {
  const parsed = robustParseJson(text);
  if (parsed && parsed.steps && Array.isArray(parsed.steps)) return parsed;
  if (parsed && parsed.plan && parsed.plan.steps) return parsed.plan;
  return extractStepsHeuristic(text);
}
```

- [ ] **Step 5: Replace the cap in both prompts**

`"Rules: 3-8 steps"` appears **twice** — in `planMode` and again in `revisePlanMode`. Fixing one leaves plan revision still capped, which looks fixed and is not.

In `local-agent/src/index.ts`, `planMode`:

```typescript
  const prompt = "Create an implementation plan as JSON:\n" +
    "{\"summary\":\"goal\",\"runCommand\":\"how to run the finished project\",\"steps\":[{\"title\":\"\",\"detail\":\"\",\"files\":[\"path\"]}]}" +
    "Rules: as many steps as the work genuinely needs - a one-file script might be 2, " +
    "a full application with a database, API and UI might be 20 or more. Never pad, never compress. " +
    "Each step must touch a different set of files. Wrap in \`\`\`json.\n" +
    "runCommand is the single command that starts the finished project, e.g. \"python3 src/app/server.py\".\n\n" +
    "Project:\n" + ctx.tree + "\n\nChat:\n" + transcript;
```

And in `revisePlanMode`:

```typescript
  const prompt = "Update plan with: " + changes +
    "\n\nJSON format: {\"summary\":\"\",\"runCommand\":\"how to run the finished project\",\"steps\":[{\"title\":\"\",\"detail\":\"\",\"files\":[\"\"]}]}\n" +
    "As many steps as the work needs - never pad, never compress. Different files per step.";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && node local-agent/test/run-tests.cjs`
Expected: PASS, count up by 10.

- [ ] **Step 7: Commit**

```bash
git add local-agent/src/plan-scale.ts local-agent/src/parser/json-repair.ts local-agent/src/index.ts local-agent/test/run-tests.cjs
git commit -m "Let a plan be as long as the work, not eight steps"
```

---

### Task 2: Ask the model for better code

**Files:**
- Modify: `local-agent/src/index.ts` (`buildPrompt`)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. Prompt text only.

**The risk in this task is the whole task.** The build prompt is terse because
this project has been burned by replies the parser could not read. The block
goes **last**, stays four lines, and the e2e suite is the gate.

- [ ] **Step 1: Add the block**

In `buildPrompt`, insert between the architecture rules and `contextStr`:

```typescript
    "CODE QUALITY:\n" +
    "- Handle errors and validate input. Do not write happy-path-only code.\n" +
    "- Docstrings on public functions. Comments explain why, not what.\n" +
    "- Avoid needless passes, quadratic loops over large inputs, and repeated I/O.\n" +
    "- The project must be runnable: keep requirements.txt / package.json in step with what the code imports.\n" +
```

- [ ] **Step 2: Verify parsing did not regress**

This is the gate. The e2e suite drives the real parser against mock replies:

Run: `source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && node local-agent/test/run-e2e.cjs > /tmp/e2e.log 2>&1; tail -3 /tmp/e2e.log`
Expected: PASS, 150 passed, 0 failed.

If plan or build parsing checks fail, **shrink the block** rather than
debugging around it — four lines of quality guidance is not worth a build that
cannot be parsed.

- [ ] **Step 3: Commit**

```bash
git add local-agent/src/index.ts
git commit -m "Ask the model for error handling, docs and efficiency"
```

---

### Task 3: The run manifest

**Files:**
- Create: `local-agent/src/run-manifest.ts`
- Test: `local-agent/test/run-tests.cjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface RunManifest { version: number; run: string; install?: string; language?: string; userEdited?: boolean; generatedBy?: string }`
  - `interface RunResolution { command: string | null; source: "manifest" | "plan" | "detected" | "none" }`
  - `resolveRun(manifest: RunManifest | null, planRunCommand: string | undefined, detected: string | null): RunResolution`
  - `mergeManifest(existing: RunManifest | null, run: string | null, opts?: { userEdited?: boolean; language?: string; install?: string }): RunManifest`
  - `renderRunScript(manifest: RunManifest, platform: "win32" | "posix"): string`
  - `MANIFEST_NAME = "closeni.run.json"`

- [ ] **Step 1: Write the failing test**

Add to `local-agent/test/run-tests.cjs`, above `function testToolchain()`:

```javascript
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
```

Register it in `main()`:

```javascript
  testPlanScale();
  testRunManifest();
  testBrowserCheck();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: FAIL — `Cannot find module '.../dist/run-manifest.js'`

- [ ] **Step 3: Write the implementation**

Create `local-agent/src/run-manifest.ts`:

```typescript
/**
 * How to run a project, written into the project.
 *
 * The app used to guess from filenames - main.py, index.js, Cargo.toml - so a
 * project at src/app/server.py matched nothing and the panel said "no entry
 * point found", despite the model having declared the command while planning.
 *
 * A file on disk fixes the deeper version of that: the answer survives closing
 * the app, and the project can be run without it.
 */

export const MANIFEST_NAME = "closeni.run.json";
const MANIFEST_VERSION = 1;

export interface RunManifest {
  version: number;
  run: string;
  install?: string;
  language?: string;
  /** Set when the user edits the command. Later builds then leave it alone. */
  userEdited?: boolean;
  generatedBy?: string;
}

export interface RunResolution {
  command: string | null;
  source: "manifest" | "plan" | "detected" | "none";
}

function clean(value: string | null | undefined): string {
  return (value || "").trim();
}

/**
 * Which command to run, and where it came from.
 *
 * The source is returned as well as the command because the panel shows it:
 * "from your plan" and "detected from main.py" are different levels of
 * confidence, and the user should be able to tell which one they have.
 */
export function resolveRun(
  manifest: RunManifest | null,
  planRunCommand: string | undefined,
  detected: string | null,
): RunResolution {
  const fromManifest = clean(manifest && manifest.run);
  if (fromManifest) return { command: fromManifest, source: "manifest" };
  const fromPlan = clean(planRunCommand);
  if (fromPlan) return { command: fromPlan, source: "plan" };
  const fromDetection = clean(detected);
  if (fromDetection) return { command: fromDetection, source: "detected" };
  return { command: null, source: "none" };
}

/**
 * Fold a new command into an existing manifest.
 *
 * A command the user edited is never replaced. Without that rule, correcting a
 * wrong command and then building again would silently undo the correction.
 */
export function mergeManifest(
  existing: RunManifest | null,
  run: string | null,
  opts?: { userEdited?: boolean; language?: string; install?: string },
): RunManifest {
  const o = opts || {};
  const keepUserRun = !!(existing && existing.userEdited) && !o.userEdited;
  const next: RunManifest = {
    version: MANIFEST_VERSION,
    run: keepUserRun ? existing!.run : clean(run) || clean(existing && existing.run),
    generatedBy: "CloseNI",
  };
  if (o.userEdited || (existing && existing.userEdited)) next.userEdited = true;
  const install = o.install || (existing && existing.install);
  if (install) next.install = install;
  const language = o.language || (existing && existing.language);
  if (language) next.language = language;
  return next;
}

/**
 * The script written beside the manifest, so the project runs without this app.
 *
 * The command is emitted verbatim. Quoting or escaping it would mangle
 * something like python3 -c "print(1)" into a script that fails for a reason
 * nobody could see.
 */
export function renderRunScript(manifest: RunManifest, platform: "win32" | "posix"): string {
  const install = clean(manifest.install);
  const run = clean(manifest.run);
  if (platform === "win32") {
    return [
      "@echo off",
      "REM Generated by CloseNI. Edit the command in the app, or here.",
      install ? install : null,
      run,
      "",
    ].filter(function (l) { return l !== null; }).join("\r\n");
  }
  return [
    "#!/bin/sh",
    "# Generated by CloseNI. Edit the command in the app, or here.",
    "set -e",
    install ? install : null,
    run,
    "",
  ].filter(function (l) { return l !== null; }).join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && node local-agent/test/run-tests.cjs`
Expected: PASS, count up by 22.

- [ ] **Step 5: Commit**

```bash
git add local-agent/src/run-manifest.ts local-agent/test/run-tests.cjs
git commit -m "Give a project a file saying how to run it"
```

---

### Task 4: Write and read the manifest

**Files:**
- Modify: `desktop/main.js`, `desktop/preload.js`, `desktop/builder.js`

**Interfaces:**
- Consumes: `resolveRun`, `mergeManifest`, `renderRunScript`, `MANIFEST_NAME` from Task 3; `detectEntrypoint` from `desktop/entrypoint.js`.
- Produces: IPC `read-manifest` → `RunManifest | null`; IPC `write-manifest` → `{ ok: boolean, error?: string }`.

- [ ] **Step 1: Add the IPC handlers**

The agent's compiled module is reachable from the main process, so there is one
implementation of the rules rather than two. Add to `desktop/main.js`:

```javascript
const RUN = require(path.join(__dirname, "..", "local-agent", "dist", "run-manifest.js"));

function manifestPath(workspace) { return path.join(workspace, RUN.MANIFEST_NAME); }

ipcMain.handle("read-manifest", function (event, workspace) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(workspace), "utf-8"));
  } catch (e) {
    // Absent or corrupt both mean "no manifest". A malformed file must not
    // stop the panel from loading.
    return null;
  }
});

/**
 * Write the manifest and the scripts beside it.
 *
 * The scripts are regenerated every time, so they cannot drift from the
 * manifest the app actually reads.
 */
ipcMain.handle("write-manifest", function (event, payload) {
  try {
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(manifestPath(payload.workspace), "utf-8")); } catch (e) {}
    const merged = RUN.mergeManifest(existing, payload.run, {
      userEdited: !!payload.userEdited,
      install: payload.install,
      language: payload.language,
    });
    fs.writeFileSync(manifestPath(payload.workspace), JSON.stringify(merged, null, 2) + "\n");

    const sh = path.join(payload.workspace, "run.sh");
    fs.writeFileSync(sh, RUN.renderRunScript(merged, "posix"));
    try { fs.chmodSync(sh, 0o755); } catch (e) { /* chmod is meaningless on Windows */ }
    fs.writeFileSync(path.join(payload.workspace, "run.bat"), RUN.renderRunScript(merged, "win32"));

    return { ok: true, manifest: merged };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});
```

- [ ] **Step 2: Expose them**

In `desktop/preload.js`, add to the `exposeInMainWorld` object:

```javascript
  readManifest: function (workspace) { return ipcRenderer.invoke("read-manifest", workspace); },
  writeManifest: function (p) { return ipcRenderer.invoke("write-manifest", p); },
```

- [ ] **Step 3: Write the manifest when a build finishes**

In `desktop/builder.js`, find where the build completes (the point that reports
the final status after the last step) and add:

```javascript
  // The model declared how to run the project while planning; persist it so the
  // answer survives closing the app. An edited command is preserved by
  // mergeManifest, so this cannot undo a correction.
  const plan = CN.getPlan();
  if (plan && CN.getWorkspace()) {
    const detected = window.CNEntry
      ? window.CNEntry.detectEntrypoint(await CN.listFiles(CN.getWorkspace()), null, null, window.api.platform)
      : null;
    const chosen = plan.runCommand || detected;
    if (chosen) await window.api.writeManifest({ workspace: CN.getWorkspace(), run: chosen });
  }
```

Read the surrounding function before editing and match its existing names for
the plan and workspace accessors rather than assuming these.

- [ ] **Step 4: Verify**

Run: `source scripts/wsl-env.sh && node --check desktop/main.js && node --check desktop/builder.js && node --check desktop/preload.js && node local-agent/test/run-tests.cjs`
Expected: no syntax errors, PASS with the same count as Task 3.

Run: `cd desktop && npm start`, build a small project, then:

```bash
cat <workspace>/closeni.run.json && ls -l <workspace>/run.sh
```

Expected: the manifest holds the command, and `run.sh` is executable.

- [ ] **Step 5: Commit**

```bash
git add desktop/main.js desktop/preload.js desktop/builder.js
git commit -m "Write the run manifest when a build finishes"
```

---

### Task 5: The Test panel

**Files:**
- Modify: `desktop/index.html` (`#panel-test`), `desktop/renderer.js`, `desktop/styles.css`

**Interfaces:**
- Consumes: `readManifest` / `writeManifest` from Task 4, `resolveRun` semantics from Task 3.
- Produces: `refreshRunBar()` in the renderer.

- [ ] **Step 1: Replace the panel markup**

In `desktop/index.html`, replace the whole `#panel-test` section:

```html
<section id="panel-test" class="panel">
  <div id="run-bar">
    <div class="run-row">
      <span class="micro">Run</span>
      <input id="test-cmd" class="mono" placeholder="no run command yet - type one, or build a project">
      <button id="test-run" class="btn invert">Run</button>
    </div>
    <div class="run-row run-meta">
      <span id="run-source" class="run-badge"></span>
      <span id="run-hint" class="hint"></span>
      <span class="run-spacer"></span>
      <button id="test-check" class="btn btn-sm">Syntax-check all</button>
    </div>
  </div>

  <div id="test-view">
    <div id="test-output-col">
      <div class="micro">Output</div>
      <div id="test-summary" class="micro"></div>
      <div id="test-results"></div>
      <div id="test-history-label" class="micro">Earlier</div>
      <div id="test-history"></div>
    </div>
    <div id="test-chat-col">
      <div class="micro">Ask about this run</div>
      <div id="test-chat-flow"></div>
      <div id="test-chat-bar">
        <input id="test-chat-input" placeholder="Ask anything about this run...">
        <button id="test-chat-send" class="btn invert">Send</button>
      </div>
    </div>
  </div>
</section>
```

- [ ] **Step 2: Wire the run bar**

Append to `desktop/renderer.js`:

```javascript
/**
 * The run bar.
 *
 * The manifest wins, then the plan, then filename detection - and the badge
 * says which, because "from your plan" and "detected from main.py" are
 * different levels of confidence.
 */
let runSource = "none";

async function refreshRunBar() {
  const box = $("test-cmd");
  const badge = $("run-source");
  const hint = $("run-hint");
  if (!box || !workspace) return;

  const manifest = await window.api.readManifest(workspace).catch(function () { return null; });
  const plan = currentPlan;
  let files = [];
  try { files = await window.api.listFiles(workspace); } catch (e) {}
  const detected = window.CNEntry
    ? window.CNEntry.detectEntrypoint(files, null, null, window.api.platform)
    : null;

  let command = null;
  if (manifest && String(manifest.run || "").trim()) { command = manifest.run.trim(); runSource = "manifest"; }
  else if (plan && String(plan.runCommand || "").trim()) { command = plan.runCommand.trim(); runSource = "plan"; }
  else if (detected) { command = detected; runSource = "detected"; }
  else { runSource = "none"; }

  box.value = command || "";
  const labels = {
    manifest: ["SAVED", "from closeni.run.json - edit it here and it sticks"],
    plan: ["FROM YOUR PLAN", "the model declared this while planning"],
    detected: ["DETECTED", "guessed from the files in this workspace"],
    none: ["NOT FOUND", "type a command, or build a project and one will be saved"],
  };
  badge.textContent = labels[runSource][0];
  badge.className = "run-badge " + runSource;
  hint.textContent = labels[runSource][1];
}

// Editing the command saves it, and marks it so no later build overwrites it.
$("test-cmd").onchange = async function () {
  const cmd = $("test-cmd").value.trim();
  if (!cmd || !workspace) return;
  await window.api.writeManifest({ workspace: workspace, run: cmd, userEdited: true });
  await refreshRunBar();
  toast("Run command saved");
};
```

Call it when the panel opens by extending `switchTab`:

```javascript
  if (mode === "test") refreshRunBar();
```

- [ ] **Step 3: Keep a short history**

Replace `renderTestResults` so earlier runs are not lost:

```javascript
const testHistory = [];

function pushHistory(label, ok) {
  testHistory.unshift({ label: label, ok: ok });
  testHistory.splice(6);   // a short list, not a log
  const box = $("test-history");
  if (!box) return;
  box.innerHTML = "";
  testHistory.forEach(function (h) {
    const row = document.createElement("div");
    row.className = "test-row " + (h.ok ? "pass" : "fail");
    row.innerHTML = '<span class="cmd">' + escapeHtml(h.label) + '</span>' +
      '<span class="verdict">' + (h.ok ? "passed" : "failed") + "</span>";
    box.appendChild(row);
  });
  $("test-history-label").style.display = testHistory.length ? "" : "none";
}
```

Call `pushHistory(cmd, r && r.success)` at the end of each of the three existing
handlers — `test-run`, `test-run-project` and `test-check`.

- [ ] **Step 4: Style it**

Append to `desktop/styles.css`. Tokens only — the lint rejects colour literals:

```css
#run-bar{border:1px solid var(--line);border-radius:var(--r-lg);background:var(--panel);padding:var(--sp-4) var(--sp-5);}
.run-row{display:flex;align-items:center;gap:var(--sp-3);}
.run-row .micro{margin-bottom:0;flex:none;}
#test-cmd{flex:1;}
.run-meta{margin-top:var(--sp-3);}
.run-spacer{flex:1;}
.run-badge{font-size:9px;letter-spacing:.1em;text-transform:uppercase;padding:2px 6px;
  border-radius:var(--r-sm);border:1px solid var(--line-strong);color:var(--mut);}
.run-badge.manifest,.run-badge.plan{color:var(--ok);background:var(--ok-bg);border-color:var(--ok-line);}
.run-badge.detected{color:var(--warn);background:var(--warn-bg);border-color:var(--warn-line);}
.run-badge.none{color:var(--err);background:var(--err-bg);border-color:var(--err-line);}

#test-view{display:flex;gap:var(--sp-5);flex:1;min-height:0;}
#test-output-col{flex:1.35;display:flex;flex-direction:column;min-width:0;overflow-y:auto;
  border:1px solid var(--line);border-radius:var(--r-lg);background:var(--panel);padding:var(--sp-4) var(--sp-5);}
#test-chat-col{flex:1;display:flex;flex-direction:column;min-width:0;
  border:1px solid var(--line);border-radius:var(--r-lg);background:var(--panel);padding:var(--sp-4) var(--sp-5);}
#test-chat-flow{flex:1;overflow-y:auto;margin-bottom:var(--sp-3);}
#test-chat-bar{display:flex;gap:var(--sp-3);}
#test-chat-input{flex:1;}
#test-history-label{margin-top:var(--sp-5);display:none;}
```

- [ ] **Step 5: Verify**

Run: `source scripts/wsl-env.sh && node --check desktop/renderer.js && node local-agent/test/run-tests.cjs`
Expected: PASS. The css lint catches any literal above.

Run: `cd desktop && npm start` and check: the Test panel shows a run bar with a
badge; editing the command and pressing Enter saves it and the badge becomes
`SAVED`; restarting keeps it; running twice leaves the first in **Earlier**.

- [ ] **Step 6: Commit**

```bash
git add desktop/index.html desktop/renderer.js desktop/styles.css
git commit -m "Give Test a run bar that knows what to run"
```

---

### Task 6: Ask about this run

**Files:**
- Modify: `local-agent/src/index.ts` (`StepRequest`, `runBuildStep`, new `askMode`, arg parsing), `desktop/main.js`, `desktop/preload.js`, `desktop/renderer.js`

**Interfaces:**
- Consumes: `runBuildStep`, `StepOutcome` (which already carries `raw`).
- Produces: agent mode `ask <workspace> <provider> <question> <command> <output>`; IPC `ask-run` → `{ success, answer?, appliedFiles?, error? }`.

- [ ] **Step 1: Let a reply be prose**

`runBuildStep` currently returns `{ success: false, error: "No file changes
found in AI response.", raw: response }` when a reply contains no files. For a
question that is the **normal** case, not a failure.

In `local-agent/src/index.ts`, add to `StepRequest`:

```typescript
  /** A question may legitimately be answered in prose. Without this, a reply
   *  with no file changes is reported as a failure. */
  allowNoChanges?: boolean;
```

Then change the no-changes branch:

```typescript
      if (req.allowNoChanges) return { success: true, appliedFiles: [], raw: response };
      return { success: false, error: "No file changes found in AI response.", raw: response };
```

- [ ] **Step 2: Add the mode**

```typescript
/**
 * Answer a question about a run, and apply a fix if one is offered.
 *
 * The command and its output travel with the question, so nobody has to paste a
 * traceback. It reuses the build thread for the same reason suggestMode does: a
 * fresh chat would answer confidently with none of the project in view.
 */
async function askMode(workspace: string, providerId: string, question: string, command: string, output: string) {
  const registry = new ProviderRegistry();
  registry.loadProviders();
  const config = registry.getProvider(providerId);
  if (!config) { emit({ success: false, error: "Provider not found: " + providerId }); return; }

  const controller = new PlaywrightController(config);
  controller.setWorkspace(workspace);
  controller.setThreadKind("build");

  if (!controller.getBuildThreadUrl()) {
    emit({ success: false, error: "No build thread for this workspace. Build a project before asking about a run." });
    return;
  }

  await controller.launch(config);
  try {
    const resumed = await controller.navigateToBuildThread(config);
    if (!resumed) {
      emit({ success: false, error: "The build thread could not be reopened, so there is no context to answer against." });
      return;
    }
    await controller.waitForLogin();

    const detail =
      "The user ran this command against the project you built:\n\n" +
      "$ " + command + "\n\n" + capText(output, 4000) +
      "\n\nTheir question: " + question +
      "\n\nAnswer plainly. If a file change would fix it, reply with the JSON file-change format " +
      "using mode \"overwrite\" and full file contents. If no change is needed, just explain - do not invent one.";

    const outcome = await runBuildStep(controller, config, {
      prompt: question,
      workspace: workspace,
      autonomy: "auto",
      stepIndex: 0,
      stepDetail: detail,
      goalSummary: "",
      allowNoChanges: true,
    });
    emit({
      success: outcome.success,
      answer: outcome.raw || "",
      appliedFiles: outcome.appliedFiles || [],
      error: outcome.error,
    });
  } finally {
    await controller.close();
  }
}
```

Register it in the argument dispatch beside the other modes:

```typescript
  } else if (mode === "ask") {
    await askMode(args[1], args[2], args[3], args[4] || "", args[5] || "");
```

- [ ] **Step 3: Spawn it**

In `desktop/main.js`, beside the `suggest` handler:

```javascript
ipcMain.handle("ask-run", function (event, payload) {
  return new Promise(function (resolve) {
    let proc;
    try {
      proc = spawnAgent(["ask", payload.workspace, payload.provider, payload.question,
        payload.command || "", payload.output || ""], agentEnv(payload.headed ? "1" : "0", payload.controls));
    } catch (e) { resolve({ success: false, error: String(e) }); return; }
    agentProc = proc;
    let output = "";
    proc.stdout.on("data", function (d) { output += d.toString(); routeChunk(d.toString()); });
    proc.stderr.on("data", function (d) { routeChunk(d.toString()); });
    proc.on("close", function () {
      const m = output.match(/AGENT_OUTPUT_START\s*([\s\S]*?)\s*AGENT_OUTPUT_END/);
      try { resolve(JSON.parse(m ? m[1] : output)); }
      catch (e) { resolve({ success: false, error: "Could not read the agent's reply." }); }
    });
  });
});
```

Match the existing handlers' line-routing helper name rather than assuming
`routeChunk` — read the `suggest` handler and reuse whatever it uses.

In `desktop/preload.js`:

```javascript
  askRun: function (p) { return ipcRenderer.invoke("ask-run", p); },
```

- [ ] **Step 4: Wire the chat**

Append to `desktop/renderer.js`:

```javascript
// The last run, carried automatically so nobody pastes a traceback into a box
// sitting directly beneath that same traceback.
let lastRun = { command: "", output: "" };

function addTestMsg(who, text) {
  const flow = $("test-chat-flow");
  if (!flow) return null;
  const wrap = document.createElement("div");
  wrap.className = "msg " + who;
  const label = document.createElement("span");
  label.className = "msg-label";
  label.textContent = who === "user" ? "you" : "ai";
  const body = document.createElement("div");
  body.className = "msg-text";
  if (who === "ai" && text && text.length > 40) body.innerHTML = renderMarkdown(text);
  else body.textContent = text;
  wrap.appendChild(label); wrap.appendChild(body);
  flow.appendChild(wrap);
  flow.scrollTop = flow.scrollHeight;
  return body;
}

$("test-chat-send").onclick = async function () {
  const input = $("test-chat-input");
  const q = input.value.trim();
  if (!q) return;
  if (!workspace) { toast("Pick a workspace", "err"); return; }
  input.value = "";
  addTestMsg("user", q);
  const pending = addTestMsg("ai", "thinking...");
  const r = await window.api.askRun({
    workspace: workspace, provider: provider, question: q,
    command: lastRun.command, output: lastRun.output,
    headed: $("show-browser") ? $("show-browser").checked : false,
    controls: desiredControls(),
  });
  if (r && r.success) {
    pending.innerHTML = renderMarkdown(r.answer || "(no answer)");
    if (r.appliedFiles && r.appliedFiles.length) {
      const note = document.createElement("div");
      note.className = "hint";
      note.style.marginTop = "8px";
      note.textContent = "Applied: " + r.appliedFiles.join(", ");
      pending.appendChild(note);
      toast(r.appliedFiles.length + " file(s) changed");
    }
  } else {
    pending.textContent = (r && r.error) || "Could not get an answer.";
  }
};
$("test-chat-input").addEventListener("keydown", function (e) {
  if (e.key === "Enter") { e.preventDefault(); $("test-chat-send").onclick(); }
});
```

Record each run by adding this line to the end of the `test-run`,
`test-run-project` and `test-check` handlers:

```javascript
  lastRun = { command: cmd, output: (r && r.output) || "" };
```

For `test-check`, which has no single command, use
`lastRun = { command: "syntax check", output: JSON.stringify(res && res.results || []) };`.

- [ ] **Step 5: Verify**

Run: `source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && node --check desktop/renderer.js && node --check desktop/main.js && node local-agent/test/run-tests.cjs`
Expected: PASS.

Run: `cd desktop && npm start`. Build a project, run it, ask "why did this
fail?" in the Test chat. Expected: a prose answer appears — **the case that
previously displayed nothing at all.** If the reply proposes a fix, the applied
files are listed.

- [ ] **Step 6: Commit**

```bash
git add local-agent/src/index.ts desktop/main.js desktop/preload.js desktop/renderer.js
git commit -m "Let the Test panel answer questions about a run"
```

---

### Task 7: Frontend preview

**Files:**
- Create: `desktop/preview-target.js`
- Modify: `desktop/index.html`, `desktop/builder.js`, `desktop/styles.css`
- Test: `local-agent/test/run-tests.cjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `previewTarget(output: string, files: string[]): { url: string, kind: "server" | "file" } | null`

- [ ] **Step 1: Write the failing test**

Add to `local-agent/test/run-tests.cjs`, above `function testToolchain()`:

```javascript
function testPreviewTarget() {
  section("preview target");
  const { previewTarget } = require(path.join(__dirname, "..", "..", "desktop", "preview-target.js"));

  // Real output from the servers these projects actually produce.
  const flask = " * Running on http://127.0.0.1:5000\n * Press CTRL+C to quit";
  check("a flask url is found", previewTarget(flask, []).url === "http://127.0.0.1:5000");
  check("and is a server", previewTarget(flask, []).kind === "server");
  const vite = "  VITE v5.0.0  ready in 300 ms\n  ➜  Local:   http://localhost:5173/";
  check("a vite url is found", previewTarget(vite, []).url === "http://localhost:5173/");
  const py = "Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...";
  check("a python http.server url is found", previewTarget(py, []).url.indexOf("8000") !== -1);
  // The last url wins: a server that reprints its address should not pin the
  // preview to the first line it ever wrote.
  check("the last url wins",
    previewTarget("http://localhost:1111\nhttp://localhost:2222", []).url === "http://localhost:2222");

  // No server: a static page is the next best thing.
  check("index.html is used when there is no url",
    previewTarget("", ["index.html"]).kind === "file");
  check("and points at the file", previewTarget("", ["index.html"]).url.indexOf("index.html") !== -1);
  check("a nested index.html is found", previewTarget("", ["public/index.html"]).url.indexOf("public/index.html") !== -1);
  check("a root index.html beats a nested one",
    previewTarget("", ["public/index.html", "index.html"]).url.indexOf("public") === -1);

  // Nothing to show means the toggle hides, rather than an empty frame.
  check("no url and no html yields nothing", previewTarget("", ["main.py"]) === null);
  check("empty input is survivable", previewTarget("", []) === null);
  check("missing input is survivable", previewTarget(null, null) === null);
  // A url in a traceback is not a server.
  check("an https doc link is ignored",
    previewTarget("see https://docs.python.org/3/", []) === null);
}
```

Register it in `main()`:

```javascript
  testRunManifest();
  testPreviewTarget();
  testBrowserCheck();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: FAIL — `Cannot find module '.../desktop/preview-target.js'`

- [ ] **Step 3: Write the implementation**

Create `desktop/preview-target.js`:

```javascript
/*
 * What should the preview show?
 *
 * Loaded as a plain <script> in the renderer (window.CNPreview) and require()d
 * by the test harness. There is no bundler, so no import/export.
 *
 * Only local addresses count. A documentation link in a traceback is not a
 * server, and pointing the preview at the open internet is not what anyone
 * asked for.
 */
(function (root) {
  var LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s"'<>)\]]*/g;

  function previewTarget(output, files) {
    var text = String(output || "");
    var urls = text.match(LOCAL_URL);
    if (urls && urls.length) {
      // The last one wins: a server that reprints its address as it restarts
      // should not pin the preview to the first line it ever wrote.
      return { url: urls[urls.length - 1], kind: "server" };
    }

    var list = files || [];
    var root_ = null;
    var nested = null;
    for (var i = 0; i < list.length; i++) {
      var p = String(list[i]).replace(/\\/g, "/");
      if (p === "index.html") root_ = p;
      else if (/(^|\/)index\.html$/.test(p) && !nested) nested = p;
    }
    var pick = root_ || nested;
    return pick ? { url: pick, kind: "file" } : null;
  }

  var api = { previewTarget: previewTarget };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNPreview = api;
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Add the sandboxed webview**

In `desktop/index.html`, add the script beside the other UMD modules:

```html
<script src="browser-check.js"></script>
<script src="preview-target.js"></script>
```

Add a toggle to the Builder toolbar, after `#builder-status`:

```html
<button id="builder-preview" class="btn is-hidden">Preview</button>
```

And a preview pane inside `#builder-view`, after `#builder-main`:

```html
<div id="preview-pane" class="is-hidden">
  <div id="preview-head">
    <span class="micro">Preview</span>
    <span id="preview-url" class="hint"></span>
    <button id="preview-close" class="btn btn-sm">Close</button>
  </div>
  <!-- This renders code an AI wrote. nodeintegration off, contextIsolation on,
       and its own partition so a generated page cannot reach Electron APIs or
       the session cookies belonging to the user's provider logins. -->
  <webview id="preview-frame" partition="persist:closeni-preview"
           nodeintegration="false" webpreferences="contextIsolation=yes"></webview>
</div>
```

Enable webviews in `desktop/main.js`, in the `BrowserWindow` `webPreferences`:

```javascript
      webviewTag: true,
```

- [ ] **Step 5: Wire the toggle**

Append to `desktop/builder.js`:

```javascript
// Only offer a preview when there is genuinely something to show. An empty
// frame is worse than no button.
function updatePreviewButton(runOutput, files) {
  const btn = document.getElementById("builder-preview");
  if (!btn || !window.CNPreview) return;
  const target = window.CNPreview.previewTarget(runOutput || "", files || []);
  btn.classList.toggle("is-hidden", !target);
  btn.dataset.url = target ? target.url : "";
  btn.dataset.kind = target ? target.kind : "";
}

document.getElementById("builder-preview").onclick = function () {
  const btn = document.getElementById("builder-preview");
  const pane = document.getElementById("preview-pane");
  const frame = document.getElementById("preview-frame");
  if (!btn.dataset.url) return;
  const url = btn.dataset.kind === "file"
    ? "file://" + CN.getWorkspace() + "/" + btn.dataset.url
    : btn.dataset.url;
  frame.src = url;
  document.getElementById("preview-url").textContent = url;
  pane.classList.remove("is-hidden");
};

document.getElementById("preview-close").onclick = function () {
  document.getElementById("preview-pane").classList.add("is-hidden");
  document.getElementById("preview-frame").src = "about:blank";
};
```

Call `updatePreviewButton(r && r.output, files)` from the `test-run-project`
handler in `renderer.js`, after the run completes.

- [ ] **Step 6: Style it**

```css
#preview-pane{width:46%;min-width:320px;display:flex;flex-direction:column;
  border:1px solid var(--line);border-radius:var(--r-lg);background:var(--panel);overflow:hidden;}
#preview-pane.is-hidden{display:none;}
#preview-head{display:flex;align-items:center;gap:var(--sp-3);padding:var(--sp-3) var(--sp-4);
  border-bottom:1px solid var(--line);}
#preview-head .micro{margin-bottom:0;flex:none;}
#preview-url{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#preview-frame{flex:1;border:none;background:var(--surface-sunken);}
```

- [ ] **Step 7: Verify**

Run: `source scripts/wsl-env.sh && node --check desktop/preview-target.js && node --check desktop/builder.js && node local-agent/test/run-tests.cjs`
Expected: PASS, count up by 13.

Run: `cd desktop && npm start`. Build a static page, Run Project, and confirm
the Preview button appears and renders it. Then confirm the isolation holds — in
the webview's devtools console:

```javascript
typeof require
```

Expected: `"undefined"`. **If this prints `"function"`, node integration is
still on and the task is not done** — a generated page would have filesystem
access.

- [ ] **Step 8: Commit**

```bash
git add desktop/preview-target.js desktop/index.html desktop/builder.js desktop/main.js desktop/styles.css local-agent/test/run-tests.cjs
git commit -m "Preview a built frontend in a sandboxed webview"
```

---

### Task 8: Pixel motion

**Files:**
- Modify: `desktop/styles.css`, `desktop/builder.js`

**Interfaces:**
- Consumes: the `--dur-*` tokens and `data-decor` from the visual-identity work.
- Produces: classes `.pix-stamp`, `.pix-flicker`, `.pix-spin`, and a stepped progress bar.

**Nothing animates while the app is idle.** Ambient motion was reviewed and
rejected; this only fires on events.

- [ ] **Step 1: Add the keyframes**

Append to `desktop/styles.css`. `steps()` is the whole technique — a linear
transition reads as modern UI, a stepped one reads as a sprite:

```css
/* Pixel motion. Event-driven only: each of these fires when something happens
   and then stops. Nothing here runs on an idle screen. */
@keyframes pix-stamp{
  0%{transform:scale(0);opacity:0;} 100%{transform:scale(1);opacity:1;}
}
@keyframes pix-flicker{
  0%,100%{opacity:1;} 25%,75%{opacity:.25;} 50%{opacity:1;}
}
@keyframes pix-spin{
  0%{content:"|";} 25%{content:"/";} 50%{content:"-";} 75%{content:"\\";}
}

/* steps() is what makes it pixel rather than smooth. */
.pix-stamp{animation:pix-stamp .24s steps(4) 1;}
.pix-flicker{animation:pix-flicker .36s steps(2) 2;}
.pix-spin::after{display:inline-block;width:1ch;content:"|";
  animation:pix-spin .6s steps(4) infinite;}

/* The progress bar advances in chunks rather than sliding. */
#builder-progress{transition:width var(--dur-slow) steps(12);}

/* Both switches still turn everything off. */
[data-decor="off"] .pix-stamp,
[data-decor="off"] .pix-flicker,
[data-decor="off"] .pix-spin::after{animation:none;}
@media (prefers-reduced-motion: reduce){
  .pix-stamp,.pix-flicker,.pix-spin::after{animation:none;}
}
```

- [ ] **Step 2: Fire them on events**

In `desktop/builder.js`, where a step's status chip is rendered, add the class
for the state that just changed:

```javascript
  // The chip stamps in when a step finishes and flickers when it fails, so a
  // change is visible without watching the list.
  if (s.status === "done") statusEl.classList.add("pix-stamp");
  else if (s.status === "failed") statusEl.classList.add("pix-flicker");
  else if (s.status === "running") statusEl.classList.add("pix-spin");
```

Match the surrounding code's variable name for the status element rather than
assuming `statusEl` — read the function first.

- [ ] **Step 3: Verify**

Run: `source scripts/wsl-env.sh && node --check desktop/builder.js && node local-agent/test/run-tests.cjs`
Expected: PASS. The css lint catches any colour literal.

Run: `cd desktop && npm start`. Run a build and watch the step list: a finished
step stamps in, a running one has a blocky spinner, a failed one flickers twice
and settles. Then Settings → Appearance → uncheck **Texture & glow**: all of it
stops. **An idle screen must be completely still.**

- [ ] **Step 4: Commit**

```bash
git add desktop/styles.css desktop/builder.js
git commit -m "Mark events with pixel motion, and only events"
```

---

### Task 9: Documentation and merge

**Files:**
- Modify: `README.md`, `docs/ROADMAP.md`

- [ ] **Step 1: Document the run file**

Add to `README.md` after the install section:

```markdown
## The run file

Every project CloseNI builds gets a `closeni.run.json` describing how to start
it, plus `run.sh` and `run.bat` generated from it. The app writes them at the end
of a build, from the command the model declared while planning.

Open the project again — tomorrow, or on another machine — and the Test panel
already knows what to run. Edit the command in the panel and it is saved back;
later builds will not overwrite an edited command.
```

- [ ] **Step 2: Record the sub-project**

Add to `docs/ROADMAP.md` after sub-project 9:

```markdown
## 10 · Run & test experience — DONE

Not in the original 28. Added after using the app: a built project gave no
indication of how to run it. Spec: `specs/2026-08-10-run-and-test-flow-design.md`,
plan: `plans/2026-08-10-run-and-test-flow.md`

- **Run manifest** — `closeni.run.json` plus `run.sh`/`run.bat`, written by the
  app from the command the model declares while planning. The app writes it
  rather than the model, because a model that forgets is a failure mode this
  project has already hit. An edited command is never overwritten.
- **Test panel** — a run bar showing the command and where it came from, output
  with history, and a chat that carries the last run with it.
- **Ask about this run** — answers questions in the build thread and can apply
  fixes through the existing patch pipeline. A prose answer is now a success;
  previously a reply with no file changes displayed nothing at all.
- **Plan length follows the work** — `"Rules: 3-8 steps"` was hardcoded in two
  places and silently compressed larger projects into eight. The cap is now
  guidance, bounded at 40, which **rejects rather than truncates**.
- **Code quality directives** in the build prompt — error handling, docstrings,
  efficiency, and keeping dependency files in step with imports.
- **Frontend preview** in a `<webview>` with its own partition and node
  integration off, because it renders AI-written code and the default partition
  holds live provider session cookies.
- **Pixel motion on events only** — `steps()` timing on step completion, test
  results and progress. Nothing animates on an idle screen; ambient motion
  stays rejected.
```

- [ ] **Step 3: Run the full suite**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json \
  && node local-agent/test/run-tests.cjs \
  && node local-agent/test/run-e2e.cjs > /tmp/e2e.log 2>&1; tail -3 /tmp/e2e.log
```

Expected: both PASS, e2e still 150. A drop means the prompt changes in Tasks 1
or 2 regressed parsing — shrink the quality block.

- [ ] **Step 4: Commit and merge**

```bash
git add -A
git commit -m "Document the run file"
git checkout main && git merge --no-ff run-and-test-flow -m "Merge run and test flow"
git push origin main
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Step count follows the work | 1 |
| Bound rejects rather than truncates | 1 |
| Duration estimate | 1 (`estimateDuration`), surfaced in 5 |
| Quality directives, placed last | 2 |
| Plan declares `runCommand` | 1 (prompt), 3 (resolution) |
| Manifest + scripts on disk | 3, 4 |
| App writes it, not the model | 4 |
| `userEdited` survives a rebuild | 3 (logic), 5 (set on edit) |
| Resolution order with `source` | 3, 5 |
| Run bar, output, history | 5 |
| Chat carries the run | 6 |
| Chat reuses the build thread | 6 |
| Prose answer is a success | 6 Step 1 |
| Fixes go through the existing pipeline | 6 |
| Preview target order | 7 |
| Sandboxed webview | 7 Steps 4, 7 |
| Pixel motion on events only | 8 |
| Behind reduced-motion and `data-decor` | 8 |

**Gap found and closed:** the spec says the plan sidebar shows a duration
estimate, but `estimateDuration` had no consumer. Task 5 was the wrong home —
it belongs where the plan is rendered. Add to Task 1 Step 5 a call in
`renderer.js`'s plan renderer:
`"~" + plan.steps.length + " steps · " + CNScale.estimateDuration(plan.steps.length)`.
Since `plan-scale.ts` compiles to the agent's `dist`, the renderer reads it the
same way `desktop/main.js` reads `run-manifest.js` in Task 4 — via
`require(path.join(__dirname, "..", "local-agent", "dist", "plan-scale.js"))`
in the main process, exposed through an IPC call, or duplicated as a four-line
UMD helper in `desktop/`. **Prefer the UMD helper**: the renderer has no
`require`, and one arithmetic function is not worth an IPC round trip.

**Type consistency:** `resolveRun`, `mergeManifest`, `renderRunScript`,
`MANIFEST_NAME`, `RunManifest`, `RunResolution`, `previewTarget`,
`estimateDuration`, `MAX_PLAN_STEPS` and `allowNoChanges` are used identically
across tasks. `runSource` in Task 5 uses the same four values as
`RunResolution.source` in Task 3.

**Known risks:**

1. **Task 2 can regress parsing.** It is the only task whose gate is the e2e
   suite rather than a unit test, and the remedy is written into the task:
   shrink the block.
2. **Three tasks edit code whose surrounding names I have not read** — Task 4
   Step 3 (build completion), Task 6 Step 3 (line routing), Task 8 Step 2
   (status element). Each says to read first rather than assume.
3. **Nothing here proves the panel looks right or the motion reads as pixel
   art.** Those need the app run by a person, and each task ends with what to
   check.
