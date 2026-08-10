# Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run independent build steps at the same time, so a twenty-step plan does not take half an hour of strictly serial waiting.

**Architecture:** The model declares which steps depend on which. A pure scheduler decides what may start. Several conversations run at once in separate pages of one browser context, but everything after the reply — applying, checking, approving commands — happens one at a time behind a single lock.

**Tech Stack:** Playwright `BrowserContext.newPage()` for parallel conversations, a pure scheduler as a UMD module in `desktop/`, async primitives in the agent.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-10-concurrency-design.md`. Read it before starting.
- **Only the conversation parallelises. Everything after the reply is serialised** — apply, syntax checks, and command approval. This removes shared-state races by construction rather than by careful locking.
- **A plan with no `dependsOn` runs strictly serially**, exactly as today. Every plan that exists is such a plan.
- **A cycle or an out-of-range index makes a plan unparseable**, so the caller re-asks. A build that deadlocks halfway is worse than one that asks again.
- **`blocked` is not `failed`.** A step that never ran must not be reported as having failed.
- **The default concurrency is 2**, and the setting states the risk: the realistic failure is the user's provider account being throttled, not a crash.
- **No profile cloning.** Pages in one context, never a copied profile directory.
- Run tests with `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`.
- Never commit `local-agent/storage/sessions.json` or anything under `local-agent/storage/browser-profiles/`.

## File Structure

| File | Responsibility |
|---|---|
| `local-agent/src/plan-graph.ts` (create) | `validateGraph`, `serialGraph` — is a dependency graph usable? Pure. |
| `local-agent/src/async-pool.ts` (create) | `createMutex`, `createPool` — the two async primitives. |
| `desktop/scheduler.js` (create) | `runnableSteps` — what may start now. Pure, UMD. |
| `local-agent/src/parser/json-repair.ts` (modify) | Reject an invalid graph |
| `local-agent/src/index.ts` (modify) | Plan prompt, apply lock, parallel session |
| `local-agent/src/providers/playwright-controller.ts` (modify) | `attachTo` a shared context |
| `desktop/builder.js` (modify) | Scheduler-driven loop, `blocked` state |
| `desktop/index.html`, `renderer.js`, `styles.css` (modify) | The setting, the blocked chip |
| `local-agent/test/run-tests.cjs`, `run-e2e.cjs` (modify) | Unit and overlap tests |

---

### Task 1: The dependency graph

**Files:**
- Create: `local-agent/src/plan-graph.ts`
- Modify: `local-agent/src/parser/json-repair.ts`, `local-agent/src/index.ts` (both plan prompts)
- Test: `local-agent/test/run-tests.cjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `validateGraph(steps: { dependsOn?: number[] }[]): { ok: boolean; reason?: string }`
  - `serialGraph(count: number): number[][]` — the implicit chain used when nothing is declared
  - `normaliseGraph(steps): number[][]` — each step's dependencies, declared or implied

- [ ] **Step 1: Write the failing test**

Add to `local-agent/test/run-tests.cjs`, above `function testToolchain()`:

```javascript
function testPlanGraph() {
  section("plan graph");
  const g = require(path.join(DIST, "plan-graph.js"));
  const steps = (deps) => deps.map(function (d) { return d === null ? {} : { dependsOn: d }; });

  check("an empty graph is fine", g.validateGraph([]).ok === true);
  check("a valid graph passes", g.validateGraph(steps([[], [0], [0], [1, 2]])).ok === true);

  // Rejected at parse time rather than discovered at deadlock.
  check("a self-reference is rejected", g.validateGraph(steps([[0]])).ok === false);
  check("and says why", /self/i.test(g.validateGraph(steps([[0]])).reason || ""));
  check("a two-step cycle is rejected", g.validateGraph(steps([[1], [0]])).ok === false);
  check("a long cycle is rejected", g.validateGraph(steps([[2], [0], [1]])).ok === false);
  check("a forward reference is rejected", g.validateGraph(steps([[1], []])).ok === false);
  check("an index past the end is rejected", g.validateGraph(steps([[], [9]])).ok === false);
  check("a negative index is rejected", g.validateGraph(steps([[], [-1]])).ok === false);
  check("a non-integer index is rejected", g.validateGraph([{ dependsOn: ["a"] }]).ok === false);
  check("dependsOn that is not an array is rejected", g.validateGraph([{ dependsOn: 3 }]).ok === false);

  // Absent means serial. Every plan that exists today is such a plan, and this
  // is the rule that keeps them behaving exactly as they do now.
  check("no graph at all becomes a chain",
    JSON.stringify(g.normaliseGraph(steps([null, null, null]))) === JSON.stringify([[], [0], [1]]));
  check("serialGraph builds the same chain",
    JSON.stringify(g.serialGraph(3)) === JSON.stringify([[], [0], [1]]));
  check("serialGraph of one has no dependencies",
    JSON.stringify(g.serialGraph(1)) === JSON.stringify([[]]));
  check("serialGraph of zero is empty", JSON.stringify(g.serialGraph(0)) === "[]");

  // A partially-declared plan is treated as declared: a model that answered the
  // question at all is trusted, and an empty list is a real answer.
  check("a declared empty list stays empty",
    JSON.stringify(g.normaliseGraph(steps([[], []]))) === JSON.stringify([[], []]));
  check("mixed declaration keeps what was declared",
    JSON.stringify(g.normaliseGraph([{ dependsOn: [] }, {}, { dependsOn: [0] }])) ===
    JSON.stringify([[], [], [0]]));
}
```

