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

  // The build used to keep a thread of its own; chat, plan and build now share
  // activeChat, so getBuildThread / setBuildThread / clearBuildThread are gone.
  // What those tests were really protecting is kept here against the API that
  // survived.
  store.writeSessions(file, {
    "/ws": {
      chats: [{ url: "https://chat.example.com/c/zzz", title: "T", createdAt: "2026-01-01" }],
      activeChat: "https://chat.example.com/c/zzz",
      activeChatProvider: "deepseek",
    },
  });
  const after = store.readSessions(file);
  check("activeChat round-trips", after["/ws"].activeChat === "https://chat.example.com/c/zzz");
  check("chats round-trip", after["/ws"].chats.length === 1);
  check("the provider that owns the thread is recorded", after["/ws"].activeChatProvider === "deepseek");

  // THE invariant of the one-conversation design: starting a build resets the
  // ledger, and must not take the conversation with it. If this ever regresses,
  // every build silently starts a new thread and every step prompt grows back
  // to carrying the whole project.
  store.setBuildLedger(file, "/ws", { "a.py": { hash: "h1", step: 0 } });
  store.resetBuildRun(file, "/ws");
  const reset = store.readSessions(file);
  check("a build reset clears the ledger",
    JSON.stringify(reset["/ws"].buildLedger) === "{}", JSON.stringify(reset["/ws"].buildLedger));
  check("a build reset leaves the conversation alone",
    reset["/ws"].activeChat === "https://chat.example.com/c/zzz", reset["/ws"].activeChat);
  check("a build reset leaves the chat list alone", reset["/ws"].chats.length === 1);

  // Session files carry live conversation URLs and must not be world-readable.
  if (process.platform !== "win32") {
    check("the session file is written 0600",
      (fs.statSync(file).mode & 0o777) === 0o600, "0" + (fs.statSync(file).mode & 0o777).toString(8));
  }

  fs.writeFileSync(file, "{ this is not json");
  check("corrupt file reads as empty", JSON.stringify(store.readSessions(file)) === "{}");

  check("workspaces are independent", (() => {
    store.setBuildLedger(file, "/a", { "x.py": { hash: "1", step: 0 } });
    store.setBuildLedger(file, "/b", { "y.py": { hash: "2", step: 0 } });
    const s = store.readSessions(file);
    return !!s["/a"].buildLedger["x.py"] && !s["/a"].buildLedger["y.py"] && !!s["/b"].buildLedger["y.py"];
  })());

  // --- build ledger
  const lf = path.join(dir, "ledger.json");
  check("missing ledger reads as empty", JSON.stringify(store.getBuildLedger(lf, "/ws")) === "{}");

  store.setBuildLedger(lf, "/ws", { "a.py": { hash: "h1", step: 0 }, "b.py": { hash: null, step: 0 } });
  const led = store.getBuildLedger(lf, "/ws");
  check("ledger round-trips", led["a.py"].hash === "h1" && led["b.py"].hash === null, JSON.stringify(led));
  check("ledger records the step", led["a.py"].step === 0);

  store.setBuildLedger(lf, "/ws", { "a.py": { hash: "h2", step: 1 } });
  check("ledger updates in place", store.getBuildLedger(lf, "/ws")["a.py"].hash === "h2");

  store.resetBuildRun(lf, "/ws");
  check("resetBuildRun clears the ledger", JSON.stringify(store.getBuildLedger(lf, "/ws")) === "{}");
  // Legacy field from when the build had a thread of its own. Still cleared, so
  // an upgraded install does not keep a stale one in its session file forever.
  check("resetBuildRun clears the legacy build thread",
    (store.readSessions(lf)["/ws"].activeBuildThread ?? null) === null);

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

function testControlDecisions() {
  section("provider control decisions");
  const d = require(path.join(DIST, "providers/controls/decisions.js"));
  const { hasControls } = require(path.join(DIST, "providers/controls/index.js"));

  // Attribute-flagged state: DeepSeek's aria-pressed, GLM's data-selected.
  check("wanted on, currently off, clicks", d.flagAction("false", true) === "click");
  check("wanted on, already on, skips", d.flagAction("true", true) === "already-set");
  check("wanted off, currently on, clicks", d.flagAction("true", false) === "click");
  check("wanted off, already off, skips", d.flagAction("false", false) === "already-set");
  // A missing attribute must never be guessed at. Blind toggling would turn a
  // wanted setting off, which is worse than not setting it.
  check("missing attribute is unreadable", d.flagAction(null, true) === "unreadable");
  check("garbage attribute is unreadable", d.flagAction("yes", true) === "unreadable");

  // Text-flagged state: Qwen's trigger label.
  check("trigger already showing the value skips", d.labelAction("Qwen3.8-Max", "Qwen3.8-Max") === "already-set");
  check("trigger showing something else opens", d.labelAction("Qwen3.7-Plus", "Qwen3.8-Max") === "open");
  check("case and spacing do not matter", d.labelAction("  GLM-5.2 ", "glm-5.2") === "already-set");
  check("a multi-line trigger matches on any line", d.labelAction("Model\nQwen3.8-Max", "Qwen3.8-Max") === "already-set");
  check("an empty trigger is unreadable", d.labelAction("", "Qwen3.8-Max") === "unreadable");

  // The reason matching is whole-line: Qwen renders each model as a card with
  // a description, and Qwen3.7-Max's description mentions Qwen3.7.
  check("a longer name does not satisfy a shorter one", d.optionMatches("Qwen3.7-Max", "Qwen3.7") === false);
  check("a description mentioning the name does not match",
    d.optionMatches("Qwen3.7-Max\nBuilt on Qwen3.7", "Qwen3.7") === false);
  check("the title line matches exactly", d.optionMatches("Qwen3.7-Max\nBuilt on Qwen3.7", "Qwen3.7-Max") === true);

  check("selector template substitution",
    d.fillSelector('[data-model-type="{value}"]', "expert") === '[data-model-type="expert"]');

  // Settings arrive as JSON on an environment variable. A bad one means no
  // controls, never a crash: a mistyped setting must not stop a build.
  check("valid JSON parses", d.parseDesiredControls('{"mode":"expert"}').mode === "expert");
  check("booleans survive", d.parseDesiredControls('{"smart-search":false}')["smart-search"] === false);
  check("malformed JSON yields nothing", Object.keys(d.parseDesiredControls("{oops")).length === 0);
  check("missing value yields nothing", Object.keys(d.parseDesiredControls(undefined)).length === 0);
  check("an array yields nothing", Object.keys(d.parseDesiredControls("[1,2]")).length === 0);
  check("non-scalar values are dropped", Object.keys(d.parseDesiredControls('{"a":{"b":1}}')).length === 0);

  // A provider with no module has no controls rather than an error.
  check("deepseek has a module", hasControls("deepseek") === true);
  check("qwen-studio has a module", hasControls("qwen-studio") === true);
  check("glm has a module", hasControls("glm") === true);
  check("an unknown provider has none", hasControls("huggingchat") === false);
}

function testControlSettings() {
  section("provider control settings");
  const { resolveControls, labelFor } = require(path.join(__dirname, "..", "..", "desktop", "controls-settings.js"));

  const controls = [
    { id: "mode", kind: "select", default: "default", options: [{ value: "default" }, { value: "expert" }] },
    { id: "deep-thinking", kind: "toggle", default: true },
    { id: "smart-search", kind: "toggle", default: false },
  ];

  const defaults = resolveControls(controls, {});
  check("defaults are used when nothing is saved", defaults.mode === "default");
  check("a toggle defaulting to on is on", defaults["deep-thinking"] === true);
  check("a toggle defaulting to off is off", defaults["smart-search"] === false);

  const saved = resolveControls(controls, { mode: "expert", "deep-thinking": false });
  check("saved choices win over defaults", saved.mode === "expert");
  check("a saved false is respected, not treated as unset", saved["deep-thinking"] === false);
  check("unsaved controls still get their default", saved["smart-search"] === false);

  // Saved values are validated against what the provider declares now. A model
  // dropped from a provider's line-up would otherwise be requested forever.
  check("a value no longer offered falls away",
    resolveControls(controls, { mode: "vision" }).mode === undefined);
  check("a control no longer declared falls away",
    resolveControls(controls, { "old-control": true })["old-control"] === undefined);
  check("a non-boolean for a toggle is dropped",
    resolveControls(controls, { "deep-thinking": "yes" })["deep-thinking"] === undefined);

  check("a provider with no controls asks for nothing", Object.keys(resolveControls([], {})).length === 0);
  check("missing arguments are survivable", Object.keys(resolveControls(null, null)).length === 0);

  const withLabels = { options: [{ value: "glm-5.2", label: "GLM-5.2" }] };
  check("a value's label is shown", labelFor(withLabels, "glm-5.2") === "GLM-5.2");
  check("an unknown value falls back to itself", labelFor(withLabels, "glm-9") === "glm-9");
}

function testCssTokens() {
  section("css tokens");
  const { colorLiteralsOutsideThemes, themeBlocks } = require(path.join(__dirname, "css-lint.cjs"));
  const css = fs.readFileSync(path.join(__dirname, "..", "..", "desktop", "styles.css"), "utf8");

  // The load-bearing check. A colour outside a theme block is a rule no theme
  // can reach, and it fails silently - the app just looks wrong on that theme.
  const stray = colorLiteralsOutsideThemes(css);
  check("no colour literals outside theme blocks", stray.length === 0,
    stray.slice(0, 6).map(function (o) { return "line " + o.line + ": " + o.text; }).join(" | "));

  // Sanity-check the lint itself, so a broken detector cannot report success.
  check("the lint detects a hex", colorLiteralsOutsideThemes(".a{color:#fff;}").length === 1);
  check("the lint detects rgba", colorLiteralsOutsideThemes(".a{background:rgba(0,0,0,.5);}").length === 1);
  check("the lint ignores colours inside :root", colorLiteralsOutsideThemes(":root{--x:#fff;}").length === 0);
  check("the lint ignores colours inside a theme block",
    colorLiteralsOutsideThemes('[data-theme="paper"]{--x:#fff;}').length === 0);
  check("the lint sees a rule after a theme block closes",
    colorLiteralsOutsideThemes(":root{--x:#fff;}\n.a{color:#000;}").length === 1);
  check("the lint ignores var() references", colorLiteralsOutsideThemes(".a{color:var(--txt);}").length === 0);

  const blocks = themeBlocks(css);
  check("a :root block exists", blocks.some(function (b) { return b.name === ":root"; }));

  // Every theme must redefine the whole palette. A theme that omits --err-bg
  // inherits Midnight's near-black, which looks correct until the day a build
  // fails - on Paper, that is dark red text on a near-black background.
  const { STRUCTURAL_PREFIXES } = require(path.join(__dirname, "css-lint.cjs"));
  const { THEMES } = require(path.join(__dirname, "..", "..", "desktop", "theme.js"));
  const rootBlock = blocks.find(function (b) { return b.name === ":root"; });
  const palette = rootBlock.tokens.filter(function (t) {
    return !STRUCTURAL_PREFIXES.some(function (p) { return t.indexOf(p) === 0; });
  });

  check("the palette is substantial", palette.length >= 25, String(palette.length));
  check("structural tokens are excluded from the palette",
    palette.indexOf("--sp-1") === -1 && palette.indexOf("--r-md") === -1);

  THEMES.forEach(function (t) {
    if (t.id === "midnight") return;   // midnight IS :root
    const block = blocks.find(function (b) { return b.name === t.id; });
    if (!block) { check("theme " + t.id + " has a block", false); return; }
    const missing = palette.filter(function (tok) { return block.tokens.indexOf(tok) === -1; });
    check("theme " + t.id + " defines the whole palette", missing.length === 0, missing.join(" "));
  });

  // Structural tokens belong to :root alone; a theme redefining spacing would
  // change layout, which is not what a theme is for.
  blocks.forEach(function (b) {
    if (b.name === ":root") return;
    const structural = b.tokens.filter(function (t) {
      return STRUCTURAL_PREFIXES.some(function (p) { return t.indexOf(p) === 0; });
    });
    check("theme " + b.name + " does not redefine structure", structural.length === 0, structural.join(" "));
  });

  // The decor flag drives whether Appearance offers a decoration toggle, so it
  // has to agree with which themes actually declare a texture. Drift between
  // the two shows up as a toggle that does nothing.
  const textured = blocks.filter(function (b) {
    return b.name !== ":root" && /--overlay-texture:\s*(?!none)/.test(
      css.slice(css.indexOf('[data-theme="' + b.name + '"]'))
         .slice(0, css.slice(css.indexOf('[data-theme="' + b.name + '"]')).indexOf("}")));
  }).map(function (b) { return b.name; });
  const flagged = THEMES.filter(function (t) { return t.decor; }).map(function (t) { return t.id; });
  check("the crt flag matches the themes with a texture",
    textured.sort().join() === flagged.sort().join(), "textured=" + textured.join() + " flagged=" + flagged.join());
}

function testTheme() {
  section("theme resolution");
  const { THEMES, resolveTheme, DEFAULT_THEME } = require(path.join(__dirname, "..", "..", "desktop", "theme.js"));

  check("nine themes are offered", THEMES.length === 9, String(THEMES.length));
  check("midnight is the default", DEFAULT_THEME === "midnight");
  check("midnight is in the list", THEMES.some(function (t) { return t.id === "midnight"; }));
  check("every theme has an id and a name", THEMES.every(function (t) { return t.id && t.name; }));
  check("ids are unique",
    new Set(THEMES.map(function (t) { return t.id; })).size === THEMES.length);
  // Only the themes carrying a texture are marked, so the Appearance toggle
  // knows when it is worth showing. Task 3's test proves this agrees with the
  // CSS; this one just pins the count.
  check("five themes carry decoration",
    THEMES.filter(function (t) { return t.decor; }).length === 5,
    THEMES.filter(function (t) { return t.decor; }).map(function (t) { return t.id; }).join());

  check("a saved theme is honoured", resolveTheme("paper") === "paper");
  check("nothing saved yields the default", resolveTheme(null) === "midnight");
  check("an empty string yields the default", resolveTheme("") === "midnight");
  // A theme removed in a later version must not leave the app unstyled - every
  // token would go unresolved, which renders as black text on white.
  check("an unknown theme falls back", resolveTheme("vaporwave-deluxe") === "midnight");
  check("a non-string falls back", resolveTheme({ id: "paper" }) === "midnight");
}

