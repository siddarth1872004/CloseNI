/**
 * The one implementation of AIWebProvider. Adapters are data; this is the
 * behaviour, written once for every browser-accessed AI.
 *
 * What it keeps from PlaywrightController, because each was learned the hard
 * way against a live site:
 *   - long prompts go in through the NATIVE value setter (React tracks its own
 *     copy of the value; assigning el.value is swallowed) - now scoped to the
 *     resolved composer instead of the first textarea on the page;
 *   - the composer is verified to hold the text before sending;
 *   - Enter is the fallback when no send control resolves (DeepSeek's case);
 *   - a reply that differs from the previous message counts as new, because
 *     follow-up answers are often shorter;
 *   - a closed reply stream shortens the stability window, never skips it;
 *   - the provider's own Copy control upgrades code blocks when counts agree.
 *
 * What it adds: named UI states, a mutation counter so polling does not re-read
 * the reply when nothing changed, incremental capture of the streaming text,
 * selector chains that report which link held, page-crash recovery, and debug
 * artifacts captured automatically at the points a run gets stuck.
 */
import { Locator } from "playwright";
import {
  AIWebProvider, AIResponse, Artifact, AskOptions, HealthReport, StateReport, SubmitResult, UIState, WaitResult,
} from "./ai-web-provider.js";
import { AdapterSpec } from "./adapters.js";
import { classifyState, collectSignalsInPage, LOGIN_TEXT, PageSignals, isTerminalForAutomation } from "./state.js";
import { CompletionDetector, StreamCapture } from "./completion-detector.js";
import { replyStreamTap, mutationCounter } from "../../providers/stream-tap.js";
import { BrowserSessionManager, ManagedContext, ManagedPage } from "../browser/session-manager.js";
import { navigate, NavOutcome, waitFor } from "../browser/navigate.js";
import { captureDiagnostics, DebugArtifacts, diagnosticsRoot } from "../browser/diagnostics.js";
import { ChainDiagnosis, ChainSpec, Resolved, diagnoseChain, resolveChain } from "../selectors/chain.js";
import { snapshotLocator } from "../semantic/dom.js";
import { pipeline } from "../response/normalize.js";
import { Tracer, quietTracer } from "../trace.js";
import { nowMs, sleep } from "../util.js";

type ChainName = keyof AdapterSpec["chains"];

export interface ProviderDeps {
  sessions: BrowserSessionManager;
  tracer?: Tracer;
  /** Where this provider's login lives. Required to launch; not needed to attach. */
  profileDir?: string;
  diagnosticsDir?: string;
  /** Capture artifacts automatically on AUTH_REQUIRED, CAPTCHA, ERROR and failed waits. */
  autoDiagnostics?: boolean;
}

/** Pages whose binding is installed. exposeBinding throws if repeated on a page. */
const bound = new WeakSet<object>();
/** Which provider object the page's stream binding reports to. */
const owners = new WeakMap<object, ChatWebProvider>();

const TIMED_OUT = Symbol("timed-out");

/**
 * A page call bounded in time. page.evaluate has no timeout of its own, so a
 * page whose main thread is stuck - an infinite loop in the site's own script -
 * would otherwise hang the whole run, which is exactly what a fixture with a
 * looping Markdown renderer did.
 */
function bounded<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(TIMED_OUT), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(TIMED_OUT); });
  });
}

export class ChatWebProvider implements AIWebProvider {
  readonly id: string;
  readonly name: string;
  private mp: ManagedPage | null = null;
  private ctx: ManagedContext | null = null;
  private attached = false;
  private resolved: Partial<Record<ChainName, Resolved>> = {};
  private stream = { opened: 0, closed: 0, status: 0, cut: false };
  /**
   * The stop control was seen between sending and waiting. A reply that is
   * over before the wait starts - an empty one - shows its stop control only
   * briefly, and the detector must still know it came and went.
   */
  private stopSeenSinceSubmit = false;
  private lastNav: NavOutcome | null = null;
  private lastWait: WaitResult | null = null;
  private baseline = { count: 0, text: "" };
  private lastUrl = "";
  private readonly tracer: Tracer;
  private readonly diagDir: string;

  constructor(readonly spec: AdapterSpec, private deps: ProviderDeps) {
    this.id = spec.id;
    this.name = spec.name;
    this.tracer = (deps.tracer || quietTracer()).child({ provider: spec.id });
    this.diagDir = deps.diagnosticsDir || diagnosticsRoot();
  }