Register it in `main()`:

```javascript
  testPlanScale();
  testPlanGraph();
  testRunManifest();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: FAIL — `Cannot find module '.../dist/plan-graph.js'`

- [ ] **Step 3: Write the implementation**

Create `local-agent/src/plan-graph.ts`:

```typescript
/**
 * Which steps depend on which.
 *
 * Later steps read earlier steps' files. The plan guarantees each step *writes*
 * a different set; it says nothing about what a step *imports*. Inferring that
 * from file lists is guesswork, and guessing wrong fails a step whose code was
 * correct - so the model that designed the project declares it instead.
 */

/** The implicit chain: step n waits for step n-1. Today's behaviour, exactly. */
export function serialGraph(count: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < count; i++) out.push(i === 0 ? [] : [i - 1]);
  return out;
}

/**
 * Each step's dependencies, declared or implied.
 *
 * A plan where no step declares anything is a chain. A plan where any step
 * declares something is taken at its word, including the steps that declared an
 * empty list - an empty list is an answer, not a silence.
 */
export function normaliseGraph(steps: { dependsOn?: number[] }[]): number[][] {
  const list = steps || [];
  const anyDeclared = list.some((s) => Array.isArray(s && s.dependsOn));
  if (!anyDeclared) return serialGraph(list.length);
  return list.map((s) => (Array.isArray(s && s.dependsOn) ? s.dependsOn.slice() : []));
}

/**
 * Is this graph usable?
 *
 * Rejected at parse time so the caller re-asks. A build that deadlocks halfway
 * through, or runs a step before the module it imports exists, is a far worse
 * outcome than one more round-trip to the model.
 */
export function validateGraph(steps: { dependsOn?: number[] }[]): { ok: boolean; reason?: string } {
  const list = steps || [];
  for (let i = 0; i < list.length; i++) {
    const deps = list[i] && (list[i] as any).dependsOn;
    if (deps === undefined) continue;
    if (!Array.isArray(deps)) return { ok: false, reason: "step " + i + " has a dependsOn that is not a list" };
    for (const d of deps) {
      if (typeof d !== "number" || !Number.isInteger(d)) {
        return { ok: false, reason: "step " + i + " depends on a non-integer" };
      }
      if (d === i) return { ok: false, reason: "step " + i + " depends on itself" };
      if (d < 0 || d >= list.length) return { ok: false, reason: "step " + i + " depends on " + d + ", which does not exist" };
      // Only backwards references. A step depending on a later one is either a
      // cycle or a plan whose order means nothing.
      if (d > i) return { ok: false, reason: "step " + i + " depends on later step " + d };
    }
  }
  // Backwards-only references cannot form a cycle, but the check is kept
  // explicit rather than left as a proof in a comment: a future change that
  // allows forward references would otherwise silently reintroduce deadlock.
  const graph = normaliseGraph(list);
  const state = new Array(graph.length).fill(0);
  const walk = (i: number): boolean => {
    if (state[i] === 1) return false;
    if (state[i] === 2) return true;
    state[i] = 1;
    for (const d of graph[i]) if (d >= 0 && d < graph.length && !walk(d)) return false;
    state[i] = 2;
    return true;
  };
  for (let i = 0; i < graph.length; i++) if (!walk(i)) return { ok: false, reason: "the graph contains a cycle" };
  return { ok: true };
}
```

- [ ] **Step 4: Reject an invalid graph at parse time**

In `local-agent/src/parser/json-repair.ts`, add the import:

```typescript
import { validateGraph } from "../plan-graph.js";
```

And extend `parsePlanRobust`:

```typescript
export function parsePlanRobust(text: string): any {
  const plan = parsePlanShape(text);
  // Over the bound, treat the reply as unparseable so the caller re-asks.
  // Truncating to the bound would silently drop the end of the project.
  if (plan && plan.steps && plan.steps.length > MAX_PLAN_STEPS) return null;
  // Same reasoning for a graph that cannot be scheduled: re-asking costs one
  // round-trip, a deadlocked build costs the whole run.
  if (plan && plan.steps && !validateGraph(plan.steps).ok) return null;
  return plan;
}
```

- [ ] **Step 5: Ask for the graph in both plan prompts**

`planMode` — append to the Rules line:

```typescript
    "dependsOn lists the steps whose files this step imports or builds on; a step that needs nothing lists []. " +
    "Be accurate: steps with no declared dependency between them may run at the same time.\n" +
```

And extend the JSON shape in the same prompt:

```typescript
    "{\"summary\":\"goal\",\"runCommand\":\"how to run the finished project\",\"steps\":[{\"title\":\"\",\"detail\":\"\",\"files\":[\"path\"],\"dependsOn\":[]}]}" +
