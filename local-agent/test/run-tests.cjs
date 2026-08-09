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
  testPatchApplier();
  await testBrowserExtraction();

  console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + " — " + pass + " passed, " + fail + " failed");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("test runner threw:", e);
  process.exit(1);
});