  // ------------------------------------------------------------ lifecycle --

  async launch(): Promise<void> {
    if (this.mp && this.mp.healthy()) return;
    if (!this.deps.profileDir) throw new Error(this.name + ": no profile directory - launch needs one, attach does not");
    this.ctx = await this.deps.sessions.context({
      key: "provider:" + this.id, kind: "provider", profileDir: this.deps.profileDir,
      clipboardOrigin: originOf(this.spec.baseUrl),
    });
    this.mp = await this.ctx.page("main");
    await this.install();
  }

  attach(page: ManagedPage): void {
    this.mp = page;
    this.attached = true;
    this.resolved = {};
  }

  private onStream(ev: string, status?: number, errored?: boolean): void {
    if (ev === "open") { this.stream.opened++; this.stream.status = typeof status === "number" ? status : 0; }
    else if (ev === "close") { this.stream.closed++; if (errored) this.stream.cut = true; }
  }

  private page(): ManagedPage {
    if (!this.mp) throw new Error(this.name + ": not launched");
    return this.mp;
  }

  /** Binding + init scripts, once per page. Failures leave stability in charge. */
  private async install(): Promise<void> {
    const mp = this.page();
    const p = mp.page;
    try {
      // A binding lives as long as its page and cannot be replaced, but the
      // provider object driving that page can be - a new ChatWebProvider over
      // the same profile reuses the page. So the binding reports to whoever
      // owns the page now, not to whoever installed it.
      owners.set(p, this);
      if (!bound.has(p)) {
        await p.exposeBinding("__closeniStream", (_src: any, ev: string, status?: number, errored?: boolean) => {
          const owner = owners.get(p);
          if (owner) owner.onStream(ev, status, errored);
        });
        await p.addInitScript(mutationCounter);
        if (this.spec.streamUrlPattern) await p.addInitScript(replyStreamTap, this.spec.streamUrlPattern);
        bound.add(p);
      }
      await p.evaluate(mutationCounter).catch(() => { /* about:blank before navigation */ });
      if (this.spec.streamUrlPattern) await p.evaluate(replyStreamTap, this.spec.streamUrlPattern).catch(() => { /* same */ });
    } catch (err: any) {
      this.tracer.event({ action: "install-watchers", result: "failure", error: String(err && err.message || err) });
    }
  }

  /**
   * A crashed or closed page is replaced and sent back to where it was.
   * Returns false when there is no context to recover into (attached pages).
   */
  private async recover(): Promise<boolean> {
    if (this.mp && this.mp.healthy()) return true;
    if (this.attached) return false;
    // The whole context can go too - a browser crash takes every page with it.
    // Ask the session manager again; it relaunches a dead context.
    if (!this.ctx || !this.ctx.alive()) {
      if (!this.deps.profileDir) return false;
      try {
        this.ctx = await this.deps.sessions.context({ key: "provider:" + this.id, kind: "provider", profileDir: this.deps.profileDir, clipboardOrigin: originOf(this.spec.baseUrl) });
      } catch (err: any) {
        this.tracer.event({ action: "recover", result: "failure", error: String(err && err.message || err) });
        return false;
      }
    }
    const target = this.lastUrl || this.spec.baseUrl;
    this.tracer.event({ action: "recover", result: "info", url: target, detail: this.mp && this.mp.crashed ? "renderer crashed" : "page closed" });
    this.mp = await this.ctx.page("main");
    this.resolved = {};
    await this.install();
    this.lastNav = await navigate(this.mp, target, { tracer: this.tracer, timeoutMs: 30000, retries: 1 });
    await this.install();
    return this.lastNav.ok;
  }

  async close(): Promise<void> {
    if (this.attached) { this.mp = null; return; }
    await this.deps.sessions.closeContext("provider:" + this.id);
    this.mp = null;
    this.ctx = null;
  }

  // ------------------------------------------------------------- chains --

  private async chain(name: ChainName, fresh: boolean = false): Promise<Resolved | null> {
    const spec: ChainSpec = this.spec.chains[name];
    if (!spec.strategies.length) return null;
    const cached = this.resolved[name];
    if (cached && !fresh) {
      const still = await cached.locator.count().catch(() => 0);
      if (still > 0) return cached;
    }
    const r = await resolveChain(this.page().page, spec);
    if (r) {
      this.resolved[name] = r;
      if (r.index > 0) this.tracer.event({ action: "selector-fallback", result: "info", selector: r.description, detail: name + " carried by strategy #" + (r.index + 1) });
    } else {
      delete this.resolved[name];
    }
    return r;
  }

