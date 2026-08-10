# Provider Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the provider config honest and fast, add GLM, and make signing in an explicit action instead of a two-minute hang.

**Architecture:** The completion decision becomes a pure function so it can be tested without a browser, then feeds `waitForResponse` as a second signal alongside the existing stability check — which stays as the fallback and floor. Dead config fields are deleted from the schema and every config. The picker reads the config directory instead of hardcoded markup. A `signin` mode launches a visible browser regardless of `AGENT_HEADED`.

**Tech Stack:** TypeScript (ES2020, CommonJS via `tsc`), Playwright, plain browser JS for the renderer (no bundler), Electron IPC, plain-CJS test harness.

## Global Constraints

- Agent source compiles with `npx tsc -p local-agent/tsconfig.json`. **Every test run must be preceded by a build.**
- Desktop files load as `<script>` tags — no bundler, no ES modules, no npm imports in renderer code.
- Tests use `section(name)` and `check(name, condition, extra)`. No test framework.
- Suite must stay green: currently **110 unit + 120 end-to-end**.
- Never run two e2e suites at once. Check with `ps -eo args= | grep run-e2e.cjs`, not `pgrep -f`.
- On WSL, `source scripts/wsl-env.sh` first.
- **The stability check is never removed.** The stop-button signal may only shorten a wait after a response has started; it can never be the sole reason a wait ends. This is the code that once hung for the full 120 seconds.
- **Item 8 is out of scope.** Do not add model-switching selectors or machinery.

---

### Task 1: The completion decision

**Files:**
- Create: `local-agent/src/providers/completion.ts`
- Test: `local-agent/test/run-tests.cjs` (new `testCompletion()`)

**Interfaces:**
- Produces:
  ```typescript
  interface CompletionState { started: boolean; stopSeen: boolean; stopGone: boolean; stableTicks: number }
  function isComplete(state: CompletionState, useStopButton: boolean, requiredStableTicks: number): boolean
  ```

- [ ] **Step 1: Write the failing test**

Add to `run-tests.cjs` above `function testRelevance() {`:

```javascript
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
```

Register it:

```javascript
  testApprovalPolicy();
  testCompletion();
  testEntrypoint();
```

- [ ] **Step 2: Run to verify it fails**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm test
```

Expected: FAIL — `Cannot find module '.../dist/providers/completion.js'`.

- [ ] **Step 3: Implement**

Create `local-agent/src/providers/completion.ts`:

```typescript
export interface CompletionState {
  /** A reply has begun arriving. Nothing completes before this. */
  started: boolean;
  /** The provider's stop button was observed at least once. */
  stopSeen: boolean;
  /** It was observed and has since disappeared. */
  stopGone: boolean;
  /** Consecutive polls where the reply text did not change. */
  stableTicks: number;
}

/**
 * Two signals, in priority order.
 *
 * The stop button vanishing means the provider itself considers the reply
 * finished — immediate and exact. It only counts once a reply has started; a
 * stop button absent because generation has not begun is not a finished reply.
 *
 * Stability is the fallback and the floor: it applies when the provider has no
 * stop button, when the selector is wrong, or when the button never appeared.
 * The stop signal can only make a wait shorter, never end one that stability
 * would not eventually end on its own.
 */
