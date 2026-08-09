# Delta Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop re-sending the model files it has already been shown, so later steps of a build carry a small prompt instead of the whole project every time.

**Architecture:** A build run keeps a *ledger* of what its thread has been shown — one entry per workspace file, holding a content hash. The ledger lives in `sessions.json` beside `activeBuildThread` and is reset when a build starts, because every step is still a separate process at this phase. Before each step the agent hashes every source file: a file is **new** if the ledger has never seen it and **changed** if its hash differs. Only new and changed files are ranked and sent; everything else the thread already holds. The project tree is sent the same way — only paths that appeared since the previous step.

**Tech Stack:** TypeScript (ES2020, CommonJS output via `tsc`), Node 24, Node's built-in `crypto` for hashing, plain-CJS test harness (`local-agent/test/run-tests.cjs`, `run-e2e.cjs`) — no test framework.

## Global Constraints

- All source is TypeScript under `local-agent/src/`, compiled by `npx tsc -p local-agent/tsconfig.json` to `local-agent/dist/`. Tests run against `dist/`, so **every test run must be preceded by a build**.
- Tests use the existing harness helpers `section(name)` and `check(name, condition, extra)`. Do not introduce Jest, Mocha, Vitest or `assert`.
- `sessions.json` is read and written by **both** the agent and `desktop/main.js`. Existing fields (`chats`, `activeChat`, `activeBuildThread`) must be preserved exactly; only additive changes are allowed.
- Never log or commit the contents of `sessions.json` — it holds private chat URLs. It is git-ignored; keep it that way.
- Run the full suite with `cd local-agent && npm run test:all` before every commit. It must stay green: currently **57 unit + 76 end-to-end**.
- On WSL, `source scripts/wsl-env.sh` first or `node`/Chromium will not resolve.
- **Step 0 of a build must behave exactly as it does today.** An empty ledger means every file is new, so the first step's prompt is unchanged. All savings come from step 2 onward.

---

### Task 1: Ledger storage

Add ledger persistence to the session store. Nothing reads it yet.

**Files:**
- Modify: `local-agent/src/session-store.ts`
- Test: `local-agent/test/run-tests.cjs` (extend `testSessionStore()`)

**Interfaces:**
- Consumes: `readSessions`, `writeSessions` (already in `session-store.ts`).
- Produces:
  - `interface LedgerEntry { hash: string | null; step: number }` — `hash` is `null` when the path was only listed in the tree, never sent as signatures.
  - `type BuildLedger = Record<string, LedgerEntry>`
  - `getBuildLedger(file: string, workspace: string): BuildLedger`
  - `setBuildLedger(file: string, workspace: string, ledger: BuildLedger): void`
  - `resetBuildRun(file: string, workspace: string): void` — clears **both** `activeBuildThread` and `buildLedger`.

- [ ] **Step 1: Write the failing test**

Append inside `testSessionStore()` in `local-agent/test/run-tests.cjs`, immediately before its `fs.rmSync(dir, ...)` line:

```javascript
  // --- build ledger
  const lf = path.join(dir, "ledger.json");
  check("missing ledger reads as empty", JSON.stringify(store.getBuildLedger(lf, "/ws")) === "{}");

  store.setBuildLedger(lf, "/ws", { "a.py": { hash: "h1", step: 0 }, "b.py": { hash: null, step: 0 } });
  const led = store.getBuildLedger(lf, "/ws");
  check("ledger round-trips", led["a.py"].hash === "h1" && led["b.py"].hash === null, JSON.stringify(led));
  check("ledger records the step", led["a.py"].step === 0);

  store.setBuildThread(lf, "/ws", "https://chat.example.com/c/run1");
  store.setBuildLedger(lf, "/ws", { "a.py": { hash: "h2", step: 1 } });
  check("ledger and thread coexist", store.getBuildThread(lf, "/ws") === "https://chat.example.com/c/run1" && store.getBuildLedger(lf, "/ws")["a.py"].hash === "h2");

  store.resetBuildRun(lf, "/ws");
  check("resetBuildRun clears the thread", store.getBuildThread(lf, "/ws") === null);
  check("resetBuildRun clears the ledger", JSON.stringify(store.getBuildLedger(lf, "/ws")) === "{}");

  // The desktop app's fields must survive a reset.
  const s2 = store.readSessions(lf);
  s2["/ws"].activeChat = "https://chat.example.com/c/keepme";
  store.writeSessions(lf, s2);
  store.setBuildLedger(lf, "/ws", { "z.py": { hash: "h9", step: 3 } });
  store.resetBuildRun(lf, "/ws");
  check("resetBuildRun leaves activeChat alone", store.readSessions(lf)["/ws"].activeChat === "https://chat.example.com/c/keepme");
```

