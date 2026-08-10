# Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CloseNI installable — a Windows `.exe` and a Linux AppImage/`.deb`, built by CI on a tag.

**Architecture:** Three defects block packaging and are fixed first: state written into the install directory, `spawn("node")`, and a 389MB browser. Each becomes a pure function with its own tests, because none of them can be exercised by running the app from source. Only then does electron-builder get configured.

**Tech Stack:** electron-builder (NSIS, AppImage, deb), GitHub Actions, Electron 31 running as Node via `ELECTRON_RUN_AS_NODE`, Playwright's own CLI for browser download.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-10-distribution-design.md`. Read it before starting.
- **`local-agent/storage/` must never be packaged.** It holds live session cookies and private chat URLs. The `files` config is an explicit **allow-list**, never an exclude-list: a forgotten exclusion publishes credentials to a public release, a forgotten inclusion fails loudly on first launch. Same rule for `.superpowers/`, `docs/`, `samples/`, `app/`, `instance/`, `__pycache__/`, `vscode-extension/`.
- **The `CLOSENI_STORAGE`-unset path is what the tests use**, not a legacy fallback. The e2e suite spawns the agent directly with provider configs in a temp directory and relies on storage following `profileDir`. Breaking it invalidates 150 checks.
- **`PLAYWRIGHT_BROWSERS_PATH` is set only when `app.isPackaged`.** In development it must stay unset, or Playwright stops seeing `~/.cache/ms-playwright` and the developer is told to download 389MB they already have.
- **`scripts/wsl-env.sh` must keep unsetting `ELECTRON_RUN_AS_NODE`.** Set in the developer's shell it makes Electron report v20.18.0 and never open a window. Setting it on a *child* process is the opposite case and is correct.
- Run tests with `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`.
- Never commit `local-agent/storage/sessions.json`, `last-chat-url.json`, or anything under `local-agent/storage/browser-profiles/`.

## Heads-up before starting

**Task 2 makes the app forget its provider logins, in development too.** Storage moves to `userData` on one code path rather than two, which is the coherent choice and the one the spec took — but the existing signed-in DeepSeek, Qwen and GLM profiles stay behind at the old location. Signing in again is three clicks per provider via the Sign in button. The 95MB at `local-agent/storage/` can be deleted afterwards, or kept as a fallback.

## File Structure

| File | Responsibility |
|---|---|
| `local-agent/src/storage-paths.ts` (create) | `storagePaths(root, config)` — where sessions and profiles live. Pure. |
| `local-agent/src/providers/playwright-controller.ts` (modify) | Two call sites use it |
| `desktop/browser-check.js` (create) | `hasChromium(entries)` — is a browser installed. Pure, UMD. |
| `desktop/main.js` (modify) | Electron-as-Node spawns, `CLOSENI_STORAGE`, `PLAYWRIGHT_BROWSERS_PATH`, the download IPC |
| `desktop/index.html`, `renderer.js`, `styles.css` (modify) | The first-run gate |
| `scripts/make-icon.mjs` (create) | Rasterises `build/icon.svg` to `build/icon.png` using Playwright |
| `build/icon.png` (create, committed) | 512×512, what electron-builder actually consumes |
| `package.json` (modify) | `main`, `workspaces`, version, the `build` block |
| `.github/workflows/release.yml` (create) | Tag → build → GitHub Release |
| `local-agent/test/run-tests.cjs` (modify) | New unit sections |

---

### Task 1: Where state lives

**Files:**
- Create: `local-agent/src/storage-paths.ts`
- Modify: `local-agent/src/providers/playwright-controller.ts:79-84`, `:153`
- Test: `local-agent/test/run-tests.cjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface StoragePaths { root: string; sessionsFile: string; profileDir: string }`
  - `storagePaths(root: string | undefined, config: { id: string; profileDir: string }): StoragePaths`

- [ ] **Step 1: Write the failing test**

Add to `local-agent/test/run-tests.cjs`, above `function testToolchain()`:

```javascript
function testStoragePaths() {
  section("storage paths");
  const { storagePaths } = require(path.join(DIST, "storage-paths.js"));
  const cfg = { id: "deepseek", profileDir: "local-agent/storage/browser-profiles/deepseek" };

  // Unset is not a legacy fallback - it is what the e2e suite uses. It writes
  // provider configs into a temp directory and relies on storage following
  // profileDir, so this branch must reproduce today's behaviour exactly.
  const dev = storagePaths(undefined, cfg);
  check("unset keeps sessions beside the profiles",
    dev.sessionsFile === path.join("local-agent", "storage", "sessions.json"), dev.sessionsFile);
  check("unset resolves the profile directory",
    dev.profileDir === path.resolve("local-agent/storage/browser-profiles/deepseek"), dev.profileDir);

  // A temp-directory config, which is the shape the e2e suite actually writes.
  const tmp = storagePaths(undefined, { id: "mock", profileDir: "/tmp/run-42/profiles/mock" });
  check("a temp profileDir keeps its own sessions file",
    tmp.sessionsFile === path.join("/tmp/run-42", "sessions.json"), tmp.sessionsFile);

  // Packaged: everything under one writable root.
  const packed = storagePaths("/home/u/.config/CloseNI", cfg);
  check("a root places sessions at its top",
    packed.sessionsFile === path.join("/home/u/.config/CloseNI", "sessions.json"), packed.sessionsFile);
  check("a root places profiles by provider id",
    packed.profileDir === path.join("/home/u/.config/CloseNI", "browser-profiles", "deepseek"), packed.profileDir);
  check("the root is reported", packed.root === "/home/u/.config/CloseNI");
  // Two providers must not share a profile directory.
  check("providers are separated",
    storagePaths("/r", { id: "glm", profileDir: "x" }).profileDir !==
    storagePaths("/r", { id: "qwen-studio", profileDir: "x" }).profileDir);

  // An env var set to nothing is the same as not set. Treating "" as a root
  // would put profiles at the filesystem root.
  check("an empty root is treated as unset",
    storagePaths("", cfg).sessionsFile === dev.sessionsFile);
  check("whitespace is treated as unset",
    storagePaths("   ", cfg).sessionsFile === dev.sessionsFile);
}
```

