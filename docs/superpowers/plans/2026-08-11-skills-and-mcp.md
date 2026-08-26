# Skills, Personas and MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user change what the model knows and how it works — a persona, any number of skills, and MCP tool output — without editing `buildPrompt` and recompiling.

**Architecture:** Three pure modules plus one subprocess client. `prompt-compose.ts` assembles persona → skills → MCP context → base under one hard budget, truncating lowest-priority-first and reporting what it dropped. `skill-store.ts` reads `.md` files from the user data directory. `mcp-client.ts` speaks three JSON-RPC methods over stdio to a server the user configured. The composed preamble reaches the agent through an environment variable, exactly as `AGENT_CONTROLS` already does, rather than as a new positional argument threaded through every mode.

**Tech Stack:** TypeScript compiled to CommonJS in `local-agent/`; UMD renderer modules in `desktop/`; Node's own `child_process` and `fs` — no new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-08-10-skills-and-mcp-design.md`

## Global Constraints

- **No new runtime dependency.** The MCP client is three JSON-RPC methods over stdio, written by hand. The project's only runtime dependencies are Playwright and Electron and that does not change.
- **Budget is 6000 characters** across everything prepended, as one hard total.
- **`base` is never truncated, at any budget.** The JSON formatting instruction lives in `base`, and this project has lost whole builds to replies the parser could not read.
- **Order is persona → skills → MCP context → base.** The task goes last because it is what the model should still be reading when it starts generating.
- **Failure is never fatal.** A server that will not start, a tool that errors, one that times out: log and skip. A build must not fail because an optional context source was unavailable.
- **Truncation is reported, never silent.** The user must see that they configured more than was sent.
- **No frontmatter, no registry, no versioning.** A skill is a paragraph of Markdown; the filename is the display name.
- **Files live under the Electron user data directory**, reached with `defaultStorageRoot()` from `local-agent/src/storage-paths.ts` so a CLI run and the app agree — the bug fixed on 11 August.
- Every module that can be pure **is** pure, and is tested without a subprocess, a network or a clock. This matches `check-planner.ts`, `selector-health.ts` and `smoke-report.ts`.

---

## File Structure

| File | Responsibility |
|---|---|
| `local-agent/src/prompt-compose.ts` | **Create.** Order, budget, truncation, truncation report. Pure. |
| `local-agent/src/skill-store.ts` | **Create.** Discover persona/skill `.md` files; read selected ones. |
| `local-agent/src/mcp/mcp-client.ts` | **Create.** `initialize`, `tools/list`, `tools/call` over stdio. |
| `local-agent/src/mcp/mcp-context.ts` | **Create.** Read `mcp.json`, run the configured calls, return text. Pure planning split from the impure run, as `check-planner` splits. |
| `local-agent/src/index.ts` | **Modify.** Read `AGENT_PREAMBLE`; prepend via `composePrompt` in `buildPrompt`. |
| `desktop/main.js` | **Modify.** IPC: list/read/write/delete skills, import from GitHub, read/write `mcp.json`. |
| `desktop/preload.js` | **Modify.** Expose those calls. |
| `desktop/index.html` | **Modify.** A `skills` Settings section. |
| `desktop/renderer.js` | **Modify.** Render it; put the composed preamble in `AGENT_PREAMBLE`. |
| `desktop/github-api.js` | **Modify.** `getFile(owner, repo, path)` for GitHub import. |
| `local-agent/test/run-tests.cjs` | **Modify.** Tests for each task. |
| `scripts/verify.mjs` | **Modify.** Pin the invariants that only exist as renderer wiring. |

---

### Task 1: Prompt composition and the budget

**Files:**
- Create: `local-agent/src/prompt-compose.ts`
- Test: `local-agent/test/run-tests.cjs` (new `testPromptCompose()`)

**Interfaces:**
- Consumes: nothing.
- Produces: `composePrompt(parts: PromptParts, budget?: number): Composed`
  where `PromptParts = { persona?: string; skills?: string[]; mcpContext?: string[]; base: string }`
  and `Composed = { text: string; truncated: string[] }`.
  Also `export const PREAMBLE_BUDGET_CHARS = 6000`.

- [ ] **Step 1: Write the failing test**

Add to `local-agent/test/run-tests.cjs`, and register `testPromptCompose();` in the runner list beside the other `test*()` calls:

```javascript
function testPromptCompose() {
  section("what gets prepended, and what gets dropped");
  const C = require(path.join(DIST, "prompt-compose.js"));

  const parts = {
    persona: "You are terse.",
    skills: ["Write pytest tests.", "Prefer the standard library."],
    mcpContext: ["Flask docs: use app.route."],
    base: "TASK: build a thing. Reply with ```json.",
  };
  const out = C.composePrompt(parts);

  // Order is the design decision: who you are, how to work, what is true,
  // what to do. The task is last so it is what the model is still reading
  // when it starts generating.
  const iPersona = out.text.indexOf("You are terse.");
  const iSkill = out.text.indexOf("Write pytest tests.");
  const iMcp = out.text.indexOf("Flask docs");
  const iBase = out.text.indexOf("TASK: build a thing.");
  check("persona comes first", iPersona >= 0 && iPersona < iSkill);
  check("skills come before context", iSkill < iMcp);
  check("context comes before the task", iMcp < iBase);
  check("nothing was dropped under budget", out.truncated.length === 0, JSON.stringify(out.truncated));
  check("every skill is present", out.text.includes("Prefer the standard library."));

  // Each part absent individually, leaving no stray separator behind.
  const bare = C.composePrompt({ base: "ONLY" });
  check("an empty parts object yields exactly base", bare.text === "ONLY", JSON.stringify(bare.text));
  check("and reports nothing dropped", bare.truncated.length === 0);
  const noPersona = C.composePrompt({ skills: ["S"], base: "B" });
  check("no persona leaves no blank lead-in", !/^\s/.test(noPersona.text), JSON.stringify(noPersona.text.slice(0, 12)));
  const emptyStrings = C.composePrompt({ persona: "   ", skills: ["", "  "], mcpContext: [""], base: "B" });
  check("blank parts are treated as absent", emptyStrings.text === "B", JSON.stringify(emptyStrings.text));

  // Over budget: lowest priority first.
  const big = (n) => "x".repeat(n);
  const over = C.composePrompt(
    { persona: big(400), skills: [big(400)], mcpContext: [big(400)], base: "BASE" }, 900);
  check("mcp context is dropped first", over.truncated.includes("mcp context"), JSON.stringify(over.truncated));
  check("and it is gone from the text", !over.text.includes(big(400) + "\n\nBASE"));
  const tighter = C.composePrompt(
    { persona: big(400), skills: [big(400)], mcpContext: [big(400)], base: "BASE" }, 500);
  check("then skills", tighter.truncated.includes("skills"), JSON.stringify(tighter.truncated));
  const tightest = C.composePrompt(
    { persona: big(400), skills: [big(400)], mcpContext: [big(400)], base: "BASE" }, 50);
  check("then persona", tightest.truncated.includes("persona"), JSON.stringify(tightest.truncated));

  // THE check. base carries the JSON instruction, and a build has been lost to
  // a reply the parser could not read.
  check("base survives a budget smaller than itself",
    tightest.text.includes("BASE"), JSON.stringify(tightest.text));
  const microBudget = C.composePrompt({ persona: big(9000), base: "BASE" }, 1);
  check("base survives a budget of 1", microBudget.text === "BASE", JSON.stringify(microBudget.text));
  check("base alone over budget is still returned whole",
    C.composePrompt({ base: big(9000) }, 10).text.length === 9000);

  check("the default budget is 6000", C.PREAMBLE_BUDGET_CHARS === 6000);
  check("nonsense budget falls back to the default",
    C.composePrompt(parts, NaN).text === out.text);
  check("null parts do not throw", typeof C.composePrompt(null).text === "string");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs 2>&1 | grep -A2 "what gets prepended"`
Expected: FAIL — `Cannot find module '.../dist/prompt-compose.js'`

- [ ] **Step 3: Write minimal implementation**

Create `local-agent/src/prompt-compose.ts`:

```typescript
/**
 * What goes in front of a step's prompt, and what gets cut when it will not fit.
 *
 * Order is the decision: persona, then skills, then MCP context, then the task.
 * Who you are, how to work, what is true, what to do - and the task last,
 * because it is what the model should still be reading when it starts to
 * generate.
 *
 * The budget exists because this project has lost whole builds to replies the
 * parser could not read. A persona plus three skills plus a fetched page of
 * documentation can put thousands of characters between the model and the JSON
 * formatting instruction. So `base` is never truncated at any budget - it
 * carries that instruction - and everything else is cut lowest-priority first
 * and REPORTED, because silently sending a smaller prompt than the user
 * configured is how a setting stops meaning anything.
 */