- [ ] **Step 2: Run test to verify it fails**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm test
```

Expected: FAIL — `store.getBuildLedger is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `local-agent/src/session-store.ts`, add the types beside `WorkspaceSession`:

```typescript
export interface LedgerEntry {
  /** Content hash of what the thread was shown. null = listed in the tree only. */
  hash: string | null;
  step: number;
}

export type BuildLedger = Record<string, LedgerEntry>;
```

Add `buildLedger` to `WorkspaceSession`:

```typescript
export interface WorkspaceSession {
  chats: ChatRef[];
  activeChat: string | null;
  /** Thread shared by every step of the current build run. */
  activeBuildThread?: string | null;
  /** What that thread has already been shown. Reset when a build starts. */
  buildLedger?: BuildLedger;
}
```

Add the accessors at the end of the file:

```typescript
export function getBuildLedger(file: string, workspace: string): BuildLedger {
  if (!workspace) return {};
  return readSessions(file)[workspace]?.buildLedger ?? {};
}

export function setBuildLedger(file: string, workspace: string, ledger: BuildLedger): void {
  if (!workspace) return;
  const sessions = readSessions(file);
  ensureEntry(sessions, workspace).buildLedger = ledger;
  writeSessions(file, sessions);
}

/**
 * Start a fresh build run. Thread and ledger belong to the same run, so they are
 * cleared together — clearing one without the other would show a new thread a
 * delta computed against the old one's history.
 */
export function resetBuildRun(file: string, workspace: string): void {
  if (!workspace) return;
  const sessions = readSessions(file);
  const entry = ensureEntry(sessions, workspace);
  entry.activeBuildThread = null;
  entry.buildLedger = {};
  writeSessions(file, sessions);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:all
```

Expected: PASS — unit rises from 57 to 64; e2e stays at 76.

- [ ] **Step 5: Commit**

```bash
git add local-agent/src/session-store.ts local-agent/test/run-tests.cjs
git commit -m "Persist a per-build-run ledger in the session store"
```

---

### Task 2: Delta computation

A pure module that decides what a step still needs to be told. No I/O, no browser — the easiest part of this phase to get wrong and the easiest to test.

**Files:**
- Create: `local-agent/src/context/delta.ts`
- Test: `local-agent/test/run-tests.cjs` (new `testDelta()` section)

**Interfaces:**
- Consumes: `WorkspaceFile` from `./relevance.js` (`{ path: string; content: string; mtimeMs: number }`); `BuildLedger`, `LedgerEntry` from `../session-store.js`.
- Produces:
  - `hashContent(content: string): string` — first 16 chars of a sha1 hex digest.
  - `interface DeltaResult { candidates: WorkspaceFile[]; newPaths: string[]; unchangedCount: number }`
  - `computeDelta(files: WorkspaceFile[], ledger: BuildLedger): DeltaResult`
  - `nextLedger(previous: BuildLedger, allFiles: WorkspaceFile[], sentPaths: string[], step: number): BuildLedger`

- [ ] **Step 1: Write the failing test**

Add to `local-agent/test/run-tests.cjs`, immediately above `function testRelevance() {`:

```javascript
function testDelta() {
  section("delta context");
  const delta = require(path.join(DIST, "context/delta.js"));
  const f = (p, c) => ({ path: p, content: c, mtimeMs: 1000 });

  check("hash is stable", delta.hashContent("abc") === delta.hashContent("abc"));
  check("hash differs on different content", delta.hashContent("abc") !== delta.hashContent("abd"));

  const files = [f("a.py", "one"), f("b.py", "two"), f("c.py", "three")];

  // Empty ledger: everything is new, which keeps step 0 identical to today.
  const first = delta.computeDelta(files, {});
  check("empty ledger makes every file a candidate", first.candidates.length === 3, "candidates: " + first.candidates.length);
  check("empty ledger reports every path as new", first.newPaths.length === 3);
  check("empty ledger has nothing unchanged", first.unchangedCount === 0);

  // After sending a.py and b.py, and listing c.py in the tree only.
  const ledger = delta.nextLedger({}, files, ["a.py", "b.py"], 0);
  check("sent files record a hash", ledger["a.py"].hash === delta.hashContent("one"));
  check("listed-only files record a null hash", ledger["c.py"].hash === null, JSON.stringify(ledger["c.py"]));
  check("ledger records the step", ledger["a.py"].step === 0);

  const second = delta.computeDelta(files, ledger);
  check("unchanged sent files are not candidates", !second.candidates.some((x) => x.path === "a.py"), second.candidates.map((x) => x.path).join(","));
  check("listed-only files are still candidates", second.candidates.some((x) => x.path === "c.py"));
  check("nothing is newly appeared", second.newPaths.length === 0, second.newPaths.join(","));
  check("unchanged files are counted", second.unchangedCount === 2, "unchanged: " + second.unchangedCount);

  // A file rewritten between steps must be re-sent — this is the drift correction.
  const edited = [f("a.py", "one EDITED"), f("b.py", "two"), f("c.py", "three")];
  const third = delta.computeDelta(edited, ledger);
  check("a changed file becomes a candidate again", third.candidates.some((x) => x.path === "a.py"), third.candidates.map((x) => x.path).join(","));
  check("a changed file is not reported as new", third.newPaths.indexOf("a.py") === -1);

  // A file created by the previous step appears in the tree delta.
  const grown = edited.concat([f("d.py", "four")]);
  const fourth = delta.computeDelta(grown, ledger);
  check("a brand new file is reported as new", fourth.newPaths.length === 1 && fourth.newPaths[0] === "d.py", fourth.newPaths.join(","));

  // Deleting a file must not resurrect it or throw.
  const shrunk = [f("a.py", "one")];
  const fifth = delta.computeDelta(shrunk, ledger);
  check("deleted files are simply absent", fifth.candidates.length === 0 && fifth.newPaths.length === 0, JSON.stringify(fifth.newPaths));

  check("ledger carries forward untouched entries", (() => {
    const l2 = delta.nextLedger(ledger, files, [], 1);
    return l2["a.py"].hash === delta.hashContent("one") && l2["a.py"].step === 0;
  })());
}
```

Register it in the runner block:

```javascript
  testEditPlanParsing();
  testPlanParsing();
  testSessionStore();
  testDelta();
  testRelevance();
  testPatchApplier();
```

- [ ] **Step 2: Run test to verify it fails**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm test
```

Expected: FAIL — `Cannot find module '.../dist/context/delta.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `local-agent/src/context/delta.ts`:

```typescript
import * as crypto from "crypto";
import { WorkspaceFile } from "./relevance.js";
import { BuildLedger } from "../session-store.js";

/** Short sha1 — long enough to make a collision irrelevant, short enough to keep
 *  sessions.json readable. */
export function hashContent(content: string): string {
  return crypto.createHash("sha1").update(content, "utf-8").digest("hex").slice(0, 16);
}

export interface DeltaResult {
  /** Files the thread still needs to be shown. */
  candidates: WorkspaceFile[];
  /** Paths that did not exist last step — the tree delta. */
  newPaths: string[];
  /** How many files were skipped because the thread already has them. */
  unchangedCount: number;
}

/**
 * A file needs sending when the thread has never been shown its contents, or
 * when what is on disk no longer matches what it was shown. The second case is
 * the drift correction: the thread remembers what it proposed, disk holds what
 * was applied, and a retry or a hand edit makes those differ.
 */
export function computeDelta(files: WorkspaceFile[], ledger: BuildLedger): DeltaResult {
  const candidates: WorkspaceFile[] = [];
  const newPaths: string[] = [];
  let unchangedCount = 0;

  for (const file of files) {
    const entry = ledger[file.path];
    if (!entry) {
      newPaths.push(file.path);
      candidates.push(file);
      continue;
    }
    if (entry.hash === null || entry.hash !== hashContent(file.content)) {
      candidates.push(file);
    } else {
      unchangedCount++;
    }
  }

  return { candidates: candidates, newPaths: newPaths, unchangedCount: unchangedCount };
}

/**
 * Record what the thread now knows. Files whose signatures were sent store their
 * hash; files that only appeared in the tree listing store null, so they are
 * still offered as candidates next step.
 */
export function nextLedger(
  previous: BuildLedger,
  allFiles: WorkspaceFile[],
  sentPaths: string[],
  step: number
): BuildLedger {
  const sent = new Set(sentPaths);
  const next: BuildLedger = Object.assign({}, previous);
  for (const file of allFiles) {
    if (sent.has(file.path)) {
      next[file.path] = { hash: hashContent(file.content), step: step };
    } else if (!next[file.path]) {
      next[file.path] = { hash: null, step: step };
    }
  }
  return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:all
```

