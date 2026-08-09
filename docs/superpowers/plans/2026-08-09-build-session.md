# Build Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open the browser once per build instead of once per step.

**Architecture:** A new `build-session` mode keeps one process, one browser and one chat thread alive for a whole build, taking steps as newline-delimited JSON on stdin and replying with events on stdout. The per-step work is extracted from `buildMode` into a single function both modes call, so the existing one-shot path stays byte-identical and remains the fallback. `builder.js` keeps owning the step loop — it opens a session, sends one step per iteration, and closes it — so pause, skip and stop keep working exactly as they do today.

**Tech Stack:** TypeScript (ES2020, CommonJS via `tsc`), Node 24, Playwright, Electron IPC, plain-CJS test harness.

## Global Constraints

- All source is TypeScript under `local-agent/src/`, compiled by `npx tsc -p local-agent/tsconfig.json` to `local-agent/dist/`. Tests run against `dist/`, so **every test run must be preceded by a build**.
- Tests use the existing harness helpers `section(name)` and `check(name, condition, extra)`. No test framework.
- Run the full suite with `cd local-agent && npm run test:all` before every commit. It must stay green: currently **81 unit + 88 end-to-end**.
- Never run two e2e suites at once, and check with `ps -eo args= | grep run-e2e.cjs` rather than `pgrep -f`, which matches the checking command itself.
- On WSL, `source scripts/wsl-env.sh` first.
- **The one-shot `browser` mode must keep working unchanged.** It is the fallback when a session cannot start, and every existing e2e test exercises it.
- **Pause, skip and stop are between-step operations today.** `builder.js` checks them before starting each step; none interrupt a running step. Preserve that contract — do not add mid-step interruption.

---

### Task 1: Extract the per-step work

Pull the body of a build step out of `buildMode` so a session can call it repeatedly. Pure refactor: no behaviour change, no new tests, the existing suite is the safety net.

**Files:**
- Modify: `local-agent/src/index.ts` — `buildMode`

**Interfaces:**
- Produces:
  ```typescript
  interface StepRequest {
    prompt: string; workspace: string; autonomy: string;
    stepIndex: number; stepDetail: string; goalSummary: string;
  }
  interface StepOutcome { success: boolean; appliedFiles?: string[]; error?: string; lastError?: string; raw?: string }
  async function runBuildStep(controller: PlaywrightController, config: ProviderConfig, req: StepRequest): Promise<StepOutcome>
  ```

- [ ] **Step 1: Move the body**

Everything in `buildMode` from the workspace scan through the retry loop becomes `runBuildStep`, taking an already-open `controller` and `config`. It **returns** its outcome instead of calling `emit`, and does not open or close the browser.

`buildMode` becomes:

```typescript
async function buildMode(prompt: string, workspace: string, providerId: string, autonomy: string, stepIndex: number, stepDetail: string, goalSummary: string) {
  const { controller, config } = await openProviderForBuild(providerId, workspace, stepIndex <= 0);
  try {
    const outcome = await runBuildStep(controller, config, {
      prompt, workspace, autonomy, stepIndex, stepDetail, goalSummary,
    });
    emit(outcome);
  } finally {
    await controller.close();
  }
}
```