export const PREAMBLE_BUDGET_CHARS = 6000;

export interface PromptParts {
  persona?: string;
  skills?: string[];
  mcpContext?: string[];
  base: string;
}

export interface Composed {
  text: string;
  /** Names of the parts that did not fit, in the order they were dropped. */
  truncated: string[];
}

function clean(v: string | undefined | null): string {
  return typeof v === "string" ? v.trim() : "";
}

function cleanList(v: string[] | undefined | null): string[] {
  return (Array.isArray(v) ? v : []).map(clean).filter(Boolean);
}

export function composePrompt(parts: PromptParts | null | undefined, budget?: number): Composed {
  const p = parts || ({ base: "" } as PromptParts);
  const base = typeof p.base === "string" ? p.base : "";
  const limit = Number.isFinite(budget as number) && (budget as number) > 0
    ? Math.floor(budget as number)
    : PREAMBLE_BUDGET_CHARS;

  let persona = clean(p.persona);
  let skills = cleanList(p.skills);
  let mcpContext = cleanList(p.mcpContext);
  const truncated: string[] = [];

  const size = () =>
    (persona ? persona.length + 2 : 0) +
    skills.reduce((a, s) => a + s.length + 2, 0) +
    mcpContext.reduce((a, s) => a + s.length + 2, 0);

  // Lowest priority first: context is the most replaceable, persona the least.
  if (size() > limit && mcpContext.length) { mcpContext = []; truncated.push("mcp context"); }
  if (size() > limit && skills.length) { skills = []; truncated.push("skills"); }
  if (size() > limit && persona) { persona = ""; truncated.push("persona"); }

  const blocks = ([] as string[])
    .concat(persona ? [persona] : [])
    .concat(skills)
    .concat(mcpContext)
    .concat([base]);

  return { text: blocks.join("\n\n"), truncated: truncated };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `source scripts/wsl-env.sh && npm run build && node local-agent/test/run-tests.cjs 2>&1 | tail -3`
Expected: PASS, with the total up by the number of new checks.

- [ ] **Step 5: Commit**

```bash
git add local-agent/src/prompt-compose.ts local-agent/test/run-tests.cjs
git commit -m "Compose a prompt preamble that cannot crowd out the format rules"
```

---

### Task 2: Reading personas and skills off disk

**Files:**
- Create: `local-agent/src/skill-store.ts`
- Test: `local-agent/test/run-tests.cjs` (new `testSkillStore()`)

**Interfaces:**
- Consumes: `defaultStorageRoot()` from `local-agent/src/storage-paths.ts`.
- Produces:
  `skillsDir(root: string): string`, `personasDir(root: string): string`,
  `listMarkdown(dir: string): string[]` (display names, no `.md`, sorted),
  `readSelected(dir: string, names: string[]): string[]`,
  `isSafeName(name: string): boolean`.

- [ ] **Step 1: Write the failing test**

```javascript
function testSkillStore() {
  section("personas and skills are just files");
  const S = require(path.join(DIST, "skill-store.js"));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-skills-"));
  const sd = S.skillsDir(root);
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, "pytest.md"), "Always write pytest tests.");
  fs.writeFileSync(path.join(sd, "stdlib.md"), "Prefer the standard library.");
  fs.writeFileSync(path.join(sd, "notes.txt"), "not a skill");
  fs.mkdirSync(path.join(sd, "adir.md"), { recursive: true });

  check("skills live under the storage root",
    sd === path.join(root, "skills") && S.personasDir(root) === path.join(root, "personas"));
  const names = S.listMarkdown(sd);
  check("the filename is the display name",
    JSON.stringify(names) === JSON.stringify(["pytest", "stdlib"]), JSON.stringify(names));
  check("a non-markdown file is ignored", !names.includes("notes"));
  check("a directory named .md is ignored", !names.includes("adir"));
  check("an unreadable directory yields an empty list rather than throwing",
    JSON.stringify(S.listMarkdown(path.join(root, "nope"))) === "[]");

  const read = S.readSelected(sd, ["pytest", "missing", "stdlib"]);
  check("only the selected files are read", read.length === 2, JSON.stringify(read));
  check("contents come back", read[0] === "Always write pytest tests.");
  check("a selected file that is gone is skipped, not fatal", !read.join(" ").includes("missing"));
  check("selection order is preserved", read[1] === "Prefer the standard library.");

  // A name comes from the renderer and is used to build a path. Anything that
  // could leave the directory is refused rather than sanitised, because a
  // sanitised name silently reads a different file than the one asked for.
  check("a plain name is safe", S.isSafeName("pytest") === true);
  check("a dotted name is safe", S.isSafeName("py.test-1_x") === true);
  check("traversal is refused", S.isSafeName("../../etc/passwd") === false);
  check("a separator is refused", S.isSafeName("a/b") === false && S.isSafeName("a\\b") === false);
  check("an absolute path is refused", S.isSafeName("/etc/passwd") === false);
  check("empty is refused", S.isSafeName("") === false && S.isSafeName("   ") === false);
  check("an unsafe name reads nothing",
    JSON.stringify(S.readSelected(sd, ["../../etc/passwd"])) === "[]");

  fs.rmSync(root, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs 2>&1 | grep -A2 "just files"`
Expected: FAIL — `Cannot find module '.../dist/skill-store.js'`

- [ ] **Step 3: Write minimal implementation**

Create `local-agent/src/skill-store.ts`:

```typescript
/**
 * Personas and skills, as plain Markdown files.
 *
 * A persona is a stance; a skill is a practice. Both are a paragraph of prose,
 * and inventing frontmatter, a registry or versioning around a paragraph would
 * be the larger commitment. The filename is the display name.
 *
 * Under the same user data directory the desktop app uses, so a headless run
 * and the app see the same skills - the mistake fixed on 11 August, where the
 * app and the CLI read two different browser profiles.
 */
import * as fs from "fs";
import * as path from "path";

export function skillsDir(root: string): string {
  return path.join(root, "skills");
}

export function personasDir(root: string): string {
  return path.join(root, "personas");
}

/**
 * Is this a name we will turn into a path?
 *
 * Refused rather than sanitised. A sanitised name silently reads a different
 * file than the one asked for, and the name arrives from the renderer.
 */
export function isSafeName(name: string): boolean {
  const n = String(name || "").trim();
  if (!n) return false;
  if (n.includes("/") || n.includes("\\")) return false;
  if (n === "." || n === ".." || n.startsWith(".")) return false;
  return /^[A-Za-z0-9._-]+$/.test(n);
}

/** Display names of the .md files in a directory, sorted, without extensions. */
export function listMarkdown(dir: string): string[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // A directory that does not exist yet is a user who has written no skills,
    // not an error worth surfacing.
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => e.name.slice(0, -3))
    .filter(isSafeName)
    .sort();
}

/** The contents of the named files, in the order given, skipping any that fail. */
export function readSelected(dir: string, names: string[]): string[] {
  const out: string[] = [];
  for (const name of names || []) {
    if (!isSafeName(name)) continue;
    try {
      const text = fs.readFileSync(path.join(dir, name + ".md"), "utf-8").trim();
      if (text) out.push(text);
    } catch {
      // A selected skill whose file has been deleted is a stale checkbox, not a
      // reason to fail a build.
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `source scripts/wsl-env.sh && npm run build && node local-agent/test/run-tests.cjs 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add local-agent/src/skill-store.ts local-agent/test/run-tests.cjs
git commit -m "Read personas and skills as plain markdown files"
```

---

### Task 3: The minimal MCP client

**Files:**
- Create: `local-agent/src/mcp/mcp-client.ts`
- Create: `local-agent/test/fixtures/fake-mcp-server.js`
- Test: `local-agent/test/run-tests.cjs` (new `testMcpClient()`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  `callTool(server: ServerSpec, tool: string, args: any, timeoutMs?: number): Promise<{ ok: boolean; text: string; error?: string }>`
  where `ServerSpec = { command: string; args?: string[]; env?: Record<string,string> }`.
  `listTools(server: ServerSpec, timeoutMs?: number): Promise<{ ok: boolean; tools: string[]; error?: string }>`
  — the third of the spec's three methods. `callTool` does not need it, because a
  configured call names its tool; the Settings panel needs it to show what a
  server offers, and leaving it out would have made the fixture answer a request
  nothing ever sent.
  Also `export function textFromResult(result: any): string` (pure) and
  `export const MCP_TIMEOUT_MS = 20000`.

- [ ] **Step 1: Write the failing test**

First create the fixture `local-agent/test/fixtures/fake-mcp-server.js`:

```javascript
/*
 * An MCP server that speaks just enough JSON-RPC to test the client, and does
 * nothing else. FAKE_MCP_MODE selects the failure being exercised.
 */
const readline = require("readline");
const mode = process.env.FAKE_MCP_MODE || "ok";

if (mode === "exit") process.exit(3);

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

readline.createInterface({ input: process.stdin }).on("line", function (line) {
  if (mode === "silent") return;
  if (mode === "garbage") { process.stdout.write("not json at all\n"); return; }
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "fake" } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "fetch" }] } });
  } else if (msg.method === "tools/call") {
    if (mode === "error") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "tool exploded" } });
    } else {
      send({ jsonrpc: "2.0", id: msg.id,
        result: { content: [{ type: "text", text: "ARGS:" + JSON.stringify(msg.params.arguments) }] } });
    }
  }
});
```

Then add:

```javascript
async function testMcpClient() {
  section("MCP, spoken by hand over stdio");
  const M = require(path.join(DIST, "mcp/mcp-client.js"));
  const fixture = path.join(__dirname, "fixtures", "fake-mcp-server.js");
  const spec = (mode) => ({ command: process.execPath, args: [fixture], env: { FAKE_MCP_MODE: mode } });

  // The result shape is MCP's, and pulling text out of it is pure.
  check("text content is extracted",
    M.textFromResult({ content: [{ type: "text", text: "hello" }] }) === "hello");
  check("several text blocks are joined",
    M.textFromResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }) === "a\nb");
  check("non-text content is ignored",
    M.textFromResult({ content: [{ type: "image", data: "..." }, { type: "text", text: "t" }] }) === "t");
  check("an unrecognised shape yields empty", M.textFromResult({ nope: 1 }) === "");
  check("null does not throw", M.textFromResult(null) === "");

  const good = await M.callTool(spec("ok"), "fetch", { url: "https://x.test" });
  check("a handshake and a call return text", good.ok === true, JSON.stringify(good));
  check("the arguments reached the tool", good.text.includes('"url":"https://x.test"'), good.text);

  const errored = await M.callTool(spec("error"), "fetch", {});
  check("a JSON-RPC error is reported, not thrown", errored.ok === false);
  check("and carries the server's message", /tool exploded/.test(errored.error || ""), errored.error);

  const dead = await M.callTool(spec("exit"), "fetch", {});
  check("a server that exits immediately fails cleanly", dead.ok === false);
  check("and says so", !!dead.error);

  const silent = await M.callTool(spec("silent"), "fetch", {}, 1200);
  check("a server that never answers times out", silent.ok === false);
  check("and names the timeout", /timed out/i.test(silent.error || ""), silent.error);

  const junk = await M.callTool(spec("garbage"), "fetch", {}, 1200);
  check("malformed output does not crash the caller", junk.ok === false);

  const missing = await M.callTool({ command: "definitely-not-a-real-command-xyz" }, "fetch", {}, 2000);
  check("a command that does not exist fails cleanly", missing.ok === false);
  check("the default timeout is 20s", M.MCP_TIMEOUT_MS === 20000);

  // The third method. Not needed to make a configured call - that names its
  // tool - but the Settings panel shows what a server offers.
  const listed = await M.listTools(spec("ok"));
  check("tools/list returns the server's tools",
    listed.ok === true && listed.tools.indexOf("fetch") !== -1, JSON.stringify(listed));
  const listFailed = await M.listTools(spec("exit"));
  check("listing a dead server fails cleanly", listFailed.ok === false && Array.isArray(listFailed.tools));
}
```

Register `await testMcpClient();` in the runner list.

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs 2>&1 | grep -A2 "spoken by hand"`
Expected: FAIL — `Cannot find module '.../dist/mcp/mcp-client.js'`