Expected: PASS — unit rises from 64 to 79; e2e stays at 76.

- [ ] **Step 5: Commit**

```bash
git add local-agent/src/context/delta.ts local-agent/test/run-tests.cjs
git commit -m "Add delta computation for per-step context"
```

---

### Task 3: Wire the delta into build prompts

Use the ledger in `buildMode`, and change what the prompt says about the tree.

**Files:**
- Modify: `local-agent/src/index.ts` — `buildPrompt` (lines 202-231), `openProviderForBuild`, `buildMode`'s context block
- Modify: `local-agent/src/providers/playwright-controller.ts` — rename `clearBuildThreadForWorkspace` to `resetBuildRunForWorkspace`
- Modify: `local-agent/test/run-tests.cjs` — the controller check that used the old name

**Interfaces:**
- Consumes: `getBuildLedger`, `setBuildLedger`, `resetBuildRun` (Task 1); `computeDelta`, `nextLedger` (Task 2); `selectRelevantFiles` (existing).
- Produces:
  - `buildPrompt(userPrompt: string, tree: string, relevantFiles: { path: string; content: string }[], priorFiles: string[], isFirstStep: boolean): string` — one added parameter.
  - `controller.getLedger(): BuildLedger`
  - `controller.saveLedger(ledger: BuildLedger): void`
  - `controller.resetBuildRunForWorkspace(): void` — replaces `clearBuildThreadForWorkspace`.

- [ ] **Step 1: Rename the reset method**

In `playwright-controller.ts` replace:

```typescript
  clearBuildThreadForWorkspace() {
    clearBuildThread(this.sessionStoreFile, this.workspace);
  }
```

with:

```typescript
  /** Thread and ledger belong to the same run and are cleared together. */
  resetBuildRunForWorkspace() {
    resetBuildRun(this.sessionStoreFile, this.workspace);
  }
```

Change the import on line 4 from `clearBuildThread` to `resetBuildRun`. In `index.ts`, change the one call inside `openProviderForBuild` from `controller.clearBuildThreadForWorkspace()` to `controller.resetBuildRunForWorkspace()`. In `run-tests.cjs`, change `c.clearBuildThreadForWorkspace();` to `c.resetBuildRunForWorkspace();`.

- [ ] **Step 2: Write the failing test**

Add to `local-agent/test/run-e2e.cjs`, immediately before the final `await mock.close();`:

```javascript
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
    check("step 1 prompt is shorter than step 0's", step1Prompt.length < step0Prompt.length, "step0=" + step0Prompt.length + " step1=" + step1Prompt.length);

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
```

- [ ] **Step 3: Run test to verify it fails**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:e2e
```

Expected: FAIL — `step 1 does not resend alpha's signatures`, because every step still sends the full ranked set.

- [ ] **Step 4: Write minimal implementation**

In `index.ts`, add to the imports beside the existing `session-store` usage:

```typescript
import { getBuildLedger, setBuildLedger } from "./session-store.js";
import { computeDelta, nextLedger } from "./context/delta.js";
```

Give `buildPrompt` its extra parameter and change the tree wording. Replace lines 202-212 with:

```typescript
function buildPrompt(userPrompt: string, tree: string, relevantFiles: { path: string; content: string }[], priorFiles: string[], isFirstStep: boolean): string {
  let contextStr = "";
  if (tree) contextStr += "\n\nProject Structure:\n" + tree;
  if (relevantFiles.length > 0) {
    contextStr += "\n\nRelevant Existing Files (use 'overwrite' mode with FULL content to modify them):\n";
    for (const f of relevantFiles) contextStr += "\n--- " + f.path + " ---\n" + f.content + "\n";
  }
  if (priorFiles.length > 0) {
    // After the first step the thread already holds the earlier listing, so only
    // what appeared since is worth the tokens.
    contextStr += isFirstStep
      ? "\n\nFiles ALREADY in the workspace (DO NOT recreate or collapse into these):\n"
      : "\n\nNew files since the last step (DO NOT recreate or collapse into these):\n";
    for (const f of priorFiles) contextStr += "- " + f + "\n";
  }
```