  // -------------------------------------------------------------- state --

  private async signals(): Promise<PageSignals> {
    const p = this.page().page;
    const generic: PageSignals = await p.evaluate(collectSignalsInPage, {
      composer: null, stop: null, send: null, assistant: null,
      loginText: LOGIN_TEXT.concat((this.spec.stateHints && this.spec.stateHints.loginText) || []),
    });
    const composer = await this.chain("composer", true);
    if (composer) {
      const el = composer.locator.last();
      generic.composerVisible = await el.isVisible().catch(() => false);
      generic.composerEnabled = generic.composerVisible && (await el.isEditable().catch(() => false));
      generic.composerKind = await el.evaluate((e: any) => e.tagName === "TEXTAREA" ? "textarea" : e.isContentEditable ? "contenteditable" : e.tagName === "INPUT" ? "input" : "").catch(() => "");
    } else {
      generic.composerVisible = false;
      generic.composerEnabled = false;
    }
    const stop = await this.chain("stop", true);
    generic.stopVisible = stop ? await stop.locator.first().isVisible().catch(() => false) : false;
    if (generic.stopVisible) this.stopSeenSinceSubmit = true;
    const send = await this.chain("send", true);
    generic.sendEnabled = send ? await send.locator.last().isEnabled().catch(() => null) : null;
    const assistant = await this.chain("assistant", true);
    if (assistant) {
      generic.assistantCount = assistant.count;
      generic.lastAssistantChars = ((await assistant.locator.last().innerText().catch(() => "")) || "").length;
    }
    if (this.lastNav && this.lastNav.status) generic.httpStatus = this.lastNav.status;
    if (this.stream.status) generic.streamStatus = this.stream.status;
    return generic;
  }

  async detectState(ctx: { inFlight?: boolean; detector?: "waiting" | "streaming" | "complete" | "failed" } = {}): Promise<StateReport> {
    const mp = this.page();
    if (!mp.healthy()) return { state: "ERROR", evidence: ["page " + (mp.crashed ? "crashed" : "closed")], url: this.lastUrl };
    if (this.lastNav && !this.lastNav.ok && this.lastNav.errorKind !== "http") {
      return {
        state: "ERROR", evidence: ["navigation failed: " + this.lastNav.errorKind + (this.lastNav.error ? " - " + this.lastNav.error : "")],
        url: this.lastNav.url, navigation: navSummary(this.lastNav),
      };
    }
    try {
      const got = await bounded(this.signals(), 8000);
      if (got === TIMED_OUT) return { state: "UNKNOWN", evidence: ["the page did not answer within 8s - its main thread may be stuck"], url: this.lastUrl };
      const s = got;
      const c = classifyState(s, { hints: this.spec.stateHints, ...ctx });
      return { state: c.state, evidence: c.evidence, url: s.url, ...(this.lastNav ? { navigation: navSummary(this.lastNav) } : {}) };
    } catch (err: any) {
      return { state: "UNKNOWN", evidence: ["could not read the page: " + String(err && err.message || err).split("\n")[0]], url: this.lastUrl };
    }
  }

  /** Poll the state until it is one a caller can act on. */
  private async settle(timeoutMs: number): Promise<StateReport> {
    const deadline = nowMs() + timeoutMs;
    let last: StateReport = await this.detectState();
    let readySince = -1;
    while (nowMs() < deadline) {
      if (last.state === "CHAT_READY" || isTerminalForAutomation(last.state)) return last;
      if (last.state === "READY") {
        if (readySince < 0) readySince = nowMs();
        // A loaded page with no composer and no login markers, stable for a few
        // seconds, is an answer in itself - not worth the whole timeout.
        if (nowMs() - readySince > 4000) return last;
      } else readySince = -1;
      await sleep(this.spec.timing.pollMs);
      last = await this.detectState();
    }
    return last;
  }

  private async noteTerminal(report: StateReport, label: string): Promise<void> {
    if (this.deps.autoDiagnostics === false) return;
    if (!isTerminalForAutomation(report.state) && report.state !== "UNKNOWN" && report.state !== "GENERATION_FAILED") return;
    await this.diagnostics(label + "-" + report.state.toLowerCase(), { state: report });
  }

