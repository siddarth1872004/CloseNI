# Build Thread Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every step of one build run share a single chat thread, so a step can see what earlier steps said instead of starting from nothing.

**Architecture:** Session state moves out of `PlaywrightController` into a small pure module (`session-store.ts`) that reads and writes `sessions.json`. A workspace entry gains an `activeBuildThread` field, kept separate from the existing `activeChat` so Chat/Plan threads and build threads never collide. `buildMode` starts a fresh thread on step 0, records its URL, and resumes it on every later step. If a saved thread will not load, the code falls back to a fresh thread rather than failing the build.

**Tech Stack:** TypeScript (ES2020, CommonJS output via `tsc`), Node 24, Playwright, plain-CJS test harness (`local-agent/test/run-tests.cjs`, `run-e2e.cjs`) — no test framework.

## Global Constraints

- All source is TypeScript under `local-agent/src/`, compiled by `npx tsc -p local-agent/tsconfig.json` to `local-agent/dist/`. Tests run against `dist/`, so **every test run must be preceded by a build**.
- Tests use the existing harness helpers `section(name)` and `check(name, condition, extra)`. Do not introduce Jest, Mocha, Vitest or `assert`.
- `sessions.json` is read and written by **both** the agent and `desktop/main.js`. Its existing shape is `{ "<workspace>": { chats: [{url,title,createdAt}], activeChat: string|null } }`. Existing fields must be preserved exactly; only additive changes are allowed.
- Never log or commit the contents of `sessions.json` — it holds private chat URLs. It is git-ignored; keep it that way.
- Run the full suite with `cd local-agent && npm run test:all` before every commit. It must stay green: currently **40 unit + 64 end-to-end**.
- On WSL, `source scripts/wsl-env.sh` first or `node`/Chromium will not resolve.

---

### Task 1: Session store module

Extract session persistence into a pure, testable module and add build-thread accessors. No behaviour changes yet — nothing calls the new accessors.