**The ledger must be reached through the controller, not through a second path calculation.** `PlaywrightController` derives `sessionStoreFile` from `config.profileDir`; any independent derivation in `index.ts` would silently diverge the moment a provider config moved its profile, and the delta would quietly never fire. Add two methods to `playwright-controller.ts` beside `getBuildThreadUrl`:

```typescript
  getLedger(): BuildLedger {
    return getBuildLedger(this.sessionStoreFile, this.workspace);
  }

  saveLedger(ledger: BuildLedger) {
    setBuildLedger(this.sessionStoreFile, this.workspace, ledger);
  }
```

and extend its import on line 4 to include `getBuildLedger, setBuildLedger, BuildLedger`.

Because the ledger now comes from the controller, the context work has to happen *after* the provider is open. In `buildMode`, delete this line from the context block:

```typescript
  const relevant = selectRelevantFiles({ files: allFiles, stepDetail: stepDetail, prompt: prompt });
```

and delete the `console.log("Step " + (stepIndex + 1) + ": including ...")` line and the `const filtered = ...` block that follow it. Keep the `allFiles` collection and `effectivePrompt` exactly where they are.

Then, immediately after the `openProviderForBuild` call and inside the existing `try {`, before `prevCount` is read, insert:

```typescript
    const isFirstStep = stepIndex <= 0;
    const ledger = isFirstStep ? {} : controller.getLedger();
    const delta = computeDelta(allFiles, ledger);
    const relevant = selectRelevantFiles({ files: delta.candidates, stepDetail: stepDetail, prompt: prompt });
    controller.saveLedger(nextLedger(ledger, allFiles, relevant.map((r) => r.path), stepIndex));

    const filtered = allFiles
      .map(function (f) { return f.path; })
      .filter(function (f) { return isFirstStep || delta.newPaths.indexOf(f) !== -1; })
      .slice(0, 40);

    console.log("Step " + (stepIndex + 1) + ": including " + relevant.length + " files (signatures)" +
      (isFirstStep ? "" : ", skipped " + delta.unchangedCount + " the thread already has") +
      (relevant.length ? " (" + relevant.map(f => f.path + ":" + f.content.length + "c").join(", ") + ")" : ""));
```

`allFiles` already holds workspace-relative forward-slash paths, so `filtered` no longer needs the `path.relative` mapping the old block did. Remove the now-unused `walk(workspace, priorFiles)` call and its `priorFiles` declaration from the context block if nothing else references them.

Replace the tree listing so later steps only carry new paths. The existing block is:

```typescript
  const filtered = priorFiles
    .map(function (f) { return path.relative(workspace, f).replace(/\\/g, "/"); })
    .filter(function (f) { return !f.startsWith(".agent-backups") && !f.startsWith("."); })
    .slice(0, 40);
```

Replace its last line with:

```typescript
    .filter(function (f) { return isFirstStep || delta.newPaths.indexOf(f) !== -1; })
    .slice(0, 40);
```

Update the log line so the saving is visible:

```typescript
  console.log("Step " + (stepIndex + 1) + ": including " + relevant.length + " files (signatures)" +
    (isFirstStep ? "" : ", skipped " + delta.unchangedCount + " the thread already has") +
    (relevant.length ? " (" + relevant.map(f => f.path + ":" + f.content.length + "c").join(", ") + ")" : ""));
```

Finally pass the new argument at the `buildPrompt` call site inside `buildMode`:

```typescript
    await controller.sendPrompt(buildPrompt(effectivePrompt, ctx.tree, relevant, filtered, isFirstStep), config);
```