export function isComplete(state: CompletionState, useStopButton: boolean, requiredStableTicks: number): boolean {
  if (!state.started) return false;
  if (useStopButton && state.stopSeen && state.stopGone) return true;
  return state.stableTicks >= requiredStableTicks;
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:all
```

Expected: PASS — unit rises from 110 to 118; e2e stays at 120.

- [ ] **Step 5: Commit**

```bash
git add local-agent/src/providers/completion.ts local-agent/test/run-tests.cjs
git commit -m "Add the completion decision as a pure function"
```

---

### Task 2: Use the stop button in waitForResponse

**Files:**
- Modify: `local-agent/src/providers/playwright-controller.ts` — `waitForResponse`
- Modify: `local-agent/test/mock-provider.cjs` — a stop button that appears while replying
- Test: `local-agent/test/run-e2e.cjs`

**Interfaces:**
- Consumes: `isComplete` (Task 1).
- Produces: mock gains `#stop`, visible only while a reply is pending.

- [ ] **Step 1: Give the mock a stop button**

In `mock-provider.cjs`, add the button to the page markup beside `#send`:

```html
  <button id="stop" style="display:none;">Stop</button>
```

and in the page's `send()`, wrap the fetch so the button is visible only while waiting:

```javascript
  var stop = document.getElementById('stop');
  stop.style.display = '';
  var res = await fetch('/__reply', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: text
  });
  var body = await res.json();
  stop.style.display = 'none';
```

- [ ] **Step 2: Write the failing test**

Add to `run-e2e.cjs` before the final `await mock.close();`:

```javascript
  // ------------------------- the stop button ends a wait sooner than stability
  section("stop button completes a reply without the stability wait");
  {
    const ws = mkWorkspace();
    const cfgPath = path.join(PROVIDER_DIR, "mock.json");
    const original = fs.readFileSync(cfgPath, "utf8");

    // A reply that takes a moment, so the stop button is genuinely observable.
    mock.setReplyDelay(2500);

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
```

- [ ] **Step 3: Run to verify it fails**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:e2e
```

Expected: FAIL — `the stop-button path was used`, because nothing reads `stopButton`.

- [ ] **Step 4: Implement**

In `playwright-controller.ts`, import the decision:

```typescript
import { isComplete } from "./completion.js";
```

Add a helper beside `countMessages`:

```typescript
  private async stopButtonVisible(config: ProviderConfig): Promise<boolean> {
    if (!this.page || !config.selectors.stopButton) return false;
    try {
      return (await this.page.locator(config.selectors.stopButton).count()) > 0;
    } catch {
      return false;
    }
  }
```

Replace the body of the polling loop in `waitForResponse`. The existing loop
tracks `started`, `lastText` and `stableCount`; add stop-button tracking and let
`isComplete` decide:

```typescript
    let started = false;
    let lastText: string | null = null;
    let stableCount = 0;
    let waitingTicks = 0;
    let stopSeen = false;
    let stopGone = false;
    const useStopButton = !!(config.completionRules?.waitForStopButtonDisappear && config.selectors.stopButton);

    while (Date.now() - start < maxWait) {
      await this.page.waitForTimeout(POLL_INTERVAL_MS);
      const count = await this.countMessages(config);
      const text = await this.getLastMessageText(config);

      if (useStopButton) {
        const visible = await this.stopButtonVisible(config);
        if (visible) { stopSeen = true; stopGone = false; }
        else if (stopSeen) stopGone = true;
      }

      // A reply to a follow-up is usually SHORTER than the answer before it, so
      // "grew by 50 characters" never fires and the whole wait is spent thinking
      // about a reply that already arrived. Compare against the baseline text
      // instead: anything that is not still the previous message counts as new.
      const isNew = count > prevCount || (text.length > 0 && text !== prevContent);

      if (!started) {
        if (isNew) {
          console.log("Response started!");
          started = true;
          lastText = text;
          stableCount = 0;
        } else {
          waitingTicks++;
          if (waitingTicks % THINKING_LOG_EVERY_TICKS === 0) {
            const elapsed = Math.round((Date.now() - start) / 1000);
            console.log("AI is thinking... (" + elapsed + "s elapsed of " + Math.round(maxWait / 1000) + "s)");
          }
        }
        continue;
      }

      if (text === lastText && isNew) stableCount++;
      else { stableCount = 0; lastText = text; }

      if (isComplete({ started, stopSeen, stopGone, stableTicks: stableCount }, useStopButton, STABLE_TICKS)) {
        console.log(useStopButton && stopSeen && stopGone
          ? "Response complete (stop button disappeared)!"
          : "Response complete (stable for " + (STABLE_TICKS * POLL_INTERVAL_MS) / 1000 + "s)!");
        return await this.extractWithRetry(config);
      }
    }
```

- [ ] **Step 5: Run to verify it passes**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:all
```

Expected: PASS — unit 118, e2e rises from 120 to 125. Every existing section must still pass; the mock's default config has no working `stopButton`, so they all take the stability path unchanged.

- [ ] **Step 6: Commit**

```bash
git add local-agent/src/providers/playwright-controller.ts local-agent/test/mock-provider.cjs local-agent/test/run-e2e.cjs
git commit -m "Complete a reply when the provider's stop button disappears"
```

---

### Task 3: Delete the dead config fields

**Files:**
- Modify: `local-agent/src/providers/playwright-controller.ts` — `ProviderConfig`
- Modify: all four files in `local-agent/config/providers/`
- Modify: `local-agent/test/run-e2e.cjs` — `writeProviderConfig`
- Modify: `local-agent/test/fixtures/chat.html` only if it references removed fields

**Interfaces:**
- Produces: `ProviderConfig` without `kind`, `requiresLogin`, `selectors.codeBlock`, `selectors.copyButton`, `completionRules.waitForCopyButton`, `completionRules.stableMs`; `selectors.stopButton` becomes optional.

- [ ] **Step 1: Narrow the interface**

```typescript
export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  selectors: {
    chatInput: string;
    sendButton: string;
    /** Optional. When set with waitForStopButtonDisappear, ends a wait early. */
    stopButton?: string;
    assistantMessage: string;
  };
  completionRules: {
    waitForStopButtonDisappear: boolean;
    maxWaitMs: number;
  };
  profileDir: string;
}
```

- [ ] **Step 2: Build and let the compiler find every use**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json
```

Expected: errors naming each remaining reference to a removed field. Remove those references. There should be none in `src/` — the fields were never read — so a clean build here confirms the audit.

- [ ] **Step 3: Strip the config files**

For each of `deepseek.json`, `qwen-studio.json`, `huggingchat.json`, `open-webui.json`, delete `kind`, `requiresLogin`, `selectors.codeBlock`, `selectors.copyButton`, `completionRules.waitForCopyButton`, `completionRules.stableMs`. Keep `stopButton` and set `waitForStopButtonDisappear` to `true` for DeepSeek and Qwen, which both have one.

Update `writeProviderConfig` in `run-e2e.cjs` to emit only the retained fields.

- [ ] **Step 4: Run the suite**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:all
```

Expected: PASS — unit 118, e2e 125, unchanged. A schema change that moves a test count means something read a field that was supposed to be dead.

- [ ] **Step 5: Commit**

```bash
git add local-agent/src/providers/playwright-controller.ts local-agent/config/providers/ local-agent/test/run-e2e.cjs
git commit -m "Delete provider config fields that were never read"
```

---

### Task 4: GLM, a dynamic picker, and logos

**Files:**
- Create: `local-agent/config/providers/glm.json`
- Modify: `desktop/main.js` — `list-providers` handler
- Modify: `desktop/preload.js` — expose it
- Modify: `desktop/index.html` — empty picker, populated at startup
- Modify: `desktop/renderer.js` — populate and persist the selection
- Modify: `desktop/styles.css` — provider chip

**Interfaces:**
- Produces: `window.api.listProviders(): Promise<{ id, name }[]>`.

- [ ] **Step 1: The GLM config**

Create `local-agent/config/providers/glm.json`:

```json
{
  "id": "glm",
  "name": "GLM (Z.ai)",
  "baseUrl": "https://chat.z.ai/",
  "enabled": true,
  "_selectorsUnverified": "These selectors have not been checked against the live site. If GLM hangs or sends nothing, correct chatInput and sendButton here first.",
  "selectors": {
    "chatInput": "textarea, div[contenteditable=\"true\"]",
    "sendButton": "button[type=\"submit\"], button[class*=\"send\"]",
    "stopButton": "button[class*=\"stop\"]",
    "assistantMessage": "[class*=\"assistant\"], .markdown-body, [class*=\"message\"][class*=\"bot\"]"
  },
  "completionRules": {
    "waitForStopButtonDisappear": true,
    "maxWaitMs": 120000
  },
  "profileDir": "local-agent/storage/browser-profiles/glm"
}
```

The `_selectorsUnverified` key is data, not schema — the registry ignores unknown keys, and it records honestly that these are guesses.

- [ ] **Step 2: main.js — list providers**

Reading four JSON files does not warrant spawning the agent:

```javascript
ipcMain.handle("list-providers", function () {
  const dir = path.join(__dirname, "..", "local-agent", "config", "providers");
  const out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
        if (cfg && cfg.enabled && cfg.id) out.push({ id: cfg.id, name: cfg.name || cfg.id });
      } catch (e) { /* a malformed config is skipped, not fatal */ }
    }
  } catch (e) { /* no directory means no providers */ }
  return out;
});
```

In `desktop/preload.js`:

```javascript
  listProviders: function () { return ipcRenderer.invoke("list-providers"); },
```

- [ ] **Step 3: index.html — empty the picker**

```html
      <select id="provider-select"></select>
```

- [ ] **Step 4: renderer.js — populate it**

Add near the other startup wiring:

```javascript
(async function () {
  const sel = $("provider-select");
  if (!sel) return;
  let list = [];
  try { list = await window.api.listProviders(); } catch (e) {}
  if (!list.length) list = [{ id: "deepseek", name: "DeepSeek Chat" }];
  sel.innerHTML = "";
  list.forEach(function (p) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name;
    sel.appendChild(o);
  });
  let saved = null;
  try { saved = localStorage.getItem("closeni.provider"); } catch (e) {}
  if (saved && list.some(function (p) { return p.id === saved; })) sel.value = saved;
  provider = sel.value;
  sel.onchange = function (e) {
    provider = e.target.value;
    try { localStorage.setItem("closeni.provider", provider); } catch (e) {}
  };
})();
```

Delete the existing `$("provider-select").onchange = ...` line, which this replaces.

- [ ] **Step 5: styles.css — the chip**

```css
#provider-select{width:100%;background:#050506;border:1px solid var(--line);color:var(--txt);padding:7px 8px;border-radius:3px;font-family:inherit;font-size:12px;}
.provider-chip{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:3px;font-size:10px;font-weight:600;margin-right:8px;background:#1d1d22;color:var(--txt);}
```

- [ ] **Step 6: Verify**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:all
cd .. && for f in desktop/*.js; do node --check "$f" || echo "SYNTAX FAIL $f"; done
```

Expected: suite unchanged at 118 / 125, all desktop files parse.

- [ ] **Step 7: Commit**

```bash
git add local-agent/config/providers/glm.json desktop/
git commit -m "Add GLM and read the provider list from the config directory"
```

---

### Task 5: Signing in

**Files:**
- Modify: `local-agent/src/index.ts` — `signinMode`, arg branch, and the `waitForLogin` timeout
- Modify: `local-agent/src/providers/playwright-controller.ts` — `waitForLogin` fails fast when headless
- Modify: `desktop/main.js`, `preload.js`, `renderer.js`, `index.html`
- Test: `local-agent/test/run-e2e.cjs`

**Interfaces:**
- Produces: mode `signin <provider>`; `window.api.signIn(provider)`.

- [ ] **Step 1: Write the failing test**

Add to `run-e2e.cjs` before the final `await mock.close();`:

```javascript
  // ------------------------------------------------ signing in to a provider
  section("signin reports whether the chat input appeared");
  {
    const r = await runAgent(["signin", "mock"], { timeoutMs: 90000 });
    check("signin succeeds when the input is present", !!r.result && r.result.success === true, JSON.stringify(r.result));
    check("signin launches a visible browser", r.out.includes("HEADED"), (r.out.match(/Launching browser.*/) || [""])[0]);
  }