- [ ] **Step 3: Write minimal implementation**

Create `local-agent/src/mcp/mcp-client.ts`:

```typescript
/**
 * MCP over stdio, in about a hundred lines.
 *
 * This needs exactly three methods - initialize, tools/list, tools/call -
 * against a well-specified protocol. Taking the official SDK for three methods
 * would be the larger commitment in a project whose only runtime dependencies
 * are Playwright and Electron.
 *
 * Nothing here throws at the caller. A server that will not start, one that
 * answers with an error, one that never answers at all: each comes back as
 * { ok: false } with a message. A build must not fail because an optional
 * context source was unavailable - the model simply gets less context, which
 * is the situation today.
 */
import { spawn, ChildProcess } from "child_process";

export const MCP_TIMEOUT_MS = 20000;

export interface ServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ToolResult {
  ok: boolean;
  text: string;
  error?: string;
}

/** The text blocks of an MCP tool result. Pure, so it is tested directly. */
export function textFromResult(result: any): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as any).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n");
}

/**
 * What tools a server offers.
 *
 * The third of the three methods. callTool does not use it - a configured call
 * already names its tool - but the Settings panel needs it to show the user
 * what they can call, and a client that could not answer that would push
 * everyone back to reading a server's README.
 */
export async function listTools(
  server: ServerSpec,
  timeoutMs: number = MCP_TIMEOUT_MS,
): Promise<{ ok: boolean; tools: string[]; error?: string }> {
  const r = await rpc(server, "tools/list", {}, timeoutMs);
  if (!r.ok) return { ok: false, tools: [], error: r.error };
  const tools = r.result && Array.isArray(r.result.tools)
    ? r.result.tools.map((t: any) => (t && typeof t.name === "string" ? t.name : "")).filter(Boolean)
    : [];
  return { ok: true, tools: tools };
}

/**
 * One request against a freshly started server.
 *
 * A process per call, deliberately. Keeping servers alive between calls means
 * owning their lifetime - restarting a crashed one, killing them when a build
 * ends, deciding what happens when the app closes mid-call - and the calls here
 * happen once per build. Paying a subprocess launch for that is cheaper than
 * owning a process pool.
 *
 * Nothing throws at the caller. A server that will not start, one that answers
 * with an error, one that never answers: each comes back as { ok: false } with
 * a message, because a build must not fail for want of optional context.
 */
function rpc(
  server: ServerSpec,
  method: string,
  params: any,
  timeoutMs: number,
): Promise<{ ok: boolean; result?: any; error?: string }> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    let settled = false;
    let buffer = "";
    let nextId = 1;
    const pending = new Map<number, (msg: any) => void>();

    const done = (r: { ok: boolean; result?: any; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc && proc.kill(); } catch { /* already gone */ }
      resolve(r);
    };

    const timer = setTimeout(
      () => done({ ok: false, error: "the MCP server timed out after " + timeoutMs + "ms" }),
      timeoutMs);

    try {
      proc = spawn(server.command, server.args || [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: Object.assign({}, process.env, server.env || {}),
      });
    } catch (e: any) {
      done({ ok: false, error: "could not start the MCP server: " + (e && e.message) });
      return;
    }

    proc.on("error", (e: any) =>
      done({ ok: false, error: "could not start the MCP server: " + (e && e.message) }));
    proc.on("close", (code) =>
      done({ ok: false, error: "the MCP server exited (code " + code + ") before answering" }));

    const send = (m: string, p: any): Promise<any> =>
      new Promise((res) => {
        const id = nextId++;
        pending.set(id, res);
        try { proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p }) + "\n"); }
        catch { /* the close handler reports it */ }
      });

    proc.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: any;
        // Malformed output is skipped rather than fatal: the timeout is what
        // eventually reports a server that only ever emits noise.
        try { msg = JSON.parse(line); } catch { continue; }
        const waiter = pending.get(msg && msg.id);
        if (waiter) { pending.delete(msg.id); waiter(msg); }
      }
    });

    (async () => {
      const init = await send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "CloseNI", version: "0.1.0" },
      });
      if (settled) return;
      if (init && init.error) {
        done({ ok: false, error: "initialize failed: " + (init.error.message || "") });
        return;
      }
      try { proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); }
      catch { /* reported by the close handler */ }

      const answer = await send(method, params);
      if (settled) return;
      if (answer && answer.error) {
        done({ ok: false, error: answer.error.message || "the server returned an error" });
        return;
      }
      done({ ok: true, result: answer && answer.result });
    })();
  });
}

/**
 * What tools a server offers.
 *
 * The third of the three methods. callTool does not use it - a configured call
 * already names its tool - but the Settings panel needs it to show the user
 * what they can call, and a client that could not answer that would push
 * everyone back to reading a server's README.
 */
export async function listTools(
  server: ServerSpec,
  timeoutMs: number = MCP_TIMEOUT_MS,
): Promise<{ ok: boolean; tools: string[]; error?: string }> {
  const r = await rpc(server, "tools/list", {}, timeoutMs);
  if (!r.ok) return { ok: false, tools: [], error: r.error };
  const tools = r.result && Array.isArray(r.result.tools)
    ? r.result.tools.map((t: any) => (t && typeof t.name === "string" ? t.name : "")).filter(Boolean)
    : [];
  return { ok: true, tools: tools };
}

export async function callTool(
  server: ServerSpec,
  tool: string,
  args: any,
  timeoutMs: number = MCP_TIMEOUT_MS,
): Promise<ToolResult> {
  const r = await rpc(server, "tools/call", { name: tool, arguments: args || {} }, timeoutMs);
  if (!r.ok) return { ok: false, text: "", error: r.error };
  const text = textFromResult(r.result);
  return text
    ? { ok: true, text: text }
    : { ok: false, text: "", error: "the tool returned no text content" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `source scripts/wsl-env.sh && npm run build && node local-agent/test/run-tests.cjs 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add local-agent/src/mcp/mcp-client.ts local-agent/test/fixtures/fake-mcp-server.js local-agent/test/run-tests.cjs