function testLogo() {
  section("logo");
  const svg = fs.readFileSync(path.join(__dirname, "..", "..", "build", "icon.svg"), "utf8");

  // Sub-project 8 rasterises this into .ico and .png. A known viewBox is what
  // makes those sizes land on whole pixels.
  check("the viewBox is 32x32", /viewBox=["']0 0 32 32["']/.test(svg), svg.slice(0, 120));
  check("it is an svg element", /<svg[\s>]/.test(svg));
  check("it draws something", /<path[\s>]/.test(svg));
  // currentColor is what lets one file serve nine themes and an installer icon.
  check("it inherits its colour", svg.indexOf("currentColor") !== -1);
  check("no raster is embedded", svg.indexOf("data:image") === -1);

  // electron-builder cannot read SVG. It needs a PNG of at least 512x512.
  const png = fs.readFileSync(path.join(__dirname, "..", "..", "build", "icon.png"));
  check("the png is a png", png.slice(1, 4).toString() === "PNG");
  // IHDR puts width and height at bytes 16-23, big-endian. No library needed.
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  check("the png is 512 wide", w === 512, String(w));
  check("the png is 512 tall", h === 512, String(h));
}

function testLanguageMark() {
  section("language marks");
  const { languageMark } = require(path.join(__dirname, "..", "..", "desktop", "language-mark.js"));

  check("python", languageMark("handlers.py").label === "py");
  check("python uses its own token", languageMark("handlers.py").token === "--lang-py");
  check("rust", languageMark("src/main.rs").token === "--lang-rs");
  check("javascript", languageMark("index.js").token === "--lang-js");
  check("java", languageMark("App.java").token === "--lang-java");
  check("c", languageMark("main.c").token === "--lang-c");
  check("c++ shares the c accent", languageMark("app.cpp").token === "--lang-c");
  check("headers share it too", languageMark("util.h").token === "--lang-c");

  // The label is the extension, so a family shares a colour but keeps its name.
  check("the label is the extension", languageMark("app.cpp").label === "cpp");
  check("uppercase is normalised", languageMark("MAIN.PY").label === "py");

  // Anything unrecognised still gets a mark, so rows do not change width.
  check("an unknown extension falls back", languageMark("notes.txt").token === "--lang-default");
  check("and keeps its extension as the label", languageMark("notes.txt").label === "txt");
  check("no extension falls back", languageMark("Makefile").token === "--lang-default");
  check("a file with no extension is labelled", languageMark("Makefile").label === "—");
  // .gitignore is not a "gitignore" file; labelling it as one would be wrong
  // on every dotfile row.
  check("a dotfile is not read as an extension", languageMark(".gitignore").label === "—");
  check("a windows path works", languageMark("src\\main.rs").token === "--lang-rs");
  check("a long extension is truncated", languageMark("a.mjsonschema").label.length <= 4);
  check("missing input is survivable", languageMark(undefined).token === "--lang-default");
}

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
  // Two providers must not share a profile directory - that would share a login.
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

function testBuildConfig() {
  section("build configuration");
  const root = path.join(__dirname, "..", "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const b = pkg.build || {};

  check("the app entry point is the desktop main", pkg.main === "desktop/main.js", String(pkg.main));
  // Was pinned to the literal "1.0.0", so the first patch release failed a test
  // that had nothing to do with the change. Nothing in the app hardcodes a
  // version - it reads package.json - so what is worth asserting is that the
  // version is well formed and that the release workflow will accept a tag for
  // it, not what the digits happen to be.
  check("the version is semver", /^\d+\.\d+\.\d+$/.test(pkg.version), String(pkg.version));
  // Quoted literals only. The first version of this flagged a comment that
  // mentioned the release it was describing, which is prose, not a hardcoded
  // version - and a check that punishes explaining yourself is a bad check.
  check("no source file hardcodes a version as a string literal", (() => {
    const files = ["desktop/main.js", "desktop/renderer.js", "desktop/index.html"];
    return files.every((f) => {
      const src = fs.readFileSync(path.join(root, f), "utf8");
      return !/["'`]\d+\.\d+\.\d+["'`]/.test(src);
    });
  })());
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
  // local-agent/storage holds live session cookies and private chat URLs, and
  // .gitignore does not constrain electron-builder. An allow-list is used so a
  // mistake is a missing file rather than a published credential.
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

function testPlanScale() {
  section("plan scale");
  const { estimateDuration, MAX_PLAN_STEPS } = require(path.join(DIST, "plan-scale.js"));

  check("the bound is 40", MAX_PLAN_STEPS === 40);

  // Each step is a browser round-trip of a minute or two, so a long plan is a
  // long build. The estimate exists so that is a choice, not a surprise.
  check("a short plan reads in minutes", /min/.test(estimateDuration(3)), estimateDuration(3));
  check("a long plan reads differently", estimateDuration(30) !== estimateDuration(3));
  check("zero steps is survivable", typeof estimateDuration(0) === "string");

  const mk = (n) => {
    const steps = [];
    for (let i = 0; i < n; i++) steps.push({ title: "s" + i, detail: "d", files: ["f" + i + ".py"] });
    return F + "json\n" + JSON.stringify({ summary: "x", steps: steps }) + "\n" + F;
  };

  // The eight-step cap was the complaint. Anything up to the bound must parse.
  check("a nine-step plan parses", (parsePlanRobust(mk(9)) || {}).steps.length === 9);
  check("a twenty-step plan parses", (parsePlanRobust(mk(20)) || {}).steps.length === 20);
  check("exactly forty parses", (parsePlanRobust(mk(40)) || {}).steps.length === 40);

  // Rejecting rather than truncating: a truncated plan silently loses the end
  // of the project - deployment, tests - while looking like it worked.
  check("forty-one is rejected, not truncated", parsePlanRobust(mk(41)) === null);

  // runCommand is optional so older and hand-written plans still parse.
  const withRun = F + 'json\n{"summary":"x","runCommand":"python3 app.py","steps":[{"title":"t","detail":"d","files":["a.py"]}]}\n' + F;
  check("a plan may declare how to run itself", parsePlanRobust(withRun).runCommand === "python3 app.py");
  check("a plan without runCommand still parses",
    !!parsePlanRobust(F + 'json\n{"summary":"x","steps":[{"title":"t","detail":"d","files":["a.py"]}]}\n' + F));

  // The renderer cannot require the agent's module - no bundler, no require -
  // so the estimate is duplicated in desktop/plan-scale.js. Duplication is only
  // acceptable while something proves the copies agree.
  const ui = require(path.join(__dirname, "..", "..", "desktop", "plan-scale.js"));
  [0, 1, 3, 8, 20, 40, 100].forEach(function (n) {
    check("both copies agree at " + n + " steps",
      ui.estimateDuration(n) === estimateDuration(n),
      "ui=" + ui.estimateDuration(n) + " agent=" + estimateDuration(n));
  });
}

function testRunManifest() {
  section("run manifest");
  const m = require(path.join(DIST, "run-manifest.js"));

  check("the manifest has a stable name", m.MANIFEST_NAME === "closeni.run.json");

  // --- resolution order. This is the logic behind the original complaint:
  // "no entry point found" when the app already knew the answer.
  const man = { version: 1, run: "python3 src/app/server.py" };
  check("the manifest wins", m.resolveRun(man, "python3 other.py", "python3 main.py").command === "python3 src/app/server.py");
  check("and says so", m.resolveRun(man, "x", "y").source === "manifest");
  check("the plan wins over detection", m.resolveRun(null, "python3 plan.py", "python3 main.py").command === "python3 plan.py");
  check("and says so", m.resolveRun(null, "python3 plan.py", "y").source === "plan");
  check("detection is the fallback", m.resolveRun(null, undefined, "python3 main.py").source === "detected");
  // "none" rather than a broken command: the panel says it found nothing.
  check("nothing found is reported", m.resolveRun(null, undefined, null).source === "none");
  check("and yields no command", m.resolveRun(null, undefined, null).command === null);
  // An empty run must fall through, not resolve to "".
  check("an empty manifest run falls through",
    m.resolveRun({ version: 1, run: "" }, undefined, "python3 main.py").source === "detected");
  check("a whitespace run falls through",
    m.resolveRun({ version: 1, run: "  " }, "python3 plan.py", null).source === "plan");

  // --- an edited command survives a rebuild. Watching the next build undo your
  // correction is how people stop trusting a tool.
  const edited = m.mergeManifest({ version: 1, run: "python3 mine.py", userEdited: true }, "python3 generated.py");
  check("an edited command is kept", edited.run === "python3 mine.py");
  check("and stays flagged", edited.userEdited === true);
  const fresh = m.mergeManifest({ version: 1, run: "python3 old.py", userEdited: false }, "python3 new.py");
  check("an unedited command is replaced", fresh.run === "python3 new.py");
  check("editing sets the flag",
    m.mergeManifest(null, "python3 x.py", { userEdited: true }).userEdited === true);
  check("a new manifest carries a version", m.mergeManifest(null, "python3 x.py").version === 1);
  check("extra fields are kept",
    m.mergeManifest(null, "python3 x.py", { install: "pip install -r requirements.txt" }).install === "pip install -r requirements.txt");

  // --- scripts
  const sh = m.renderRunScript({ version: 1, run: "python3 app.py", install: "pip install -r requirements.txt" }, "posix");
  check("the shell script has a shebang", sh.indexOf("#!/bin/sh") === 0, sh.slice(0, 20));
  check("the shell script installs first", sh.indexOf("pip install") < sh.indexOf("python3 app.py"));
  check("the shell script runs the command", sh.indexOf("python3 app.py") !== -1);
  const bat = m.renderRunScript({ version: 1, run: "python app.py" }, "win32");
  check("the batch file suppresses echo", bat.indexOf("@echo off") === 0, bat.slice(0, 20));
  check("the batch file runs the command", bat.indexOf("python app.py") !== -1);
  // A command with quotes must survive verbatim - mangling it produces a script
  // that fails in a way nobody can explain.
  const quoted = m.renderRunScript({ version: 1, run: 'python3 -c "print(1)"' }, "posix");
  check("quotes survive", quoted.indexOf('python3 -c "print(1)"') !== -1, quoted);
}

function testPreviewTarget() {
  section("preview target");
  const { previewTarget } = require(path.join(__dirname, "..", "..", "desktop", "preview-target.js"));

  // Real output from the servers these projects actually produce.
  const flask = " * Running on http://127.0.0.1:5000\n * Press CTRL+C to quit";
  check("a flask url is found", previewTarget(flask, []).url === "http://127.0.0.1:5000");
  check("and is a server", previewTarget(flask, []).kind === "server");
  const vite = "  VITE v5.0.0  ready in 300 ms\n  Local:   http://localhost:5173/";
  check("a vite url is found", previewTarget(vite, []).url === "http://localhost:5173/");
  const py = "Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...";
  check("a python http.server url is found", previewTarget(py, []).url.indexOf("8000") !== -1);
  // The last url wins: a server that reprints its address as it restarts should
  // not pin the preview to the first line it ever wrote.
  check("the last url wins",
    previewTarget("http://localhost:1111\nhttp://localhost:2222", []).url === "http://localhost:2222");

  // No server: a static page is the next best thing.
  check("index.html is used when there is no url", previewTarget("", ["index.html"]).kind === "file");
  check("and points at the file", previewTarget("", ["index.html"]).url.indexOf("index.html") !== -1);
  check("a nested index.html is found", previewTarget("", ["public/index.html"]).url.indexOf("public/index.html") !== -1);
  check("a root index.html beats a nested one",
    previewTarget("", ["public/index.html", "index.html"]).url.indexOf("public") === -1);

  // Nothing to show means the toggle hides, rather than an empty frame.
  check("no url and no html yields nothing", previewTarget("", ["main.py"]) === null);
  check("empty input is survivable", previewTarget("", []) === null);
  check("missing input is survivable", previewTarget(null, null) === null);
  // A documentation link in a traceback is not a server, and pointing the
  // preview at the open internet is not what anyone asked for.
  check("an external doc link is ignored", previewTarget("see https://docs.python.org/3/", []) === null);
}

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

  // A join waits for every dependency. Step 2 is still offered here - it only
  // needs step 0 - so the assertion is about step 3 specifically.
  check("a join waits for both",
    runnableSteps(diamond, S({ completed: [0, 1] }), 4).indexOf(3) === -1,
    JSON.stringify(runnableSteps(diamond, S({ completed: [0, 1] }), 4)));
  check("a join with one branch running still waits",
    JSON.stringify(runnableSteps(diamond, S({ completed: [0, 1], running: [2] }), 4)) === "[]");
  check("and starts once both are done",
    JSON.stringify(runnableSteps(diamond, S({ completed: [0, 1, 2] }), 4)) === "[3]");

  // Nothing left to do returns nothing, rather than looping forever.
  check("everything complete yields nothing",
    JSON.stringify(runnableSteps(diamond, S({ completed: [0, 1, 2, 3] }), 4)) === "[]");
  check("a running step is not offered twice",
    runnableSteps(diamond, S({ completed: [0], running: [1, 2] }), 9).indexOf(1) === -1);
  check("a completed step is not offered again",
    runnableSteps(serial, S({ completed: [0, 1] }), 9).indexOf(0) === -1);

  // A skipped step counts as satisfied - the user chose to move past it, and
  // blocking everything downstream would make Skip useless.
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

  // --- resuming. Without this, pressing Build after a partial run re-runs
  // every completed step from the beginning, which is what made recovering
  // from a failure feel like starting over.
  const { seedState } = require(path.join(__dirname, "..", "..", "desktop", "scheduler.js"));
  const St = (statuses) => statuses.map(function (x) { return { status: x }; });

  const fresh = seedState(St(["pending", "pending", "pending"]));
  check("a fresh plan seeds nothing done", JSON.stringify(fresh.completed) === "[]");
  const part = seedState(St(["done", "done", "failed", "pending"]));
  check("finished steps are remembered", JSON.stringify(part.completed) === "[0,1]");
  check("a failure is remembered", JSON.stringify(part.failed) === "[2]");
  check("pending steps stay runnable", part.completed.indexOf(3) === -1 && part.failed.indexOf(3) === -1);
  check("skipped is remembered",
    JSON.stringify(seedState(St(["skipped", "pending"])).skipped) === "[0]");
  check("blocked is remembered",
    JSON.stringify(seedState(St(["failed", "blocked"])).blocked) === "[1]");

  // A step left "running" when the app closed is not running now. Treating it
  // as in-flight would wedge the scheduler waiting for something that will
  // never report back.
  const interrupted = seedState(St(["done", "running", "pending"]));
  check("an interrupted step is not still running", JSON.stringify(interrupted.running) === "[]");
  check("and becomes runnable again",
    JSON.stringify(runnableSteps([[], [0], [1]], interrupted, 2)) === "[1]");

  // Seeded state must drive the scheduler straight to the next unfinished step.
  check("a resumed build continues rather than restarting",
    JSON.stringify(runnableSteps([[], [0], [1], [2]], seedState(St(["done", "done", "pending", "pending"])), 1)) === "[2]");
}

async function testAsyncPool() {
  section("async primitives");
  const { createMutex, createPool } = require(path.join(DIST, "async-pool.js"));
  const wait = (ms) => new Promise(function (r) { setTimeout(r, ms); });

  // The mutex is what makes "parallel conversations, serialised applies" true.
  // If two bodies ever overlap, two workers could interleave writes to the
  // ledger, or - worse - both prompt for command approval, and the replies
  // arrive on one stdin queue with nothing saying which command they answer.
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

  // A throwing body must release the lock, or the whole build stops dead.
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

function testGitHubSafe() {
  section("github safety");
  const s = require(path.join(__dirname, "..", "..", "desktop", "github-safe.js"));

  // --- redaction. A token in a log file has been published: to a screenshot,
  // a pasted error report, a support request.
  const T = "ghp_abcdef1234567890";
  check("a token is redacted", s.redactToken("using " + T + " now", T).indexOf(T) === -1);
  check("and leaves a marker", /REDACTED/.test(s.redactToken("using " + T, T)));
  check("every occurrence goes", s.redactToken(T + " and " + T, T).indexOf(T) === -1);
  check("a token inside a url goes",
    s.redactToken("https://x-access-token:" + T + "@github.com/a/b", T).indexOf(T) === -1);
  check("surrounding text survives", /^using /.test(s.redactToken("using " + T, T)));
  // A partial match is not the token and must not be mangled.
  check("a partial match is left alone", s.redactToken("ghp_abc is short", T) === "ghp_abc is short");
  // An absent token must not turn the text into mush - an empty needle would
  // otherwise match between every character.
  check("no token leaves text intact", s.redactToken("hello", "") === "hello");
  check("a null token leaves text intact", s.redactToken("hello", null) === "hello");
  check("empty text is survivable", s.redactToken("", T) === "");
  check("null text is survivable", s.redactToken(null, T) === "");
  // A token containing regex metacharacters must still be replaced literally.
  check("metacharacters in the token are literal",
    s.redactToken("a b+c d", "b+c").indexOf("b+c") === -1);

  // --- argument safety. With shell:false an argument is data, not syntax, so
  // content passes through untouched; only the wrong TYPE is rejected.
  check("a normal list passes",
    JSON.stringify(s.safeGitArgs(["commit", "-m", "hi"])) === JSON.stringify(["commit", "-m", "hi"]));
  check("a semicolon is data, not syntax",
    s.safeGitArgs(["commit", "-m", "fix; drop table"])[2] === "fix; drop table");
  check("backticks survive unchanged",
    s.safeGitArgs(["commit", "-m", "use `x`"])[2] === "use `x`");
  check("a dollar substitution survives unchanged",
    s.safeGitArgs(["commit", "-m", "cost $(x)"])[2] === "cost $(x)");
  check("an empty list is fine", JSON.stringify(s.safeGitArgs([])) === "[]");

  let threw = 0;
  [[1], [null], [undefined], [{}], "notalist", null].forEach(function (bad) {
    try { s.safeGitArgs(bad); } catch (e) { threw++; }
  });
  check("bad argument types all throw", threw === 6, String(threw));

  // --- repo urls. Both clone and fetch go through this, so a search result
  // cannot aim either at a host of its choosing.
  const p = s.parseRepoUrl;
  check("an https url parses", JSON.stringify(p("https://github.com/pallets/flask")) === '{"owner":"pallets","repo":"flask"}');
  check("a .git suffix is stripped", p("https://github.com/pallets/flask.git").repo === "flask");
  check("a trailing slash is fine", p("https://github.com/pallets/flask/").repo === "flask");
  check("extra path segments are ignored", p("https://github.com/pallets/flask/tree/main").repo === "flask");
  check("the ssh form parses", JSON.stringify(p("git@github.com:pallets/flask.git")) === '{"owner":"pallets","repo":"flask"}');
  check("www is accepted", p("https://www.github.com/pallets/flask").owner === "pallets");

  check("another host is rejected", p("https://gitlab.com/a/b") === null);
  // The one that matters: a lookalike host must not pass a prefix check.
  check("a lookalike host is rejected", p("https://github.com.evil.test/a/b") === null);
  check("a subdomain lookalike is rejected", p("https://notgithub.com/a/b") === null);
  check("a raw host is rejected", p("https://raw.githubusercontent.com/a/b") === null);
  check("too few segments is rejected", p("https://github.com/pallets") === null);
  check("no url is rejected", p("") === null);
  check("a null url is rejected", p(null) === null);
  check("a non-url is rejected", p("just some words") === null);
  check("a javascript scheme is rejected", p("javascript:alert(1)") === null);

  // --- persistence policy
  check("encryption available means persist", s.shouldPersistToken(true) === true);
  // Writing plaintext because encryption failed would take a decision the user
  // never made and leave a credential in a predictable path.
  check("encryption unavailable means memory only", s.shouldPersistToken(false) === false);
  check("an unknown state is treated as unavailable", s.shouldPersistToken(undefined) === false);
}

/**
 * The bug this guards against is invisible in normal use: it only fires when
 * someone types a semicolon. Asserting against the source is crude, but it is
 * the only way to catch a regression with no runtime symptom until it has one.
 */
function testGitSpawnHardening() {
  section("git spawn hardening");
  const main = fs.readFileSync(path.join(__dirname, "..", "..", "desktop", "main.js"), "utf8");
  const at = main.indexOf('ipcMain.handle("git"');
  const gitBlock = main.slice(at, at + 900);
  check("the git handler exists", at !== -1 && gitBlock.length > 100);
  check("git does not run through a shell", /shell:\s*false/.test(gitBlock), gitBlock.slice(0, 200));
  check("git arguments are validated", /safeGitArgs/.test(gitBlock));
  check("git output is redacted", /redactToken/.test(gitBlock));
}

async function testGitHubApi() {
  section("github api shapes");
  const { createGitHubApi } = require(path.join(__dirname, "..", "..", "desktop", "github-api.js"));

  // The transport is injected, so every call shape is tested without a token
  // and without touching GitHub - which matters, because there is no credential
  // in this environment and there will not be one.
  const calls = [];
  const fake = function (method, apiPath, body) {
    calls.push({ method: method, path: apiPath, body: body });
    if (apiPath.indexOf("/readme") !== -1) {
      return Promise.resolve({ status: 200, body: { content: Buffer.from("# Hi").toString("base64") } });
    }
    if (apiPath.indexOf("/git/trees/") !== -1) {
      return Promise.resolve({ status: 200, body: { tree: [{ path: "a.py", type: "blob" }, { path: "src", type: "tree" }] } });
    }
    if (apiPath.indexOf("/actions/runs") !== -1) {
      return Promise.resolve({ status: 200, body: { workflow_runs: [{ name: "ci", status: "completed", conclusion: "success", html_url: "u" }] } });
    }
    return Promise.resolve({ status: 200, body: [{ full_name: "me/x", private: false }] });
  };
  const api = createGitHubApi(fake);

  await api.listRepos();
  check("repos are listed for the signed-in user", calls[0].path.indexOf("/user/repos") === 0, calls[0].path);
  check("and sorted by recent activity", /sort=updated/.test(calls[0].path));

  const readme = await api.getReadme("pallets", "flask");
  check("the readme path is right", calls[1].path === "/repos/pallets/flask/readme", calls[1].path);
  // The API returns base64; a caller putting this in a prompt needs text.
  check("the readme is decoded", readme === "# Hi", JSON.stringify(readme));

  const tree = await api.getTree("pallets", "flask");
  check("the tree is fetched recursively", /recursive=1/.test(calls[2].path), calls[2].path);
  check("only files are returned", JSON.stringify(tree) === '["a.py"]', JSON.stringify(tree));

  const runs = await api.listRuns("pallets", "flask");
  check("runs are listed", calls[3].path.indexOf("/repos/pallets/flask/actions/runs") === 0);
  check("and are simplified", runs[0].name === "ci" && runs[0].conclusion === "success");

  await api.dispatchWorkflow("pallets", "flask", "ci.yml", "main");
  check("a dispatch is a POST", calls[4].method === "POST");
  check("to the workflow's dispatch path",
    calls[4].path === "/repos/pallets/flask/actions/workflows/ci.yml/dispatches", calls[4].path);
  check("carrying the ref", calls[4].body.ref === "main");

  await api.createRepo("newthing", true);
  check("creating a repo is a POST to /user/repos", calls[5].method === "POST" && calls[5].path === "/user/repos");
  check("the name is sent", calls[5].body.name === "newthing");
  check("privacy is honoured", calls[5].body.private === true);

  // Failures must be legible rather than throwing something shapeless.
  const failing = createGitHubApi(function () { return Promise.resolve({ status: 401, body: { message: "Bad credentials" } }); });
  let msg = "";
  try { await failing.listRepos(); } catch (e) { msg = e.message; }
  check("a 401 is reported clearly", /token|401/i.test(msg), msg);

  // A rate limit is a wait, not a breakage, and saying which is the difference
  // between "try later" and "something is broken".
  const limited = createGitHubApi(function () {
    return Promise.resolve({ status: 403, body: { message: "API rate limit exceeded" } });
  });
  let rateMsg = "";
  try { await limited.listRepos(); } catch (e) { rateMsg = e.message; }
  check("a rate limit says so", /rate limit/i.test(rateMsg), rateMsg);

  // A 403 that is not a rate limit is usually a missing scope, and saying so
  // saves the user hunting for a problem that is one checkbox away.
  const scoped = createGitHubApi(function () {
    return Promise.resolve({ status: 403, body: { message: "Resource not accessible" } });
  });
  let scopeMsg = "";
  try { await scoped.listRepos(); } catch (e) { scopeMsg = e.message; }
  check("a plain 403 mentions scopes", /scope/i.test(scopeMsg), scopeMsg);
}

function testCommandPolicy() {
  section("command policy");
  const p = require(path.join(DIST, "verification/command-policy.js"));

  // --- the safety floor. Auto-allow used to mean literally everything: a real
  // run auto-executed "sudo apt install" and "curl ... | python3" with no
  // confirmation at all.
  check("sudo always asks", p.needsConfirmation("sudo apt install -y x") === true);
  check("apt always asks", p.needsConfirmation("apt install -y python3-venv") === true);
  check("a piped remote script always asks",
    p.needsConfirmation("curl -sS https://example.com/get-pip.py | python3") === true);
  check("wget piped to a shell always asks",
    p.needsConfirmation("wget -qO- https://x.sh | sh") === true);
  check("rm -rf always asks", p.needsConfirmation("rm -rf build") === true);
  check("a disk write always asks", p.needsConfirmation("dd if=/dev/zero of=/dev/sda") === true);
  check("chmod 777 always asks", p.needsConfirmation("chmod 777 /etc") === true);
  check("a shutdown always asks", p.needsConfirmation("shutdown -h now") === true);
  // An || chain hides the dangerous half behind a harmless first command.
  check("a dangerous second clause is caught",
    p.needsConfirmation("apt install -y x || sudo apt install -y x") === true);
  check("a dangerous clause after && is caught",
    p.needsConfirmation("echo hi && sudo rm -rf /") === true);

  // Ordinary project commands stay automatic, or auto-allow means nothing.
  check("running the project is fine", p.needsConfirmation("python3 app.py") === false);
  check("running tests is fine", p.needsConfirmation("pytest -q") === false);
  check("npm run build is fine", p.needsConfirmation("npm run build") === false);
  check("a plain mkdir is fine", p.needsConfirmation("mkdir -p src") === false);
  check("an empty command is fine", p.needsConfirmation("") === false);
  check("a missing command is fine", p.needsConfirmation(null) === false);

  // --- environment setup. These failing is a machine problem, not a code
  // problem, and failing the step for it blocked fourteen good steps.
  check("venv is environment setup", p.isEnvironmentSetup("python3 -m venv venv") === true);
  check("pip install is environment setup", p.isEnvironmentSetup("pip install -r requirements.txt") === true);
  check("pip3 install too", p.isEnvironmentSetup("pip3 install flask") === true);
  check("apt install too", p.isEnvironmentSetup("apt install -y python3-venv") === true);
  check("npm install too", p.isEnvironmentSetup("npm install") === true);
  check("poetry install too", p.isEnvironmentSetup("poetry install") === true);
  check("activating a venv too", p.isEnvironmentSetup("source venv/bin/activate") === true);

  // Running or testing the project is verification, and must still fail a step.
  check("running the app is not setup", p.isEnvironmentSetup("python3 app.py") === false);
  check("running tests is not setup", p.isEnvironmentSetup("pytest") === false);
  check("npm run build is not setup", p.isEnvironmentSetup("npm run build") === false);
  check("npm test is not setup", p.isEnvironmentSetup("npm test") === false);
  check("an empty command is not setup", p.isEnvironmentSetup("") === false);

  // --- files the app generates and the model must not adopt. It saw run.sh in
  // the workspace and started maintaining it, overwriting what we wrote.
  check("the manifest is protected", p.isGeneratedFile("closeni.run.json") === true);
  check("run.sh is protected", p.isGeneratedFile("run.sh") === true);
  check("run.bat is protected", p.isGeneratedFile("run.bat") === true);
  check("a nested run.sh is the project's own", p.isGeneratedFile("scripts/run.sh") === false);
  check("app.py is not protected", p.isGeneratedFile("app.py") === false);
  check("a windows path is normalised", p.isGeneratedFile(".\\run.sh") === true);
  check("no path is not protected", p.isGeneratedFile("") === false);
}

function testDependsOnNumbering() {
  section("dependsOn numbering");
  const { parsePlanRobust, normaliseDependsOn } = require(path.join(DIST, "parser/json-repair.js"));

  // The real failure: a model numbers its steps 1..N and references them by
  // those numbers, so step 3 saying dependsOn:[2] reads as depending on itself
  // once treated as a zero-based index. An eighteen-step Flask plan was thrown
  // away twice in one run for this, and the re-ask resent the same good plan.
  const oneBased = {
    summary: "s",
    steps: [
      { title: "1", files: ["a"], dependsOn: [] },
      { title: "2", files: ["b"], dependsOn: [] },
      { title: "3", files: ["c"], dependsOn: [2] },
      { title: "4", files: ["d"], dependsOn: [3] },
      { title: "5", files: ["e"], dependsOn: [3, 4] },
    ],
  };
  const parsed = parsePlanRobust(JSON.stringify(oneBased));
  check("a 1-based plan is accepted", !!parsed, "rejected");
  // Step 3 -> step 2 is index 1; step 5 -> steps 3 and 4 are indices 2 and 3.
  check("its references are shifted to indices",
    parsed && JSON.stringify(parsed.steps.map((s) => s.dependsOn)) === "[[],[],[1],[2],[2,3]]",
    parsed && JSON.stringify(parsed.steps.map((s) => s.dependsOn)));

  // Zero-based is what the prompt asks for and must be left alone.
  const zeroBased = [
    { title: "a", files: ["a"], dependsOn: [] },
    { title: "b", files: ["b"], dependsOn: [0] },
    { title: "c", files: ["c"], dependsOn: [0, 1] },
  ];
  const kept = normaliseDependsOn(zeroBased);
  check("a 0-based plan is untouched",
    JSON.stringify(kept.map((s) => s.dependsOn)) === "[[],[0],[0,1]]",
    JSON.stringify(kept && kept.map((s) => s.dependsOn)));

  // A graph that is broken under both readings stays rejected: shifting must
  // not turn one unschedulable plan into a different unschedulable plan.
  check("a real cycle is still rejected",
    normaliseDependsOn([
      { title: "a", files: ["a"], dependsOn: [1] },
      { title: "b", files: ["b"], dependsOn: [0] },
    ]) === null);
  check("a forward dependency is still rejected",
    normaliseDependsOn([
      { title: "a", files: ["a"], dependsOn: [] },
      { title: "b", files: ["b"], dependsOn: [5] },
    ]) === null);
  check("an empty plan is rejected", normaliseDependsOn([]) === null);
}

function testRobustFileParsing() {
  section("robust file parsing");
  const { parseFilesRobust, salvageTruncatedJson } = require(path.join(DIST, "parser/json-repair.js"));
  const { extractFencedFiles, looksLikePath } = require(path.join(DIST, "parser/fenced-files.js"));

  const paths = function (text) {
    const r = parseFilesRobust(text);
    return r ? r.changes.map(function (c) { return c.filePath; }).join(",") : null;
  };

  // The control: nothing below may break the format that already worked.
  check("plain json still parses", paths('{"files":[{"path":"ok.py","content":"x=1"}]}') === "ok.py");
  check("fenced json still parses",
    paths('```json\n{"files":[{"path":"ok.py","content":"x=1"}]}\n```') === "ok.py");

  // Truncation - what a completion timeout leaves behind.
  check("a reply cut off mid-file keeps the files completed before the cut",
    paths('{"files":[{"path":"a.py","content":"x=1"},{"path":"b.py","content":"import os\\nprint(') === "a.py");
  check("a reply cut off after a key keeps the complete entries",
    paths('{"files":[{"path":"a.py","content":"x=1"},{"path":"b.py","content":') === "a.py");
  // The half-written file is dropped rather than written truncated. Closing an
  // open string recovers content that was cut off mid-write, which for source
  // means a file that will not compile - and may overwrite one that did. An
  // end-to-end build caught this: `"import os\nprint(` was salvaged into b.py
  // and failed the step. One re-ask is cheaper than a broken file.
  check("a single file cut off mid-content is refused, not written partial",
    parseFilesRobust('```json\n{"files":[{"path":"a.py","content":"import os\\nprint(1)') === null);
  check("salvage does nothing to already-balanced json",
    salvageTruncatedJson('{"a":1}').length === 0);

  // The model answered in code blocks instead of JSON.
  check("path from a comment on the first line",
    paths("Here:\n\n```python\n# src/app/config.py\nDEBUG = True\n```") === "src/app/config.py");
  check("path from the fence info string",
    paths("```python src/models.py\nclass A: pass\n```") === "src/models.py");
  check("path from a heading above the fence",
    paths("**src/routes.py**\n```python\nx = 1\n```") === "src/routes.py");
  check("several files with prose between them",
    paths("A:\n**src/a.py**\n```python\na=1\n```\nB:\n```python\n# src/b.py\nb=2\n```") === "src/a.py,src/b.py");

  // The naming comment must not survive into the file it named.
  const c = parseFilesRobust("```python\n# src/app.py\nDEBUG = True\n```");
  check("the path comment is stripped from the content",
    c.changes[0].newContent.indexOf("src/app.py") === -1 && /DEBUG/.test(c.changes[0].newContent));

  // A file written twice is the model correcting itself.
  const twice = parseFilesRobust("```python\n# a.py\nold\n```\nthen:\n```python\n# a.py\nnew\n```");
  check("a file written twice keeps the later version",
    twice.changes.length === 1 && /new/.test(twice.changes[0].newContent));

  // Guards. A false positive writes a junk file, which is worse than a miss.
  check("an illustrative block with no path is ignored",
    parseFilesRobust("For example:\n```python\nprint('hi')\n```") === null);
  check("prose is not mistaken for a path", !looksLikePath("Here is the file"));
  check("an absolute path is refused", !looksLikePath("/etc/passwd"));
  check("a traversing path is refused", !looksLikePath("../../etc/passwd"));
  check("a url is refused", !looksLikePath("https://example.com/a.py"));
  check("a real path is accepted", looksLikePath("src/app/config.py"));
  check("a bare known filename is accepted", looksLikePath("Dockerfile"));

  // Salvage can recover a path whose content never arrived; writing that would
  // blank a real file.
  check("a file with a path but no content is dropped",
    parseFilesRobust('{"files":[{"path":"b.py"}]}') === null);

  check("empty blocks are ignored", extractFencedFiles("```python x.py\n\n```").length === 0);

  // Reading a reply back out of a page loses the fence info string: the
  // language becomes a class on <code> and anything after it lands as the first
  // line of the code. A trial build lost two files to this before the bare
  // first line was accepted as a path.
  check("a bare path on the block's first line is accepted",
    paths("\n```\n src/store.py\nHABITS = []\n```\n") === "src/store.py");
  check("a block that is only a path is not a file",
    parseFilesRobust("```\nsrc/x.py\n```") === null);
  check("a normal first line is not mistaken for a path",
    parseFilesRobust("```\nimport os\nprint(1)\n```") === null);
}

function testPackagedPaths() {
  section("paths that must survive packaging");
  const root = path.join(__dirname, "..", "..");
  const main = fs.readFileSync(path.join(root, "desktop/main.js"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

  // Packaged, __dirname is inside the archive, so path.join(__dirname, "..") is
  // app.asar itself - a file. Spawning with that as cwd fails ENOENT, and Node
  // blames the executable, which is how an installed build reported
  // "spawn C:\Program Files\CloseNI\CloseNI.exe ENOENT" - the one path that was
  // definitely fine.
  const spawnCwds = [...main.matchAll(/cwd:\s*([^,\n]+)/g)].map((m) => m[1].trim());
  check("no spawn uses an archive-relative cwd",
    spawnCwds.every((c) => !/__dirname,\s*"\.\."/.test(c)), spawnCwds.join(" | "));
  check("spawns use a real directory helper",
    spawnCwds.some((c) => /spawnCwd\(\)/.test(c)), spawnCwds.join(" | "));
  check("the helper points at resourcesPath when packaged",
    /isPackaged\s*\?\s*process\.resourcesPath/.test(main));

  // Anything reached through unpackedPath must actually be unpacked, or the
  // helper falls back to a path inside the archive.
  const unpacked = (pkg.build && pkg.build.asarUnpack) || [];
  const referenced = [...main.matchAll(/unpackedPath\(path\.join\("([^"]+)"/g)].map((m) => m[1]);
  for (const r of new Set(referenced)) {
    check("asarUnpack covers " + r,
      unpacked.some((u) => u.split("/")[0] === r), JSON.stringify(unpacked));
  }
  check("the agent is reached through the unpacked path",
    /function agentPath\(\)[^\n]*unpackedPath/.test(main));
}

function testPlaywrightCliResolution() {
  section("playwright installer is reachable");

  // The Download button reported "Playwright is missing from this build" on a
  // completely intact install. require.resolve("playwright/cli.js") throws
  // because Playwright declares an "exports" map that does not list ./cli.js,
  // and Node refuses deep imports outside it - the file being right there on
  // disk makes no difference.
  let deepThrew = false;
  try { require.resolve("playwright/cli.js"); } catch (e) { deepThrew = true; }
  check("the deep path is blocked by the exports map, as assumed", deepThrew);

  // ./package.json is in the map, so its directory is reachable.
  const dir = path.dirname(require.resolve("playwright/package.json"));
  const cli = path.join(dir, "cli.js");
  check("the installer resolves via package.json", fs.existsSync(cli), cli);

  // And the packaging must hand Playwright to the app as real files: it
  // resolves and spawns executables, which cannot be done from inside an asar.
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf-8"));
  const unpack = (pkg.build && pkg.build.asarUnpack) || [];
  check("playwright is unpacked from the asar",
    unpack.some(function (p) { return /node_modules\/playwright\/\*\*/.test(p); }), JSON.stringify(unpack));
  check("playwright-core is unpacked too",
    unpack.some(function (p) { return /playwright-core/.test(p); }), JSON.stringify(unpack));
}

function testBehaviourChecker() {
  section("behaviour checks");
  const {
    planBehaviourChecks, judge, looksLikeServer, TEST_TIMEOUT_MS, SMOKE_TIMEOUT_MS,
  } = require(path.join(DIST, "verification/behaviour-checker.js"));

  const have = (t) => t;            // every tool installed
  const none = () => null;          // nothing installed
  const noManifest = () => null;

  // Nothing to check is reported as nothing, never as a pass.
  check("an empty project plans no checks",
    planBehaviourChecks([], noManifest, have, null).length === 0);
  check("a run command alone gives a smoke check",
    planBehaviourChecks([], noManifest, have, "python3 app.py")
      .filter((c) => c.kind === "smoke").length === 1);

  // package.json is only a suite if it declares one. "npm test" with no test
  // script exits 1, which would read as a failing suite rather than none.
  const withTest = () => ({ scripts: { test: "jest" } });
  const withoutTest = () => ({ scripts: { build: "tsc" } });
  check("package.json with a test script counts",
    planBehaviourChecks(["package.json"], withTest, have, null).some((c) => c.kind === "test"));
  check("package.json without one does not",
    planBehaviourChecks(["package.json"], withoutTest, have, null).length === 0);
  check("package.json with an empty test script does not",
    planBehaviourChecks(["package.json"], () => ({ scripts: { test: "  " } }), have, null).length === 0);

  // One suite, not every suite a polyglot repo could plausibly have.
  const poly = planBehaviourChecks(["package.json", "Cargo.toml", "go.mod"], withTest, have, null);
  check("a polyglot repo runs one suite", poly.filter((c) => c.kind === "test").length === 1,
    JSON.stringify(poly.map((c) => c.command)));

  // A tests/ directory with no manifest is still a suite.
  check("a bare tests/ directory is detected",
    planBehaviourChecks(["tests"], noManifest, have, null).some((c) => c.kind === "test"));

  // A missing runner is reported, never silently dropped: a project with real
  // tests and no pytest must not look like a project with no tests.
  const missing = planBehaviourChecks(["tests"], noManifest, none, null);
  check("a suite whose runner is absent is still reported", missing.length === 1, JSON.stringify(missing));
  check("and is marked unavailable", missing[0].available === false);
  check("and names the tool needed", missing[0].tool === "pytest");

  // Servers and scripts have opposite success conditions.
  check("flask run reads as a server", looksLikeServer("flask run --port 5000"));
  check("npm start reads as a server", looksLikeServer("npm start"));
  check("uvicorn reads as a server", looksLikeServer("uvicorn main:app"));
  check("a plain script does not", !looksLikeServer("python3 tools/report.py"));
  check("an empty command does not", !looksLikeServer(""));

  const server = { kind: "smoke", command: "flask run", language: "run", timeoutMs: SMOKE_TIMEOUT_MS, survivesTimeout: true };
  const script = { kind: "smoke", command: "python3 x.py", language: "run", timeoutMs: SMOKE_TIMEOUT_MS };
  const suite = { kind: "test", command: "npm test", language: "javascript", timeoutMs: TEST_TIMEOUT_MS };

  check("a server still running at the deadline passes",
    judge(server, { success: false, timedOut: true }).passed);
  check("a server that exited early fails",
    !judge(server, { success: true, timedOut: false }).passed);
  check("a script that exits 0 passes", judge(script, { success: true, timedOut: false }).passed);
  check("a script that exits non-zero fails", !judge(script, { success: false, timedOut: false }).passed);
  check("a script that hangs fails", !judge(script, { success: false, timedOut: true }).passed);
  check("a passing suite passes", judge(suite, { success: true, timedOut: false }).passed);
  check("a failing suite fails", !judge(suite, { success: false, timedOut: false }).passed);
  check("a suite that times out fails", !judge(suite, { success: false, timedOut: true }).passed);

  // A run command is not trusted for being ours.
  check("the smoke check carries the project's own command",
    planBehaviourChecks([], noManifest, have, "python3 app.py")[0].command === "python3 app.py");
}

function testSearchBlockMatching() {
  section("search_replace matching");
  const { findSearchBlock, replaceLines, applyPatch } =
    require(path.join(DIST, "patch/patch-applier.js"));

  const file = "def add(a, b):\n    return a + b\n\ndef sub(a, b):\n    return a - b\n";
  const found = (blk) => {
    const r = findSearchBlock(file, blk);
    return r && r !== "ambiguous" ? r.start + "-" + r.end : String(r);
  };

  // A real run missed six of seven blocks on an exact substring match. Models
  // get the code right and the whitespace slightly wrong.
  check("an exact block matches", found("def add(a, b):\n    return a + b") === "0-2");
  check("trailing spaces are tolerated", found("def add(a, b):   \n    return a + b") === "0-2");
  check("CRLF is tolerated", found("def add(a, b):\r\n    return a + b") === "0-2");
  check("a trailing newline is tolerated", found("def add(a, b):\n    return a + b\n") === "0-2");

  // Indentation is the meaning of the code in Python, so it is compared
  // exactly: a matcher that shrugged at it could patch the wrong scope.
  check("wrong indentation does NOT match", found("def add(a, b):\n        return a + b") === "null");
  check("absent text does not match", found("def mul(a, b):\n    return a * b") === "null");
  check("an empty block does not match everything", found("") === "null");
  check("a whitespace-only block does not match", found("   \n  ") === "null");

  // String.replace silently took the first hit, which can edit a place nobody
  // looked at.
  check("a repeated block is ambiguous, not the first hit",
    findSearchBlock("x = 1\nx = 1\n", "x = 1") === "ambiguous");

  check("replacement leaves the rest of the file alone",
    replaceLines(file, 0, 2, "def add(a, b):\n    return a + b + 0") ===
    "def add(a, b):\n    return a + b + 0\n\ndef sub(a, b):\n    return a - b\n");
  check("a CRLF file stays CRLF",
    replaceLines("a\r\nb\r\n", 0, 1, "z") === "z\r\nb\r\n");

  // End to end through the applier, with the whitespace drift that failed live.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sr-"));
  fs.writeFileSync(path.join(ws, "m.py"), file);
  const res = applyPatch(ws, {
    changes: [{
      filePath: "m.py", mode: "search_replace", language: "python",
      searchBlock: "def add(a, b):   \n    return a + b",
      replaceBlock: "def add(a, b):\n    return a + b + 0",
    }],
  });
  check("the applier accepts a block with drifted whitespace",
    res.appliedFiles.length === 1, JSON.stringify(res.errors));
  check("and writes the change", fs.readFileSync(path.join(ws, "m.py"), "utf8").includes("a + b + 0"));

  // A miss must say what to do instead.
  const miss = applyPatch(ws, {
    changes: [{ filePath: "m.py", mode: "search_replace", language: "python",
      searchBlock: "nope", replaceBlock: "x" }],
  });
  check("a miss names the way out", (miss.errors || []).some((e) => /overwrite/.test(e)),
    JSON.stringify(miss.errors));

  fs.rmSync(ws, { recursive: true, force: true });
}

function testAbbreviationGuard() {
  section("abbreviated files never overwrite real ones");
  const { isAbbreviated, applyPatch } = require(path.join(DIST, "patch/patch-applier.js"));

  // Flagged: a stand-in for the file rather than the file.
  check("'rest of the file unchanged' is caught", isAbbreviated("A = 1\n# ... rest of the file unchanged ...\n"));
  check("'existing code here' is caught", isAbbreviated("function a(){}\n// existing code here\n"));
  check("'same as before' is caught", isAbbreviated("x = 1\n# ... same as before\n"));
  check("'keep the rest as-is' is caught", isAbbreviated("x = 1\n// keep the rest of the file as-is\n"));

  // Allowed: an ellipsis on its own is ordinary code.
  check("python Ellipsis is not flagged", !isAbbreviated("def f():\n    ...\n"));
  check("slicing is not flagged", !isAbbreviated("xs = data[...]\n"));
  check("prose using the word rest is not flagged",
    !isAbbreviated('"""Handles the rest of the pipeline."""\nx = 1\n'));
  check("empty content is not flagged", !isAbbreviated(""));

  // And the behaviour that matters: it must not reach disk.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-abbrev-"));
  const target = path.join(ws, "config.py");
  fs.writeFileSync(target, "DEBUG = True\nDB_PATH = 'habits.db'\n");

  const res = applyPatch(ws, {
    changes: [{ filePath: "config.py", mode: "overwrite", language: "python",
      newContent: "DEBUG = True\n# ... rest of the file unchanged ...\n" }],
  });
  check("the overwrite is refused", res.appliedFiles.length === 0, JSON.stringify(res.appliedFiles));
  check("the error names the problem", (res.errors || []).some(function (e) { return /abbreviated/i.test(e); }), JSON.stringify(res.errors));
  check("the real file is untouched",
    fs.readFileSync(target, "utf8").includes("DB_PATH"), fs.readFileSync(target, "utf8"));

  // Creating a NEW file with the same text destroys nothing, so it is allowed:
  // refusing there would risk blocking legitimate code on a guess.
  const fresh = applyPatch(ws, {
    changes: [{ filePath: "brand-new.py", mode: "create", language: "python",
      newContent: "A = 1\n# ... rest of the file unchanged ...\n" }],
  });
  check("a new file with the same text is allowed", fresh.appliedFiles.length === 1, JSON.stringify(fresh.errors));

  fs.rmSync(ws, { recursive: true, force: true });
}

async function testAgentQueue() {
  section("agent run queue");

  // Mirrors queueAgentRun in desktop/main.js. Every agent run opens the same
  // Chromium profile directory, and Chromium locks it - two runs at once means
  // the second gets a profile it cannot own, an empty page, and a "Chat input
  // not found" that looks like a broken selector. So runs must not overlap.
  let agentQueue = Promise.resolve();
  function queueAgentRun(task) {
    const run = agentQueue.then(function () { return task(); }, function () { return task(); });
    agentQueue = run.then(function () {}, function () {});
    return run;
  }

  const events = [];
  function job(name, ms, shouldFail) {
    return function () {
      return new Promise(function (resolve, reject) {
        events.push(name + ":start");
        setTimeout(function () {
          events.push(name + ":end");
          shouldFail ? reject(new Error(name)) : resolve(name);
        }, ms);
      });
    };
  }

  // A slow run first, then a fast one: without a queue the fast one finishes
  // inside the slow one, which is exactly the failure that was observed.
  const runs = [
    queueAgentRun(job("chat", 40)),
    queueAgentRun(job("plan", 5)),
    queueAgentRun(job("boom", 5, true)),
    queueAgentRun(job("after", 5)),
  ];
  await Promise.all(runs.map(function (p) { return p.catch(function () {}); }));

  let depth = 0;
  let overlapped = false;
  events.forEach(function (e) {
    if (e.indexOf(":start") !== -1) { depth++; if (depth > 1) overlapped = true; } else depth--;
  });

  check("agent runs never overlap", !overlapped, events.join(" "));
  check("runs execute in the order they were queued",
    events.join(",") === "chat:start,chat:end,plan:start,plan:end,boom:start,boom:end,after:start,after:end");
  // One rejected run must not wedge the queue for everything behind it.
  check("a failed run does not stall the queue", events.indexOf("after:end") !== -1);

  // --- session handoff -----------------------------------------------------
  // Mirrors end-session / start-session in desktop/main.js. end-session used to
  // null the handle and return at once, so starting another build immediately
  // spawned a second agent onto a Chromium profile the first still held. The
  // dying session's in-flight step then failed with "Target page, context or
  // browser has been closed" and the new one reported "no session".
  function fakeProc(name, exitAfterMs, log) {
    const handlers = {};
    const proc = {
      name: name,
      once: function (e, f) { (handlers[e] = handlers[e] || []).push(f); },
      stdin: {
        writable: true,
        write: function () {
          setTimeout(function () {
            log.push(name + ":exited");
            (handlers.close || []).forEach(function (f) { f(); });
          }, exitAfterMs);
        },
      },
      kill: function () {},
    };
    return proc;
  }

  async function handoff() {
    const log = [];
    let sessionProc = fakeProc("A", 40, log);
    let sessionClosing = null;

    // end-session
    const proc = sessionProc;
    sessionProc = null;
    sessionClosing = new Promise(function (resolve) {
      let done = false;
      const finish = function () { if (done) return; done = true; sessionClosing = null; resolve(); };
      proc.once("close", finish);
      try { proc.stdin.write("{}"); } catch (e) {}
      setTimeout(finish, 15000);
    });

    // start-session, immediately after
    if (sessionClosing) await sessionClosing;
    log.push("B:spawns");
    sessionProc = fakeProc("B", 10, log);
    return log;
  }

  const order = await handoff();
  check("a new session waits for the old one to exit",
    order.join(",") === "A:exited,B:spawns", order.join(","));

  // The old close handler nulled the handle unconditionally, so a late close
  // from a replaced session wiped the live one.
  let live = { id: "B" };
  const stale = { id: "A" };
  (function onCloseOfStale(p) { if (live === p) live = null; })(stale);
  check("a stale session closing does not clear its replacement", live !== null);
}

function testProviderGating() {
  section("provider gating");
  const { ProviderRegistry } = require(path.join(DIST, "providers/provider-registry.js"));

  const reg = new ProviderRegistry();
  const quiet = console.log;
  console.log = function () {};   // loadProviders narrates every file it reads
  reg.loadProviders();
  console.log = quiet;

  const listed = reg.listProviders();
  const gated = listed.filter(function (p) { return p.comingSoon; }).map(function (p) { return p.id; });

  // Shown, not hidden: a provider people should know is planned rather than
  // one that silently does not exist.
  check("gated providers are still listed for the settings panel", gated.length >= 1, gated.join(","));
  check("at least one provider is actually usable",
    listed.some(function (p) { return !p.comingSoon; }));

  // The part that matters: nothing gated can reach a browser, whatever asked.
  for (const p of listed) {
    if (!p.comingSoon) continue;
    let refused = false;
    try { reg.getUsableProvider(p.id); } catch (e) { refused = /coming soon/.test(e.message); }
    check("a gated provider cannot be driven: " + p.id, refused);
  }

  const usable = listed.find(function (p) { return !p.comingSoon; });
  check("an available provider still resolves",
    reg.getUsableProvider(usable.id) && reg.getUsableProvider(usable.id).id === usable.id);

  // Absent and gated are different answers, and callers distinguish them.
  check("an unknown provider is undefined rather than a throw",
    reg.getUsableProvider("no-such-provider-xyz") === undefined);

  // Every gated provider must say why, next to the selectors someone will need
  // in order to finish it. A bare flag becomes a mystery in a month.
  const fs2 = require("fs");
  const dir = path.join(__dirname, "..", "config", "providers");
  for (const id of gated) {
    const cfg = JSON.parse(fs2.readFileSync(path.join(dir, id + ".json"), "utf-8"));
    check("gated provider records why: " + id,
      typeof cfg._comingSoonReason === "string" && cfg._comingSoonReason.length > 40);
  }
}

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
  // The syntax pass is unchanged. Python now gets a mypy check on top of it,
  // which is why this asserts the syntax commands rather than every command -
  // see "type checking, not just parsing" for the addition itself.
  check("Python and JS still get their syntax checks",
    commands(planChecks(["a.py", "b.js"], [], all, TMP)
      .filter(function (c) { return c.kind !== "types"; })).join(" ") ===
      'python -m py_compile "a.py" node --check "b.js"');
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
      'python -m py_compile "a.py"');
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

  // --- the wider language set. Without these a build in any of them reports
  // success on code nobody compiled.
  check("go is checked per file",
    commands(planChecks(["main.go"], [], all, TMP))[0] === 'gofmt -e "main.go"');
  check("a go module is one build",
    commands(planChecks(["main.go", "util.go"], ["go.mod"], all, TMP)).join() === "go build ./...");
  check("ruby is checked per file",
    commands(planChecks(["app.rb"], [], all, TMP))[0] === 'ruby -c "app.rb"');
  check("php is checked per file",
    commands(planChecks(["index.php"], [], all, TMP))[0] === 'php -l "index.php"');
  check("shell is checked per file",
    commands(planChecks(["deploy.sh"], [], all, TMP))[0] === 'bash -n "deploy.sh"');

  // TypeScript has Rust's problem: a file importing another fails alone, so a
  // tsconfig claims the language and yields one project check.
  check("a tsconfig collapses typescript into one check",
    commands(planChecks(["src/a.ts", "src/b.ts"], ["tsconfig.json"], all, TMP)).join() === "tsc --noEmit");
  check("standalone typescript is checked per file",
    planChecks(["scratch.ts", "other.ts"], [], all, TMP).length === 2);
  check("tsx counts as typescript",
    commands(planChecks(["App.tsx"], ["tsconfig.json"], all, TMP)).join() === "tsc --noEmit");

  // A .csproj is matched by suffix, not by an exact filename - the project file
  // is named after the project.
  check("a csproj is found whatever it is called",
    commands(planChecks(["Program.cs"], ["MyApp.csproj"], all, TMP)).join() === "dotnet build");
  check("c# without a project file is not guessed at",
    planChecks(["Program.cs"], [], all, TMP).length === 0);

  // A manifest for one language still must not silence another.
  const polyglot = planChecks(["main.go", "app.rb"], ["go.mod"], all, TMP);
  check("a go module does not suppress ruby", polyglot.length === 2);
  check("and ruby is still per file",
    commands(polyglot).indexOf('ruby -c "app.rb"') !== -1);

  // Missing tools still skip rather than emit a command that cannot succeed.
  check("no go toolchain means no go check",
    planChecks(["main.go"], ["go.mod"], only(["python"]), TMP).length === 0);
}

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

  // --- the wider language set
  check("a go module runs with go run", detectEntrypoint(["go.mod", "main.go"], null) === "go run .");
  check("a lone main.go runs too", detectEntrypoint(["main.go"], null) === "go run main.go");
  check("a csproj uses dotnet run", detectEntrypoint(["MyApp.csproj"], null) === "dotnet run");
  check("ruby runs main.rb", detectEntrypoint(["main.rb"], null) === "ruby main.rb");
  check("ruby app.rb too", detectEntrypoint(["app.rb"], null) === "ruby app.rb");
  check("php serves the directory", /php -S/.test(detectEntrypoint(["index.php"], null) || ""));

  // A static frontend has nothing to execute, so it gets served rather than run
  // - opening a file:// page is not the same as the site working.
  check("a static site is served",
    /http\.server|npx serve/.test(detectEntrypoint(["index.html", "style.css"], null) || ""),
    String(detectEntrypoint(["index.html", "style.css"], null)));
  check("but a real entry point beats a static page",
    detectEntrypoint(["index.html", "main.py"], null) === "python3 main.py");

  // A library genuinely has no entry point, and saying so is the honest answer.
  check("a library yields null", detectEntrypoint(["src/mylib/__init__.py", "setup.py"], null) === null);

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

    // Chat, plan and build all write the one conversation. "worker" is the
    // only kind that does not: it is the read-only account probe, and it must
    // never adopt or overwrite the conversation it is reporting on.
    const readStore = () => JSON.parse(fs.readFileSync(storeFile, "utf-8"));
    c.setWorkspace("/my/ws");
    c.setThreadKind("chat");
    c.setChatUrlForWorkspace("/my/ws", "https://example.test/a/chat-1");
    check("chat kind writes activeChat", readStore()["/my/ws"].activeChat === "https://example.test/a/chat-1");
    // Read from cfg rather than hardcoded: this is what stops a resumed thread
    // being handed to a provider it does not belong to.
    check("the thread records which provider owns it",
      readStore()["/my/ws"].activeChatProvider === cfg.id, JSON.stringify(readStore()["/my/ws"]));

    c.setThreadKind("worker");
    c.setChatUrlForWorkspace("/my/ws", "https://example.test/c/probe-1");
    check("a worker never overwrites the conversation",
      readStore()["/my/ws"].activeChat === "https://example.test/a/chat-1", readStore()["/my/ws"].activeChat);

    c.setThreadKind("chat");
    c.resetBuildRunForWorkspace();
    check("starting a build preserves the conversation",
      readStore()["/my/ws"].activeChat === "https://example.test/a/chat-1");
  } finally {
    await c.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testApplyFollowUp() {
  section("a failed patch is retried with a different tactic");
  const { buildApplyFollowUp } = require(path.join(DIST, "follow-up.js"));

  // The case from the 11 August run: six of seven search blocks missed. The
  // step recovered only because the generic follow-up happened to ask for
  // whole files. This asks deliberately.
  const missed = buildApplyFollowUp([
    "Failed to apply src/storage.py: Search block not found in src/storage.py",
    "Failed to apply src/cli/parser.py: Search block not found in src/cli/parser.py",
  ].join("\n"), ["src/storage.py", "src/cli/parser.py", "main.py"]);

  check("it names both failed files",
    /src\/storage\.py/.test(missed) && /src\/cli\/parser\.py/.test(missed), missed);
  check("it asks for a whole-file overwrite", /mode "overwrite"/.test(missed), missed);
  check("it says not to retry search_replace",
    /[Dd]o not use search_replace/.test(missed), missed);
  check("it says the blocks did not match", /did not match/i.test(missed), missed);
  check("it carries the raw errors through", /Search block not found/.test(missed), missed);
  check("it lists the project's other files", /main\.py/.test(missed), missed);

  // The generic verification follow-up tells the model its code failed under
  // test and to fix the root cause. Nothing ran here, so that wording would
  // send it rewriting working logic over an addressing mistake.
  check("it does not claim a test failed", !/failed when tested|root cause/i.test(missed), missed);

  const abbrev = buildApplyFollowUp(
    "Failed to apply config.py: Refusing to overwrite config.py with an abbreviated file: it contains an \"unchanged\" placeholder", []);
  check("an abbreviated file gets its own reason", /placeholder/i.test(abbrev), abbrev);
  check("and is still asked for in full", /COMPLETE/.test(abbrev), abbrev);
  check("with no file list when nothing is known", !/Existing files in this project/.test(abbrev), abbrev);

  // An escape attempt is the one case where resending the same content is
  // right - only the path was wrong, so asking for an overwrite would be
  // answering the wrong question.
  const outside = buildApplyFollowUp(
    "Failed to apply /etc/passwd: Security Error: Attempted to write outside workspace: /etc/passwd", ["app.py"]);
  check("a path escape is explained as a path problem",
    /outside the project directory/.test(outside), outside);
  check("and asks for relative paths", /relative to the project root/.test(outside), outside);
  check("rather than for another overwrite", !/mode "overwrite"/.test(outside), outside);

  // Unparseable errors must still produce a usable instruction rather than
  // "these files: " with nothing after it.
  const vague = buildApplyFollowUp("something went wrong", ["a.py"]);
  check("an unrecognised error still asks for whole files",
    /the files for this step/.test(vague) && /mode "overwrite"/.test(vague), vague);
  check("empty input does not throw",
    typeof buildApplyFollowUp("", []) === "string" && buildApplyFollowUp(null, []).length > 0);

  // Long error dumps are truncated so the retry prompt stays smaller than the
  // reply it is asking for.
  const flood = buildApplyFollowUp("Failed to apply x.py: " + "e".repeat(9000), []);
  check("a huge error dump is capped", flood.length < 2500, String(flood.length));
}

function testSchedulerGraph() {
  section("a plan's declared dependencies reach the scheduler");
  const sched = require(path.join(__dirname, "..", "..", "desktop", "scheduler.js"));

  function withDeps(list) { return list.map(function (d) { return { dependsOn: d }; }); }

  // The regression this exists for. The renderer built its step list without
  // dependsOn, so every plan looked undeclared, became a chain, and one
  // failure blocked everything behind it.
  const declared = sched.graphFor(withDeps([[], [0], [], [1, 2]]));
  check("declared dependencies are used", declared.declared === true);
  check("and kept exactly", JSON.stringify(declared.graph) === JSON.stringify([[], [0], [], [1, 2]]));
  check("no reason is reported for a good graph", !declared.reason);

  const none = sched.graphFor([{}, {}, {}]);
  check("an undeclared plan is still a chain",
    JSON.stringify(none.graph) === JSON.stringify([[], [0], [1]]));
  check("and says it was not declared", none.declared === false);
  check("an empty plan yields an empty graph", JSON.stringify(sched.graphFor([]).graph) === "[]");
  check("a null plan does not throw", JSON.stringify(sched.graphFor(null).graph) === "[]");

  // An empty list is an answer, not a silence: step 1 declaring [] means it
  // genuinely waits for nothing.
  const empties = sched.graphFor(withDeps([[], []]));
  check("an all-empty declaration is honoured, not treated as absent",
    empties.declared === true && JSON.stringify(empties.graph) === JSON.stringify([[], []]));

  // Anything unschedulable falls back to the chain rather than hanging the
  // build with nothing running and nothing able to start.
  const cyclic = sched.graphFor(withDeps([[1], [0]]));
  check("a cycle falls back to the chain",
    JSON.stringify(cyclic.graph) === JSON.stringify([[], [0]]) && cyclic.declared === false);
  check("and says why", /later/.test(cyclic.reason || ""), cyclic.reason);
  check("a self-reference falls back", sched.graphFor(withDeps([[], [1]])).declared === false);
  check("an out-of-range index falls back", sched.graphFor(withDeps([[], [9]])).declared === false);
  check("a negative index falls back", sched.graphFor(withDeps([[], [-1]])).declared === false);
  check("a non-number falls back", sched.graphFor(withDeps([[], ["a"]])).declared === false);
  check("a fractional index falls back", sched.graphFor(withDeps([[], [0.5]])).declared === false);
  check("the reason names a human step number, not an index",
    /step 2/.test(sched.graphFor(withDeps([[], [9]])).reason || ""),
    sched.graphFor(withDeps([[], [9]])).reason);

  // The point of all of it: an unrelated step must survive a failure.
  const graph = sched.graphFor(withDeps([[], [0], [], [2]])).graph;
  const blocked = sched.blockedBy(graph, [0]);
  check("a failure blocks only what depended on it",
    JSON.stringify(blocked) === JSON.stringify([1]), JSON.stringify(blocked));
  const state = { completed: [], failed: [0], blocked: [1], skipped: [], running: [] };
  check("an independent step is still runnable after that failure",
    JSON.stringify(sched.runnableSteps(graph, state, 1)) === JSON.stringify([2]));

  // And under the old chain it would not have been - the assertion that this
  // change is doing something.
  const chain = sched.graphFor([{}, {}, {}, {}]).graph;
  check("under a chain that same failure blocks everything after it",
    JSON.stringify(sched.blockedBy(chain, [0])) === JSON.stringify([1, 2, 3]));
}

function testBuildState() {
  section("a build survives closing the app");
  const B = require(path.join(DIST, "build-state.js"));

  const plan = { summary: "Flask habit tracker", runCommand: "python app.py" };
  const steps = [
    { title: "Scaffold", detail: "make dirs", files: ["app.py"], dependsOn: [], status: "done" },
    { title: "Schema", detail: "sqlite", files: ["db.py"], dependsOn: [0], status: "failed" },
    { title: "Routes", detail: "crud", files: ["routes.py"], dependsOn: [0], status: "pending" },
  ];

  const state = B.serialiseBuildState(plan, steps, { provider: "deepseek", now: "2026-08-11T10:00:00.000Z" });
  check("the summary is kept", state.summary === "Flask habit tracker");
  check("so is the run command", state.runCommand === "python app.py");
  check("and the provider", state.provider === "deepseek");
  check("startedAt defaults to now", state.startedAt === "2026-08-11T10:00:00.000Z");

  // The regression that ate the last feature: dependsOn dropped in a map.
  check("dependsOn survives serialising",
    JSON.stringify(state.steps.map(function (s) { return s.dependsOn; })) === JSON.stringify([[], [0], [0]]));

  const back = B.parseBuildState(JSON.stringify(state));
  check("it round-trips", JSON.stringify(back.steps) === JSON.stringify(state.steps), JSON.stringify(back.steps));
  check("statuses come back", back.steps[0].status === "done" && back.steps[1].status === "failed");

  // A step that was running when the app closed is not running now. Restoring
  // it as running would seed the scheduler with a step it waits on forever.
  const mid = B.parseBuildState(JSON.stringify(
    B.serialiseBuildState(plan, [{ title: "x", detail: "", files: [], status: "running" }], {})));
  check("a step caught mid-run comes back pending", mid.steps[0].status === "pending");

  // Anything unreadable means "no build here", never a crash: refusing to open
  // a workspace because a state file is malformed is worse than no resume.
  check("garbage is no build", B.parseBuildState("{{{") === null);
  check("null is no build", B.parseBuildState(null) === null);
  check("an array is no build", B.parseBuildState("[1,2]") === null);
  check("a wrong version is no build", B.parseBuildState('{"version":99,"steps":[{}]}') === null);
  check("no steps is no build", B.parseBuildState('{"version":1,"steps":[]}') === null);
  check("a non-object step is no build", B.parseBuildState('{"version":1,"steps":[5]}') === null);
  check("an unknown status reads as pending",
    B.parseBuildState('{"version":1,"steps":[{"status":"exploded"}]}').steps[0].status === "pending");
  check("a missing files array becomes empty",
    JSON.stringify(B.parseBuildState('{"version":1,"steps":[{"title":"a"}]}').steps[0].files) === "[]");
  check("a non-string in files is dropped",
    JSON.stringify(B.parseBuildState('{"version":1,"steps":[{"files":["a",7,null]}]}').steps[0].files) === '["a"]');

  const prog = B.describeProgress(back);
  check("progress counts done steps", prog.done === 1 && prog.total === 3);
  check("and knows it is unfinished", prog.unfinished === true);
  // A skipped step is finished as far as the user is concerned - the scheduler
  // already treats it as a satisfied dependency.
  const allDone = B.parseBuildState(JSON.stringify(B.serialiseBuildState(plan,
    [{ title: "a", status: "done" }, { title: "b", status: "skipped" }], {})));
  check("a skipped step counts as finished", B.describeProgress(allDone).unfinished === false);
  check("no state is not unfinished", B.describeProgress(null).unfinished === false);

  // Where it goes. The workspace, beside closeni.run.json - so the answer
  // survives this install rather than living in app state.

  // Timing round-trips with the rest of a build, and is re-validated on read:
  // this is JSON on disk a person can edit, and a NaN reaching formatDuration
  // would print "NaNms" in the report.
  const timed = B.serialiseBuildState(plan,
    [{ title: "a", status: "done", timing: { totalMs: 104100, phases: { writing: 78000, checking: 23400 } } }], {});
  check("timing is stored", timed.steps[0].timing.totalMs === 104100);
  check("and its phases", timed.steps[0].timing.phases.writing === 78000);
  const readBack = B.parseBuildState(JSON.stringify(timed));
  check("timing survives a restart", readBack.steps[0].timing.phases.checking === 23400);
  check("a NaN total is dropped",
    B.parseBuildState('{"version":1,"steps":[{"timing":{"totalMs":"soon"}}]}').steps[0].timing === undefined);
  check("a negative phase is dropped",
    JSON.stringify(B.parseBuildState('{"version":1,"steps":[{"timing":{"totalMs":5,"phases":{"a":-3,"b":7}}}]}')
      .steps[0].timing.phases) === '{"b":7}');
  check("a step with no timing stays without one",
    B.parseBuildState('{"version":1,"steps":[{"title":"a"}]}').steps[0].timing === undefined);

  check("it is stored in the workspace", B.BUILD_STATE_DIR === ".closeni" && B.BUILD_STATE_NAME === "build.json");
}

function testCheckpoints() {
  section("undoing a step");
  const C = require(path.join(DIST, "checkpoint.js"));

  // A step that created streaks.py and overwrote app.py.
  let cp4 = C.mergeCheckpoint(null, 3, { "streaks.py": null, "app.py": "APP v3" }, { at: "T1" });
  check("a created file records no prior", cp4.files["streaks.py"].prior === null);
  check("an overwritten one records its contents", cp4.files["app.py"].prior === "APP v3");

  // The repair loop applies again. The second apply sees app.py as the FIRST
  // one left it - recording that would restore the middle of the step.
  cp4 = C.mergeCheckpoint(cp4, 3, { "app.py": "APP v4-broken", "util.py": null });
  check("the first prior wins within a step", cp4.files["app.py"].prior === "APP v3");
  check("a file first seen in the retry is still recorded", cp4.files["util.py"].prior === null);
  check("the step number is kept", cp4.step === 3);

  const sealed4 = C.sealCheckpoint(cp4, { "app.py": "APP v4", "streaks.py": "S", "util.py": "U" });
  check("sealing records what the step left", sealed4.files["app.py"].after === C.hash("APP v4"));
  check("and keeps the prior", sealed4.files["app.py"].prior === "APP v3");

  const sealed5 = C.sealCheckpoint(
    C.mergeCheckpoint(null, 4, { "app.py": "APP v4", "routes.py": null }, { at: "T2" }),
    { "app.py": "APP v5", "routes.py": "R" });

  // Rolling back to before step 4 (index 3) undoes 4 and 5 together.
  const plan = C.planRollback([sealed4, sealed5], 3,
    { "app.py": "APP v5", "streaks.py": "S", "util.py": "U", "routes.py": "R" });

  check("both steps are undone", JSON.stringify(plan.steps) === JSON.stringify([3, 4]));
  // Step 5 also touched app.py, but step 4 saw it first - and step 4's prior is
  // the state before the rollback target, which is the whole point.
  check("a file touched twice restores to the earliest prior", plan.restore["app.py"] === "APP v3");
  check("files created by the undone steps are removed",
    JSON.stringify(plan.remove.sort()) === JSON.stringify(["routes.py", "streaks.py", "util.py"]));
  check("nothing drifted when the files are as the build left them",
    plan.drifted.length === 0, JSON.stringify(plan.drifted));

  // A hand edit since the build wrote it must be named, not silently lost.
  const edited = C.planRollback([sealed4, sealed5], 3,
    { "app.py": "APP v5 + my fix", "streaks.py": "S", "util.py": "U", "routes.py": "R" });
  check("an edit made since is reported as drift",
    JSON.stringify(edited.drifted) === JSON.stringify(["app.py"]), JSON.stringify(edited.drifted));
  check("drift is judged against the LAST step to write the file",
    edited.restore["app.py"] === "APP v3");
  const deleted = C.planRollback([sealed4, sealed5], 3,
    { "app.py": "APP v5", "streaks.py": null, "util.py": "U", "routes.py": "R" });
  check("a file deleted by hand also counts as drift",
    deleted.drifted.indexOf("streaks.py") !== -1, JSON.stringify(deleted.drifted));
  // Claiming drift over a file nobody looked at would block a good rollback.
  const unknown = C.planRollback([sealed4, sealed5], 3, {});
  check("a file the caller did not read is not called drifted", unknown.drifted.length === 0);

  // Rolling back to a later step leaves the earlier ones alone.
  const later = C.planRollback([sealed4, sealed5], 4, { "app.py": "APP v5", "routes.py": "R" });
  check("only steps at or after the target are undone",
    JSON.stringify(later.steps) === JSON.stringify([4]));
  check("and the file goes back to what step 5 found", later.restore["app.py"] === "APP v4");
  check("step 4's creations are untouched", later.remove.indexOf("streaks.py") === -1);

  // A file too large to have been stored is admitted to, not half-restored.
  const big = C.mergeCheckpoint(null, 0, { "data.bin": "x".repeat(C.MAX_PRIOR_BYTES + 1) });
  check("an oversized prior is not stored", big.files["data.bin"].prior === null);
  check("and is flagged", big.files["data.bin"].tooLarge === true);
  const bigPlan = C.planRollback([C.sealCheckpoint(big, { "data.bin": "y" })], 0, { "data.bin": "y" });
  check("it is reported as unrestorable",
    JSON.stringify(bigPlan.unrestorable) === JSON.stringify(["data.bin"]));
  check("and is neither restored nor removed",
    !bigPlan.restore["data.bin"] && bigPlan.remove.indexOf("data.bin") === -1);

  // Reading back.
  const round = C.parseCheckpoint(JSON.stringify(sealed4));
  check("a checkpoint round-trips", JSON.stringify(round.files) === JSON.stringify(sealed4.files));
  check("garbage is no checkpoint", C.parseCheckpoint("{{") === null);
  check("a wrong version is no checkpoint", C.parseCheckpoint('{"version":9,"step":0,"files":{}}') === null);
  check("a missing step number is no checkpoint", C.parseCheckpoint('{"version":1,"files":{}}') === null);
  check("a negative step is no checkpoint", C.parseCheckpoint('{"version":1,"step":-2,"files":{}}') === null);
  check("no checkpoints means nothing to undo", C.planRollback([], 0, {}).steps.length === 0);
  check("the file name sorts in step order",
    C.checkpointName(0) === "step-001.json" && C.checkpointName(11) === "step-012.json");
}

function testRollbackOnDisk() {
  section("a rollback returns a real workspace to where it was");
  const C = require(path.join(DIST, "checkpoint.js"));
  const { applyPatch } = require(path.join(DIST, "patch/patch-applier.js"));

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-rollback-"));
  fs.writeFileSync(path.join(ws, "app.py"), "print('v3')\n");

  function priors(paths) {
    const o = {};
    paths.forEach(function (r) {
      try { o[r] = fs.readFileSync(path.join(ws, r), "utf-8"); } catch (e) { o[r] = null; }
    });
    return o;
  }
  function afters(cp) { return priors(Object.keys(cp.files)); }

  // Step 4 rewrites app.py and adds streaks.py.
  const cp3 = C.mergeCheckpoint(null, 3, priors(["app.py", "streaks.py"]));
  applyPatch(ws, { changes: [
    { filePath: "app.py", mode: "overwrite", newContent: "print('v4')\n" },
    { filePath: "streaks.py", mode: "create", newContent: "S=1\n" }] });
  const s3 = C.sealCheckpoint(cp3, afters(cp3));

  // Step 5 rewrites app.py again and adds routes.py.
  const cp4 = C.mergeCheckpoint(null, 4, priors(["app.py", "routes.py"]));
  applyPatch(ws, { changes: [
    { filePath: "app.py", mode: "overwrite", newContent: "print('v5')\n" },
    { filePath: "routes.py", mode: "create", newContent: "R=1\n" }] });
  const s4 = C.sealCheckpoint(cp4, afters(cp4));

  const plan = C.planRollback([s3, s4], 3, priors(["app.py", "streaks.py", "routes.py"]));
  check("the plan sees no drift on an untouched workspace", plan.drifted.length === 0, JSON.stringify(plan.drifted));

  Object.keys(plan.restore).forEach(function (r) { fs.writeFileSync(path.join(ws, r), plan.restore[r]); });
  plan.remove.forEach(function (r) { fs.rmSync(path.join(ws, r), { force: true }); });

  check("the overwritten file is back to before step 4",
    fs.readFileSync(path.join(ws, "app.py"), "utf8") === "print('v3')\n",
    fs.readFileSync(path.join(ws, "app.py"), "utf8"));
  check("the file step 4 created is gone", !fs.existsSync(path.join(ws, "streaks.py")));
  check("so is the one step 5 created", !fs.existsSync(path.join(ws, "routes.py")));

  fs.rmSync(ws, { recursive: true, force: true });
}

function testContextBudget() {
  section("a build moves to a new conversation before it outgrows one");
  const B = require(path.join(DIST, "context-budget.js"));

  check("a new thread starts empty", B.emptySize().chars === 0 && B.emptySize().turns === 0);

  let size = B.addTurn(B.emptySize(), 1000, 4000);
  check("a turn counts both directions", size.chars === 5000 && size.turns === 1);
  size = B.addTurn(size, 500, 2500);
  check("turns accumulate", size.chars === 8000 && size.turns === 2);
  check("a reply that could not be read still counts its prompt",
    B.addTurn(B.emptySize(), 900, 0).chars === 900);
  check("negative and NaN inputs do not corrupt the count",
    B.addTurn(B.emptySize(), -5, NaN).chars === 0);

  const budget = 100000;
  check("a half-full thread keeps going", !B.shouldRollOver({ chars: 50000, turns: 5 }, budget));
  check("one at the threshold rolls over", B.shouldRollOver({ chars: 80000, turns: 9 }, budget));
  check("and just under it does not", !B.shouldRollOver({ chars: 79999, turns: 9 }, budget));

  // The decision is about whether the COMING exchange fits. A thread at 70%
  // about to be sent a large prompt should move now, while it is free to.
  check("a large next prompt brings the rollover forward",
    B.shouldRollOver({ chars: 70000, turns: 8 }, budget, 15000));
  check("a small one does not", !B.shouldRollOver({ chars: 70000, turns: 8 }, budget, 500));

  // Rolling over a thread that has said nothing would loop: there is nowhere
  // cheaper to send the prompt than the empty conversation it is already in.
  check("a fresh thread never rolls over, however large the prompt",
    !B.shouldRollOver({ chars: 0, turns: 0 }, budget, 10 * 1000 * 1000));

  check("a missing budget falls back to the default",
    B.budgetFor(undefined) === B.DEFAULT_BUDGET_CHARS && B.budgetFor(0) === B.DEFAULT_BUDGET_CHARS);
  check("a configured budget is used", B.budgetFor(42000) === 42000);
  check("a nonsense budget falls back", B.budgetFor("lots") === B.DEFAULT_BUDGET_CHARS);

  // Storage round-trips through JSON, so anything can come back.
  check("a malformed stored size reads as a new thread",
    B.readSize(null).chars === 0 && B.readSize("x").turns === 0 &&
    B.readSize({ chars: "many" }).chars === 0);
  check("a valid stored size survives", B.readSize({ chars: 12, turns: 3 }).chars === 12);

  check("the description is in percent, not raw characters",
    /50% of the conversation budget/.test(B.describeSize({ chars: 50000, turns: 4 }, budget)),
    B.describeSize({ chars: 50000, turns: 4 }, budget));
  check("one turn is not pluralised", /^1 turn,/.test(B.describeSize({ chars: 1, turns: 1 }, budget)));

  // Every provider config has to carry a budget, or the one that does not gets
  // the default silently and nobody finds out until a build fifteen steps in.
  const dir = path.join(__dirname, "..", "config", "providers");
  fs.readdirSync(dir).filter(function (f) { return f.endsWith(".json"); }).forEach(function (f) {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    check(f + " declares a context budget", typeof cfg.contextBudgetChars === "number" && cfg.contextBudgetChars > 0);
  });
}

function testSelectorHealth() {
  section("checking a provider's selectors still match");
  const H = require(path.join(DIST, "health/selector-health.js"));

  const full = { chatInput: 1, sendButton: 1, assistantMessage: 14, copyButton: 6, stopButton: 0 };
  const healthy = H.judgeSelectors(full, { conversationResumed: true });
  check("a matching provider passes", healthy.ok === true, healthy.summary);
  check("and says how many were checked", /selectors checked/.test(healthy.summary), healthy.summary);

  function find(rep, sel) { return rep.findings.filter(function (f) { return f.selector === sel; })[0]; }

  // The whole point. assistantMessage matching nothing in a conversation that
  // HAS replies is the frozen-selector bug that made a build wait out 300s.
  const frozen = H.judgeSelectors(Object.assign({}, full, { assistantMessage: 0 }), { conversationResumed: true });
  check("a dead assistant selector is critical", find(frozen, "assistantMessage").health === "critical");
  check("and fails the report", frozen.ok === false);
  check("and the summary names it", /assistantMessage/.test(frozen.summary), frozen.summary);

  // ...but the SAME zero on a fresh page proves nothing, because an empty chat
  // has no replies. Calling that a failure is how a check gets ignored.
  const fresh = H.judgeSelectors(Object.assign({}, full, { assistantMessage: 0, copyButton: 0 }), { conversationResumed: false });
  check("the same zero on a fresh page is skipped, not failed",
    find(fresh, "assistantMessage").health === "skipped");
  check("a fresh page still passes overall", fresh.ok === true);
  check("and the summary admits what it could not check",
    /read path could not be checked/.test(fresh.summary), fresh.summary);

  // The composer is the one thing nothing works without.
  const noInput = H.judgeSelectors(Object.assign({}, full, { chatInput: 0 }), { conversationResumed: true });
  check("a missing composer is critical", find(noInput, "chatInput").health === "critical");
  check("and fails the report", noInput.ok === false);

  // A missing send button is survivable - sendPrompt presses Enter instead.
  const noSend = H.judgeSelectors(Object.assign({}, full, { sendButton: 0 }), { conversationResumed: true });
  check("a missing send button is only degraded", find(noSend, "sendButton").health === "degraded");
  check("so the report still passes", noSend.ok === true);
  check("and the note says what happens instead", /Enter/.test(find(noSend, "sendButton").note));

  // Copy is an optimisation over a working fallback.
  const noCopy = H.judgeSelectors(Object.assign({}, full, { copyButton: 0 }), { conversationResumed: true });
  check("a missing copy button is degraded, not critical", find(noCopy, "copyButton").health === "degraded");
  check("and it passes", noCopy.ok === true);

  // Never claimable from an idle page, and the report must say so rather than
  // quietly omitting it - silence reads as "verified".
  check("the stop button is always reported as unknowable when idle",
    find(healthy, "stopButton").health === "skipped");
  check("and explains why", /while a reply is generating/.test(find(healthy, "stopButton").note));

  // A selector this provider does not configure is not its failure.
  const unconfigured = H.judgeSelectors({ chatInput: 1, sendButton: 1 },
    { conversationResumed: true, configured: { assistantMessage: false, copyButton: false } });
  check("an unconfigured selector is skipped", find(unconfigured, "copyButton").health === "skipped");
  check("and does not fail the provider", unconfigured.ok === true);

  // Nothing at all must not throw, and must not read as healthy.
  const empty = H.judgeSelectors({}, { conversationResumed: false });
  check("empty counts do not throw and do not pass", empty.ok === false);
  check("undefined context does not throw", typeof H.judgeSelectors({}, {}).summary === "string");
  check("negative counts are treated as zero",
    H.judgeSelectors({ chatInput: -3 }, { conversationResumed: true }).ok === false);
}

function testTypeChecks() {
  section("type checking, not just parsing");
  const CP = require(path.join(DIST, "verification/check-planner.js"));

  const all = function (t) { return t; };            // everything installed
  const none = function () { return null; };          // nothing installed
  const noMypy = function (t) { return t === "mypy" ? null : t; };

  function plan(files, roots, resolve) {
    return CP.planChecks(files, roots || [], resolve || all, "/tmp/checks");
  }
  function of(checks, kind) { return checks.filter(function (c) { return c.kind === kind; }); }

  // Python got a syntax check and nothing else. That is the gap: py_compile
  // proves a file parses and says nothing about whether it is right.
  const py = plan(["app.py"], []);
  check("python still gets its syntax check", of(py, "syntax").length === 1);
  check("and now a type check as well", of(py, "types").length === 1);
  check("the type check is mypy", /mypy/.test(of(py, "types")[0].command), of(py, "types")[0].command);

  const cmd = of(py, "types")[0].command;
  // Every flag here prevents a specific false failure. Without the first, a
  // Flask project fails EVERY step on a missing type stub for flask.
  check("third-party imports without stubs cannot fail a step",
    /--ignore-missing-imports/.test(cmd), cmd);
  check("errors in files this step did not write are not reported",
    /--follow-imports=silent/.test(cmd), cmd);
  check("the cache is kept out of the user's project",
    /--cache-dir "\/tmp\/checks\/mypy"/.test(cmd), cmd);
  check("the file being checked is quoted", /"app\.py"/.test(cmd), cmd);

  // Absent means skipped, never failed: mypy is not installed on most machines.
  const without = plan(["app.py"], [], noMypy);
  check("no mypy means no type check", of(without, "types").length === 0);
  check("but the syntax check still runs", of(without, "syntax").length === 1);
  check("nothing installed means no checks at all", plan(["app.py"], [], none).length === 0);

  // Syntax before types. A file that does not parse makes mypy complain about
  // the parse, and reporting that as a type failure sends the model hunting a
  // bug that is really a typo.
  const order = plan(["app.py"], []);
  check("the syntax check is ordered before the type check",
    order.findIndex(function (c) { return c.kind === "syntax"; }) <
    order.findIndex(function (c) { return c.kind === "types"; }));

  // Languages that already have real type checking gain nothing here.
  check("typescript adds no second check", of(plan(["a.ts"], []), "types").length === 0);
  check("rust adds no second check", of(plan(["a.rs"], ["Cargo.toml"]), "types").length === 0);
  check("javascript adds no second check", of(plan(["a.js"], []), "types").length === 0);
  check("a rust crate is still one project check",
    of(plan(["a.rs"], ["Cargo.toml"]), "syntax").length === 1);

  // Every python file gets its own, and non-python files get nothing.
  const many = plan(["a.py", "b.py", "README.md"], []);
  check("each python file is type checked", of(many, "types").length === 2);
  check("a markdown file is not", !/README/.test(JSON.stringify(many)));

  // mypy is slower than py_compile and must not be cut off mid-run.
  check("type checks get a longer timeout than syntax checks",
    of(py, "types")[0].timeoutMs > of(py, "syntax")[0].timeoutMs,
    of(py, "types")[0].timeoutMs + " vs " + of(py, "syntax")[0].timeoutMs);

  // Resolution has to find mypy inside a virtualenv, where the console script
  // is often not on PATH but the module is importable.
  const TC = require(path.join(DIST, "verification/toolchain.js"));
  check("mypy is resolvable as a module, not only as a script",
    (TC.TOOL_CANDIDATES.mypy || []).some(function (c) { return /-m mypy/.test(c); }),
    JSON.stringify(TC.TOOL_CANDIDATES.mypy));
}

function testStepTests() {
  section("a step writes tests, and they are run");
  const B = require(path.join(DIST, "verification/behaviour-checker.js"));
  const F = require(path.join(DIST, "follow-up.js"));

  // The gate that stops every early step failing. A project with a
  // pyproject.toml matches the pytest rule from step one, and pytest with
  // nothing to collect exits non-zero.
  check("no tests yet means the suite is not run", B.hasTestFiles(["app.py", "config.py"]) === false);
  check("a python test file counts", B.hasTestFiles(["app.py", "test_streaks.py"]) === true);
  check("so does the _test suffix", B.hasTestFiles(["streaks_test.py"]) === true);
  check("a tests/ directory counts", B.hasTestFiles(["tests/test_app.py"]) === true);
  check("nested too", B.hasTestFiles(["src/tests/helpers.py"]) === true);
  check("windows separators are handled", B.hasTestFiles(["src\\tests\\a.py"]) === true);
  check("a jest spec counts", B.hasTestFiles(["src/streaks.test.ts"]) === true);
  check("a go test counts", B.hasTestFiles(["streaks_test.go"]) === true);
  check("a java test counts", B.hasTestFiles(["src/StreakTest.java"]) === true);
  check("an rspec file counts", B.hasTestFiles(["spec/streak_spec.rb"]) === true);
  check("a file merely named 'latest.py' does not", B.hasTestFiles(["latest.py"]) === false);
  check("a directory called 'contest' does not", B.hasTestFiles(["contest/app.py"]) === false);
  check("an empty list does not", B.hasTestFiles([]) === false);
  check("nonsense does not throw", B.hasTestFiles([null, 7, ""]) === false);

  // The follow-up is the whole risk of this feature. A model told "your code
  // failed" will bend correct code to satisfy a wrong assertion, and that lands
  // as a green step with the behaviour broken.
  const fu = F.buildTestFollowUp("test_streak_resets: assert 0 == 1", ["streaks.py", "test_streaks.py"]);
  check("the follow-up carries the failure", /assert 0 == 1/.test(fu), fu);
  check("it says either could be wrong", /either could be at fault/i.test(fu), fu);
  check("it offers fixing the code", /fix the code/i.test(fu));
  check("and fixing the test", /fix the test/i.test(fu));
  check("it forbids bending code to a wrong assertion",
    /Do not change working code to satisfy a wrong assertion/i.test(fu), fu);
  check("and forbids gutting the test", /do not weaken\s+or delete a test/i.test(fu), fu);
  check("it does not assert the code is at fault",
    !/Your previous code failed when tested/.test(fu), fu);
  check("it lists the project's files", /streaks\.py/.test(fu));
  check("empty input does not throw", typeof F.buildTestFollowUp(null, []) === "string");
  check("a huge failure dump is capped", F.buildTestFollowUp("e".repeat(9000), []).length < 3000);
}

function testSmokeReport() {
  section("one real round trip, judged strictly");
  const S = require(path.join(DIST, "health/smoke-report.js"));

  const good = {
    sent: true, stopSeen: true, stopConfigured: true,
    streamsOpened: 1, streamsClosed: 1, streamConfigured: true,
    textGrowths: 6, elapsedMs: 6800,
    reply: "```python\nprint('closeni-smoke-ok')\n```",
    expect: "closeni-smoke-ok",
    copied: "print('closeni-smoke-ok')", copyConfigured: true,
  };
  function find(rep, step) { return rep.findings.filter(function (f) { return f.step === step; })[0]; }

  const healthy = S.judgeSmoke(good);
  check("a working provider passes", healthy.ok === true, healthy.summary);
  check("and every check is reported", healthy.findings.length === 7, String(healthy.findings.length));

  // THE bug. The frozen assistant selector did not fail - it passed after 300s
  // watching a node that was the previous answer, so what it read back was that
  // older answer rather than ours. Both halves must be caught.
  const frozen = S.judgeSmoke(Object.assign({}, good, {
    textGrowths: 0, elapsedMs: 301000, reply: "a previous answer, still on screen",
  }));
  check("text that never changed is critical", find(frozen, "assistantMessage").health === "critical");
  check("and the report fails", frozen.ok === false);
  check("300s for one line is also critical", find(frozen, "completion").health === "critical");

  // Found by the first live run against DeepSeek. waitForResponse waits 3s
  // before it starts polling, so a short reply is already complete by the first
  // tick: the length never changes and textGrowths is 0. The reply had been
  // read correctly - the exact token was there and the Copy button returned the
  // exact code - and the report still called the selector critical.
  //
  // Same rule as the passive check: zero is only evidence when something should
  // have happened. Correct content proves the selector read the live answer,
  // however few ticks saw it change.
  const fastReply = S.judgeSmoke(Object.assign({}, good, { textGrowths: 0 }));
  check("a reply that arrived before polling started is not a frozen selector",
    find(fastReply, "assistantMessage").health === "ok", find(fastReply, "assistantMessage").detail);
  check("and the run passes", fastReply.ok === true, fastReply.summary);
  check("the note says why it saw no change",
    /before[\s\S]{0,40}watching|already complete/i.test(find(fastReply, "assistantMessage").detail),
    find(fastReply, "assistantMessage").detail);

  // The real frozen selector is still caught: no change AND the content is not
  // ours, because it is reading somebody else's answer.
  const reallyFrozen = S.judgeSmoke(Object.assign({}, good, { textGrowths: 0, reply: "an older answer" }));
  check("no change plus wrong content is still critical",
    find(reallyFrozen, "assistantMessage").health === "critical");
  check("and still fails the run", reallyFrozen.ok === false);
  const emptyFrozen = S.judgeSmoke(Object.assign({}, good, { textGrowths: 0, reply: "" }));
  check("no change plus an empty reply is critical",
    find(emptyFrozen, "assistantMessage").health === "critical");

  check("the completion note explains it is on the fallback",
    /fallback/.test(find(frozen, "completion").detail), find(frozen, "completion").detail);

  // A slow pass is still a failure - reporting it green is how it survived.
  const slow = S.judgeSmoke(Object.assign({}, good, { elapsedMs: S.COMPLETION_BUDGET_MS + 1 }));
  check("just over the budget fails", slow.ok === false);
  const fast = S.judgeSmoke(Object.assign({}, good, { elapsedMs: S.COMPLETION_BUDGET_MS - 1 }));
  check("just under it passes", fast.ok === true);
  check("never completing is critical",
    S.judgeSmoke(Object.assign({}, good, { elapsedMs: 0 })).ok === false);

  // Content, not presence. Reading the wrong element yields text, just not ours.
  const wrong = S.judgeSmoke(Object.assign({}, good, { reply: "Sure! Here is some Python for you." }));
  check("a reply without the expected answer is critical", find(wrong, "replyContent").health === "critical");
  check("and the report says what came back instead",
    /Sure! Here is some Python/.test(find(wrong, "replyContent").detail));
  check("an empty reply is critical",
    find(S.judgeSmoke(Object.assign({}, good, { reply: "" })), "replyContent").health === "critical");

  // Degraded: a fallback exists, so builds still work and are worse.
  const noStop = S.judgeSmoke(Object.assign({}, good, { stopSeen: false }));
  check("a stop button that never appeared is degraded", find(noStop, "stopButton").health === "degraded");
  check("and does not fail the run", noStop.ok === true);
  const noStream = S.judgeSmoke(Object.assign({}, good, { streamsOpened: 0, streamsClosed: 0 }));
  check("a stream pattern that never matched is degraded", find(noStream, "replyStream").health === "degraded");
  check("and the note says it is a guess until confirmed",
    /Network tab/.test(find(noStream, "replyStream").detail));
  const halfStream = S.judgeSmoke(Object.assign({}, good, { streamsOpened: 2, streamsClosed: 1 }));
  check("a stream that opened and never closed is degraded", find(halfStream, "replyStream").health === "degraded");
  const noCopy = S.judgeSmoke(Object.assign({}, good, { copied: null }));
  check("a copy control returning nothing is degraded", find(noCopy, "copyButton").health === "degraded");
  check("and does not fail the run", noCopy.ok === true);
  const oddCopy = S.judgeSmoke(Object.assign({}, good, { copied: "print('something else')" }));
  check("a copy control returning the wrong text is degraded", find(oddCopy, "copyButton").health === "degraded");

  // Unconfigured is not a failure of this provider.
  const bare = S.judgeSmoke(Object.assign({}, good, {
    stopConfigured: false, streamConfigured: false, copyConfigured: false,
    stopSeen: false, streamsOpened: 0, copied: null,
  }));
  check("unconfigured selectors are skipped, not failed", bare.ok === true, bare.summary);
  check("the stop button reads as skipped", find(bare, "stopButton").health === "skipped");

  // Nothing sent means nothing below it means anything.
  const unsent = S.judgeSmoke({ sent: false });
  check("a prompt that never sent is critical", find(unsent, "send").health === "critical");
  check("and the report fails", unsent.ok === false);
  check("empty observations do not throw", typeof S.judgeSmoke({}).summary === "string");
  check("undefined does not throw", S.judgeSmoke(undefined).ok === false);

  check("a passing summary says the read path works",
    /whole read path is working/.test(healthy.summary), healthy.summary);
  check("a degraded summary warns about the fallback",
    /slower than they should be/.test(noStop.summary), noStop.summary);
}

async function testLocalModels() {
  section("a provider that is not a web page");
  const CS = require(path.join(DIST, "providers/chat-session.js"));
  const O = require(path.join(DIST, "providers/ollama-session.js"));

  // Every existing config predates transports and must keep working untouched.
  check("no transport means browser", CS.transportOf({}) === "browser");
  check("null does not throw", CS.transportOf(null) === "browser");
  check("an unknown transport falls back to browser", CS.transportOf({ transport: "carrier-pigeon" }) === "browser");
  check("ollama is recognised", CS.transportOf({ transport: "ollama" }) === "ollama");
  check("isBrowserTransport agrees", CS.isBrowserTransport({}) === true && CS.isBrowserTransport({ transport: "ollama" }) === false);

  // ollama list shows versioned tags; people write the bare name, and
  // `ollama run` matches the same way.
  check("an exact model name matches", O.hasModel(["llama3.2:latest"], "llama3.2:latest"));
  check("a bare name finds a versioned tag", O.hasModel(["qwen2.5-coder:7b"], "qwen2.5-coder"));
  check("a versioned request does not match a different version",
    O.hasModel(["qwen2.5-coder:7b"], "qwen2.5-coder:14b") === false);
  check("case does not matter", O.hasModel(["Qwen2.5-Coder:7b"], "qwen2.5-coder"));
  check("an absent model is absent", O.hasModel(["llama3.2:latest"], "qwen2.5-coder") === false);
  check("an empty request matches nothing", O.hasModel(["a:1"], "") === false);

  check("model names are parsed", JSON.stringify(O.modelNames('{"models":[{"name":"a:1"},{"name":"b:2"}]}')) === '["a:1","b:2"]');
  check("garbage yields no models", JSON.stringify(O.modelNames("{{")) === "[]");
  check("a missing models array yields none", JSON.stringify(O.modelNames('{"x":1}')) === "[]");

  check("a chat reply is read", O.replyText('{"message":{"content":"hi"}}') === "hi");
  check("a generate reply is read too", O.replyText('{"response":"hi"}') === "hi");
  check("an unreadable reply is empty", O.replyText("{{") === "");

  // The message is what the user acts on, so it says what to do.
  check("a refused connection says how to start the server",
    /ollama serve/.test(O.describeFailure({ code: "ECONNREFUSED" }, "http://127.0.0.1:11434", "m")));
  check("a timeout says a CPU model is slow, not broken",
    /very slow/.test(O.describeFailure({ code: "ETIMEDOUT" }, "e", "m")));

  // Against a real HTTP server, so the request path itself is exercised.
  const http = require("http");
  let lastBody = null;
  const server = http.createServer(function (req, res) {
    let body = "";
    req.on("data", function (c) { body += c; });
    req.on("end", function () {
      if (req.url === "/api/tags") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "qwen2.5-coder:7b" }] }));
        return;
      }
      lastBody = JSON.parse(body || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: { content: "reply " + lastBody.messages.length } }));
    });
  });
  await new Promise(function (r) { server.listen(0, "127.0.0.1", r); });
  const endpoint = "http://127.0.0.1:" + server.address().port;

  const good = new O.OllamaSession({ endpoint: endpoint, model: "qwen2.5-coder" });
  const ready = await good.ready();
  check("a reachable server holding the model is ready", ready.ok === true, ready.detail);

  const missing = new O.OllamaSession({ endpoint: endpoint, model: "nothing-here" });
  const notReady = await missing.ready();
  check("a missing model is not ready", notReady.ok === false);
  check("and the message says how to get it", /ollama pull nothing-here/.test(notReady.detail), notReady.detail);

  check("no model configured is not ready",
    (await new O.OllamaSession({ endpoint: endpoint }).ready()).ok === false);

  // The conversation is ours: history accumulates and reset empties it.
  check("a reply comes back", (await good.ask("one")) === "reply 1");
  check("the history grows", good.turns() === 2);
  check("the next turn carries it", (await good.ask("two")) === "reply 3");
  check("the server saw the whole conversation", lastBody.messages.length === 3, JSON.stringify(lastBody.messages.length));
  check("stream is off - the caller wants the whole answer", lastBody.stream === false);
  check("the model is named in the request", lastBody.model === "qwen2.5-coder");
  await good.reset();
  check("reset empties the conversation", good.turns() === 0);

  await new Promise(function (r) { server.close(r); });

  // A failed turn must not leave its question in the history, or every later
  // request re-sends a question that was never answered.
  const dead = new O.OllamaSession({ endpoint: endpoint, model: "qwen2.5-coder", timeoutMs: 1500 });
  let threw = false;
  try { await dead.ask("hello"); } catch (e) { threw = /Nothing is listening|Could not reach/.test(e.message); }
  check("a dead server throws a message that says what to do", threw);
  check("and the failed turn is not left in the history", dead.turns() === 0);

  // The shipped config has to actually be usable.
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "providers", "ollama.json"), "utf8"));
  check("the shipped config declares the ollama transport", cfg.transport === "ollama");
  check("and names a model", typeof cfg.model === "string" && cfg.model.length > 0);
  check("and is marked chat-only", cfg.chatOnly === true);
}

