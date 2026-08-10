# Multi-language Builds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify and run Rust, C, C++ and Java projects the way the agent already verifies and runs Python and JavaScript.

**Architecture:** A manifest at the workspace root claims its language and produces one project-level check; languages with no manifest are checked per file. The decision is a pure function taking a tool resolver, so the whole thing is testable on a machine with no compilers — which is this one.

**Tech Stack:** TypeScript compiled to CommonJS by `tsc`, tests in plain CommonJS (`local-agent/test/run-tests.cjs`, `run-e2e.cjs`), renderer helpers as UMD-style dual-load modules in `desktop/`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-10-multi-language-builds-design.md`. Read it before starting.
- **A missing toolchain skips, never fails.** Emit zero commands rather than one that cannot succeed. Precedent: `resolvePythonCommand`.
- **A present manifest claims its language even when its tool is missing.** Falling back to per-file checks for a Rust crate would produce exactly the false failures this design exists to prevent.
- **Per-file checks write nothing into the workspace.** `rustc` and `javac` are pointed at a temp directory. Project checks are exempt: `cargo check` writes to `target/`, which belongs to the project.
- **Never probe `.exe` tool names.** In WSL `gcc.exe` resolves to a Windows binary that cannot read a `/tmp/...` path, so probing it produces checks that fail confusingly. Probe plain names only and let Windows resolve `gcc` to `gcc.exe` itself.
- Build with `source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json` — the Windows `tsc` on PATH cannot read UNC paths and prints its help text instead of compiling.
- Never commit `local-agent/storage/sessions.json`, `last-chat-url.json`, or anything under `local-agent/storage/browser-profiles/`.

## File Structure

| File | Responsibility |
|---|---|
| `local-agent/src/verification/toolchain.ts` (create) | Is this tool installed, and under what name? Probe, cache, return null. |
| `local-agent/src/verification/check-planner.ts` (create) | Pure: given changed files, root entries and a tool resolver, which commands should run? |
| `local-agent/src/verification/command-runner.ts` (modify) | `runCommand` gains `timeoutIsFailure`; `resolvePythonCommand` delegates to `resolveTool`; `detectSyntaxChecks` is deleted. |
| `local-agent/src/index.ts` (modify) | Both check call sites use the planner and honour each check's own timeout. |
| `desktop/entrypoint.js` (modify) | Manifest-first Run rules; platform-aware. |
| `desktop/preload.js` (modify) | Expose `platform` so the renderer can pass it. |
| `local-agent/test/run-tests.cjs` (modify) | Unit tests for the planner and entry point. |
| `local-agent/test/run-e2e.cjs` (modify) | Real compilers when present, skipped cleanly when not. |

---

### Task 1: Tool resolution

**Files:**
- Create: `local-agent/src/verification/toolchain.ts`
- Modify: `local-agent/src/verification/command-runner.ts:76-95`
- Test: `local-agent/test/run-tests.cjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveTool(name: string): string | null`, `resetToolCache(): void`, `TOOL_CANDIDATES: Record<string, string[]>`.

- [ ] **Step 1: Write the failing test**

Add to `local-agent/test/run-tests.cjs`, above `function testEntrypoint()`:

```javascript
function testToolchain() {
  section("tool resolution");
  const { resolveTool, resetToolCache, TOOL_CANDIDATES } = require(path.join(DIST, "verification/toolchain.js"));

  // node is running this test, so it is definitionally installed.
  resetToolCache();
  check("a tool that exists resolves", resolveTool("node") === "node");
  check("the answer is cached", resolveTool("node") === "node");
  check("a tool that does not exist resolves to null",
    resolveTool("definitely-not-a-real-tool-xyz") === null);

  // Candidate order matters: "python" only exists on Windows and old Linux.
  check("python is probed in platform order",
    TOOL_CANDIDATES.python[0] === (process.platform === "win32" ? "python" : "python3"));
  // Windows has mingw32-make where Linux has make.
  check("make has a mingw fallback", TOOL_CANDIDATES.make.indexOf("mingw32-make") > 0);
  // Probing .exe names would resolve a Windows binary from WSL that cannot read
  // a /tmp path, producing checks that fail for a reason nobody can see.
  const allCandidates = Object.keys(TOOL_CANDIDATES)
    .reduce(function (acc, k) { return acc.concat(TOOL_CANDIDATES[k]); }, []);
  check("no .exe names are probed", allCandidates.every(function (c) { return c.indexOf(".exe") === -1; }));
}
```

Register it in `main()` next to the other unit sections:

```javascript
  testControlSettings();
  testToolchain();
  testEntrypoint();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: FAIL — `Cannot find module '.../dist/verification/toolchain.js'`

- [ ] **Step 3: Write the implementation**

Create `local-agent/src/verification/toolchain.ts`:

```typescript
/**
 * Is this tool installed here, and under what name?
 *
 * Generalises what resolvePythonCommand did for one interpreter. Guessing wrong
 * is not a harmless mistake: every check for that language fails with "not
 * found" and the model spends its self-heal retries on a machine problem it
 * cannot fix. That already cost one whole build, with `python` vs `python3`.
 */
import { spawnSync } from "child_process";

/**
 * Candidate names per tool, in the order to try.
 *
 * Plain names only. In WSL, `gcc.exe` resolves to a Windows binary that cannot
 * read a /tmp path, so probing .exe fallbacks would find a compiler that then
 * fails on every file. Windows resolves `gcc` to `gcc.exe` on its own.
 */
export const TOOL_CANDIDATES: Record<string, string[]> = {
  python: process.platform === "win32" ? ["python", "py -3", "python3"] : ["python3", "python"],
  node: ["node"],
  gcc: ["gcc", "cc"],
  gxx: ["g++", "c++"],
  rustc: ["rustc"],
  cargo: ["cargo"],
  javac: ["javac"],
  make: ["make", "mingw32-make"],
  mvn: ["mvn"],
  gradle: ["gradle"],
};

const cache = new Map<string, string | null>();

/** Test seam: the cache is per-process and would otherwise outlive a test. */
export function resetToolCache(): void {
  cache.clear();
}

export function resolveTool(name: string): string | null {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;

  const candidates = TOOL_CANDIDATES[name] || [name];
  for (const candidate of candidates) {
    try {
      if (spawnSync(candidate + " --version", { shell: true, stdio: "ignore", timeout: 10000 }).status === 0) {
        cache.set(name, candidate);
        return candidate;
      }
    } catch {
      /* try the next candidate */
    }
  }
  console.log("No " + name + " found; checks needing it are skipped.");
  cache.set(name, null);
  return null;
}
```

Then replace the body of `resolvePythonCommand` in `command-runner.ts` (lines 76-95, the `cachedPython` block) with a delegation, keeping the exported name because `normalizeCommand` uses it:

```typescript
export function resolvePythonCommand(): string | null {
  return resolveTool("python");
}
```

Add the import at the top of `command-runner.ts`:

```typescript
import { resolveTool } from "./toolchain.js";
```

Delete the now-unused `cachedPython` variable.

- [ ] **Step 4: Run tests to verify they pass**

Run: `source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && node local-agent/test/run-tests.cjs`
Expected: PASS, with the count up by 6.

- [ ] **Step 5: Commit**

```bash
git add local-agent/src/verification/toolchain.ts local-agent/src/verification/command-runner.ts local-agent/test/run-tests.cjs
git commit -m "Generalise interpreter probing to any tool"
```

---

### Task 2: The check planner

**Files:**
- Create: `local-agent/src/verification/check-planner.ts`
- Test: `local-agent/test/run-tests.cjs`

**Interfaces:**
- Consumes: `resolveTool` from Task 1.
- Produces:
  - `type ToolResolver = (name: string) => string | null`
  - `interface Check { command: string; scope: "file" | "project"; language: string; timeoutMs: number }`
  - `planChecks(changedPaths: string[], rootEntries: string[], resolve: ToolResolver, tmpDir: string): Check[]`
  - `planChecksForWorkspace(workspace: string, changedPaths: string[]): Check[]`
  - `FILE_CHECK_TIMEOUT_MS = 15000`, `PROJECT_CHECK_TIMEOUT_MS = 180000`

- [ ] **Step 1: Write the failing test**

Add to `local-agent/test/run-tests.cjs`, above `function testEntrypoint()`:

```javascript
function testCheckPlanner() {
  section("check planning");
  const {
    planChecks, FILE_CHECK_TIMEOUT_MS, PROJECT_CHECK_TIMEOUT_MS,
  } = require(path.join(DIST, "verification/check-planner.js"));

  // A fake resolver is the whole point of the design: none of these compilers
  // are installed here, and the decisions still get tested.
  const all = function (name) { return name === "gxx" ? "g++" : name; };
  const none = function () { return null; };
  const only = function (names) {
    return function (n) { return names.indexOf(n) === -1 ? null : (n === "gxx" ? "g++" : n); };
  };
  const TMP = "/tmp/checks";
  const commands = function (checks) { return checks.map(function (c) { return c.command; }); };

  // --- per-file, no manifest
  check("a C file is checked with gcc",
    commands(planChecks(["main.c"], [], all, TMP))[0] === 'gcc -fsyntax-only "main.c"');
  check("a C++ file is checked with g++",
    commands(planChecks(["app.cpp"], [], all, TMP))[0] === 'g++ -fsyntax-only "app.cpp"');
  check("a header is checked too",
    planChecks(["util.h"], [], all, TMP).length === 1);
  check("a lone Rust file is checked as a library, not a binary",
    commands(planChecks(["scratch.rs"], [], all, TMP))[0] ===
      'rustc --edition 2021 --crate-type lib --emit=metadata --out-dir "/tmp/checks" "scratch.rs"');
  check("a lone Java file compiles to a temp directory",
    commands(planChecks(["App.java"], [], all, TMP))[0] === 'javac -d "/tmp/checks" "App.java"');
  check("Python and JS still work",
    commands(planChecks(["a.py", "b.js"], [], all, TMP)).join(" ") ===
      'python3 -m py_compile "a.py" node --check "b.js"');
  check("an unrecognised extension yields nothing",
    planChecks(["README.md"], [], all, TMP).length === 0);

  // --- a manifest claims its language
  const cargo = planChecks(["src/main.rs", "src/util.rs", "src/lib.rs"], ["Cargo.toml"], all, TMP);
  check("Cargo.toml collapses three files into one check", cargo.length === 1);
  check("and that check is cargo check", cargo[0].command === "cargo check");
  check("the project check is marked as one", cargo[0].scope === "project");
  check("without Cargo.toml the same files are checked individually",
    planChecks(["src/main.rs", "src/util.rs", "src/lib.rs"], [], all, TMP).length === 3);

  check("pom.xml claims Java",
    commands(planChecks(["src/main/java/App.java"], ["pom.xml"], all, TMP)).join() === "mvn -q compile");
  check("build.gradle claims Java",
    commands(planChecks(["App.java"], ["build.gradle"], all, TMP)).join() === "gradle compileJava -q");
  check("a Makefile claims C, as a dry run rather than a build",
    commands(planChecks(["main.c"], ["Makefile"], all, TMP)).join() === "make -n");

  // A manifest for one language must not silence another.
  const mixed = planChecks(["src/main.rs", "helper.c"], ["Cargo.toml"], all, TMP);
  check("a Rust manifest does not suppress the C check", mixed.length === 2);
  check("the C file is still checked per file",
    commands(mixed).indexOf('gcc -fsyntax-only "helper.c"') !== -1);

  // A manifest with nothing of its language changed is not worth running.
  check("a manifest whose language did not change yields no project check",
    planChecks(["notes.md"], ["Cargo.toml"], all, TMP).length === 0);

  // --- missing tools
  check("no toolchain means no commands, not failing ones",
    planChecks(["main.c", "src/main.rs", "App.java"], [], none, TMP).length === 0);
  check("a missing tool skips only its own language",
    commands(planChecks(["main.c", "a.py"], [], only(["python"]), TMP)).join() ===
      'python3 -m py_compile "a.py"');
  // The crate is still a crate. Falling back to per-file rustc would report the
  // false failures this whole design exists to avoid.
  check("a manifest whose tool is missing yields nothing, not a per-file fallback",
    planChecks(["src/main.rs"], ["Cargo.toml"], only(["rustc"]), TMP).length === 0);

  // --- timeouts
  check("a project check gets the long timeout",
    planChecks(["src/main.rs"], ["Cargo.toml"], all, TMP)[0].timeoutMs === PROJECT_CHECK_TIMEOUT_MS);
  check("a per-file check gets the short one",
    planChecks(["main.c"], [], all, TMP)[0].timeoutMs === FILE_CHECK_TIMEOUT_MS);
  check("the long timeout is long enough for a cold cargo check",
    PROJECT_CHECK_TIMEOUT_MS >= 180000);

  // --- duplicates
  check("the same file twice is checked once",
    planChecks(["main.c", "main.c"], [], all, TMP).length === 1);
}
```

Register it in `main()`:

```javascript
  testToolchain();
  testCheckPlanner();
  testEntrypoint();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: FAIL — `Cannot find module '.../dist/verification/check-planner.js'`

- [ ] **Step 3: Write the implementation**

Create `local-agent/src/verification/check-planner.ts`:

```typescript
/**
 * What should we run to verify this step?
 *
 * The interesting decision is scope. Python and JS have a genuine per-file
 * syntax check, which is why the old code could answer one file at a time.
 * Rust and Java are module-aware: a .rs file containing `mod utils;` fails on
 * its own even when the crate is perfect. Checking it alone would report a
 * failure the model then burns its retries trying to fix.
 *
 * So a manifest claims its language. Cargo.toml means one `cargo check` and no
 * per-file rustc at all.
 *
 * planChecks is pure - it takes a resolver rather than probing - so every
 * decision below is tested on a machine with none of these compilers installed.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveTool } from "./toolchain.js";

export type ToolResolver = (name: string) => string | null;

export interface Check {
  command: string;
  /** "project" runs once for the whole workspace; "file" runs per changed file. */
  scope: "file" | "project";
  language: string;
  timeoutMs: number;
}

export const FILE_CHECK_TIMEOUT_MS = 15000;
/** cargo check on a first run downloads and compiles the dependency tree. */
export const PROJECT_CHECK_TIMEOUT_MS = 180000;

interface ManifestRule {
  /** Root-level file that triggers this rule. */
  file: string;
  tool: string;
  /** Built from the resolved tool name. */
  command: (tool: string) => string;
  language: string;
  /** Extensions this manifest takes responsibility for. */
  extensions: string[];
}

const MANIFESTS: ManifestRule[] = [
  { file: "Cargo.toml", tool: "cargo", command: (t) => t + " check", language: "rust", extensions: [".rs"] },
  { file: "pom.xml", tool: "mvn", command: (t) => t + " -q compile", language: "java", extensions: [".java"] },
  { file: "build.gradle", tool: "gradle", command: (t) => t + " compileJava -q", language: "java", extensions: [".java"] },
  { file: "build.gradle.kts", tool: "gradle", command: (t) => t + " compileJava -q", language: "java", extensions: [".java"] },
  // -n is a dry run: it proves the Makefile parses and its targets resolve
  // without building anything. A real make would drop object files and binaries
  // into the user's workspace, which is more than a check should do.
  { file: "Makefile", tool: "make", command: (t) => t + " -n", language: "c", extensions: [".c", ".h", ".cpp", ".hpp", ".cc"] },
];

interface FileRule {
  extensions: string[];
  tool: string;
  language: string;
  command: (tool: string, file: string, tmpDir: string) => string;
}