git commit -m "Speak just enough MCP to fetch context before a build"
```

---

### Task 4: Reading mcp.json and running its calls

**Files:**
- Create: `local-agent/src/mcp/mcp-context.ts`
- Test: `local-agent/test/run-tests.cjs` (new `testMcpContext()`)

**Interfaces:**
- Consumes: `callTool`, `ServerSpec` from Task 3.
- Produces:
  `parseMcpConfig(raw: any): McpConfig` (pure) where
  `McpConfig = { servers: Record<string, ServerSpec>; calls: { server: string; tool: string; args: any }[] }`,
  `planCalls(config: McpConfig): { server: string; tool: string; args: any; spec: ServerSpec }[]` (pure),
  `gatherContext(config: McpConfig, run?: typeof callTool): Promise<{ texts: string[]; notes: string[] }>`.

- [ ] **Step 1: Write the failing test**

```javascript
async function testMcpContext() {
  section("MCP context, gathered once before a build");
  const X = require(path.join(DIST, "mcp/mcp-context.js"));

  const raw = {
    servers: { fetch: { command: "uvx", args: ["mcp-server-fetch"] } },
    calls: [{ server: "fetch", tool: "fetch", args: { url: "https://x.test" } }],
  };
  const cfg = X.parseMcpConfig(raw);
  check("servers survive parsing", cfg.servers.fetch.command === "uvx");
  check("calls survive parsing", cfg.calls.length === 1 && cfg.calls[0].tool === "fetch");
  check("garbage yields an empty config",
    X.parseMcpConfig("{{").servers && Object.keys(X.parseMcpConfig("{{").servers).length === 0);
  check("null yields an empty config", X.parseMcpConfig(null).calls.length === 0);
  check("a server with no command is dropped",
    Object.keys(X.parseMcpConfig({ servers: { a: {} } }).servers).length === 0);
  check("a call naming an unknown server is dropped by the planner",
    X.planCalls(X.parseMcpConfig({ servers: {}, calls: [{ server: "gone", tool: "t" }] })).length === 0);

  const planned = X.planCalls(cfg);
  check("a planned call carries its server spec", planned[0].spec.command === "uvx");

  // The whole point: a failure is context we did not get, never a failed build.
  const okRun = async () => ({ ok: true, text: "DOCS" });
  const gathered = await X.gatherContext(cfg, okRun);
  check("successful calls return their text", gathered.texts.join("") === "DOCS", JSON.stringify(gathered.texts));
  check("and nothing is reported", gathered.notes.length === 0);

  const failRun = async () => ({ ok: false, text: "", error: "server exploded" });
  const failed = await X.gatherContext(cfg, failRun);
  check("a failed call contributes no text", failed.texts.length === 0);
  check("but is reported rather than hidden", /server exploded/.test(failed.notes.join(" ")), JSON.stringify(failed.notes));
  check("a build is not failed by it", Array.isArray(failed.texts));

  const throwRun = async () => { throw new Error("boom"); };
  const threw = await X.gatherContext(cfg, throwRun);
  check("a client that throws is caught", threw.texts.length === 0 && threw.notes.length === 1, JSON.stringify(threw.notes));

  const empty = await X.gatherContext(X.parseMcpConfig(null), okRun);
  check("no configuration means no calls and no noise",
    empty.texts.length === 0 && empty.notes.length === 0);
}
```

Register `await testMcpContext();`.

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs 2>&1 | grep -A2 "gathered once"`
Expected: FAIL — `Cannot find module '.../dist/mcp/mcp-context.js'`