Register it in `main()`:

```javascript
  testCssTokens();
  testStoragePaths();
  testTheme();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: FAIL — `Cannot find module '.../dist/storage-paths.js'`

- [ ] **Step 3: Write the implementation**

Create `local-agent/src/storage-paths.ts`:

```typescript
/**
 * Where sessions and browser profiles live.
 *
 * Packaged, the app cannot write next to its own executable - on Windows that
 * is Program Files, and saving a session would simply fail. So the desktop app
 * passes a writable root down as CLOSENI_STORAGE.
 *
 * Pure, and separated from the controller, because this is the one part of
 * packaging that cannot be exercised by running the app from source: the
 * packaged layout only happens in a packaged build.
 */
import * as path from "path";

export interface StoragePaths {
  /** Directory holding sessions.json and browser-profiles/. */
  root: string;
  sessionsFile: string;
  profileDir: string;
}

export function storagePaths(root: string | undefined, config: { id: string; profileDir: string }): StoragePaths {
  const trimmed = (root || "").trim();

  if (!trimmed) {
    // Today's behaviour, preserved exactly. This is the path the end-to-end
    // suite takes: it writes provider configs into a temp directory and expects
    // storage to follow profileDir there.
    const dir = path.join(config.profileDir, "..", "..");
    return {
      root: dir,
      sessionsFile: path.join(dir, "sessions.json"),
      profileDir: path.resolve(config.profileDir),
    };
  }

  return {
    root: trimmed,
    sessionsFile: path.join(trimmed, "sessions.json"),
    // Keyed by provider id, not by the configured path: two providers sharing a
    // profile directory would share a login.
    profileDir: path.join(trimmed, "browser-profiles", config.id),
  };
}
```

- [ ] **Step 4: Use it in the controller**

In `playwright-controller.ts`, add the import at the top:

```typescript
import { storagePaths } from "../storage-paths.js";
```

Replace the constructor body (lines 79-84):

```typescript
  constructor(config: ProviderConfig) {
    const paths = storagePaths(process.env.CLOSENI_STORAGE, config);
    if (!fs.existsSync(paths.root)) fs.mkdirSync(paths.root, { recursive: true });
    this.sessionStoreFile = paths.sessionsFile;
    this.profilePath = paths.profileDir;
    this.isHeaded = process.env.AGENT_HEADED === "1";
  }
```

Add the field beside the other private fields near the top of the class:

```typescript
  private profilePath: string = "";
```

And in `launch()`, replace `const profilePath = path.resolve(config.profileDir);` with:

```typescript
    const profilePath = this.profilePath;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && node local-agent/test/run-tests.cjs`
Expected: PASS, count up by 8.

Then the end-to-end suite, which is the real check that the unset path is untouched:

Run: `source scripts/wsl-env.sh && node local-agent/test/run-e2e.cjs > /tmp/e2e.log 2>&1; tail -3 /tmp/e2e.log`
Expected: PASS, 150 passed, 0 failed.

- [ ] **Step 6: Commit**

```bash
git add local-agent/src/storage-paths.ts local-agent/src/providers/playwright-controller.ts local-agent/test/run-tests.cjs
git commit -m "Let the storage root be told to the agent"
```

---

### Task 2: The agent runs on Electron

**Files:**
- Modify: `desktop/main.js` — `agentEnv`, four `spawn` sites (~72, ~126, ~168, ~253), the sessions path (~330)

**Interfaces:**
- Consumes: `CLOSENI_STORAGE` from Task 1.
- Produces: `storageRoot(): string`, `spawnAgent(args, extraEnv): ChildProcess`

- [ ] **Step 1: Add the storage root and a single spawn helper**

Four call sites spawn the agent with slightly different env. One helper removes the chance of fixing three of them and missing the fourth. Add near `agentPath()` in `desktop/main.js`:

```javascript
/**
 * Where the app may write. Packaged, it cannot write beside its own executable:
 * on Windows that is Program Files. The agent is a separate process with no
 * Electron API, so the location is handed to it in the environment.
 */