function testResearch() {
  section("research through the provider's own search");
  const GH = require(path.join(__dirname, "..", "..", "desktop", "github-api.js"));

  // Sources are how a research answer is checked rather than trusted.
  // Its own module, because requiring index.js runs main().
  const idx = require(path.join(DIST, "research.js"));
  check("the helpers live outside the CLI entry point", typeof idx.extractSources === "function");
  const answer = "Flask signs cookies.\n\nSOURCES:\nhttps://flask.palletsprojects.com/x\nhttps://owasp.org/y";
  check("sources under the marker are found",
    JSON.stringify(idx.extractSources(answer)) ===
    JSON.stringify(["https://flask.palletsprojects.com/x", "https://owasp.org/y"]));
  check("trailing punctuation is not part of a url",
    idx.extractSources("SOURCES:\nhttps://a.example/x.")[0] === "https://a.example/x");
  check("duplicates are collapsed",
    idx.extractSources("SOURCES:\nhttps://a.example\nhttps://a.example").length === 1);
  // Models cite inline about half the time, so no marker means fall back
  // rather than report an answer with no sources.
  check("inline urls are found when there is no marker",
    idx.extractSources("See https://a.example/doc for more").length === 1);
  check("an answer with no urls yields none", idx.extractSources("no links here").length === 0);
  check("empty input does not throw", idx.extractSources(null).length === 0);

  // A provider with no search control must say so rather than silently
  // answering from memory and presenting it as research.
  check("a provider offering smart-search is usable",
    idx.hasSearchControl({ controls: [{ id: "smart-search" }] }) === true);
  check("one without it is not",
    idx.hasSearchControl({ controls: [{ id: "mode" }] }) === false);
  check("no controls at all is not", idx.hasSearchControl({}) === false);

  // GitHub search, authenticated, shaped down to what the panel shows.
  const calls = [];
  const api = GH.createGitHubApi(function (method, apiPath) {
    calls.push(method + " " + apiPath);
    return Promise.resolve({ status: 200, body: { items: [
      { full_name: "pallets/flask", description: "d", stargazers_count: 68000,
        language: "Python", html_url: "https://github.com/pallets/flask", pushed_at: "2026-08-01" },
    ] } });
  });
  return api.searchRepos("flask session", 5).then(function (rows) {
    check("the search hits the repositories endpoint", /\/search\/repositories/.test(calls[0]), calls[0]);
    check("the query is encoded", /q=flask%20session/.test(calls[0]), calls[0]);
    check("the limit is passed", /per_page=5/.test(calls[0]), calls[0]);
    check("only the fields the panel shows come back",
      JSON.stringify(Object.keys(rows[0]).sort()) ===
      JSON.stringify(["description", "fullName", "language", "stars", "updatedAt", "url"]),
      JSON.stringify(Object.keys(rows[0])));
    check("stars survive", rows[0].stars === 68000);
    return api.searchRepos("  ").then(function (empty) {
      check("an empty query makes no request", empty.length === 0 && calls.length === 1);
    });
  });
}