  async openChat(): Promise<StateReport> {
    if (!this.attached) await this.launch();
    const mp = this.page();
    this.lastNav = await navigate(mp, this.spec.baseUrl, { tracer: this.tracer, timeoutMs: 30000, retries: 1 });
    this.lastUrl = this.lastNav.finalUrl || this.spec.baseUrl;
    if (!this.lastNav.ok && this.lastNav.errorKind !== "http") {
      const r = await this.detectState();
      this.tracer.event({ action: "open-chat", result: "failure", url: this.spec.baseUrl, detail: r.state + ": " + r.evidence.join("; ") });
      return r;
    }
    await this.install();
    const r = await this.settle(this.spec.timing.readyTimeoutMs);
    this.tracer.event({ action: "open-chat", result: r.state === "CHAT_READY" ? "success" : "info", url: r.url, detail: r.state + ": " + r.evidence.join("; ") });
    await this.noteTerminal(r, "open-chat");
    return r;
  }

  async startConversation(): Promise<StateReport> {
    if (!this.mp) return this.openChat();
    const nc = await this.chain("newChat", true);
    if (nc && (await nc.locator.first().isVisible().catch(() => false))) {
      await nc.locator.first().click({ timeout: 5000 }).catch(() => { /* fall back to navigation */ });
      await sleep(500);
      this.resolved = {};
      const r = await this.settle(this.spec.timing.readyTimeoutMs);
      if (r.state === "CHAT_READY") return r;
    }
    return this.openChat();
  }

  async clearConversation(): Promise<void> {
    // A new conversation, not a deletion: removing history on the provider's
    // side is the user's decision, and nothing here should make it.
    await this.startConversation();
  }

  // ------------------------------------------------------------- prompt --

  private async composerText(loc: Locator): Promise<number> {
    return loc.evaluate((el: any) => (el.tagName === "TEXTAREA" || el.tagName === "INPUT" ? el.value : el.textContent || "").length).catch(() => -1);
  }

  /**
   * Close an overlay that is not a login: a cookie notice, a promo, a
   * "what's new" card. Escape first, then a button whose text says dismiss.
   * A login dialog is never touched - that is AUTH_REQUIRED, not an obstacle.
   */
  private async dismissBenignModal(): Promise<boolean> {
    const p = this.page().page;
    const dialog = p.locator('[role="dialog"]:visible, [aria-modal="true"]:visible, dialog[open]').first();
    if (!(await dialog.count().catch(() => 0))) return false;
    const isLogin = await dialog.evaluate((el: any) => !!el.querySelector('input[type="password"]') || /log ?in|sign ?in|登录/i.test(String(el.innerText || "").slice(0, 300))).catch(() => true);
    if (isLogin) return false;
    await p.keyboard.press("Escape").catch(() => { /* try a button */ });
    await sleep(200);
    if (!(await dialog.isVisible().catch(() => false))) { this.tracer.event({ action: "dismiss-modal", result: "success", detail: "escape" }); return true; }
    const btn = dialog.getByRole("button", { name: /^(accept|accept all|agree|i agree|got it|ok|okay|close|dismiss|continue|no thanks|知道了|同意|关闭|确定)$/i }).first();
    if (await btn.count().catch(() => 0)) {
      await btn.click({ timeout: 3000 }).catch(() => { /* reported below */ });
      await sleep(200);
    }
    const gone = !(await dialog.isVisible().catch(() => false));
    this.tracer.event({ action: "dismiss-modal", result: gone ? "success" : "failure", detail: gone ? "button" : "overlay stayed" });
    return gone;
  }