- [ ] **Step 2: Verify nothing changed**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:all
```

Expected: PASS — 81 unit, 88 e2e, unchanged. A pure refactor that moves tests is a failed refactor.

- [ ] **Step 3: Commit**

```bash
git add local-agent/src/index.ts
git commit -m "Extract runBuildStep so a session can reuse it"
```

---

### Task 2: The build-session mode

**Files:**
- Modify: `local-agent/src/index.ts` — new `buildSessionMode`, new arg branch in `main()`
- Test: `local-agent/test/run-e2e.cjs`

**Interfaces:**
- Consumes: `runBuildStep`, `openProviderForBuild` (Task 1).
- Produces: mode `build-session <workspace> <provider> [autonomy]`.
  - stdin, one JSON object per line: `{"type":"step","index":n,"detail":"...","goal":"...","prompt":"..."}` and `{"type":"close"}`
  - stdout, one JSON object per line, each prefixed `SESSION_EVENT: `
    - `{"type":"ready"}` once the browser and thread are open
    - `{"type":"step-result","index":n,"success":bool,"appliedFiles":[...],"error":"..."}`
    - `{"type":"closed"}`
  - Human-readable logs keep going to stdout unprefixed, so the existing renderer log parsing is unaffected.

- [ ] **Step 1: Write the failing test**

Add to `run-e2e.cjs` before the final `await mock.close();`:

```javascript
  // ----------------------------------- one browser for a whole build, not one per step
  section("build session opens the browser once");
  {
    const ws = mkWorkspace();
    mock.resetThreads();
    mock.setReplies([F + 'json\n{"files":[{"path":"src/s.js","mode":"create","content":"module.exports = {};\\n"}]}\n' + F]);

    const proc = require("child_process").spawn(
      process.execPath,
      [AGENT, "build-session", ws, "mock", "auto"],
      { cwd: path.join(__dirname, "..", ".."), env: { ...process.env, AGENT_PROVIDER_DIR: PROVIDER_DIR } }
    );
    let out = "";
    const results = [];
    proc.stdout.on("data", (d) => {
      out += d.toString();
      for (const line of d.toString().split(/\r?\n/)) {
        const m = line.match(/^SESSION_EVENT: (.*)$/);
        if (m) { try { results.push(JSON.parse(m[1])); } catch { /* ignore */ } }
      }
    });
    proc.stderr.on("data", (d) => (out += d.toString()));

    const waitFor = (pred, ms) => new Promise((res) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (pred() || Date.now() - t0 > ms) { clearInterval(iv); res(pred()); }
      }, 200);
    });

    const ready = await waitFor(() => results.some((r) => r.type === "ready"), 90000);
    check("session reports ready", ready, out.slice(-300));

    for (let i = 0; i < 3; i++) {
      mock.setReplies([F + 'json\n{"files":[{"path":"src/s' + i + '.js","mode":"create","content":"module.exports = { i: ' + i + ' };\\n"}]}\n' + F]);
      const detail = "Execute ONLY this step: step " + i + ". Expected files: src/s" + i + ".js";
      proc.stdin.write(JSON.stringify({ type: "step", index: i, detail: detail, goal: "goal", prompt: detail }) + "\n");
      const got = await waitFor(() => results.some((r) => r.type === "step-result" && r.index === i), 120000);
      check("step " + i + " returns a result", got, out.slice(-400));
    }

    proc.stdin.write(JSON.stringify({ type: "close" }) + "\n");
    await waitFor(() => proc.exitCode !== null, 30000);

    const launches = (out.match(/Launching browser/g) || []).length;
    check("browser launched exactly once for three steps", launches === 1, "launches: " + launches);
    check("all three steps succeeded", results.filter((r) => r.type === "step-result" && r.success).length === 3, JSON.stringify(results.filter((r) => r.type === "step-result")));
    check("all three files exist", [0, 1, 2].every((i) => fs.existsSync(path.join(ws, "src/s" + i + ".js"))));

    try { proc.kill(); } catch { /* already gone */ }
    fs.rmSync(ws, { recursive: true, force: true });
  }
```

- [ ] **Step 2: Run to verify it fails**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:e2e
```

Expected: FAIL — `session reports ready` times out, because the mode does not exist.

- [ ] **Step 3: Implement the mode**

Add to `index.ts`:

```typescript
function sessionEvent(payload: any) {
  console.log("SESSION_EVENT: " + JSON.stringify(payload));
}

/**
 * One process, one browser, one thread for a whole build. Steps arrive on stdin
 * as newline-delimited JSON. The caller keeps owning the step loop, so pause,
 * skip and stop stay exactly as they are — this only removes the per-step
 * browser launch.
 */
async function buildSessionMode(workspace: string, providerId: string, autonomy: string) {
  const { controller, config } = await openProviderForBuild(providerId, workspace, true);
  sessionEvent({ type: "ready" });

  let buffer = "";
  let closing = false;
  // Steps are handled one at a time; a queue keeps a fast writer from
  // interleaving two steps in the same browser.
  let chain: Promise<void> = Promise.resolve();

  await new Promise<void>((resolve) => {
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }

        if (msg.type === "close") {
          closing = true;
          chain = chain.then(() => { resolve(); });
          continue;
        }

        if (msg.type === "step" && !closing) {
          chain = chain.then(async () => {
            try {
              const outcome = await runBuildStep(controller, config, {
                prompt: msg.prompt || msg.detail || "",
                workspace: workspace,
                autonomy: autonomy,
                stepIndex: msg.index,
                stepDetail: msg.detail || "",
                goalSummary: msg.goal || "",
              });
              sessionEvent(Object.assign({ type: "step-result", index: msg.index }, outcome));
            } catch (e: any) {
              sessionEvent({ type: "step-result", index: msg.index, success: false, error: String(e && e.message ? e.message : e) });
            }
          });
        }
      }
    });
    process.stdin.on("end", () => { chain = chain.then(() => resolve()); });
  });

  await controller.close();
  sessionEvent({ type: "closed" });
}
```

