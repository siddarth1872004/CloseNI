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

  fs.rmSync(dir, { recursive: true, force: true });
}

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

function testDiff() {
  section("line diff");
  const { diffLines } = require(path.join(__dirname, "..", "..", "desktop", "diff.js"));
  const types = (rows) => rows.map((r) => r.type).join(",");
  const texts = (rows, t) => rows.filter((r) => r.type === t).map((r) => r.text);

  check("identical files are all same", types(diffLines("a\nb", "a\nb")) === "same,same");

  const added = diffLines("a\nc", "a\nb\nc");
  check("an added line is marked add", texts(added, "add").join() === "b", JSON.stringify(added));
  check("adding does not mark removals", texts(added, "remove").length === 0, JSON.stringify(added));

  const removed = diffLines("a\nb\nc", "a\nc");
  check("a removed line is marked remove", texts(removed, "remove").join() === "b", JSON.stringify(removed));

  const changed = diffLines("a\nold\nc", "a\nnew\nc");
  check("a changed line is a remove plus an add", texts(changed, "remove").join() === "old" && texts(changed, "add").join() === "new", JSON.stringify(changed));

  // A created file has no previous version: everything is an addition.
  const created = diffLines("", "x\ny");
  check("empty before means all added", types(created) === "add,add", JSON.stringify(created));
  check("empty both sides yields nothing", diffLines("", "").length === 0);

  // Long unchanged runs collapse so a small change in a big file stays readable.
  const big = Array.from({ length: 40 }, (_, i) => "line" + i).join("\n");
  const collapsed = diffLines(big, big + "\nEXTRA");
  check("long unchanged runs collapse to a gap", collapsed.some((r) => r.type === "gap"), types(collapsed).slice(0, 60));
  check("collapsing keeps the change visible", collapsed.some((r) => r.type === "add" && r.text === "EXTRA"));
  check("collapsed output is far shorter than the file", collapsed.length < 20, "rows: " + collapsed.length);

  // Trailing newlines must not invent a phantom final line.
  check("trailing newline is not a spurious line", diffLines("a\n", "a\n").every((r) => r.type === "same"), JSON.stringify(diffLines("a\n", "a\n")));
}

function testApprovalPolicy() {
  section("approval policy");
  // Its own module rather than index.js, which calls main() on import and would
  // launch the agent just by being required.
  const { decideApproval } = require(path.join(DIST, "verification/approval-policy.js"));

  check("auto allows without asking", decideApproval("auto") === "allow");
  check("never denies without asking", decideApproval("never") === "deny");
  check("ask prompts", decideApproval("ask") === "ask");
  // An unset or unrecognised policy must be the safe one: prompt rather than
  // silently running commands the user never approved.
  check("unknown value prompts", decideApproval("banana") === "ask");
  check("empty value prompts", decideApproval("") === "ask");
  check("undefined prompts", decideApproval(undefined) === "ask");
}

function testEntrypoint() {
  section("entry point detection");
  const { detectEntrypoint } = require(path.join(__dirname, "..", "..", "desktop", "entrypoint.js"));

  check("npm start wins when scripts.start exists",
    detectEntrypoint(["package.json", "index.js"], { scripts: { start: "node ." } }) === "npm start");
  check("package main is used when there is no start script",
    detectEntrypoint(["package.json", "app.js"], { main: "app.js" }) === "node app.js");
  check("a package.json with neither falls through to files",
    detectEntrypoint(["package.json", "index.js"], {}) === "node index.js");

  check("main.py at the root", detectEntrypoint(["main.py"], null) === "python3 main.py");
  check("src/main.py", detectEntrypoint(["src/main.py"], null) === "python3 src/main.py");
  check("app.py", detectEntrypoint(["app.py"], null) === "python3 app.py");
  check("index.js", detectEntrypoint(["index.js"], null) === "node index.js");
  check("src/index.js", detectEntrypoint(["src/index.js"], null) === "node src/index.js");

  check("root main.py beats src/main.py", detectEntrypoint(["src/main.py", "main.py"], null) === "python3 main.py");
  check("python beats javascript when both exist", detectEntrypoint(["index.js", "main.py"], null) === "python3 main.py");

  // Returning null is a real answer: better than running something arbitrary.
  check("nothing recognisable yields null", detectEntrypoint(["README.md", "notes.txt"], null) === null);
  check("an empty workspace yields null", detectEntrypoint([], null) === null);
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

    // A build thread is tracked separately from the Chat/Plan thread, so the two
    // never overwrite each other.
    const readStore = () => JSON.parse(fs.readFileSync(storeFile, "utf-8"));
    c.setWorkspace("/my/ws");
    c.setThreadKind("build");
    c.setChatUrlForWorkspace("/my/ws", "https://example.test/c/build-1");
    check("build kind writes activeBuildThread", readStore()["/my/ws"].activeBuildThread === "https://example.test/c/build-1", JSON.stringify(readStore()["/my/ws"]));
    check("build kind leaves activeChat untouched", readStore()["/my/ws"].activeChat !== "https://example.test/c/build-1");
    check("getBuildThreadUrl reads it back", c.getBuildThreadUrl() === "https://example.test/c/build-1");

    c.setThreadKind("chat");
    c.setChatUrlForWorkspace("/my/ws", "https://example.test/a/chat-1");
    check("chat kind still writes activeChat", readStore()["/my/ws"].activeChat === "https://example.test/a/chat-1");
    check("writing the chat thread preserves the build thread", readStore()["/my/ws"].activeBuildThread === "https://example.test/c/build-1");

    c.resetBuildRunForWorkspace();
    check("build thread can be cleared", c.getBuildThreadUrl() === null);
    check("clearing the build thread preserves activeChat", readStore()["/my/ws"].activeChat === "https://example.test/a/chat-1");
  } finally {
    await c.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  testEditPlanParsing();
  testPlanParsing();
  testSessionStore();
  testDelta();
  testDiff();
  testApprovalPolicy();
  testEntrypoint();
  testRelevance();
  testPatchApplier();
  await testBrowserExtraction();

  console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + " — " + pass + " passed, " + fail + " failed");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("test runner threw:", e);
  process.exit(1);
});