function storageRoot() { return app.getPath("userData"); }

/**
 * Spawn the agent.
 *
 * process.execPath with ELECTRON_RUN_AS_NODE rather than "node": a packaged app
 * cannot assume Node is installed. Note that this same variable, set in a
 * developer's shell, makes Electron itself refuse to open a window - which is
 * why scripts/wsl-env.sh unsets it. Setting it on a child is the opposite case.
 */
function spawnAgent(args, extraEnv) {
  const env = Object.assign({}, process.env, {
    ELECTRON_RUN_AS_NODE: "1",
    CLOSENI_STORAGE: storageRoot(),
  }, extraEnv || {});
  // Packaged, Playwright must look inside userData; in development it must not,
  // or it stops seeing the browsers already in ~/.cache/ms-playwright.
  if (app.isPackaged) env.PLAYWRIGHT_BROWSERS_PATH = path.join(storageRoot(), "browsers");
  return spawn(process.execPath, [agentPath()].concat(args), {
    cwd: path.join(__dirname, ".."),
    env: env,
  });
}
```

- [ ] **Step 2: Route all four call sites through it**

Replace each `spawn("node", [agentPath()]…)` with `spawnAgent(…)`. The existing `agentEnv(headed, controls)` helper stays and becomes the `extraEnv` argument:

```javascript
// ~line 72, run-agent
const proc = spawnAgent(finalArgs, agentEnv(headed, payload.controls));

// ~line 126, suggest
proc = spawnAgent(["suggest", payload.workspace, payload.provider, String(payload.stepIndex), payload.text],
  agentEnv(payload.headed ? "1" : "0", payload.controls));

// ~line 168, start-session
proc = spawnAgent(["build-session", payload.workspace, payload.provider, payload.autonomy || "ask"],
  agentEnv(headed, payload.controls));

// ~line 253, sign-in
proc = spawnAgent(["signin", providerId], { AGENT_HEADED: "1" });
```

`agentEnv` currently returns a full merged environment via `Object.assign({}, process.env, …)`. Change it to return only its own keys, since `spawnAgent` does the merging:

```javascript
function agentEnv(headed, controls) {
  const env = { AGENT_HEADED: headed };
  if (controls && Object.keys(controls).length) env.AGENT_CONTROLS = JSON.stringify(controls);
  return env;
}
```

- [ ] **Step 3: Point the app's own sessions read at the same place**

`main.js` reads `sessions.json` directly for the chat list, at a path that will no longer be where the agent writes. Replace the body of that function (~line 330):

```javascript
  // Must agree with storagePaths() in the agent: both sides read the same file.
  return path.join(storageRoot(), "sessions.json");
```

- [ ] **Step 4: Verify**

Run: `source scripts/wsl-env.sh && node --check desktop/main.js && node local-agent/test/run-tests.cjs`
Expected: no syntax error, PASS with the same count as Task 1.

Run: `cd desktop && npm start`

Expected, and **this is the step that proves the task**:
1. The window opens. If it does not, `ELECTRON_RUN_AS_NODE` has leaked into the parent — check `scripts/wsl-env.sh` was sourced.
2. The provider list populates.
3. Pick a workspace, send a Chat message. The agent spawns and replies.
4. **Providers now ask you to sign in again.** Expected: storage moved to `userData`. Sign in to one and confirm it sticks across a restart.
5. Confirm the new location exists and holds a profile:
   `ls ~/.config/CloseNI/browser-profiles/`

- [ ] **Step 5: Commit**

```bash
git add desktop/main.js
git commit -m "Run the agent on Electron's own binary, storing state in userData"
```

---

### Task 3: The first-run browser gate

**Files:**
- Create: `desktop/browser-check.js`
- Modify: `desktop/main.js`, `desktop/preload.js`, `desktop/index.html`, `desktop/renderer.js`, `desktop/styles.css`
- Test: `local-agent/test/run-tests.cjs`

**Interfaces:**
- Consumes: `storageRoot()` from Task 2.
- Produces: `hasChromium(entries: string[]): boolean`; IPC `browser-status` → `{ ready: boolean, path: string }`; IPC `install-browser` → `{ ok: boolean, error?: string }`; event `browser-progress` → a string line.

- [ ] **Step 1: Write the failing test**

Add to `local-agent/test/run-tests.cjs`, above `function testToolchain()`:

```javascript
function testBrowserCheck() {
  section("browser presence");
  const { hasChromium } = require(path.join(__dirname, "..", "..", "desktop", "browser-check.js"));

  check("a chromium build counts", hasChromium(["chromium-1234"]) === true);
  check("a different revision counts", hasChromium(["chromium-9999"]) === true);
  check("extras alongside it are fine", hasChromium(["ffmpeg-1011", "chromium-1234"]) === true);
  check("an empty directory does not count", hasChromium([]) === false);
  check("a missing directory does not count", hasChromium(null) === false);
  // The headless shell cannot show a login page, and signing in is the whole
  // reason the app opens a visible browser.
  check("the headless shell alone does not count", hasChromium(["chromium_headless_shell-1234"]) === false);
  check("ffmpeg alone does not count", hasChromium(["ffmpeg-1011"]) === false);
  check("a partial download does not count", hasChromium(["chromium-1234.downloads-in-progress"]) === false);
}
```

Register it in `main()`:

```javascript
  testStoragePaths();
  testBrowserCheck();
  testTheme();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: FAIL — `Cannot find module '.../desktop/browser-check.js'`