const FILE_RULES: FileRule[] = [
  { extensions: [".py"], tool: "python", language: "python", command: (t, f) => t + ' -m py_compile "' + f + '"' },
  { extensions: [".js", ".cjs", ".mjs"], tool: "node", language: "javascript", command: (t, f) => t + ' --check "' + f + '"' },
  { extensions: [".c", ".h"], tool: "gcc", language: "c", command: (t, f) => t + ' -fsyntax-only "' + f + '"' },
  { extensions: [".cpp", ".cc", ".hpp"], tool: "gxx", language: "cpp", command: (t, f) => t + ' -fsyntax-only "' + f + '"' },
  // --crate-type lib so a file without `fn main` is not rejected for lacking
  // one; a file that has one still compiles as a library. --out-dir keeps the
  // .rmeta out of the user's source tree.
  { extensions: [".rs"], tool: "rustc", language: "rust",
    command: (t, f, tmp) => t + ' --edition 2021 --crate-type lib --emit=metadata --out-dir "' + tmp + '" "' + f + '"' },
  // -d for the same reason: .class files beside the sources would mean the
  // check modified the project it was inspecting.
  { extensions: [".java"], tool: "javac", language: "java", command: (t, f, tmp) => t + ' -d "' + tmp + '" "' + f + '"' },
];