```

`revisePlanMode` — the same shape and one line:

```typescript
    "\n\nJSON format: {\"summary\":\"\",\"runCommand\":\"how to run the finished project\",\"steps\":[{\"title\":\"\",\"detail\":\"\",\"files\":[\"\"],\"dependsOn\":[]}]}\n" +
    "As many steps as the work needs - never pad, never compress. Different files per step.\n" +
    "dependsOn lists earlier steps this one builds on; [] if it needs nothing.";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && node local-agent/test/run-tests.cjs`
Expected: PASS, count up by 17.

Then the e2e suite, because the plan prompt changed again:

Run: `source scripts/wsl-env.sh && node local-agent/test/run-e2e.cjs > /tmp/e2e.log 2>&1; tail -3 /tmp/e2e.log`
Expected: PASS, 150 passed, 0 failed.

- [ ] **Step 7: Commit**

```bash
git add local-agent/src/plan-graph.ts local-agent/src/parser/json-repair.ts local-agent/src/index.ts local-agent/test/run-tests.cjs
git commit -m "Let a plan declare which steps depend on which"
```

---

### Task 2: The scheduler

**Files:**
- Create: `desktop/scheduler.js`
- Test: `local-agent/test/run-tests.cjs`

**Interfaces:**
- Consumes: the graph shape from Task 1 (`dependsOn` per step).
- Produces: `runnableSteps(graph, state, limit): number[]` where `graph` is `number[][]` and `state` is `{ completed: number[], failed: number[], blocked: number[], skipped: number[], running: number[] }`

- [ ] **Step 1: Write the failing test**

Add to `local-agent/test/run-tests.cjs`, above `function testToolchain()`:

```javascript
function testScheduler() {
  section("scheduler");
  const { runnableSteps, blockedBy } = require(path.join(__dirname, "..", "..", "desktop", "scheduler.js"));
  const S = (o) => Object.assign({ completed: [], failed: [], blocked: [], skipped: [], running: [] }, o);
  const serial = [[], [0], [1], [2]];
  const diamond = [[], [0], [0], [1, 2]];

  // The guarantee that nothing regresses: a chain yields one step at a time
  // however high the limit.
  check("a chain starts only the first", JSON.stringify(runnableSteps(serial, S({}), 4)) === "[0]");
  check("a chain stays one at a time",
    JSON.stringify(runnableSteps(serial, S({ completed: [0] }), 4)) === "[1]");

  // Independent steps run together, up to the limit.
  check("a diamond starts one, then two",
    JSON.stringify(runnableSteps(diamond, S({ completed: [0] }), 4)) === "[1,2]");
  check("the limit caps them",
    JSON.stringify(runnableSteps(diamond, S({ completed: [0] }), 1)) === "[1]");
  check("steps already running count against the limit",
    JSON.stringify(runnableSteps(diamond, S({ completed: [0], running: [1] }), 2)) === "[2]");
  check("a full pipeline starts nothing",
    JSON.stringify(runnableSteps(diamond, S({ completed: [0], running: [1, 2] }), 2)) === "[]");

  // A join waits for every dependency.
  check("a join waits for both",
    JSON.stringify(runnableSteps(diamond, S({ completed: [0, 1] }), 4)) === "[]");
  check("and starts once both are done",
    JSON.stringify(runnableSteps(diamond, S({ completed: [0, 1, 2] }), 4)) === "[3]");

  // Nothing left to do returns nothing, rather than looping forever.
  check("everything complete yields nothing",
    JSON.stringify(runnableSteps(diamond, S({ completed: [0, 1, 2, 3] }), 4)) === "[]");
  check("a running step is not offered twice",
    runnableSteps(diamond, S({ completed: [0], running: [1, 2] }), 9).indexOf(1) === -1);
  check("a completed step is not offered again",
    runnableSteps(serial, S({ completed: [0, 1] }), 9).indexOf(0) === -1);

  // A skipped step counts as satisfied - the user chose to move past it.
  check("a skipped dependency unblocks its dependent",
    JSON.stringify(runnableSteps(serial, S({ skipped: [0] }), 4)) === "[1]");

  // --- failure fans out, and blocked is not failed
  check("a failed step blocks its direct dependent",
    JSON.stringify(blockedBy(serial, [1])) === "[2,3]");
  check("failure blocks transitively", JSON.stringify(blockedBy(diamond, [0])) === "[1,2,3]");
  check("a failed branch blocks only its own side",
    JSON.stringify(blockedBy(diamond, [1])) === "[3]");
  check("a failure at the end blocks nothing", JSON.stringify(blockedBy(diamond, [3])) === "[]");
  check("nothing failed blocks nothing", JSON.stringify(blockedBy(diamond, [])) === "[]");
  check("a blocked step is never runnable",
    JSON.stringify(runnableSteps(serial, S({ failed: [0], blocked: [1, 2, 3] }), 4)) === "[]");
  check("a failed step does not unblock its dependent",
    JSON.stringify(runnableSteps(serial, S({ failed: [0] }), 4)) === "[]");
}
```

Register it in `main()`:

```javascript
  testPlanGraph();
  testScheduler();
  testRunManifest();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: FAIL — `Cannot find module '.../desktop/scheduler.js'`

- [ ] **Step 3: Write the implementation**

Create `desktop/scheduler.js`:

```javascript
/*
 * What may start now?
 *
 * A work queue rather than waves: called after every state change, so a fast
 * step's slot is reused immediately instead of waiting for its whole wave to
 * drain.
 *
 * Loaded as a plain <script> in the renderer (window.CNSched) and require()d by
 * the test harness. There is no bundler, so no import/export.
 */
(function (root) {
  function has(list, i) { return (list || []).indexOf(i) !== -1; }

  /**
   * Every step that can no longer run because something it needed failed.
   *
   * Transitive: if 1 depends on 0 and 3 depends on 1, a failure at 0 blocks
   * both. Reported as blocked rather than failed - a step that never ran must
   * not be described as having failed.
   */
  function blockedBy(graph, failed) {
    var g = graph || [];
    var dead = (failed || []).slice();
    var out = [];
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = 0; i < g.length; i++) {
        if (dead.indexOf(i) !== -1) continue;
        for (var j = 0; j < (g[i] || []).length; j++) {
          if (dead.indexOf(g[i][j]) !== -1) {
            dead.push(i);
            out.push(i);
            changed = true;
            break;
          }
        }
      }
    }
    return out.sort(function (a, b) { return a - b; });
  }

  function runnableSteps(graph, state, limit) {
    var g = graph || [];
    var s = state || {};
    var slots = Math.max(0, (limit || 1) - (s.running || []).length);
    var out = [];
    for (var i = 0; i < g.length && out.length < slots; i++) {
      if (has(s.completed, i) || has(s.failed, i) || has(s.blocked, i) ||
          has(s.skipped, i) || has(s.running, i)) continue;
      var ready = true;
      for (var j = 0; j < (g[i] || []).length; j++) {
        var d = g[i][j];
        // A skipped dependency counts as satisfied: the user chose to move past
        // it. A failed one does not - its dependent is blocked, not runnable.
        if (!has(s.completed, d) && !has(s.skipped, d)) { ready = false; break; }
      }
      if (ready) out.push(i);
    }
    return out;
  }

  var api = { runnableSteps: runnableSteps, blockedBy: blockedBy };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNSched = api;
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `source scripts/wsl-env.sh && node --check desktop/scheduler.js && node local-agent/test/run-tests.cjs`
Expected: PASS, count up by 19.

- [ ] **Step 5: Commit**

```bash
git add desktop/scheduler.js local-agent/test/run-tests.cjs
git commit -m "Decide what may start now"
```

---

### Task 3: Async primitives

**Files:**
- Create: `local-agent/src/async-pool.ts`
- Test: `local-agent/test/run-tests.cjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `createMutex(): { run<T>(fn: () => Promise<T>): Promise<T> }`
  - `createPool<T>(items: T[]): { acquire(): Promise<T>; release(item: T): void; size(): number }`

- [ ] **Step 1: Write the failing test**

Add to `local-agent/test/run-tests.cjs`, above `function testToolchain()`:

```javascript
async function testAsyncPool() {
  section("async primitives");
  const { createMutex, createPool } = require(path.join(DIST, "async-pool.js"));
  const wait = (ms) => new Promise(function (r) { setTimeout(r, ms); });

  // The mutex is what makes "parallel conversations, serialised applies" true.
  // If two bodies ever overlap, two workers could interleave writes to the
  // ledger or both create the same backup directory.
  const m = createMutex();
  let inside = 0;
  let maxInside = 0;
  const order = [];
  await Promise.all([1, 2, 3, 4].map(function (n) {
    return m.run(async function () {
      inside++;
      maxInside = Math.max(maxInside, inside);
      await wait(20);
      order.push(n);
      inside--;
      return n;
    });
  }));
  check("only one body runs at a time", maxInside === 1, "max=" + maxInside);
  check("all four ran", order.length === 4);
  check("they ran in the order they queued", JSON.stringify(order) === "[1,2,3,4]");
  check("the result is returned", (await m.run(async function () { return 7; })) === 7);

  // A throwing body must release the lock, or the build stops dead.
  let threw = false;
  try { await m.run(async function () { throw new Error("boom"); }); } catch (e) { threw = true; }
  check("a throwing body propagates", threw === true);
  check("and does not wedge the mutex", (await m.run(async function () { return "after"; })) === "after");

  // The pool hands out the workers.
  const pool = createPool(["a", "b"]);
  check("the pool reports its size", pool.size() === 2);
  const first = await pool.acquire();
  const second = await pool.acquire();
  check("two acquires give different items", first !== second);

  let third = null;
  const pending = pool.acquire().then(function (v) { third = v; });
  await wait(10);
  check("a third acquire waits", third === null);
  pool.release(first);
  await pending;
  check("and is served on release", third === first);
}
```

Register it in `main()` — note the `await`, like `testCommandTimeout`:

```javascript
  testScheduler();
  await testAsyncPool();
  testRunManifest();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: FAIL — `Cannot find module '.../dist/async-pool.js'`

- [ ] **Step 3: Write the implementation**

Create `local-agent/src/async-pool.ts`:

```typescript
/**
 * The two primitives concurrency needs.
 *
 * A build step is two phases: talking to the model, which is 90 seconds and
 * touches nothing shared, and everything after the reply, which is milliseconds
 * and touches the workspace, the backup directory, the delta ledger and the
 * approval queue. Only the first runs concurrently.
 */

/** Runs bodies one at a time, in the order they queued. */
export function createMutex() {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      // Chain onto the tail, but swallow the previous body's rejection here so
      // one failed step cannot wedge the lock for the whole build.
      const result = tail.then(() => fn(), () => fn());
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}