function testExportBranch() {
  section("a build replayed as one commit per step");
  const E = require(path.join(DIST, "export-branch.js"));
  const C = require(path.join(DIST, "checkpoint.js"));

  check("a branch name is slugged", E.branchName("Flask Habit Tracker!") === "closeni/flask-habit-tracker");
  check("an empty summary still names a branch", E.branchName("") === "closeni/build");
  check("punctuation only still names a branch", E.branchName("!!!") === "closeni/build");
  check("a long summary is trimmed without a trailing dash",
    !/-$/.test(E.branchName("a very long project summary that goes on and on and on and on")));
  check("a commit subject is one line", E.commitMessage(5, "Streak\ncalculation") === "step 6: Streak calculation");
  check("an untitled step still says something", E.commitMessage(0, "") === "step 1: changes");

  // Step 4 creates streaks.py and rewrites app.py; step 5 rewrites app.py again
  // and creates routes.py. The content after step 4 is nowhere stored - it is
  // recovered from what step 5 recorded as its prior.
  function cp(step, files, title) { return { version: 1, step: step, title: title, at: "", files: files }; }
  const checkpoints = [
    cp(3, { "app.py": { prior: "v3", after: "h4" }, "streaks.py": { prior: null, after: "hs" } }, "Streaks"),
    cp(4, { "app.py": { prior: "v4", after: "h5" }, "routes.py": { prior: null, after: "hr" } }, "Routes"),
  ];
  const current = { "app.py": "v5", "streaks.py": "S", "routes.py": "R" };
  const plan = E.planCommits(checkpoints, current);

  check("one commit per step", plan.commits.length === 2);
  check("commits are in step order", plan.commits[0].step === 3 && plan.commits[1].step === 4);
  // The whole trick: step 5's prior IS step 4's result.
  check("a file's after-state comes from the next step that touched it",
    plan.commits[0].writes["app.py"] === "v4", JSON.stringify(plan.commits[0].writes));
  check("a file nothing touched again takes its content from disk",
    plan.commits[0].writes["streaks.py"] === "S");
  check("the last step's file also comes from disk", plan.commits[1].writes["app.py"] === "v5");
  check("a file created later is not in an earlier commit",
    !("routes.py" in plan.commits[0].writes));
  check("titles are carried", plan.commits[0].title === "Streaks");
  check("titles can be overridden from the plan",
    E.planCommits(checkpoints, current, { 3: "Better name" }).commits[0].title === "Better name");
  check("a clean build warns about nothing", plan.warnings.length === 0, JSON.stringify(plan.warnings));

  // The bug that only showed up by running it against a real repository.
  //
  // The export refuses on a dirty tree, so the user commits the finished build
  // first - which means HEAD already holds every file. Staging only the paths a
  // step touched leaves the rest at HEAD's version, so step 4's commit contained
  // routes.py, which step 5 created. Every commit stages every build path at its
  // state as of that step, so a file that does not exist yet is a deletion.
  check("a file a later step creates is deleted in earlier commits",
    plan.commits[0].deletes.indexOf("routes.py") !== -1, JSON.stringify(plan.commits[0].deletes));
  check("and is written once its step arrives", plan.commits[1].writes["routes.py"] === "R");
  check("a file an earlier step created stays written later",
    plan.commits[1].writes["streaks.py"] === "S");


  // A file deleted since the build must be represented as absent, not written.
  const gone = E.planCommits(checkpoints, { "app.py": "v5", "streaks.py": null, "routes.py": "R" });
  check("a file gone from disk becomes a delete",
    gone.commits[0].deletes.indexOf("streaks.py") !== -1, JSON.stringify(gone.commits[0].deletes));
  check("and is not also written", !("streaks.py" in gone.commits[0].writes));

  // Unreadable is not the same as absent. Treating it as a delete would turn an
  // export into data loss.
  const unread = E.planCommits(checkpoints, { "app.py": "v5", "routes.py": "R" });
  check("an unreadable file is neither written nor deleted",
    !("streaks.py" in unread.commits[0].writes) &&
    unread.commits[0].deletes.indexOf("streaks.py") === -1);
  check("and it is warned about", /streaks\.py/.test(unread.warnings.join(" ")), JSON.stringify(unread.warnings));

  // A prior we never stored means the history is approximate, and says so.
  const big = E.planCommits(
    [cp(0, { "data.bin": { prior: null, after: null, tooLarge: true } })], { "data.bin": "x" });
  check("an unrecorded prior is warned about", /too large/.test(big.warnings.join(" ")), JSON.stringify(big.warnings));

  check("no checkpoints means no commits", E.planCommits([], {}).commits.length === 0);
  check("null input does not throw", E.planCommits(null, null).commits.length === 0);
}