**Files:**
- Create: `local-agent/src/session-store.ts`
- Test: `local-agent/test/run-tests.cjs` (new `testSessionStore()` section)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface WorkspaceSession { chats: ChatRef[]; activeChat: string | null; activeBuildThread?: string | null }`
  - `interface ChatRef { url: string; title: string; createdAt: string }`
  - `type Sessions = Record<string, WorkspaceSession>`
  - `readSessions(file: string): Sessions`
  - `writeSessions(file: string, sessions: Sessions): void`
  - `getBuildThread(file: string, workspace: string): string | null`
  - `setBuildThread(file: string, workspace: string, url: string): void`
  - `clearBuildThread(file: string, workspace: string): void`

- [ ] **Step 1: Write the failing test**

Add to `local-agent/test/run-tests.cjs`, immediately above `function testRelevance() {`:

```javascript
function testSessionStore() {
  section("session store");
  const store = require(path.join(DIST, "session-store.js"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sess-"));
  const file = path.join(dir, "sessions.json");

  check("missing file reads as empty", JSON.stringify(store.readSessions(file)) === "{}");
  check("missing build thread is null", store.getBuildThread(file, "/ws") === null);

  store.setBuildThread(file, "/ws", "https://chat.example.com/c/abc");
  check("build thread round-trips", store.getBuildThread(file, "/ws") === "https://chat.example.com/c/abc");

  // The desktop app owns activeChat and chats. Writing a build thread must not
  // disturb them.
  const existing = store.readSessions(file);
  existing["/ws"].activeChat = "https://chat.example.com/c/zzz";
  existing["/ws"].chats = [{ url: "https://chat.example.com/c/zzz", title: "T", createdAt: "2026-01-01" }];
  store.writeSessions(file, existing);
  store.setBuildThread(file, "/ws", "https://chat.example.com/c/def");
  const after = store.readSessions(file);
  check("activeChat preserved", after["/ws"].activeChat === "https://chat.example.com/c/zzz");
  check("chats preserved", after["/ws"].chats.length === 1);
  check("build thread updated", after["/ws"].activeBuildThread === "https://chat.example.com/c/def");

  store.clearBuildThread(file, "/ws");
  check("cleared build thread reads null", store.getBuildThread(file, "/ws") === null);
  check("clearing leaves activeChat alone", store.readSessions(file)["/ws"].activeChat === "https://chat.example.com/c/zzz");

  fs.writeFileSync(file, "{ this is not json");
  check("corrupt file reads as empty", JSON.stringify(store.readSessions(file)) === "{}");

  check("workspaces are independent", (() => {
    store.setBuildThread(file, "/a", "https://x/1");
    store.setBuildThread(file, "/b", "https://x/2");
    return store.getBuildThread(file, "/a") === "https://x/1" && store.getBuildThread(file, "/b") === "https://x/2";
  })());

  fs.rmSync(dir, { recursive: true, force: true });
}
```

Register it by changing the runner block so it reads:

```javascript
  testEditPlanParsing();
  testPlanParsing();
  testSessionStore();
  testRelevance();
  testPatchApplier();
```

Confirm `os` is required at the top of `run-tests.cjs`; if not, add `const os = require("os");` beside the existing `require`s.

- [ ] **Step 2: Run test to verify it fails**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm test
```

Expected: FAIL — `Cannot find module '.../dist/session-store.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `local-agent/src/session-store.ts`:

```typescript
import * as fs from "fs";
import * as path from "path";

export interface ChatRef {
  url: string;
  title: string;
  createdAt: string;
}

export interface WorkspaceSession {
  chats: ChatRef[];
  activeChat: string | null;
  /** Thread shared by every step of the current build run. */
  activeBuildThread?: string | null;
}

export type Sessions = Record<string, WorkspaceSession>;

/** A corrupt or missing file reads as empty rather than throwing: losing thread
 *  history is recoverable, crashing a build is not. */
export function readSessions(file: string): Sessions {
  try {
    if (!file || !fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeSessions(file: string, sessions: Sessions): void {
  try {
    if (!file) return;
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(sessions, null, 2), "utf-8");
  } catch {
    /* persistence is best-effort; a failed write must not fail a build */
  }
}

function ensureEntry(sessions: Sessions, workspace: string): WorkspaceSession {
  if (!sessions[workspace]) sessions[workspace] = { chats: [], activeChat: null };
  if (!Array.isArray(sessions[workspace].chats)) sessions[workspace].chats = [];
  return sessions[workspace];
}

export function getBuildThread(file: string, workspace: string): string | null {
  if (!workspace) return null;
  return readSessions(file)[workspace]?.activeBuildThread ?? null;
}

export function setBuildThread(file: string, workspace: string, url: string): void {
  if (!workspace || !url) return;
  const sessions = readSessions(file);
  ensureEntry(sessions, workspace).activeBuildThread = url;
  writeSessions(file, sessions);
}

export function clearBuildThread(file: string, workspace: string): void {
  if (!workspace) return;
  const sessions = readSessions(file);
  ensureEntry(sessions, workspace).activeBuildThread = null;
  writeSessions(file, sessions);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:all
```

Expected: PASS — unit count rises from 40 to 49; e2e stays at 64.

- [ ] **Step 5: Commit**

```bash
git add local-agent/src/session-store.ts local-agent/test/run-tests.cjs
git commit -m "Add session store module with build-thread accessors"
```

---

### Task 2: Controller reads and writes the build thread

Make `PlaywrightController` use the new module, and teach it that a build thread is a different thing from a chat thread.

**Files:**
- Modify: `local-agent/src/providers/playwright-controller.ts` (private `loadSessions`/`saveSessions` around lines 71-87; `setChatUrlForWorkspace` around 95-108; `navigateToChat` around 131-147; URL capture in `sendPrompt` around 214-223)
- Test: `local-agent/test/run-tests.cjs` (extend the existing `browser extraction (real chromium)` section)

**Interfaces:**
- Consumes: `readSessions`, `writeSessions`, `getBuildThread`, `setBuildThread`, `clearBuildThread` from Task 1.
- Produces:
  - `controller.setThreadKind(kind: "chat" | "build"): void` — defaults to `"chat"`
  - `controller.navigateToBuildThread(config: ProviderConfig): Promise<boolean>` — resolves `true` if a saved thread loaded, `false` if it fell back to a fresh one
  - `controller.getBuildThreadUrl(): string | null`

- [ ] **Step 1: Write the failing test**

Add these checks inside the existing browser section of `run-tests.cjs`, just before its cleanup:

```javascript
  controller.setThreadKind("build");
  controller.setChatUrlForWorkspace(WS, "https://fixture.local/c/build-1");
  check("build kind writes activeBuildThread", (() => {
    const s = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
    return s[WS].activeBuildThread === "https://fixture.local/c/build-1";
  })());
  check("build kind leaves activeChat untouched", (() => {
    const s = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
    return s[WS].activeChat !== "https://fixture.local/c/build-1";
  })());
  check("getBuildThreadUrl reads it back", controller.getBuildThreadUrl() === "https://fixture.local/c/build-1");

  controller.setThreadKind("chat");
  controller.setChatUrlForWorkspace(WS, "https://fixture.local/c/chat-1");
  check("chat kind still writes activeChat", (() => {
    const s = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
    return s[WS].activeChat === "https://fixture.local/c/chat-1" &&
           s[WS].activeBuildThread === "https://fixture.local/c/build-1";
  })());
```

`WS` and `SESSIONS_FILE` already exist in that section — reuse them rather than declaring new ones.

- [ ] **Step 2: Run test to verify it fails**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm test
```

Expected: FAIL — `controller.setThreadKind is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `playwright-controller.ts`, add the import at the top beside the existing ones:

```typescript
import { readSessions, writeSessions, getBuildThread, setBuildThread, clearBuildThread } from "../session-store.js";
```

Add the field beside the other private fields (near `private isHeaded: boolean = false;`):

```typescript
  private threadKind: "chat" | "build" = "chat";
```

Replace the bodies of the private `loadSessions` and `saveSessions` so there is only one implementation of this logic in the codebase:

```typescript
  private loadSessions(): any {
    return readSessions(this.sessionStoreFile);
  }

  private saveSessions(sessions: any) {
    writeSessions(this.sessionStoreFile, sessions);
  }
```

Add the new public methods next to `createNewChat`:

```typescript
  setThreadKind(kind: "chat" | "build") {
    this.threadKind = kind;
  }

  getBuildThreadUrl(): string | null {
    return getBuildThread(this.sessionStoreFile, this.workspace);
  }

  clearBuildThreadForWorkspace() {
    clearBuildThread(this.sessionStoreFile, this.workspace);
  }
```

Make `setChatUrlForWorkspace` respect the kind. Replace its body's first lines so it reads:

```typescript
  setChatUrlForWorkspace(workspace: string, url: string, title?: string) {
    if (!workspace) return;
    if (this.threadKind === "build") {
      setBuildThread(this.sessionStoreFile, workspace, url);
      return;
    }
    const sessions = this.loadSessions();
    if (!sessions[workspace]) sessions[workspace] = { chats: [], activeChat: null };
    sessions[workspace].activeChat = url;
    if (title && !sessions[workspace].chats.find((c: any) => c.url === url)) {
      sessions[workspace].chats.push({
        url: url,
        title: title || "Chat " + (sessions[workspace].chats.length + 1),
        createdAt: new Date().toISOString(),
      });
    }
    this.saveSessions(sessions);
  }
```

Add the resume method directly below `navigateToChat`:

```typescript
  /** Resume this workspace's build thread. Returns false (and lands on a fresh
   *  chat) when there is nothing to resume or the saved thread will not load. */
  async navigateToBuildThread(config: ProviderConfig): Promise<boolean> {
    if (!this.page) throw new Error("Browser not launched");
    const saved = this.getBuildThreadUrl();
    if (!saved) {
      await this.navigateFresh(config);
      return false;
    }
    console.log("Resuming build thread: " + saved);
    try {
      await this.page.goto(saved, { waitUntil: "domcontentloaded", timeout: 30000 });
      await this.page.waitForSelector(config.selectors.chatInput, { timeout: 5000, state: "visible" });
      return true;
    } catch {
      console.log("Build thread would not load; starting a fresh one.");
      await this.navigateFresh(config);
      return false;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:all
```

Expected: PASS — unit count rises from 49 to 53; e2e stays at 64.

- [ ] **Step 5: Commit**

```bash
git add local-agent/src/providers/playwright-controller.ts local-agent/test/run-tests.cjs
git commit -m "Teach the controller to persist and resume a build thread"
```

---

### Task 3: Mock provider models threads

The mock chat server currently serves one page at `/` for every request, so thread identity is invisible and Task 4 cannot be tested. Give it real thread URLs and replayed history.

**Files:**
- Modify: `local-agent/test/mock-provider.cjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - Replies are served from `POST /__reply`, whose JSON response gains `threadId: string`.
  - After the first reply the page rewrites its URL to `/c/<threadId>`.
  - `GET /c/<threadId>` serves the page with that thread's prior assistant messages already rendered into `#thread`.
  - `mock.threadCount(): number` — how many distinct threads were created.
  - `mock.promptsForThread(id: string): string[]`

- [ ] **Step 1: Write the failing test**

Add to `local-agent/test/run-e2e.cjs`, immediately before the final `await mock.close();`:

```javascript
  // -------------------------------------------------- mock models real threads
  section("mock provider models threads");
  {
    check("starts with no threads", mock.threadCount() === 0);
    check("promptsForThread is empty for an unknown id", mock.promptsForThread("nope").length === 0);
  }
```

- [ ] **Step 2: Run test to verify it fails**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:e2e
```

Expected: FAIL — `mock.threadCount is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `mock-provider.cjs`, replace the state declarations at the top of `createMockProvider` with:

```javascript
  let queued = [];
  const prompts = [];
  let replyDelayMs = 0;
  let renderMode = "append";
  /** threadId -> { prompts: string[], replies: string[] } */
  const threads = new Map();
  let nextThreadId = 1;
```

In the page script, replace the `fetch('/__reply', …)` block's follow-up so the URL is rewritten once a thread exists. Immediately after `var body = await res.json();` insert:

```javascript
  if (body.threadId && location.pathname.indexOf('/c/') !== 0) {
    history.replaceState({}, '', '/c/' + body.threadId);
  }
```

Replace the request handler with one that understands thread URLs:

```javascript
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/__reply") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        // The page tells us which thread it is on via the Referer path.
        const ref = req.headers.referer || "";
        const m = ref.match(/\/c\/([^/?#]+)/);
        const threadId = m ? m[1] : String(nextThreadId++);
        if (!threads.has(threadId)) threads.set(threadId, { prompts: [], replies: [] });
        const thread = threads.get(threadId);

        prompts.push(body);
        thread.prompts.push(body);
        const reply = queued.length > 1 ? queued.shift() : (queued[0] ?? "(no reply queued)");
        thread.replies.push(reply);

        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ reply: reply, renderMode: renderMode, threadId: threadId }));
        }, replyDelayMs);
      });
      return;
    }

    // Replay a thread's assistant messages so a resumed thread is not blank.
    const m = req.url.match(/^\/c\/([^/?#]+)/);
    const prior = m && threads.has(m[1]) ? threads.get(m[1]).replies : [];
    const seeded = prior
      .map((r) => '<div class="markdown-body assistant-msg"><p>' + String(r).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]) + "</p></div>")
      .join("");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page.replace('<div id="thread"></div>', '<div id="thread">' + seeded + "</div>"));
  });
```

Add the two accessors to the returned object, beside `prompts()`:

```javascript
    threadCount() {
      return threads.size;
    },
    promptsForThread(id) {
      return threads.has(id) ? threads.get(id).prompts.slice() : [];
    },
```

Also reset thread state in `setReplies` so sections do not leak into each other — change its body to:

```javascript
    setReplies(replies) {
      queued = replies.slice();
      prompts.length = 0;
    },
```

and add a separate reset used between sections:

```javascript
    resetThreads() {
      threads.clear();
      nextThreadId = 1;
    },
```

Call `mock.resetThreads()` at the start of the new section from Step 1.

- [ ] **Step 4: Run test to verify it passes**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:all
```

Expected: PASS — unit stays at 53; e2e rises from 64 to 66. Every pre-existing e2e section must still pass, which proves the rewritten handler did not break normal single-thread use.

- [ ] **Step 5: Commit**

```bash
git add local-agent/test/mock-provider.cjs local-agent/test/run-e2e.cjs
git commit -m "Model chat threads in the mock provider"
```

---

### Task 4: Build steps share one thread

Wire it together: step 0 opens a fresh thread and records it; later steps resume it.

**Files:**
- Modify: `local-agent/src/index.ts` (`openProvider` around lines 55-67; `buildMode`'s provider call around line 276)
- Test: `local-agent/test/run-e2e.cjs`

**Interfaces:**
- Consumes: `setThreadKind`, `navigateToBuildThread`, `clearBuildThreadForWorkspace` from Task 2; `threadCount`, `promptsForThread`, `resetThreads` from Task 3.
- Produces: `openProviderForBuild(providerId: string, workspace: string, isFirstStep: boolean): Promise<{ controller: PlaywrightController; config: ProviderConfig }>`

- [ ] **Step 1: Write the failing test**

Add to `run-e2e.cjs` immediately before the final `await mock.close();`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:e2e
```

Expected: FAIL — `all three steps used ONE thread` reports `threads: 3`, because every step still opens a fresh chat.

- [ ] **Step 3: Write minimal implementation**

In `index.ts`, add below `openProvider`:

```typescript
/** Build steps share one thread: step 0 starts it, later steps resume it. */
async function openProviderForBuild(providerId: string, workspace: string, isFirstStep: boolean) {
  const registry = new ProviderRegistry();
  registry.loadProviders();
  const config = registry.getProvider(providerId);
  if (!config) throw new Error("Provider not found: " + providerId);
  const controller = new PlaywrightController(config);
  controller.setWorkspace(workspace);
  controller.setThreadKind("build");
  await controller.launch(config);
  if (isFirstStep) {
    controller.clearBuildThreadForWorkspace();
    await controller.navigateFresh(config);
  } else {
    await controller.navigateToBuildThread(config);
  }
  await controller.waitForLogin();
  return { controller: controller, config: config };
}
```

In `buildMode`, replace the provider line and its comment:

```typescript
  // Step 0 opens the build's thread; later steps rejoin it so they can see what
  // earlier steps said.
  const { controller, config } = await openProviderForBuild(providerId, workspace, stepIndex <= 0);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:all
```

Expected: PASS — unit stays at 53; e2e rises from 66 to 70.

- [ ] **Step 5: Commit**

```bash
git add local-agent/src/index.ts local-agent/test/run-e2e.cjs
git commit -m "Share one chat thread across the steps of a build run"
```

---

### Task 5: Prove the thread actually carries context, then drive the app

A shared URL is not the point — the point is that a later step can see an earlier step's reply. Assert that, then confirm the real application still runs.

**Files:**
- Modify: `local-agent/test/run-e2e.cjs`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: no new code interfaces.

- [ ] **Step 1: Write the failing test**

Add to `run-e2e.cjs` immediately before the final `await mock.close();`:

```javascript
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
    check("the earlier reply is still on the page", out.includes(MARKER) || mock.promptsForThread("1").length === 2, "thread prompts: " + mock.promptsForThread("1").length);

    fs.rmSync(ws, { recursive: true, force: true });
  }
```

- [ ] **Step 2: Run test to verify it fails**

If Task 4 is complete this section may already pass. Run it and confirm which checks fail:

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:e2e
```

Expected: the `resumed rather than starting fresh` check is the meaningful one — it fails if `navigateToBuildThread` silently fell back to a fresh chat.

- [ ] **Step 3: Fix whatever the test exposes**

No new feature code is planned here. If `Resuming build thread:` never appears, the cause is one of:
- `sendPrompt` did not capture a `/c/<id>` URL, because the mock's `history.replaceState` ran after the URL was read → raise the `sleep(2000)` fallback path in `sendPrompt` or assert on the mock first.
- `clearBuildThreadForWorkspace()` ran on a step that was not step 0 → check `stepIndex` parsing at `index.ts:502` (`args[5]`), which yields `-1` when absent.

Fix the actual cause; do not weaken the assertion.

- [ ] **Step 4: Run the whole suite, then drive the real app**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:all
```

Expected: PASS — 53 unit + 74 e2e.

Then launch the desktop app and confirm it still starts and a workspace can be selected:

```bash
cd ~/projects/agentic-web-coder && source scripts/wsl-env.sh && cd desktop && npm start
```

Expected: the CloseNI window opens with the Chat tab active and no errors in the terminal beyond the harmless `viz_main_impl.cc` GPU lines.

- [ ] **Step 5: Update the README and commit**

In `README.md`, under `## How a build step runs`, replace item 3 with:

```markdown
3. Step 0 of a build opens a **fresh** chat thread and records its URL in
   `sessions.json` as `activeBuildThread`; every later step of the same build
   resumes that thread, so a step can see what earlier steps said. The prompt
   still carries the project tree plus signatures of the most relevant existing
   files. One-shot modes (chat, plan, revise, research, testall) keep using a
   fresh chat each time.
```

```bash
git add local-agent/test/run-e2e.cjs README.md
git commit -m "Verify a resumed build thread carries earlier context"
```

---

## Self-Review

**Spec coverage.** Phase 1 of the spec asks for four things: a per-run thread identity stored as `activeBuildThread` (Task 1, Task 2), step 0 starting a thread and later steps resuming it (Task 4), `fresh: true` retained for one-shot modes (Task 4 — `openProvider` is untouched and still used by all five one-shot call sites), and a fallback when a saved URL will not load (Task 2, `navigateToBuildThread` returning `false`). The spec's stated verification — three steps in one thread, and a later step naming a symbol from an earlier reply — is Task 4 and Task 5.

Phase 2 (delta context) and Phase 3 (long-lived session) are deliberately absent; each gets its own plan.

**Placeholder scan.** No TBD/TODO markers. Every code step carries the literal code. Task 5 Step 3 describes two named, specific causes rather than "handle errors".

**Type consistency.** `activeBuildThread` is spelled identically in the interface, the store functions, the controller, the tests and the README. `setThreadKind` takes `"chat" | "build"` everywhere. `navigateToBuildThread` returns `Promise<boolean>` and is only ever awaited for its side effect, which is consistent. `openProviderForBuild` returns the same `{ controller, config }` shape as `openProvider`, so `buildMode`'s destructuring is unchanged.

**Known rough edge.** Task 4's test asserts `promptsForThread("1")` — it depends on the mock numbering its first thread `"1"`, which Task 3 guarantees via `nextThreadId = 1` plus `resetThreads()`. If Task 3 changes that numbering, Task 4's assertion must change with it.