In `main()`, add the branch beside the existing modes, before the default:

```typescript
  else if (mode === "build-session") await buildSessionMode(args[1], args[2] || "deepseek", args[3] || "auto");
```

`args[1]` is the workspace and `args[2]` the provider for this mode — it does not use the positional layout the other modes share.

- [ ] **Step 4: Run to verify it passes**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:all
```

Expected: PASS — 81 unit, e2e rises from 88 to 95. `browser launched exactly once for three steps` is the assertion that matters.

- [ ] **Step 5: Commit**

```bash
git add local-agent/src/index.ts local-agent/test/run-e2e.cjs
git commit -m "Add a build-session mode that holds one browser for a whole build"
```

---

### Task 3: Desktop uses the session, with a fallback

**Files:**
- Modify: `desktop/main.js` — new IPC handlers beside `run-agent`
- Modify: `desktop/preload.js` — expose them
- Modify: `desktop/builder.js` — `CN.startBuild` opens a session, sends steps, closes

**Interfaces:**
- Consumes: the `build-session` protocol from Task 2.
- Produces, on `window.CN`:
  - `startSession(workspace, provider, autonomy, headed): Promise<{ok: boolean, error?: string}>`
  - `sendStep(index, detail, goal): Promise<StepOutcome>`
  - `endSession(): Promise<void>`

- [ ] **Step 1: main.js — session lifecycle**

Add beside the `run-agent` handler. It reuses the same log-line forwarding the renderer already listens to, so the Agent pane keeps working:

```javascript
let sessionProc = null;
const pendingSteps = new Map();