- [ ] **Step 3: Write the implementation**

Create `desktop/browser-check.js`:

```javascript
/*
 * Is a usable browser installed?
 *
 * Loaded by main.js (window/global CNBrowser) and require()d by the test
 * harness. There is no bundler, so no import/export.
 *
 * Playwright names each browser directory <name>-<revision>. Only a full
 * chromium counts: the headless shell cannot display a login page, and signing
 * in to a provider is the entire reason the app opens a visible browser.
 */
(function (root) {
  var CHROMIUM = /^chromium-\d+$/;

  function hasChromium(entries) {
    if (!entries || !entries.length) return false;
    for (var i = 0; i < entries.length; i++) {
      if (CHROMIUM.test(String(entries[i]))) return true;
    }
    return false;
  }

  var api = { hasChromium: hasChromium };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNBrowser = api;
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Add the main-process check and installer**

In `desktop/main.js`, near the other `ipcMain.handle` calls:

```javascript
const { hasChromium } = require("./browser-check.js");

function browsersDir() { return path.join(storageRoot(), "browsers"); }

ipcMain.handle("browser-status", function () {
  // Development uses the developer's own ~/.cache/ms-playwright, which
  // PLAYWRIGHT_BROWSERS_PATH deliberately does not override there.
  if (!app.isPackaged) return { ready: true, path: "(development: system Playwright cache)" };
  let entries = [];
  try { entries = fs.readdirSync(browsersDir()); } catch (e) { /* not created yet */ }
  return { ready: hasChromium(entries), path: browsersDir() };
});

/**
 * Download Chromium through Playwright's own CLI.
 *
 * Reaching into playwright-core's internal registry would be shorter and would
 * break on the next Playwright upgrade. The CLI is the supported entry point,
 * and it already prints progress we can forward to the window.
 */
ipcMain.handle("install-browser", function (event) {
  return new Promise(function (resolve) {
    let cli;
    try {
      cli = require.resolve("playwright/cli.js");
    } catch (e) {
      resolve({ ok: false, error: "Playwright is missing from this build." });
      return;
    }
    const proc = spawn(process.execPath, [cli, "install", "chromium"], {
      cwd: path.join(__dirname, ".."),
      env: Object.assign({}, process.env, {
        ELECTRON_RUN_AS_NODE: "1",
        PLAYWRIGHT_BROWSERS_PATH: browsersDir(),
      }),
    });
    function forward(d) {
      const line = String(d).trim();
      if (line && win) win.webContents.send("browser-progress", line);
    }
    proc.stdout.on("data", forward);
    proc.stderr.on("data", forward);
    proc.on("error", function (e) { resolve({ ok: false, error: String(e) }); });
    proc.on("close", function (code) {
      resolve(code === 0 ? { ok: true } : { ok: false, error: "Download failed (exit " + code + ")." });
    });
  });
});
```

- [ ] **Step 5: Expose it and build the gate**

In `desktop/preload.js`, add to the `exposeInMainWorld` object:

```javascript
  browserStatus: function () { return ipcRenderer.invoke("browser-status"); },
  installBrowser: function () { return ipcRenderer.invoke("install-browser"); },
  onBrowserProgress: function (cb) { ipcRenderer.on("browser-progress", function (e, line) { cb(line); }); },
```

In `desktop/index.html`, before `<div id="toast-stack"></div>`:

```html
<div id="browser-gate">
  <div id="browser-card">
    <div class="micro">One-time setup</div>
    <p>CloseNI drives real browsers to talk to AI providers. It needs its own copy of Chromium — about 389MB, downloaded once and kept for good.</p>
    <button id="browser-install" class="btn invert">Download browser</button>
    <div id="browser-progress"></div>
  </div>
</div>
```

In `desktop/renderer.js`, append:

```javascript
/**
 * First run: without a browser the app can do nothing at all, so this blocks
 * rather than failing later at the first sign-in with a confusing message.
 */
(async function () {
  const gate = $("browser-gate");
  if (!gate || !window.api.browserStatus) return;
  const status = await window.api.browserStatus().catch(function () { return { ready: true }; });
  if (status.ready) return;

  gate.classList.add("show");
  const out = $("browser-progress");
  window.api.onBrowserProgress(function (line) { out.textContent = line; });

  $("browser-install").onclick = async function () {
    const btn = $("browser-install");
    btn.disabled = true;
    out.textContent = "Starting...";
    const r = await window.api.installBrowser();
    if (r && r.ok) {
      gate.classList.remove("show");
      toast("Browser ready");
    } else {
      btn.disabled = false;
      out.textContent = (r && r.error) || "Download failed.";
    }
  };
})();
```

In `desktop/styles.css` — tokens only, or Task 1 of the visual-identity work fails its lint:

```css
#browser-gate{position:fixed;inset:0;background:var(--overlay);display:none;
  align-items:center;justify-content:center;z-index:90;backdrop-filter:blur(3px);}