- [ ] **Step 3: Write minimal implementation**

Create `local-agent/src/mcp/mcp-context.ts`:

```typescript
/**
 * The MCP calls a build should make, and their results.
 *
 * Once per build, not per step. A schema or a page of documentation does not
 * change while a build runs, and re-fetching it twenty times would cost twenty
 * subprocess launches for identical text.
 *
 * Planning is split from running, as check-planner splits, so every decision
 * about what to call is tested without launching anything.
 */
import { callTool, ServerSpec } from "./mcp-client.js";

export interface McpCall {
  server: string;
  tool: string;
  args: any;
}

export interface McpConfig {
  servers: Record<string, ServerSpec>;
  calls: McpCall[];
}

/** Anything unreadable is "no MCP configured", which is the common case. */
export function parseMcpConfig(raw: any): McpConfig {
  let obj = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch { return { servers: {}, calls: [] }; }
  }
  if (!obj || typeof obj !== "object") return { servers: {}, calls: [] };

  const servers: Record<string, ServerSpec> = {};
  const src = obj.servers && typeof obj.servers === "object" ? obj.servers : {};
  for (const name of Object.keys(src)) {
    const s = src[name];
    if (!s || typeof s.command !== "string" || !s.command.trim()) continue;
    servers[name] = {
      command: s.command.trim(),
      args: Array.isArray(s.args) ? s.args.filter((a: any) => typeof a === "string") : [],
      env: s.env && typeof s.env === "object" ? s.env : {},
    };
  }

  const calls: McpCall[] = [];
  for (const c of Array.isArray(obj.calls) ? obj.calls : []) {
    if (!c || typeof c.server !== "string" || typeof c.tool !== "string") continue;
    calls.push({ server: c.server, tool: c.tool, args: c.args || {} });
  }
  return { servers: servers, calls: calls };
}

/** Only calls whose server actually exists. */
export function planCalls(config: McpConfig): (McpCall & { spec: ServerSpec })[] {
  const cfg = config || { servers: {}, calls: [] };
  return (cfg.calls || [])
    .filter((c) => !!(cfg.servers || {})[c.server])
    .map((c) => Object.assign({}, c, { spec: cfg.servers[c.server] }));
}

/**
 * Run every planned call and collect the text.
 *
 * `run` is injectable so the decisions here are tested without a subprocess.
 * Nothing propagates: a failure becomes a note, and the build gets less
 * context rather than no build.
 */
export async function gatherContext(
  config: McpConfig,
  run: typeof callTool = callTool,
): Promise<{ texts: string[]; notes: string[] }> {
  const texts: string[] = [];
  const notes: string[] = [];
  for (const call of planCalls(config)) {
    try {
      const r = await run(call.spec, call.tool, call.args);
      if (r && r.ok && r.text) texts.push(r.text);
      else notes.push(call.server + "/" + call.tool + ": " + ((r && r.error) || "no text returned"));
    } catch (e: any) {
      notes.push(call.server + "/" + call.tool + ": " + (e && e.message ? e.message : String(e)));
    }
  }
  return { texts: texts, notes: notes };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `source scripts/wsl-env.sh && npm run build && node local-agent/test/run-tests.cjs 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add local-agent/src/mcp/mcp-context.ts local-agent/test/run-tests.cjs