```

- [ ] **Step 2: Run to verify it fails**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:e2e
```

Expected: FAIL — the mode does not exist, so the agent falls through to `browser` mode with nonsense arguments.

- [ ] **Step 3: Implement the mode**

In `index.ts`, above `buildMode`:

```typescript
/**
 * Open a visible browser so the user can sign in. Headed regardless of
 * AGENT_HEADED: a login in a window nobody can see is the bug this fixes.
 */
async function signinMode(providerId: string) {
  const registry = new ProviderRegistry();
  registry.loadProviders();
  const config = registry.getProvider(providerId);
  if (!config) { emit({ success: false, error: "Provider not found: " + providerId }); return; }

  process.env.AGENT_HEADED = "1";
  const controller = new PlaywrightController(config);
  await controller.launch(config);
  try {
    await controller.navigateFresh(config);
    const ok = await controller.waitForLogin(300000);
    emit(ok
      ? { success: true }
      : { success: false, error: "No chat input appeared. The sign-in may not have completed." });
  } finally {
    await controller.close();
  }
}
```

In `main()`:

```typescript
    else if (mode === "signin") await signinMode(args[1] || "deepseek");
```

`PlaywrightController` reads `AGENT_HEADED` in its constructor, so the assignment must come before the instance is created — it does.

