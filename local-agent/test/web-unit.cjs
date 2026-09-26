/*
 * Unit tests for the browser-native layer (local-agent/src/web). No browser.
 *
 *   node local-agent/test/web-unit.cjs        on its own
 *   npm test                                  as part of the unit suite
 *
 * Every pure module is tested against data: signal sets, synthetic ticks,
 * parsed HTML, recorded provider markup. The browser-driven behaviour is in
 * run-web.cjs.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const W = path.join(__dirname, "..", "dist", "web");
const req = (p) => require(path.join(W, p));

async function run(check, section) {
  const { redactUrl, redactText, formatEvent, Tracer } = req("trace.js");
  const { classifyNavError } = req("browser/navigate.js");
  const { judgeChain, describeStrategy } = req("selectors/chain.js");
  const { parseHtml, decodeEntities, textOf } = req("semantic/dom.js");
  const B = req("semantic/blocks.js");
  const { classifyState, isTerminalForAutomation } = req("providers/state.js");
  const { CompletionDetector, StreamCapture } = req("providers/completion-detector.js");
  const N = req("response/normalize.js");
  const A = req("providers/adapters.js");
  const U = req("research/url.js");
  const { selectMainContent, stripBoilerplate, RepeatedBlocks } = req("research/content.js");
  const { buildWebPage, sectionize } = req("research/page.js");
  const { chunkPage } = req("research/chunk.js");
  const { rankChunks, isRelevant, Bm25 } = req("research/relevance.js");
  const { findInPage } = req("research/find.js");
  const { judgeLink, Frontier } = req("research/links.js");
  const D = req("research/dedupe.js");
  const E = req("research/evidence.js");
  const { detectConflicts } = req("research/conflicts.js");
  const { SourceGraph } = req("research/graph.js");
  const { buildContext, checkCitations } = req("research/context.js");
  const P = req("research/planner.js");
  const { TtlCache, ResearchCaches } = req("research/cache.js");
  const S = req("research/search.js");
  const { BrowserMemory, ResearchMemory } = req("research/memory.js");
  const { looksLikeAppShell } = req("research/fetcher.js");
  const util = req("util.js");

  // ------------------------------------------------------------ tracing --
  section("web: tracing redacts credentials wherever they appear");
  check("userinfo is stripped from a URL", !/secret/.test(redactUrl("https://user:secret@example.com/x")));
  check("a token query parameter is redacted", /token=REDACTED/.test(redactUrl("https://a.test/cb?token=abc123&x=1")) && /x=1/.test(redactUrl("https://a.test/cb?token=abc123&x=1")));
  check("a bearer token is redacted", redactText("Authorization: Bearer abcdefghijklmnop").indexOf("abcdefghijklmnop") === -1);
  check("a cookie header is redacted", !/sessionid=zzz/.test(redactText("cookie: sessionid=zzz; other=1")));
  check("a GitHub token is redacted", !/ghp_/.test(redactText("used ghp_" + "a".repeat(36))));
  check("a JWT is redacted", !/eyJ/.test(redactText("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop")));
  check("ordinary text passes through", redactText("the reply had 3 code blocks") === "the reply had 3 code blocks");
  {
    const seen = [];
    const t = new Tracer({ session: "s1", sink: (e) => seen.push(e) });
    const c = t.child({ provider: "qwen" });
    c.event({ action: "navigation", result: "success", url: "https://chat.qwen.ai/?session=abc", durationMs: 1840 });
    check("events carry session and provider", seen[0].session === "s1" && seen[0].provider === "qwen");
    check("event URLs are redacted at the sink", /session=REDACTED/.test(seen[0].url));
    const line = formatEvent(seen[0]);
    check("a formatted line reads [time] [QWEN] [navigation] … status=success", /^\[\d\d:\d\d:\d\d\] \[QWEN\] \[navigation\] URL=.* duration=1840ms status=success/.test(line), line);
    let threw = false;
    await c.span("boom", {}, async () => { throw new Error("nope"); }).catch(() => { threw = true; });
    check("span re-throws and records the failure", threw && seen[seen.length - 1].result === "failure" && seen[seen.length - 1].error === "nope");
  }

  // --------------------------------------------------------- navigation --
  section("web: navigation failures are classified by what to do next");
  check("timeout", classifyNavError("page.goto: Timeout 30000ms exceeded.") === "timeout");
  check("dns", classifyNavError("net::ERR_NAME_NOT_RESOLVED at https://x") === "dns");
  check("a proxy refusal is 'blocked', not a site fault", classifyNavError("net::ERR_TUNNEL_CONNECTION_FAILED at https://chat.deepseek.com/") === "blocked");
  check("refused", classifyNavError("net::ERR_CONNECTION_REFUSED at http://127.0.0.1:1") === "refused");
  check("tls", classifyNavError("net::ERR_CERT_AUTHORITY_INVALID") === "tls");
  check("a port the browser refuses to use is 'blocked'", classifyNavError("net::ERR_UNSAFE_PORT at http://127.0.0.1:1/") === "blocked");
  check("aborted", classifyNavError("net::ERR_ABORTED; maybe frame was detached?") === "aborted");
  check("crash", classifyNavError("Target page, context or browser has been closed") === "crash");

  // ------------------------------------------------------------- chains --
  section("web: selector chains report which link held");
  {
    const r = [{ description: "css=a", provenance: "MEASURED", count: 0 }, { description: "role=textbox", provenance: "UNVERIFIED", count: 1 }];
    const d = judgeChain("composer", r, 1);
    check("a chain carried by a later link is 'fallback'", d.verdict === "fallback" && /re-capture/.test(d.note), d.note);
    check("and says which link and its provenance", /role=textbox/.test(d.note) && /UNVERIFIED/.test(d.note));
    check("primary match is ok", judgeChain("c", [{ description: "css=a", provenance: "MEASURED", count: 2 }], 0).verdict === "ok");
    check("nothing matching is broken", judgeChain("c", [{ description: "css=a", provenance: "MEASURED", count: 0 }], -1).verdict === "broken");
    check("strategies describe themselves", describeStrategy({ kind: "role", role: "button", name: "Send" }) === 'role=button[name="Send"]');
  }

  // ---------------------------------------------------------- parseHtml --
  section("web: the HTML parser keeps what extraction needs");
  {
    const s = parseHtml('<html lang="en"><head><title>A &amp; B</title><meta name="description" content="d"><link rel="canonical" href="/c"></head><body><p>one<p>two<ul><li>x<li>y</ul><pre>  a\n    b\n</pre><script>var x = "<p>no</p>";</script><div hidden>secret</div><p style="display:none">gone</p></body></html>', "https://site.test/page");
    check("title with entities", s.title === "A & B");
    check("language", s.lang === "en");
    check("canonical made absolute", s.meta.canonical === "https://site.test/c");
    const text = textOf(s.root);
    check("implied </p> closes paragraphs", (s.root.c || []).filter((n) => n.t === "p").length >= 2);
    check("script contents never become text", !/no/.test(text.replace(/one|two/g, "")) || !/var x/.test(text));
    check("hidden attribute and display:none are hidden", !/secret|gone/.test(text));
    check("<pre> whitespace survives", /  a\n    b/.test(text));
    check("numeric entities decode", decodeEntities("&#x2191;&#65;") === "\u2191A");
    check("malformed input does not throw", !!parseHtml("<div><p>unclosed <b>bold</div></span>").root);
  }

  // ------------------------------------------------------------- blocks --
  section("web: DOM becomes typed blocks, then Markdown");
  {
    const html = '<div><h2 id="t">Title</h2><p>Some <b>bold</b>, <code>x()</code> and a <a href="https://e.test/a">link</a>.</p>' +
      '<ol><li>first</li><li>second</li></ol><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2|3</td></tr></tbody></table>' +
      '<pre><code class="language-python">print(1)\n</code></pre><div role="button">Copy</div><button>Regenerate</button>' +
      '<details><summary>More</summary><p>hidden detail</p></details><blockquote><p>quoted</p></blockquote><img src="https://e.test/i.png" alt="diagram"></div>';
    const bl = B.domToBlocks(parseHtml(html).root);
    const types = bl.map((b) => b.type).join(",");
    check("block order and types", types === "heading,paragraph,list,table,code,details,quote,image", types);
    check("code language from the class", bl.find((b) => b.type === "code").lang === "python");
    check("controls are not content", !/Copy|Regenerate/.test(B.blocksToText(bl)));
    const md = B.blocksToMarkdown(bl);
    check("inline markdown: bold, code, link", /\*\*bold\*\*/.test(md) && /`x\(\)`/.test(md) && /\[link\]\(https:\/\/e\.test\/a\)/.test(md), md);
    check("ordered list renders numbered", /1\. first\n2\. second/.test(md));
    check("table renders with an escaped pipe", /\| A \| B \|/.test(md) && /2\\\|3/.test(md), md);
    check("links are collected", B.collectLinks(bl).length === 1 && B.collectLinks(bl)[0].href === "https://e.test/a");
    const reasoning = B.domToBlocks(parseHtml('<div><div class="think-box"><p>step one</p></div><p>answer</p></div>').root, { reasoning: [/think/] });
    check("a reasoning hint separates the reasoning subtree", reasoning[0].type === "reasoning" && reasoning[1].type === "paragraph");
    check("reasoning is excluded from answer collections", B.collect(reasoning, "paragraph").length === 1);
    const cite = B.domToBlocks(parseHtml('<p>Claim <span class="cite-chip"><a href="https://src.test">[1]</a></span></p>').root, { citation: [/cite/] });
    check("citation hint yields citation blocks", B.collect(cite, "citation").length === 1 && B.collect(cite, "citation")[0].href === "https://src.test");
  }
  {
    const snap = parseHtml(fs.readFileSync(path.join(__dirname, "fixtures", "replay", "deepseek-reply.html"), "utf8"));
    const bl = B.domToBlocks(snap.root);
    check("recorded DeepSeek reply: prose, python code, prose", bl.map((b) => b.type + (b.lang ? ":" + b.lang : "")).join(",") === "paragraph,code:python,paragraph");
    const code = bl.find((b) => b.type === "code").text;
    check("recorded DeepSeek reply: code keeps its lines", code.split("\n").length > 10 && /^import re\nimport unicodedata/.test(code), code.slice(0, 60));
    check("recorded DeepSeek reply: the language banner is not a paragraph", !bl.some((b) => b.type === "paragraph" && b.text === "python"));
  }

  // -------------------------------------------------------------- state --
  section("web: UI state is classified from signals, with evidence");
  const base = { url: "https://x.test/", title: "t", readyState: "complete", composerVisible: false, composerEnabled: false, stopVisible: false, sendEnabled: null, assistantCount: 0, lastAssistantChars: 0, passwordField: false, loginPrompt: false, modalOpen: false, modalIsLogin: false, captcha: false, alerts: [], busy: false, bodyChars: 500 };
  const st = (over, ctx) => classifyState({ ...base, ...over }, ctx || {});
  check("composer visible and enabled → CHAT_READY", st({ composerVisible: true, composerEnabled: true }).state === "CHAT_READY");
  check("password field and no composer → AUTH_REQUIRED", st({ passwordField: true }).state === "AUTH_REQUIRED");
  check("login control and no composer → AUTH_REQUIRED", st({ loginPrompt: true }).state === "AUTH_REQUIRED");
  check("a login control beside a working composer is guest mode, not a wall", st({ loginPrompt: true, composerVisible: true, composerEnabled: true }).state === "CHAT_READY");
  check("a login dialog over the composer → AUTH_REQUIRED", st({ composerVisible: true, composerEnabled: true, modalOpen: true, modalIsLogin: true }).state === "AUTH_REQUIRED");
  check("a challenge outranks a login", st({ captcha: true, passwordField: true }).state === "CAPTCHA");
  check("HTTP 429 on the reply → RATE_LIMITED", st({ composerVisible: true, composerEnabled: true, streamStatus: 429 }).state === "RATE_LIMITED");
  check("a rate-limit alert → RATE_LIMITED", st({ composerVisible: true, composerEnabled: true, alerts: ["Too many requests. Please try again later."] }).state === "RATE_LIMITED");
  check("401 on the reply → AUTH_REQUIRED", st({ composerVisible: true, streamStatus: 401 }).state === "AUTH_REQUIRED");
  check("5xx page → ERROR", st({ httpStatus: 503 }).state === "ERROR");
  check("5xx during generation → GENERATION_FAILED", st({ composerVisible: true, streamStatus: 500 }, { inFlight: true }).state === "GENERATION_FAILED");
  check("stop control visible → GENERATING", st({ composerVisible: true, composerEnabled: true, stopVisible: true }).state === "GENERATING");
  check("detector complete → GENERATION_COMPLETE", st({ composerVisible: true, composerEnabled: true }, { detector: "complete" }).state === "GENERATION_COMPLETE");
  check("loading document → LOADING", st({ readyState: "loading" }).state === "LOADING");
  check("busy indicator → LOADING", st({ busy: true }).state === "LOADING");
  check("loaded, no composer, no login → READY with a reason", st({}).state === "READY" && /not a chat page/.test(st({}).evidence[0]));
  check("an error alert with no composer → ERROR", st({ alerts: ["Something went wrong"] }).state === "ERROR");
  check("terminal states are the ones automation cannot pass", isTerminalForAutomation("AUTH_REQUIRED") && isTerminalForAutomation("CAPTCHA") && !isTerminalForAutomation("LOADING"));

  // --------------------------------------------------------- completion --
  section("web: completion is detected from signals, not sleeps");
  const opts = { stabilityMs: 3000, settleMs: 500, startTimeoutMs: 10000, maxWaitMs: 60000, useStopControl: true };
  const feedAll = (det, ticks) => { let v; for (const t of ticks) v = det.feed({ assistantCount: 1, stopVisible: false, streamsOpened: 0, streamsClosed: 0, mutationSeq: 0, ...t }); return v; };
  {
    const d = new CompletionDetector({ count: 0, text: "" }, opts);
    const v = feedAll(d, [{ atMs: 100, text: "", assistantCount: 0 }, { atMs: 400, text: "Hel", streamsOpened: 1, mutationSeq: 1 }, { atMs: 700, text: "Hello", streamsOpened: 1, mutationSeq: 2 }, { atMs: 900, text: "Hello", streamsOpened: 1, streamsClosed: 1, mutationSeq: 2 }, { atMs: 1500, text: "Hello", streamsOpened: 1, streamsClosed: 1, mutationSeq: 2 }]);
    check("a closed stream ends the wait after the settle window", v.phase === "complete" && v.reason === "stream-closed", JSON.stringify(v));
  }
  {
    const d = new CompletionDetector({ count: 0, text: "" }, opts);
    const v = feedAll(d, [{ atMs: 100, text: "", assistantCount: 0 }, { atMs: 400, text: "a", stopVisible: true, mutationSeq: 1 }, { atMs: 900, text: "ab", stopVisible: false, mutationSeq: 2 }, { atMs: 1500, text: "ab", mutationSeq: 2 }]);
    check("the stop control disappearing ends the wait", v.phase === "complete" && v.reason === "stop-button-gone", JSON.stringify(v));
  }
  {
    const d = new CompletionDetector({ count: 0, text: "" }, { ...opts, useStopControl: false });
    const a = feedAll(d, [{ atMs: 100, text: "a", mutationSeq: 1 }, { atMs: 2000, text: "a", mutationSeq: 1 }]);
    check("a pause shorter than the stability window is not the end", a.phase === "streaming");
    const b = d.feed({ atMs: 3200, assistantCount: 1, text: "a", stopVisible: false, streamsOpened: 0, streamsClosed: 0, mutationSeq: 1 });
    check("stability ends it once the window passes", b.phase === "complete" && b.reason === "stability");
  }
  {
    const d = new CompletionDetector({ count: 0, text: "" }, opts);
    const v = feedAll(d, [{ atMs: 100, text: "a", stopVisible: true, mutationSeq: 1 }, { atMs: 5000, text: "a", stopVisible: true, mutationSeq: 1 }]);
    check("a model that pauses while its stop control is up is still writing", v.phase === "streaming");
  }
  {
    const d = new CompletionDetector({ count: 0, text: "" }, { ...opts, useStopControl: false, streamStallMs: 8000 });
    const v = feedAll(d, [{ atMs: 100, text: "a", streamsOpened: 1, mutationSeq: 1 }, { atMs: 5000, text: "a", streamsOpened: 1, mutationSeq: 1 }]);
    check("a pause while the reply request is still open is not the end", v.phase === "streaming", JSON.stringify(v));
    const w = d.feed({ atMs: 8200, assistantCount: 1, text: "a", stopVisible: false, streamsOpened: 1, streamsClosed: 0, mutationSeq: 1 });
    check("an open request quiet past the stall window ends as stalled, not complete-by-stability", w.phase === "complete" && w.reason === "stalled", JSON.stringify(w));
  }
  {
    const d = new CompletionDetector({ count: 3, text: "a long previous answer" }, opts);
    const v = feedAll(d, [{ atMs: 300, assistantCount: 3, text: "a long previous answer" }, { atMs: 600, assistantCount: 3, text: "short", mutationSeq: 1 }]);
    check("a SHORTER follow-up reply still counts as started", v.reason === "started");
  }
  {
    const d = new CompletionDetector({ count: 0, text: "" }, opts);
    check("no reply by the start timeout is a failure", feedAll(d, [{ atMs: 10001, assistantCount: 0, text: "" }]).reason === "no-start");
    const e = new CompletionDetector({ count: 0, text: "" }, opts);
    check("an HTTP failure on the reply fails immediately", e.feed({ atMs: 100, assistantCount: 0, text: "", stopVisible: false, streamsOpened: 1, streamsClosed: 0, mutationSeq: 0, streamStatus: 429 }).reason === "http-failure");
    const f = new CompletionDetector({ count: 0, text: "" }, { ...opts, maxWaitMs: 2000, useStopControl: true });
    const v = feedAll(f, [{ atMs: 100, text: "a", stopVisible: true, mutationSeq: 1 }, { atMs: 2100, text: "ab", stopVisible: true, mutationSeq: 2 }]);
    check("the ceiling ends a never-finishing reply as a timeout", v.phase === "complete" && v.reason === "timeout");
  }
  {
    const c = new StreamCapture();
    c.update("Hello, this is", 1);
    const d = c.update("Hello, this is a research", 2);
    check("streaming delta is the appended text", d.kind === "append" && d.delta === " a research");
    const r = c.update("Hello, this was rewritten", 3);
    check("a rewrite is reported as one, with the changed tail", r.kind === "rewrite" && r.delta === "was rewritten");
    check("an unchanged read produces no partial", c.update("Hello, this was rewritten", 4).kind === "none" && c.partials.length === 3);
  }

  // ---------------------------------------------------------- normalize --
  section("web: a reply normalises into an AIResponse without invented fields");
  {
    const dom = parseHtml('<div data-message-id="msg-42-17"><div class="thinking-box"><p>I will compute.</p></div><p>Answer with a <a href="https://docs.test/report.pdf">report</a>.</p><pre><code class="language-js">x = 1</code></pre><table><tr><th>k</th></tr><tr><td>v</td></tr></table></div>').root.c[0];
    const res = N.pipeline({ provider: "fx", dom, innerText: "I will compute. Answer with a report. x = 1 k v", url: "https://chat.test/c/abcdef0123456789abcd", capturedAt: "2026-09-26T00:00:00Z" }, {},
      { conversationIdPattern: A.DEEPSEEK.conversationIdPattern, meta: { strategy: "css=x", provenance: "FIXTURE", extractMs: 0, copyButtonUsed: false, warnings: [] } });
    check("reasoning separated from the answer", res.reasoning && /compute/.test(res.reasoning.text) && !/compute/.test(res.content.text));
    check("code, table and links extracted", res.content.code.length === 1 && res.content.tables.length === 1 && res.content.links.length === 1);
    check("a linked file is an attachment and an artifact", res.attachments.length === 1 && res.artifacts.some((a) => a.kind === "file-link"));
    check("message id from the markup", res.messageId === "msg-42-17");
    check("conversation id from the URL", res.conversationId === "abcdef0123456789abcd");
    check("status complete without a wait", res.status === "complete");
    const empty = N.pipeline({ provider: "fx", dom: parseHtml("<div></div>").root, innerText: "", url: "", capturedAt: "t" }, {}, { meta: { strategy: "x", provenance: "FIXTURE", extractMs: 0, copyButtonUsed: false, warnings: [] } });
    check("an empty reply is status 'empty' with no reasoning field", empty.status === "empty" && !("reasoning" in empty));
    const flat = N.pipeline({ provider: "fx", dom: null, innerText: "only text", url: "", capturedAt: "t" }, {}, { meta: { strategy: "x", provenance: "FIXTURE", extractMs: 0, copyButtonUsed: false, warnings: [] } });
    check("no DOM → text kept, and a warning that structure was lost", flat.content.text === "only text" && /structure lost/.test(flat.extraction_metadata.warnings.join()));
    const lossy = N.pipeline({ provider: "fx", dom: parseHtml("<div><p>tiny</p></div>").root, innerText: "tiny plus a great deal more text that the DOM snapshot somehow did not contain at all", url: "", capturedAt: "t" }, {}, { meta: { strategy: "x", provenance: "FIXTURE", extractMs: 0, copyButtonUsed: false, warnings: [] } });
    check("structured text far below visible text is flagged", /covers \d+%/.test(lossy.extraction_metadata.warnings.join()));
  }

  // ----------------------------------------------------------- adapters --
  section("web: adapters record what is and is not known");
  const allStrategies = (spec) => Object.values(spec.chains).flatMap((c) => c.strategies);
  check("DeepSeek has no stop chain - measured not to exist", A.DEEPSEEK.chains.stop.strategies.length === 0 && A.DEEPSEEK.knowledge["stop control"] === "NOT_APPLICABLE");
  check("DeepSeek's reply stream is the measured endpoint", A.DEEPSEEK.streamUrlPattern === "/api/v0/chat/completion");
  check("GLM claims nothing as MEASURED", !allStrategies(A.GLM).some((s) => s.provenance === "MEASURED"));
  check("no adapter claims a stream endpoint it never measured", !A.QWEN.streamUrlPattern && !A.GLM.streamUrlPattern);
  check("reasoning markup is UNKNOWN everywhere", ["deepseek", "qwen", "glm"].every((id) => A.adapterFor(id).knowledge["reasoning markup"] === "UNKNOWN"));
  check("the app's config id qwen-studio maps to the Qwen adapter", A.adapterFor("qwen-studio").id === "qwen");
  check("every chain ends in a heuristic or has none", ["composer", "send", "assistant"].every((k) => { const s = A.GLM.chains[k].strategies; return s[s.length - 1].kind === "heuristic"; }));
  const fromCfg = A.adapterFromConfig({ id: "mock", name: "M", baseUrl: "http://x/", selectors: { chatInput: "#i", sendButton: "#s", assistantMessage: ".a", stopButton: "#stop" }, completionRules: { maxWaitMs: 1234 } });
  check("an adapter can be built from a provider config", fromCfg.chains.composer.strategies[0].css === "#i" && fromCfg.timing.maxWaitMs === 1234);

  // ---------------------------------------------------------------- url --
  section("web: one URL, one identity");
  check("tracking parameters, fragment, www and trailing slash removed", U.canonicalizeUrl("https://www.Example.com/a/b/?utm_source=x&id=2&fbclid=z#top") === "//example.com/a/b?id=2");
  check("query order does not matter", U.canonicalizeUrl("http://e.test/p?b=2&a=1") === U.canonicalizeUrl("https://e.test/p?a=1&b=2"));
  check("index.html is the directory", U.canonicalizeUrl("https://e.test/docs/index.html") === U.canonicalizeUrl("https://e.test/docs/"));
  check("cleanUrl keeps the scheme but drops tracking", U.cleanUrl("https://e.test/x?utm_medium=a&k=1#f") === "https://e.test/x?k=1");
  check("source types from URLs", U.sourceTypeOf("https://github.com/a/b") === "code-repository" && U.sourceTypeOf("https://docs.python.org/3/") === "documentation" && U.sourceTypeOf("https://arxiv.org/abs/1") === "academic" && U.sourceTypeOf("https://en.wikipedia.org/wiki/X") === "encyclopedia");
  check("siteOf groups subdomains", U.siteOf("https://docs.python.org/x") === "python.org" && U.siteOf("https://a.b.co.uk/") === "b.co.uk");

  // ------------------------------------------------------------ content --
  section("web: main content is chosen by several methods voting");
  const page = (body, title = "T") => parseHtml("<html><head><title>" + title + "</title></head><body>" + body + "</body></html>", "https://site.test/p");
  {
    const s = page('<nav class="topnav"><a href="/">Home</a> <a href="/a">About</a></nav><main><article><h1>Guide</h1><p>' + "Real content sentence. ".repeat(20) + '</p><h2>More</h2><p>' + "Second part. ".repeat(15) + '</p></article></main><footer>Copyright</footer>');
    const m = selectMainContent(s.root);
    check("article inside main chosen by consensus", m.node.t === "article" && /consensus/.test(m.method), m.method + " " + JSON.stringify(m.votes));
    const wp = buildWebPage(s);
    check("nav and footer text excluded from main text", !/Home|Copyright/.test(wp.main_text) && /Real content/.test(wp.main_text));
    check("whole-page text still has everything", /Copyright/.test(wp.text));
  }
  {
    const s = page('<div class="wrapper"><div class="menu"><a href="/1">One</a> <a href="/2">Two</a> <a href="/3">Three</a> <a href="/4">Four</a></div><div class="content"><h1>No semantic tags</h1><p>' + "A paragraph of genuine prose about the topic. ".repeat(12) + '</p><p>' + "Another paragraph here. ".repeat(10) + '</p></div><div class="sidebar"><p>Related links and ads</p></div></div>');
    const wp = buildWebPage(s);
    check("without semantic tags, density still finds the content", /genuine prose/.test(wp.main_text) && !/Related links/.test(wp.main_text), wp.main_content.method);
  }
  {
    const short = page("<main><article><h1>Rate limits</h1><p>The API allows 100 requests per minute.</p></article></main>");
    const wp = buildWebPage(short);
    check("a short page is not reduced to its heading", /100 requests per minute/.test(wp.main_text), wp.main_text);
  }
  {
    const s = page('<main><p>Keep this main text that is reasonably long so it counts as content.</p><div class="share-bar">Share on Twitter</div><div class="cookie-banner">We use cookies</div></main>');
    const st2 = stripBoilerplate(selectMainContent(s.root).node);
    check("share bars and cookie banners removed inside main", st2.removed === 2 && !/cookies|Twitter/.test(textOf(st2.node)));
    const rep = new RepeatedBlocks(3);
    for (let i = 0; i < 3; i++) rep.observe("site.test", "https://site.test/" + i, ["Was this page helpful? Let us know."]);
    check("a block on three pages of one site is boilerplate", rep.isBoilerplate("site.test", "Was this page helpful? Let us know."));
    check("but not on another site", !rep.isBoilerplate("other.test", "Was this page helpful? Let us know."));
  }

  // --------------------------------------------------------------- page --
  section("web: pages become section trees with linked context");
  const docHtml = '<main><article><h1>Widget</h1><p>Intro text for the widget library.</p><h2>Auth</h2><p>Tokens expire after 30 days. See <a href="/auth?utm_source=x">auth docs</a>.</p><h3>OAuth</h3><p>OAuth was added in 2.0.</p><pre><code class="language-bash">widget login</code></pre><h2>Limits</h2><table><tr><th>Plan</th><th>RPM</th></tr><tr><td>Free</td><td>60</td></tr></table></article></main><footer><a href="/privacy">Privacy</a></footer>';
  const wp = buildWebPage(page(docHtml, "Widget docs"));
  check("sections carry heading paths", wp.sections.map((s) => s.path.join(">")).includes("Widget docs>Widget>Auth>OAuth") || wp.sections.map((s) => s.path.join(">")).includes("Widget>Auth>OAuth"), JSON.stringify(wp.sections.map((s) => s.path)));
  check("code blocks and tables know their section", wp.code_blocks[0].headingPath.slice(-1)[0] === "OAuth" && wp.tables[0].headingPath.slice(-1)[0] === "Limits");
  const authLink = wp.links.find((l) => l.text === "auth docs");
  check("links carry heading path and in-main flag", authLink && authLink.inMain && authLink.headingPath.slice(-1)[0] === "Auth");
  check("link canonical form drops tracking", authLink && !/utm_/.test(authLink.canonical));
  check("footer links are not in main", wp.links.find((l) => l.text === "Privacy").inMain === false);
  check("sectionize splits on headings", sectionize([{ type: "heading", level: 1, text: "A" }, { type: "paragraph", text: "x", inlines: [] }, { type: "heading", level: 2, text: "B" }, { type: "paragraph", text: "y", inlines: [] }], "").length === 2);

  // ------------------------------------------------------------- chunks --
  section("web: chunks follow sections and keep code and tables whole");
  const chunks = chunkPage(wp);
  check("one chunk per section at least", chunks.length >= 4, chunks.length);
  check("code chunk kept whole", chunks.some((c) => c.kind === "code" && /widget login/.test(c.text)));
  check("table chunk kept whole", chunks.some((c) => c.kind === "table" && /Free/.test(c.text) && /RPM/.test(c.text)));
  check("chunks carry provenance fields", chunks.every((c) => c.url && c.headingPath && typeof c.position === "number" && c.retrieved_at));
  {
    const long = buildWebPage(page("<main><h1>L</h1><p>" + "This is a sentence that repeats. ".repeat(200) + "</p></main>"));
    const lc = chunkPage(long, { maxChars: 500, targetChars: 400 });
    check("an oversized paragraph is split at sentence boundaries", lc.length > 5 && lc.every((c) => c.text.length <= 700));
  }

  // ---------------------------------------------------------- relevance --
  section("web: relevance is a set of signals, stated order");
  {
    const bm = new Bm25(["token authentication expires", "performance benchmarks widgets", "unrelated cooking recipe"]);
    check("BM25 prefers the matching document", bm.score(0, ["token", "expiry"]) > bm.score(2, ["token", "expiry"]));
    const ranked = rankChunks(chunks, "how long do tokens expire");
    check("the auth chunk ranks first for a token question", /Tokens expire/.test(ranked[0].chunk.text), ranked[0].chunk.text.slice(0, 60));
    check("signals are exposed, not a single score", ["lexical", "headingMatch", "titleMatch", "coverage", "sourceType", "position"].every((k) => k in ranked[0].signals));
    check("an irrelevant chunk is not relevant", !isRelevant(rankChunks(chunks, "chocolate cake")[0]));
  }

  // --------------------------------------------------------------- find --
  section("web: find-in-page answers without reading the whole page");
  check("exact", findInPage(wp, "30 days", "exact").length === 1);
  check("case-insensitive", findInPage(wp, "TOKENS EXPIRE", "ci").length === 1);
  check("regex", findInPage(wp, "\\d+ days", "regex")[0].match === "30 days");
  check("keywords in any order", findInPage(wp, "expire tokens", "keywords").length === 1);
  check("heading", findInPage(wp, "oauth", "heading")[0].match === "OAuth");
  check("section returns the section's text", /added in 2\.0/.test(findInPage(wp, "oauth", "section")[0].context));
  check("code", findInPage(wp, "login", "code").length === 1);
  check("table", findInPage(wp, "free", "table").length === 1);
  const sem = findInPage(wp, "authentication", "semantic");
  check("semantic finds 'authentication' in the Auth part of the page via expansion", sem.length > 0 && sem[0].headingPath.includes("Auth") && !sem.some((h) => h.headingPath.includes("Limits")), JSON.stringify(sem.map((h) => h.headingPath)));
  check("an invalid regex returns nothing rather than throwing", findInPage(wp, "(", "regex").length === 0);

  // -------------------------------------------------------------- links --
  section("web: links are judged against the objective");
  {
    const j = (text, href, inMain, heading) => judgeLink({ text, href, canonical: U.canonicalizeUrl(href), headingPath: heading || [], inMain }, wp, "widget oauth authentication");
    check("a topical in-content link is FOLLOW", j("OAuth guide", "https://site.test/docs/oauth", true).decision === "FOLLOW");
    check("chrome is IGNORE", j("Privacy", "https://site.test/privacy", false).decision === "IGNORE");
    check("a file is IGNORE", j("download", "https://site.test/a.zip", true).decision === "IGNORE");
    check("social links are IGNORE", j("Share", "https://twitter.com/x", true).decision === "IGNORE");
    check("a same-site content link with no topical words is MAYBE", j("next page", "https://site.test/other", true).decision === "MAYBE");
    const f = new Frontier({ maxDepth: 1, maxPerDomain: 2, maxTotal: 10 });
    check("frontier accepts a URL", f.push("https://a.test/x?utm_source=1", 1, 1) === null);
    check("tracking variants are the same URL", f.push("https://a.test/x", 1, 1) === "already queued");
    check("depth cap", f.push("https://a.test/deep", 2, 1) === "too deep");
    f.push("https://a.test/y", 1, 1);
    check("per-domain cap", f.push("https://a.test/z", 1, 1) === "domain cap");
    const n = f.pop(); f.markVisited(n.url);
    check("visited is refused", f.push(n.url, 0, 1) === "visited");
  }

  // -------------------------------------------------------------- dedupe --
  section("web: duplicates are found by canonical URL and by content");
  const article = "In our benchmarks the Widget Engine handles 12,000 widgets per second on a modern laptop. The scheduler was rewritten in version 3.0 to batch updates.";
  check("a mirror is a near-duplicate", D.nearDuplicate(article, article + " Mirrored.").duplicate);
  check("different articles are not", !D.nearDuplicate(article, "Rate limits allow sixty requests per minute for every token on the hosted API.").duplicate);
  check("simhash of identical text is identical", D.hamming(D.simhash(article), D.simhash(article)) === 0);
  const groups = D.groupDuplicates([article, "unrelated text about cooking pasta and sauce for dinner tonight", article + " (copy)"], (x) => x, 0.7);
  check("grouping puts the copy with its original", groups[0] === groups[2] && groups[0] !== groups[1], JSON.stringify(groups));
  const ledger = new D.ParagraphLedger();
  check("a paragraph first seen on one page is new", ledger.check("https://a/", article) === null);
  check("the same paragraph on another page names the first", ledger.check("https://b/", article) === "https://a/");

  // ------------------------------------------------------------ evidence --
  section("web: evidence keeps exact spans and parses quantities");
  {
    const q = E.quantities("The API allows 100 requests per minute and 1,500 per day since version 2.0 in 2026.");
    check("quantities with units", q.some((x) => x.value === 100 && x.unit === "requests per minute") && q.some((x) => x.value === 1500));
    check("a version number is not a quantity", !q.some((x) => x.value === 2));
    const plan = P.decompose("How long do Widget tokens expire?");
    const sub = plan.subquestions[0];
    const ranked = rankChunks(chunks, sub.text);
    const ev = E.extractEvidence(ranked.filter((r) => isRelevant(r)), sub);
    check("evidence found for the token question", ev.length > 0 && /30 days/.test(ev[0].claim.text), JSON.stringify(ev.map((e) => e.claim.text)));
    const e0 = ev[0];
    const chunk = chunks.find((c) => c.id === e0.chunkId);
    check("the span offsets point at the sentence exactly", chunk.text.slice(e0.provenance.span.start, e0.provenance.span.end) === e0.claim.text);
    check("provenance carries URL, section and time", e0.provenance.url && e0.provenance.section.length && e0.provenance.retrieved_at);
    check("a heading is never glued to its first sentence", !ev.some((e) => /^Auth Tokens/.test(e.claim.text)));
  }

  // ----------------------------------------------------------- conflicts --
  section("web: disagreeing sources are reported, not resolved");
  const mkEv = (text, url) => ({ id: util.hashText(text + url), claim: E.toClaim(text, "sq1"), chunkId: "c", signals: { lexical: 1, headingMatch: 0, titleMatch: 0, coverage: 1, sourceType: "unknown", position: 0 }, provenance: { url, title: "", section: [], span: { start: 0, end: text.length, text }, retrieved_at: "t", source_type: "unknown" } });
  {
    const c = detectConflicts([mkEv("The hosted API allows 100 requests per minute per token.", "https://a.test/docs"), mkEv("From June the hosted API allows 60 requests per minute per token.", "https://b.test/blog")]);
    check("different numbers for the same thing conflict", c.length === 1 && c[0].kind === "numeric" && /100 requests per minute vs 60/.test(c[0].context), JSON.stringify(c.map((x) => x.context)));
    const p = detectConflicts([mkEv("The engine supports OAuth for all users.", "https://a.test/"), mkEv("The engine does not support OAuth for all users.", "https://b.test/")]);
    check("assert vs deny conflicts", p.length === 1 && p[0].kind === "polarity");
    const same = detectConflicts([mkEv("The API allows 100 requests per minute.", "https://a.test/x"), mkEv("The API allows 60 requests per minute.", "https://a.test/x#frag")]);
    check("one page never conflicts with itself", same.length === 0);
    const mirror = detectConflicts([mkEv("The API allows 100 requests per minute.", "https://a.test/x"), mkEv("The API allows 60 requests per minute.", "https://m.test/x")], { sameSource: () => true });
    check("a mirror is the same source", mirror.length === 0);
    const units = detectConflicts([mkEv("The engine handles 100 widgets per second.", "https://a.test/"), mkEv("The engine handles 60 requests per minute.", "https://b.test/")]);
    check("different units are not a conflict", units.length === 0);
    const unrelated = detectConflicts([mkEv("The library was first released in 2019 by the team.", "https://a.test/"), mkEv("Rate limits changed in 2026 for hosted plans.", "https://b.test/")]);
    check("unrelated sentences with numbers are not a conflict", unrelated.length === 0);
  }

  // --------------------------------------------------------------- graph --
  section("web: the source graph traces claims back to sources");
  {
    const g = new SourceGraph("q");
    const sub = { id: "sq1", text: "t", strategies: ["broad"], focus: ["t"] };
    g.addSubquestion(sub);
    const q1 = g.addQuery({ text: "t", strategy: "broad", subquestionId: "sq1" }, "b1");
    const q2 = g.addQuery({ text: "t docs", strategy: "documentation", subquestionId: "sq1" }, "b1");
    const res = { title: "T", url: "https://a.test/x", canonical_url: U.canonicalizeUrl("https://a.test/x"), domain: "a.test", snippet: "", source_type: "unknown", discovered_at: "t", search_query: "t", relevance: { query: 1, rank: 1, backend: "b1" }, metadata: {} };
    const r1 = g.addResult(q1, res); g.addResult(q2, res);
    g.addSource({ canonical_url: U.canonicalizeUrl("https://a.test/x"), title: "T", url: "https://a.test/x", final_url: "https://a.test/x", source_type: "unknown", fetched_at: "t" }, r1);
    const ev = mkEv("The API allows 100 requests per minute.", "https://a.test/x");
    g.addEvidence(ev);
    const tr = g.trace(ev.claim.id);
    check("claim → evidence → source", tr.evidence.length === 1 && tr.sources.length === 1 && tr.sources[0].label === "T");
    check("found by two queries", g.discoveryCount("https://a.test/x") === 2);
    check("mermaid output", /^graph LR/.test(g.toMermaid()));
    check("stats count kinds", g.stats().source === 1 && g.stats().query === 2);
  }

  // ------------------------------------------------------------- context --
  section("web: the context holds evidence, conflicts and gaps - never pages");
  {
    const plan = { question: "Q?", method: "heuristic", subquestions: [{ id: "sq1", text: "rate limits", strategies: ["broad"], focus: ["rate", "limits"] }, { id: "sq2", text: "pricing", strategies: ["broad"], focus: ["pricing"] }] };
    const e1 = mkEv("The hosted API allows 100 requests per minute per token.", "https://a.test/docs");
    const e2 = mkEv("From June the hosted API allows 60 requests per minute per token.", "https://b.test/blog");
    const conflicts = detectConflicts([e1, e2]);
    const ctx = buildContext(plan, [e1, e2], conflicts, {});
    check("sources numbered once each", ctx.citations.length === 2 && ctx.citations[0].n === 1);
    check("evidence lines cite their source", /100 requests per minute per token\. \[1\]/.test(ctx.text));
    check("conflicts get their own section", /Conflicts between sources/.test(ctx.text) && /\[1\] vs .*\[2\]/.test(ctx.text));
    check("an unanswered subquestion is listed as a gap", ctx.gaps.includes("pricing") && /Gaps/.test(ctx.text));
    const small = buildContext(plan, [e1, e2], [], { maxChars: 200 });
    check("the context is trimmed to budget", small.chars <= 260 && small.omitted > 0, small.chars);
    const chk = checkCitations("Limits are 100 [1] or 60 [2], see also [7].", ctx.citations);
    check("citation check finds invalid numbers", chk.invalid.join() === "7" && chk.used.join() === "1,2,7");
  }

  // ------------------------------------------------------------- planner --
  section("web: the planner decomposes from the question's own structure");
  {
    const c = P.detectComparison("Compare React, Vue and Svelte for production AI applications");
    check("comparison entities", c && c.entities.join("|") === "React|Vue|Svelte", JSON.stringify(c));
    check("comparison purpose", c && c.purpose === "production AI applications");
    check("'X vs Y' form", P.detectComparison("Postgres vs MySQL for analytics").entities.join("|") === "Postgres|MySQL");
    check("'difference between' form", P.detectComparison("What is the difference between TCP and UDP?").entities.join("|") === "TCP|UDP");
    check("not a comparison", P.detectComparison("How do I install Rust?") === null);
    const cp = P.decompose("Compare X, Y and Z for production AI applications, focusing on performance and security");
    const texts = cp.subquestions.map((s) => s.text);
    check("aspects come from the question itself", texts.includes("X performance") && texts.includes("Z security") && !texts.some((t) => /limitations/.test(t)), JSON.stringify(texts));
    check("each entity gets official documentation", ["X", "Y", "Z"].every((e) => texts.includes(e + " official documentation")));
    check("the purpose becomes a cross-cutting subquestion", texts.some((t) => /X vs Y vs Z production AI applications/.test(t)));
    const cmpNoAspect = P.decompose("Compare Alpha and Beta");
    check("with no aspect named, a small generic set is used", cmpNoAspect.subquestions.some((s) => s.text === "Alpha limitations"));
    const multi = P.decompose("What is Widget Engine? How fast is it; and also what license does it use");
    check("multi-part questions split", multi.subquestions.length >= 3, JSON.stringify(multi.subquestions.map((s) => s.text)));
    check("strategies from words: docs", P.strategiesFor("How to configure the Widget API").includes("documentation"));
    check("strategies: github", P.strategiesFor("best open source library for parsing").includes("github"));
    check("strategies: news and recency", P.strategiesFor("latest announcements in 2026").includes("recency"));
    check("strategies: exact for quoted phrases", P.strategiesFor('what does "exit code 137" mean')[0] === "exact");
    check("strategies: technical for errors", P.strategiesFor("segfault in the renderer").includes("technical"));
    check("broad always last", P.strategiesFor("anything").slice(-1)[0] === "broad");
    const sq = { id: "sq1", text: "widget rate limits", strategies: [], focus: ["widget", "rate", "limits"] };
    check("documentation query", P.queryFor(sq, "documentation").text === "widget rate limits documentation");
    check("exact query quotes the focus", P.queryFor(sq, "exact").text === '"widget rate limits"');
    check("recency query adds the year", P.queryFor(sq, "recency", new Date("2026-09-26")).text === "widget rate limits 2026");
    const ann = P.decompose("What are the Widget Engine rate limits and performance?");
    const rl = ann.subquestions.find((s) => /rate limits$/.test(s.text));
    check("distinctive focus drops the shared subject", rl && rl.distinctive.includes("rate") && !rl.distinctive.includes("widget"), JSON.stringify(rl && rl.distinctive));
    const model = await P.decomposeWithModel("Compare A and B", async () => '{"subquestions": ["A startup time", "B startup time", "A limitations"]}');
    check("model subquestions are merged with the heuristic ones, near-duplicates dropped", model.method === "model+heuristic" && model.subquestions.filter((s) => s.text === "A limitations").length === 1 && model.subquestions.some((s) => s.text === "A startup time"));
    const junk = await P.decomposeWithModel("Compare A and B", async () => "I cannot help with that.");
    check("a model returning prose leaves the heuristic plan", junk.method === "heuristic");
    const threw = await P.decomposeWithModel("Compare A and B", async () => { throw new Error("offline"); });
    check("a model that fails leaves the heuristic plan", threw.method === "heuristic");
  }

  // --------------------------------------------------------------- cache --
  section("web: caches expire, evict, persist, and refuse authenticated content");
  {
    const c = new TtlCache("search", 1000, 2);
    c.set("a", 1, {}, 0);
    check("hit before expiry", c.get("a", 500) === 1);
    check("miss after expiry", c.get("a", 1500) === undefined);
    c.set("x", 1, {}, 0); c.set("y", 2, {}, 0); c.get("x", 1); c.set("z", 3, {}, 2);
    check("LRU evicts the least recently used", c.get("y", 3) === undefined && c.get("x", 3) === 1);
    let refused = false;
    try { c.set("secret", "page", { authenticated: true }); } catch { refused = true; }
    check("authenticated content is refused", refused);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "closeni-cache-"));
    new TtlCache("page", 60000, 10, dir).set("k", { v: 1 });
    check("disk persistence across instances", new TtlCache("page", 60000, 10, dir).get("k").v === 1);
    check("research caches have every namespace", Object.keys(new ResearchCaches().stats()).join() === "search,page,parsed,chunks,evidence,meta");
  }

  // -------------------------------------------------------------- search --
  section("web: search results are normalised and aggregated");
  {
    check("a wrapped result URL is unwrapped", S.resolveResultUrl("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x") === "https://example.com/a");
    check("an ordinary URL is left alone", S.resolveResultUrl("https://example.com/b?q=1") === "https://example.com/b?q=1");
    const q = (text, sub) => ({ text, strategy: "broad", subquestionId: sub });
    const r = (url, title, rank, backend, text, sub) => ({ title, url, canonical_url: U.canonicalizeUrl(url), domain: U.domainOf(url), snippet: title, source_type: "unknown", discovered_at: "t", search_query: text, relevance: { query: 0.5, rank, backend }, metadata: { subquestion: sub } });
    const agg = S.aggregate([
      { backend: "b1", query: q("one", "sq1"), status: "ok", durationMs: 1, results: [r("https://a.test/x?utm_source=1", "X page", 2, "b1", "one", "sq1"), r("https://b.test/y", "Y page", 1, "b1", "one", "sq1")] },
      { backend: "b2", query: q("two", "sq2"), status: "ok", durationMs: 1, results: [r("https://a.test/x", "X page", 1, "b2", "two", "sq2")] },
    ]);
    check("tracking variants merged", agg.results.length === 2 && agg.duplicatesRemoved === 1);
    check("found by more queries ranks first", agg.results[0].domain === "a.test" && agg.results[0].metadata.foundBy === 2);
    check("a merged result serves both subquestions", agg.results[0].metadata.subquestions.join() === "sq1,sq2");
    const gh = new S.GitHubSearchBackend(undefined, undefined, async () => ({ status: 200, body: JSON.stringify({ items: [{ full_name: "o/widget", html_url: "https://github.com/o/widget", description: "A widget engine", stargazers_count: 5, pushed_at: "2026-01-01T00:00:00Z" }] }) }));
    const out = await gh.search({ text: "widget", strategy: "github", subquestionId: "sq1" }, 5);
    check("GitHub results normalised", out.status === "ok" && out.results[0].source_type === "code-repository" && out.results[0].published_at === "2026-01-01T00:00:00Z");
    const limited = await new S.GitHubSearchBackend(undefined, undefined, async () => ({ status: 403, body: "{}" })).search({ text: "w", strategy: "github", subquestionId: "s" }, 5);
    check("a GitHub rate limit is 'blocked' and says why", limited.status === "blocked" && /rate limit/.test(limited.detail));
  }

  // -------------------------------------------------------------- memory --
  section("web: memory avoids rediscovery");
  {
    const m = new BrowserMemory();
    m.fail("https://a.test/x?utm_source=1", "net::ERR_TUNNEL_CONNECTION_FAILED", "blocked");
    check("a blocked URL is skipped, tracking variants included", m.shouldSkip("https://a.test/x"));
    m.fail("https://b.test/", "timeout", "timeout");
    check("one timeout is retried", !m.shouldSkip("https://b.test/"));
    m.fail("https://b.test/", "timeout", "timeout");
    check("two are not", m.shouldSkip("https://b.test/"));
    const rm = new ResearchMemory();
    const e = mkEv("A fact about widgets that is long enough.", "https://a.test/");
    check("new evidence counts as fresh", rm.addEvidence([e]) === 1);
    check("the same evidence again does not", rm.addEvidence([e]) === 0);
    const other = { ...e, claim: { ...e.claim, subquestionId: "sq2" } };
    check("the same sentence for another subquestion is new evidence", rm.addEvidence([other]) === 1);
  }
  check("an app shell is recognised", looksLikeAppShell({ main_text: "" }, '<div id="root"></div><noscript>enable js</noscript>'));
  check("a real page is not an app shell", !looksLikeAppShell({ main_text: "x".repeat(500) }, "<p>...</p>"));
  check("sentences do not split on e.g. or version numbers", util.sentences("Use e.g. version 3.5 here. Then stop.").length === 2);
  check("stems meet plural and singular", util.stem("limits") === util.stem("limit") && util.stem("handles") === util.stem("handle"));
}

module.exports = { run };

if (require.main === module) {
  let pass = 0, fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log("  ok   " + name); }
    else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + String(extra).slice(0, 300) : "")); }
  };
  const section = (name) => console.log("\n" + name);
  run(check, section).then(() => {
    console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + " — " + pass + " passed, " + fail + " failed");
    process.exit(fail === 0 ? 0 : 1);
  }).catch((e) => { console.error("web unit tests threw:", e); process.exit(1); });
}