git commit -m "Gather MCP context once per build, never fatally"
```

---

### Task 5: Wiring the preamble into the agent

**Files:**
- Modify: `local-agent/src/index.ts` (import `composePrompt`; prepend inside `buildPrompt`, which begins at line 469)
- Modify: `scripts/verify.mjs`
- Test: `local-agent/test/run-tests.cjs` (extend `testPromptCompose()`)

**Interfaces:**
- Consumes: `composePrompt`, `PREAMBLE_BUDGET_CHARS` from Task 1.
- Produces: the agent reads `AGENT_PREAMBLE` — a JSON object
  `{ persona?: string, skills?: string[], mcpContext?: string[] }` — once, and
  prepends it to every step prompt of that run.

- [ ] **Step 1: Write the failing test**

Append to `testPromptCompose()`:

```javascript
  // The agent has to read the preamble from the environment, the way provider
  // controls already travel, rather than as a new positional argument threaded
  // through every mode.
  const agent = fs.readFileSync(path.join(__dirname, "..", "src", "index.ts"), "utf8");
  check("the agent reads AGENT_PREAMBLE", /AGENT_PREAMBLE/.test(agent));
  check("and composes rather than concatenating", /composePrompt\(/.test(agent));
  check("an unreadable preamble is ignored rather than fatal",
    /catch\s*\{?\s*[^}]*\}?\s*\/\/ a malformed preamble|try \{[\s\S]{0,200}AGENT_PREAMBLE/.test(agent));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs 2>&1 | grep "AGENT_PREAMBLE"`
Expected: FAIL — the agent does not mention it yet.

- [ ] **Step 3: Write minimal implementation**

Add the import beside the others near the top of `local-agent/src/index.ts`:

```typescript
import { composePrompt } from "./prompt-compose.js";
```

Add above `function buildPrompt(`:

```typescript
/**
 * The persona, skills and MCP context for this run.
 *
 * Read once from the environment, the way provider controls already travel -
 * a new positional argument would have to be threaded through every mode and
 * every caller for something only buildPrompt uses.
 *
 * A malformed value is ignored rather than fatal: it means the user gets the
 * behaviour they had before configuring anything, which is a working build.
 */
let preambleParts: { persona?: string; skills?: string[]; mcpContext?: string[] } | null = null;
function readPreamble(): { persona?: string; skills?: string[]; mcpContext?: string[] } {
  if (preambleParts) return preambleParts;
  try {
    const parsed = JSON.parse(process.env.AGENT_PREAMBLE || "{}");
    preambleParts = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    preambleParts = {};
  }
  return preambleParts!;
}
```

Then at the very end of `buildPrompt`, wrap both `return` statements. Change the non-first-step return from `return "Next step. ..." + contextStr + "\n\nStep:\n" + userPrompt;` to assign that string to `const body` and return `withPreamble(body)`, and do the same for the first-step return. Add:

```typescript
/**
 * Put the user's preamble in front of a step prompt.
 *
 * composePrompt owns the budget, and `base` - which carries the JSON format
 * instruction - is never truncated. What was dropped is logged, because
 * silently sending less than the user configured is how a setting stops
 * meaning anything.
 */
function withPreamble(base: string): string {
  const parts = readPreamble();
  if (!parts.persona && !(parts.skills || []).length && !(parts.mcpContext || []).length) return base;
  const composed = composePrompt({
    persona: parts.persona,
    skills: parts.skills,
    mcpContext: parts.mcpContext,
    base: base,
  });
  if (composed.truncated.length) {
    console.log("Preamble over budget; dropped: " + composed.truncated.join(", "));
  }
  return composed.text;
}
```

Add to `scripts/verify.mjs`, beside the other agent checks:

```javascript
// Skills, personas and MCP context all arrive as one preamble. The risk is the
// same one that kept the quality block to four lines: text in front of the JSON
// instruction is parse risk, and this project has lost builds to it.
check('the preamble is composed under a budget, not concatenated',
  /composePrompt\(/.test(agent) && !/AGENT_PREAMBLE[\s\S]{0,80}\+ base/.test(agent));
check('base is never truncated',
  /base is never truncated|never truncated/.test(read('local-agent/src/prompt-compose.ts')));
check('what was dropped is reported',
  /Preamble over budget/.test(agent));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `source scripts/wsl-env.sh && npm run build && node local-agent/test/run-tests.cjs 2>&1 | tail -3 && node scripts/verify.mjs 2>&1 | grep -E "preamble|FAIL|passed" | tail -5`
Expected: PASS on both.

- [ ] **Step 5: Commit**

```bash
git add local-agent/src/index.ts local-agent/test/run-tests.cjs scripts/verify.mjs
git commit -m "Let a persona, skills and MCP context reach every step prompt"
```

---

### Task 6: The desktop side — IPC, GitHub import, and the Settings panel

**Files:**
- Modify: `desktop/github-api.js` (add `getFile` beside `getReadme` at line 36)
- Modify: `desktop/main.js` (IPC handlers beside `read-build-state`)
- Modify: `desktop/preload.js`
- Modify: `desktop/index.html` (a `skills` Settings tab and section)
- Modify: `desktop/renderer.js` (render the section; set `AGENT_PREAMBLE`)
- Modify: `scripts/verify.mjs`

**Interfaces:**
- Consumes: `skillsDir`, `personasDir`, `listMarkdown`, `readSelected`, `isSafeName` (Task 2); `parseMcpConfig`, `gatherContext` (Task 4); `composePrompt` (Task 1).
- Produces: `window.api.listSkills()`, `readSkill(kind, name)`, `writeSkill(kind, name, text)`, `deleteSkill(kind, name)`, `importSkill(owner, repo, filePath)`, `readMcpConfig()`, `writeMcpConfig(text)`, `gatherMcpContext()`.

- [ ] **Step 1: Write the failing test**

```javascript
function testSkillsWiring() {
  section("skills reach the agent from the app");
  const GH = require(path.join(__dirname, "..", "..", "desktop", "github-api.js"));
  const main = fs.readFileSync(path.join(__dirname, "..", "..", "desktop", "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "..", "desktop", "preload.js"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "..", "desktop", "renderer.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "desktop", "index.html"), "utf8");

  // Import needs a file fetch; getReadme exists, a general one did not.
  const calls = [];
  const api = GH.createGitHubApi(function (m, p) {
    calls.push(p);
    return Promise.resolve({ status: 200, body: { content: Buffer.from("SKILL TEXT").toString("base64") } });
  });
  return api.getFile("o", "r", "docs/skill.md").then(function (text) {
    check("a file is fetched by path", /\/repos\/o\/r\/contents\/docs\/skill\.md/.test(calls[0]), calls[0]);
    check("and decoded from base64", text === "SKILL TEXT", text);

    check("the app exposes skill management",
      /listSkills/.test(preload) && /writeSkill/.test(preload) && /deleteSkill/.test(preload));
    check("and MCP configuration", /readMcpConfig/.test(preload) && /writeMcpConfig/.test(preload));
    check("the main process refuses an unsafe skill name", /isSafeName/.test(main));
    check("there is a Skills settings section", /data-section="skills"/.test(html));
    check("the renderer sends the preamble as AGENT_PREAMBLE", /AGENT_PREAMBLE/.test(renderer));
    check("MCP context is gathered once, before the build starts",
      /gatherMcpContext\(\)[\s\S]{0,400}startSession|gatherMcpContext/.test(renderer));
  });
}
```

Register `await testSkillsWiring();`.

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs 2>&1 | grep -A3 "reach the agent"`
Expected: FAIL — `api.getFile is not a function`

- [ ] **Step 3: Write minimal implementation**

In `desktop/github-api.js`, after `getReadme`:

```javascript
      /** Any file in a repository, decoded. Import needs a path, not just a README. */
      getFile: async function (owner, repo, filePath) {
        var body = await call("GET", "/repos/" + owner + "/" + repo + "/contents/" +
          String(filePath).split("/").map(encodeURIComponent).join("/"));
        return Buffer.from(String(body.content || ""), "base64").toString("utf-8");
      },
```

In `desktop/main.js`, beside the build-state handlers:

```javascript
const SKILLS = require(unpackedPath(path.join("local-agent", "dist", "skill-store.js")));
const MCPCTX = require(unpackedPath(path.join("local-agent", "dist", "mcp", "mcp-context.js")));

function skillDirFor(kind) {
  return kind === "persona" ? SKILLS.personasDir(storageRoot()) : SKILLS.skillsDir(storageRoot());
}
function mcpConfigPath() { return path.join(storageRoot(), "mcp.json"); }

ipcMain.handle("list-skills", function () {
  return {
    ok: true,
    personas: SKILLS.listMarkdown(SKILLS.personasDir(storageRoot())),
    skills: SKILLS.listMarkdown(SKILLS.skillsDir(storageRoot())),
  };
});

ipcMain.handle("read-skill", function (event, p) {
  try {
    if (!SKILLS.isSafeName(p.name)) return { ok: false, error: "bad name" };
    return { ok: true, text: fs.readFileSync(path.join(skillDirFor(p.kind), p.name + ".md"), "utf-8") };
  } catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle("write-skill", function (event, p) {
  try {
    // Refused rather than sanitised: a sanitised name writes a different file
    // than the one the user asked for.
    if (!SKILLS.isSafeName(p.name)) return { ok: false, error: "A name may only contain letters, numbers, dot, dash and underscore." };
    const dir = skillDirFor(p.kind);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, p.name + ".md"), String(p.text || ""));
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle("delete-skill", function (event, p) {
  try {
    if (!SKILLS.isSafeName(p.name)) return { ok: false, error: "bad name" };
    fs.rmSync(path.join(skillDirFor(p.kind), p.name + ".md"), { force: true });
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle("import-skill", async function (event, p) {
  try {
    const text = await gh.getFile(p.owner, p.repo, p.path);
    const name = String(p.path).split("/").pop().replace(/\.md$/i, "");
    if (!SKILLS.isSafeName(name)) return { ok: false, error: "That file's name cannot be used as a skill name." };
    const dir = skillDirFor(p.kind || "skill");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name + ".md"), text);
    return { ok: true, name: name };
  } catch (e) { return { ok: false, error: GH.redactToken(String(e && e.message), currentToken()) }; }
});

ipcMain.handle("read-mcp-config", function () {
  try { return { ok: true, text: fs.readFileSync(mcpConfigPath(), "utf-8") }; }
  catch (e) { return { ok: true, text: "" }; }
});

ipcMain.handle("write-mcp-config", function (event, text) {
  try {
    fs.mkdirSync(storageRoot(), { recursive: true });
    fs.writeFileSync(mcpConfigPath(), String(text || ""));
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
});

/**
 * Run the configured MCP calls once, before a build.
 *
 * An MCP server is an arbitrary subprocess the user configured, and this is
 * where the app runs it. Nothing here can fail a build: gatherContext returns
 * notes instead of throwing.
 */
ipcMain.handle("gather-mcp-context", async function () {
  try {
    let raw = "";
    try { raw = fs.readFileSync(mcpConfigPath(), "utf-8"); } catch (e) { return { ok: true, texts: [], notes: [] }; }
    const res = await MCPCTX.gatherContext(MCPCTX.parseMcpConfig(raw));
    return { ok: true, texts: res.texts, notes: res.notes };
  } catch (e) { return { ok: true, texts: [], notes: [String(e)] }; }
});
```

In `desktop/preload.js`:

```javascript
  listSkills: function () { return ipcRenderer.invoke("list-skills"); },
  readSkill: function (kind, name) { return ipcRenderer.invoke("read-skill", { kind: kind, name: name }); },
  writeSkill: function (kind, name, text) { return ipcRenderer.invoke("write-skill", { kind: kind, name: name, text: text }); },
  deleteSkill: function (kind, name) { return ipcRenderer.invoke("delete-skill", { kind: kind, name: name }); },
  importSkill: function (p) { return ipcRenderer.invoke("import-skill", p); },
  readMcpConfig: function () { return ipcRenderer.invoke("read-mcp-config"); },
  writeMcpConfig: function (text) { return ipcRenderer.invoke("write-mcp-config", text); },
  gatherMcpContext: function () { return ipcRenderer.invoke("gather-mcp-context"); },
```

In `desktop/index.html`, add the tab after `data-section="permissions"`:

```html
          <button class="settings-tab" data-section="skills">Skills</button>
```

and the section after the permissions section:

```html
          <div class="settings-section" data-section="skills">
            <div class="micro">Persona</div>
            <div class="hint">A stance the model takes. One at a time, or none.</div>
            <select id="persona-select"><option value="">(none)</option></select>

            <div class="micro mt-2">Skills</div>
            <div class="hint">Practices to follow. Any number. Plain markdown files -
              the filename is the name.</div>
            <div id="skill-list"></div>

            <div class="row mt-1">
              <input id="skill-new-name" placeholder="new skill name">
              <button id="skill-new" class="btn btn-sm">Create</button>
            </div>
            <textarea id="skill-editor" rows="8" placeholder="Select a skill to edit it..."></textarea>
            <div class="row"><button id="skill-save" class="btn btn-sm">Save</button>
              <button id="skill-delete" class="btn btn-sm">Delete</button></div>

            <div class="micro mt-2">Import from GitHub</div>
            <div class="row">
              <input id="skill-import" placeholder="owner/repo/path/to/skill.md">
              <button id="skill-import-go" class="btn btn-sm">Import</button>
            </div>

            <div class="micro mt-2">MCP servers and calls</div>
            <div class="hint">Tools run once before a build and their text is folded
              into every step. An MCP server is a program this app will run.</div>
            <textarea id="mcp-config" rows="8" placeholder='{"servers":{},"calls":[]}'></textarea>
            <div class="row"><button id="mcp-save" class="btn btn-sm">Save</button></div>
          </div>
```

In `desktop/renderer.js`, add the panel logic and the preamble assembly:

```javascript
/**
 * The persona and skills the user has ticked.
 *
 * Selections live in localStorage; the files on disk are the source of truth,
 * so a skill deleted outside the app simply stops being read.
 */
let selectedSkills = [];
try { selectedSkills = JSON.parse(localStorage.getItem("closeni.skills") || "[]") || []; } catch (e) {}
let selectedPersona = "";
try { selectedPersona = localStorage.getItem("closeni.persona") || ""; } catch (e) {}

async function refreshSkills() {
  const r = await window.api.listSkills();
  if (!r || !r.ok) return;
  const sel = $("persona-select");
  sel.innerHTML = '<option value="">(none)</option>';
  r.personas.forEach(function (n) {
    const o = document.createElement("option");
    o.value = n; o.textContent = n; o.selected = n === selectedPersona;
    sel.appendChild(o);
  });
  sel.onchange = function () {
    selectedPersona = sel.value;
    try { localStorage.setItem("closeni.persona", selectedPersona); } catch (e) {}
  };
  const list = $("skill-list");
  list.innerHTML = "";
  r.skills.forEach(function (n) {
    const row = document.createElement("label");
    row.className = "settings-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selectedSkills.indexOf(n) !== -1;
    cb.onchange = function () {
      selectedSkills = cb.checked
        ? selectedSkills.concat([n])
        : selectedSkills.filter(function (x) { return x !== n; });
      try { localStorage.setItem("closeni.skills", JSON.stringify(selectedSkills)); } catch (e) {}
    };
    const name = document.createElement("span");
    name.textContent = n;
    name.style.cursor = "pointer";
    name.onclick = async function () {
      const got = await window.api.readSkill("skill", n);
      if (got && got.ok) { $("skill-editor").value = got.text; $("skill-editor").dataset.name = n; }
    };
    row.appendChild(cb); row.appendChild(name);
    list.appendChild(row);
  });
}

$("skill-new").onclick = async function () {
  const name = $("skill-new-name").value.trim();
  if (!name) { toast("Name it first", "err"); return; }
  const r = await window.api.writeSkill("skill", name, "");
  if (!r.ok) { toast(r.error, "err"); return; }
  $("skill-new-name").value = "";
  $("skill-editor").dataset.name = name;
  await refreshSkills();
};

$("skill-save").onclick = async function () {
  const name = $("skill-editor").dataset.name;
  if (!name) { toast("Select a skill first", "err"); return; }
  const r = await window.api.writeSkill("skill", name, $("skill-editor").value);
  toast(r.ok ? "Saved " + name : (r.error || "Could not save"), r.ok ? "" : "err");
};

$("skill-delete").onclick = async function () {
  const name = $("skill-editor").dataset.name;
  if (!name) return;
  if (!confirm("Delete the skill \"" + name + "\"? The file is removed from disk.")) return;
  await window.api.deleteSkill("skill", name);
  $("skill-editor").value = ""; delete $("skill-editor").dataset.name;
  selectedSkills = selectedSkills.filter(function (x) { return x !== name; });
  try { localStorage.setItem("closeni.skills", JSON.stringify(selectedSkills)); } catch (e) {}
  await refreshSkills();
};

$("skill-import-go").onclick = async function () {
  const raw = $("skill-import").value.trim();
  const m = raw.match(/^([^/]+)\/([^/]+)\/(.+\.md)$/i);
  if (!m) { toast("Use owner/repo/path/to/file.md", "err"); return; }
  const r = await window.api.importSkill({ owner: m[1], repo: m[2], path: m[3], kind: "skill" });
  if (!r.ok) { toast(r.error || "Import failed", "err"); log("skill import failed: " + r.error, "err"); return; }
  $("skill-import").value = "";
  log("imported skill: " + r.name, "ok");
  await refreshSkills();
};

$("mcp-save").onclick = async function () {
  const text = $("mcp-config").value;
  // Parsed here so a typo is caught before a build depends on it.
  if (text.trim()) {
    try { JSON.parse(text); }
    catch (e) { toast("That is not valid JSON", "err"); return; }
  }
  const r = await window.api.writeMcpConfig(text);
  toast(r.ok ? "MCP configuration saved" : (r.error || "Could not save"), r.ok ? "" : "err");
};

/**
 * Everything the model should be told before the task, for this run.
 *
 * MCP tools run here - once, before the build - rather than per step. A tool
 * whose answer changes mid-build is therefore read once, which is recorded in
 * the design as a known consequence of not paying a browser round-trip per call.
 */
async function buildPreamble() {
  const parts = {};
  if (selectedPersona) {
    const p = await window.api.readSkill("persona", selectedPersona);
    if (p && p.ok) parts.persona = p.text;
  }
  const skills = [];
  for (const n of selectedSkills) {
    const s = await window.api.readSkill("skill", n);
    if (s && s.ok && s.text.trim()) skills.push(s.text);
  }
  if (skills.length) parts.skills = skills;

  const mcp = await window.api.gatherMcpContext();
  if (mcp && mcp.texts && mcp.texts.length) parts.mcpContext = mcp.texts;
  (mcp && mcp.notes ? mcp.notes : []).forEach(function (n) { log("mcp: " + n, "err"); });
  return parts;
}
```

Then carry it to the agent. In `desktop/renderer.js`, change `CN.startSession` and `runAgent` to build the preamble first and pass it through — `buildPreamble()` runs the MCP tools, so it is awaited once here rather than per step:

```javascript
  startSession: function (ws, prov, autonomy, resuming) {
    try {
      const cb = $("show-browser");
      // Awaited here, once, because buildPreamble runs the configured MCP
      // tools. Per step it would pay a subprocess launch twenty times for
      // text that does not change during a build.
      return buildPreamble().then(function (preamble) {
        return window.api.startSession(ws, prov, autonomy, cb ? cb.checked : false,
          desiredControls(), window.CN.getConcurrency(), resuming, preamble);
      }).catch(function (e) { return { ok: false, error: String(e) }; });
    } catch (e) { return Promise.resolve({ ok: false, error: String(e) }); }
  },
```

and in `runAgent`, before the `window.api.runAgent(...)` call, add `payload.preamble = await buildPreamble();`.

In `desktop/preload.js`, widen the two signatures:

```javascript
  startSession: function (workspace, provider, autonomy, headed, controls, concurrency, resuming, preamble) {
    return ipcRenderer.invoke("start-session", { workspace: workspace, provider: provider, autonomy: autonomy, headed: headed, controls: controls, concurrency: concurrency, resuming: resuming, preamble: preamble });
  },
```

In `desktop/main.js`, take the preamble in `agentEnv` and pass `payload.preamble` at each of its call sites (`run-agent`, `start-session`, `suggest`, `sign-in`, `auth-status`, `provider-health` — the last three pass `null`, since a status probe sends no prompt):

```javascript
function agentEnv(headed, controls, preamble) {
  const env = { AGENT_HEADED: headed };
  if (controls && Object.keys(controls).length) env.AGENT_CONTROLS = JSON.stringify(controls);
  // One environment variable, read once by the agent, exactly as controls
  // travel. A positional argument would have to be threaded through every mode.
  if (preamble && Object.keys(preamble).length) env.AGENT_PREAMBLE = JSON.stringify(preamble);
  return env;
}
```

and pass `payload.preamble` at each `agentEnv(...)` call site, adding `preamble` to the `start-session` and `run-agent` payloads in `preload.js`.

Add to `scripts/verify.mjs`:

```javascript
// Skills and MCP. The name check is the security-relevant one: a name from the
// renderer becomes a path.
check('a skill name is refused rather than sanitised',
  /isSafeName/.test(read('desktop/main.js')) &&
  /Refused rather than sanitised|refused rather than sanitised/.test(read('local-agent/src/skill-store.ts')));
check('MCP context is gathered once per build, not per step',
  /gather-mcp-context/.test(read('desktop/main.js')) &&
  !/gatherMcpContext[\s\S]{0,200}sendStep/.test(read('desktop/builder.js')));
check('the preamble travels as an environment variable',
  /AGENT_PREAMBLE/.test(read('desktop/main.js')));
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
source scripts/wsl-env.sh
npm run build && node local-agent/test/run-tests.cjs 2>&1 | tail -3
node scripts/verify.mjs 2>&1 | grep -E "FAIL|passed" | tail -2
node scripts/verify-visual.mjs 2>&1 | tail -2
node -e "new Function(require('fs').readFileSync('desktop/renderer.js','utf8'))" && echo "renderer parses"
```
Expected: all PASS, renderer parses.

- [ ] **Step 5: Launch the app and confirm the panel is real**

```bash
source scripts/wsl-env.sh
cat > ./.drive-tmp.mjs <<'EOF'
import { _electron as electron } from "playwright";
const app = await electron.launch({ args: ["--no-sandbox", "."], cwd: process.cwd(), timeout: 60000 });
const win = await app.firstWindow({ timeout: 60000 });
await win.waitForLoadState("domcontentloaded");
await win.waitForTimeout(4000);
await win.click('.nav-btn[data-mode="settings"]');
await win.click('.settings-tab[data-section="skills"]');
await win.waitForTimeout(500);
console.log(JSON.stringify(await win.evaluate(() => ({
  visible: !!document.querySelector('.settings-section[data-section="skills"].active'),
  controls: ["persona-select","skill-list","skill-editor","skill-import","mcp-config"]
    .filter(id => !!document.getElementById(id)),
}))));
await win.screenshot({ path: "/tmp/skills-panel.png" });
await app.close();
EOF
node ./.drive-tmp.mjs; rm -f ./.drive-tmp.mjs
```
Expected: `visible: true` and all five controls present. **Look at the screenshot** — a blank panel is a failure.

- [ ] **Step 6: Commit**

```bash
git add desktop/ local-agent/test/run-tests.cjs scripts/verify.mjs
git commit -m "Configure personas, skills and MCP servers from Settings"
```

---

### Task 7: Close the roadmap items and record what is not verified

**Files:**
- Modify: `docs/ROADMAP.md:172-186` (section 5 header and items 13/15)
- Modify: `README.md`
- Modify: `scripts/verify.mjs` (the unverified block at the end)

- [ ] **Step 1: Update the roadmap**

Change the section 5 header from `## 5 · GitHub & external tools — 3 of 5` to `— DONE`, and rewrite items 13 and 15 from `todo` to `done` with one sentence each on what was built and the constraint that shaped it (MCP is a context provider because the model drives a chat window and cannot call a tool).

- [ ] **Step 2: Add the honest limitation to verify.mjs**

In the "NOT covered by this script" block, add — using single quotes, not backticks, because that block is a template literal:

```
    · Interoperability with any real MCP server. The client is tested against
      a scripted fake, which proves the framing and the failure handling. It
      does not prove that this client and, say, mcp-server-fetch agree.
```

- [ ] **Step 3: Run every gate**

```bash
source scripts/wsl-env.sh
node scripts/verify.mjs 2>&1 | grep -E "PASS —|FAIL —"
node scripts/edge-cases.mjs 2>&1 | grep -E "passed|FAIL" | tail -1
node scripts/verify-visual.mjs 2>&1 | grep -E "passed|FAIL" | tail -1
node local-agent/test/run-tests.cjs 2>&1 | tail -2
```
Expected: four PASS lines.

- [ ] **Step 4: Commit**

```bash
git add docs/ROADMAP.md README.md scripts/verify.mjs
git commit -m "Close the last two roadmap items"
```