- [ ] **Step 4: Fail fast when headless**

In `playwright-controller.ts`, replace `waitForLogin`:

```typescript
  async waitForLogin(timeoutMs: number = 120000): Promise<boolean> {
    if (!this.page) throw new Error("Browser not launched");
    // A login cannot happen in a window nobody can see, so headless runs give up
    // quickly and name the fix rather than waiting out the full timeout.
    const effective = this.isHeaded ? timeoutMs : Math.min(timeoutMs, 15000);
    console.log("Waiting for chat input (" + Math.round(effective / 1000) + "s)...");
    try {
      await this.page.waitForSelector('textarea, div[contenteditable="true"]', { timeout: effective, state: "visible" });
      console.log("Chat input ready.");
      return true;
    } catch {
      console.log(this.isHeaded
        ? "No chat input appeared."
        : "No chat input appeared. If this provider needs a login, use Sign in first.");
      return false;
    }
  }
```

- [ ] **Step 5: The desktop button**

`desktop/main.js`, beside the other handlers:

```javascript
ipcMain.handle("sign-in", function (event, providerId) {
  return new Promise(function (resolve) {
    const proc = spawn("node", [agentPath(), "signin", providerId],
      { cwd: path.join(__dirname, ".."), env: Object.assign({}, process.env, { AGENT_HEADED: "1" }) });
    agentProc = proc;
    let output = "";
    let lineBuf = "";
    proc.stdout.on("data", function (d) {
      const t = d.toString();
      output += t;
      lineBuf += t;
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
      resolve({ success: output.indexOf('"success":true') !== -1 });
    });
    proc.on("error", function (e) { agentProc = null; resolve({ success: false, error: String(e) }); });
  });
});
```