function extensionOf(filePath: string): string {
  const name = filePath.replace(/\\/g, "/").split("/").pop() || "";
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

export function planChecks(
  changedPaths: string[],
  rootEntries: string[],
  resolve: ToolResolver,
  tmpDir: string,
): Check[] {
  const checks: Check[] = [];
  const present = new Set(rootEntries || []);
  const changed = Array.from(new Set(changedPaths || []));

  // A manifest claims its extensions whether or not its tool is installed.
  // Falling back to per-file checks for a crate would produce exactly the false
  // failures this design exists to prevent, so a missing cargo means no Rust
  // check at all rather than a misleading one.
  const claimed = new Set<string>();
  for (const rule of MANIFESTS) {
    if (!present.has(rule.file)) continue;
    for (const ext of rule.extensions) claimed.add(ext);

    // Running cargo check because a README changed is waste.
    const touched = changed.some((p) => rule.extensions.includes(extensionOf(p)));
    if (!touched) continue;

    const tool = resolve(rule.tool);
    if (!tool) continue;
    const command = rule.command(tool);
    if (checks.some((c) => c.command === command)) continue;
    checks.push({ command: command, scope: "project", language: rule.language, timeoutMs: PROJECT_CHECK_TIMEOUT_MS });
  }

  for (const filePath of changed) {
    const ext = extensionOf(filePath);
    if (claimed.has(ext)) continue;
    const rule = FILE_RULES.find((r) => r.extensions.includes(ext));
    if (!rule) continue;
    const tool = resolve(rule.tool);
    if (!tool) continue;
    checks.push({
      command: rule.command(tool, filePath, tmpDir),
      scope: "file",
      language: rule.language,
      timeoutMs: FILE_CHECK_TIMEOUT_MS,
    });
  }

  return checks;
}

/**
 * The impure shell: read the workspace root, make somewhere for compiler
 * artifacts to land, then defer every decision to the pure function above.
 */
export function planChecksForWorkspace(workspace: string, changedPaths: string[]): Check[] {
  let rootEntries: string[] = [];
  try {
    rootEntries = fs.readdirSync(workspace);
  } catch {
    /* an unreadable workspace simply has no manifests */
  }
  // rustc --out-dir does not create the directory; javac -d does. Making it
  // here covers both.
  const tmpDir = path.join(os.tmpdir(), "closeni-checks");
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch {
    /* a check that cannot write its artifacts will report that itself */
  }
  return planChecks(changedPaths, rootEntries, resolveTool, tmpDir);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && node local-agent/test/run-tests.cjs`
Expected: PASS, with the count up by 25.

- [ ] **Step 5: Commit**

```bash
git add local-agent/src/verification/check-planner.ts local-agent/test/run-tests.cjs
git commit -m "Plan checks by manifest first, then per file"
```

---

### Task 3: A timed-out check is a failure

**Files:**
- Modify: `local-agent/src/verification/command-runner.ts:10-71`
- Test: `local-agent/test/run-tests.cjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `runCommand(command, cwd, timeoutMs?, options?: { timeoutIsFailure?: boolean })` — the fourth parameter is new; omitting it preserves today's behaviour exactly.

- [ ] **Step 1: Write the failing test**

Add to `local-agent/test/run-tests.cjs`, above `function testEntrypoint()`:

```javascript
async function testCommandTimeout() {
  section("command timeouts");
  const { runCommand } = require(path.join(DIST, "verification/command-runner.js"));
  const sleeper = process.platform === "win32" ? "ping -n 6 127.0.0.1 > NUL" : "sleep 5";

  // A model-suggested command that runs quietly is probably a server, and
  // calling that a failure would break `python -m http.server`. Unchanged.
  const asServer = await runCommand(sleeper, os.tmpdir(), 1500);
  check("a quiet long-running command still counts as a server", asServer.success === true);
  check("and says so", asServer.output.indexOf("Assuming") !== -1);

  // A syntax check is supposed to terminate. One that does not has told us
  // nothing, and reporting that as a pass is worse than reporting the timeout.
  const asCheck = await runCommand(sleeper, os.tmpdir(), 1500, { timeoutIsFailure: true });
  check("a check that times out fails", asCheck.success === false);
  check("the timeout is reported", asCheck.timedOut === true);

  // The option must not change anything about a command that finishes.
  const quick = await runCommand("node --version", os.tmpdir(), 15000, { timeoutIsFailure: true });
  check("a command that finishes is unaffected", quick.success === true);
}
```

Register it in `main()` — note it is `await`ed, like `testBrowserExtraction`:

```javascript
  testCheckPlanner();
  await testCommandTimeout();
  testEntrypoint();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: FAIL — "a check that times out fails", because the timeout currently reports success.

- [ ] **Step 3: Write the implementation**

In `command-runner.ts`, add the options parameter and guard the server heuristic:

```typescript
export interface RunOptions {
  /**
   * Treat a timeout as a failure. A syntax check is supposed to terminate, so
   * one that does not has told us nothing - and reporting that as a pass hides
   * exactly the case worth knowing about. Off by default, because a command the
   * model suggested may legitimately be a server that never exits.
   */
  timeoutIsFailure?: boolean;
}

export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number = 15000,
  options: RunOptions = {},
): Promise<CommandResult> {
```

Then change the timeout branch inside `proc.on("close", ...)`:

```typescript
      if (timedOut && !hasErrorOutput && !options.timeoutIsFailure) {
```

Nothing else in the function changes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && node local-agent/test/run-tests.cjs`
Expected: PASS, with the count up by 5.

- [ ] **Step 5: Commit**

```bash
git add local-agent/src/verification/command-runner.ts local-agent/test/run-tests.cjs
git commit -m "Let a check treat its own timeout as a failure"
```

---

### Task 4: Use the planner in both check call sites

**Files:**
- Modify: `local-agent/src/index.ts:199-214` (`testAllMode`), `local-agent/src/index.ts:397-406` (build step checks), `local-agent/src/index.ts:9` (imports)
- Modify: `local-agent/src/verification/command-runner.ts:118-128` (delete `detectSyntaxChecks`)

**Interfaces:**
- Consumes: `planChecksForWorkspace`, `Check` from Task 2; `runCommand`'s `RunOptions` from Task 3.
- Produces: no new exports. `detectSyntaxChecks` no longer exists.

- [ ] **Step 1: Delete the old entry point**

Remove `detectSyntaxChecks` entirely from `command-runner.ts` (lines 118-128). Nothing tests it, and leaving a per-file-only API beside the planner invites someone to call the wrong one.

- [ ] **Step 2: Update the imports in `index.ts`**

Replace line 9:

```typescript
import { runCommand, normalizeCommand } from "./verification/command-runner.js";
import { planChecksForWorkspace } from "./verification/check-planner.js";
```

- [ ] **Step 3: Rewrite `testAllMode`**

The old loop asked each file for its own checks, which cannot see a manifest. The planner is asked once, for every file at once:

```typescript
async function testAllMode(workspace: string) {
  const files: string[] = [];
  walk(workspace, files);
  let pass = 0; let fail = 0;
  const results: { command: string; success: boolean }[] = [];
  const checks = planChecksForWorkspace(workspace, files.map((f) => path.relative(workspace, f)));
  for (const c of checks) {
    const r = await runCommand(c.command, workspace, c.timeoutMs, { timeoutIsFailure: true });
    console.log((r.success ? "PASS " : "FAIL ") + c.command);
    results.push({ command: c.command, success: r.success });
    if (r.success) pass++; else { fail++; if (r.output) projLog(r.output.slice(0, 800)); }
  }
  emit({ success: fail === 0, passed: pass, failed: fail, results: results });
}
```

- [ ] **Step 4: Rewrite the build-step checks**

Replace the `const checks: string[] = []` block and its loop:

```typescript
      const checks = planChecksForWorkspace(workspace, plan.changes.map((c) => c.filePath));
      for (const c of checks) {
        console.log("RUNNING_CHECK: " + c.command);
        const r = await runCommand(c.command, workspace, c.timeoutMs, { timeoutIsFailure: true });
        console.log("CHECK_RESULT: " + (r.success ? "PASS" : "FAIL"));
        if (!r.success) { failed = { command: c.command, output: r.output }; break; }
      }
```

- [ ] **Step 5: Verify the whole suite still passes**

Run: `source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && node local-agent/test/run-tests.cjs`
Expected: PASS, same count as after Task 3.

Then the end-to-end suite, which exercises the Python and JS check paths for real:

Run: `source scripts/wsl-env.sh && node local-agent/test/run-e2e.cjs > /tmp/e2e.log 2>&1; tail -3 /tmp/e2e.log`
Expected: PASS, 150 passed, 0 failed. The "build mode — self-heals broken code" and "testall reports per-check results" sections are the ones that would catch a mistake here.

- [ ] **Step 6: Commit**

```bash
git add local-agent/src/index.ts local-agent/src/verification/command-runner.ts
git commit -m "Route both check call sites through the planner"
```

---

### Task 5: Running the new languages

**Files:**
- Modify: `desktop/entrypoint.js`
- Modify: `desktop/preload.js:2`
- Modify: `desktop/renderer.js` (the Run Project handler, around line 500)
- Test: `local-agent/test/run-tests.cjs` (`testEntrypoint`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `detectEntrypoint(paths, packageJson, manifests, platform)` — two new optional parameters. `manifests` is `{ makefile?: string }`; `platform` is a `process.platform` value, defaulting to non-Windows behaviour.

- [ ] **Step 1: Write the failing test**

Add these to the existing `testEntrypoint()` in `local-agent/test/run-tests.cjs`, after the current checks and before its closing brace:

```javascript
  // Manifests beat loose files: a Cargo project is `cargo run`, whatever else
  // happens to be lying around.
  check("Cargo.toml means cargo run",
    detectEntrypoint(["Cargo.toml", "src/main.rs"], null) === "cargo run");
  check("a Makefile with a run target uses it",
    detectEntrypoint(["Makefile", "main.c"], null, { makefile: "all:\n\tgcc main.c\nrun: all\n\t./a.out\n" }) === "make run");
  check("a Makefile without one just builds",
    detectEntrypoint(["Makefile", "main.c"], null, { makefile: "all:\n\tgcc main.c\n" }) === "make");
  check("package.json still wins over a Makefile",
    detectEntrypoint(["package.json", "Makefile"], { scripts: { start: "node ." } }) === "npm start");

  // Loose files, no manifest.
  check("main.c compiles and runs",
    detectEntrypoint(["main.c"], null) === "gcc main.c -o main && ./main");
  check("main.cpp uses g++",
    detectEntrypoint(["main.cpp"], null) === "g++ main.cpp -o main && ./main");
  check("Main.java compiles and runs",
    detectEntrypoint(["Main.java"], null) === "javac Main.java && java Main");

  // Windows has no ./ and no python3.
  check("Windows drops the ./ prefix",
    detectEntrypoint(["main.c"], null, null, "win32") === "gcc main.c -o main && main");
  check("Windows uses python, not python3",
    detectEntrypoint(["main.py"], null, null, "win32") === "python main.py");
  check("everywhere else keeps python3",
    detectEntrypoint(["main.py"], null, null, "linux") === "python3 main.py");

  // Maven and Gradle are checked but not run: the main class cannot be inferred
  // from a file listing, and a Run button that fails confusingly is worse than
  // no Run button.
  check("a Maven project has no entry point", detectEntrypoint(["pom.xml"], null) === null);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: FAIL — "Cargo.toml means cargo run" returns `null`.

- [ ] **Step 3: Write the implementation**

Replace the body of `desktop/entrypoint.js` between the IIFE braces:

```javascript
  /**
   * Returns the command to run, or null when nothing is recognisable. null is a
   * real answer - reporting it beats running something arbitrary in the user's
   * project directory.
   *
   * `manifests` carries the contents this needs to read rather than guess at;
   * today that is only the Makefile, to see whether it has a `run` target.
   * `platform` is a process.platform value: Windows has no `./` and calls the
   * interpreter `python`.
   */
  function detectEntrypoint(paths, packageJson, manifests, platform) {
    var isWin = platform === "win32";
    var py = isWin ? "python" : "python3";
    var run = isWin ? "" : "./";
    var files = manifests || {};

    var set = {};
    (paths || []).forEach(function (p) { set[String(p).replace(/\\/g, "/")] = true; });

    // An explicit start script is the most deliberate answer available.
    if (packageJson) {
      if (packageJson.scripts && packageJson.scripts.start) return "npm start";
      if (packageJson.main) return "node " + packageJson.main;
    }

    // A manifest describes the whole project; loose files describe one file.
    if (set["Cargo.toml"]) return "cargo run";
    if (set["Makefile"]) return /^run\s*:/m.test(files.makefile || "") ? "make run" : "make";

    var fileRules = [
      { file: "main.py", command: py + " main.py" },
      { file: "src/main.py", command: py + " src/main.py" },
      { file: "app.py", command: py + " app.py" },
      { file: "index.js", command: "node index.js" },
      { file: "src/index.js", command: "node src/index.js" },
      { file: "main.c", command: "gcc main.c -o main && " + run + "main" },
      { file: "src/main.c", command: "gcc src/main.c -o main && " + run + "main" },
      { file: "main.cpp", command: "g++ main.cpp -o main && " + run + "main" },
      { file: "src/main.cpp", command: "g++ src/main.cpp -o main && " + run + "main" },
      { file: "Main.java", command: "javac Main.java && java Main" },
      { file: "App.java", command: "javac App.java && java App" },
    ];
    for (var i = 0; i < fileRules.length; i++) {
      if (set[fileRules[i].file]) return fileRules[i].command;
    }
    return null;
  }

  var api = { detectEntrypoint: detectEntrypoint };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNEntry = api;
```

Delete the old `PY` constant and `FILE_RULES` array — the rules now depend on the platform, so they are built per call.

- [ ] **Step 4: Expose the platform to the renderer**

In `desktop/preload.js`, add to the `exposeInMainWorld` object:

```javascript
  platform: process.platform,
```

- [ ] **Step 5: Pass the new arguments from the Run Project handler**

`desktop/renderer.js:499` currently reads:

```javascript
  const cmd = window.CNEntry ? window.CNEntry.detectEntrypoint(files, pkg) : null;
```

Replace it with a Makefile read and the two new arguments. The surrounding
handler already has `files`, `pkg` and `workspace` in scope, and already reads
`package.json` the same way a few lines above:

```javascript
  let makefile = null;
  if (files.indexOf("Makefile") !== -1) {
    try {
      const mk = await window.api.readFile(workspace + "/Makefile", { full: true });
      if (mk && mk.ok) makefile = mk.text;
    } catch (e) { /* an unreadable Makefile just means no `run` target */ }
  }
  const cmd = window.CNEntry
    ? window.CNEntry.detectEntrypoint(files, pkg, { makefile: makefile }, window.api.platform)
    : null;
```

Note `mk.text`, matching the `{ ok, text }` shape the `package.json` read above
already unwraps — passing the whole result object would make every `run` target
undetectable.

- [ ] **Step 6: Run tests to verify they pass**

Run: `source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && node local-agent/test/run-tests.cjs`
Expected: PASS, with the count up by 12 and no existing entry-point check broken.

Also syntax-check the renderer, which `tsc` does not cover:

Run: `source scripts/wsl-env.sh && node --check desktop/entrypoint.js && node --check desktop/renderer.js && node --check desktop/preload.js`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add desktop/entrypoint.js desktop/preload.js desktop/renderer.js local-agent/test/run-tests.cjs
git commit -m "Run Rust, C, C++ and Java projects"
```

---

### Task 6: End-to-end against real compilers

**Files:**
- Modify: `local-agent/test/run-e2e.cjs` (add a section before the `signin` section)

**Interfaces:**
- Consumes: `planChecksForWorkspace` from Task 2, `runCommand` from Task 3.
- Produces: nothing.

- [ ] **Step 1: Write the test**

Insert before the `// ------------------------------------------------ signing in to a provider` comment in `local-agent/test/run-e2e.cjs`:

```javascript
  // ------------------------------------------------------- multi-language
  section("checks catch real errors in each language");
  {
    const { planChecksForWorkspace } = require(path.join(__dirname, "..", "dist", "verification", "check-planner.js"));
    const { runCommand } = require(path.join(__dirname, "..", "dist", "verification", "command-runner.js"));
    const { resolveTool } = require(path.join(__dirname, "..", "dist", "verification", "toolchain.js"));

    // Every case runs the same shape: write a good file and a broken one, and
    // assert the check agrees. Skipped when the compiler is absent, the way the
    // chromium-dependent sections already skip - this machine has no gcc.
    const cases = [
      { tool: "gcc", name: "C", file: "main.c",
        good: "#include <stdio.h>\nint main(void) { printf(\"hi\\n\"); return 0; }\n",
        bad: "int main(void) { return 0\n" },
      { tool: "gxx", name: "C++", file: "main.cpp",
        good: "#include <string>\nint main() { std::string s = \"hi\"; return 0; }\n",
        bad: "int main() { std::string s = ; }\n" },
      { tool: "rustc", name: "Rust", file: "scratch.rs",
        good: "pub fn add(a: i32, b: i32) -> i32 { a + b }\n",
        bad: "pub fn add(a: i32, b: i32) -> i32 { a + }\n" },
      { tool: "javac", name: "Java", file: "App.java",
        good: "public class App { public static void main(String[] a) { System.out.println(1); } }\n",
        bad: "public class App { public static void main(String[] a) { int x = } }\n" },
    ];

    for (const c of cases) {
      if (!resolveTool(c.tool)) {
        console.log("  skip " + c.name + " (no " + c.tool + " on this machine)");
        continue;
      }
      const ws = mkWorkspace();

      fs.writeFileSync(path.join(ws, c.file), c.good);
      let checks = planChecksForWorkspace(ws, [c.file]);
      check(c.name + " gets exactly one check", checks.length === 1, JSON.stringify(checks));
      let r = await runCommand(checks[0].command, ws, checks[0].timeoutMs, { timeoutIsFailure: true });
      check(c.name + " passes on valid code", r.success === true, r.output);

      fs.writeFileSync(path.join(ws, c.file), c.bad);
      r = await runCommand(checks[0].command, ws, checks[0].timeoutMs, { timeoutIsFailure: true });
      check(c.name + " fails on a syntax error", r.success === false, r.output);

      // The point of the temp directory: a check must not leave build output in
      // the project it was inspecting.
      check(c.name + " leaves no artifacts in the workspace",
        fs.readdirSync(ws).length === 1, fs.readdirSync(ws).join(","));

      fs.rmSync(ws, { recursive: true, force: true });
    }

    // A Cargo project collapses to one check even with several source files.
    if (resolveTool("cargo")) {
      const ws = mkWorkspace();
      fs.mkdirSync(path.join(ws, "src"));
      fs.writeFileSync(path.join(ws, "Cargo.toml"),
        '[package]\nname = "probe"\nversion = "0.1.0"\nedition = "2021"\n');
      fs.writeFileSync(path.join(ws, "src", "main.rs"), "mod util;\nfn main() { println!(\"{}\", util::two()); }\n");
      fs.writeFileSync(path.join(ws, "src", "util.rs"), "pub fn two() -> i32 { 2 }\n");

      const checks = planChecksForWorkspace(ws, ["src/main.rs", "src/util.rs"]);
      check("a cargo project is one check, not two", checks.length === 1, JSON.stringify(checks));
      // main.rs declares `mod util;` and would fail on its own. That it passes
      // here is the entire reason the manifest rule exists.
      const r = await runCommand(checks[0].command, ws, checks[0].timeoutMs, { timeoutIsFailure: true });
      check("a multi-file crate passes as a project", r.success === true, r.output);
      fs.rmSync(ws, { recursive: true, force: true });
    } else {
      console.log("  skip cargo project (no cargo on this machine)");
    }
  }
```

- [ ] **Step 2: Run it**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-e2e.cjs > /tmp/e2e.log 2>&1; sed -n '/checks catch real errors/,/signin reports/p' /tmp/e2e.log; tail -3 /tmp/e2e.log`

Expected on this machine: every case prints `skip` and the suite still reports PASS with 150 passed, 0 failed. **A skip everywhere is the expected result here, not a failure** — none of these compilers are installed in WSL. On a machine with a toolchain the same code runs the real checks.

- [ ] **Step 3: Prove the skips are not hiding a broken test**

The risk with a test that skips everywhere is that it would fail if it ever ran. Force one case to run by temporarily making `resolveTool` return a tool that does exist — verify the Python path through the same code:

```bash
source scripts/wsl-env.sh && node -e '
const p = require("./local-agent/dist/verification/check-planner.js");
const { runCommand } = require("./local-agent/dist/verification/command-runner.js");
const fs = require("fs"), os = require("os"), path = require("path");
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"));
fs.writeFileSync(path.join(ws, "a.py"), "def f(:\n");
const checks = p.planChecksForWorkspace(ws, ["a.py"]);
runCommand(checks[0].command, ws, checks[0].timeoutMs, { timeoutIsFailure: true })
  .then(r => { console.log("checks:", checks.length, "success:", r.success); });
'
```

Expected: `checks: 1 success: false` — the planner produced a check and the check caught the error.

- [ ] **Step 4: Commit**

```bash
git add local-agent/test/run-e2e.cjs
git commit -m "Check real C, C++, Rust and Java, skipping without a toolchain"
```

---

### Task 7: Documentation

**Files:**
- Modify: `docs/ROADMAP.md:66-72`

- [ ] **Step 1: Update the roadmap**

Replace the sub-project 3 section:

```markdown
## 3 · Multi-language builds — DONE

Roadmap item 5. Spec: `specs/2026-08-10-multi-language-builds-design.md`,
plan: `plans/2026-08-10-multi-language-builds.md`

- **5. JS, Rust, C, C++, Java** — `done`. A manifest at the workspace root
  claims its language and yields one project-level check (`cargo check`,
  `make -n`, `mvn -q compile`, `gradle compileJava -q`); languages with no
  manifest are checked per file (`gcc -fsyntax-only`, `rustc --emit=metadata`,
  `javac`). Run Project handles Cargo, Makefiles and loose C/C++/Java files.

  Rust and Java could not be checked per file: a `.rs` file containing
  `mod utils;` fails alone even when the crate is perfect, and the model would
  have spent its self-heal retries fixing code that was never broken.

  A missing toolchain skips rather than fails, so a machine with Python but no
  Rust verifies nothing for Rust and says so in the log. Go and TypeScript are
  in the file walker but out of item 5's scope; each is a few lines in the
  planner.
```

Update the header count on line 3 to **5 of 9 complete** and add `3 · Multi-language builds` to the list.

- [ ] **Step 2: Run the full suite one last time**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json \
  && node local-agent/test/run-tests.cjs \
  && node local-agent/test/run-e2e.cjs > /tmp/e2e.log 2>&1; tail -3 /tmp/e2e.log
```

Expected: both PASS.

- [ ] **Step 3: Commit and merge**

```bash
git add docs/ROADMAP.md
git commit -m "Record multi-language builds as done"
git checkout main && git merge --no-ff multi-language -m "Merge multi-language builds: item 5"
git push origin main
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| `resolveTool` generalising `resolvePythonCommand` | 1 |
| `planChecks` pure, `ToolSet`/resolver injected | 2 |
| Manifest table (Cargo, Makefile, pom, gradle) | 2 |
| Per-file table (gcc, g++, rustc, javac) | 2 |
| Per-file artifacts to a temp dir | 2, verified in 6 |
| Manifest claims language even without its tool | 2 |
| `timeoutIsFailure`, 180s project / 15s file | 2, 3 |
| `detectEntrypoint` manifest-first + `run` target | 5 |
| Maven/Gradle checked but not run | 5 |
| Unit tests with no toolchain | 1, 2, 3, 5 |
| End-to-end with real compilers, skipping cleanly | 6 |
| Go and TypeScript out of scope | not implemented, recorded in 7 |

**Type consistency:** `Check`, `ToolResolver`, `planChecks`, `planChecksForWorkspace`, `FILE_CHECK_TIMEOUT_MS`, `PROJECT_CHECK_TIMEOUT_MS` and `RunOptions` are used with the same names and shapes in Tasks 2, 3, 4 and 6. The C++ tool key is `gxx` throughout, not `g++`, because `+` is awkward in a key that also names a candidate list — the resolved *command* is `g++`.

**Known gap, recorded rather than hidden:** on this machine every case in Task 6 skips, so the end-to-end language checks are unproven here. Task 6 Step 3 exists specifically to prove the surrounding code path works using a tool that *is* installed.