- [ ] **Step 5: Run tests and commit**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:all
```

Expected: PASS — unit 79, e2e rises from 76 to 80.

```bash
git add local-agent/src/index.ts local-agent/src/providers/playwright-controller.ts local-agent/test/run-tests.cjs local-agent/test/run-e2e.cjs
git commit -m "Send only what the thread has not already seen"
```

---

### Task 4: Confirm the saving, then drive the app

Prove the prompt actually shrank across a realistic multi-step build, and check the desktop app still works.

**Files:**
- Modify: `local-agent/test/run-e2e.cjs`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: no new code interfaces.

- [ ] **Step 1: Write the failing test**

Add to `run-e2e.cjs` immediately before the final `await mock.close();`:

```javascript
  // ------------------------------------ the delta actually shrinks the prompt
  section("prompt size falls across a multi-step build");
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
    // Without the delta each step would grow as the project grows. With it, later
    // steps carry only the one file their predecessor just wrote.
    check("step 4 is not larger than step 2", sizes[3] <= sizes[1], "sizes: " + sizes.join(","));
    check("prompts stay bounded as the project grows", Math.max(...sizes) - Math.min(...sizes) < 2500, "sizes: " + sizes.join(","));

    fs.rmSync(ws, { recursive: true, force: true });
  }
```

- [ ] **Step 2: Run the whole suite**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && cd local-agent && npm run test:all
```

Expected: PASS — unit 79, e2e 84.

If `step 4 is not larger than step 2` fails, the delta is not firing. Check the log line from Task 3 Step 4: it should report `skipped N the thread already has` with N growing each step. If N is 0 on every step, the ledger is not being read back — verify `ledgerFile` resolves to the same path the controller writes (`local-agent/storage/sessions.json`).

- [ ] **Step 3: Drive the real app**

```bash
cd ~/projects/agentic-web-coder && source scripts/wsl-env.sh && cd desktop && npm start
```

Expected: the CloseNI window opens with the Chat tab active and no errors beyond the harmless `viz_main_impl.cc` GPU lines.

- [ ] **Step 4: Update the README and commit**

In `README.md`, under `## How a build step runs`, append to item 3:

```markdown
   From step 2 onward the prompt carries only a delta: signatures for files the
   thread has never seen or whose content changed since it saw them, plus the
   paths that appeared since the previous step. What the thread already holds is
   not re-sent. The ledger of what it has seen lives in `sessions.json` as
   `buildLedger` and is cleared when a build starts.
```

```bash
git add local-agent/test/run-e2e.cjs README.md
git commit -m "Verify per-step prompts stay bounded as a build grows"
```

---

## Self-Review

**Spec coverage.** Phase 2 of the spec asks for: a persisted ledger keyed by path holding a content hash (Task 1); new-versus-changed detection by hash rather than mtime (Task 2, `computeDelta`, with `hashContent` and an explicit test that identical content does not trigger a resend); ranking only new and changed files through `selectRelevantFiles` (Task 3); the project tree sent as a delta (Task 3, the `filtered` change plus the reworded prompt); step 1 unchanged (Global Constraints, and the empty-ledger tests in Task 2); and drift correction when a retry overwrites a file (Task 2's "changed file becomes a candidate again", Task 3's on-disk-rewrite check).

The spec's correction about persistence is implemented by Task 1 storing the ledger in `sessions.json`.

**Placeholder scan.** No TBD/TODO markers. Every code step carries literal code. Task 4 Step 2 names a specific diagnostic and a specific cause rather than "debug it".

**Type consistency.** `LedgerEntry.hash` is `string | null` in the interface, in `nextLedger`, in `computeDelta`'s check, and in the tests. `BuildLedger` is `Record<string, LedgerEntry>` throughout. `resetBuildRun` (store) and `resetBuildRunForWorkspace` (controller) are consistently named and the rename is applied in all three call sites named in Task 3 Step 1. `buildPrompt`'s new fifth parameter `isFirstStep: boolean` is added at the definition and the one call site.

**Fixed during review.** An earlier draft of Task 3 derived the ledger's file path inside `index.ts`, independently of how `PlaywrightController` derives `sessionStoreFile` from `config.profileDir`. Those two would diverge the moment a provider config moved its profile, and the delta would silently stop firing with no error — the worst kind of failure, since the build still succeeds and just gets slower. Task 3 now reaches the ledger through `controller.getLedger()` / `controller.saveLedger()`, so there is exactly one derivation of that path. This is why the context work moved to after the provider is opened.

**Remaining rough edge.** Task 4's `step 4 is not larger than step 2` compares prompt lengths, which depends on the mock's replies staying the size they are in that test. Editing those replies can move the numbers; the `skipped N the thread already has` log line is the more direct signal and is what the Step 2 diagnostic points at.
