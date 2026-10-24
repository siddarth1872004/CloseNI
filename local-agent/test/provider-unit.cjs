/*
 * Unit tests: Providers: controls, gating, reading replies out of a real page,
 * selector health, the smoke report, local models and research.
 *
 * Run by run-tests.cjs (npm test), against the compiled output.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const DIST = path.join(__dirname, "..", "dist");
const { parseMarkdownToEditPlan } = require(path.join(DIST, "parser/patch-parser.js"));
const { PlaywrightController } = require(path.join(DIST, "providers/playwright-controller.js"));

// Handed in by run-tests.cjs, which keeps the one count.
let check, section, skipped;

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
  const forced = JSON.parse(d.withControl('{"deep-thinking":true,"smart-search":true}', "deep-thinking", false));
  check("a control forced for one run overrides the saved one and keeps the rest",
    forced["deep-thinking"] === false && forced["smart-search"] === true, JSON.stringify(forced));
  check("a control can be forced with nothing saved", d.withControl(undefined, "smart-search", true) === '{"smart-search":true}');
  check("non-scalar values are dropped", Object.keys(d.parseDesiredControls('{"a":{"b":1}}')).length === 0);

  // A provider with no module has no controls rather than an error.
  check("deepseek has a module", hasControls("deepseek") === true);
  check("qwen-studio has a module", hasControls("qwen-studio") === true);
  check("glm has a module", hasControls("glm") === true);
  check("an unknown provider has none", hasControls("huggingchat") === false);
}

function testControlSettings() {
  section("provider control settings");
  const { resolveControls, labelFor } = require(path.join(__dirname, "..", "..", "native", "qml", "js", "controls-settings.mjs"));

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
    // Untitled or not, every thread is listed: the app's chat list reads it.
    const listed = readStore()["/my/ws"].chats.find((x) => x.url === "https://example.test/a/chat-1");
    check("an untitled thread is listed, with its provider", !!listed && listed.title === "" && listed.provider === cfg.id,
      JSON.stringify(readStore()["/my/ws"].chats));
    c.setChatUrlForWorkspace("/my/ws", "https://example.test/a/chat-1");
    check("a thread is listed once", readStore()["/my/ws"].chats.filter((x) => x.url === "https://example.test/a/chat-1").length === 1);
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

    // DeepSeek's markup: the language label sits beside the <pre> in a
    // banner, and inline code splits a paragraph into text nodes and elements.
    c.setWorkspace("/my/ws-labelled");
    const labelled = { ...cfg, baseUrl: "file://" + path.join(__dirname, "fixtures", "chat-labelled.html") };
    await c.navigateFresh(labelled);
    const reply = await c.extractLatestResponse(labelled);
    check("a paragraph with inline code keeps its words", reply.includes("Now I'll update `src/x.py`:"), reply);
    check("a code block's label rides on its fence, not as prose",
      reply.includes("```tool\n{") && !/^tool$/m.test(reply), reply);
    check("a one-word paragraph beside a block is kept", /^Done\.$/m.test(reply) && /^Fixed$/m.test(reply), reply);
    // The coding agent reads the structured view, not the one above.
    const structured = await c.getLastMessageStructured(labelled);
    check("structured view: the label rides on the fence",
      structured.includes("```tool\n{") && !/^\s*tool\s*$/m.test(structured), structured);
    check("structured view: the paragraph and its inline code survive", structured.includes("Now I'll update `src/x.py`:"), structured);
    check("structured view: a one-word paragraph beside a block is kept", /^Fixed$/m.test(structured), structured);
  } finally {
    await c.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// The same kind of sweep over the two DOM readers, with replies rendered the
// way the chat sites render them.
async function testReaderSweep() {
  section("reader sweep: replies as the page renders them (real chromium)");
  const { parseFilesRobust } = require(path.join(DIST, "parser/json-repair.js"));
  let browser;
  try {
    browser = await require("playwright").chromium.launch();
  } catch (e) {
    console.log("  skip (chromium unavailable: " + String(e.message).split("\n")[0] + ")");
    skipped.push("reader sweep");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-readers-"));
  try {
    const page = await browser.newPage();
    const cfg = { id: "fx", selectors: { assistantMessage: ".assistant-msg", copyButton: "" }, profileDir: path.join(root, "profiles", "fx") };
    const c = new PlaywrightController(cfg);
    c.attachPageForReplay(page);
    const read = async (body) => {
      await page.setContent('<div><div class="assistant-msg">old</div><div class="assistant-msg">' + body + "</div></div>");
      return { flat: await c.extractLatestResponse(cfg), md: await c.getLastMessageStructured(cfg) };
    };
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    // A block read back from the page ends in one newline either way.
    const contentOf = (t, p) => {
      const r = parseFilesRobust(t);
      const f = r && r.changes.find((x) => x.filePath === p);
      return f ? f.newContent.replace(/\n$/, "") : undefined;
    };
    const both = (name, r, p, want) => {
      check("flat reader: " + name, contentOf(r.flat, p) === want, r.flat);
      check("structured reader: " + name, contentOf(r.md, p) === want, r.md);
    };

    const README = "# Tool\n\nInstall:\n\n```bash\nnpm i tool\n```\n\nDone.";
    let r = await read('<p><strong>README.md</strong></p><div class="md-code-block"><div class="banner"><span>markdown</span><div role="button">Copy</div></div><pre><code class="language-markdown">' + esc(README) + "</code></pre></div>");
    both("a README holding a fence round-trips", r, "README.md", README);

    r = await read('<ol><li><p>Create <code>src/app.py</code>:</p><pre><code class="language-python">import os\nprint(os.getcwd())</code></pre></li><li><p>Run it.</p></li></ol>');
    both("code inside a list item is a block", r, "src/app.py", "import os\nprint(os.getcwd())");

    const CODE = "import json\ntext\njson\nCopy\nprint(1)";
    r = await read('<p><code>a.py</code></p><pre><code class="language-python">' + CODE + "</code></pre>");
    both("code lines that equal label words survive", r, "a.py", CODE);

    r = await read('<p>Here is <code>x.rs</code>:</p><pre><code class="language-rust">fn main() {}</code></pre>');
    check("structured reader: the language class rides on the fence", /```rust\n/.test(r.md), r.md);
    check("only the newest reply is read", !/^old$/m.test(r.flat) && !/^old$/m.test(r.md));

    r = await read("<h3>src/b.py</h3><pre><code>y = 2</code></pre><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>");
    both("a heading names the block after it", r, "src/b.py", "y = 2");
    check("flat reader: table cells are not glued together", !/ab|12/.test(r.flat.replace(/```[\s\S]*?```/g, "")), r.flat);

    // A renderer leaves a soft line break in the paragraph's text. The plan
    // rescue splits on those lines, and a file label must stay on its own line.
    r = await read("<p>Here is the plan.\nStep 1: setup\nStep 2: routes\n\n**src/config.py**</p><pre><code>DEBUG = True</code></pre>");
    check("flat reader: a soft line break stays a line", /^Step 1: setup\nStep 2: routes$/m.test(r.flat), r.flat);
    both("a label after a soft break names the block", r, "src/config.py", "DEBUG = True");

    const CITE = '<p>pygame-ce ships a wheel<a href="https://x"><span class="ds-markdown-cite"><span style="opacity:0">-</span><span>15</span></span></a>, so use it.</p>';
    r = await read(CITE);
    check("structured reader: without a selector a citation badge reads as text", /wheel-15,/.test(r.md), r.md);
    await page.setContent('<div class="assistant-msg">' + CITE + "</div>");
    const cited = await c.getLastMessageStructured({ ...cfg, selectors: { ...cfg.selectors, citation: ".ds-markdown-cite" } });
    check("structured reader: a citation badge is left out", /ships a wheel, so use it\./.test(cited) && !/15/.test(cited), cited);

    r = await read("");
    check("an empty reply reads as empty", r.flat === "" && r.md.trim() === "", JSON.stringify(r));
    r = await read("Just text, no markup.");
    check("a bare text reply reads", r.flat.includes("Just text") && r.md.includes("Just text"), JSON.stringify(r));
  } finally {
    await browser.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// The selector sweep: every selector literal in the source and the provider
// configs, pulled out with the TypeScript parser and checked in a real page
// with the API it is handed to. A typo in one only shows up on the live site.
async function testSelectorSyntax() {
  section("selector sweep: every literal selector parses (real chromium)");
  const ts = require("typescript");
  const ROOT = path.join(__dirname, "..", "..");
  const DOM_CALLS = new Set(["querySelector", "querySelectorAll", "closest", "matches", "webkitMatchesSelector"]);
  const PW_CALLS = new Set(["locator", "waitForSelector", "$", "$$", "$eval", "$$eval", "isVisible", "click", "fill", "textContent", "innerText", "getAttribute"]);
  const PROP_KEYS = new Set(["css", "chatInput", "sendButton", "stopButton", "assistantMessage", "copyButton", "selector", "selectors"]);
  const walk = (dir, out) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|js|cjs|mjs)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
    }
    return out;
  };
  // Folds "a" + "b"; null when anything is dynamic.
  const fold = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const a = fold(n.left), b = fold(n.right);
      return a !== null && b !== null ? a + b : null;
    }
    if (ts.isParenthesizedExpression(n)) return fold(n.expression);
    return null;
  };
  // kind: "dom" goes to querySelector; "pw" to Playwright; "shared" is a config
  // or property value, which may reach either.
  const found = [];
  for (const f of walk(path.join(ROOT, "local-agent", "src"), [])) {
    const sf = ts.createSourceFile(f, fs.readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, f.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const at = (n) => path.relative(ROOT, f) + ":" + (sf.getLineAndCharacterOfPosition(n.getStart()).line + 1);
    (function visit(n) {
      if (ts.isCallExpression(n) && n.arguments.length) {
        const callee = n.expression;
        const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : null;
        const s = name && (DOM_CALLS.has(name) || PW_CALLS.has(name)) ? fold(n.arguments[0]) : null;
        // The Playwright names are common words; count them only when the
        // argument looks like a selector.
        if (s !== null && (DOM_CALLS.has(name) || (/[#.\[\]:>=]|^[a-z]+(,|$)/i.test(s) &&
            !(["click", "fill", "textContent", "innerText", "getAttribute", "isVisible"].includes(name) && !/[#.\[\]:]/.test(s))))) {
          found.push({ at: at(n), sel: s, kind: DOM_CALLS.has(name) ? "dom" : "pw" });
        }
      }
      if (ts.isPropertyAssignment(n) && PROP_KEYS.has(n.name.getText(sf).replace(/["']/g, ""))) {
        const s = fold(n.initializer);
        if (s) found.push({ at: at(n), sel: s, kind: "shared" });
      }
      ts.forEachChild(n, visit);
    })(sf);
  }
  const cfgDir = path.join(ROOT, "local-agent", "config", "providers");
  for (const f of fs.readdirSync(cfgDir)) {
    const c = JSON.parse(fs.readFileSync(path.join(cfgDir, f), "utf8"));
    for (const [k, v] of Object.entries(c.selectors || {})) {
      if (k.startsWith("_") || k === "streamUrlPattern" || typeof v !== "string" || !v) continue;
      found.push({ at: "config/providers/" + f + " " + k, sel: v, kind: "shared" });
    }
  }

  let browser;
  try {
    browser = await require("playwright").chromium.launch();
  } catch (e) {
    console.log("  skip (chromium unavailable: " + String(e.message).split("\n")[0] + ")");
    skipped.push("selector sweep");
    return;
  }
  const bad = [];
  try {
    const page = await browser.newPage();
    await page.setContent("<main><textarea placeholder=x></textarea></main>");
    for (const r of found) {
      let err = null;
      if (r.kind === "dom") {
        err = await page.evaluate((s) => { try { document.querySelectorAll(s); return null; } catch (e) { return String(e.message).split("\n")[0]; } }, r.sel);
      } else {
        try { await page.locator(r.sel).count(); } catch (e) { err = String(e.message).split("\n")[0]; }
        if (!err && r.kind === "shared" && /:has-text|:text|>>|^text=|^xpath=|:visible|:nth-match/.test(r.sel)) err = "Playwright-only syntax in a value that may reach querySelector";
      }
      if (err) bad.push(r.at + " " + JSON.stringify(r.sel) + ": " + err);
    }
  } finally {
    await browser.close();
  }
  check("the sweep found the selectors", found.length > 50, String(found.length));
  check("every literal selector parses where it is used", bad.length === 0, bad.join("\n"));
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
  const enterOnly = H.judgeSelectors(Object.assign({}, full, { sendButton: 0 }),
    { conversationResumed: true, configured: { sendButton: false } });
  check("a provider that sends with Enter has its send button skipped, not degraded",
    find(enterOnly, "sendButton").health === "skipped" && /Enter/.test(find(enterOnly, "sendButton").note));

  // Nothing at all must not throw, and must not read as healthy.
  const empty = H.judgeSelectors({}, { conversationResumed: false });
  check("empty counts do not throw and do not pass", empty.ok === false);
  check("undefined context does not throw", typeof H.judgeSelectors({}, {}).summary === "string");
  check("negative counts are treated as zero",
    H.judgeSelectors({ chatInput: -3 }, { conversationResumed: true }).ok === false);
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
  {
    const { cleanError } = require(path.join(DIST, "clean-error.js"));
    const raw = 'page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://chat.deepseek.com/\nCall log:\n\u001b[2m  - navigating to "https://chat.deepseek.com/", waiting until "domcontentloaded"\u001b[22m\n';
    check("an error shown to a person loses the call log and colour codes", cleanError(raw) === "page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://chat.deepseek.com/", JSON.stringify(cleanError(raw)));
    check("a plain multi-line error is kept whole", cleanError("line one\nline two") === "line one\nline two");
    check("a missing error is an empty string, not 'undefined'", cleanError(undefined) === "");
  }
  check("nothing after an unsent prompt is judged - it is 'not run', not a selector failure",
    ["stopButton", "replyStream", "assistantMessage", "completion", "replyContent", "copyButton"].every((st) => find(unsent, st).health === "skipped"));
  const offline = S.judgeSmoke({ sent: false, error: "page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://chat.deepseek.com/" });
  check("an unreachable site is named as the network, not as selectors",
    /could not be reached/.test(find(offline, "send").detail) && /no selector was tested/.test(offline.summary) && !/selector is watching/.test(JSON.stringify(offline)), offline.summary);
  const refused = S.judgeSmoke({ sent: false, error: "the composer did not take the prompt" });
  check("a send that failed on the page is not called a network problem",
    !/could not be reached/.test(refused.summary) && /could not be sent/.test(find(refused, "send").detail), refused.summary);
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
  // GitHub search (searchRepos) is the native app's C++ GitHubApi now, tested
  // in native/tests/tst_github.cpp.
}

// What DeepSeek puts where a reply should be: classified from the rules in
// deepseek.json, which were measured by injecting each fault into the live
// page (scripts/deepseek-faults.mjs, 9 October 2026).
function testReplyTrouble() {
  section("provider trouble: busy, rate limited, full, signed out");
  const R = require(path.join(DIST, "providers/reply-trouble.js"));
  const ds = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "providers", "deepseek.json"), "utf8"));
  const rules = ds.replyErrors;
  const hint = (content) => JSON.stringify({ type: "error", content: content, clear_response: true });
  const sig = (status, notices) => ({ signals: { status: status, notices: notices || [] } });

  check("a finished reply is no trouble", R.classifyTrouble(sig("FINISHED"), rules) === null);
  check("nor is no signal at all", R.classifyTrouble({}, rules) === null);
  check("nor is anything, for a provider with no rules", R.classifyTrouble(sig("INCOMPLETE"), undefined) === null);
  const busy = R.classifyTrouble(sig("", [hint("Server busy, please try again later.")]), rules);
  check("a busy hint is busy, in DeepSeek's own words", busy && busy.kind === "busy" && busy.detail === "Server busy, please try again later.", JSON.stringify(busy));
  check("so is the Chinese one", R.classifyTrouble(sig("", [hint("服务器繁忙，请稍后再试")]), rules).kind === "busy");
  check("a reply cut off INCOMPLETE is busy", R.classifyTrouble(sig("INCOMPLETE"), rules).kind === "busy");
  check("a rate-limit toast is a rate limit",
    R.classifyTrouble(sig("", [JSON.stringify({ type: "error", content: "You are sending messages too frequently. Please wait a moment before sending again." })]), rules).kind === "rate-limit");
  // The live toast (10 October): read as busy, it was resent three times into the limit.
  const rate = R.classifyTrouble(sig("", [JSON.stringify({ type: "error", content: "Messages too frequent. Try again later." })]), rules);
  check("so is DeepSeek's live one, and it is not hammered", rate.kind === "rate-limit" && R.backoffFor("rate-limit", 0, rules) === 60000 && R.backoffFor("rate-limit", 1, rules) === null,
    JSON.stringify(rate));
  check("CONTEXT_LENGTH_EXCEEDED means the conversation is full", R.classifyTrouble(sig("CONTEXT_LENGTH_EXCEEDED"), rules).kind === "full");
  check("CONTENT_FILTER is a refusal", R.classifyTrouble(sig("CONTENT_FILTER"), rules).kind === "refused");
  check("an error notice nobody listed still means no reply",
    R.classifyTrouble(sig("", [JSON.stringify({ type: "error", content: "Something new" })]), rules).kind === "busy");
  check("a notice that is not an error is not trouble", R.classifyTrouble(sig("FINISHED", [JSON.stringify({ type: "info", content: "Tip" })]), rules) === null);
  check("HTTP 429 is a rate limit, 5xx busy, 401 signed out",
    R.classifyTrouble({ httpStatus: 429 }, rules).kind === "rate-limit" && R.classifyTrouble({ httpStatus: 502 }, rules).kind === "busy" &&
    R.classifyTrouble({ httpStatus: 401 }, rules).kind === "signed-out");
  check("the sign-in page means signed out", R.classifyTrouble({ url: "https://chat.deepseek.com/sign_in" }, rules).kind === "signed-out");
  check("a chat whose id holds 'login' is not", R.classifyTrouble({ url: "https://chat.deepseek.com/a/chat/s/loginx" }, rules) === null);
  check("the page's notice row is read when the stream said nothing",
    R.classifyTrouble({ pageNotice: "Server is temporarily unavailable." }, rules).kind === "busy");
  check("and DeepSeek's own length-limit text means full", R.classifyTrouble({ pageNotice: "Length limit exceeded. Your message will be sent to a new chat." }, rules).kind === "full");
  const hf = "Warning: You are sending unauthenticated requests to the HF Hub. Please set a HF_TOKEN to enable higher rate limits and faster downloads.";
  check("a notice that is our own prompt is not one", R.echoesPrompt(hf, "Tool results (1):\n" + hf) && !R.echoesPrompt(hf, "something else") && !R.echoesPrompt("", hf));
  check("so a prompt quoting \"rate limits\" is no rate limit",
    R.classifyTrouble({ pageNotice: hf }, rules) && R.classifyTrouble({ pageNotice: hf, sentPrompt: "Tool results:\n" + hf }, rules) === null);

  check("busy is sent again after 5s, 20s and 60s, then given up",
    R.backoffFor("busy", 0, rules) === 5000 && R.backoffFor("busy", 2, rules) === 60000 && R.backoffFor("busy", 3, rules) === null);
  check("a rate limit once, after a minute", R.backoffFor("rate-limit", 0, rules) === 60000 && R.backoffFor("rate-limit", 1, rules) === null);
  check("a refusal once", R.backoffFor("refused", 0, rules) === 5000 && R.backoffFor("refused", 1, rules) === null);
  check("full and signed out are never resent", R.backoffFor("full", 0, rules) === null && R.backoffFor("signed-out", 0, rules) === null);

  const msg = R.describeTrouble(busy, 4, "DeepSeek Chat");
  check("the message quotes DeepSeek and counts the tries", /"Server busy, please try again later\."/.test(msg) && /after 4 tries/.test(msg), msg);
  check("signed out says to sign in again", /Sign in/.test(R.describeTrouble({ kind: "signed-out", detail: "x" }, 1, "DeepSeek Chat")));
  check("a status is named, not quoted", /\(HTTP 429\)/.test(R.describeTrouble({ kind: "rate-limit", detail: "HTTP 429" }, 1, "D")));

  const C = require(path.join(DIST, "providers/playwright-controller.js"));
  check("a chat URL's id is read", C.chatId("https://chat.deepseek.com/a/chat/s/abc-123?x=1") === "abc-123" && C.chatId("https://chat.deepseek.com/") === "");
}

// Status, pacing, tiered locating and page snapshots: the pieces that let a
// provider fail in a way a person can act on.
function testResilience() {
  section("provider resilience: status, pacing, locating, snapshots");
  const St = require(path.join(DIST, "providers/provider-status.js"));
  const R = require(path.join(DIST, "providers/reply-trouble.js"));
  const P = require(path.join(DIST, "providers/pacing.js"));
  const L = require(path.join(DIST, "providers/locate.js"));
  const D = require(path.join(DIST, "providers/dom-snapshot.js"));

  check("every trouble has a status",
    ["busy", "rate-limit", "full", "refused", "too-long", "signed-out", "challenge"].every((k) => typeof St.statusForTrouble(k) === "string"));
  check("a challenge asks the person", St.statusForTrouble("challenge") === "CHALLENGE_REQUIRED" && St.groupOf("CHALLENGE_REQUIRED") === "intervention");
  check("a rate limit and a busy server are retried", St.mayRetry("RATE_LIMITED") && St.mayRetry("NETWORK_ERROR") && St.mayRetry("RESPONSE_INCOMPLETE"));
  check("a challenge, a sign-in or a changed page never are",
    !St.mayRetry("CHALLENGE_REQUIRED") && !St.mayRetry("AUTH_REQUIRED") && !St.mayRetry("PAGE_CHANGED") && !St.mayRetry("CONTEXT_FULL"));
  check("leaving a challenge takes READY", !St.canMove("CHALLENGE_REQUIRED", "GENERATING") && St.canMove("CHALLENGE_REQUIRED", "READY"));
  check("anything may pause", St.canMove("GENERATING", "PAUSED") && St.canMove("AUTH_REQUIRED", "PAUSED"));
  const seen = [];
  const t = new St.StatusTracker((s, d) => seen.push(s + ":" + d));
  t.set("GENERATING");
  t.set("CHALLENGE_REQUIRED", "check");
  const refused = t.set("GENERATING");
  check("the tracker keeps a refused move out, and says so", refused === false && t.status === "CHALLENGE_REQUIRED" && t.why === "check");
  t.set("CHALLENGE_REQUIRED", "check");
  check("and reports only changes", seen.join(",") === "GENERATING:,CHALLENGE_REQUIRED:check", seen.join(","));
  const quiet = new St.StatusTracker(() => { throw new Error("listener"); });
  check("a listener that throws does not break the caller", quiet.set("GENERATING") === true);

  const rules = { challenge: ".cf-turnstile", challengeUrl: "/challenge", signedOutUrl: "/sign_in" };
  check("a human check on the page is a challenge", R.classifyTrouble({ challengeShown: true, url: "https://x/sign_in" }, rules).kind === "challenge");
  check("so is the challenge URL", R.classifyTrouble({ url: "https://x/challenge?r=1" }, rules).kind === "challenge");
  check("and it is never resent", R.backoffFor("challenge", 0, rules) === null);
  check("its message says to finish it in the browser", /Show browser/.test(R.describeTrouble({ kind: "challenge", detail: "x" }, 1, "D")));
  check("backoff doubles to a cap", JSON.stringify(R.cappedBackoff(5000, 60000, 5)) === "[5000,10000,20000,40000,60000]");
  check("a provider with no backoff of its own gets the capped defaults",
    R.backoffFor("busy", 0, {}) === 5000 && R.backoffFor("busy", 2, {}) === 20000 && R.backoffFor("busy", 3, {}) === null &&
    R.backoffFor("rate-limit", 0, {}) === 30000 && R.backoffFor("rate-limit", 1, {}) === 60000 && R.backoffFor("rate-limit", 2, {}) === null);

  const noon = new Date(2026, 9, 14, 12, 0, 0).getTime();
  check("a day is the local calendar day", P.dayOf(noon) === "2026-10-14");
  check("a budget is a positive whole number or none",
    P.parseBudget("50") === 50 && P.parseBudget("0") === 0 && P.parseBudget("-3") === 0 && P.parseBudget("x") === 0 && P.parseBudget(undefined) === 0);
  check("a gap is a positive whole number of ms, capped at an hour, or none",
    P.parseGap("5000") === 5000 && P.parseGap("2500.7") === 2500 && P.parseGap("0") === 0 && P.parseGap("-1") === 0 &&
    P.parseGap("x") === 0 && P.parseGap(undefined) === 0 && P.parseGap("99999999") === P.MAX_GAP_MS && P.MAX_GAP_MS === 3600000);
  check("the gap is the provider's or the person's, whichever is longer",
    P.effectiveGap(3000, 0) === 3000 && P.effectiveGap(3000, 10000) === 10000 && P.effectiveGap(3000, 1000) === 3000 &&
    P.effectiveGap(undefined, 2000) === 2000 && P.effectiveGap(undefined, 0) === 0);
  check("the first prompt goes straight out", JSON.stringify(P.paceDecision(null, noon, 3000, 5)) === '{"action":"send","waitMs":0}');
  const rec = P.recordSend(null, noon);
  check("a send is counted", rec.count === 1 && rec.day === "2026-10-14" && rec.lastSentAt === noon);
  check("the next waits out the gap", P.paceDecision(rec, noon + 1000, 3000, 0).waitMs === 2000);
  check("not once the gap has passed", P.paceDecision(rec, noon + 5000, 3000, 0).waitMs === 0);
  check("a clock that went back owes nothing", P.paceDecision(rec, noon - 1000, 3000, 0).waitMs === 0);
  const spent = P.paceDecision({ day: "2026-10-14", count: 5, lastSentAt: noon }, noon + 60000, 0, 5);
  check("a spent budget stops, and says where to raise it", spent.action === "stop" && /Settings > Permissions/.test(spent.reason), JSON.stringify(spent));
  check("it resets the next day", P.paceDecision({ day: "2026-10-13", count: 5, lastSentAt: noon - 86400000 }, noon, 0, 5).action === "send");
  check("no budget never stops", P.paceDecision({ day: "2026-10-14", count: 9999, lastSentAt: 0 }, noon, 0, 0).action === "send");

  const tiers = L.tiersFor([{ css: ".a" }, { text: "Copy" }, { role: "button", name: "Send" }, {}, { text: "(" }], "#send");
  check("tiers go role, text, css, then the selector, with the broken ones dropped",
    JSON.stringify(tiers) === '[{"role":"button","name":"Send"},{"text":"Copy"},{"css":".a"},{"css":"#send"}]', JSON.stringify(tiers));
  check("no tiers is the selector alone", JSON.stringify(L.tiersFor(undefined, "#x")) === '[{"css":"#x"}]');
  check("the selector is not listed twice", L.tiersFor([{ css: "#x" }], "#x").length === 1);

  const page = '<html><head><script>var token="abc"</script><style>.x{}</style></head><body>' +
    '<div class="ds-message" title="mail me at sam@example.com">Here is the fix for your login handler, which reads the session cookie twice</div>' +
    '<textarea class="composer">my private prompt</textarea><input value="secret">' +
    '<a href="https://chat.example/a/chat/s/abc?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig">Chat</a>' +
    '<span>Call +1 (555) 123-4567</span><svg viewBox="0 0 24 24"><path d="M1 2 3 4"></path></svg>' +
    '<button aria-label="Send">Send</button><div data-id="a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7">x</div></body></html>';
  const out = D.scrubSnapshot(page);
  check("scripts and styles go", !/<script|<style|token="abc"/.test(out), out);
  check("the person's words go, their length stays", !/login handler/.test(out) && /\[text: \d+ chars\]/.test(out), out);
  check("so do the composer and form values", !/my private prompt/.test(out) && !/secret/.test(out), out);
  check("URL queries go, the path stays", /href="https:\/\/chat.example\/a\/chat\/s\/abc"/.test(out) && !/eyJ/.test(out), out);
  check("emails, phone numbers and tokens are masked", !/sam@example/.test(out) && !/555/.test(out) && /\[token\]/.test(out), out);
  check("the structure a selector needs stays", /class="ds-message"/.test(out) && /aria-label="Send"/.test(out) && />Send</.test(out) && /viewBox="0 0 24 24"/.test(out), out);
  check("drawing data goes", !/M1 2 3 4/.test(out), out);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-snap-"));
  let file = "";
  for (let i = 0; i < 12; i++) file = D.saveSnapshot(root, "deep/seek", "page changed", page, noon + i * 1000);
  const kept = fs.readdirSync(path.join(root, "diagnostics"));
  check("a snapshot is saved scrubbed, and only the newest ten are kept",
    kept.length === 10 && fs.existsSync(file) && /^deep_seek-/.test(path.basename(file)) && !/login handler/.test(fs.readFileSync(file, "utf8")), kept.join(","));
  check("a snapshot that cannot be written is no error", D.saveSnapshot(path.join(file, "nope"), "x", "y", page) === "");
  fs.rmSync(root, { recursive: true, force: true });

  const pRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-pace-"));
  return (async () => {
    let clock = noon, slept = 0;
    const pacer = new P.Pacer(P.Pacer.fileFor(pRoot, "deep/seek"), { minGapMs: 3000 }, 2, async (ms) => { slept += ms; clock += ms; }, () => clock);
    const countFile = path.join(pRoot, "pacing-deep_seek.json");
    await pacer.beforeSend();
    check("a prompt is not counted before it goes out", !fs.existsSync(countFile));
    pacer.sent();
    clock += 1000;
    let waited = 0;
    await pacer.beforeSend((ms) => { waited = ms; });
    // This one never went out (a send the page ignored), so it is not counted.
    await pacer.beforeSend();
    pacer.sent();
    let stopped = null;
    try { await pacer.beforeSend(); } catch (e) { stopped = e; }
    check("the pacer waits the gap, counts what went out on disk and stops at the budget",
      waited === 2000 && slept === 2000 && stopped instanceof P.BudgetSpent && JSON.parse(fs.readFileSync(countFile, "utf8")).count === 2,
      waited + " " + slept + " " + stopped);
    const again = new P.Pacer(P.Pacer.fileFor(pRoot, "deep/seek"), { minGapMs: 3000 }, 2, async () => {}, () => clock);
    let restarted = null;
    try { await again.beforeSend(); } catch (e) { restarted = e; }
    check("the budget still holds after a restart", restarted instanceof P.BudgetSpent);

    clock = noon;
    const longer = new P.Pacer(P.Pacer.fileFor(pRoot, "gap"), { minGapMs: 3000 }, 0, async (ms) => { clock += ms; }, () => clock, 10000);
    await longer.beforeSend();
    longer.sent();
    let gapWait = 0;
    await longer.beforeSend((ms) => { gapWait = ms; });
    check("a longer gap from Settings is waited", longer.gapMs() === 10000 && gapWait === 10000, String(gapWait));
    const shorter = new P.Pacer(P.Pacer.fileFor(pRoot, "gap2"), { minGapMs: 3000 }, 0, async () => {}, () => clock, 1000);
    check("a shorter one does not undercut the provider's", shorter.gapMs() === 3000);
    fs.rmSync(pRoot, { recursive: true, force: true });
  })();
}

// The tiers on a real page: a renamed class falls through to the role, and a
// hidden match is passed over.
async function testLocateLive() {
  section("provider resilience: tiered locating (real chromium)");
  const L = require(path.join(DIST, "providers/locate.js"));
  let browser;
  try {
    browser = await require("playwright").chromium.launch();
  } catch (e) {
    console.log("  skip (chromium unavailable: " + String(e.message).split("\n")[0] + ")");
    skipped.push("tiered locating");
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent('<textarea class="renamed-x9" aria-label="Message DeepSeek"></textarea>' +
      '<button style="display:none" class="send">Send</button><button class="send-v2" aria-label="Send message">Send</button>');
    const input = await L.findNow(page, L.tiersFor([{ role: "textbox", name: "^message" }], "textarea.old-composer"));
    check("a renamed class falls through to the role", input && input.tier === "role" && (await input.locator.getAttribute("class")) === "renamed-x9");
    const send = await L.findNow(page, L.tiersFor([{ css: ".send" }], undefined));
    check("a hidden match is not a match", send === null);
    const byText = await L.findNow(page, L.tiersFor([{ css: ".send" }, { text: "^send$" }], undefined));
    check("text finds the visible one", byText && byText.tier === "text" && (await byText.locator.getAttribute("class")) === "send-v2");
    const t0 = Date.now();
    const none = await L.findWithin(page, [{ css: ".nothing" }], 600, 100);
    check("findWithin gives up at its timeout", none === null && Date.now() - t0 >= 600);
  } finally {
    await browser.close();
  }
}

// The whole path on a real page that answers like DeepSeek: an XHR to
// /api/v0/chat/completion with an SSE body, busy hints rendered as a row with
// no .ds-message.
// The offline library: saved provider pages, one per state, read the way the
// live wait reads them - so a selector or rule change is checked against every
// state without touching the site.
async function testSnapshots() {
  section("provider pages offline: the saved snapshot library");
  const dir = path.join(__dirname, "fixtures", "snapshots", "deepseek");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  check("the library is versioned and names its provider", manifest.version === 1 && manifest.provider === "deepseek");
  const files = manifest.pages.map((p) => p.file);
  check("it has idle, generating, done, rate-limited and login-wall pages",
    ["idle.html", "generating.html", "done.html", "rate-limited.html", "login-wall.html"].every((f) => files.indexOf(f) !== -1) && files.every((f) => fs.existsSync(path.join(dir, f))));
  const ds = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "providers", "deepseek.json"), "utf8"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-snapshots-"));
  const cfg = Object.assign({}, ds, { baseUrl: "https://ds.test/", profileDir: path.join(root, "profile") });
  const ctl = new PlaywrightController(cfg);
  ctl.setWorkspace(path.join(root, "ws"));
  try {
    await ctl.launch(cfg);
  } catch (e) {
    console.log("  skip (chromium unavailable: " + String(e.message).split("\n")[0] + ")");
    skipped.push("the snapshot library");
    fs.rmSync(root, { recursive: true, force: true });
    return;
  }
  const context = ctl.page.context();
  try {
    for (const p of manifest.pages) {
      const page = await context.newPage();
      const html = fs.readFileSync(path.join(dir, p.file), "utf8");
      await page.route("https://ds.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
      await page.goto(p.url);
      ctl.attachPageForReplay(page);
      const st = await ctl.readPageState(cfg);
      const want = p.expect;
      let ok = st.status === want.status && (want.messages === undefined || st.messages === want.messages);
      let reply = "";
      if (ok && want.reply) {
        reply = await ctl.extractLatestResponse(cfg);
        ok = reply.indexOf(want.reply) === 0;
      }
      check(p.file + " reads as " + want.status + (want.messages !== undefined ? " with " + want.messages + " message(s)" : "") + (want.reply ? ", its reply intact" : ""),
        ok, JSON.stringify({ st: st, reply: reply.slice(0, 80) }));
      await page.close();
    }
  } finally {
    await ctl.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testReplyTroubleLive() {
  section("provider trouble: the wait on a DeepSeek-like page (real chromium)");
  const ds = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "providers", "deepseek.json"), "utf8"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-trouble-"));
  const cfg = Object.assign({}, ds, {
    baseUrl: "https://ds.test/",
    profileDir: path.join(root, "profiles", "ds"),
    completionRules: Object.assign({}, ds.completionRules, { maxWaitMs: 6000 }),
    replyErrors: Object.assign({}, ds.replyErrors, { retryBackoffMs: [100], rateLimitBackoffMs: [] }),
  });
  const sse = (...lines) => lines.join("\n\n") + "\n\n";
  const BUSY = sse("event: ready\ndata: {}", 'event: hint\ndata: {"type":"error","content":"Server busy, please try again later.","clear_response":true}', "event: close\ndata: {}");
  const OK = sse('data: {"v":"PONG"}', 'data: {"p":"response/status","o":"SET","v":"FINISHED"}', "event: close\ndata: {}");
  const FULL = sse('data: {"v":"Partial"}', 'data: {"p":"response/status","o":"SET","v":"CONTEXT_LENGTH_EXCEEDED"}', "event: close\ndata: {}");
  let queue = [];
  const held = [];
  // As on 14 October 2026: a second list after the conversation holds the
  // prompts sent, as plain rows.
  const html = '<!doctype html><div class="ds-virtual-list-visible-items" id="list"></div><div class="ds-virtual-list-visible-items" id="sent"></div><textarea placeholder="Message"></textarea><script>' +
    'const ta=document.querySelector("textarea[placeholder]"),list=document.getElementById("list");' +
    'ta.addEventListener("keydown",e=>{if(e.key!=="Enter")return;e.preventDefault();const q=ta.value;ta.value="";' +
    'const u=document.createElement("div");u.innerHTML="<div class=\\"ds-message\\">"+q+"</div>";list.appendChild(u);' +
    'const sr=document.createElement("div");sr.textContent=q;document.getElementById("sent").appendChild(sr);' +
    'const x=new XMLHttpRequest();x.open("POST","/api/v0/chat/completion");x.onload=()=>{const t=x.responseText;const row=document.createElement("div");' +
    'const h=/event: hint\\ndata: (\\{.*\\})/.exec(t);if(h)row.innerHTML="<span>"+JSON.parse(h[1]).content+"</span>";' +
    'else{const m=/"v":"([A-Za-z]+)"/.exec(t);row.innerHTML="<div class=\\"ds-message\\"><div class=\\"ds-markdown\\">"+(m?m[1]:"")+"</div></div>";}' +
    'list.appendChild(row);};x.send(q);});</script>';
  // One browser per config: the tap goes into a page once, with the signal
  // patterns of its first send.
  const open = async (config, name, body = html) => {
    const ctl = new PlaywrightController(Object.assign({}, config, { profileDir: path.join(root, "profiles", name) }));
    ctl.setWorkspace(path.join(root, "ws"));
    await ctl.launch(config);
    await ctl.page.route("https://ds.test/**", async (route) => {
      if (/completion/.test(route.request().url())) {
        const body = queue.shift();
        if (body === undefined) { held.push(route); return; }
        return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: body });
      }
      return route.fulfill({ status: 200, contentType: "text/html", body: body });
    });
    await ctl.page.goto("https://ds.test/a/chat/s/one");
    return ctl;
  };
  let c;
  try {
    c = await open(cfg, "a");
  } catch (e) {
    console.log("  skip (chromium unavailable: " + String(e.message).split("\n")[0] + ")");
    skipped.push("provider trouble on a page");
    fs.rmSync(root, { recursive: true, force: true });
    return;
  }
  const ask = async (config, prompt, ctl) => {
    ctl = ctl || c;
    const n = await ctl.countMessages(config), t = await ctl.getLastMessageText(config);
    await ctl.sendPrompt(prompt, config);
    return await ctl.waitForResponse(config, n, t);
  };
  try {
    queue = [BUSY, OK];
    let r = await ask(cfg, "hi");
    check("a busy hint in the stream is sent again, and the real reply read", r === "PONG", JSON.stringify(r));

    const noSignals = Object.assign({}, cfg, { selectors: Object.assign({}, cfg.selectors, { replySignals: undefined }) });
    const plain = await open(noSignals, "b");
    queue = [BUSY, OK];
    try { r = await ask(noSignals, "again", plain); } finally { await plain.close().catch(() => {}); }
    check("the notice row on the page is enough on its own", r === "PONG" && queue.length === 0, JSON.stringify(r));

    const warned = "Tool results (1):\n[1] bash - exit 0\nWarning: You are sending unauthenticated requests to the HF Hub. Please set a HF_TOKEN to enable higher rate limits and faster downloads.";
    queue = [OK, OK];
    r = await ask(cfg, warned);
    check("a prompt that quotes \"rate limits\" is not read as one", r === "PONG" && queue.length === 1, JSON.stringify({ r: r, left: queue.length }));
    const oldNotice = Object.assign({}, cfg, { replyErrors: Object.assign({}, cfg.replyErrors, { notice: ".ds-virtual-list-visible-items > *" }) });
    const old = await open(oldNotice, "c");
    queue = [OK, OK];
    try { r = await ask(oldNotice, warned, old); } finally { await old.close().catch(() => {}); }
    check("even when the notice selector lands on the sent-prompts list", r === "PONG" && queue.length === 1, JSON.stringify({ r: r, left: queue.length }));

    queue = [BUSY, BUSY];
    let err = null;
    try { await ask(cfg, "busy twice"); } catch (e) { err = e; }
    check("once the waits run out, DeepSeek's words and the tries are reported",
      err && err.kind === "busy" && /Server busy/.test(err.message) && /after 2 tries/.test(err.message), err && err.message);

    queue = [FULL];
    err = null;
    try { await ask(cfg, "full"); } catch (e) { err = e; }
    check("a full conversation is not read as the reply, nor resent", err && err.kind === "full" && queue.length === 0, err && err.message);

    queue = [];
    err = null;
    const t0 = Date.now();
    try { await ask(cfg, "silent"); } catch (e) { err = e; }
    check("a reply that never starts ends with a message, not the previous answer",
      err && /did not start a reply/.test(err.message), err ? err.message : "returned a reply");
    check("within the ceiling and its grace", Date.now() - t0 < 30000);
    for (const h of held.splice(0)) await h.abort().catch(() => {});

    // The send itself: the composer that was found gets the prompt, a covered
    // composer is still typed into, and a send the page ignores is reported
    // instead of waited out, and not counted against the budget.
    const long = "Long prompt. " + "x".repeat(6000) + " END";
    const hidden = await open(cfg, "hidden", html.replace("<textarea", '<textarea style="display:none"></textarea><textarea'));
    queue = [OK];
    try { r = await ask(cfg, long, hidden); } finally { await hidden.close().catch(() => {}); }
    check("a long prompt goes into the composer that was found, not an earlier hidden textarea", r === "PONG" && queue.length === 0, JSON.stringify(r));

    const covered = await open(cfg, "covered", html.replace("<script>", '<div style="position:fixed;inset:0;z-index:9;background:rgba(0,0,0,.2)"></div><script>'));
    queue = [OK];
    try { r = await ask(cfg, "under a banner", covered); } finally { await covered.close().catch(() => {}); }
    check("a composer covered by a banner is still typed into and sent", r === "PONG" && queue.length === 0, JSON.stringify(r));

    const deaf = await open(cfg, "deaf", '<!doctype html><div class="ds-virtual-list-visible-items"></div><textarea placeholder="Message"></textarea>');
    const counted = () => (deaf.pacer.read() || { count: 0 }).count;
    const before = counted();
    queue = [OK];
    err = null;
    const t2 = Date.now();
    try { await deaf.sendPrompt("nobody hears this", cfg); } catch (e) { err = e; }
    const took = Date.now() - t2;
    const after = counted();
    await deaf.close().catch(() => {});
    check("a send the page ignores is pressed once more, then reported", err && /did not send the prompt/.test(err.message) && /twice/.test(err.message), err ? err.message : "no error");
    check("without waiting out the reply ceiling", took < 30000, String(took));
    check("and it is not counted against the day's budget", after === before && queue.length === 1, before + " -> " + after);
    queue = [];

    await c.page.goto("https://ds.test/sign_in");
    err = null;
    const t1 = Date.now();
    try { await c.sendPrompt("hello", cfg); } catch (e) { err = e; }
    check("signed out, the send stops at once with 'sign in again'", err && err.kind === "signed-out" && /Sign in/.test(err.message) && Date.now() - t1 < 5000, err && err.message);
  } finally {
    await c.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testStreamStatus() {
  section("a failed reply request says so instead of timing out");
  const S = require(path.join(DIST, "providers/stream-status.js"));

  check("a healthy reply is not a failure", S.describeStreamFailure(200) === null);
  check("nor is any 2xx", S.describeStreamFailure(204) === null);
  // XHR reports 0 before headers arrive; treating that as an error would fail
  // every single healthy reply.
  check("status 0 is not a failure", S.describeStreamFailure(0) === null);
  check("a missing status is not a failure",
    S.describeStreamFailure(undefined) === null && S.describeStreamFailure(NaN) === null);

  const limited = S.describeStreamFailure(429);
  check("429 is recognised as rate limiting", /rate limiting/i.test(limited.message), limited.message);
  check("and says to wait rather than blaming the code",
    /wait/i.test(limited.message) && /nothing is wrong with the code/i.test(limited.message));
  check("and is fatal, because waiting longer cannot help", limited.fatal === true);

  const unauth = S.describeStreamFailure(401);
  check("401 points at the session, not the code", /sign in again/i.test(unauth.message), unauth.message);
  check("403 does too", /sign in again/i.test(S.describeStreamFailure(403).message));

  const server = S.describeStreamFailure(503);
  check("5xx is named as the provider's end", /their end/i.test(server.message), server.message);

  const other = S.describeStreamFailure(418);
  check("an unrecognised failure still reports its code", /HTTP 418/.test(other.message), other.message);
  check("and still stops the wait", other.fatal === true);

  // Deliberately out of scope, and the test records why: a content refusal is a
  // successful reply whose prose declines. Same status, same stream, nothing
  // structural to read - so this module must not pretend to detect it.
  check("a content refusal is not something a status can reveal",
    S.describeStreamFailure(200) === null);
}

// DeepSeek's reasoning, as measured on the live site on 8 October 2026 and
// trimmed: the reasoning is a ds-markdown inside .ds-think-content, and
// collapsing it removes it from the page.
async function testThinkingReader() {
  section("reasoning reader: DeepSeek's thinking markup (real chromium)");
  let browser;
  try {
    browser = await require("playwright").chromium.launch();
  } catch (e) {
    console.log("  skip (chromium unavailable: " + String(e.message).split("\n")[0] + ")");
    skipped.push("reasoning reader");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-think-"));
  try {
    const ds = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "providers", "deepseek.json"), "utf8"));
    const cfg = Object.assign({}, ds, { profileDir: path.join(root, "profiles", "ds") });
    const page = await browser.newPage();
    const user = (t) => '<div class="d29f3d7d ds-message"><div class="ds-collapsible-text"><span>' + t + "</span></div></div>";
    const head = (t) => '<div class="_245c867"><span class="_5255ff8">' + t + "</span></div>";
    const think = (t) => '<div class="ds-think-content"><div class="ds-markdown">' + t + "</div></div>";
    const answer = (t) => '<div class="ds-markdown ds-assistant-message-main-content">' + t + "</div>";
    const turn = (inner) => '<div class="ds-message">' + inner + "</div>";
    const EARLIER = user("first") + turn(head("Thought for 2 seconds") + think("<p>old reasoning</p>") + answer("<p>old answer</p>"));
    const fresh = () => { const c = new PlaywrightController(cfg); c.attachPageForReplay(page); return c; };
    const set = (html) => page.setContent("<main>" + html + "</main>");

    await set(EARLIER + user("second") + turn(head("Thought for 3 seconds") +
      think("<p>Check 391.</p><ul><li>17 x 23 = 391</li></ul>") + answer("<p>391 = 17 × 23, not prime.</p>")));
    let c = fresh();
    const reply = await c.getLastMessageStructured(cfg);
    check("the reply is the answer, not the reasoning", /not prime/.test(reply) && !/Check 391/.test(reply), reply);
    check("the last-message text the wait watches is the answer", /not prime/.test(await c.getLastMessageText(cfg)));
    let r = await c.getLastThinking(cfg);
    check("the newest turn's reasoning is read as markdown", /Check 391\./.test(r) && /^- 17 x 23 = 391$/m.test(r), r);
    check("an earlier turn's reasoning is not part of it", !/old reasoning/.test(r), r);

    // Sent, and the reply's turn not drawn yet: the last turn is the prompt.
    await set(EARLIER + user("second"));
    check("before the reply's turn exists there is no reasoning", (await fresh().getLastThinking(cfg)) === "");

    // A new chat whose first reply is still thinking: nothing is a reply yet,
    // and no fallback may pick the reasoning up instead.
    await set(user("hi") + turn(head("Thinking") + think("<p>mid-thought</p>")));
    c = fresh();
    check("reasoning alone counts as no reply", (await c.countMessages(cfg)) === 0 && (await c.getLastMessageText(cfg)) === "");
    check("and is still relayed", /mid-thought/.test(await c.getLastThinking(cfg)));

    // Collapsed: the header is there and the reasoning is gone from the page.
    await set(EARLIER + user("second") + turn('<div class="_245c867"><span class="_5255ff8" id="h">Thought for 4 seconds</span></div>' +
      answer("<p>done</p>")) + "<script>window.clicks=0;document.getElementById('h').onclick=function(){window.clicks++;" +
      "this.parentNode.insertAdjacentHTML('afterend','<div class=\"ds-think-content\"><div class=\"ds-markdown\"><p>expanded reasoning</p></div></div>');};</script>");
    r = await fresh().getLastThinking(cfg);
    check("a collapsed reasoning block is expanded and read", /expanded reasoning/.test(r), r);
    check("by one click on its header", (await page.evaluate(() => window.clicks)) === 1);

    await set(EARLIER + user("second") + turn(answer("<p>no thinking here</p>")));
    check("a reply without reasoning has none", (await fresh().getLastThinking(cfg)) === "");

    const plain = Object.assign({}, cfg, { selectors: Object.assign({}, cfg.selectors, { thinking: undefined, turn: undefined }) });
    check("a provider with no reasoning selectors reads none", (await fresh().getLastThinking(plain)) === "");
  } finally {
    await browser.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testNavigationRetry() {
  section("navigation: Chromium's retry-me errors are retried");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-nav-"));
  const cfg = { id: "nav", name: "Nav", baseUrl: "https://example.test/", selectors: {}, profileDir: path.join(root, "profiles", "nav") };
  // A stand-in page whose goto fails with each error in turn, then succeeds.
  const stub = (errors) => {
    const page = { calls: 0, goto: async () => { const e = errors[page.calls++]; if (e) throw new Error(e); } };
    const c = new PlaywrightController(cfg);
    c.attachPageForReplay(page);
    return { c, page };
  };
  const quiet = console.log;
  console.log = () => {};
  try {
    let t = stub(["page.goto: net::ERR_CERT_VERIFIER_CHANGED at https://example.test/"]);
    await t.c.navigateFresh(cfg);
    check("a changed certificate verifier is navigated again", t.page.calls === 2);

    t = stub(["page.goto: net::ERR_NETWORK_CHANGED at https://example.test/"]);
    await t.c.navigateFresh(cfg);
    check("so is a changed network", t.page.calls === 2);

    t = stub(["page.goto: net::ERR_NAME_NOT_RESOLVED at https://example.test/"]);
    let threw = false;
    try { await t.c.navigateFresh(cfg); } catch { threw = true; }
    check("any other failure is not retried", threw && t.page.calls === 1);

    const again = "page.goto: net::ERR_CERT_VERIFIER_CHANGED at https://example.test/";
    t = stub([again, again, again, again]);
    threw = false;
    try { await t.c.navigateFresh(cfg); } catch { threw = true; }
    check("and the retries stop after three tries", threw && t.page.calls === 3);
  } finally {
    console.log = quiet;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testRoutes() {
  section("routes: browser, copy and paste");
  const R = require(path.join(DIST, "providers/route-session.js"));
  check("there is no API route and no API session", R.ROUTES.join() === "browser,manual" && R.routeOf("api") === null &&
    !fs.existsSync(path.join(DIST, "providers/api-session.js")));

  // Copy and paste.
  const shown = [];
  const m = new R.ManualSession(function (p) { shown.push(p); });
  const a1 = m.ask("prompt one");
  check("a prompt is shown to copy", shown[0] === "prompt one" && m.awaiting);
  check("the pasted reply answers it", m.supply("pasted") && (await a1) === "pasted" && !m.awaiting);
  check("a reply with nothing waiting is refused", m.supply("stray") === false);
  const a2 = m.ask("prompt two");
  m.cancel("Stopped.");
  let why = "";
  try { await a2; } catch (e) { why = e.message; }
  check("Esc stops the wait with a reason", why === "Stopped." && !m.awaiting);

  // The router.
  const fake = function (name, log) {
    return { start: async function () {}, ready: async function () { return { ok: true, detail: name }; },
      ask: async function (p) { log.push(name + ":" + p); return name; }, reset: async function () { log.push(name + ":reset"); },
      close: async function () { log.push(name + ":close"); } };
  };
  const log = [];
  let opens = 0;
  const failing = new R.RoutedSession({ openBrowser: async function () { opens++; throw new Error("page changed"); }, manual: new R.ManualSession(function () {}) });
  let startErr = "";
  try { await failing.start(); } catch (e) { startErr = e.message; }
  failing.fallBack();
  check("a browser that cannot open leaves copy and paste", startErr === "page changed" && failing.route === "manual");
  check("both routes are offered", failing.available().join() === "browser,manual");
  let again = "";
  try { await failing.use("browser"); } catch (e) { again = e.message; }
  check("/route browser tries the page again", opens === 2 && again === "page changed" && failing.route === "manual");

  const mm = new R.ManualSession(function () {});
  const r = new R.RoutedSession({ openBrowser: async function () { return fake("browser", log); }, manual: mm });
  await r.start();
  check("prompts go to the browser first", r.route === "browser" && (await r.ask("p")) === "browser");
  await r.reset();
  check("a new conversation resets the page", log.indexOf("browser:reset") !== -1);
  await r.use("manual");
  const waiting = r.ask("copy me");
  await r.use("browser");
  let moved = "";
  try { await waiting; } catch (e) { moved = e.message; }
  check("leaving copy and paste stops its wait", /browser route/.test(moved));
  check("route names are read loosely, unknown ones are null", R.routeOf("Manual ") === "manual" && R.routeOf("ftp") === null);
  await r.close();
  check("closing closes the page", log.indexOf("browser:close") !== -1);

  for (const id of ["deepseek", "glm", "qwen-studio"]) {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "providers", id + ".json"), "utf8"));
    check(id + " names no API and no key", !("api" in cfg) && !/_API_KEY|keyEnv/.test(JSON.stringify(cfg)));
    check(id + " keeps a short gap between prompts", cfg.pacing && cfg.pacing.minGapMs >= 1000 && cfg.pacing.minGapMs <= 10000);
  }
}

async function run(c, s, sk) {
  check = c; section = s; skipped = sk;
  testControlDecisions();
  testControlSettings();
  testProviderGating();
  await testBrowserExtraction();
  await testReaderSweep();
  await testThinkingReader();
  await testNavigationRetry();
  await testSelectorSyntax();
  testSelectorHealth();
  testSmokeReport();
  await testLocalModels();
  testResearch();
  testStreamStatus();
  testReplyTrouble();
  await testReplyTroubleLive();
  await testSnapshots();
  await testResilience();
  await testLocateLive();
  await testRoutes();
}

module.exports = { run };