function testPlanEdit() {
  section("editing a plan without breaking its graph");
  const P = require(path.join(__dirname, "..", "..", "desktop", "plan-edit.js"));
  const sched = require(path.join(__dirname, "..", "..", "desktop", "scheduler.js"));

  function mk(deps) { return deps.map(function (d, i) { return { title: "s" + (i + 1), dependsOn: d }; }); }
  function depsOf(r) { return r.steps.map(function (s) { return s.dependsOn; }); }

  // 1 <- 2 <- 3 <- 4, and 5 independent.
  const plan = mk([[], [0], [1], [2], []]);

  // Deleting a step hands its dependents what IT needed. Dropping the
  // reference instead would lose an ordering the model stated.
  const del = P.deleteStep(plan, 2);
  check("the step is gone", del.steps.length === 4);
  check("its dependents inherit its dependencies",
    JSON.stringify(depsOf(del)) === JSON.stringify([[], [0], [1], []]), JSON.stringify(depsOf(del)));
  check("and the change is explained", /now depends on step 2/.test(del.notes.join(" ")), JSON.stringify(del.notes));
  check("the result still schedules", sched.graphFor(del.steps).declared === true);

  // Deleting step 1, which nothing depended through.
  const delFirst = P.deleteStep(plan, 0);
  check("deleting the first step shifts everything down",
    JSON.stringify(depsOf(delFirst)) === JSON.stringify([[], [0], [1], []]), JSON.stringify(depsOf(delFirst)));
  check("a one-step plan refuses deletion", !!P.deleteStep(mk([[]]), 0).refused);
  check("an out-of-range delete is refused", !!P.deleteStep(plan, 9).refused);

  // undefined and [] mean different things to the scheduler, so an undeclared
  // step must not become a declared one.
  const undeclared = [{ title: "a" }, { title: "b" }, { title: "c" }];
  check("an undeclared step stays undeclared",
    P.deleteStep(undeclared, 1).steps.every(function (s) { return s.dependsOn === undefined; }));
  check("and the plan still reads as a chain",
    sched.graphFor(P.deleteStep(undeclared, 1).steps).declared === false);

  // Moving is refused when it would invert a real dependency.
  const bad = P.moveStep(plan, 3, 0);
  check("moving a step above its dependency is refused", !!bad.refused, bad.refused);
  check("the refusal names both steps", /step 4 depends on step 3/.test(bad.refused), bad.refused);
  check("and the plan is untouched", bad.steps === bad.steps && JSON.stringify(depsOf(bad)) === JSON.stringify([[], [0], [1], [2], []]));

  // The case a naive check misses: the step being dragged is fine, but moving
  // it strands something that depended on it.
  const stranded = P.moveStep(plan, 1, 4);
  check("moving a step below its dependents is also refused", !!stranded.refused, stranded.refused);

  // A legal move remaps every index.
  const ok = P.moveStep(plan, 4, 0);
  check("a legal move succeeds", !ok.refused, ok.refused);
  check("every dependency index moves with the step it points at",
    JSON.stringify(depsOf(ok)) === JSON.stringify([[], [], [1], [2], [3]]), JSON.stringify(depsOf(ok)));
  check("the moved step is first", ok.steps[0].title === "s5");
  check("the result still schedules", sched.graphFor(ok.steps).declared === true);
  check("moving to the same place changes nothing", JSON.stringify(P.moveStep(plan, 2, 2).steps) === JSON.stringify(plan));

  // Merging folds a step into the one above it.
  const rich = [
    { title: "Schema", detail: "tables", files: ["db.py"], dependsOn: [] },
    { title: "Migrations", detail: "alembic", files: ["mig.py"], dependsOn: [0], testable: true },
    { title: "Routes", detail: "crud", files: ["r.py"], dependsOn: [1] },
  ];
  const merged = P.mergeStepUp(rich, 1);
  check("two steps become one", merged.steps.length === 2);
  check("titles are joined", merged.steps[0].title === "Schema + Migrations");
  check("details are kept", /tables[\s\S]*alembic/.test(merged.steps[0].detail));
  check("files are unioned", JSON.stringify(merged.steps[0].files) === JSON.stringify(["db.py", "mig.py"]));
  check("testable survives if either half had it", merged.steps[0].testable === true);
  check("the merged step does not depend on itself",
    JSON.stringify(merged.steps[0].dependsOn) === "[]", JSON.stringify(merged.steps[0].dependsOn));
  check("what followed now depends on the merged step",
    JSON.stringify(merged.steps[1].dependsOn) === "[0]", JSON.stringify(merged.steps[1].dependsOn));
  check("merging the first step is refused", !!P.mergeStepUp(rich, 0).refused);
  check("the result still schedules", sched.graphFor(merged.steps).declared === true);
}

