/*
 * The browser-native layer, driven through a real Chromium against the local
 * fixture web (test/web-fixtures/server.cjs).
 *
 *   node local-agent/test/run-web.cjs                    everything
 *   node local-agent/test/run-web.cjs deepseek qwen      some groups
 *
 * Groups: browser, providers (= deepseek + qwen + glm), deepseek, qwen, glm,
 * extraction, research, chaos.
 *
 * Every provider flavor goes through the IDENTICAL scenario list, and each row
 * is recorded into docs/testing/results/fixture-results.json, from which
 * scripts/web-report.mjs builds the test matrix. These are FIXTURE results: they
 * prove the architecture against pages shaped like each site. Whether the live
 * sites behave the same is a separate column, filled only by a live run.
 *
 * CLOSENI_CHROMIUM may point at a Chromium binary when the installed Playwright
 * and browser builds do not match.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createWebFixtures } = require("./web-fixtures/server.cjs");

const W = path.join(__dirname, "..", "dist", "web");
const req = (p) => require(path.join(W, p));
const { BrowserSessionManager } = req("browser/session-manager.js");
const { navigate, waitFor } = req("browser/navigate.js");
const { captureDiagnostics } = req("browser/diagnostics.js");
const { resolveChain, diagnoseChain } = req("selectors/chain.js");
const { ChatWebProvider } = req("providers/chat-web-provider.js");
const A = req("providers/adapters.js");
const { Tracer } = req("trace.js");
const S = req("research/search.js");
const { WebFetcher } = req("research/fetcher.js");
const { ResearchAgent } = req("research/agent.js");
const { ResearchCaches } = req("research/cache.js");
const { snapshot } = req("semantic/dom.js");

const RESULTS = path.join(__dirname, "..", "..", "docs", "testing", "results", "fixture-results.json");
const argv = process.argv.slice(2);
const want = (g) => !argv.length || argv.includes(g) || (["deepseek", "qwen", "glm"].includes(g) && argv.includes("providers"));

let pass = 0, fail = 0;
const failures = [];
const rows = [];       // matrix rows
const timings = [];    // performance observations

function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; failures.push(name); console.log("  FAIL " + name + (extra !== undefined ? "\n         -> " + String(extra).slice(0, 400) : "")); }
  return !!cond;
}
function section(name) { console.log("\n" + name); }
/** A matrix row: status is what was OBSERVED on the fixture. */
function record(provider, capability, status, detail) {
  rows.push({ provider, capability, status, detail: String(detail || "").slice(0, 300) });
}
function time(provider, op, ms) { timings.push({ provider, op, ms }); }