`desktop/preload.js`:

```javascript
  signIn: function (providerId) { return ipcRenderer.invoke("sign-in", providerId); },
```

`desktop/index.html`, directly after the provider select:

```html
      <button id="provider-signin" class="btn" style="width:100%;margin-top:8px;">Sign in</button>
```

`desktop/renderer.js`, beside the other button handlers:

```javascript
$("provider-signin").onclick = async function () {
  const btn = $("provider-signin");
  btn.disabled = true;
  btn.textContent = "Opening browser...";
  toast("A browser window will open - sign in, then it closes itself");
  const r = await window.api.signIn(provider);
  btn.disabled = false;
  btn.textContent = "Sign in";
  if (r && r.success) { toast("Signed in to " + provider); log("signed in to " + provider, "ok"); }
  else { toast("Sign-in did not complete", "err"); log("sign-in failed: " + ((r && r.error) || "no chat input appeared"), "err"); }
};
```

- [ ] **Step 6: Run everything and drive the app**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:all
cd .. && for f in desktop/*.js; do node --check "$f" || echo "SYNTAX FAIL $f"; done
cd desktop && npm start
```

Expected: unit 118, e2e rises from 125 to 127. The app opens; the sidebar shows a populated provider picker including GLM and a Sign in button.

- [ ] **Step 7: Commit**

```bash
git add local-agent/src/ desktop/ local-agent/test/run-e2e.cjs
git commit -m "Add an explicit sign-in flow and fail fast when headless"
```

---

### Task 6: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: README**

Add after the Permissions section:

```markdown
## Providers

The picker lists every enabled config in `local-agent/config/providers/`. Adding a
provider means adding a JSON file there — no code change and no markup change.

Every field in a provider config is read. `chatInput`, `sendButton` and
`assistantMessage` drive the conversation; `stopButton` with
`waitForStopButtonDisappear` ends a wait the moment the provider's own stop
button vanishes, instead of waiting for the reply text to sit still for eight
seconds. A provider without a stop button falls back to that stability check, so
a wrong selector costs speed rather than correctness.

`GLM (Z.ai)` ships with **unverified selectors** — they have never been checked
against the live site. If it hangs or sends nothing, correct `chatInput` and
`sendButton` in `glm.json` first.

## Signing in

**Sign in** beside the provider picker opens a visible browser at that provider
and waits for the chat input to appear, then closes. The session lives in that
provider's persistent profile under `local-agent/storage/browser-profiles/`.

A headless run that finds no chat input gives up after 15 seconds and says to
sign in, rather than waiting out the full timeout for a login that cannot happen
in a window nobody can see.
```

- [ ] **Step 2: ROADMAP**

Update sub-project 2: items 7, 9, 10 to `done`; item 8 stays `todo` with a note that it is blocked on provider UI markup the author cannot observe, not on effort. Note the sub-project is three of four.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/ROADMAP.md
git commit -m "Document the provider platform and sign-in flow"
```

---

## Self-Review

**Spec coverage.** Completion decision as a pure function with the start-gate and the stability floor (Task 1), wired in with the stability fallback intact (Task 2). Dead fields deleted from schema and configs (Task 3). GLM with its unverified selectors recorded in the file itself (Task 4). Dynamic picker reading the config directory (Task 4). Explicit sign-in launching headed regardless of `AGENT_HEADED`, plus fail-fast when headless (Task 5). Logos as a neutral chip (Task 4, Step 5). Item 8 deliberately absent.

**Gap found and closed.** The spec described a per-provider logo chip but the picker is a native `<select>`, which cannot contain markup — an option element renders text only. Task 4 ships the chip CSS and the dynamic list, but a coloured mark inside the dropdown is not achievable without replacing the select with a custom component, which is out of scope here. The chip class is available for the surrounding UI; the picker itself stays text. Recording this rather than quietly shipping a rule that never applies.

**Placeholder scan.** No TBD/TODO. Every code step carries literal code.

**Type consistency.** `CompletionState` fields match between the module, the tests and the call site in `waitForResponse`. `stopButton` is optional in the interface and guarded before use. `listProviders` returns `{ id, name }` in the handler, the preload and the renderer.

**Known rough edge.** Task 2's timing assertion compares two real runs; on a heavily loaded machine the margin could narrow. The `stop button` log assertion is the reliable signal and is checked independently.
