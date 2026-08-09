/*
 * Regression tests for the parsing, patching and browser-extraction logic.
 *
 * Run against the compiled output:   npm run build && npm test
 *
 * The browser section needs Playwright's chromium ("npx playwright install
 * chromium"). If it is unavailable the section is skipped rather than failed,
 * so the parser/patch suites still run in environments without a browser.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const DIST = path.join(__dirname, "..", "dist");
const { parseMarkdownToEditPlan } = require(path.join(DIST, "parser/patch-parser.js"));
const { parsePlanRobust } = require(path.join(DIST, "parser/json-repair.js"));
const { applyPatch } = require(path.join(DIST, "patch/patch-applier.js"));
const { PlaywrightController } = require(path.join(DIST, "providers/playwright-controller.js"));
const { selectRelevantFiles, extractSignatures } = require(path.join(DIST, "context/relevance.js"));

const F = "```";
let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log("  ok   " + name);
  } else {
    fail++;
    console.log("  FAIL " + name + (extra ? "  -> " + extra : ""));
  }
}

function section(name) {
  console.log("\n" + name);
}

function emptyPlan(changes) {
  return { changes: changes, warnings: [], errors: [], commands: [], rawMarkdown: "" };
}

function testEditPlanParsing() {
  section("edit-plan parsing");

  let r = parseMarkdownToEditPlan(
    F + 'json\n{"files":[{"path":"a.py","mode":"create","content":"print(1)\\n"}],"commands":["python a.py"]}\n' + F
  );
  check("clean json", r.changes.length === 1 && r.changes[0].filePath === "a.py" && r.changes[0].newContent === "print(1)\n");
  check("commands parsed", r.commands.length === 1);

  r = parseMarkdownToEditPlan(
    "Sure! Here is the code:\n\n" + F + 'json\n{"files":[{"path":"b.py","mode":"create","content":"x=1"}]}\n' + F + "\n\nLet me know!"
  );
  check("ignores prose around the fence", r.changes.length === 1 && r.changes[0].filePath === "b.py");

  r = parseMarkdownToEditPlan(F + 'json\n{"files":[{"path":"c.py","mode":"create","content":"y=2",},],}\n' + F);
  check("repairs trailing commas", r.changes.length === 1 && r.changes[0].filePath === "c.py");

  // Models routinely emit real newlines inside a JSON string, which is invalid JSON.
  r = parseMarkdownToEditPlan(F + 'json\n{"files":[{"path":"d.py","mode":"create","content":"def f():\n    return 1\n"}]}\n' + F);
  check("repairs raw newlines inside content", r.changes.length === 1 && String(r.changes[0].newContent).includes("return 1"));

  r = parseMarkdownToEditPlan('{"files":[{"path":"e.py","mode":"create","content":"z=3"}]}');
  check("accepts unfenced json", r.changes.length === 1);

  r = parseMarkdownToEditPlan(F + 'json\n{"files":[{"mode":"create","content":"orphan"}]}\n' + F);
  check("drops a change with no path", r.changes.every((c) => !!c.filePath), "got " + JSON.stringify(r.changes));

  r = parseMarkdownToEditPlan("I cannot help with that request.");
  check("prose-only reply yields no changes", r.changes.length === 0);
}

function testPlanParsing() {
  section("plan parsing");

  let p = parsePlanRobust(
    F + 'json\n{"summary":"build api","steps":[{"title":"s1","detail":"d1","files":["a.py"]},{"title":"s2","detail":"d2","files":["b.py"]}]}\n' + F
  );
  check("clean plan", !!p && p.steps.length === 2 && p.summary === "build api");

  p = parsePlanRobust("Here's the plan:\n" + F + 'json\n{"summary":"x","steps":[{"title":"only","detail":"dd","files":["q.py"]}]}\n' + F + "\nHope that helps");
  check("plan wrapped in prose", !!p && p.steps.length === 1);

  p = parsePlanRobust('{"plan":{"summary":"nested","steps":[{"title":"n","detail":"","files":[]}]}}');
  check("plan nested under a plan key", !!p && p.steps.length === 1);

  p = parsePlanRobust("no json whatsoever here");
  check("unparseable plan returns null", p === null);
}

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

function testRelevance() {
  section("context selection");

  // The workspace exactly as it stood when the real run reached step 5. Steps 1-4
  // produced models, storage, services and cli; step 5 writes main.py at the root
  // and has to import from cli/handlers.py.
  let t = 1000;
  const f = (p, content) => ({ path: p, content: content, mtimeMs: (t += 1000) });
  const todoWorkspace = [
    f("src/models/__init__.py", "from .task import Task\n"),
    f("src/models/task.py", "class Task:\n    def __init__(self, title):\n        self.title = title\n"),
    f("src/storage/__init__.py", "from .json_storage import JsonStorage\n"),
    f("src/storage/json_storage.py", "import json\n\nclass JsonStorage:\n    def load(self):\n        pass\n"),
    f("src/services/__init__.py", "from .task_service import TaskService\n"),
    f("src/services/task_service.py", "class TaskService:\n    def add(self, t):\n        pass\n"),
    f("src/cli/parser.py", "import argparse\n\ndef create_parser():\n    pass\n"),
    // Written last, by step 4 — and the one main.py must import from.
    f("src/cli/handlers.py", "def handle_add(a):\n    pass\ndef handle_remove(a):\n    pass\ndef handle_done(a):\n    pass\n"),
    f("src/cli/__init__.py", "from .parser import create_parser\n"),
  ];
  const step5 = "Overall: Build a to-do CLI\n\nExecute ONLY this step: Implement Main Entry Point. Create the entrypoint. Expected files: main.py";

  const picked = selectRelevantFiles({ files: todoWorkspace, stepDetail: step5, prompt: "build a todo cli" });
  const pickedPaths = picked.map((p) => p.path);

  check("selects something", picked.length > 0);
  check(
    "includes the handlers module the entrypoint imports",
    pickedPaths.includes("src/cli/handlers.py"),
    pickedPaths.join(", ")
  );
  check(
    "the handler names are visible to the model",
    picked.some((p) => p.path === "src/cli/handlers.py" && p.content.includes("handle_remove")),
    JSON.stringify(picked.find((p) => p.path === "src/cli/handlers.py"))
  );
  check("recent work outranks older work", pickedPaths.indexOf("src/cli/handlers.py") < pickedPaths.indexOf("src/models/task.py") || !pickedPaths.includes("src/models/task.py"), pickedPaths.join(", "));

  // Deterministic: same input, same context, regardless of walk order.
  const shuffled = todoWorkspace.slice().reverse();
  const again = selectRelevantFiles({ files: shuffled, stepDetail: step5, prompt: "build a todo cli" });
  check("selection is deterministic", JSON.stringify(again.map((p) => p.path)) === JSON.stringify(pickedPaths), again.map((p) => p.path).join(", "));

  // Same-directory work still wins when the step targets a subdirectory.
  const stepInCli = "Execute ONLY this step: Extend the CLI. Expected files: src/cli/commands.py";
  const cliPick = selectRelevantFiles({ files: todoWorkspace, stepDetail: stepInCli, prompt: "cli" }).map((p) => p.path);
  check("directory match still applies", cliPick.includes("src/cli/parser.py") && cliPick.includes("src/cli/handlers.py"), cliPick.join(", "));

  // Budget: a pile of large files must not blow up the prompt.
  const many = [];
  for (let i = 0; i < 40; i++) many.push({ path: "src/mod" + i + ".py", content: "def f" + i + "():\n    pass\n".repeat(200), mtimeMs: 1000 + i });
  const bounded = selectRelevantFiles({ files: many, stepDetail: "Expected files: main.py", prompt: "x", budgetChars: 1200 });
  const totalChars = bounded.reduce((n, p) => n + p.content.length, 0);
  check("respects the character budget", bounded.length <= 8 && totalChars <= 1200 + 800, "files=" + bounded.length + " chars=" + totalChars);
  check("always returns at least one file", bounded.length >= 1);

  check("empty workspace yields nothing", selectRelevantFiles({ files: [], stepDetail: "x", prompt: "y" }).length === 0);

  section("signature extraction");
  check(
    "python: keeps defs and imports, drops bodies",
    (() => {
      const s = extractSignatures("import os\n\nclass A:\n    def go(self):\n        secret_body = 1\n        return secret_body\n", "a.py");
      return s.includes("import os") && s.includes("class A:") && s.includes("def go") && !s.includes("secret_body");
    })()
  );
  check(
    "javascript: picks up module.exports",
    extractSignatures("const x = 1;\nfunction go() { return 2; }\nmodule.exports = { go };\n", "a.js").includes("module.exports"),
    extractSignatures("const x = 1;\nfunction go() { return 2; }\nmodule.exports = { go };\n", "a.js")
  );
  check(
    "rust: picks up pub fn and struct",
    (() => {
      const s = extractSignatures("use std::io;\n\npub struct Store {}\n\npub fn load() -> u32 {\n    42\n}\n", "a.rs");
      return s.includes("pub struct Store") && s.includes("pub fn load") && !s.includes("42");
    })()
  );
  check(
    "java: picks up declarations",
    extractSignatures("package app;\n\npublic class Main {\n    public static void main(String[] a) {}\n}\n", "Main.java").includes("public class Main"),
  );
}

function testPatchApplier() {
  section("patch applier");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-test-"));
  const ws = path.join(root, "ws");
  const sibling = path.join(root, "ws-evil");
  fs.mkdirSync(ws);
  fs.mkdirSync(sibling);

  let r = applyPatch(ws, emptyPlan([{ filePath: "src/app.py", mode: "create", newContent: "print('hi')\n" }]));
  check("creates a nested file", r.success && fs.readFileSync(path.join(ws, "src/app.py"), "utf8") === "print('hi')\n", r.errors.join("|"));

  r = applyPatch(ws, emptyPlan([{ filePath: "src/app.py", mode: "overwrite", newContent: "print('v2')\n" }]));
  check("overwrite takes a backup", r.success && !!r.backupDir, r.errors.join("|"));

  r = applyPatch(ws, emptyPlan([{ filePath: "src/app.py", mode: "search_replace", searchBlock: "v2", replaceBlock: "v3" }]));
  check("search_replace edits in place", r.success && fs.readFileSync(path.join(ws, "src/app.py"), "utf8").includes("v3"), r.errors.join("|"));

  r = applyPatch(ws, emptyPlan([{ filePath: "../ws-evil/pwned.py", mode: "create", newContent: "bad" }]));
  check("blocks ../ traversal", !r.success && !fs.existsSync(path.join(sibling, "pwned.py")));

  // A sibling directory sharing the workspace name as a prefix must not count as inside it.
  const prefixEscape = path.join("..", path.basename(ws) + "-evil", "x.py");
  r = applyPatch(ws, emptyPlan([{ filePath: prefixEscape, mode: "create", newContent: "bad" }]));
  check("blocks sibling-prefix escape", !r.success && !fs.existsSync(path.join(sibling, "x.py")));

  const abs = path.join(root, "abs-pwned.py");
  r = applyPatch(ws, emptyPlan([{ filePath: abs, mode: "create", newContent: "bad" }]));
  check("blocks absolute paths", !r.success && !fs.existsSync(abs));

  r = applyPatch(ws, emptyPlan([{ mode: "create", newContent: "x" }]));
  check("reports a missing path clearly", !r.success && r.errors[0].includes("missing a file path"), r.errors.join("|"));

  fs.rmSync(root, { recursive: true, force: true });
}

async function testBrowserExtraction() {
  section("browser extraction (real chromium)");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-browser-"));
  const fixture = path.join(__dirname, "fixtures", "chat.html");
  const cfg = {
    id: "fixture",
    name: "Fixture",
    kind: "web",
    baseUrl: "file://" + fixture,
    requiresLogin: false,
    enabled: true,
    selectors: {
      chatInput: "textarea",
      sendButton: 'button[type="submit"]',
      stopButton: "",
      assistantMessage: ".assistant-msg",
      codeBlock: "pre code",
      copyButton: "",
    },
    completionRules: { waitForStopButtonDisappear: false, waitForCopyButton: false, stableMs: 100, maxWaitMs: 5000 },
    profileDir: path.join(root, "profiles", "fixture"),
  };

  const c = new PlaywrightController(cfg);
  c.setWorkspace("/my/ws");
  try {
    await c.launch(cfg);
  } catch (e) {
    console.log("  skip (chromium unavailable: " + String(e.message).split("\n")[0] + ")");
    fs.rmSync(root, { recursive: true, force: true });
    return;
  }

  try {
    await c.navigateFresh(cfg);

    check("counts every assistant message", (await c.countMessages(cfg)) === 2);

    // The fixture holds two replies; only the newest one may be returned, otherwise
    // a re-ask would feed the stale answer back to the parser.
    const extracted = await c.extractLatestResponse(cfg);
    check("extraction is scoped to the last message", extracted.includes("FRESH.py") && !extracted.includes("STALE.py"), extracted.slice(0, 120));

    const plan = parseMarkdownToEditPlan(extracted);
    check("extracted text parses to the fresh change", plan.changes.length === 1 && plan.changes[0].filePath === "FRESH.py", JSON.stringify(plan.changes));

    const md = await c.getLastMessageStructured(cfg);
    check("structured markdown keeps list items", md.includes("bullet one") && md.includes("bullet two"));
    check("structured markdown strips Copy/Download chrome", !/Copy Download/.test(md));

    c.setChatUrlForWorkspace("/my/ws", "https://example.test/a/abc123", "My Chat");
    check("session url round-trips", c.getChatUrlForWorkspace("/my/ws") === "https://example.test/a/abc123");

    // The store sits two levels above the profile dir, alongside the agent's storage.
    const storeFile = path.resolve(cfg.profileDir, "..", "..", "sessions.json");
    check("sessions file is written next to storage", fs.existsSync(storeFile), storeFile);

    c.createNewChat("/my/ws");
    check("new chat clears the active thread", c.getChatUrlForWorkspace("/my/ws") === null);
  } finally {
    await c.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  testEditPlanParsing();
  testPlanParsing();
  testSessionStore();
  testRelevance();
  testPatchApplier();
  await testBrowserExtraction();

  console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + " — " + pass + " passed, " + fail + " failed");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("test runner threw:", e);
  process.exit(1);
});