function testStepTiming() {
  section("where a build's time went");
  const T = require(path.join(__dirname, "..", "..", "desktop", "step-timing.js"));

  // A step: 2s before the first phase is reported, then sending, writing,
  // applying, checking - and 1s after the last phase closes.
  let t = T.newTimer(0);
  T.markPhase(t, "sending", 2000);
  T.markPhase(t, "writing", 2400);
  T.markPhase(t, "applying", 80400);
  T.markPhase(t, "checking", 80700);
  T.finish(t, 104100);

  check("the total is wall clock for the step", t.totalMs === 104100, String(t.totalMs));
  check("the model wait is attributed to writing", t.phases.writing === 78000, String(t.phases.writing));
  check("sending is its own line", t.phases.sending === 400);
  check("applying is separated from checking", t.phases.applying === 300 && t.phases.checking === 23400);

  // Time before any phase is reported belongs to nothing, and saying so beats
  // folding it into a neighbour - a timing report that guesses starts lying.
  check("time before the first phase is unattributed", t.phases[T.UNATTRIBUTED] === 2000, JSON.stringify(t.phases));
  check("every millisecond is accounted for",
    Object.keys(t.phases).reduce(function (a, k) { return a + t.phases[k]; }, 0) === t.totalMs);

  const rows = T.phaseRows(t);
  check("phases are listed longest first", rows[0].phase === "writing" && rows[1].phase === "checking");
  check("zero-length phases are dropped", rows.every(function (r) { return r.ms > 0; }));

  check("finishing twice does not double-count", T.finish(t, 999999).totalMs === 104100);

  // A build rolls its steps together.
  let u = T.newTimer(0);
  T.markPhase(u, "writing", 0);
  T.finish(u, 10000);
  const sum = T.summarise([t, u]);
  check("every step is counted", sum.steps === 2);
  check("totals add up", sum.totalMs === 114100);
  check("writing dominates", sum.phases[0].phase === "writing" && sum.phases[0].ms === 88000);
  check("percentages are of counted time, not the clock",
    sum.phases.reduce(function (a, r) { return a + r.percent; }, 0) >= 99);
  check("an empty build does not throw", T.summarise([]).totalMs === 0);
  check("nulls are ignored", T.summarise([null, undefined]).steps === 0);

  // Durations someone can read at a glance.
  check("sub-second is milliseconds", T.formatDuration(400) === "400ms");
  check("seconds keep one decimal", T.formatDuration(23400) === "23.4s");
  check("minutes drop it", T.formatDuration(102000) === "1m 42s");
  check("seconds are zero-padded", T.formatDuration(64000) === "1m 04s");
  // 59.6s rounds to 60 and would otherwise read as "3m 60s".
  check("a rounding carry rolls the minute", T.formatDuration(239600) === "4m 00s");
  check("zero is zero", T.formatDuration(0) === "0ms");
  check("nonsense does not throw", T.formatDuration(NaN) === "0ms" && T.formatDuration(-5) === "0ms");

  // Only the durable half is stored.
  const rec = T.toRecord(t);
  check("a record keeps the total and the phases", rec.totalMs === 104100 && rec.phases.writing === 78000);
  check("and drops the live cursor", !("phaseAt" in rec) && !("phase" in rec));
  check("no timer means no record", T.toRecord(null) === undefined);
}

