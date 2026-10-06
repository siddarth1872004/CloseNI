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
  for (const f of walk(path.join(ROOT, "local-agent", "src"), []).concat(walk(path.join(ROOT, "desktop"), []))) {
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

async function run(c, s, sk) {
  check = c; section = s; skipped = sk;
  testControlDecisions();
  testControlSettings();
  testProviderGating();
  await testBrowserExtraction();
  await testReaderSweep();
  await testSelectorSyntax();
  testSelectorHealth();
  testSmokeReport();
  await testLocalModels();
  testResearch();
  testStreamStatus();
}

module.exports = { run };