ipcMain.handle("start-session", function (event, payload) {
  return new Promise(function (resolve) {
    if (sessionProc) { resolve({ ok: true }); return; }
    const headed = payload.headed ? "1" : "0";
    const proc = spawn("node", [agentPath(), "build-session", payload.workspace, payload.provider, payload.autonomy || "ask"],
      { cwd: path.join(__dirname, ".."), env: Object.assign({}, process.env, { AGENT_HEADED: headed }) });
    sessionProc = proc;
    let lineBuf = "";
    let settled = false;

    proc.stdout.on("data", function (d) {
      lineBuf += d.toString();
      let idx;
      while ((idx = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.substring(0, idx).replace(/\r$/, "");
        lineBuf = lineBuf.substring(idx + 1);
        const m = line.match(/^SESSION_EVENT: (.*)$/);
        if (!m) { if (line.trim()) event.sender.send("agent-log", line); continue; }
        let ev; try { ev = JSON.parse(m[1]); } catch (e) { continue; }
        if (ev.type === "ready" && !settled) { settled = true; resolve({ ok: true }); }
        if (ev.type === "step-result") {
          const done = pendingSteps.get(ev.index);
          if (done) { pendingSteps.delete(ev.index); done(ev); }
        }
      }
    });
    proc.stderr.on("data", function (d) { event.sender.send("agent-log", d.toString()); });
    proc.on("close", function () {
      sessionProc = null;
      for (const [, done] of pendingSteps) done({ success: false, error: "session ended" });
      pendingSteps.clear();
      if (!settled) { settled = true; resolve({ ok: false, error: "session exited before ready" }); }
    });
    proc.on("error", function (e) {
      sessionProc = null;
      if (!settled) { settled = true; resolve({ ok: false, error: String(e) }); }
    });
  });
});

ipcMain.handle("send-step", function (event, payload) {
  return new Promise(function (resolve) {
    if (!sessionProc) { resolve({ success: false, error: "no session" }); return; }
    pendingSteps.set(payload.index, resolve);
    sessionProc.stdin.write(JSON.stringify({
      type: "step", index: payload.index, detail: payload.detail, goal: payload.goal, prompt: payload.detail,
    }) + "\n");
  });
});

ipcMain.handle("end-session", function () {
  if (!sessionProc) return Promise.resolve();
  try { sessionProc.stdin.write(JSON.stringify({ type: "close" }) + "\n"); } catch (e) {}
  const proc = sessionProc;
  setTimeout(function () { try { proc.kill(); } catch (e) {} }, 8000);
  sessionProc = null;
  return Promise.resolve();
});
```

- [ ] **Step 2: preload.js — expose them**

Add to the existing `contextBridge.exposeInMainWorld` object, matching the surrounding style:

```javascript
  startSession: function (workspace, provider, autonomy, headed) {
    return ipcRenderer.invoke("start-session", { workspace: workspace, provider: provider, autonomy: autonomy, headed: headed });
  },
  sendStep: function (index, detail, goal) {
    return ipcRenderer.invoke("send-step", { index: index, detail: detail, goal: goal });
  },
  endSession: function () { return ipcRenderer.invoke("end-session"); },
```

- [ ] **Step 3: builder.js — use the session, fall back if it fails**

In `CN.startBuild`, immediately after `buttons("running");`, add:

```javascript
    const useSession = await CN.startSession(CN.getWorkspace(), CN.getProvider(), "ask", CN.isHeaded && CN.isHeaded());
    const sessionOk = !!(useSession && useSession.ok);
    if (!sessionOk) CN.log("session unavailable, falling back to per-step launches", "step");
```

and after the loop, before `running = false;`:

```javascript
    if (sessionOk) await CN.endSession();
```

In `runOne(i)`, replace the single `const res = await CN.runAgent(args);` with:

```javascript
    const res = sessionActive()
      ? await CN.sendStep(i, stepDetail, (plan && plan.summary) || "")
      : await CN.runAgent(args);
```

and add near the other module-level state at the top of the file:

```javascript
  let sessionOn = false;
  function sessionActive() { return sessionOn; }
```

setting `sessionOn = sessionOk;` where the session is started and `sessionOn = false;` after `endSession()`. `runOne` is also called by `CN.retryFailed`, which has no session — `sessionActive()` returns false there, so it keeps using `runAgent`.

- [ ] **Step 4: Verify**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:all
for f in ../desktop/*.js; do node --check "$f" || echo "SYNTAX FAIL $f"; done
```

Expected: PASS — 81 unit, 95 e2e (the desktop is not covered by the suite; this confirms nothing regressed), and every desktop file parses.

- [ ] **Step 5: Commit**

```bash
git add desktop/main.js desktop/preload.js desktop/builder.js
git commit -m "Drive builds through one long-lived agent session"
```

---

### Task 4: Drive the app and document

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Launch and check the window**

```bash
cd ~/projects/agentic-web-coder && source scripts/wsl-env.sh && cd desktop && npm start
```

Expected: the window opens on the Chat tab, no errors beyond the harmless `viz_main_impl.cc` GPU lines.

- [ ] **Step 2: Confirm the controls still exist**

Pause, skip and stop are between-step operations owned by `builder.js`, and Task 3 does not change the loop. Confirm the buttons still show and hide correctly by checking `buttons("running")` / `buttons("paused")` behaviour is untouched:

```bash
grep -n "builder-pause\|builder-resume\|builder-skip\|builder-stop" desktop/builder.js
```

Expected: the four handlers at the end of the file are unchanged from before Task 3.

- [ ] **Step 3: Update the README**

Under `## How a build step runs`, replace item 2 with:

```markdown
2. For a build, `desktop/main.js` starts **one** `local-agent` process in
   `build-session` mode and feeds it steps over stdin, so the browser opens once
   per build rather than once per step. If the session cannot start, the builder
   falls back to spawning `local-agent/dist/index.js` per step, which is what the
   one-shot modes always do. Arguments longer than 8000 chars are spilled to a
   temp file and the path passed instead; the agent reads those back
   (`resolveArg`).
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "Document the build session"
```

---

## Self-Review

**Spec coverage.** Phase 3 of the spec asks for: a long-lived process owning browser and thread (Task 2); newline-delimited JSON framing because stdin already carries approval replies (Task 2 — approvals continue to flow through `runBuildStep`'s existing `askApproval`, which reads stdin directly; the session's own reader ignores any line that is not valid JSON with a known `type`, so the two coexist); desktop wiring via `start-session` / `send-step` / `end-session` (Task 3); the per-step spawn retained as fallback (Task 3, `sessionActive()`); and the ledger surviving in the session (already satisfied — Phase 2 persists it to `sessions.json`, so no work is needed here).

**Correction to the spec.** It claimed pause/skip/stop "become messages that must be honoured mid-flight, including while blocked on a model response". That is wrong: those controls are between-step in `builder.js` today and this plan keeps the loop there, so they are untouched. The spec's characterisation of this as the phase's main cost was mistaken.

**Placeholder scan.** No TBD/TODO. Every code step carries literal code.

**Type consistency.** `StepOutcome` is what `runBuildStep` returns, what `step-result` carries, and what `sendStep` resolves to. `SESSION_EVENT: ` is spelled identically in the agent, the test and `main.js`.

**Known rough edge.** Task 3 is not covered by the automated suite — the e2e drives the CLI, not Electron. Task 4's manual launch is the only check that the desktop wiring works, so a regression there would reach a user before a test caught it. Building an Electron-driving harness is worth doing but belongs in its own piece of work.
