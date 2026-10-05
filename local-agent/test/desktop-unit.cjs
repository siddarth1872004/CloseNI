/*
 * Unit tests: The desktop app and its packaging: themes and marks, storage paths, the
 * browser gate, build and release config, GitHub, skills, MCP and onboarding.
 *
 * Run by run-tests.cjs (npm test), against the compiled output.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const DIST = path.join(__dirname, "..", "dist");

// The renderer is one script per panel under desktop/renderer/, read as one.
function readRenderer() {
  const dir = path.join(__dirname, "..", "..", "desktop", "renderer");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort()
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
}

// The main process likewise: main.js and the IPC domains under desktop/main/.
function readMain() {
  const D = path.join(__dirname, "..", "..", "desktop");
  return [path.join(D, "main.js")].concat(fs.readdirSync(path.join(D, "main")).filter((f) => f.endsWith(".js")).sort()
    .map((f) => path.join(D, "main", f))).map((f) => fs.readFileSync(f, "utf8")).join("\n");
}

// Handed in by run-tests.cjs, which keeps the one count.
let check, section, skipped;

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

function testRendererLoadOrder() {
  section("renderer load order");
  const { forwardRefs, rendererScripts } = require(path.join(__dirname, "load-order.cjs"));
  const scripts = rendererScripts(path.join(__dirname, "..", "..", "desktop"));
  check("index.html loads the renderer's scripts, core first and startup last",
    scripts.length > 2 && scripts[0].name === "renderer/core.js" &&
      scripts[scripts.length - 1].name === "renderer/startup.js", scripts.map((s) => s.name).join(", "));
  const refs = forwardRefs(scripts);
  check("no code that runs during load reaches a later script", refs.length === 0, refs.slice(0, 4).join(" | "));

  // Sanity-check the scan itself, so a broken one cannot report success.
  const a = { name: "a.js", source: "(async function () { await x(); later(); })();\nfunction early() { return 1; }\n" };
  const b = { name: "b.js", source: "function later() { return early(); }\n" };
  check("the scan finds a forward call after an await", forwardRefs([a, b]).length === 1);
  check("and through a function it calls",
    forwardRefs([{ name: "a.js", source: "function f() { later(); }\nf();\n" }, b]).length === 1);
  check("a click handler is not load-time code",
    forwardRefs([{ name: "a.js", source: "el.onclick = function () { later(); };\nel.onchange = later;\n" }, b]).length === 0);
  check("a typeof guard is safe",
    forwardRefs([{ name: "a.js", source: "if (typeof later === \"function\") {}\n" }, b]).length === 0);
  check("calling backwards is fine", forwardRefs([b, a]).length === 0);
}

function testFlow() {
  section("project flow");
  const F = require(path.join(__dirname, "..", "..", "desktop", "flow.js"));
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
  const V = require(path.join(__dirname, "..", "..", "desktop", "code-view.js"));
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
  const { languageToken } = require(path.join(__dirname, "..", "..", "desktop", "language-mark.js"));
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

  // Captured from a real failed install behind a proxy that blocks the CDN.
  const B = require(path.join(__dirname, "..", "..", "desktop", "browser-check.js"));
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
  check("the gate uses it", /describeInstallFailure\(output, code\)/.test(readMain()));
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
    const files = ["desktop/index.html"];
    return files.map((f) => fs.readFileSync(path.join(root, f), "utf8")).concat(readMain(), readRenderer())
      .every((src) => !/["'`]\d+\.\d+\.\d+["'`]/.test(src));
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
  ["local-agent/storage", ".superpowers", "docs", "samples", "app", "instance"]
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
  const main = readMain();
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

function testPackagedPaths() {
  section("paths that must survive packaging");
  const root = path.join(__dirname, "..", "..");
  const main = readMain();
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
  const GH = require(path.join(__dirname, "..", "..", "desktop", "github-api.js"));
  const D = path.join(__dirname, "..", "..", "desktop");
  const main = readMain();
  const preload = fs.readFileSync(path.join(D, "preload.js"), "utf8");
  const renderer = readRenderer();
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

function testRecentWorkspaces() {
  section("the projects you have been working on");
  const R = require(path.join(__dirname, "..", "..", "desktop", "recent-workspaces.js"));

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
  const O = require(path.join(__dirname, "..", "..", "desktop", "onboarding.js"));
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

  // Wiring: the guide reads real state, never a flag of its own.
  const D = path.join(__dirname, "..", "..", "desktop");
  const html = fs.readFileSync(path.join(D, "index.html"), "utf8");
  const renderer = readRenderer();
  check("the page loads onboarding.js before the renderer",
    html.indexOf('<script src="onboarding.js">') !== -1 &&
      html.indexOf('<script src="onboarding.js">') < html.indexOf('<script src="renderer/core.js">'));
  check("there is somewhere to draw it", /id="welcome"/.test(html));
  check("Settings can bring it back", /id="welcome-reset"/.test(html));
  check("the account light updates it", /acctNow = state;\s*renderOnboarding\(\)/.test(renderer));
  check("opening a folder updates it", /renderRecent\(\);\s*renderOnboarding\(\);\s*\}/.test(renderer));
  check("the browser gate updates it", /browserReady = false;\s*renderOnboarding\(\)/.test(renderer));

  // Every provider a person can sign in to has its terms on file, and they reach the guide.
  const files = fs.readFileSync(path.join(D, "main", "files.js"), "utf8");
  check("the provider list carries termsUrl to the renderer", /termsUrl: cfg\.termsUrl/.test(files));
  check("the guide reads it from the provider", /termsUrl: p && p\.termsUrl/.test(renderer));
  const provDir = path.join(__dirname, "..", "config", "providers");
  const noTerms = fs.readdirSync(provDir).filter(function (f) {
    const cfg = JSON.parse(fs.readFileSync(path.join(provDir, f), "utf8"));
    return cfg.enabled && !cfg.comingSoon && /^https:/.test(cfg.baseUrl) && !/^https:\/\//.test(cfg.termsUrl || "");
  });
  check("every selectable web provider links its terms", noTerms.length === 0, noTerms.join(", "));
  // A first launch lands on the Code panel, not the chat panel's guide, so the
  // sign-in and its terms are said there too.
  const code = fs.readFileSync(path.join(D, "code.js"), "utf8");
  check("the Code panel's welcome has a place for the terms", /id="code-terms"/.test(html));
  check("and fills it from the guide's sign-in step", /CN\.signInStep\(\)/.test(code) && /step\.terms/.test(code) && /signInStep:/.test(renderer));
  check("and redraws when the account light changes",
    /CN\.onAccountChange = refreshWelcome/.test(code) && /acctNow = state;\s*renderOnboarding\(\);\s*if \(window\.CN && window\.CN\.onAccountChange\)/.test(renderer));
}

async function run(c, s, sk) {
  check = c; section = s; skipped = sk;
  testCssTokens();
  testStoragePaths();
  testGitHubSafe();
  testGitSpawnHardening();
  await testGitHubApi();
  testBrowserCheck();
  testBuildConfig();
  testReleaseWorkflow();
  testTheme();
  testLogo();
  testLanguageMark();
  testPackagedPaths();
  testPlaywrightCliResolution();
  testStorageRoot();
  testPromptCompose();
  testSkillStore();
  await testMcpClient();
  await testMcpContext();
  testSkillsWiring();
  testRecentWorkspaces();
  testOnboarding();
  testRendererLoadOrder();
  testFlow();
  testCodeView();
}

module.exports = { run };