async function testHeadlessCli() {
  section("a build with no window");
  const cp = require("child_process");
  const B = require(path.join(DIST, "build-state.js"));
  const ROOT = path.join(__dirname, "..", "..");
  const fake = "node " + JSON.stringify(path.join(__dirname, "fixtures", "fake-agent.js"));

  function makeWorkspace(steps) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-cli-"));
    fs.mkdirSync(path.join(ws, ".closeni"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".closeni", "build.json"),
      JSON.stringify(B.serialiseBuildState({ summary: "Demo" }, steps, {}), null, 2));
    return ws;
  }
  function run(ws, env) {
    return cp.spawnSync("node", [path.join(ROOT, "bin", "closeni.js"), "build", ws, "--json"], {
      encoding: "utf8", timeout: 60000,
      env: Object.assign({}, process.env, { CLOSENI_AGENT_CMD: fake }, env || {}),
    });
  }
  function events(out) {
    return String(out || "").split("\n").filter(Boolean).map(function (l) {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
  }
  function readState(ws) {
    return B.parseBuildState(fs.readFileSync(path.join(ws, ".closeni", "build.json"), "utf8"));
  }

  // 1 <- 2 <- 3, and 4 depending on nothing. Step 2 fails.
  const plan = [
    { title: "Scaffold", detail: "d", files: [], dependsOn: [], status: "pending" },
    { title: "Schema", detail: "d", files: [], dependsOn: [0], status: "pending" },
    { title: "Routes", detail: "d", files: [], dependsOn: [1], status: "pending" },
    { title: "Docs", detail: "d", files: [], dependsOn: [], status: "pending" },
  ];

  let ws = makeWorkspace(plan);
  let r = run(ws, { FAKE_FAIL_STEPS: "1" });
  let ev = events(r.stdout);
  function has(type, index) {
    return ev.some(function (e) { return e.type === type && (index === undefined || e.index === index); });
  }

  check("the declared graph is used", has("graph") && ev[0].declared === true, JSON.stringify(ev[0]));
  check("step 1 runs and finishes", has("step-done", 0));
  check("step 2 fails", has("step-failed", 1));
  check("step 3 is blocked, not failed", has("step-blocked", 2) && !has("step-failed", 2));
  // §2's whole point, executing for real rather than in a unit test: step 4
  // depends on nothing, so a failure at step 2 must not stop it.
  check("step 4 still runs, because nothing it needed failed", has("step-done", 3));
  check("a build with a failed step exits non-zero", r.status === 1, String(r.status));

  let st = readState(ws);
  check("the statuses are written to disk",
    st.steps.map(function (s) { return s.status; }).join(",") === "done,failed,blocked,done",
    st.steps.map(function (s) { return s.status; }).join(","));
  check("timing is recorded per step", st.steps[0].timing.totalMs >= 0 && st.steps[0].timing.phases.writing > 0,
    JSON.stringify(st.steps[0].timing));

  // Running again resumes: what succeeded is kept, what failed is retried.
  r = run(ws);
  ev = events(r.stdout);
  check("a second run resumes rather than restarting", ev.some(function (e) { return e.type === "resume" && e.done === 2; }),
    JSON.stringify(ev.filter(function (e) { return e.type === "resume"; })));
  check("the completed steps are not run again", !has("step-start", 0) && !has("step-start", 3));
  check("the failed step is retried", has("step-start", 1));
  check("and what it blocked runs too", has("step-done", 2));
  check("a completed build exits zero", r.status === 0, String(r.status));
  check("every step ends done", readState(ws).steps.every(function (s) { return s.status === "done"; }));

  fs.rmSync(ws, { recursive: true, force: true });

  // A plan whose graph cannot be scheduled falls back to the chain rather than
  // refusing, exactly as the app does.
  ws = makeWorkspace([
    { title: "a", detail: "d", files: [], dependsOn: [1], status: "pending" },
    { title: "b", detail: "d", files: [], dependsOn: [], status: "pending" },
  ]);
  ev = events(run(ws).stdout);
  check("an unschedulable graph falls back to the chain",
    ev[0].type === "graph" && ev[0].declared === false && /later/.test(ev[0].reason || ""),
    JSON.stringify(ev[0]));
  fs.rmSync(ws, { recursive: true, force: true });

  // Refusals, which are the paths a script hits first.
  const noPlan = cp.spawnSync("node", [path.join(ROOT, "bin", "closeni.js"), "build", os.tmpdir()],
    { encoding: "utf8", timeout: 20000 });
  check("no plan exits 2 and says where it looked", noPlan.status === 2 && /build\.json/.test(noPlan.stderr));
  const badAuto = cp.spawnSync("node", [path.join(ROOT, "bin", "closeni.js"), "build", os.tmpdir(), "--autonomy", "yolo"],
    { encoding: "utf8", timeout: 20000 });
  check("an unknown autonomy is refused", badAuto.status === 2, String(badAuto.status));
  const help = cp.spawnSync("node", [path.join(ROOT, "bin", "closeni.js")], { encoding: "utf8", timeout: 20000 });
  check("no arguments prints usage", /closeni build/.test(help.stdout));
}

function testStorageRoot() {
  section("the CLI and the app share one browser profile");
  const S = require(path.join(DIST, "storage-paths.js"));

  // The bug this exists for, found by the first live smoke run: the desktop app
  // sets CLOSENI_STORAGE to Electron's userData and every agent it spawns
  // inherits it, but a CLI entry point sets nothing - so storagePaths fell back
  // to the repo-local profileDir. The app was signed in and `npm run smoke`
  // reported "not signed in", against a different directory entirely.
  check("defaultStorageRoot is exported", typeof S.defaultStorageRoot === "function");

  const linux = S.defaultStorageRoot("linux", { XDG_CONFIG_HOME: "/x/cfg", HOME: "/home/u" });
  check("linux follows XDG_CONFIG_HOME", linux === path.join("/x/cfg", "CloseNI"), linux);
  const linuxNoXdg = S.defaultStorageRoot("linux", { HOME: "/home/u" });
  check("and falls back to ~/.config", linuxNoXdg === path.join("/home/u", ".config", "CloseNI"), linuxNoXdg);
  const mac = S.defaultStorageRoot("darwin", { HOME: "/Users/u" });
  check("macOS uses Application Support",
    mac === path.join("/Users/u", "Library", "Application Support", "CloseNI"), mac);
  const win = S.defaultStorageRoot("win32", { APPDATA: "C:\\Users\\u\\AppData\\Roaming" });
  check("windows uses APPDATA", win === path.join("C:\\Users\\u\\AppData\\Roaming", "CloseNI"), win);
  check("no home anywhere yields nothing rather than a guess",
    S.defaultStorageRoot("linux", {}) === "");

  // The name has to match what Electron actually created, or the CLI points at
  // a directory that has never been signed in to.
  check("the app name matches package.json productName",
    require(path.join(__dirname, "..", "..", "package.json")).productName === "CloseNI");

  // storagePaths itself is untouched: the e2e suite depends on the no-root
  // branch resolving profileDir relative to its fixture directory.
  const fixture = S.storagePaths("", { id: "deepseek", profileDir: "/tmp/fx/storage/browser-profiles/deepseek" });
  check("an unset root still resolves the configured profileDir",
    fixture.profileDir === path.resolve("/tmp/fx/storage/browser-profiles/deepseek"), fixture.profileDir);
  const rooted = S.storagePaths("/root", { id: "deepseek", profileDir: "ignored" });
  check("a root keys the profile by provider id",
    rooted.profileDir === path.join("/root", "browser-profiles", "deepseek"), rooted.profileDir);
}

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

  // Order is the design decision: who you are, how to work, what is true, what
  // to do. The task is last so it is what the model is still reading when it
  // starts generating.
  const iPersona = out.text.indexOf("You are terse.");
  const iSkill = out.text.indexOf("Write pytest tests.");
  const iMcp = out.text.indexOf("Flask docs");
  const iBase = out.text.indexOf("TASK: build a thing.");
  check("persona comes first", iPersona >= 0 && iPersona < iSkill);
  check("skills come before context", iSkill < iMcp);
  check("context comes before the task", iMcp < iBase);
  check("nothing was dropped under budget", out.truncated.length === 0, JSON.stringify(out.truncated));
  check("every skill is present", out.text.includes("Prefer the standard library."));

  const bare = C.composePrompt({ base: "ONLY" });
  check("an empty parts object yields exactly base", bare.text === "ONLY", JSON.stringify(bare.text));
  check("and reports nothing dropped", bare.truncated.length === 0);
  const noPersona = C.composePrompt({ skills: ["S"], base: "B" });
  check("no persona leaves no blank lead-in", !/^\s/.test(noPersona.text), JSON.stringify(noPersona.text.slice(0, 12)));
  const emptyStrings = C.composePrompt({ persona: "   ", skills: ["", "  "], mcpContext: [""], base: "B" });
  check("blank parts are treated as absent", emptyStrings.text === "B", JSON.stringify(emptyStrings.text));

  const big = function (n) { return "x".repeat(n); };
  const over = C.composePrompt(
    { persona: big(400), skills: [big(400)], mcpContext: [big(400)], base: "BASE" }, 900);
  check("mcp context is dropped first", over.truncated.indexOf("mcp context") !== -1, JSON.stringify(over.truncated));
  const tighter = C.composePrompt(
    { persona: big(400), skills: [big(400)], mcpContext: [big(400)], base: "BASE" }, 500);
  check("then skills", tighter.truncated.indexOf("skills") !== -1, JSON.stringify(tighter.truncated));
  const tightest = C.composePrompt(
    { persona: big(400), skills: [big(400)], mcpContext: [big(400)], base: "BASE" }, 50);
  check("then persona", tightest.truncated.indexOf("persona") !== -1, JSON.stringify(tightest.truncated));

  // THE check. base carries the JSON instruction, and this project has lost
  // whole builds to replies the parser could not read.
  check("base survives a budget smaller than itself",
    tightest.text.indexOf("BASE") !== -1, JSON.stringify(tightest.text));
  const microBudget = C.composePrompt({ persona: big(9000), base: "BASE" }, 1);
  check("base survives a budget of 1", microBudget.text === "BASE", JSON.stringify(microBudget.text));
  check("base alone over budget is still returned whole",
    C.composePrompt({ base: big(9000) }, 10).text.length === 9000);

  check("the default budget is 6000", C.PREAMBLE_BUDGET_CHARS === 6000);
  check("nonsense budget falls back to the default",
    C.composePrompt(parts, NaN).text === out.text);
  check("null parts do not throw", typeof C.composePrompt(null).text === "string");

  // The agent has to read the preamble from the environment, the way provider
  // controls already travel, rather than as a new positional argument threaded
  // through every mode and every caller for something only buildPrompt uses.
  const agentSrc = fs.readFileSync(path.join(__dirname, "..", "src", "index.ts"), "utf8");
  check("the agent reads AGENT_PREAMBLE", /AGENT_PREAMBLE/.test(agentSrc));
  check("and composes rather than concatenating", /composePrompt\(/.test(agentSrc));
  check("a malformed preamble is ignored rather than fatal",
    /try \{[\s\S]{0,240}AGENT_PREAMBLE[\s\S]{0,240}catch/.test(agentSrc));
  check("what was dropped is reported", /Preamble over budget/.test(agentSrc));
}

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
  check("a non-markdown file is ignored", names.indexOf("notes") === -1);
  check("a directory named .md is ignored", names.indexOf("adir") === -1);
  check("an unreadable directory yields an empty list rather than throwing",
    JSON.stringify(S.listMarkdown(path.join(root, "nope"))) === "[]");

  const read = S.readSelected(sd, ["pytest", "missing", "stdlib"]);
  check("only the selected files are read", read.length === 2, JSON.stringify(read));
  check("contents come back", read[0] === "Always write pytest tests.");
  check("a selected file that is gone is skipped, not fatal", read.join(" ").indexOf("missing") === -1);
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
  check("a leading dot is refused", S.isSafeName(".hidden") === false);
  check("an unsafe name reads nothing",
    JSON.stringify(S.readSelected(sd, ["../../etc/passwd"])) === "[]");

  fs.rmSync(root, { recursive: true, force: true });
}

async function testMcpClient() {
  section("MCP, spoken by hand over stdio");
  const M = require(path.join(DIST, "mcp/mcp-client.js"));
  const fixture = path.join(__dirname, "fixtures", "fake-mcp-server.js");
  const spec = function (mode) {
    return { command: process.execPath, args: [fixture], env: { FAKE_MCP_MODE: mode } };
  };

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
  check("the arguments reached the tool", good.text.indexOf('"url":"https://x.test"') !== -1, good.text);

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
  check("every tool is listed", listed.tools.length === 2, JSON.stringify(listed.tools));
  const listFailed = await M.listTools(spec("exit"));
  check("listing a dead server fails cleanly",
    listFailed.ok === false && Array.isArray(listFailed.tools));
}

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
  check("garbage yields an empty config", Object.keys(X.parseMcpConfig("{{").servers).length === 0);
  check("null yields an empty config", X.parseMcpConfig(null).calls.length === 0);
  check("a server with no command is dropped",
    Object.keys(X.parseMcpConfig({ servers: { a: {} } }).servers).length === 0);
  check("a call naming an unknown server is dropped by the planner",
    X.planCalls(X.parseMcpConfig({ servers: {}, calls: [{ server: "gone", tool: "t" }] })).length === 0);

  const planned = X.planCalls(cfg);
  check("a planned call carries its server spec", planned[0].spec.command === "uvx");

  // The whole point: a failure is context we did not get, never a failed build.
  const okRun = async function () { return { ok: true, text: "DOCS" }; };
  const gathered = await X.gatherContext(cfg, okRun);
  check("successful calls return their text", gathered.texts.join("") === "DOCS", JSON.stringify(gathered.texts));
  check("and nothing is reported", gathered.notes.length === 0);

  const failRun = async function () { return { ok: false, text: "", error: "server exploded" }; };
  const failed = await X.gatherContext(cfg, failRun);
  check("a failed call contributes no text", failed.texts.length === 0);
  check("but is reported rather than hidden", /server exploded/.test(failed.notes.join(" ")), JSON.stringify(failed.notes));
  check("a build is not failed by it", Array.isArray(failed.texts));

  const throwRun = async function () { throw new Error("boom"); };
  const threw = await X.gatherContext(cfg, throwRun);
  check("a client that throws is caught",
    threw.texts.length === 0 && threw.notes.length === 1, JSON.stringify(threw.notes));

  const empty = await X.gatherContext(X.parseMcpConfig(null), okRun);
  check("no configuration means no calls and no noise",
    empty.texts.length === 0 && empty.notes.length === 0);
}