/** Hands out a fixed set of workers, making callers wait when none is free. */
export function createPool<T>(items: T[]) {
  const free: T[] = items.slice();
  const waiting: ((item: T) => void)[] = [];
  return {
    acquire(): Promise<T> {
      const ready = free.shift();
      if (ready !== undefined) return Promise.resolve(ready);
      return new Promise<T>((resolve) => waiting.push(resolve));
    },
    release(item: T): void {
      const next = waiting.shift();
      if (next) next(item);
      else free.push(item);
    },
    size(): number {
      return items.length;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && node local-agent/test/run-tests.cjs`
Expected: PASS, count up by 11.

- [ ] **Step 5: Commit**

```bash
git add local-agent/src/async-pool.ts local-agent/test/run-tests.cjs
git commit -m "Add a mutex and a worker pool"
```

---

### Task 4: A controller per worker, one browser

**Files:**
- Modify: `local-agent/src/providers/playwright-controller.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `attachTo(context: BrowserContext, config: ProviderConfig): Promise<void>` and `getContext(): BrowserContext | null` on `PlaywrightController`.

- [ ] **Step 1: Add the methods**

`PlaywrightController` holds one `page`, so a second concurrent conversation
needs a second controller — sharing the first's context, never a second profile.

In `local-agent/src/providers/playwright-controller.ts`, add after `launch`:

```typescript
  /** The context this controller launched, for workers to attach to. */
  getContext(): BrowserContext | null {
    return this.context;
  }

  /**
   * Open another page in an existing context.
   *
   * This is how concurrency happens: one launchPersistentContext, several
   * pages. Chromium locks a profile directory, so a second launch on the same
   * profile would collide - but a second page in the same context is exactly
   * what a person with two tabs open is doing.
   *
   * The context is not owned here: close() leaves it alone and shuts only this
   * controller's page, so one worker finishing does not take the browser out
   * from under the others.
   */
  async attachTo(context: BrowserContext, config: ProviderConfig): Promise<void> {
    this.context = context;
    this.ownsContext = false;
    this.page = await context.newPage();
    this.launchedConfig = config;
  }
```

Add the field beside the other private fields:

```typescript
  /** Workers share the launcher's context and must not close it. */
  private ownsContext: boolean = true;
```

And make `close()` respect it:

```typescript
  async close(): Promise<void> {
    if (!this.ownsContext) {
      if (this.page) { await this.page.close().catch(() => {}); this.page = null; }
      this.context = null;
      return;
    }
    // ...existing body unchanged...
  }
```

Read the existing `close()` before editing and keep its body intact under the
new guard.

- [ ] **Step 2: Verify**

Run: `source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && node local-agent/test/run-tests.cjs`
Expected: PASS, same count as Task 3. This task adds no tests of its own — it is
exercised by Task 5's e2e overlap test, which is the only way to prove two pages
in one context actually work.

- [ ] **Step 3: Commit**

```bash
git add local-agent/src/providers/playwright-controller.ts
git commit -m "Let a controller share another's browser context"
```

---

### Task 5: Parallel steps in the session

**Files:**
- Modify: `local-agent/src/index.ts` (`runBuildStep`, `buildSessionMode`)

**Interfaces:**
- Consumes: `createMutex`, `createPool` from Task 3; `attachTo`, `getContext` from Task 4.
- Produces: session accepts `{"type":"step",...}` messages concurrently; env var `AGENT_CONCURRENCY`.

- [ ] **Step 1: Serialise everything after the reply**

In `local-agent/src/index.ts`, add the import:

```typescript
import { createMutex, createPool } from "./async-pool.js";
```

Add a module-level lock beside the other module state:

```typescript
/**
 * Everything after a reply happens behind this: applying the patch, syntax
 * checks, and running suggested commands.
 *
 * Two workers cannot interleave writes to the delta ledger, cannot both create
 * the same backup directory, and - the one that would be worst - cannot both
 * ask the user to approve a command. Approval replies arrive on one stdin queue
 * with nothing to say which command they answer, so two concurrent prompts
 * would hand the wrong answer to the wrong command.
 */
const applyLock = createMutex();
```

Then wrap the post-response body of `runBuildStep`. The send-and-wait stays
outside the lock — that is the 90 seconds worth parallelising; everything from
parsing the reply onward goes inside:

```typescript
  return applyLock.run(async () => {
    // ...existing body from `const plan = parseMarkdownToEditPlan(response)`
    //    through the retry loop and its returns, unchanged...
  });
```

Read `runBuildStep` before editing: the lock must open **after** the
`waitForResponse` that produces `response`, and close after the final return.

- [ ] **Step 2: Run steps concurrently in the session**

Replace the chaining in `buildSessionMode`. The current code serialises with
`chain = chain.then(...)`; the pool now provides the limit instead:

```typescript
async function buildSessionMode(workspace: string, providerId: string, autonomy: string) {
  const { controller, config } = await openProviderForBuild(providerId, workspace, true);
  sessionEvent({ type: "ready" });

  // Default 2. The realistic failure is the user's provider account being
  // throttled, not a crash, so the conservative number is the right default and
  // raising it is the user's decision.
  const limit = Math.max(1, Math.min(4, parseInt(process.env.AGENT_CONCURRENCY || "2", 10) || 2));
  const workers: PlaywrightController[] = [controller];
  const ctx = controller.getContext();
  for (let i = 1; i < limit && ctx; i++) {
    const extra = new PlaywrightController(config);
    extra.setWorkspace(workspace);
    extra.setThreadKind("build");
    await extra.attachTo(ctx, config);
    workers.push(extra);
  }
  console.log("Build session ready with " + workers.length + " worker(s).");
  const pool = createPool(workers);

  let closing = false;
  let inFlight = 0;
  let onIdle: (() => void) | null = null;

  await new Promise<void>((resolve) => {
    sessionLineHandler = (line: string): boolean => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return false; }
      if (!msg || typeof msg !== "object") return false;

      if (msg.type === "close") {
        closing = true;
        // Wait for work already in flight rather than cutting it off midway:
        // a half-applied step would leave the workspace in a state nobody asked
        // for.
        if (inFlight === 0) resolve();
        else onIdle = resolve;
        return true;
      }

      if (msg.type === "step" && !closing) {
        inFlight++;
        (async () => {
          const worker = await pool.acquire();
          try {
            const outcome = await runBuildStep(worker, config, {
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
          } finally {
            pool.release(worker);
            inFlight--;
            if (closing && inFlight === 0 && onIdle) onIdle();
          }
        })();
        return true;
      }

      return false;
    };
  });

  // Workers first: each closes only its own page. The launcher closes last and
  // takes the context with it.
  for (let i = 1; i < workers.length; i++) await workers[i].close();
  await controller.close();
  sessionLineHandler = null;
}
```

Read the existing `buildSessionMode` before replacing it and keep any cleanup at
the end that this does not mention.

- [ ] **Step 3: Pass the setting through**

In `desktop/main.js`, the `start-session` handler already builds its env through
`agentEnv`. Add the limit to the session spawn:

```javascript
      proc = spawnAgent(["build-session", payload.workspace, payload.provider, payload.autonomy || "ask"],
        Object.assign(agentEnv(headed, payload.controls),
          { AGENT_CONCURRENCY: String(payload.concurrency || 2) }));
```

- [ ] **Step 4: Verify**

Run: `source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json && node --check desktop/main.js && node local-agent/test/run-tests.cjs`
Expected: PASS, same count as Task 3.

Then the full e2e suite, which drives real builds through the session:

Run: `source scripts/wsl-env.sh && node local-agent/test/run-e2e.cjs > /tmp/e2e.log 2>&1; tail -3 /tmp/e2e.log`
Expected: PASS, 150 passed, 0 failed. The **build session** and **build steps
share one chat thread** sections are the ones that would catch a mistake here.

- [ ] **Step 5: Commit**

```bash
git add local-agent/src/index.ts desktop/main.js
git commit -m "Run conversations in parallel, applies one at a time"
```

---

### Task 6: The scheduler drives the build

**Files:**
- Modify: `desktop/builder.js` (`CN.startBuild`), `desktop/index.html`, `desktop/styles.css`

**Interfaces:**
- Consumes: `runnableSteps`, `blockedBy` from Task 2; `normaliseGraph` semantics from Task 1.
- Produces: a `blocked` step status.

- [ ] **Step 1: Load the scheduler**

In `desktop/index.html`, beside the other UMD modules:

```html
<script src="preview-target.js"></script>
<script src="scheduler.js"></script>
```

- [ ] **Step 2: Replace the serial loop**

In `desktop/builder.js`, replace the `for` loop inside `CN.startBuild`:

```javascript
    // The graph, declared or implied. A plan where nothing is declared is a
    // chain, which reproduces the old serial loop exactly.
    const anyDeclared = steps.some(function (s) { return Array.isArray(s.dependsOn); });
    const graph = steps.map(function (s, i) {
      if (anyDeclared) return Array.isArray(s.dependsOn) ? s.dependsOn.slice() : [];
      return i === 0 ? [] : [i - 1];
    });
    const limit = CN.getConcurrency();
    const state = { completed: [], failed: [], blocked: [], skipped: [], running: [] };
    let launched = 0;

    function settle(i, ok) {
      state.running = state.running.filter(function (x) { return x !== i; });
      (ok ? state.completed : state.failed).push(i);
      if (!ok) {
        // Blocked, not failed: these steps never ran, and saying they failed
        // would claim something about code nobody executed.
        window.CNSched.blockedBy(graph, state.failed).forEach(function (b) {
          if (state.blocked.indexOf(b) === -1 && state.completed.indexOf(b) === -1) {
            state.blocked.push(b);
            setStatusOf(b, "blocked");
          }
        });
      }
      progress((state.completed.length + state.failed.length + state.blocked.length + state.skipped.length) / steps.length);
    }

    while (!stopRequested) {
      while (paused && !stopRequested) await sleep(500);
      if (stopRequested) break;

      const ready = window.CNSched.runnableSteps(graph, state, limit);
      if (!ready.length) {
        if (state.running.length === 0) break;   // nothing running, nothing startable: done
        await sleep(250);
        continue;
      }

      ready.forEach(function (i) {
        if (skipNext) {
          skipNext = false;
          state.skipped.push(i);
          setStatusOf(i, "skipped");
          CN.log("step " + (i + 1) + " skipped", "step");
          return;
        }
        state.running.push(i);
        launched++;
        runOne(i).then(function (ok) { settle(i, ok); },
                       function () { settle(i, false); });
      });
      await sleep(120);
    }

    // Let anything still in flight finish before the session closes, or its
    // apply would be cut off midway.
    while (state.running.length && !stopRequested) await sleep(250);
```

Read `CN.startBuild` before replacing, and keep the session setup above the loop
and the teardown below it exactly as they are.

- [ ] **Step 3: Style the blocked chip**

In `desktop/styles.css`, beside the other status rules:

```css
/* Blocked is not failed: it means a dependency failed, so this never ran.
   Dashed like skipped, because in both cases no code was executed. */
.step-card-status.blocked{color:var(--mut);border-style:dashed;opacity:.7;}
```

- [ ] **Step 4: Verify**

Run: `source scripts/wsl-env.sh && node --check desktop/builder.js && node local-agent/test/run-tests.cjs`
Expected: PASS. The css lint catches any colour literal.

Run: `cd desktop && npm start` and build a plan. Expected: with a plan that has
no `dependsOn`, steps run one at a time exactly as before — that is the
regression check that matters most.

- [ ] **Step 5: Commit**

```bash
git add desktop/builder.js desktop/index.html desktop/styles.css
git commit -m "Let the scheduler drive the build"
```

---

### Task 7: The concurrency setting

**Files:**
- Modify: `desktop/index.html`, `desktop/renderer.js`, `desktop/preload.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `CN.getConcurrency(): number`, `localStorage` key `closeni.concurrency`.

- [ ] **Step 1: Add the control**

In `desktop/index.html`, inside the Permissions settings section after the
Show Browser row:

```html
<div class="micro mt-2">Parallel steps</div>
<select id="concurrency-select">
  <option value="1">1 - one at a time</option>
  <option value="2" selected>2 - faster</option>
  <option value="3">3 - fastest</option>
</select>
<div class="hint">Independent steps run at the same time in separate tabs.
  More parallel conversations means more load on your provider account, which
  can get it rate-limited. 2 is a safe default.</div>
```

- [ ] **Step 2: Persist it and expose it**

In `desktop/renderer.js`, beside the autonomy persistence:

```javascript
// Persist the concurrency choice, and say what raising it costs. The realistic
// failure is a throttled provider account, not a crash.
(function () {
  const sel = $("concurrency-select");
  if (!sel) return;
  try { const saved = localStorage.getItem("closeni.concurrency"); if (saved) sel.value = saved; } catch (e) {}
  sel.onchange = function () { try { localStorage.setItem("closeni.concurrency", sel.value); } catch (e) {} };
})();
```

Add to the `window.CN` object:

```javascript
  getConcurrency: function () {
    const s = $("concurrency-select");
    const n = parseInt((s && s.value) || "2", 10);
    return Math.max(1, Math.min(3, isNaN(n) ? 2 : n));
  },
```

And pass it when starting a session — extend `CN.startSession`:

```javascript
  startSession: function (ws, prov, autonomy) {
    try {
      const cb = $("show-browser");
      return window.api.startSession(ws, prov, autonomy, cb ? cb.checked : false, desiredControls(), window.CN.getConcurrency())
        .catch(function (e) { return { ok: false, error: String(e) }; });
    } catch (e) { return Promise.resolve({ ok: false, error: String(e) }); }
  },
```

In `desktop/preload.js`:

```javascript
  startSession: function (workspace, provider, autonomy, headed, controls, concurrency) {
    return ipcRenderer.invoke("start-session", { workspace: workspace, provider: provider, autonomy: autonomy, headed: headed, controls: controls, concurrency: concurrency });
  },
```

- [ ] **Step 3: Add the spacing class**

`mt-2` does not exist yet. In `desktop/styles.css`, beside `.mt-1`:

```css
.mt-2{margin-top:var(--sp-5);}
```

- [ ] **Step 4: Verify**

Run: `source scripts/wsl-env.sh && node --check desktop/renderer.js && node --check desktop/preload.js && node local-agent/test/run-tests.cjs`
Expected: PASS.

Run: `cd desktop && npm start`. Settings → Permissions shows the selector with
its warning; changing it survives a restart.

- [ ] **Step 5: Commit**

```bash
git add desktop/index.html desktop/renderer.js desktop/preload.js desktop/styles.css
git commit -m "Let the user choose how many steps run at once"
```

---

### Task 8: Prove steps overlap, document, merge

**Files:**
- Modify: `local-agent/test/run-e2e.cjs`, `README.md`, `docs/ROADMAP.md`

- [ ] **Step 1: Write the overlap test**

Everything so far proves the *decisions* are right. This proves two
conversations actually run at once. Insert before the `signin` section in
`local-agent/test/run-e2e.cjs`:

```javascript
  // ------------------------------------------------------------ concurrency
  section("independent steps overlap in time");
  {
    const { createMutex, createPool } = require(path.join(__dirname, "..", "dist", "async-pool.js"));
    const { runnableSteps } = require(path.join(__dirname, "..", "..", "desktop", "scheduler.js"));

    // A diamond: 1 and 2 are independent, 3 waits for both. Each "step" sleeps,
    // so overlap is measurable.
    const graph = [[], [0], [0], [1, 2]];
    const pool = createPool(["w1", "w2"]);
    const lock = createMutex();
    const spans = [];
    let applyOverlap = 0;
    let inApply = 0;
    const state = { completed: [], failed: [], blocked: [], skipped: [], running: [] };

    async function fakeStep(i) {
      const w = await pool.acquire();
      const start = Date.now();
      await new Promise(function (r) { setTimeout(r, 300); });     // the conversation
      await lock.run(async function () {                            // the apply
        inApply++;
        if (inApply > 1) applyOverlap++;
        await new Promise(function (r) { setTimeout(r, 40); });
        inApply--;
      });
      spans.push({ i: i, start: start, end: Date.now() });
      pool.release(w);
      state.running = state.running.filter(function (x) { return x !== i; });
      state.completed.push(i);
    }

    const t0 = Date.now();
    while (state.completed.length < 4) {
      const ready = runnableSteps(graph, state, 2);
      ready.forEach(function (i) { state.running.push(i); fakeStep(i); });
      await new Promise(function (r) { setTimeout(r, 30); });
    }
    const elapsed = Date.now() - t0;

    const s1 = spans.find(function (s) { return s.i === 1; });
    const s2 = spans.find(function (s) { return s.i === 2; });
    const s3 = spans.find(function (s) { return s.i === 3; });
    check("all four steps ran", spans.length === 4);
    check("the independent pair overlapped", s1.start < s2.end && s2.start < s1.end,
      JSON.stringify([s1, s2]));
    check("the join started after both finished", s3.start >= Math.max(s1.end, s2.end) - 60);
    // Four serial steps would be ~1360ms; three waves is ~1020ms.
    check("it beat running them serially", elapsed < 1250, elapsed + "ms");
    // The whole point of the lock.
    check("no two applies overlapped", applyOverlap === 0, String(applyOverlap));
  }
```

- [ ] **Step 2: Run it**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-e2e.cjs > /tmp/e2e.log 2>&1; sed -n '/independent steps overlap/,/signin reports/p' /tmp/e2e.log; tail -3 /tmp/e2e.log`
Expected: PASS, 155 passed, 0 failed.

- [ ] **Step 3: Document it**

Add to `README.md` after the run-file section:

```markdown
## Parallel steps

A plan declares which steps depend on which, so steps that need nothing from
each other run at the same time in separate browser tabs. Set how many in
Settings → Permissions; the default is 2.

Only the conversations run in parallel. Applying files, syntax checks and
command approvals happen one at a time, so two steps can never interleave writes
to your workspace.

**More is not always better.** Each parallel step is another conversation with
your provider, and providers rate-limit. If builds start hanging, lower it.
```

- [ ] **Step 4: Record the sub-project**

Replace the sub-project 4 section of `docs/ROADMAP.md`:

```markdown
## 4 · Concurrency & multi-agent — DONE

Roadmap item 4. Spec: `specs/2026-08-10-concurrency-design.md`,
plan: `plans/2026-08-10-concurrency.md`

- **4. Concurrent agents + inter-agent communication** — `done` for the
  concurrency half. Independent steps run at the same time in separate pages of
  one browser context.

  The blocker recorded here — that browser profiles are per provider — turned
  out to constrain two *browsers*, not two *conversations*. One context opens
  many pages, which is what a person with three tabs is doing, and it avoids the
  profile cloning sub-project 8 already refused.

  The real constraint was that later steps read earlier steps' files, which the
  plan never described. The model now declares `dependsOn`, because inferring it
  from file lists would fail steps whose code was correct.

  **Only conversations parallelise; applies are serialised.** That removes every
  shared-state race by construction, including the worst one: approval replies
  arrive on a single stdin queue with nothing to say which command they answer,
  so two concurrent prompts would hand the wrong answer to the wrong command.

  Default 2, configurable. The realistic failure is a throttled provider
  account, not a crash — and a throttled session looks like a slow reply, which
  the completion detector will wait out. Conservative default, not cleverness.

  **Not done:** inter-agent communication in the sense of a reviewer agent on a
  second provider. It makes each step slower, which is the opposite of this
  sub-project's purpose, and deserves its own decision.
```

Update the header count on line 3 to **9 of 10 complete** and add
`4 · Concurrency & multi-agent` to the list.

- [ ] **Step 5: Run the full suite**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json \
  && node local-agent/test/run-tests.cjs \
  && node local-agent/test/run-e2e.cjs > /tmp/e2e.log 2>&1; tail -3 /tmp/e2e.log
```

Expected: both PASS.

- [ ] **Step 6: Commit and merge**

```bash
git add -A
git commit -m "Prove independent steps overlap, and document it"
git checkout main && git merge --no-ff concurrency -m "Merge concurrency: item 4"
git push origin main
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| `dependsOn` in the plan schema | 1 |
| Prompts ask for it (both plan modes) | 1 Step 5 |
| Cycles/self/forward/out-of-range rejected at parse time | 1 |
| Absent graph means serial | 1 (`normaliseGraph`), 6 (builder mirrors it) |
| Pure scheduler, work-queue not waves | 2 |
| Failure blocks dependents transitively | 2 (`blockedBy`), 6 (applied) |
| `blocked` is not `failed` | 2, 6 |
| Parallel conversations | 5 |
| Serialised applies | 5 Step 1 |
| Pages in one context, no cloning | 4 |
| Default 2, configurable, risk stated | 5, 7 |
| Worker threads transient, not persisted | 5 — workers never call `setBuildThread`; only the launcher's thread is recorded |
| `blocked` chip in the step list | 6 Step 3 |
| Scheduler unit tests | 2 |
| Graph validation unit tests | 1 |
| End-to-end overlap test | 8 |

**Gap found and closed:** the spec says a skipped step should not stall the
build, but never says whether skipping satisfies a dependency. It now does —
`runnableSteps` treats `skipped` as satisfied, because the user chose to move
past that step and blocking everything downstream would make Skip useless. Tested
in Task 2.

**A risk the spec understated, now handled in Task 5 Step 1:** approval replies
arrive on one stdin queue with nothing identifying which command they answer.
Two concurrent prompts would hand the wrong answer to the wrong command — a
security-relevant confusion, since the answer might be "allow". Putting command
execution inside the apply lock prevents two prompts existing at once. This is a
stronger reason for the lock than the ledger races the spec cites.

**Type consistency:** `runnableSteps`, `blockedBy`, `validateGraph`,
`normaliseGraph`, `serialGraph`, `createMutex`, `createPool`, `attachTo`,
`getContext`, `getConcurrency` and `AGENT_CONCURRENCY` are used identically
throughout. The state object has the same five arrays in Tasks 2 and 6.

**Known risks:**

1. **Tasks 4 and 5 have no unit tests** — they are browser plumbing. Task 8's
   overlap test covers the primitives and the scheduler together, and the
   existing e2e session tests cover the single-worker path, but "two Playwright
   pages in one persistent context both drive a provider correctly" is proven
   only by running a real build.
2. **Whether providers tolerate this at all** is untestable here. If DeepSeek
   throttles, it looks like a slow reply, not an error.
3. **Task 6 replaces the build loop**, the most load-bearing loop in the app. The
   regression check that matters is a plan with no `dependsOn` behaving exactly
   as before, and it is the first thing Step 4 asks for.