  async submitPrompt(prompt: string): Promise<SubmitResult> {
    if (!(await this.recover())) return { sent: false, method: "none", composer: "", chars: prompt.length, error: "page unavailable" };
    await this.dismissBenignModal();
    const pre = await this.detectState();
    if (pre.state === "GENERATING") {
      // Never type into a composer the provider has disabled mid-answer.
      await waitFor(this.page().page, async () => (await this.detectState()).state !== "GENERATING", { timeoutMs: 60000, intervalMs: 1000 });
    } else if (isTerminalForAutomation(pre.state)) {
      return { sent: false, method: "none", composer: "", chars: prompt.length, error: pre.state + ": " + pre.evidence.join("; ") };
    }
    const composer = await this.chain("composer", true);
    if (!composer) {
      await this.noteTerminal({ ...pre, state: "UNKNOWN" }, "no-composer");
      return { sent: false, method: "none", composer: "", chars: prompt.length, error: "no composer found by any strategy" };
    }
    const assistant = await this.chain("assistant", true);
    this.baseline = {
      count: assistant ? assistant.count : 0,
      text: assistant ? ((await assistant.locator.last().innerText().catch(() => "")) || "") : "",
    };
    this.stream = { opened: 0, closed: 0, status: 0, cut: false };
    this.stopSeenSinceSubmit = false;
    owners.set(this.page().page, this);
    const box = composer.locator.last();
    let method: string;
    await box.click({ timeout: 5000 }).catch(() => { /* focus by fill instead */ });
    if (prompt.length > this.spec.timing.longPromptChars) {
      method = "native-setter";
      await box.evaluate((el: any, text: string) => {
        const w = globalThis as any;
        if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
          const proto = el.tagName === "TEXTAREA" ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, "value");
          if (desc && desc.set) desc.set.call(el, text); else el.value = text;
          el.dispatchEvent(new w.Event("input", { bubbles: true }));
        } else {
          // A rich-text editor keeps its own model of the text and listens for
          // editing commands; insertText goes through that path in one step and
          // turns newlines into the editor's own line breaks. Assigning
          // textContent would bypass the model and flatten the lines.
          el.focus();
          const sel = w.getSelection();
          if (sel) { const r = w.document.createRange(); r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r); }
          const ok = w.document.execCommand && w.document.execCommand("insertText", false, text);
          if (!ok) { el.textContent = text; el.dispatchEvent(new w.Event("input", { bubbles: true })); }
        }
      }, prompt);
    } else {
      method = "fill";
      await box.fill(prompt, { timeout: 10000 });
    }
    const held = await this.composerText(box);
    if (held < Math.min(prompt.length, 40)) {
      method += "+refill";
      await box.fill(prompt, { timeout: 10000 }).catch(() => { /* reported below */ });
    }
    const send = await this.chain("send", true);
    let sentBy = "enter";
    if (send && (await send.locator.last().isEnabled().catch(() => false))) {
      try { await send.locator.last().click({ timeout: 5000 }); sentBy = "click:" + send.description; }
      catch { await box.press("Enter").catch(() => { /* reported below */ }); }
    } else {
      await box.press("Enter").catch(() => { /* reported below */ });
    }
    // Did it go? The composer empties, a reply starts, a stream opens, or the
    // stop control appears. If none of those within 3s, one more Enter.
    const went = await waitFor(this.page().page, async () => {
      if (this.stream.opened > 0) return true;
      const n = await this.composerText(box);
      if (n === 0) return true;
      const s = await this.chain("stop");
      if (s && (await s.locator.first().isVisible().catch(() => false))) { this.stopSeenSinceSubmit = true; return true; }
      const a = await this.chain("assistant", true);
      return !!a && a.count > this.baseline.count;
    }, { timeoutMs: 3000, intervalMs: 200 });
    if (!went && sentBy !== "enter") {
      await box.press("Enter").catch(() => { /* nothing more to try */ });
      sentBy += "+enter";
    }
    this.lastUrl = this.page().page.url();
    const result: SubmitResult = { sent: true, method: method + "/" + sentBy, composer: composer.description, chars: prompt.length };
    // Always look once more: a site may accept the text, empty the composer and
    // THEN demand a login or put up a challenge - "went" is not "was accepted".
    {
      const after = await this.detectState({ inFlight: true });
      if (after.state === "AUTH_REQUIRED" || after.state === "CAPTCHA") {
        result.sent = false;
        result.error = after.state + ": " + after.evidence.join("; ");
        await this.noteTerminal(after, "submit");
      }
    }
    this.tracer.event({ action: "submit", result: result.sent ? "success" : "failure", selector: composer.description, detail: result.method + " chars=" + prompt.length, error: result.error });
    return result;
  }

  // --------------------------------------------------------------- wait --

  async waitForResponse(opts: AskOptions = {}): Promise<WaitResult> {
    const t = this.spec.timing;
    const detector = new CompletionDetector(this.baseline, {
      stabilityMs: t.stabilityMs, settleMs: t.settleMs, startTimeoutMs: t.startTimeoutMs,
      maxWaitMs: opts.maxWaitMs || t.maxWaitMs, useStopControl: this.spec.chains.stop.strategies.length > 0,
      streamStallMs: t.streamStallMs,
    });
    if (this.stopSeenSinceSubmit) {
      detector.feed({ atMs: 0, assistantCount: this.baseline.count, text: this.baseline.text, stopVisible: true, streamsOpened: 0, streamsClosed: 0, mutationSeq: -1 });
    }
    const capture = new StreamCapture();
    const start = nowMs();
    let lastSeq = -2;
    let lastStateCheck = 0;
    let finalState: UIState = "UNKNOWN";
    let unresponsiveSince = -1;
    const finish = (status: WaitResult["status"], signal: WaitResult["signal"], error?: string): WaitResult => {
      const r: WaitResult = { status, signal, waitedMs: nowMs() - start, partials: capture.partials.slice(), finalState, ...(error ? { error } : {}) };
      this.lastWait = r;
      this.tracer.event({ action: "wait-response", result: status === "complete" ? "success" : "failure", durationMs: r.waitedMs,
        detail: "signal=" + signal + " partials=" + r.partials.length + " chars=" + capture.text.length, error });
      return r;
    };

    for (;;) {
      const mp = this.mp;
      if (!mp || !mp.healthy()) {
        const recovered = await this.recover().catch(() => false);
        finalState = "ERROR";
        return finish(recovered && capture.text ? "partial" : "failed", "interrupted", "page " + (mp && mp.crashed ? "crashed" : "closed") + " during generation" + (recovered ? " - recovered the page; the reply may be complete on reload" : ""));
      }
      const at = nowMs() - start;
      const seqR = await bounded(mp.page.evaluate(() => { const m = (globalThis as any).__closeniMut; return m ? m.seq : -1; }), 3000);
      if (seqR === TIMED_OUT) {
        // The page is not answering at all. Give it a while - a heavy render
        // can stall briefly - then call it what it is.
        if (unresponsiveSince < 0) unresponsiveSince = at;
        if (at - unresponsiveSince > t.unresponsiveMs) {
          finalState = "ERROR";
          const r = finish(capture.text ? "partial" : "failed", "interrupted", "the page stopped responding for " + Math.round((at - unresponsiveSince) / 1000) + "s - its main thread is stuck");
          // Replace the page so the next action gets a working one; closing a
          // wedged page is itself bounded.
          await bounded(mp.page.close(), 5000);
          mp.closed = true;
          return r;
        }
        await sleep(t.pollMs);
        continue;
      }
      unresponsiveSince = -1;
      const seq: number = seqR;
      let text: string | undefined;
      let count = this.baseline.count;
      // Only re-read the reply when the page actually changed.
      if (seq !== lastSeq || seq === -1) {
        const a = await this.chain("assistant", true);
        count = a ? a.count : 0;
        const tr = a ? await bounded(a.locator.last().innerText({ timeout: 5000 }), 6000) : "";
        text = tr === TIMED_OUT ? undefined : (tr || "");
        if (text !== undefined) lastSeq = seq;
      } else {
        const a = this.resolved.assistant;
        count = a ? a.count : count;
      }
      const stop = this.resolved.stop || (await this.chain("stop"));
      const sv = stop ? await bounded(stop.locator.first().isVisible(), 3000) : false;
      const stopVisible = sv === true;
      const v = detector.feed({ atMs: at, assistantCount: count, text, stopVisible,
        streamsOpened: this.stream.opened, streamsClosed: this.stream.closed, mutationSeq: seq, streamStatus: this.stream.status });
      if (text !== undefined && detector.hasStarted) {
        const d = capture.update(text, at);
        if (d.kind !== "none" && opts.onPartial) { try { opts.onPartial({ chars: text.length, delta: d.delta }); } catch { /* observer must not break the wait */ } }
      }
      if (v.phase === "complete") {
        finalState = "GENERATION_COMPLETE";
        if (v.reason === "empty-reply") return finish("complete", "empty");
        // A reply whose stream failed mid-transfer is not complete, however
        // still the page has gone.
        if (this.stream.cut) {
          finalState = "GENERATION_FAILED";
          return finish("partial", "interrupted", "the reply's connection failed before it finished - the text is truncated");
        }
        if (v.reason === "stalled") {
          return finish("partial", "stalled", "the reply's request is still open but nothing has arrived for a while - the text may be truncated");
        }
        const signal = v.reason === "stream-closed" ? "stream-closed" : v.reason === "stop-button-gone" ? "stop-button-gone" : v.reason === "timeout" ? "timeout" : "stability";
        return finish(v.reason === "timeout" ? "partial" : "complete", signal);
      }
      if (v.phase === "failed") {
        const st = await this.detectState({ inFlight: true, detector: "failed" });
        finalState = st.state;
        const r = finish(v.reason === "no-start" ? "no-start" : "failed", v.reason === "no-start" ? "no-start" : "failed", st.evidence.join("; "));
        await this.noteTerminal(st, "wait");
        return r;
      }
      // Every ~2s, look for the page having turned into something else: a login
      // dialog after sending, a rate-limit banner, an error.
      if (at - lastStateCheck > 2000) {
        lastStateCheck = at;
        const st = await this.detectState({ inFlight: true, detector: v.phase === "waiting" ? "waiting" : "streaming" });
        if (st.state === "AUTH_REQUIRED" || st.state === "CAPTCHA" || st.state === "RATE_LIMITED" || st.state === "GENERATION_FAILED") {
          finalState = st.state;
          const r = finish(capture.text ? "partial" : "failed", "failed", st.state + ": " + st.evidence.join("; "));
          await this.noteTerminal(st, "wait");
          return r;
        }
      }
      await sleep(t.pollMs);
    }
  }

  // ------------------------------------------------------------ extract --

  /** Code blocks as the provider's own Copy control reports them, or null. */
  private async copiedCode(message: Locator): Promise<string[] | null> {
    const copy = this.spec.chains.copy;
    if (!copy.strategies.length) return null;
    try {
      const r = await resolveChain(this.page().page, copy, message);
      if (!r) return null;
      const buttons = r.locator.filter({ hasText: /^\s*copy\s*$/i });
      const n = await buttons.count();
      if (!n) return null;
      const out: string[] = [];
      for (let i = 0; i < n; i++) {
        await buttons.nth(i).scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => { /* fine */ });
        await buttons.nth(i).click({ timeout: 3000 });
        await sleep(120);
        const text: string = await this.page().page.evaluate(() => (globalThis as any).navigator.clipboard.readText());
        if (typeof text !== "string" || !text.trim()) return null;
        out.push(text.replace(/\n$/, ""));
      }
      return out;
    } catch { return null; }
  }

  async extractResponse(opts: { keepDom?: boolean; wait?: WaitResult } = {}): Promise<AIResponse> {
    const started = nowMs();
    const warnings: string[] = [];
    const url = this.mp ? this.mp.page.url() : this.lastUrl;
    const wait = opts.wait || this.lastWait || undefined;
    // An empty reply leaves the PREVIOUS message as the last one on the page.
    // Reading it would return the last answer as this one.
    const emptyReply = !!wait && wait.signal === "empty";
    const assistant = this.mp && this.mp.healthy() && !emptyReply ? await this.chain("assistant", true) : null;
    let diag: ChainDiagnosis | undefined;
    if (emptyReply) {
      warnings.push("the provider finished without adding a reply");
    } else if (!assistant) {
      warnings.push("no assistant message found by any strategy");
    } else if (assistant.index > 0) {
      diag = await diagnoseChain(this.page().page, this.spec.chains.assistant).catch(() => undefined);
      warnings.push("assistant found by fallback " + assistant.description);
    }
    let dom = null;
    let innerText = "";
    let copyUsed = false;
    if (assistant) {
      const last = assistant.locator.last();
      innerText = (await last.innerText().catch(() => "")) || "";
      dom = await snapshotLocator(this.page().page, last).catch(() => null);
    }
    const res = pipeline(
      { provider: this.id, dom, innerText, url, capturedAt: new Date().toISOString() },
      this.spec.hints,
      {
        conversationIdPattern: this.spec.conversationIdPattern,
        wait,
        keepDom: opts.keepDom ? dom : null,
        meta: {
          strategy: assistant ? assistant.description : "none",
          provenance: assistant ? ((assistant.strategy as any).provenance || "UNVERIFIED") : "UNKNOWN",
          ...(diag ? { chainVerdict: diag.verdict } : assistant ? { chainVerdict: assistant.index === 0 ? "ok" as const : "fallback" as const } : { chainVerdict: "broken" as const }),
          extractMs: 0, copyButtonUsed: false, warnings,
        },
      },
    );
    // Upgrade code with the provider's own Copy output, only when the two views
    // agree about how many blocks there are.
    if (assistant && res.content.code.length) {
      const copied = await this.copiedCode(assistant.locator.last());
      if (copied && copied.length === res.content.code.length) {
        copied.forEach((text, i) => { res.content.code[i].text = text; });
        let k = 0;
        for (const a of res.artifacts) if (a.kind === "code") a.value = copied[k++] ?? a.value;
        copyUsed = true;
      } else if (copied) {
        res.extraction_metadata.warnings.push("copy control returned " + copied.length + " blocks, DOM has " + res.content.code.length + " - kept the DOM reading");
      }
    }
    res.extraction_metadata.copyButtonUsed = copyUsed;
    res.extraction_metadata.extractMs = nowMs() - started;
    this.tracer.event({ action: "extract", result: res.status === "empty" ? "failure" : "success", durationMs: res.extraction_metadata.extractMs,
      selector: res.extraction_metadata.strategy,
      detail: "status=" + res.status + " chars=" + res.content.text.length + " code=" + res.content.code.length + " tables=" + res.content.tables.length + " links=" + res.content.links.length + (res.reasoning ? " reasoning=yes" : "") });
    return res;
  }

  async extractReasoning(): Promise<AIResponse["reasoning"] | null> {
    const r = await this.extractResponse();
    return r.reasoning || null;
  }

  async extractArtifacts(): Promise<Artifact[]> {
    return (await this.extractResponse()).artifacts;
  }

  async stopGeneration(): Promise<boolean> {
    const stop = await this.chain("stop", true);
    if (!stop) return false;
    const btn = stop.locator.first();
    if (!(await btn.isVisible().catch(() => false))) return false;
    await btn.click({ timeout: 3000 }).catch(() => { /* checked below */ });
    const gone = await waitFor(this.page().page, async () => !(await btn.isVisible().catch(() => false)), { timeoutMs: 10000 });
    this.tracer.event({ action: "stop-generation", result: gone ? "success" : "failure", selector: stop.description });
    return gone;
  }

  async ask(prompt: string, opts: AskOptions = {}): Promise<AIResponse> {
    const sub = await this.submitPrompt(prompt);
    if (!sub.sent) {
      const wait: WaitResult = { status: "failed", signal: "failed", waitedMs: 0, partials: [], finalState: "UNKNOWN", error: sub.error };
      const r = await this.extractResponse({ wait, keepDom: opts.keepDom });
      r.status = "failed";
      r.extraction_metadata.warnings.push("prompt was not sent: " + (sub.error || "unknown"));
      return r;
    }
    const wait = await this.waitForResponse(opts);
    return this.extractResponse({ wait, keepDom: opts.keepDom });
  }

  // -------------------------------------------------------- diagnostics --

  async diagnostics(label: string, extra: Record<string, unknown> = {}): Promise<DebugArtifacts | null> {
    if (!this.mp) return null;
    try {
      const chains: ChainDiagnosis[] = [];
      if (this.mp.healthy()) {
        for (const name of Object.keys(this.spec.chains) as ChainName[]) {
          if (!this.spec.chains[name].strategies.length) continue;
          chains.push(await diagnoseChain(this.mp.page, this.spec.chains[name]));
        }
      }
      const art = await captureDiagnostics(this.mp, this.diagDir, this.id + "-" + label,
        { ...extra, chains, stream: this.stream, lastWait: this.lastWait });
      this.tracer.event({ action: "diagnostics", result: "info", detail: art.dir });
      return art;
    } catch (err: any) {
      this.tracer.event({ action: "diagnostics", result: "failure", error: String(err && err.message || err) });
      return null;
    }
  }

  async healthCheck(): Promise<HealthReport> {
    const state = await this.detectState();
    const chains: ChainDiagnosis[] = [];
    if (this.mp && this.mp.healthy()) {
      for (const name of Object.keys(this.spec.chains) as ChainName[]) {
        if (!this.spec.chains[name].strategies.length) continue;
        chains.push(await diagnoseChain(this.mp.page, this.spec.chains[name]));
      }
    }
    const composer = chains.find((c) => c.name === "composer");
    const ok = state.state === "CHAT_READY" && !!composer && composer.verdict !== "broken";
    const fallbacks = chains.filter((c) => c.verdict === "fallback").map((c) => c.name);
    const broken = chains.filter((c) => c.verdict === "broken").map((c) => c.name);
    const summary = state.state + (fallbacks.length ? "; on fallback: " + fallbacks.join(", ") : "") + (broken.length ? "; nothing matches: " + broken.join(", ") : "");
    return { provider: this.id, state, chains, ok, summary };
  }
}

function originOf(u: string): string | undefined {
  try { return new URL(u).origin; } catch { return undefined; }
}

function navSummary(n: NavOutcome): StateReport["navigation"] {
  return { ok: n.ok, ...(n.errorKind ? { errorKind: n.errorKind } : {}), ...(n.error ? { error: n.error } : {}), ...(n.status ? { status: n.status } : {}), finalUrl: n.finalUrl };
}