function testSkillsWiring() {
  section("skills reach the agent from the app");
  const GH = require(path.join(__dirname, "..", "..", "desktop", "github-api.js"));
  const D = path.join(__dirname, "..", "..", "desktop");
  const main = fs.readFileSync(path.join(D, "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(D, "preload.js"), "utf8");
  const renderer = fs.readFileSync(path.join(D, "renderer.js"), "utf8");
  const html = fs.readFileSync(path.join(D, "index.html"), "utf8");

  // Import needs a file fetch. getReadme existed; a general one did not.
  const calls = [];
  const api = GH.createGitHubApi(function (m, p2) {
    calls.push(p2);
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
    check("the renderer sends the preamble as AGENT_PREAMBLE", /AGENT_PREAMBLE/.test(main));
    check("the renderer builds one", /buildPreamble/.test(renderer));
    check("MCP context is gathered before the build, not per step",
      /gather-mcp-context/.test(main) && !/gatherMcpContext/.test(fs.readFileSync(path.join(D, "builder.js"), "utf8")));
  });
}

(async () => {
  testEditPlanParsing();
  testPlanParsing();
  testSessionStore();
  testDelta();
  testDiff();
  testApprovalPolicy();
  testCompletion();
  testControlDecisions();
  testControlSettings();
  testCssTokens();
  testStoragePaths();
  testPlanScale();
  testPlanGraph();
  testCommandPolicy();
  testGitHubSafe();
  testGitSpawnHardening();
  await testGitHubApi();
  testScheduler();
  await testAsyncPool();
  testRunManifest();
  testPreviewTarget();
  testBrowserCheck();
  testBuildConfig();
  testReleaseWorkflow();
  testTheme();
  testLogo();
  testLanguageMark();
  testDependsOnNumbering();
  testRobustFileParsing();
  testPackagedPaths();
  testPlaywrightCliResolution();
  testBehaviourChecker();
  testSearchBlockMatching();
  testAbbreviationGuard();
  await testAgentQueue();
  testProviderGating();
  testToolchain();
  testCheckPlanner();
  await testCommandTimeout();
  testEntrypoint();
  testRelevance();
  testPatchApplier();
  await testBrowserExtraction();
  testApplyFollowUp();
  testSchedulerGraph();
  testBuildState();
  testCheckpoints();
  testRollbackOnDisk();
  testContextBudget();
  testSelectorHealth();
  testTypeChecks();
  testStepTests();
  testSmokeReport();
  await testLocalModels();
  await testResearch();
  testExportBranch();
  testPlanEdit();
  testStepTiming();
  await testHeadlessCli();
  testStorageRoot();
  testPromptCompose();
  testSkillStore();
  await testMcpClient();
  await testMcpContext();
  await testSkillsWiring();

  console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + " — " + pass + " passed, " + fail + " failed");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("test runner threw:", e);
  process.exit(1);
});