#browser-gate.show{display:flex;}
#browser-card{width:460px;background:var(--panel);border:1px solid var(--line-strong);
  border-radius:var(--r-lg);padding:var(--sp-6);box-shadow:var(--shadow-2);}
#browser-card p{font-size:12px;color:var(--dim);margin:var(--sp-3) 0 var(--sp-5);line-height:1.6;}
#browser-progress{font-family:ui-monospace,Consolas,monospace;font-size:11px;
  color:var(--mut);margin-top:var(--sp-4);min-height:16px;word-break:break-all;}
```

- [ ] **Step 6: Verify**

Run: `source scripts/wsl-env.sh && node --check desktop/browser-check.js && node --check desktop/main.js && node --check desktop/renderer.js && node local-agent/test/run-tests.cjs`
Expected: PASS, count up by 8.

Run: `cd desktop && npm start`
Expected: **no gate appears** — `app.isPackaged` is false in development, so the status is reported ready. The gate can only be seen in a packaged build; that is deliberate, since forcing a 389MB download on a machine that already has one would be the bug.

- [ ] **Step 7: Commit**

```bash
git add desktop/browser-check.js desktop/main.js desktop/preload.js desktop/index.html desktop/renderer.js desktop/styles.css local-agent/test/run-tests.cjs
git commit -m "Fetch Chromium on first run instead of shipping 389MB"
```

---

### Task 4: The icon electron-builder can actually use

**Files:**
- Create: `scripts/make-icon.mjs`, `build/icon.png`
- Test: `local-agent/test/run-tests.cjs`

**Interfaces:**
- Consumes: `build/icon.svg` from the visual-identity work.
- Produces: `build/icon.png`, 512×512.

**Why:** electron-builder does not accept SVG. It wants a PNG of at least 512×512 (or an `.ico`) and generates the rest. Rather than adding an image library, the icon is rasterised with the Chromium this project already depends on.

- [ ] **Step 1: Write the failing test**

Add to the existing `testLogo()` in `local-agent/test/run-tests.cjs`, after the SVG checks:

```javascript
  // electron-builder cannot read SVG. It needs a PNG of at least 512x512.
  const png = fs.readFileSync(path.join(__dirname, "..", "..", "build", "icon.png"));
  check("the png is a png", png.slice(1, 4).toString() === "PNG");
  // IHDR puts width and height at bytes 16-23, big-endian. No library needed.
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  check("the png is 512 wide", w === 512, String(w));
  check("the png is 512 tall", h === 512, String(h));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: FAIL — `ENOENT ... build/icon.png`

- [ ] **Step 3: Write the generator**

Create `scripts/make-icon.mjs`:

```javascript
/*
 * Rasterise build/icon.svg to build/icon.png at 512x512.
 *
 *   source scripts/wsl-env.sh
 *   node scripts/make-icon.mjs
 *
 * electron-builder cannot read SVG. Rather than add an image library for one
 * file, this uses the Chromium the project already depends on. The PNG is
 * committed, so a build never needs a browser - run this only when the mark
 * changes.
 */
import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

const repo = path.resolve(import.meta.dirname, "..");
const svg = fs.readFileSync(path.join(repo, "build", "icon.svg"), "utf-8");
const out = path.join(repo, "build", "icon.png");

// The mark is drawn in currentColor and lives on a dark ground in the app. An
// installer icon has no page behind it, so the background is painted here.
const page = `<!doctype html><html><body style="margin:0;background:#0b0b0c;color:#e8e8ea">
<div id="m" style="width:512px;height:512px;display:flex;align-items:center;justify-content:center">
  <div style="width:340px;height:340px">${svg}</div>
</div></body></html>`;

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 512, height: 512 } });
await p.setContent(page);
await p.locator("#m").screenshot({ path: out });
await browser.close();

const png = fs.readFileSync(out);
console.log("wrote " + out + "  " + png.readUInt32BE(16) + "x" + png.readUInt32BE(20));
```

- [ ] **Step 4: Generate the icon**

Run: `source scripts/wsl-env.sh && node scripts/make-icon.mjs`
Expected: `wrote .../build/icon.png  512x512`

- [ ] **Step 5: Run tests to verify they pass**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: PASS, count up by 4.

- [ ] **Step 6: Commit**

The PNG is committed deliberately — a build must not need a browser to produce an icon.

```bash
git add scripts/make-icon.mjs build/icon.png local-agent/test/run-tests.cjs
git commit -m "Rasterise the mark for electron-builder"
```

---

### Task 5: The build configuration

**Files:**
- Modify: `package.json`, `desktop/package.json`
- Test: `local-agent/test/run-tests.cjs`

**Interfaces:**
- Consumes: `build/icon.png` from Task 4.
- Produces: `npm run dist`, `npm run pack`.

- [ ] **Step 1: Write the failing test**

Add to `local-agent/test/run-tests.cjs`, above `function testToolchain()`:

```javascript
function testBuildConfig() {
  section("build configuration");
  const root = path.join(__dirname, "..", "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const b = pkg.build || {};

  check("the app entry point is the desktop main", pkg.main === "desktop/main.js", String(pkg.main));
  check("the version matches what the app calls itself", pkg.version === "1.0.0", String(pkg.version));
  check("desktop is a workspace", (pkg.workspaces || []).indexOf("desktop") !== -1);
  check("electron-builder is a dev dependency", !!(pkg.devDependencies || {})["electron-builder"]);
  check("electron is a dev dependency", !!(pkg.devDependencies || {}).electron);

  check("there is an app id", typeof b.appId === "string" && b.appId.length > 0);
  check("windows builds nsis", JSON.stringify((b.win || {}).target || []).indexOf("nsis") !== -1);
  check("linux builds an appimage", JSON.stringify((b.linux || {}).target || []).indexOf("AppImage") !== -1);
  check("linux builds a deb", JSON.stringify((b.linux || {}).target || []).indexOf("deb") !== -1);

  const icon = (b.win || {}).icon || b.icon;
  check("an icon is configured", !!icon, String(icon));
  check("the icon exists", fs.existsSync(path.join(root, String(icon))), String(icon));

  // The agent is spawned as a child process, and the provider configs are meant
  // to be edited by hand - glm.json says so in as many words.
  check("the agent is unpacked from the asar",
    JSON.stringify(b.asarUnpack || []).indexOf("local-agent") !== -1, JSON.stringify(b.asarUnpack));

  // --- the check that matters most ---
  // local-agent/storage holds live session cookies and private chat URLs.
  // .gitignore does not constrain electron-builder. An allow-list is used so
  // that a mistake is a missing file, not a published credential.
  const files = b.files || [];
  check("there is a files allow-list", files.length > 0);
  check("no catch-all glob", files.indexOf("**/*") === -1 && files.indexOf("**") === -1);
  const agentGlobs = files.filter(function (f) { return String(f).indexOf("local-agent") === 0; });
  check("only the agent's dist and config are included",
    agentGlobs.length > 0 && agentGlobs.every(function (f) {
      return f.indexOf("local-agent/dist") === 0 || f.indexOf("local-agent/config") === 0;
    }), agentGlobs.join(" "));
  ["local-agent/storage", ".superpowers", "docs", "samples", "app", "instance", "vscode-extension"]
    .forEach(function (dir) {
      check("nothing includes " + dir,
        files.every(function (f) { return String(f).indexOf(dir) !== 0; }), dir);
    });
}
```

Register it in `main()`:

```javascript
  testBrowserCheck();
  testBuildConfig();
  testTheme();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: FAIL — several, starting with "the app entry point is the desktop main".

- [ ] **Step 3: Rewrite the root package.json**

```json
{
  "name": "agentic-web-coder",
  "productName": "CloseNI",
  "version": "1.0.0",
  "private": true,
  "main": "desktop/main.js",
  "workspaces": ["shared", "local-agent", "vscode-extension", "desktop"],
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "start": "electron .",
    "pack": "electron-builder --dir",
    "dist": "electron-builder"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.5.4",
    "electron": "^31.0.0",
    "electron-builder": "^24.13.3"
  },
  "dependencies": {
    "playwright": "^1.62.1"
  },
  "build": {
    "appId": "com.siddarth.closeni",
    "productName": "CloseNI",
    "icon": "build/icon.png",
    "files": [
      "package.json",
      "desktop/**/*",
      "local-agent/dist/**/*",
      "local-agent/config/**/*",
      "build/icon.png"
    ],
    "asarUnpack": ["local-agent/**"],
    "win": { "target": ["nsis"], "icon": "build/icon.png" },
    "nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true },
    "linux": { "target": ["AppImage", "deb"], "icon": "build/icon.png", "category": "Development" }
  }
}
```

**The `files` array is an allow-list.** Nothing outside it is packaged. Do not
add a broad `local-agent/**` glob: that would sweep in `local-agent/storage`,
which holds live session cookies for the user's provider accounts.

- [ ] **Step 4: Trim desktop/package.json**

`electron` moves to the root so there is one copy rather than two. The `start`
script stays — `cd desktop && npm start` is the documented development command,
and npm adds ancestor `node_modules/.bin` to PATH, so the root Electron is found.

```json
{
  "name": "closeni-desktop",
  "version": "1.0.0",
  "private": true,
  "main": "main.js",
  "scripts": {
    "start": "electron ."
  }
}
```

- [ ] **Step 5: Reinstall and verify**

`desktop` becoming a workspace changes the `node_modules` layout, so a fresh
install is required:

```bash
source scripts/wsl-env.sh && rm -rf desktop/node_modules && npm install
```

Then confirm Electron is the Linux build, not `electron.exe` — the README warns
about this and it is the most common way this environment breaks:

Run: `source scripts/wsl-env.sh && ls node_modules/electron/dist/electron`
Expected: the file exists.

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: PASS, count up by 20.

Run: `cd desktop && npm start`
Expected: the window still opens.

- [ ] **Step 6: Build a package and inspect it**

This is the step that proves the allow-list. `--dir` skips installer creation,
which is much faster and enough to check the contents:

```bash
source scripts/wsl-env.sh && npm run pack
```

Then verify no credential made it in:

```bash
find dist/linux-unpacked -path '*local-agent/storage*' | head
```

Expected: **no output.** Any line here is a leaked session and must be fixed
before going further.

```bash
ls dist/linux-unpacked/resources/app.asar.unpacked/local-agent/
```

Expected: `config` and `dist` — the agent is unpacked and editable.

- [ ] **Step 7: Commit**

```bash
git add package.json desktop/package.json package-lock.json local-agent/test/run-tests.cjs
git commit -m "Package from the root with an allow-list, not an exclude-list"
```

---

### Task 6: Releases on a tag

**Files:**
- Create: `.github/workflows/release.yml`
- Test: `local-agent/test/run-tests.cjs`

**Interfaces:**
- Consumes: `npm run dist` from Task 5.
- Produces: a GitHub Release per `v*` tag.

- [ ] **Step 1: Write the failing test**

Add to `local-agent/test/run-tests.cjs`, above `function testToolchain()`:

```javascript
function testReleaseWorkflow() {
  section("release workflow");
  const wf = path.join(__dirname, "..", "..", ".github", "workflows", "release.yml");
  check("the workflow exists", fs.existsSync(wf));
  if (!fs.existsSync(wf)) return;
  const y = fs.readFileSync(wf, "utf8");

  // No YAML parser is available here, so this is a structural check rather than
  // a parse. It catches the breakages that actually happen; it does not prove
  // the file is valid YAML.
  check("tabs would break the yaml", y.indexOf("\t") === -1);
  check("it triggers on a tag", /tags:\s*\n\s*-\s*["']?v/.test(y), "no v* tag trigger");
  check("it builds on windows", y.indexOf("windows-latest") !== -1);
  check("it builds on linux", y.indexOf("ubuntu-latest") !== -1);
  check("it installs with a lockfile", y.indexOf("npm ci") !== -1);
  check("it compiles the agent before packaging", y.indexOf("npm run build") !== -1);
  check("it runs the unit suite", y.indexOf("run-tests.cjs") !== -1);
  // The e2e suite drives a real browser for about fifteen minutes. It stays a
  // local gate; running it on every tag is a poor trade.
  check("it does not run the e2e suite", y.indexOf("run-e2e.cjs") === -1);
  check("it publishes", y.indexOf("--publish") !== -1 || y.indexOf("GH_TOKEN") !== -1);
}
```

Register it in `main()`:

```javascript
  testBuildConfig();
  testReleaseWorkflow();
  testTheme();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: FAIL — "the workflow exists".

- [ ] **Step 3: Write the workflow**

Create `.github/workflows/release.yml`:

```yaml
# Builds installers and attaches them to a GitHub Release.
#
#   git tag v1.0.0 && git push --tags
#
# Windows installers must be built on Windows, which is the whole reason this
# exists: there is no Windows machine in the development environment.
name: release

on:
  push:
    tags:
      - "v*"

permissions:
  contents: write

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: npm

      - name: Install
        run: npm ci

      - name: Compile the agent
        run: npm run build

      # The unit suite is fast and catches a broken build config before it
      # produces an artifact. The end-to-end suite drives a real browser for
      # around fifteen minutes and stays a local gate.
      - name: Unit tests
        run: node local-agent/test/run-tests.cjs

      - name: Build and publish
        run: npx electron-builder --publish always
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: PASS, count up by 9.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml local-agent/test/run-tests.cjs
git commit -m "Build installers on a tag"
```

---

### Task 7: Documentation, full suite, merge

**Files:**
- Modify: `README.md`, `docs/ROADMAP.md`, `.gitignore`

- [ ] **Step 1: Ignore the build output**

`electron-builder` writes to `dist/`. Add to `.gitignore`:

```
dist/
```

Check this does not shadow `local-agent/dist/`, which is compiled output that is
already ignored separately — confirm with:

Run: `git check-ignore -v local-agent/dist/index.js`
Expected: a line naming the rule. If it names the new `dist/` rule that is still
correct; both are build output.

- [ ] **Step 2: Document installing and releasing**

Add to `README.md`, after the existing run instructions:

```markdown
## Installing a release

Download the installer for your platform from the Releases page. Windows gets
an `.exe`; Linux gets an AppImage and a `.deb`.

**Builds are unsigned.** Windows SmartScreen will warn on first run — code
signing needs a paid certificate. Choose "More info" then "Run anyway", or
build it yourself with `npm run dist`.

**First launch downloads a browser.** CloseNI drives real browsers to talk to AI
providers and needs its own Chromium, about 389MB. It downloads once, is kept in
your user data directory, and survives reinstalling. This needs a network
connection; there is no offline install.

Settings, sessions and browser profiles live in your user data directory
(`%APPDATA%/CloseNI` on Windows, `~/.config/CloseNI` on Linux), never beside the
application — a packaged app cannot write to its own install directory.

## Cutting a release

```bash
git tag v1.0.0
git push --tags
```

GitHub Actions builds the Windows installer on a Windows runner and the Linux
packages on Ubuntu, then attaches both to a Release for the tag. Build locally
with `npm run dist` (current platform only) or `npm run pack` for an unpacked
directory.
```

- [ ] **Step 3: Update the roadmap**

Replace the sub-project 8 section of `docs/ROADMAP.md`:

```markdown
## 8 · Distribution — DONE

Roadmap item 28. Spec: `specs/2026-08-10-distribution-design.md`,
plan: `plans/2026-08-10-distribution.md`

- **28. Releases page, Windows + Linux packages** — `done`. electron-builder
  produces an NSIS `.exe`, an AppImage and a `.deb`; GitHub Actions builds all
  three on a `v*` tag and attaches them to a Release.

  The packaging config was the small part. Three defects blocked it and were
  fixed first: the app wrote state into its own install directory (on Windows,
  `Program Files` — it would have failed to save a session at all), it spawned
  `node` and cannot assume Node exists on a user's machine, and Playwright's
  Chromium is 389MB. State now lives in `userData`, the agent runs on Electron's
  own binary via `ELECTRON_RUN_AS_NODE`, and the browser is fetched on first run
  behind a gate rather than shipped.

  `local-agent/storage/` holds live session cookies, and `.gitignore` does not
  constrain electron-builder, so the `files` config is an explicit allow-list
  with a test asserting nothing under `storage` can match. A forgotten exclusion
  would publish authenticated sessions to a public release; a forgotten
  inclusion just fails loudly.

  Not done, deliberately: code signing (needs a paid certificate), macOS (no Mac
  to test on), and auto-update (untrustworthy unsigned).
```

Update the header count on line 3 to **7 of 9 complete** and add
`8 · Distribution` to the list.

- [ ] **Step 4: Run the full suite**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json \
  && node local-agent/test/run-tests.cjs \
  && node local-agent/test/run-e2e.cjs > /tmp/e2e.log 2>&1; tail -3 /tmp/e2e.log
```

Expected: both PASS. The e2e count must still be 150 — if it dropped, Task 1
changed the `CLOSENI_STORAGE`-unset path and broke the suite's storage layout.

- [ ] **Step 5: Commit and merge**

```bash
git add -A
git commit -m "Document installing and releasing"
git checkout main && git merge --no-ff distribution -m "Merge distribution: item 28"
git push origin main
```

- [ ] **Step 6: Cut the first release**

```bash
git tag v1.0.0 && git push --tags
```

Then watch the run: `gh run watch`. When it finishes, download the artifact for
this platform and **actually launch it** — this is the first evidence that any
of it works. Check in order: the window opens, the browser gate appears and
downloads, a provider sign-in succeeds, and `~/.config/CloseNI/browser-profiles/`
holds the profile.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Storage moves to userData, passed as env var | 1, 2 |
| `CLOSENI_STORAGE`-unset path preserved for tests | 1 (tested), 7 (e2e re-run) |
| No profile migration | Heads-up section; no task, deliberately |
| Agent runs on Electron via `ELECTRON_RUN_AS_NODE` | 2 |
| `main.js` sessions path agrees with the agent | 2 Step 3 |
| `PLAYWRIGHT_BROWSERS_PATH` only when packaged | 2, 3 |
| First-run gate with progress | 3 |
| Playwright CLI, not internal registry | 3 Step 4 |
| Build from repo root, desktop as workspace | 5 |
| Version unified to 1.0.0 | 5 |
| `desktop/package.json` keeps `start` | 5 Step 4 |
| Allow-list, storage never packaged | 5 (tested twice: config + packed output) |
| `asarUnpack` for local-agent | 5 |
| NSIS / AppImage / deb, icon | 4, 5 |
| GitHub Actions on `v*` | 6 |
| e2e not run in CI | 6 (asserted absent) |
| Non-goals: signing, macOS, auto-update | 7 (recorded in README and ROADMAP) |

**Gap found and closed:** the spec says electron-builder uses `build/icon.svg`.
It cannot — electron-builder does not accept SVG. Task 4 was added to rasterise
it to a committed 512×512 PNG using the Chromium the project already depends on,
rather than adding an image library for one file.

**Type consistency:** `storagePaths`, `StoragePaths`, `hasChromium`,
`storageRoot`, `spawnAgent`, `browsersDir` and the IPC names
`browser-status` / `install-browser` / `browser-progress` are used identically
across tasks. `agentEnv` changes shape in Task 2 — from a full merged
environment to just its own keys — and all four call sites are updated in the
same step.

**Known risks, stated rather than hidden:**

1. **No installer is verified here.** No Windows machine, no way to launch an
   AppImage. Green tests mean the configuration is coherent. Task 7 Step 6 is
   the first real evidence and it needs a human.
2. **Task 5 Step 5 reinstalls `node_modules`.** In this WSL setup that is the
   step most likely to break, by fetching `electron.exe` instead of the Linux
   build. The step checks for it explicitly.
3. **The packaged storage layout is exercised by no automated test**, only by
   `storagePaths`' unit tests. That is why it is a pure function rather than
   logic inlined at two call sites.