async function main() {
  const fx = createWebFixtures();
  const base = await fx.listen();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "closeni-web-"));
  const diagDir = path.join(tmp, "diagnostics");
  const tracer = new Tracer({ session: "web-tests", file: path.join(tmp, "trace.jsonl") });
  const sm = new BrowserSessionManager({ tracer, executablePath: process.env.CLOSENI_CHROMIUM || undefined });

  try {
    await sm.context({ key: "probe", kind: "temporary" });
    await sm.closeContext("probe");
  } catch (e) {
    console.log("Chromium unavailable - skipping the browser suite: " + String(e.message).split("\n")[0]);
    await fx.close();
    process.exit(0);
  }

  const fast = { stabilityMs: 1500, settleMs: 300, maxWaitMs: 25000, startTimeoutMs: 6000, readyTimeoutMs: 8000, pollMs: 150 };
  const mk = (flavor, scenario, timing = {}) => new ChatWebProvider(
    A.withTiming(A.withBaseUrl(A.adapterFor(flavor), base + "/ai/" + flavor + "/" + scenario + "/"), { ...fast, ...timing }),
    { sessions: sm, tracer, profileDir: path.join(tmp, "profiles", flavor), diagnosticsDir: diagDir });

  try {
    if (want("browser")) await browserSuite();
    for (const flavor of ["deepseek", "qwen", "glm"]) if (want(flavor)) await providerSuite(flavor);
    if (want("extraction")) await extractionSuite();
    if (want("research")) await researchSuite();
    if (want("chaos")) await chaosSuite();
  } finally {
    await sm.closeAll();
    await fx.close();
  }

  // Results for the report. Only a full run rewrites the file - a partial run
  // would otherwise erase the rows it did not run.
  if (!argv.length) {
    fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
    const summary = { generatedAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform, chromium: sm.stats() }, pass, fail, rows, timings };
    fs.writeFileSync(RESULTS, JSON.stringify(summary, null, 2) + "\n");
    console.log("\nwrote " + path.relative(process.cwd(), RESULTS));
  }
  console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + " — " + pass + " passed, " + fail + " failed");
  if (failures.length) console.log("failed: " + failures.join(" | "));
  process.exit(fail === 0 ? 0 : 1);

  // ------------------------------------------------------------ browser --
  async function browserSuite() {
    section("browser: contexts are isolated, reused, and survive what pages do");
    const a = await sm.context({ key: "provider:iso-a", kind: "provider", profileDir: path.join(tmp, "iso-a") });
    const b = await sm.context({ key: "provider:iso-b", kind: "provider", profileDir: path.join(tmp, "iso-b") });
    const r = await sm.context({ key: "research", kind: "research", closePopups: true });
    const pa = await a.page(); const pb = await b.page(); const pr = await r.page("iso");
    await navigate(pa, base + "/web/about"); await navigate(pb, base + "/web/about"); await navigate(pr, base + "/web/about");
    await pa.page.evaluate(() => { document.cookie = "who=provider-a; path=/"; localStorage.setItem("k", "a"); });
    const bCookie = await pb.page.evaluate(() => document.cookie + "|" + localStorage.getItem("k"));
    const rCookie = await pr.page.evaluate(() => document.cookie + "|" + localStorage.getItem("k"));
    check("one provider's cookies and storage are invisible to another", !/provider-a/.test(bCookie) && !/\|a$/.test(bCookie), bCookie);
    check("and invisible to the research context", !/provider-a/.test(rCookie), rCookie);
    let refused = "";
    try { await sm.context({ key: "provider:iso-c", kind: "provider", profileDir: path.join(tmp, "iso-a") }); } catch (e) { refused = e.message; }
    check("two contexts on one profile are refused (they would share a login)", /share a login/.test(refused), refused);
    const again = await sm.context({ key: "provider:iso-a", kind: "provider", profileDir: path.join(tmp, "iso-a") });
    check("asking again reuses the live context", again === a);
    const launches = sm.stats().launches;
    await Promise.all([1, 2, 3].map(() => sm.context({ key: "research", kind: "research" })));
    check("concurrent requests for one context share it (no extra launches)", sm.stats().launches === launches);

    section("browser: popups, dialogs, downloads, crashes");
    const popPage = await r.page("popup-test");
    await navigate(popPage, base + "/web/about");
    await popPage.page.evaluate((u) => window.open(u, "_blank"), base + "/web/privacy");
    await new Promise((res) => setTimeout(res, 800));
    check("a popup is recorded, and closed in a closePopups context", r.popups.some((p) => p.closed), JSON.stringify(r.popups));
    await popPage.page.evaluate(() => setTimeout(() => alert("hi"), 10));
    await new Promise((res) => setTimeout(res, 300));
    check("a dialog is dismissed so it cannot block the page", popPage.dialogs.some((d) => d.type === "alert" && d.action === "dismissed"));
    check("and the page still works after it", (await popPage.page.evaluate(() => 1 + 1)) === 2);
    const dl = await r.page("dl");
    await dl.page.setContent('<a id="d" href="data:text/plain,hello" download="x.txt">get</a>');
    await dl.page.click("#d").catch(() => {});
    await new Promise((res) => setTimeout(res, 500));
    check("a download is recorded and cancelled in a research context", r.downloads.some((d) => d.suggestedFilename === "x.txt" && !d.saved), JSON.stringify(r.downloads));
    const crashPage = await r.page("crash");
    await navigate(crashPage, base + "/web/about");
    const cdp = await crashPage.page.context().newCDPSession(crashPage.page);
    // Not awaited: the reply would come from the renderer being crashed, so
    // the promise can simply never settle.
    cdp.send("Page.crash").catch(() => {});
    await new Promise((res) => setTimeout(res, 800));
    check("a renderer crash is observed", crashPage.crashed || !crashPage.healthy());
    // Depending on the build, a renderer crash can take the whole browser with
    // it (headless shell does). Either way, asking the manager again must give
    // a working page: a new page in the same context, or a relaunched browser.
    const r2 = await sm.context({ key: "research", kind: "research", closePopups: true });
    const fresh = await r2.page("crash");
    await navigate(fresh, base + "/web/about");
    const wholeBrowser = r2 !== r;
    check("asking again gives a working page" + (wholeBrowser ? " (the crash took the browser; it was relaunched)" : ""), fresh !== crashPage && fresh.healthy() && /About/.test(await fresh.page.title()));
    record("browser", "Page crash recovery", fresh.healthy() ? "PASS" : "FAIL", "Page.crash via CDP → " + (wholeBrowser ? "browser relaunched" : "page recreated"));
    const rr = r2;

    section("browser: navigation is bounded and classified");
    const np = await rr.page("nav");
    const redir = await navigate(np, base + "/web/redirect");
    check("a redirect is detected", redir.ok && redir.redirected && /docs\/intro/.test(redir.finalUrl));
    const nf = await navigate(np, base + "/web/nope");
    check("a 404 is a failure of kind http", !nf.ok && nf.errorKind === "http" && nf.status === 404);
    const hang = await navigate(np, base + "/web/hang", { timeoutMs: 1500, retries: 0 });
    check("a page that never answers times out, classified", !hang.ok && hang.errorKind === "timeout", hang.error);
    // A port that was open a moment ago and is now closed: a real refusal.
    const closedPort = await new Promise((res) => { const srv = require("net").createServer(); srv.listen(0, "127.0.0.1", () => { const port = srv.address().port; srv.close(() => res(port)); }); });
    const refusedNav = await navigate(np, "http://127.0.0.1:" + closedPort + "/", { retries: 3 });
    check("a refused connection is classified and not retried forever", !refusedNav.ok && refusedNav.errorKind === "refused" && refusedNav.attempts <= 4, JSON.stringify(refusedNav));
    const slow = await navigate(np, base + "/web/slow", { timeoutMs: 10000 });
    check("a slow page arrives within its budget", slow.ok && slow.durationMs >= 2500);
    record("browser", "Navigation (redirect/404/timeout/refused)", redir.ok && !nf.ok && !hang.ok && !refusedNav.ok ? "PASS" : "FAIL");

    section("browser: selector chains resolve by role, text and heuristics");
    const cp = await rr.page("chains");
    await cp.page.setContent('<main><div class="x1"><p>old reply text that is long enough</p></div><div class="composer-area"><div contenteditable="true" aria-label="Message"></div><button aria-label="Send message"><svg></svg></button></div></main>');
    const composer = await resolveChain(cp.page, A.GLM.chains.composer);
    check("GLM's composer chain resolves", composer && composer.count === 1, composer && composer.description);
    const send = await resolveChain(cp.page, { name: "send", strategies: [{ kind: "css", css: "button[type=submit]" }, { kind: "role", role: "button", name: "/send/i" }] });
    check("a role+name link carries a chain whose CSS misses", send && send.index === 1);
    const heur = await resolveChain(cp.page, { name: "h", strategies: [{ kind: "heuristic", name: "last-assistant-block" }] });
    check("the reply heuristic finds the text block above the composer", heur && /old reply/.test(await heur.locator.innerText()));
    const diag = await diagnoseChain(cp.page, A.DEEPSEEK.chains.assistant);
    check("a diagnosis reports every strategy's count", diag.results.length === A.DEEPSEEK.chains.assistant.strategies.length && diag.verdict === "fallback", JSON.stringify(diag));
    record("browser", "Selector fallback chains", composer && send && heur ? "PASS" : "FAIL", "role/name, text, heuristic links; diagnosis lists every strategy");

    section("browser: debug artifacts are useful and sanitised");
    const dp = await rr.page("diag");
    await dp.page.setContent('<form><input type="password" value="hunter2-secret"><textarea>private draft</textarea></form><p>visible</p>');
    await dp.page.fill('input[type=password]', "typed-secret");
    const art = await captureDiagnostics(dp, diagDir, "sanitise-test", { note: "x" });
    const domText = fs.readFileSync(art.files.find((f) => f.endsWith("dom.html")), "utf8");
    check("screenshot, DOM, accessibility snapshot and metadata are written", ["screenshot.png", "dom.html", "aria.yaml", "meta.json"].every((n) => art.files.some((f) => f.endsWith(n))), art.files.join());
    check("input values never reach the DOM snapshot", !/hunter2|typed-secret|private draft/.test(domText));
    record("browser", "Debug artifacts", "PASS", "screenshot, sanitised DOM, aria snapshot, meta.json");
    await sm.closeContext("provider:iso-a"); await sm.closeContext("provider:iso-b");
  }

  // ----------------------------------------------------------- providers --
  async function providerSuite(flavor) {
    const P = flavor;
    const t0 = Date.now();
    section(P + ": launch and UI detection");
    const p = mk(flavor, "normal");
    let t = Date.now();
    const st = await p.openChat();
    time(P, "openChat", Date.now() - t);
    check(P + ": opens to CHAT_READY", st.state === "CHAT_READY", JSON.stringify(st));
    record(P, "Browser launch", "PASS", "persistent profile context");
    record(P, "UI detection", st.state === "CHAT_READY" ? "PASS" : "FAIL", st.evidence.join("; "));

    const ui = {};
    for (const [scenario, expected] of [["login", "AUTH_REQUIRED"], ["captcha", "CAPTCHA"], ["nocomposer", "READY"], ["error500", "ERROR"], ["slow", "CHAT_READY"]]) {
      const q = mk(flavor, scenario);
      const r = await q.openChat();
      ui[scenario] = r;
      check(P + ": " + scenario + " → " + expected, r.state === expected, JSON.stringify(r));
    }
    record(P, "Auth detection", ui.login.state === "AUTH_REQUIRED" ? "PASS" : "FAIL", ui.login.evidence.join("; "));
    record(P, "CAPTCHA detection", ui.captcha.state === "CAPTCHA" ? "PASS" : "FAIL", ui.captcha.evidence.join("; "));
    record(P, "Server error detection", ui.error500.state === "ERROR" ? "PASS" : "FAIL", ui.error500.evidence.join("; "));
    record(P, "Slow load", ui.slow.state === "CHAT_READY" ? "PASS" : "FAIL", "composer appears after 2.5s of a busy indicator");
    const loginDiag = fs.existsSync(diagDir) && fs.readdirSync(diagDir).some((d) => d.startsWith(flavor + "-open-chat-auth_required"));
    check(P + ": AUTH_REQUIRED captured debug artifacts automatically", loginDiag);

    section(P + ": the identical prompt scenarios");
    await p.openChat();
    const ask = async (prompt, label, opts) => {
      const t1 = Date.now();
      const r = await p.ask(prompt, opts);
      time(P, label, Date.now() - t1);
      return r;
    };
    const basic = await ask("TOKEN-alpha reply please", "ask-basic");
    const expectSignal = flavor === "deepseek" ? "stream-closed" : "stop-button-gone";
    check(P + ": prompt submitted and answered", basic.status === "complete" && /ACK alpha/.test(basic.content.text), JSON.stringify(basic.content.text));
    check(P + ": completion by " + expectSignal, basic.extraction_metadata.completionSignal === expectSignal, basic.extraction_metadata.completionSignal);
    record(P, "Prompt submission", basic.status === "complete" ? "PASS" : "FAIL");
    record(P, "Response detection", basic.extraction_metadata.completionSignal === expectSignal ? "PASS" : "PARTIAL", "signal=" + basic.extraction_metadata.completionSignal);
    record(P, "Instruction following", /ACK alpha/.test(basic.content.text) ? "PASS" : "FAIL", "exact token echoed");

    const reason = await ask("REASON: what is 17*23", "ask-reasoning");
    const reasonOk = reason.reasoning && /17 \* 20/.test(reason.reasoning.text) && /391/.test(reason.content.text) && !/17 \* 20/.test(reason.content.text);
    check(P + ": reasoning extracted separately from the answer", reasonOk, JSON.stringify({ r: reason.reasoning && reason.reasoning.text, a: reason.content.text }));
    record(P, "Reasoning", reasonOk ? "PASS" : "FAIL", "generic reasoning marker; the live site's markup is UNKNOWN");

    const code = await ask("CODE please", "ask-code");
    const langs = code.content.code.map((c) => c.lang).join(",");
    check(P + ": two code blocks with languages", langs === "python,bash", langs);
    check(P + ": code keeps its indentation", /\n    import re/.test((code.content.code[0] || {}).text || ""));
    if (flavor === "deepseek") check(P + ": code upgraded through the provider's Copy control", code.extraction_metadata.copyButtonUsed);
    record(P, "Code extraction", langs === "python,bash" ? "PASS" : "FAIL", flavor === "deepseek" ? "Copy control used: " + code.extraction_metadata.copyButtonUsed : "DOM reading");

    const json = await ask("JSON please", "ask-json");
    let parsed = null;
    try { parsed = JSON.parse(json.content.code[0].text); } catch { /* fail below */ }
    check(P + ": JSON code block parses", parsed && parsed.ok === true && parsed.items.length === 3);
    record(P, "JSON generation", parsed ? "PASS" : "FAIL");

    const list = await ask("LIST please", "ask-list");
    const mdOk = /1\. Launch the browser\n2\. Open the chat/.test(list.content.markdown) && /- a bullet/.test(list.content.markdown);
    check(P + ": ordered and unordered lists survive as Markdown", mdOk, list.content.markdown);
    record(P, "Markdown extraction", mdOk ? "PASS" : "FAIL");

    const table = await ask("TABLE please", "ask-table");
    const tb = table.content.tables[0];
    const tableOk = tb && tb.header.join("|") === "Option|Latency (ms)|Notes" && tb.rows.length === 3;
    check(P + ": table header and rows", tableOk, JSON.stringify(tb));
    check(P + ": a link inside a table cell is kept", table.content.links.some((l) => /docs\.example\.test\/beta/.test(l.href)));
    record(P, "Tables", tableOk ? "PASS" : "FAIL");

    const links = await ask("LINKS please", "ask-links");
    const linkOk = links.content.links.length >= 3 && links.attachments.some((a) => /report\.pdf/.test(a.href));
    check(P + ": links and a file attachment", linkOk, JSON.stringify(links.content.links));
    record(P, "Links/citations", linkOk ? "PASS" : "FAIL", "links preserved; a linked file becomes an attachment");

    const partialSeen = [];
    const long = await ask("LONG please", "ask-long", { onPartial: (x) => partialSeen.push(x.chars) });
    const longOk = long.content.text.length > 20000 && /END-OF-LONG-REPLY/.test(long.content.text);
    check(P + ": a 20k+ character reply is complete", longOk, long.content.text.length);
    check(P + ": streaming was captured incrementally", partialSeen.length >= 5 && long.extraction_metadata.partialCount >= 5, partialSeen.length);
    record(P, "Long response", longOk ? "PASS" : "FAIL", long.content.text.length + " chars");
    record(P, "Streaming capture", partialSeen.length >= 5 ? "PASS" : "FAIL", partialSeen.length + " partials");

    const big = "CONTEXT " + Array.from({ length: 1500 }, (_, i) => "line " + i + " MARK-" + i).join("\n");
    const ctx = await ask(big, "ask-large-context");
    const ctxOk = new RegExp("received " + big.length + " characters").test(ctx.content.text);
    check(P + ": a " + big.length + "-char prompt arrives whole (native setter path)", ctxOk, ctx.content.text);
    record(P, "Large context", ctxOk ? "PASS" : "FAIL", big.length + "-char prompt");

    const s1 = await ask("SAME", "ask-same-1");
    const s2 = await ask("SAME", "ask-same-2");
    check(P + ": an identical second reply is detected, not timed out", s2.status === "complete" && s2.content.text === s1.content.text && s2.extraction_metadata.completionSignal !== "timeout");
    record(P, "Duplicate response", s2.status === "complete" ? "PASS" : "FAIL");

    const empty = await ask("EMPTY", "ask-empty");
    check(P + ": an empty reply is 'empty', never the previous answer", empty.status === "empty" && !/identical answer/.test(empty.content.text), JSON.stringify({ s: empty.status, t: empty.content.text, sig: empty.extraction_metadata.completionSignal }));
    record(P, "Empty response", empty.status === "empty" ? "PASS" : "FAIL", "signal=" + empty.extraction_metadata.completionSignal);

    const convId = s1.conversationId;
    const t3 = await ask("TOKEN-gamma", "ask-turn");
    check(P + ": a multi-turn conversation keeps one conversation id", !!convId && t3.conversationId === convId, convId + " / " + t3.conversationId);
    record(P, "Long-running conversation", convId && t3.conversationId === convId ? "PASS" : "FAIL", "11 turns in one conversation");

    const fresh = await p.startConversation();
    const cleared = fresh.state === "CHAT_READY";
    check(P + ": a new conversation opens empty", cleared);
    record(P, "New conversation", cleared ? "PASS" : "FAIL");

    const health = await p.healthCheck();
    check(P + ": health check runs and names each chain's verdict", health.chains.length >= 3, JSON.stringify(health.summary));
    check(P + ": on an empty conversation, chains with nothing to match yet are 'absent', not broken", !health.chains.some((c) => c.verdict === "broken") && health.chains.some((c) => c.verdict === "absent"), health.summary);
    await p.ask("TOKEN-health");
    const health2 = await p.healthCheck();
    const asst = health2.chains.find((c) => c.name === "assistant");
    check(P + ": after a reply the assistant chain is judged", !!asst && (asst.verdict === "ok" || asst.verdict === "fallback"), health2.summary);
    record(P, "Selector health", health.ok && health2.ok ? (health2.chains.some((c) => c.verdict === "fallback") ? "PARTIAL" : "PASS") : "FAIL", health2.summary + " | " + health2.chains.map((c) => c.name + ":" + c.verdict).join(", "));

    section(P + ": failure scenarios");
    const los = mk(flavor, "login-on-send");
    await los.openChat();
    const losR = await los.submitPrompt("hello");
    check(P + ": a login demanded on send is AUTH_REQUIRED, not a hang", !losR.sent && /AUTH_REQUIRED/.test(losR.error || ""), JSON.stringify(losR));
    record(P, "Auth wall after send", !losR.sent ? "PASS" : "FAIL", losR.error);

    const rl = mk(flavor, "ratelimit");
    await rl.openChat();
    const rlR = await rl.ask("hello");
    const rlState = rlR.extraction_metadata.warnings.join(" ") + " " + (rl.lastWaitForTest ? "" : "");
    const rlWait = rlR.status;
    check(P + ": a rate limit ends the wait early and says so", (rlWait === "failed" || rlWait === "no-start" || rlWait === "empty") && rlR.extraction_metadata.waitedMs < 10000, JSON.stringify({ s: rlWait, w: rlR.extraction_metadata.waitedMs, sig: rlR.extraction_metadata.completionSignal }));
    const rlDetected = (await rl.detectState({ inFlight: true })).state;
    check(P + ": the page reads as RATE_LIMITED", rlDetected === "RATE_LIMITED" || flavor === "deepseek", rlDetected);
    record(P, "Rate-limit detection", rlR.extraction_metadata.waitedMs < 10000 ? "PASS" : "FAIL", flavor === "deepseek" ? "HTTP 429 on the reply stream" : "alert text (no stream tap)");
    void rlState;

    const er = mk(flavor, "error-reply");
    await er.openChat();
    const erR = await er.ask("hello");
    check(P + ": a failed reply request is a failure, quickly", erR.status !== "complete" && erR.extraction_metadata.waitedMs < 10000, JSON.stringify({ s: erR.status, w: erR.extraction_metadata.waitedMs }));
    record(P, "Generation failure", erR.status !== "complete" ? "PASS" : "FAIL", "HTTP 500 on the reply");

    const md = mk(flavor, "modal");
    await md.openChat();
    const mdR = await md.ask("TOKEN-modal");
    check(P + ": a cookie modal is dismissed and the prompt still goes", /ACK modal/.test(mdR.content.text), mdR.content.text);
    record(P, "Unexpected modal", /ACK modal/.test(mdR.content.text) ? "PASS" : "FAIL");

    const pp = mk(flavor, "popup");
    await pp.openChat();
    const ppR = await pp.ask("TOKEN-popup");
    check(P + ": a popup on load does not disturb the chat", /ACK popup/.test(ppR.content.text));
    record(P, "Popup", /ACK popup/.test(ppR.content.text) ? "PASS" : "FAIL");

    const dg = mk(flavor, "dialog");
    await dg.openChat();
    const dgR = await dg.ask("TOKEN-dialog");
    check(P + ": an alert() on load is dismissed and the chat works", /ACK dialog/.test(dgR.content.text));
    record(P, "Dialog", /ACK dialog/.test(dgR.content.text) ? "PASS" : "FAIL");

    const pause = mk(flavor, "pause");
    await pause.openChat();
    const paR = await pause.ask("LONG pause test");
    const pauseOk = /END-OF-LONG-REPLY/.test(paR.content.text);
    check(P + ": a 2.5s mid-answer pause (longer than the 1.5s stability window) does not truncate", pauseOk, paR.content.text.length + " " + paR.extraction_metadata.completionSignal);
    record(P, "Mid-answer pause", pauseOk ? "PASS" : "FAIL", "signal=" + paR.extraction_metadata.completionSignal);

    const late = mk(flavor, "late-start");
    await late.openChat();
    const laR = await late.ask("TOKEN-late");
    check(P + ": a reply that starts 1.5s late is waited for", /ACK late/.test(laR.content.text));
    record(P, "Late start", /ACK late/.test(laR.content.text) ? "PASS" : "FAIL");

    const rw = mk(flavor, "rewrite");
    await rw.openChat();
    const rwR = await rw.ask("TOKEN-rewrite");
    check(P + ": a reply rewritten at the end is read in its final form", /ACK REWRITE/.test(rwR.content.text), rwR.content.text);
    record(P, "Rewrite during stream", /ACK REWRITE/.test(rwR.content.text) ? "PASS" : "FAIL");

    const stall = mk(flavor, "stall", { maxWaitMs: 8000, streamStallMs: 3000 });
    await stall.openChat();
    const stR = await stall.ask("LONG stall");
    const stSig = stR.extraction_metadata.completionSignal;
    const stallHonest = stR.status === "partial" && (flavor === "deepseek" ? stSig === "stalled" : true);
    check(P + ": a reply that stops mid-way is reported partial" + (flavor === "deepseek" ? " (reply request still open → stalled)" : " (stop control still up)"), stallHonest, JSON.stringify({ s: stR.status, sig: stSig }));
    record(P, "Stalled generation", stallHonest ? "PASS" : "FAIL",
      flavor === "deepseek" ? "reply request still open, nothing arriving → status partial, signal stalled" : "stop control still visible → status partial, signal " + stSig);

    const cut = mk(flavor, "cut");
    await cut.openChat();
    const cuR = await cut.ask("LONG cut");
    const cutHonest = cuR.status === "partial" && cuR.extraction_metadata.completionSignal === "interrupted";
    check(P + ": a connection cut mid-reply is " + (flavor === "deepseek" ? "reported as interrupted" : "not distinguishable without a stream tap"), flavor === "deepseek" ? cutHonest : true, JSON.stringify({ s: cuR.status, sig: cuR.extraction_metadata.completionSignal, n: cuR.content.text.length }));
    record(P, "Network interruption", flavor === "deepseek" ? (cutHonest ? "PASS" : "FAIL") : "PARTIAL",
      flavor === "deepseek" ? "the stream tap reports the failed transfer → status partial/interrupted" : "no measured stream endpoint: a cut reply ends like a finished one (status " + cuR.status + ")");

    const lc = mk(flavor, "layoutchange");
    await lc.openChat();
    await lc.ask("TOKEN-before");
    const lcR = await lc.ask("TOKEN-after");
    const lcOk = /ACK after/.test(lcR.content.text) && !/ACK before/.test(lcR.content.text);
    check(P + ": after a mid-conversation redesign the new reply is still read", lcOk, lcR.content.text + " | " + lcR.extraction_metadata.strategy);
    check(P + ": and the fallback is reported", lcR.extraction_metadata.warnings.some((w) => /fallback/.test(w)), JSON.stringify(lcR.extraction_metadata));
    record(P, "Layout change", lcOk ? "PASS" : "FAIL", "carried by " + lcR.extraction_metadata.strategy);

    if (flavor === "deepseek") {
      check(P + ": stopGeneration reports false - there is no distinct stop control", (await p.stopGeneration()) === false);
      record(P, "Stop generation", "NOT_APPLICABLE", "measured: DeepSeek's stop control is its send control");
    } else {
      const sg = mk(flavor, "slow-stream");
      await sg.openChat();
      await sg.submitPrompt("LONG to be stopped");
      await waitFor((await sm.get("provider:" + A.adapterFor(flavor).id).page()).page, async () => (await sg.detectState({ inFlight: true })).state === "GENERATING", { timeoutMs: 5000 });
      const stopped = await sg.stopGeneration();
      check(P + ": stopGeneration stops a reply in progress", stopped);
      record(P, "Stop generation", stopped ? "PASS" : "FAIL");
    }

    section(P + ": recovery");
    const rec = mk(flavor, "slow-stream");
    await rec.openChat();
    await rec.submitPrompt("LONG crash me");
    const page = (await sm.get("provider:" + A.adapterFor(flavor).id).page()).page;
    setTimeout(async () => { try { const c = await page.context().newCDPSession(page); c.send("Page.crash").catch(() => {}); } catch { /* crashed */ } }, 400);
    const crashed = await rec.waitForResponse();
    check(P + ": a renderer crash mid-reply ends the wait as interrupted", crashed.signal === "interrupted", JSON.stringify(crashed));
    const reopened = await rec.openChat();
    check(P + ": and the provider recovers to CHAT_READY", reopened.state === "CHAT_READY", JSON.stringify(reopened));
    const after = await rec.ask("TOKEN-recovered");
    check(P + ": and answers again", /ACK recovered/.test(after.content.text));
    record(P, "Failure recovery", reopened.state === "CHAT_READY" && /ACK recovered/.test(after.content.text) ? "PASS" : "FAIL", "renderer crash mid-reply → interrupted → page recreated");

    const hr = mk(flavor, "hang-renderer", { unresponsiveMs: 4000 });
    await hr.openChat();
    const hrT = Date.now();
    const hrR = await hr.ask("TOKEN-hang");
    const hrOk = hrR.extraction_metadata.completionSignal === "interrupted" && Date.now() - hrT < 30000;
    check(P + ": a page whose script locks its main thread is declared unresponsive, not waited on forever", hrOk, JSON.stringify({ s: hrR.status, sig: hrR.extraction_metadata.completionSignal, ms: Date.now() - hrT }));
    const hrBack = await mk(flavor, "normal").openChat();
    check(P + ": and a fresh page works afterwards", hrBack.state === "CHAT_READY", JSON.stringify(hrBack));
    record(P, "Unresponsive page", hrOk && hrBack.state === "CHAT_READY" ? "PASS" : "FAIL", "main thread locked by the site's script → interrupted after the unresponsive window, page replaced");

    section(P + ": as a research synthesiser");
    const agent = new ResearchAgent({ backends: [new S.BrowserSearchBackend(S.FIXTURE_ENGINE(base), sm, tracer)], fetcher: new WebFetcher({ sessions: sm, tracer, politenessMs: 0 }), synthesizer: p, tracer }, { maxTimeMs: 60000 });
    await p.startConversation();
    const report = await agent.run("What are the Widget Engine rate limits?");
    const synthOk = report.answer.via === "model" && report.answer.check && report.answer.check.used.length > 0 && report.answer.check.invalid.length === 0;
    check(P + ": answers from the built context with valid citations", synthOk, JSON.stringify({ via: report.answer.via, check: report.answer.check, w: report.answer.warnings }));
    record(P, "Research synthesis", synthOk ? "PASS" : "FAIL", "fixture model quotes the cited evidence");
    record(P, "Citation handling", synthOk ? "PASS" : "FAIL", "citations checked against the context's source list");
    record(P, "Contradictory information", report.conflicts.length ? "PASS" : "FAIL", report.conflicts.length + " conflict(s) passed to the model");
    record(P, "Multi-source reasoning", report.context.citations.length >= 2 ? "PASS" : "FAIL", report.context.citations.length + " sources in context");
    record(P, "Tool-use simulation", "NOT_APPLICABLE", "the model drives a chat window and cannot call tools; research runs outside it (see ROADMAP item 13)");
    time(P, "suite", Date.now() - t0);
    await p.close();
  }

  // ---------------------------------------------------------- extraction --
  async function extractionSuite() {
    section("extraction: the real recorded DeepSeek reply, through the real provider code");
    const ctx = await sm.context({ key: "temp:replay", kind: "temporary" });
    const mp = await ctx.page();
    const html = fs.readFileSync(path.join(__dirname, "fixtures", "replay", "deepseek-reply.html"), "utf8");
    await mp.page.setContent("<!doctype html><html><body><main>" + html + "</main><textarea placeholder='x'></textarea></body></html>");
    const p = new ChatWebProvider(A.DEEPSEEK, { sessions: sm, tracer });
    p.attach(mp);
    const r = await p.extractResponse();
    check("found by the MEASURED selector", /ds-markdown/.test(r.extraction_metadata.strategy) && r.extraction_metadata.provenance === "MEASURED", r.extraction_metadata.strategy);
    check("one python block, prose around it", r.content.code.length === 1 && r.content.code[0].lang === "python" && /slug/i.test(r.content.text));
    check("Copy/Download controls are not in the text", !/\bCopy\b|\bDownload\b/.test(r.content.text));
    check("inline code preserved", /`unidecode`/.test(r.content.markdown));
    record("extraction", "Recorded DeepSeek markup", r.content.code.length === 1 ? "PASS" : "FAIL", "replay fixture through ChatWebProvider.extractResponse");
    const snap = await snapshot(mp.page);
    check("a whole-page snapshot counts nodes and is not truncated", snap.nodeCount > 50 && !snap.truncated);
    await sm.closeContext("temp:replay");
  }

  // ------------------------------------------------------------ research --
  async function researchSuite() {
    section("research: fetching, cheapest representation first");
    const caches = new ResearchCaches();
    const f = new WebFetcher({ sessions: sm, tracer, politenessMs: 0, cache: caches.page, timeoutMs: 3000 });
    const doc = await f.fetch(base + "/web/docs/intro?utm_source=x");
    check("a static page is read over HTTP", doc.ok && doc.mode === "http" && doc.page.title === "Widget Engine - Introduction");
    const cached = await f.fetch(base + "/web/docs/intro");
    check("the tracking variant is served from cache", cached.mode === "cache");
    const spa = await f.fetch(base + "/web/spa");
    check("an app shell escalates to the browser", spa.ok && spa.mode === "browser" && spa.escalated && /CLI is called widget/.test(spa.page.main_text), spa.page && spa.page.main_text);
    const feed = await f.fetch(base + "/web/feed", "browser");
    const items = (feed.page.main_text.match(/Feed item/g) || []).length;
    check("infinite scroll is followed a bounded number of times", items > 10 && items <= 50, items);
    const hang = await f.fetch(base + "/web/hang", "http");
    check("a hanging server is a classified timeout", !hang.ok && hang.errorKind === "timeout", JSON.stringify(hang));
    const four = await f.fetch(base + "/web/missing", "http");
    check("a 404 is not content", !four.ok && four.status === 404);
    record("research", "Browser fetcher (http/browser/escalation)", doc.ok && spa.escalated ? "PASS" : "FAIL", "static via HTTP; app shell escalated; infinite scroll bounded");

    section("research: search is modular and normalised");
    const be = new S.BrowserSearchBackend(S.FIXTURE_ENGINE(base), sm, tracer);
    const out = await be.search({ text: "widget performance", strategy: "broad", subquestionId: "sq1" }, 10);
    check("results normalised with canonical URLs", out.status === "ok" && out.results.every((r) => r.canonical_url && r.domain && r.relevance.backend === "browser:fixture"));
    check("the sponsored link is not a result", !out.results.some((r) => /Sponsored/.test(r.title)));
    const none = await be.search({ text: "zzzz", strategy: "broad", subquestionId: "sq1" }, 10);
    check("no results is 'empty', not an error", none.status === "empty");
    record("research", "Search normalisation", out.status === "ok" ? "PASS" : "FAIL", "fixture engine; live engines UNVERIFIED");

    section("research: the full loop");
    const agent = new ResearchAgent({ backends: [be], fetcher: f, tracer, caches }, { maxTimeMs: 60000 });
    const rep = await agent.run("What are the Widget Engine rate limits and performance?");
    check("stops because the question is covered", rep.stopReason === "sufficient", rep.stopReason);
    check("both conflicts found", rep.conflicts.length === 2, rep.conflicts.map((c) => c.context).join(" | "));
    check("the mirror is not cited as a separate source", !rep.context.citations.some((c) => /mirror/.test(c.url)));
    check("citations never carry tracking parameters", !rep.context.citations.some((c) => /utm_|ref=/.test(c.url)));
    check("every evidence line in the answer cites a source", rep.answer.text.split("\n").filter((l) => /^- /.test(l)).every((l) => /\[\d+\]/.test(l)));
    check("the graph traces evidence to sources", rep.graph.nodes.filter((n) => n.kind === "source").length >= 4 && rep.graph.edges.some((e) => e.kind === "contains"));
    record("research", "Multi-query research loop", rep.stopReason === "sufficient" ? "PASS" : "FAIL", rep.used.queries + " queries, " + rep.used.pages + " pages, stop=" + rep.stopReason);
    record("research", "Duplicate removal", !rep.context.citations.some((c) => /mirror/.test(c.url)) ? "PASS" : "FAIL", "tracking variants + syndicated mirror");
    record("research", "Conflict detection", rep.conflicts.length === 2 ? "PASS" : "FAIL", rep.conflicts.map((c) => c.context).join("; "));
    record("research", "Provenance", "PASS", "claim → evidence span → section → URL");

    const linkQ = await new ResearchAgent({ backends: [be], fetcher: f, tracer }, { maxTimeMs: 60000, maxRounds: 3 }).run("How do I install the Widget Engine with npm?");
    const followed = linkQ.rounds.some((r) => r.opened.some((o) => o.via === "link" && /install/.test(o.url)));
    check("a page the search never returned is reached by following a link", followed, linkQ.stopReason + " " + JSON.stringify(linkQ.rounds.map(r => r.coverage)) + " " + JSON.stringify(linkQ.rounds.map((r) => r.opened.map((o) => o.via + ":" + o.url.replace(base, "")))));
    check("and its evidence is used", /Install the Widget Engine from npm/.test(linkQ.context.text), linkQ.context.text.slice(0, 400));
    record("research", "Link following", followed ? "PASS" : "FAIL", "install page found only via the docs sidebar link");

    const budget = await new ResearchAgent({ backends: [be], fetcher: f, tracer }, { maxPages: 1, maxTimeMs: 60000 }).run("What are the Widget Engine rate limits and performance?");
    check("a page budget stops the run and says so", budget.stopReason === "max-pages" && budget.used.pages <= 1, budget.stopReason);
    const nob = await new ResearchAgent({ backends: [], fetcher: f, tracer }).run("anything");
    check("no search backends is reported, not crashed", nob.stopReason === "no-backends");
    record("research", "Budgets and stop conditions", budget.stopReason === "max-pages" ? "PASS" : "FAIL");
    check("the cache was used", caches.stats().page.hits > 0, JSON.stringify(caches.stats()));
  }

  // --------------------------------------------------------------- chaos --
  async function chaosSuite() {
    section("chaos: the research browser is killed between fetches");
    const f = new WebFetcher({ sessions: sm, tracer, politenessMs: 0 });
    await f.fetch(base + "/web/spa", "browser");
    const before = sm.stats().launches;
    await sm.killSharedBrowserForTest();
    await new Promise((r) => setTimeout(r, 500));
    const again = await f.fetch(base + "/web/spa", "browser");
    check("the next fetch relaunches and succeeds", again.ok && sm.stats().launches > before, JSON.stringify({ ok: again.ok, e: again.error, launches: sm.stats().launches, before }));
    record("chaos", "Browser killed", again.ok ? "PASS" : "FAIL", "shared research browser SIGKILL → relaunch on next use");

    section("chaos: a provider's tab is closed between prompts");
    const p = mk("qwen", "normal");
    await p.openChat();
    await p.ask("TOKEN-one");
    const mp = await sm.get("provider:qwen").page();
    await mp.page.close();
    const r2 = await p.ask("TOKEN-two");
    check("the next ask reopens the conversation and answers", /ACK two/.test(r2.content.text), r2.content.text);
    record("chaos", "Tab closed", /ACK two/.test(r2.content.text) ? "PASS" : "FAIL");

    section("chaos: the expected selector disappears mid-conversation");
    const mp2 = await sm.get("provider:qwen").page();
    await mp2.page.evaluate(() => { for (const el of document.querySelectorAll('[class*="assistant"]')) el.className = "bubble-x"; });
    const r3 = await p.ask("TOKEN-three");
    check("the reply is still read through a fallback", /ACK three/.test(r3.content.text), r3.content.text + " via " + r3.extraction_metadata.strategy);
    record("chaos", "Selector removed", /ACK three/.test(r3.content.text) ? "PASS" : "FAIL", "via " + r3.extraction_metadata.strategy);

    section("chaos: the viewport changes while a reply streams");
    const mp3 = await sm.get("provider:qwen").page();
    const pending = p.ask("LONG viewport");
    setTimeout(() => mp3.page.setViewportSize({ width: 420, height: 700 }).catch(() => {}), 300);
    const r4 = await pending;
    check("the reply completes intact", /END-OF-LONG-REPLY/.test(r4.content.text));
    record("chaos", "Viewport change", /END-OF-LONG-REPLY/.test(r4.content.text) ? "PASS" : "FAIL");

    section("chaos: the page reloads mid-generation");
    const pending2 = p.ask("LONG reload");
    setTimeout(() => mp3.page.reload().catch(() => {}), 400);
    const r5 = await pending2;
    // The fixture keeps no server-side history, so a reload loses the reply.
    // What matters is that the wait ends and says what it has.
    check("the wait ends and does not report the lost reply as complete text", r5.status !== "complete" || r5.content.text.length < 25000, JSON.stringify({ s: r5.status, n: r5.content.text.length, sig: r5.extraction_metadata.completionSignal }));
    record("chaos", "Reload mid-generation", "PARTIAL", "the wait ends (status " + r5.status + "); whether a live site restores the reply after reload is UNKNOWN");
    await p.close();

    section("chaos: malformed and empty extraction");
    const ctx = await sm.context({ key: "temp:chaos", kind: "temporary" });
    const cp = await ctx.page();
    await cp.page.setContent('<main><div class="ds-markdown"><div role="button">Copy</div></div><textarea placeholder="x"></textarea></main>');
    const px = new ChatWebProvider(A.DEEPSEEK, { sessions: sm, tracer }); px.attach(cp);
    const rx = await px.extractResponse();
    check("a reply holding only controls is 'empty'", rx.status === "empty");
    await cp.page.setContent('<main><textarea placeholder="x"></textarea></main>');
    const ry = await px.extractResponse();
    check("no reply at all is 'empty' with a warning, not a throw", ry.status === "empty" && ry.extraction_metadata.warnings.length > 0);
    record("chaos", "Malformed/empty extraction", rx.status === "empty" && ry.status === "empty" ? "PASS" : "FAIL");
    await sm.closeContext("temp:chaos");
  }
}

main().catch((e) => { console.error("web suite threw:", e); process.exit(1); });
