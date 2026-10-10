/*
 * Unit tests: the native app and its packaging: themes and marks, storage
 * paths, the browser gate, build and release config, GitHub, skills, MCP and
 * onboarding. The app's pure logic lives in native/qml/js/*.mjs and is loaded
 * here through Node's require(esm); its wiring is read from the QML and C++
 * sources.
 *
 * Run by run-tests.cjs (npm test), against the compiled output.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const DIST = path.join(__dirname, "..", "dist");
const NATIVE = path.join(ROOT, "native");
const JS = path.join(NATIVE, "qml", "js");

// One native source file, by its path under native/.
function readNative(rel) {
  return fs.readFileSync(path.join(NATIVE, rel), "utf8");
}

// Every file under native/<sub> with one of the extensions, read as one.
function readNativeTree(sub, exts) {
  const out = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (exts.some(function (x) { return e.name.endsWith(x); })) out.push({ file: path.relative(NATIVE, p), text: fs.readFileSync(p, "utf8") });
    });
  })(path.join(NATIVE, sub));
  return out;
}

// Handed in by run-tests.cjs, which keeps the one count.
let check, section, skipped;

/*
 * Theme.qml's palettes, as { id: { key: value-source } }. The block is a JS
 * object literal of "id": { key: value, ... } entries; values are colour
 * strings, rgba(...) calls or numbers, none of which contain a colon.
 */
function themePalettes(qml) {
  const start = qml.indexOf("readonly property var palettes: ({");
  if (start === -1) return {};
  const end = qml.indexOf("\n    })", start);
  const block = qml.slice(start, end === -1 ? undefined : end);
  const out = {};
  for (const m of block.matchAll(/^\s*"([a-z-]+)":\s*\{([\s\S]*?)^\s*\}/gm)) {
    const keys = {};
    for (const kv of m[2].matchAll(/([A-Za-z][A-Za-z0-9]*):\s*((?:[A-Za-z.]+\([^)]*\))|[^,\n]*)/g)) keys[kv[1]] = kv[2].trim();
    out[m[1]] = keys;
  }
  return out;
}

// A colour written into a QML file. Only Theme.qml may hold one.
const COLOR_LITERAL = /"#[0-9a-fA-F]{3,8}"|\bQt\.rgba\s*\(|\brgba\s*\(|\bQt\.hsla\s*\(/;
function colourLiterals(qml) {
  return qml.split("\n").map(function (text, i) { return { line: i + 1, text: text.trim() }; })
    .filter(function (l) { return !/^(\/\/|\*|\/\*)/.test(l.text) && COLOR_LITERAL.test(l.text.replace(/\/\/.*$/, "")); });
}

// Keys that describe structure, not appearance. A palette never holds these.
const STRUCTURAL = /^(sp[A-Z0-9]|r[A-Z]|dur|ease)/;

function testThemePalettes() {
  section("theme palettes");
  const qml = readNative("qml/singletons/Theme.qml");
  const palettes = themePalettes(qml);
  const { THEMES } = require(path.join(JS, "theme.mjs"));

  // The load-bearing check. A colour outside Theme.qml is one no theme can
  // reach, and it fails silently - the app just looks wrong on that theme.
  const stray = [];
  readNativeTree("qml", [".qml"]).forEach(function (f) {
    if (f.file === path.join("qml", "singletons", "Theme.qml")) return;
    colourLiterals(f.text).forEach(function (o) { stray.push(f.file + ":" + o.line + ": " + o.text); });
  });
  check("no colour literals outside Theme.qml", stray.length === 0, stray.slice(0, 6).join(" | "));

  // Sanity-check the lint and the parser, so a broken one cannot report success.
  check("the lint detects a hex", colourLiterals('color: "#fff"').length === 1);
  check("the lint detects Qt.rgba", colourLiterals("color: Qt.rgba(0, 0, 0, .5)").length === 1);
  check("the lint ignores a comment", colourLiterals('// was "#fff"').length === 0);
  check("the lint ignores a Theme reference", colourLiterals("color: Theme.txt").length === 0);
  check("the parser reads a palette",
    JSON.stringify(themePalettes('    readonly property var palettes: ({\n        "a": {\n            bg: "#000", overlay: rgba(0, 0, 0, .7),\n            glowRadius: 0\n        }\n    })'))
      === JSON.stringify({ a: { bg: '"#000"', overlay: "rgba(0, 0, 0, .7)", glowRadius: "0" } }));

  // Every theme must define the whole palette. A theme that omits errBg falls
  // through to undefined, which looks correct until the day a build fails.
  const base = Object.keys(palettes.midnight || {});
  check("the palette is substantial", base.length >= 25, String(base.length));
  THEMES.forEach(function (t) {
    const p = palettes[t.id];
    if (!p) { check("theme " + t.id + " has a palette", false); return; }
    const missing = base.filter(function (k) { return !(k in p); });
    const extra = Object.keys(p).filter(function (k) { return base.indexOf(k) === -1; });
    check("theme " + t.id + " defines the whole palette", missing.length === 0 && extra.length === 0,
      missing.concat(extra).join(" "));
    // Spacing and radii are Theme.qml's own properties; a palette redefining
    // them would change layout, which is not what a theme is for.
    const structural = Object.keys(p).filter(function (k) { return STRUCTURAL.test(k); });
    check("theme " + t.id + " does not redefine structure", structural.length === 0, structural.join(" "));
  });
  check("every palette is a theme the list offers",
    Object.keys(palettes).every(function (id) { return THEMES.some(function (t) { return t.id === id; }); }),
    Object.keys(palettes).join());

  // The decor flag drives whether Appearance offers a decoration toggle, so it
  // has to agree with which themes actually declare a texture. Drift between
  // the two shows up as a toggle that does nothing.
  const textured = Object.keys(palettes).filter(function (id) { return palettes[id].texture && palettes[id].texture !== '""'; });
  const flagged = THEMES.filter(function (t) { return t.decor; }).map(function (t) { return t.id; });
  check("the decor flag matches the themes with a texture",
    textured.sort().join() === flagged.sort().join(), "textured=" + textured.join() + " flagged=" + flagged.join());

  // Complete is not legible: a theme can declare every key and still put dark
  // red on near-black. The pairs are the ones that carry meaning - body text,
  // muted labels, the inverted button, and each status on its own tint and on
  // the page. 3.0 is the floor below which text is gone rather than muted;
  // body text and dim labels are held to 4.5.
  const hex = function (v) {
    const h = (String(v || "").match(/^"#([0-9a-fA-F]{6})"$/) || [])[1];
    return h ? [0, 2, 4].map(function (i) { return parseInt(h.substr(i, 2), 16); }) : null;
  };
  const lum = function (c) {
    const f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = function (a, b) {
    const l = [lum(a), lum(b)].sort(function (x, y) { return y - x; });
    return (l[0] + 0.05) / (l[1] + 0.05);
  };
  check("the contrast maths is right", Math.abs(ratio([0, 0, 0], [255, 255, 255]) - 21) < 0.01);
  const PAIRS = [["txt", "bg", 4.5], ["txt", "panel", 4.5], ["txt", "surface", 4.5], ["dim", "bg", 4.5],
    ["dim", "panel", 4.5], ["mut", "bg", 3], ["inverse", "txt", 3], ["ok", "okBg", 3], ["warn", "warnBg", 3],
    ["err", "errBg", 3], ["ok", "bg", 3], ["warn", "bg", 3], ["err", "bg", 3], ["accent", "bg", 3]];
  THEMES.forEach(function (t) {
    const p = palettes[t.id];
    if (!p) return;
    const bad = [];
    PAIRS.forEach(function (pr) {
      const fg = hex(p[pr[0]]), bg = hex(p[pr[1]]);
      if (!fg || !bg) { bad.push(pr[0] + "/" + pr[1] + " is not a #rrggbb colour"); return; }
      const r = ratio(fg, bg);
      if (r < pr[2]) bad.push(pr[0] + "/" + pr[1] + " " + r.toFixed(2) + ":1");
    });
    check("theme " + t.id + " is legible", bad.length === 0, bad.join(", "));
  });
}

function testTheme() {
  section("theme resolution");
  const { THEMES, resolveTheme, DEFAULT_THEME } = require(path.join(__dirname, "..", "..", "native", "qml", "js", "theme.mjs"));

  check("eleven themes are offered", THEMES.length === 11, String(THEMES.length));
  check("terminal is the default", DEFAULT_THEME === "terminal");
  check("terminal is in the list", THEMES.some(function (t) { return t.id === "terminal"; }));
  check("pixel is in the list", THEMES.some(function (t) { return t.id === "pixel"; }));
  check("midnight is in the list", THEMES.some(function (t) { return t.id === "midnight"; }));
  check("every theme has an id and a name", THEMES.every(function (t) { return t.id && t.name; }));
  check("ids are unique",
    new Set(THEMES.map(function (t) { return t.id; })).size === THEMES.length);
  // Only the themes carrying a texture are marked, so the Appearance toggle
  // knows when it is worth showing. Task 3's test proves this agrees with the
  // CSS; this one just pins the count.
  check("six themes carry decoration",
    THEMES.filter(function (t) { return t.decor; }).length === 6,
    THEMES.filter(function (t) { return t.decor; }).map(function (t) { return t.id; }).join());

  check("a saved theme is honoured", resolveTheme("paper") === "paper");
  check("midnight can still be chosen", resolveTheme("midnight") === "midnight");
  check("pixel can still be chosen", resolveTheme("pixel") === "pixel");
  check("nothing saved yields the default", resolveTheme(null) === "terminal");
  check("an empty string yields the default", resolveTheme("") === "terminal");
  // A theme removed in a later version must not leave the app unstyled - every
  // token would go unresolved, which renders as black text on white.
  check("an unknown theme falls back", resolveTheme("vaporwave-deluxe") === "terminal");
  check("a non-string falls back", resolveTheme({ id: "paper" }) === "terminal");
}

function testFlow() {
  section("project flow");
  const F = require(path.join(__dirname, "..", "..", "native", "qml", "js", "flow.mjs"));
  const by = function (list) { const o = {}; list.forEach(function (s) { o[s.id] = s.status; }); return o; };

  let s = by(F.stages({}));
  check("five stages in order", F.stages({}).map(function (x) { return x.id; }).join() === "describe,plan,build,test,ship");
  check("a fresh project's next step is to describe it", s.describe === "next" && s.plan === "todo");
  check("only one stage is next", F.stages({}).filter(function (x) { return x.status === "next"; }).length === 1);

  s = by(F.stages({ messages: 2 }));
  check("a message is a description", s.describe === "done" && s.plan === "next");
  s = by(F.stages({ plan: true }));
  check("a plan implies a description", s.describe === "done" && s.plan === "done" && s.build === "next");

  s = by(F.stages({ messages: 1, plan: true, stepsTotal: 5, stepsDone: 2, building: true }));
  check("a running build is active, and nothing after it is next", s.build === "active" && s.test === "todo");
  s = by(F.stages({ messages: 1, plan: true, stepsTotal: 5, stepsDone: 2, stepsFailed: 1 }));
  check("a stopped build with a failure says so", s.build === "failed" && s.test === "todo");
  s = by(F.stages({ messages: 1, plan: true, stepsTotal: 5, stepsDone: 5 }));
  check("every step finished is built", s.build === "done" && s.test === "next");
  s = by(F.stages({ messages: 1, plan: true, stepsTotal: 0, stepsDone: 0 }));
  check("a plan with no steps is not built", s.build === "next");

  s = by(F.stages({ messages: 1, plan: true, stepsTotal: 3, stepsDone: 3, tested: true, shipped: true }));
  check("everything done", s.describe === "done" && s.ship === "done");
  check("nothing next when everything is done", F.nextStage(F.stages({ messages: 1, plan: true, stepsTotal: 3, stepsDone: 3, tested: true, shipped: true })) === null);

  s = by(F.stages({ shipped: true, tested: true }));
  check("a push with nothing built is not a shipped project", s.ship === "todo" && s.test === "todo" && s.describe === "next");
  check("garbage counts are ignored", by(F.stages({ plan: true, stepsTotal: "7", stepsDone: -1 })).build === "next");
  check("each stage knows its tab", F.STAGES.every(function (x) { return ["chat", "build", "test", "push"].indexOf(x.mode) !== -1; }));
  check("the next stage says what to do", /plan/i.test(F.nextStage(F.stages({ messages: 1 })).next));
}

function testCodeView() {
  section("code panel vocabulary");
  const V = require(path.join(__dirname, "..", "..", "native", "qml", "js", "code-view.mjs"));
  check("a slash command parses with its argument", JSON.stringify(V.parseSlash("/mode plan")) === JSON.stringify({ cmd: "/mode", arg: "plan", known: true }));
  check("aliases resolve", V.parseSlash("/undo").cmd === "/rewind" && V.parseSlash("/reset").cmd === "/clear");
  check("ordinary text is not a command", V.parseSlash("fix the /api route") === null && V.parseSlash("/usr/bin/env python") === null);
  check("an unknown command is flagged", V.parseSlash("/frob").known === false);
  check("the popup filters by prefix", V.matchCommands("/pl").map(function (c) { return c.name; }).join() === "/plan");
  check("mode words are forgiving", V.modeFromWord("accept") === "acceptEdits" && V.modeFromWord("YOLO") === "auto" && V.modeFromWord("x") === null);
  check("shift+tab never cycles into auto", V.nextMode("default") === "acceptEdits" && V.nextMode("acceptEdits") === "plan" && V.nextMode("auto") === "default");
  check("shift+tab walks the job modes and wraps", V.nextMode("plan") === "build" && V.nextMode("build") === "test" && V.nextMode("test") === "research" && V.nextMode("research") === "ship" && V.nextMode("ship") === "default");
  check("job modes have words", V.modeFromWord("tests") === "test" && V.modeFromWord("search") === "research" && V.modeFromWord("push") === "ship" && V.modeFromWord("builder") === "build");
  check("job modes ride on an agent mode", V.agentModeOf("build") === "acceptEdits" && V.agentModeOf("test") === "default" && V.agentModeOf("ship") === "default" && V.agentModeOf("research") === "plan" && V.agentModeOf("plan") === "plan" && V.agentModeOf("auto") === "auto");
  check("a job mode puts its job above the words", /^\[Build mode\]/.test(V.modePrompt("build", "a todo app")) && /a todo app$/.test(V.modePrompt("build", "a todo app")));
  check("plain modes send the words as typed", V.modePrompt("default", " fix it ") === "fix it" && V.modePrompt("plan", "x") === "x");
  check("an empty line is nothing, except in ship", V.modePrompt("default", "") === null && V.modePrompt("build", "  ") === null && /commit/.test(V.modePrompt("ship", "")));
  check("build starts the program, headless when it has a window", /start the program itself/.test(V.modePrompt("build", "x")) && /SDL_VIDEODRIVER=dummy/.test(V.modePrompt("build", "x")));
  check("an order to make a thing reads as a build", ["build me a snake game with pygame", "Make a todo app in React", "please create a simple calculator", "can you write a script that renames my photos", "i want you to build a website for my bakery", "can you build me a snake game?"].every(V.looksLikeBuild));
  check("a question about building does not", !["how do I build a game in pygame?", "what is the best way to make an app", "build the project and fix the errors", "write a summary of the diff", "commit the snake game"].some(V.looksLikeBuild));
  check("the test directive never weakens tests", /never weaken or delete a test/.test(V.modePrompt("test", "x")));
  check("ship never force-pushes", /Never force-push/.test(V.modePrompt("ship", "x")));
  check("the old tabs are commands", ["/build", "/test", "/research", "/ship", "/steps", "/runner", "/github", "/settings"].every(function (c) { return V.parseSlash(c).known; }));
  check("tab words alias to their mode", V.parseSlash("/push").cmd === "/ship" && V.parseSlash("/search x").cmd === "/research" && V.parseSlash("/search x").arg === "x");
  check("every job mode has its own label", ["build", "test", "research", "ship"].every(function (m) { const l = V.modeLabel(m); return l.cls === m && new RegExp(m + " mode on").test(l.text); }));
  check("choosing auto warns that what the agent reads can steer it", /without asking/.test(V.AUTO_WARNING) && /command output/.test(V.AUTO_WARNING) && /not a sandbox/.test(V.AUTO_WARNING));
  check("each mode has a label", /accept edits on/.test(V.modeLabel("acceptEdits").text) && /plan mode on/.test(V.modeLabel("plan").text) && V.modeLabel("default").text === "? for shortcuts");
  check("tools are titled like a terminal agent's", V.toolTitle({ name: "read", input: { path: "a.py" } }).verb === "Read" && V.toolTitle({ name: "edit", input: {} }).verb === "Update" && V.toolTitle({ name: "bash", input: { command: "npm test" } }).arg === "npm test");
  check("a search title names its pattern", /pattern: "TODO"/.test(V.toolTitle({ name: "grep", input: { pattern: "TODO" } }).arg));
  check("summaries: read", V.toolSummary({ name: "read", status: "done", detail: { lines: 1 } }) === "Read 1 line");
  check("summaries: edit counts changes", V.toolSummary({ name: "edit", status: "done", detail: { path: "a.py", before: "a\nb\n", after: "a\nc\nd\n" } }) === "Updated a.py with 2 additions and 1 removal");
  check("summaries: write", V.toolSummary({ name: "write", status: "done", detail: { path: "n.py", created: true, after: "x\ny\n" } }) === "Wrote 2 lines to n.py");
  const long = V.toolSummary({ name: "bash", status: "done", detail: { output: "1\n2\n3\n4\n5" } });
  check("summaries: long command output is folded", /^1\n2\n3\n.*\+2 lines/.test(long), long);
  check("summaries: declined and errors", V.toolSummary({ status: "denied", summary: "declined by the user" }) === "User declined" && /^Error: nope/.test(V.toolSummary({ status: "error", output: "Error: nope" })));
  check("tones", V.toolTone("done") === "ok" && V.toolTone("denied") === "err" && V.toolTone("waiting") === "wait");
  check("an edit can be allowed for the session", V.permissionOptions({ tool: "edit" }).map(function (o) { return o.key; }).join() === "allow,always,deny");
  check("a command names what it would remember", /npm test commands/.test(V.permissionOptions({ tool: "bash", rememberAs: "npm test" })[1].label));
  check("an always-ask command cannot be remembered", V.permissionOptions({ tool: "bash", alwaysAsk: true, rememberAs: "rm" }).length === 2);
  check("the @ under the caret is found", JSON.stringify(V.mentionAt("see @src/ap", 11)) === JSON.stringify({ query: "src/ap", start: 4 }) && V.mentionAt("me@x.com", 8) === null);
  const done = V.completeMention("see @src/ap now", 11, "src/app.py");
  check("completing a mention replaces the word", done.text === "see @src/app.py  now" && done.caret === 16, JSON.stringify(done));
  check("file ranking prefers a basename match", V.rankFiles(["lib/zapp.js", "src/app.py", "docs/apple.md"], "app", 3)[0] === "src/app.py");
  check("elapsed reads naturally", V.elapsed(4200) === "4s" && V.elapsed(75000) === "1m 15s");
  check("the help lists every command", V.COMMANDS.every(function (c) { return V.HELP.indexOf(c.name) !== -1; }));
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

  // The packaging stages build/icon.png, and the installers and the
  // AppImage want one of at least 512x512.
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
  const { languageMark } = require(path.join(__dirname, "..", "..", "native", "qml", "js", "language-mark.mjs"));

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
  const { languageToken } = require(path.join(__dirname, "..", "..", "native", "qml", "js", "language-mark.mjs"));
  check("many languages have an accent", ["main.go", "App.kt", "Main.scala", "Program.cs", "app.rb", "index.php", "init.lua", "lib.ex", "Main.hs",
    "main.zig", "App.swift", "main.dart", "core.clj", "script.jl", "run.sh", "Main.fs", "app.ts", "page.vue"].every(function (f) { return languageMark(f).token !== "--lang-default"; }));
  check("kin share an accent", languageMark("App.kt").token === "--lang-java" && languageMark("main.go").token === "--lang-c" && languageMark("Main.hs").token === "--lang-rs");
  check("language names map like extensions", languageToken("Rust") === "--lang-rs" && languageToken("TypeScript") === "--lang-js" && languageToken("go") === "--lang-c" && languageToken("C#") === "--lang-java");
  check("an unknown language name falls back", languageToken("brainfuck") === "--lang-default" && languageToken(undefined) === "--lang-default");
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
  const { hasChromium } = require(path.join(__dirname, "..", "..", "native", "qml", "js", "browser-check.mjs"));

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

  // Captured from a real failed install behind a proxy that blocks the CDN.
  const B = require(path.join(__dirname, "..", "..", "native", "qml", "js", "browser-check.mjs"));
  const ESC = String.fromCharCode(27);
  const blockedLog = [
    "Downloading Chrome for Testing 151.0.7922.34 (playwright chromium v1234)" + ESC + "[2m from https://cdn.playwright.dev/x.zip" + ESC + "[22m",
    "Error: Download failed: server returned code 403 body 'request blocked: no rule or allowlist entry allows host \"cdn.playwright.dev\"'. URL: https://cdn.playwright.dev/x.zip",
    "    at ClientRequest.<anonymous> (coreBundle.js:1:1)",
    "Failed to install browsers",
    "Error: Failed to download Chrome for Testing 151.0.7922.34 (playwright chromium v1234), caused by",
    "Error: Download failure, code=1",
  ].join("\n");
  check("colour codes are stripped from progress",
    B.stripAnsi(blockedLog.split("\n")[0]).indexOf(ESC) === -1 && /\(playwright chromium v1234\) from https/.test(B.stripAnsi(blockedLog)));
  const why = B.describeInstallFailure(blockedLog, 1);
  check("a failed download names the real reason, not the last generic line",
    /server returned code 403/.test(why) && !/Download failure, code=1/.test(why), why);
  check("and does not say 'Download failed' twice", why.indexOf("Download failed") === why.lastIndexOf("Download failed"), why);
  check("and a blocked download says which host to allow", /cdn\.playwright\.dev - a proxy or firewall/.test(why), why);
  check("a failure with no reason still reads as a sentence",
    B.describeInstallFailure("Failed to install browsers\n", 1) === "Download failed (exit 1). Check the connection and try again.");
  check("a failure that is not the network does not blame the network",
    !/firewall/.test(B.describeInstallFailure("Error: ENOSPC: no space left on device", 1)));
  check("a very long reason is cut", B.describeInstallFailure("Error: " + "x".repeat(1000), 1).length < 300);
  // The gate is AgentService.cpp, which carries a C++ copy of both. No Qt test
  // drives it, so the copy is held to the same patterns and sentences.
  const agent = readNative("src/AgentService.cpp");
  check("the gate uses them", /describeInstallFailure\(\*output/.test(agent) && /hasChromium\(entries\)/.test(agent));
  check("the gate counts the same browser builds", agent.indexOf('"^chromium-\\\\d+$"') !== -1);
  check("the gate skips the same generic lines",
    agent.indexOf("^(Failed to install browsers|Error: Failed to download |Error: Download failure, code=)") !== -1);
  check("the gate knows the same network failures",
    agent.indexOf("(403|407|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|blocked|proxy)") !== -1);
  check("the gate says the same things",
    agent.indexOf(". Check the connection and try again.") !== -1 &&
      agent.indexOf(" The browser downloads from cdn.playwright.dev - a proxy or firewall has to allow it.") !== -1 &&
      /reason\.left\(237\)/.test(agent));
}

function testBuildConfig() {
  section("build configuration");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const app = JSON.parse(readNative("package/app.json"));
  const stage = readNative("package/stage.mjs");

  // No Electron: nothing may quietly bring it back.
  const dev = pkg.devDependencies || {};
  check("Electron is not a dependency", !dev.electron && !dev["electron-builder"] && !(pkg.dependencies || {}).electron,
    Object.keys(dev).join(","));
  check("there is no electron-builder config", pkg.build === undefined);
  check("there is no Electron entry point", pkg.main === undefined, String(pkg.main));
  check("desktop is not a workspace", (pkg.workspaces || []).indexOf("desktop") === -1, (pkg.workspaces || []).join(","));
  // Was pinned to the literal "1.0.0", so the first patch release failed a test
  // that had nothing to do with the change. Nothing in the app hardcodes a
  // version - CMake reads package.json - so what is worth asserting is that the
  // version is well formed and that the release workflow will accept a tag for
  // it, not what the digits happen to be.
  check("the version is well formed", /^\d+\.\d+(\.\d+)?$/.test(pkg.version), String(pkg.version));
  check("the workspaces follow it",
    ["local-agent", "shared"].every(function (w) {
      return JSON.parse(fs.readFileSync(path.join(ROOT, w, "package.json"), "utf8")).version === pkg.version;
    }));
  // Quoted literals only. The first version of this flagged a comment that
  // mentioned the release it was describing, which is prose, not a hardcoded
  // version - and a check that punishes explaining yourself is a bad check.
  const hard = readNativeTree("src", [".cpp", ".h"]).concat(readNativeTree("qml", [".qml", ".mjs"]))
    .filter(function (f) { return /["'`]\d+\.\d+\.\d+["'`]/.test(f.text); }).map(function (f) { return f.file; });
  check("no source file hardcodes a version as a string literal", hard.length === 0, hard.join(", "));

  check("there is an app id", typeof app.id === "string" && /^[a-z]+(\.[a-z]+)+$/.test(app.id), String(app.id));
  check("windows builds an nsis installer", /makensis/.test(stage) && fs.existsSync(path.join(NATIVE, "package", "installer.nsi")));
  check("linux builds an appimage", /\.AppImage`/.test(stage));
  check("linux builds a deb", /\.deb\b/.test(stage) && typeof app.debName === "string");
  check("the icon is staged from build/", /join\(ROOT, 'build', 'icon\.png'\)/.test(stage));
  check("the icon exists", fs.existsSync(path.join(ROOT, "build", "icon.png")));

  // --- the check that matters most ---
  // local-agent/storage holds live session cookies and private chat URLs. The
  // stage copies named directories only, so a mistake is a missing file rather
  // than a published credential. verify.mjs also walks a real stage for them.
  const at = stage.indexOf("function stageAgent(");
  const body = stage.slice(at, stage.indexOf("\n}\n", at));
  const copies = [...body.matchAll(/cpSync\(join\(src, '([^']+)'\)/g)].map(function (m) { return m[1]; });
  check("the agent's stage copies only its dist and config",
    at !== -1 && copies.sort().join() === "config,dist", copies.join(","));
  check("nothing copies the whole agent directory", !/cpSync\(src\b/.test(body));
  ["storage", ".superpowers", "docs", "samples"].forEach(function (dir) {
    check("the stage never names " + dir, body.indexOf("'" + dir + "'") === -1);
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

function testGitHubSafe() {
  section("github safety");
  const s = require(path.join(__dirname, "..", "..", "native", "qml", "js", "github-safe.mjs"));

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
  check("a desktop Chromium does not recognise is pointed at the keyring",
    s.linuxPasswordStore("linux", "Hyprland", false) === "gnome-libsecret" && s.linuxPasswordStore("linux", undefined, false) === "gnome-libsecret");
  check("a desktop Chromium recognises keeps its own choice",
    s.linuxPasswordStore("linux", "ubuntu:GNOME", false) === null && s.linuxPasswordStore("linux", "KDE", false) === null);
  check("a --password-store the user passed wins", s.linuxPasswordStore("linux", "sway", true) === null);
  check("only Linux is touched", s.linuxPasswordStore("win32", "", false) === null);
}

/**
 * The bug this guards against is invisible in normal use: it only fires when
 * someone types a semicolon. Asserting against the source is crude, but it is
 * the only way to catch a regression with no runtime symptom until it has one.
 */
function testGitSpawnHardening() {
  section("git spawn hardening");
  const src = readNative("src/GitService.cpp");
  const at = src.indexOf("void GitService::git(");
  const gitBlock = src.slice(at, src.indexOf("\n}\n", at));
  check("the git handler exists", at !== -1 && gitBlock.length > 100);
  // QProcess passes arguments as a list: there is no shell to concatenate them.
  check("git does not run through a shell",
    /GitRunner::run\(/.test(gitBlock) && !/(\/bin\/sh|cmd\.exe|"-c"|bash)/.test(gitBlock), gitBlock.slice(0, 200));
  check("git arguments are validated", /GitHubSafe::safeGitArgs/.test(gitBlock));
  check("git output is redacted", /GitHubSafe::redactToken/.test(gitBlock));
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

  // The app's Download button does the same.
  const agent = readNative("src/AgentService.cpp");
  check("the app resolves it the same way",
    /node_modules\/playwright\/package\.json/.test(agent) && /cli\.js/.test(agent));

  // And the packaging must hand Playwright to the app as real files: it
  // resolves and spawns executables. The stage ships the agent's dependency
  // closure, so playwright and the playwright-core it requires both go.
  const agentPkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));
  check("playwright is an agent dependency, so it is staged", !!(agentPkg.dependencies || {}).playwright);
  check("playwright-core comes with it",
    !!(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")).dependencies || {})["playwright-core"]);
  check("the stage follows dependencies", /queue\.push\(\.\.\.Object\.keys\(meta\.dependencies/.test(readNative("package/stage.mjs")));
}

function testStorageRoot() {
  section("the CLI and the app share one browser profile");
  const S = require(path.join(DIST, "storage-paths.js"));

  // The bug this exists for, found by the first live smoke run: the desktop app
  // sets CLOSENI_STORAGE to its storage root and every agent it spawns
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

  // The name has to match the directory the app creates, or the CLI points at
  // a directory that has never been signed in to.
  check("the app name matches package.json productName",
    require(path.join(__dirname, "..", "..", "package.json")).productName === "CloseNI");
  check("and the native app's storage root uses it",
    /kAppName = "CloseNI"/.test(readNative("src/Paths.cpp")));

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
  const src = path.join(__dirname, "..", "src");
  const agentSrc = ["index.ts", "cli-io.ts", "workspace-env.ts",
    ...fs.readdirSync(path.join(src, "modes")).filter((f) => f.endsWith(".ts")).map((f) => path.join("modes", f))]
    .map((f) => fs.readFileSync(path.join(src, f), "utf8")).join("\n");
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
  // A real server reports a tool failure as a SUCCESSFUL result carrying
  // isError, with the message as ordinary text - JSON-RPC error is only for
  // protocol failures. Found against @modelcontextprotocol/server-everything:
  // our client returned ok:true with "MCP error -32602: Tool not found" as the
  // text, so a misconfigured tool would have folded its own error message into
  // every step's prompt, presented as fetched context.
  const toolErr = await M.callTool(spec("toolerror"), "nope", {});
  check("a tool error in the result is a failure, not content", toolErr.ok === false, JSON.stringify(toolErr));
  check("and the message is reported as an error", /Tool not found/.test(toolErr.error || ""), toolErr.error);
  check("its text is not returned as if it were context", !toolErr.text, JSON.stringify(toolErr.text));

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
  // Fetching a skill file from GitHub (getFile) is checked in
  // native/tests/tst_github.cpp.
  const lib = readNative("src/LibraryService.h");
  const libSrc = readNative("src/LibraryService.cpp");
  const agent = readNative("src/AgentService.cpp");
  const settings = readNative("qml/panels/SettingsPanel.qml");
  const store = readNative("qml/singletons/SettingsStore.qml");
  const code = readNative("qml/singletons/CodeStore.qml");
  const build = readNative("qml/singletons/BuildState.qml");

  check("the app exposes skill management",
    /Q_INVOKABLE void listSkills/.test(lib) && /Q_INVOKABLE void writeSkill/.test(lib) && /Q_INVOKABLE void deleteSkill/.test(lib));
  check("and MCP configuration", /Q_INVOKABLE void readMcpConfig/.test(lib) && /Q_INVOKABLE void writeMcpConfig/.test(lib));
  check("the service refuses an unsafe skill name",
    (libSrc.match(/SkillStore::isSafeName/g) || []).length >= 3);
  check("there is a Skills settings section", /Library\.listSkills\(/.test(settings));
  check("the agent gets the preamble as AGENT_PREAMBLE", /"AGENT_PREAMBLE"/.test(agent));
  check("the app builds one", /function buildPreamble\(/.test(store) && /function buildPreamble\(/.test(code));
  check("MCP context is gathered before the work, not per step",
    /gatherMcpContext/.test(store) && /gatherMcpContext/.test(build) &&
      !/gatherMcpContext/.test(fs.readFileSync(path.join(JS, "builder-logic.mjs"), "utf8")));
}

function testRecentWorkspaces() {
  section("the projects you have been working on");
  const R = require(path.join(__dirname, "..", "..", "native", "qml", "js", "recent-workspaces.mjs"));

  check("an empty list starts empty", JSON.stringify(R.parse(null)) === "[]");
  check("garbage reads as empty", JSON.stringify(R.parse("{{")) === "[]");
  check("a non-array reads as empty", JSON.stringify(R.parse('{"a":1}')) === "[]");
  check("non-strings are dropped", JSON.stringify(R.parse('["/a",7,null,"/b"]')) === '["/a","/b"]');

  let list = R.remember([], "/projects/one");
  check("the first workspace is remembered", JSON.stringify(list) === '["/projects/one"]');
  list = R.remember(list, "/projects/two");
  check("the newest is first", JSON.stringify(list) === '["/projects/two","/projects/one"]');

  // Re-opening a project you already have must move it up, not duplicate it -
  // a list with the same path twice is a list nobody trusts.
  list = R.remember(list, "/projects/one");
  check("re-opening moves it to the top rather than duplicating",
    JSON.stringify(list) === '["/projects/one","/projects/two"]', JSON.stringify(list));
  check("and the length does not grow", list.length === 2);

  // The cap keeps the rail readable.
  let many = [];
  for (let i = 0; i < 12; i++) many = R.remember(many, "/p/" + i);
  check("the list is capped", many.length === R.MAX_RECENT, String(many.length));
  check("the cap is 8", R.MAX_RECENT === 8);
  check("the oldest fell off the end", many.indexOf("/p/0") === -1);
  check("the newest is still first", many[0] === "/p/11");

  check("forgetting removes one", JSON.stringify(R.forget(["/a", "/b"], "/a")) === '["/b"]');
  check("forgetting something absent changes nothing",
    JSON.stringify(R.forget(["/a"], "/zzz")) === '["/a"]');
  check("an empty path is never remembered",
    JSON.stringify(R.remember(["/a"], "")) === '["/a"]' &&
    JSON.stringify(R.remember(["/a"], null)) === '["/a"]');
  check("whitespace is trimmed before comparing",
    JSON.stringify(R.remember(["/a"], "  /a  ")) === '["/a"]');

  // What the rail shows beside each path.
  check("a finished build reads as done", R.describe({ done: 5, total: 5 }) === "done");
  check("a partial build shows both numbers", R.describe({ done: 7, total: 18 }) === "7/18");
  check("no plan says so", R.describe(null) === "no plan");
  check("a missing folder says so, and is not confused with an empty one",
    R.describe({ missing: true }) === "missing");
  check("zero of zero is not 'done'", R.describe({ done: 0, total: 0 }) === "no plan");
}

function testOnboarding() {
  section("a first launch is told what to do, in order");
  const O = require(path.join(__dirname, "..", "..", "native", "qml", "js", "onboarding.mjs"));
  const ids = function (st) { return O.steps(st).map(function (x) { return x.id; }).join(","); };

  const fresh = { browserReady: true, workspace: "", account: "unknown", providerName: "DeepSeek", chatted: false };
  check("the order is browser, folder, sign-in, first prompt",
    ids(fresh) === "browser,workspace,signin,prompt", ids(fresh));
  check("a fresh install starts at the folder", O.current(fresh) === "workspace");
  check("with no browser, the browser comes first",
    O.current(Object.assign({}, fresh, { browserReady: false })) === "browser");
  check("an unknown browser state is not reported missing",
    O.steps({}).find(function (x) { return x.id === "browser"; }).done === true);

  // The account light starts unknown and costs a browser launch to check, so
  // unknown must never read as signed out - that would send someone already
  // signed in through the sign-in window again.
  const withFolder = Object.assign({}, fresh, { workspace: "/w" });
  const unknownStep = O.steps(withFolder).find(function (x) { return x.id === "signin"; });
  check("an unchecked account offers a check, not a sign-in", unknownStep.action === "Check", unknownStep.action);
  check("and says it may already be signed in", /already be signed in/.test(unknownStep.detail));
  const off = O.steps(Object.assign({}, withFolder, { account: "off" })).find(function (x) { return x.id === "signin"; });
  check("a signed-out account offers sign-in", off.action === "Sign in");
  check("and explains the window before it opens", /window opens/.test(off.detail) && /closes by itself/.test(off.detail));
  check("the provider is named", /DeepSeek/.test(off.title) && /DeepSeek/.test(off.detail));
  check("the sign-in step says the terms are your call", /terms of use/.test(off.terms) && /your call/.test(off.terms));
  check("and links them when the provider has any",
    O.steps(Object.assign({}, withFolder, { termsUrl: "https://x/terms" })).find(function (x) { return x.id === "signin"; }).termsUrl === "https://x/terms" &&
      off.termsUrl === null);
  const busy = O.steps(Object.assign({}, withFolder, { account: "busy" })).find(function (x) { return x.id === "signin"; });
  check("a check in progress offers no button to press twice", busy.action === null && /Checking/.test(busy.title));

  const signedIn = Object.assign({}, withFolder, { account: "on" });
  check("signed in moves on to the first prompt", O.current(signedIn) === "prompt");
  check("which offers a worked example",
    O.steps(signedIn).find(function (x) { return x.id === "prompt"; }).action === "Use an example");
  check("and the guide is still visible", O.visible(signedIn, false) === true);

  const finished = Object.assign({}, signedIn, { chatted: true });
  check("once everything is done there is nothing current", O.current(finished) === null);
  check("and the guide goes away by itself", O.visible(finished, false) === false);
  check("a dismissed guide stays gone", O.visible(fresh, true) === false);
  check("only the stored word dismisses it",
    O.isDismissed("dismissed") && !O.isDismissed(null) && !O.isDismissed("") && !O.isDismissed("yes"));
  check("a done step has no button", O.steps(finished).every(function (x) { return x.action === null; }));
  check("no provider name still reads as a sentence",
    /your provider/.test(O.steps({ account: "off" }).find(function (x) { return x.id === "signin"; }).title));

  // The example is only worth anything if it plans small and asks for tests.
  check("the example names a file and a language", /convert\.py/.test(O.EXAMPLE_PROMPT) && /Python/.test(O.EXAMPLE_PROMPT));
  check("and asks for tests", /tests/.test(O.EXAMPLE_PROMPT));

  // Wiring: the guide reads real state, never a flag of its own. AppState's
  // binding is what redraws it when the account light, the folder or the
  // browser gate changes.
  const appState = readNative("qml/singletons/AppState.qml");
  const binding = (appState.match(/onboardingState: R\.onboardingState\(([^)]*)\)/) || [])[1] || "";
  check("there is somewhere to draw it",
    fs.existsSync(path.join(NATIVE, "qml", "components", "OnboardingGuide.qml")) &&
      /OnboardingGuide\s*\{/.test(readNative("qml/panels/ChatPanel.qml")));
  check("Settings can bring it back", /AppState\.resetOnboarding\(\)/.test(readNative("qml/panels/SettingsPanel.qml")));
  check("the account light updates it", /Providers\.acct/.test(binding), binding);
  check("opening a folder updates it", /\bworkspace\b/.test(binding), binding);
  check("the browser gate updates it", /\bbrowserReady\b/.test(binding), binding);
  check("and the provider list", /Providers\.list/.test(binding) && /Providers\.current/.test(binding), binding);

  // Every provider a person can sign in to has its terms on file, and they reach the guide.
  check("the provider list carries termsUrl to the app", /QStringLiteral\("termsUrl"\)/.test(readNative("src/FilesService.cpp")));
  check("the guide reads it from the provider",
    /termsUrl: p && p\.termsUrl/.test(fs.readFileSync(path.join(JS, "renderer-logic.mjs"), "utf8")));
  const provDir = path.join(__dirname, "..", "config", "providers");
  const noTerms = fs.readdirSync(provDir).filter(function (f) {
    const cfg = JSON.parse(fs.readFileSync(path.join(provDir, f), "utf8"));
    return cfg.enabled && !cfg.comingSoon && /^https:/.test(cfg.baseUrl) && !/^https:\/\//.test(cfg.termsUrl || "");
  });
  check("every selectable web provider links its terms", noTerms.length === 0, noTerms.join(", "));
  // A first launch lands on the Code panel, not the chat panel's guide, so the
  // sign-in and its terms are said there too.
  check("the Code panel's welcome has a place for the terms", /need\.termsUrl/.test(readNative("qml/panels/CodePanel.qml")));
  // A binding on the guide's steps, so it redraws when the account light changes.
  check("and fills it from the guide's sign-in step",
    /welcomeNeed: T\.welcomeNeed\(AppState\.workspace, AppState\.onboardingSteps\)/.test(readNative("qml/singletons/CodeStore.qml")));
}

// The QML engine runs native/qml/js/*.mjs, and lacks some of what Node has.
function testNativePorts() {
  section("the app's modules load in the QML engine");
  fs.readdirSync(JS).filter(function (f) { return f.endsWith(".mjs"); }).sort().forEach(function (f) {
    const src = fs.readFileSync(path.join(JS, f), "utf8");
    // The QML engine has none of these, and a module using one fails to load
    // in the app while passing every test here under Node.
    check(f + ": nothing the QML engine lacks",
      !/\basync\b|\bawait\b|\.flat\(|fromEntries|globalThis|\bwindow\.|\bdocument\.|localStorage\.|\brequire\(|\.\.\.[A-Za-z_({[]/.test(src.replace(/^\s*(\/\/|\*).*$/gm, "")));
  });
}

function testBuilderLogic() {
  section("the Build panel's decisions, without the panel");
  const B = require(path.join(JS, "builder-logic.mjs"));

  const planned = B.stepsFromPlan([
    { title: "a", detail: "do a", files: ["a.py"], dependsOn: [], testable: true },
    { title: "b", dependsOn: [0], testable: "yes" },
    { title: "c", dependsOn: "0" },
  ]);
  check("a plan's steps start pending with no result",
    planned.every(function (s) { return s.status === "pending" && s.result === null; }));
  check("dependsOn is carried across", JSON.stringify(planned[1].dependsOn) === "[0]" && Array.isArray(planned[0].dependsOn));
  check("a dependsOn that is not a list is dropped", planned[2].dependsOn === undefined);
  check("files default to none", Array.isArray(planned[1].files) && planned[1].files.length === 0);
  check("only a literal true is testable", planned[0].testable === true && planned[1].testable === false);
  const src = [{ title: "x", dependsOn: [1] }];
  check("dependsOn is copied, not shared", B.stepsFromPlan(src)[0].dependsOn !== src[0].dependsOn);

  const saved = B.stepsFromSaved([{ title: "a", status: "done", timing: { totalMs: 5 } }, { title: "b" }]);
  check("a saved build keeps its statuses and timings",
    saved[0].status === "done" && saved[0].timing.totalMs === 5 && saved[1].status === "pending");
  const plan = B.planFromSaved({ summary: "s", runCommand: "" }, saved);
  check("a restored plan keeps its summary", plan.summary === "s" && plan.runCommand === undefined);
  check("and hands back steps without statuses", plan.steps.length === 2 && plan.steps[0].status === undefined);
  check("a restored build with nothing done is ready", B.restoredStatus(0, 4).status === "ready: 4 steps" && B.restoredStatus(0, 4).log === "");
  check("one with steps done is resumable", B.restoredStatus(2, 4).status === "resumable: 2/4 done" && /2\/4 steps done/.test(B.restoredStatus(2, 4).log));

  const st = [{ status: "done" }, { status: "skipped" }, { status: "failed" }, { status: "pending" }];
  check("skipped counts as finished", B.finishedCount(st) === 2);
  const stats = B.buildStats(st, true);
  check("build stats count total, done, failed and running",
    stats.total === 4 && stats.done === 2 && stats.failed === 1 && stats.running === true);

  const idle = B.buttonVisibility("idle", st);
  check("idle shows Start and Retry when a step failed", idle.start && idle.retry && !idle.pause && !idle.stop);
  check("idle with nothing failed has no Retry", !B.buttonVisibility("idle", [{ status: "done" }]).retry);
  const running = B.buttonVisibility("running", st);
  check("running shows Pause, Skip and Stop", running.pause && running.skip && running.stop && !running.start && !running.resume);
  const paused = B.buttonVisibility("paused", st);
  check("paused shows Resume and Stop", paused.resume && paused.stop && !paused.pause);

  const p1 = B.stepPrompt({ summary: "a game" }, { title: "Board", detail: "Draw it.", files: ["board.py"] }, "");
  check("a step is told the overall goal and only its own work",
    p1 === "Overall: a game\n\nExecute ONLY this step: Board. Draw it. Expected files: board.py", JSON.stringify(p1));
  const p2 = B.stepPrompt(null, { title: "Board" }, "wrong colour");
  check("a rejection is carried into the next attempt",
    /^Overall: \n\nExecute ONLY this step: Board\. /.test(p2) && /What was wrong: wrong colour\nAddress that specifically\.$/.test(p2), JSON.stringify(p2));

  check("rollback is offered where a later step ran", B.rollbackOffered([{ status: "pending" }, { status: "done" }], 0, false));
  check("not while the build runs", !B.rollbackOffered([{ status: "done" }], 0, true));
  check("not where nothing ran", !B.rollbackOffered([{ status: "done" }, { status: "pending" }], 1, false));
  check("a rollback that undoes nothing has no message", B.rollbackMessage({ steps: [] }, 2) === "");
  const msg = B.rollbackMessage({ steps: [1, 2], restore: { a: 1 }, remove: ["b", "c"], drifted: ["d.py"], unrestorable: ["big.bin"] }, 3);
  check("the rollback message counts what it undoes",
    /^Roll back to before step 4\?\n\nThis undoes 2 steps: 1 file\(s\) restored, 2 removed\./.test(msg), msg);
  check("and names hand-edited and unsaved files", /will be lost:\n  d\.py/.test(msg) && /left as they are:\n  big\.bin/.test(msg));
  check("one step is singular", /undoes 1 step:/.test(B.rollbackMessage({ steps: [1] }, 0)));

  const timing = { totalMs: 65000, phases: { thinking: 60000, applying: 5000 } };
  const tt = B.timingText(timing);
  check("the time card shows the total and padded phases",
    tt.total === "1m 05s" && /^thinking {6}1m 00s\napplying {6}5.0s$/.test(tt.body), JSON.stringify(tt));
  check("no phases says so", B.timingText({ totalMs: 0, phases: {} }).body === "(no phases recorded)");
  check("the step's time log line", B.stepTimingLog(0, timing) === "step 1 took 1m 05s (thinking 1m 00s, applying 5.0s)",
    B.stepTimingLog(0, timing));
  const roll = B.buildTimingLog([{ timing: timing }, {}]);
  check("the build's time is summed across timed steps", roll[0] === "build time 1m 05s across 1 step(s)" && roll.length === 3, JSON.stringify(roll));
  check("an untimed build logs nothing", B.buildTimingLog([{}]).length === 0);

  check("unusable dependencies are an error", B.dependencyLog({ reason: "cycle", graph: [] }).tone === "err");
  check("declared dependencies count the independent steps",
    B.dependencyLog({ declared: true, graph: [[], [], [0]] }).text === "plan declares its own dependencies; 1 step(s) do not wait on anything");
  check("an undeclared plan logs nothing", B.dependencyLog({ graph: [[], [0]] }) === null);
  check("diff marks", B.diffMark("add") === "+" && B.diffMark("remove") === "-" && B.diffMark("same") === " ");
  check("a file preview is opened from the workspace", B.previewUrl("file", "/w", "index.html") === "file:///w/index.html");
  check("a server preview is opened as is", B.previewUrl("server", "/w", "http://localhost:5000") === "http://localhost:5000");
  check("only done, failed and running steps move", B.PIX_MOTION.done === "pix-stamp" && B.PIX_MOTION.pending === undefined);
}

function testCodeLogic() {
  section("the Code panel's decisions, without the panel");
  const C = require(path.join(JS, "code-logic.mjs"));

  const rows = C.numberDiff("a\nb\nc\n", "a\nB\nc\nd\n");
  check("an edit's diff is numbered by side",
    rows.map(function (r) { return r.sign + r.ln + r.text; }).join("|") === " 1a|-2b|+2B| 3c|+4d", rows.map(function (r) { return r.sign + r.ln + r.text; }).join("|"));
  const long = Array.from({ length: 30 }, function (_, i) { return "l" + i; });
  const edited = long.slice(); edited[25] = "X";
  const gapped = C.numberDiff(long.join("\n"), edited.join("\n"));
  const gap = gapped.find(function (r) { return r.type === "gap"; });
  const change = gapped.find(function (r) { return r.type === "add"; });
  check("a gap moves both sides on", !!gap && gap.ln === "" && change && change.ln === 26, JSON.stringify(gapped.slice(0, 3)));

  check("todo boxes", C.todoBox("done") === "☒" && C.todoBox("in_progress") === "◼" && C.todoBox("pending") === "☐");
  check("todos show while something is left", C.todosVisible([{ status: "done" }, { status: "pending" }]));
  check("and hide when all are done or there are none", !C.todosVisible([{ status: "done" }]) && !C.todosVisible([]) && !C.todosVisible(null));
  check("build mode with no list explains itself", /^Say what to build/.test(C.buildModeInfo([])));
  check("build mode counts steps and names the current one",
    C.buildModeInfo([{ status: "done" }, { status: "in_progress", text: "tests" }]) === "1/2 steps done · now: tests");
  check("build progress", C.buildModeProgress([{ status: "done" }, { status: "x" }]) === 0.5 && C.buildModeProgress([]) === null);
  check("test mode names the run command and its source", C.testModeInfo({ command: "npm start", source: "plan" }) === "run: npm start  (plan)");
  check("test mode with no command", /^No run command yet/.test(C.testModeInfo(null)));
  check("ship mode outside git", /^Not a git repository/.test(C.shipModeInfo(false, "")));
  check("ship mode reads branch, ahead, behind and changes",
    /^on main ↑2 ↓1 · 2 changed files\./.test(C.shipModeInfo(true, "## main...origin/main [ahead 2, behind 1]\n M a\n?? b\n")),
    C.shipModeInfo(true, "## main...origin/main [ahead 2, behind 1]\n M a\n?? b\n"));
  check("a clean tree says so", /^on dev · clean\./.test(C.shipModeInfo(true, "## dev\n")));

  check("checks: could not run", C.checksSummary(null).tone === "fail");
  check("checks: counts and not run", C.checksSummary({ passed: 2, failed: 1, skipped: 1 }).text === "2 passed, 1 failed, 1 not run"
    && C.checksSummary({ passed: 2, failed: 1 }).tone === "fail");
  check("checks: nothing ran says why", C.checksSummary({ note: "no tests" }).text === "no tests" && C.checksSummary({}).tone === "none");
  check("a passing row", C.testRow({ success: true, command: "x" }).mark === "✓");
  check("a skipped row is neither pass nor fail", C.testRow({ success: false, detail: "skipped: no pytest" }).kind === "skip");
  check("a failing row keeps the first detail line", C.testRow({ success: false, detail: "boom\nmore" }).detail === "boom"
    && C.testRow({ success: false, detail: "boom\nmore" }).multiline);
  check("failing checks are listed for the fix", C.failingChecks([{ success: true, command: "a" }, { success: false, command: "b", detail: "bad" }]) === "- b: bad");
  check("the fix prompt rides on test mode", /These checks failed\./.test(C.fixChecksPrompt([])));
  check("git diff line classes",
    ["+x", "+++ b", "-x", "--- a", "@@ -1 +1 @@", "diff --git", " x"].map(C.gitDiffLineClass).join(",") === "add,meta,del,meta,hunk,meta,");
  check("permission answers", C.permissionAnswerLabel("deny", "use yarn") === "No: use yarn"
    && C.permissionAnswerLabel("always") === "Yes, don't ask again" && C.permissionAnswerLabel("once") === "Yes");

  check("an interrupted turn says so", C.doneOutcome({ reason: "interrupted" }, "default").note === "Interrupted by user");
  check("a finished plan offers to build", C.doneOutcome({ reason: "complete" }, "plan", false, false).offer === "plan");
  check("a turn that changed files offers to run", C.doneOutcome({ reason: "complete" }, "default", true, false).offer === "run");
  check("so does a fix", C.doneOutcome({ reason: "complete" }, "default", false, true).offer === "run");
  check("a turn that changed nothing ends quietly", C.doneOutcome({ reason: "complete" }, "default", false, false) === null);
  check("rewound notes", C.rewoundNote([]) === "Nothing to rewind" && C.rewoundNote(["a"]) === "Rewound 1 file: a");
  check("compacting without a summary warns", C.compactedNote("").tone === "warn" && C.compactedNote("x").tone === "dim");
  check("the header shows provider and folder", C.metaText("DeepSeek", "/home/me/proj/") === "DeepSeek · proj");
  check("toggling a mode off says so", C.toggleNote("build", "default") === "Build mode off");
  check("toggling it on names it without the shortcut", !/shift\+tab/.test(C.toggleNote("build", "build")));
  check("memory lives at the project root", C.memoryPath("/w/") === "/w/CLOSENI.md" && C.memoryPath("C:\\w\\") === "C:\\w/CLOSENI.md");
  check("research is capped for the plan", C.researchPlanPrompt("x".repeat(7000)).length === "Using this research, plan how to apply it to this project:\n\n".length + 6000);
  check("the plan offer starts with build mode", C.PLAN_OFFER_OPTIONS[0].mode === "build" && C.PLAN_OFFER_OPTIONS[3].mode === null);

  const r1 = C.routeLine("research", "build me a snake game", "");
  check("a build request in research switches to build", r1.mode === "build" && /Build mode is on/.test(r1.switched) && !r1.research);
  const r2 = C.routeLine("research", "what is htmx", "");
  check("a question in research is a search", r2.research === "what is htmx" && r2.wire === "");
  const r3 = C.routeLine("ship", "", "");
  check("enter on an empty ship line commits", r3.shown === "review, test and commit" && r3.wire.length > 0);
  const r4 = C.routeLine("plan", "fix it", "shown text");
  check("a line with its own label goes as is", r4.wire === "fix it" && r4.shown === "shown text");

  const h = ["one", "two", "three"];
  check("history up starts at the newest", C.historyUp(h, -1).index === 2 && C.historyUp(h, -1).text === "three");
  check("and stops at the oldest", C.historyUp(h, 0).index === 0);
  check("history down past the newest leaves history", C.historyDown(h, 2).index === -1 && C.historyDown(h, 2).text === "");
  check("history down moves newer", C.historyDown(h, 0).text === "two");
}

function testCodeTranscript() {
  section("the Code panel's transcript, as data");
  const T = require(path.join(JS, "code-transcript.mjs"));

  check("the transcript is bounded at 2000 entries", T.MAX_ENTRIES === 2000);
  check("nothing drops under the bound", T.overflow(1999) === 0 && T.overflow(2000) === 0);
  check("the oldest drop past it", T.overflow(2003) === 3 && T.overflow(12, 10) === 2);

  const edit = { name: "edit", status: "done", detail: { path: "a.py", before: "x = 1\n", after: "x = 2\n" } };
  check("a finished edit or write changed a file",
    T.toolChanged(edit) && T.toolChanged({ name: "write", status: "done" }));
  check("a read, a waiting edit or a failed one did not",
    !T.toolChanged({ name: "read", status: "done" }) && !T.toolChanged({ name: "edit", status: "waiting" }) &&
    !T.toolChanged({ name: "edit", status: "error" }));

  const diff = T.toolMore(edit);
  check("an edit folds out its diff, open at once",
    diff.kind === "diff" && diff.open === true && diff.rows.some(function (r) { return r.sign === "+" && r.text === "x = 2"; }),
    JSON.stringify(diff));
  const bash = T.toolMore({ name: "bash", status: "error", output: "boom" });
  check("a command folds out its output, left as the line was (even when it failed)",
    bash.kind === "out" && bash.text === "boom" && bash.open === null);
  const todo = T.toolMore({ name: "todo", status: "done", detail: { items: [{ text: "a", status: "pending" }] } });
  check("a todo update folds out the list, open", todo.kind === "todos" && todo.items.length === 1 && todo.open === true);
  check("any other finished tool folds out its output",
    T.toolMore({ name: "read", status: "done", output: "text" }).kind === "out");
  check("an unfinished tool with no output has nothing to fold",
    T.toolMore({ name: "read", status: "running" }) === null && T.toolMore({ name: "read", status: "done" }) === null);

  check("a command prompt shows the command",
    JSON.stringify(T.permissionBody({ tool: "bash", preview: { command: "ls -la" } })) === JSON.stringify({ kind: "cmd", text: "ls -la" }));
  check("or the input's command when there is no preview",
    T.permissionBody({ tool: "bash", input: { command: "pwd" } }).text === "pwd");
  const pd = T.permissionBody({ tool: "write", preview: { path: "new.py", before: "", after: "print(1)\n", created: true } });
  check("a write or edit prompt shows the path and the diff", pd.kind === "diff" && pd.path === "new.py" && pd.rows.length > 0);
  check("other prompts show nothing more", T.permissionBody({ tool: "read", preview: { path: ".env" } }) === null);

  const long = "x".repeat(T.OUTPUT_TAIL + 50) + "END";
  check("a card keeps the end of an output, where the error is",
    T.outputTail(long).length === T.OUTPUT_TAIL && /END$/.test(T.outputTail(long)));
  check("and no output is an empty one", T.outputTail(null) === "" && T.outputTail(undefined) === "");

  check("diff and show are drawn as diffs",
    T.gitShowsDiff(["diff"]) && T.gitShowsDiff(["show", "HEAD"]) && !T.gitShowsDiff(["status"]) && !T.gitShowsDiff(["log", "diff"]));
  const lines = T.gitDiffLines("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same");
  check("git diff lines are classed",
    lines.map(function (l) { return l.cls; }).join(",") === "meta,meta,meta,hunk,del,add,", JSON.stringify(lines));
  check("a git diff is capped", T.gitDiffLines("a".repeat(T.GIT_DIFF_CAP + 10))[0].text.length === T.GIT_DIFF_CAP);
  check("other git output is capped", T.gitOutput("b".repeat(T.GIT_OUT_CAP + 10)).length === T.GIT_OUT_CAP);

  const folder = T.welcomeNeed("", []);
  check("with no folder, the welcome asks for one first", folder.kind === "folder" && folder.text === "The agent works inside one folder. ");
  const signin = { id: "signin", title: "Sign in to DeepSeek", action: "Sign in", terms: "Read them.", termsUrl: "https://x", done: false };
  const need = T.welcomeNeed("/p", [{ id: "folder", done: true }, signin]);
  check("then the sign-in, with its terms",
    need.kind === "signin" && need.text === "Sign in to DeepSeek. " && need.action === "Sign in" &&
    need.terms === "Read them. " && need.termsUrl === "https://x", JSON.stringify(need));
  check("nothing once signed in", T.welcomeNeed("/p", [{ id: "signin", done: true }]) === null && T.welcomeNeed("/p", []) === null);

  check("a language's colour token", T.langToken("Python") === "--lang-py" && T.langToken("") === "");
  const rows = T.checkRows([
    { command: "pytest", success: false, detail: "1 failed\nE assert", language: "Python" },
    { command: "cargo test", success: true, detail: "" },
  ]);
  check("a check row carries its language and, when multi-line, the whole detail",
    rows[0].kind === "fail" && rows[0].language === "Python" && rows[0].output === "1 failed\nE assert" &&
    rows[1].kind === "pass" && rows[1].language === "" && rows[1].output === "");

  check("a repository's stars, and a dot before its language",
    T.repoMeta({ stars: 12, language: "Rust" }) === "★ 12 · " && T.repoMeta({}) === "★ 0");
  check("the sources heading names where they came from",
    T.sourcesTitle("web search") === "Sources · via web search" && T.sourcesTitle("") === "Sources");
  check("a clone asks about the licence",
    /^Clone a\/b into your workspace\?\n\nIt carries MIT, /.test(T.cloneQuestion("a/b", "MIT")) &&
    /an unknown licence/.test(T.cloneQuestion("a/b", "")));
  check("a fix for another folder says which", /ran \/other, not the open project/.test(T.runFixElsewhere("/other")));
  check("the spinner says how long and how to stop", T.spinnerMeta(65000) === "(1m 5s · esc to interrupt)");
}

function testRendererLogic() {
  section("the renderer's decisions, without the renderer");
  const R = require(path.join(JS, "renderer-logic.mjs"));

  check("every rail mode has a title", Object.keys(R.MODE_TITLES).join(",") === "code,chat,build,test,research,push,settings");
  check("the flow bar shows in the build modes only", R.FLOW_MODES.build && !R.FLOW_MODES.code && !R.FLOW_MODES.settings);
  check("the unread badge", R.unreadBadge(0) === "" && R.unreadBadge(5) === "5" && R.unreadBadge(150) === "99+");
  const snap = R.flowSnapshot(2, true, { total: 4, done: 1, failed: 1, running: true }, { tested: true });
  check("the flow snapshot", snap.messages === 2 && snap.plan && snap.stepsTotal === 4 && snap.stepsFailed === 1 && snap.building && snap.tested && !snap.shipped);
  check("an empty flow snapshot", R.flowSnapshot(0, null, null, null).stepsTotal === 0);
  check("flow marks", R.flowMark({ status: "done" }, 0) === "\u2713" && R.flowMark({ status: "failed" }, 0) === "!" && R.flowMark({ status: "todo" }, 2) === "3");
  check("flow titles", R.flowTitle({ status: "next", next: "plan it" }) === "Next: plan it" && R.flowTitle({ status: "done", label: "Plan" }) === "Plan - done");

  check("html is escaped", R.escapeHtml("<a & b>") === "&lt;a &amp; b&gt;");
  const md = R.renderMarkdown("# Title\n\n- one\n- **two**\n\ntext `code`\n```js\nx < 1\n```");
  check("markdown: headings, lists, bold, code",
    /<div class="md-h">Title<\/div>/.test(md) && /<ul class="md-ul"><li>one<\/li><li><strong>two<\/strong><\/li><\/ul>/.test(md) &&
    /<code class="md-inline">code<\/code>/.test(md) && /<pre class="md-code">x &lt; 1\n<\/pre>/.test(md), md);

  check("known phases are worded", R.phaseLabel({ phase: "writing", detail: "d" }).label === "writing reply" && R.phaseLabel({ phase: "writing" }).kind === "work");
  check("an unknown phase is shown verbatim", R.phaseLabel({ phase: "dreaming" }).label === "dreaming" && R.phaseLabel({ phase: "dreaming" }).kind === "busy");
  check("no phase is idle", R.phaseLabel(null).name === "idle");
  check("provider names are shortened for the rail", R.shortProviderName("DeepSeek Chat (beta)") === "DeepSeek");
  const ob = R.onboardingState([{ id: "ds", name: "DeepSeek Chat", termsUrl: "u" }], "ds", true, "/w", "on", 0, 1);
  check("the onboarding state", ob.providerName === "DeepSeek" && ob.termsUrl === "u" && ob.chatted === true);
  check("an unknown provider is 'your provider'", R.onboardingState([], "x", true, "", "unknown", 0, 0).providerName === "your provider");
  check("the account light", R.accountFromStatus(null).state === "unknown" && R.accountFromStatus({ success: true, signedIn: true }).text === "signed in");
  check("a thread label is never the URL", R.threadLabel({ url: "https://x/a/secret", label: "…cret" }) === "thread …cret" && R.threadLabel(null) === "");
  const hl = R.healthLines({ summary: "2 ok", ok: false, findings: [{ selector: "input", health: "critical", matched: 0 }], resumed: false });
  check("the selector check prints every finding", hl.length === 3 && hl[1].tone === "err" && /read path was not checked/.test(hl[2].text));

  check("a recent workspace shows its tail", R.recentLabel("/home/me/code/proj") === "code/proj" && R.recentLabel("C:\\a\\b\\c") === "b/c");
  check("controls are saved per provider", R.controlsKey("deepseek") === "closeni.controls.deepseek");
  check("unreadable saved controls are none", Object.keys(R.parseSavedControls("{bad")).length === 0 && Object.keys(R.parseSavedControls(null)).length === 0);
  const plist = [{ id: "p", controls: [{ id: "model", kind: "select", options: [{ value: "a" }, { value: "b" }], default: "a" }] }];
  check("saved controls are applied", R.desiredControls(plist, "p", '{"model":"b"}').model === "b");
  check("a provider without controls asks for nothing", Object.keys(R.desiredControls([{ id: "q" }], "q", "")).length === 0);
  check("saving one control keeps the rest", R.saveControl('{"a":1}', "b", true) === '{"a":1,"b":true}');
  check("chat titles", R.chatTitle({ title: "t" }, 0) === "t" && R.chatTitle({}, 2) === "Chat 3");
  check("a chat is named after its first line", R.chatName("\n  Build me a todo app \nwith tags") === "Build me a todo app");
  check("a long first line is cut at a word",
    R.chatName("A tiny Python web server that says hello and prints its own address on start") === "A tiny Python web server that says hello and\u2026",
    R.chatName("A tiny Python web server that says hello and prints its own address on start"));
  check("an empty message has no name", R.chatName("  ") === "" && R.chatName(null) === "");
  const at = new Date(2026, 9, 10, 9, 5).toISOString();
  check("a chat from today shows its time", R.shortWhen(at, new Date(2026, 9, 10, 18, 0)) === "09:05");
  check("a chat from this year shows its day", R.shortWhen(at, new Date(2026, 11, 1)) === "Oct 10");
  check("an older chat shows its date", R.shortWhen(at, new Date(2027, 0, 2)) === "2026-10-10");
  check("no date shows nothing", R.shortWhen(undefined) === "" && R.shortWhen("nope") === "");

  check("a plan is found in a fenced block", R.tryExtractPlan('here:\n```json\n{"steps":[1]}\n```').steps.length === 1);
  check("or in surrounding prose", R.tryExtractPlan('ok {"steps":[]} done') !== null);
  check("prose without a plan is none", R.tryExtractPlan("no plan here") === null && R.tryExtractPlan('{"a":1}') === null);
  const plan = { summary: "s", steps: [{ title: "a" }, { title: "b", dependsOn: [0] }] };
  const moved = R.applyPlanEdit(plan, "del", 0);
  check("plan edits go through plan-edit", !moved.refused && moved.plan.steps.length === 1 && moved.plan.summary === "s");
  check("an unknown edit is none", R.applyPlanEdit(plan, "zap", 0) === null);
  check("the plan's scale", /^2 steps · /.test(R.planScaleText(plan)) && R.planScaleText({}) === "");
  const p2 = { steps: [{ files: ["b.py", "a.js"], detail: "Use Flask" }, { files: ["a.js", "s.css"] }] };
  check("plan files are sorted and once each", R.planFiles(p2).join(",") === "a.js,b.py,s.css");
  check("the tech stack", R.planTechStack(p2).join(",") === "Python,JavaScript,Flask,CSS", R.planTechStack(p2).join(","));
  const req = R.planRequest([{ role: "user", text: "hi" }, { role: "ai", text: "yo" }], { name: "o/r", readme: "R", files: ["x"] });
  check("the plan request carries the reference and the chat",
    req === "Reference project o/r:\nR\n\nIts file layout:\nx\n\n---\n\nUSER: hi\n\nAI: yo\n\n", JSON.stringify(req));
  check("export takes step titles", R.exportRequest("/w", plan).steps.join(",") === "a,b" && R.exportRequest("/w", null).summary === "");

  check("the manifest wins", R.chooseRunCommand("/w", { run: " a " }, { runCommand: "b" }, "c").source === "manifest");
  check("then the plan", R.chooseRunCommand("/w", { run: " " }, { runCommand: "b" }, "c").command === "b");
  check("then detection", R.chooseRunCommand("/w", null, null, "c").source === "detected");
  check("no workspace finds nothing", R.chooseRunCommand("", { run: "a" }, null, null).source === "none");
  check("every source is labelled", ["manifest", "plan", "detected", "none"].every(function (k) { return R.RUN_LABELS[k].length === 2; }));
  let hist = [];
  for (let i = 0; i < 8; i++) hist = R.pushHistory(hist, "r" + i, true);
  check("the run history is newest first and short", hist.length === 6 && hist[0].label === "r7");
  check("a behaviour summary", R.behaviourSummary({ passed: 1, failed: 0, skipped: 2 }) === "1 passed, 0 failed, 2 not run" && R.behaviourSummary({}) === "nothing to run");
  check("a syntax summary", R.syntaxSummary({ passed: 3, failed: 1 }).history === "syntax check · 4 checks");
  check("the last run is capped", R.lastRunFromResults("c", [{ x: "y".repeat(5000) }]).output.length === 4000);

  check("a run in progress is running", R.runState({ status: "in_progress" }) === "running" && R.runState({ status: "completed" }) === "unknown");
  check("a repository option", R.repoOption({ full_name: "o/r", private: true }).value === "https://github.com/o/r.git" && /\(private\)$/.test(R.repoOption({ full_name: "o/r", private: true }).label));
  check("the clone confirmation names the licence", /carries MIT,/.test(R.cloneConfirmText({ owner: "o", repo: "r" }, "MIT")) && /an unknown licence/.test(R.cloneConfirmText({ owner: "o", repo: "r" })));
  check("a reference needs a readme or a tree", R.referenceFrom({ owner: "o", repo: "r" }, { ok: false }, { ok: false }) === null);
  const ref = R.referenceFrom({ owner: "o", repo: "r" }, { ok: true, result: "x".repeat(4000) }, { ok: false });
  check("a reference is capped", ref.name === "o/r" && ref.readme.length === 3000 && ref.files.length === 0);
  check("token storage is said plainly", /encrypted/.test(R.tokenStorageNote(true)) && /memory only/.test(R.tokenStorageNote(false)));
  check("the token page asks for repo and workflow", /scopes=repo,workflow/.test(R.TOKEN_URL));

  const provs = [{ id: "a", comingSoon: true }, { id: "b" }, { id: "c" }];
  check("a saved provider is kept", R.pickProvider(provs, "c") === "c");
  check("a gated saved provider is not", R.pickProvider(provs, "a") === "b");
  check("no usable provider is none", R.pickProvider([{ id: "a", comingSoon: true }], null) === "");
  check("coming soon is labelled", R.providerOptionLabel({ name: "X", comingSoon: true }) === "X — coming soon");
  check("a skill import path", R.parseSkillImport("o/r/skills/a.md").path === "skills/a.md" && R.parseSkillImport("o/r") === null);
  check("toggling skills", R.toggleSkill(["a"], "b", true).join(",") === "a,b" && R.toggleSkill(["a", "b"], "a", false).join(",") === "b");
  check("unreadable saved skills are none", R.parseSkills("nope").length === 0 && R.parseSkills('["a"]')[0] === "a");

  // Settings: the MCP check before saving, the preamble and the permission policy.
  check("blank MCP configuration saves", R.mcpConfigError("") === "" && R.mcpConfigError("  \n") === "");
  check("valid MCP configuration saves", R.mcpConfigError('{"servers":{},"calls":[]}') === "");
  check("a typo in the MCP configuration is caught", R.mcpConfigError('{"servers":') === "That is not valid JSON");
  const ok = function (text) { return { ok: true, text: text }; };
  const pre = R.composePreamble(ok("be terse"), [ok("tests first"), ok("  "), { ok: false, error: "gone" }, ok("small diffs")],
    { ok: true, texts: ["schema"], notes: [] });
  check("the preamble has the persona, readable skills in order and MCP text",
    pre.persona === "be terse" && pre.skills.join("|") === "tests first|small diffs" && pre.mcpContext[0] === "schema",
    JSON.stringify(pre));
  check("nothing configured is an empty preamble",
    Object.keys(R.composePreamble(null, [], { ok: true, texts: [], notes: [] })).length === 0);
  check("a blank or missing persona is left out",
    !("persona" in R.composePreamble(ok(" "), [], null)) && !("persona" in R.composePreamble({ ok: false }, [], null)));
  check("the permission choices are ask, auto and never",
    R.AUTONOMY_OPTIONS.map(function (o) { return o.value; }).join(",") === "ask,auto,never");
  check("a saved permission policy is kept", R.resolveAutonomy("never") === "never" && R.resolveAutonomy("auto") === "auto");
  check("an unknown or missing permission policy is ask",
    R.resolveAutonomy("yolo") === "ask" && R.resolveAutonomy("") === "ask" && R.resolveAutonomy(null) === "ask");
}

async function run(c, s, sk) {
  check = c; section = s; skipped = sk;
  testThemePalettes();
  testStoragePaths();
  testGitHubSafe();
  testGitSpawnHardening();
  testBrowserCheck();
  testBuildConfig();
  testReleaseWorkflow();
  testTheme();
  testLogo();
  testLanguageMark();
  testPlaywrightCliResolution();
  testStorageRoot();
  testPromptCompose();
  testSkillStore();
  await testMcpClient();
  await testMcpContext();
  testSkillsWiring();
  testRecentWorkspaces();
  testOnboarding();
  testFlow();
  testCodeView();
  testNativePorts();
  testBuilderLogic();
  testCodeLogic();
  testCodeTranscript();
  testRendererLogic();
}

module.exports = { run };
