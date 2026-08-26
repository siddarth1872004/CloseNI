import { chromium, BrowserContext, Page } from "playwright";
import * as path from "path";
import * as fs from "fs";
import { readSessions, writeSessions, resetBuildRun, getBuildLedger, setBuildLedger, BuildLedger, describeThread, getConversationSize, setConversationSize } from "../session-store.js";
import { isComplete } from "./completion.js";
import { applyProviderControls } from "./controls/index.js";
import { parseDesiredControls } from "./controls/decisions.js";
import { formatResults } from "./controls/helpers.js";
import { storagePaths } from "../storage-paths.js";

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  /**
   * Listed in the UI but not selectable, and refused if one is requested
   * anyway. Distinct from `enabled: false`, which hides a provider outright -
   * these are ones people should know are planned, shown as "coming soon"
   * rather than quietly missing. The reason lives in _comingSoonReason in the
   * JSON, next to the selectors someone will need in order to finish it.
   */
  comingSoon?: boolean;
  selectors: {
    chatInput: string;
    sendButton: string;
    /** Optional. With waitForStopButtonDisappear, ends a wait the moment the
     *  provider's own stop button vanishes instead of waiting out stability. */
    stopButton?: string;
    /**
     * Optional. A pattern matching the request the page streams its reply over.
     *
     * Used only to know when a reply has ENDED - deliberately not to read the
     * text. Knowing the stream closed needs no understanding of the provider's
     * chunk format, so this works without reverse-engineering a wire protocol,
     * and the reply still comes from the page where it is already read
     * correctly. An explicit end beats "the text has not changed for 8 seconds"
     * and is immune to the DOM problems entirely: a build step once sat at
     * "messages=3, chars=9019" for a full 300s wait because the element being
     * watched was the previous answer.
     */
    streamUrlPattern?: string;
    /**
     * Optional. The provider's own "Copy" control on a code block.
     *
     * When present, the code in a reply is read from the clipboard rather than
     * scraped out of highlighted markup. Purely an upgrade: anything wrong with
     * it falls back to reading the DOM.
     */
    copyButton?: string;
    assistantMessage: string;
  };
  completionRules: {
    waitForStopButtonDisappear: boolean;
    maxWaitMs: number;
  };
  /**
   * Optional. Roughly how much conversation this provider will hold, in
   * characters, before a build should continue in a new thread.
   *
   * A guess, and marked as one in the config. Nothing can read a provider's
   * real window, and getting it wrong in the safe direction costs one seeded
   * prompt - so it is set well below whatever the true limit is likely to be.
   * Absent falls back to DEFAULT_BUDGET_CHARS.
   */
  contextBudgetChars?: number;
  /** What this provider's UI offers. Read by the desktop settings panel; the
   *  agent only needs the selectors below. Absent means no controls. */
  controls?: Array<{
    id: string;
    label: string;
    kind: "select" | "toggle";
    default?: string | boolean;
    options?: Array<{ value: string; label: string }>;
  }>;
  /** Selectors live in config because they rot fastest — a provider renaming a
   *  class should be a text edit, not a recompile. */
  controlSelectors?: Record<string, string>;
  profileDir: string;
}

const FENCE = "\`\`\`";
const FALLBACK_SELECTORS = [
  'div[class*="ds-markdown"]',
  'div[class*="markdown-body"]',
  'div[class*="markdown"]',
  'div[class*="assistant"]',
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const DEFAULT_MAX_WAIT_MS = 120000;
const POLL_INTERVAL_MS = 2000;
// How long the reply length must hold steady before it counts as finished.
// Deliberately not read from completionRules.stableMs: the configured 3s is
// short enough that a model pausing mid-answer reads as done and the reply
// gets truncated.
const STABLE_TICKS = 4;
// Elapsed seconds drift off multiples of ten at a 2s poll, so counting ticks
// keeps the "still waiting" line on a predictable cadence.
const THINKING_LOG_EVERY_TICKS = 5;
/** Ticks of total stillness before the assistant selector is re-resolved. */
const FROZEN_TICKS = 15;

/** Ceiling on the soft extension given to a model that is still writing. */
const MAX_GRACE_MS = 180000;

/**
 * What the browser is doing right now, for the interface to show.
 *
 * Every one of these is emitted at the point the corresponding condition has
 * actually been observed on the page - a composer that exists, a stop button
 * that is visible, an assistant message whose text changed. None of them are
 * inferred from "we sent a prompt, so it is probably generating": a status
 * light that guesses is worse than none, because it keeps claiming progress
 * while a run is wedged.
 *
 * Repeats are dropped so the poll loop does not emit the same phase every two
 * seconds.
 */
let lastPhase = "";
function phase(name: string, detail?: string): void {
  const line = name + "|" + (detail || "");
  if (line === lastPhase) return;
  lastPhase = line;
  console.log("PHASE:" + JSON.stringify({ phase: name, detail: detail || "" }));
}

export class PlaywrightController {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private pickedSelector: string | null = null;
  private sessionStoreFile: string = "";
  private workspace: string = "";
  private isHeaded: boolean = false;
  // Build steps share a thread that is tracked separately from the Chat/Plan
  // thread, so the two never overwrite each other in sessions.json.
  /**
   * "worker" is a parallel build worker: it holds its own transient thread and
   * persists nothing. Without it, every worker would overwrite the workspace's
   * activeBuildThread with its own, and a resumed build would reopen whichever
   * worker happened to finish last instead of the main thread.
   */
  private threadKind: "chat" | "worker" = "chat";
  // Held from launch() so controls can be applied wherever a conversation
  // opens, without threading the config through every navigation path.
  private launchedConfig: ProviderConfig | null = null;
  // Resolved once in the constructor: packaged it comes from CLOSENI_STORAGE,
  // otherwise from the provider config, which is what the tests rely on.
  private profilePath: string = "";
  /** Workers share the launcher's context and must not close it. */
  private ownsContext: boolean = true;

  /** Which provider this controller drives - a saved thread belongs to one. */
  private providerId: string = "";

  /** The re-capture hint is printed once per process, not per conversation. */
  private static candidatesReported = false;

  /** Streams seen since the last reset: how many opened, how many closed. */
  private streamsOpened = 0;
  private streamsClosed = 0;
  private streamWatchInstalled = false;

  constructor(config: ProviderConfig) {
    const paths = storagePaths(process.env.CLOSENI_STORAGE, config);
    if (!fs.existsSync(paths.root)) fs.mkdirSync(paths.root, { recursive: true });
    this.sessionStoreFile = paths.sessionsFile;
    this.profilePath = paths.profileDir;
    this.providerId = config.id;
    this.isHeaded = process.env.AGENT_HEADED === "1";
  }

  setWorkspace(ws: string) {
    this.workspace = ws;
  }

  private loadSessions(): any {
    return readSessions(this.sessionStoreFile);
  }

  private saveSessions(sessions: any) {
    writeSessions(this.sessionStoreFile, sessions);
  }

  setThreadKind(kind: "chat" | "worker") {
    this.threadKind = kind;
  }

  /** Thread and ledger belong to the same run and are cleared together. */
  resetBuildRunForWorkspace() {
    resetBuildRun(this.sessionStoreFile, this.workspace);
  }

  getLedger(): BuildLedger {
    return getBuildLedger(this.sessionStoreFile, this.workspace);
  }

  saveLedger(ledger: BuildLedger) {
    setBuildLedger(this.sessionStoreFile, this.workspace, ledger);
  }

  /** Reply streams seen since the last send, for the smoke report. */
  streamStats(): { opened: number; closed: number } {
    return { opened: this.streamsOpened, closed: this.streamsClosed };
  }

  getConversationSize(): { chars: number; turns: number } {
    return getConversationSize(this.sessionStoreFile, this.workspace);
  }

  saveConversationSize(size: { chars: number; turns: number }) {
    setConversationSize(this.sessionStoreFile, this.workspace, size);
  }

  /**
   * Abandon this conversation and open an empty one.
   *
   * For a build that has outgrown its thread. The ledger and the size counter
   * go with it: both describe what the OLD conversation had been shown, and
   * carrying either across would have the next step compute its delta against
   * a thread that no longer exists.
   */
  async startFreshConversation(config: ProviderConfig): Promise<void> {
    this.resetBuildRunForWorkspace();
    await this.navigateFresh(config);
  }

  /**
   * The saved thread, but only if it belongs to the provider now running.
   *
   * Threads are stored per workspace, not per provider. While every mode forced
   * a fresh chat that never mattered; now that they resume, handing a
   * chat.deepseek.com URL to a different provider's browser would either waste
   * a 30s navigation or - worse - quietly load DeepSeek inside the other
   * provider's profile and send the prompt there.
   *
   * A thread saved before this field existed has no provider recorded. Those
   * are treated as belonging to whoever asks, because the only provider that
   * could have written one is the only one that has ever been usable.
   */
  getChatUrlForWorkspace(workspace: string): string | null {
    if (!workspace) return null;
    const sessions = this.loadSessions();
    const entry = sessions[workspace];
    if (!entry || !entry.activeChat) return null;
    if (entry.activeChatProvider && this.providerId &&
        entry.activeChatProvider !== this.providerId) {
      console.log("Saved thread belongs to " + entry.activeChatProvider + "; starting a new one.");
      return null;
    }
    return entry.activeChat;
  }

  /**
   * The saved conversation, described for the interface.
   *
   * Returns the full URL as well as a short label, because the panel needs the
   * URL to offer "open this conversation in your browser" - the whole point of
   * the thread being a real one on the provider's site. The label is what gets
   * displayed and logged; the URL is only ever handed to the shell.
   */
  describeSavedThread(workspace: string): { label: string; url: string } | null {
    const url = this.getChatUrlForWorkspace(workspace);
    if (!url) return null;
    return { label: describeThread(url) || "thread", url: url };
  }

  setChatUrlForWorkspace(workspace: string, url: string, title?: string) {
    if (!workspace) return;
    // A worker's thread is transient by design: recording it would clobber the
    // main build thread that a resume depends on.
    if (this.threadKind === "worker") return;
    const sessions = this.loadSessions();
    if (!sessions[workspace]) sessions[workspace] = { chats: [], activeChat: null };
    sessions[workspace].activeChat = url;
    sessions[workspace].activeChatProvider = this.providerId;
    if (title && !sessions[workspace].chats.find((c: any) => c.url === url)) {
      sessions[workspace].chats.push({
        url: url,
        title: title || "Chat " + (sessions[workspace].chats.length + 1),
        createdAt: new Date().toISOString(),
      });
    }
    this.saveSessions(sessions);
  }

  createNewChat(workspace: string) {
    if (!workspace) return;
    const sessions = this.loadSessions();
    if (!sessions[workspace]) sessions[workspace] = { chats: [], activeChat: null };
    sessions[workspace].activeChat = null;
    this.saveSessions(sessions);
  }

  async launch(config: ProviderConfig): Promise<void> {
    const profilePath = this.profilePath;
    if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true });
    const isHeadless = !this.isHeaded;
    console.log("Launching browser (" + (isHeadless ? "headless" : "HEADED - watch me!") + ") for " + config.name + "...");
    this.context = await chromium.launchPersistentContext(profilePath, {
      headless: isHeadless,
      viewport: { width: 1280, height: 900 },
      args: ["--disable-blink-features=AutomationControlled"],
    });
    this.page = this.context.pages()[0] || (await this.context.newPage());
    // Needed to read back what a provider's own Copy button puts on the
    // clipboard. Granted to the provider's origin only, and failure is
    // survivable - extraction falls back to reading the DOM.
    try {
      await this.context.grantPermissions(["clipboard-read", "clipboard-write"],
        { origin: new URL(config.baseUrl).origin });
    } catch { /* older browser, or an origin that will not take it */ }
    this.launchedConfig = config;
  }

  /** The context this controller launched, for workers to attach to. */
  /**
   * Put the provider's UI into the state the user asked for.
   *
   * These settings do not survive a new chat — the owner confirmed they reset —
   * and builds open a fresh thread per run, so this runs every time a
   * conversation opens rather than once at sign-in. It is called from
   * waitForLogin, which is the one thing every path that opens a conversation
   * already does after the chat input appears.
   */
  private async applyControls(): Promise<void> {
    const config = this.launchedConfig;
    if (!this.page || !config) return;
    const desired = parseDesiredControls(process.env.AGENT_CONTROLS);
    if (Object.keys(desired).length === 0) return;
    const results = await applyProviderControls(this.page, config.id, config.controlSelectors, desired);
    if (!results.length) return;
    // A control that is simply not on the page is reported once, quietly. It
    // repeats on every conversation open, and a provider redesign would
    // otherwise bury the run log in identical lines.
    const acted = results.filter((r) => r.action !== "unavailable");
    const missing = results.filter((r) => r.action === "unavailable");
    if (acted.length) {
      console.log("Provider controls:");
      for (const line of formatResults(config.id, acted)) console.log(line);
    }
    if (missing.length) {
      console.log("Provider controls not found on this page: " +
        missing.map((r) => r.id).join(", ") + " (selectors may need re-capturing)");
      await this.reportToggleCandidates();
    }
  }

  /**
   * List the pressable controls the page actually has, once, when one we wanted
   * was missing.
   *
   * Re-capturing a selector otherwise means installing the app, signing in,
   * opening devtools and hunting - and the person who has to do it is usually
   * not the person who can read the run log. Printing the candidates turns the
   * next ordinary run into the diagnostic. Labels and ARIA state only; no page
   * text, no URLs.
   */
  private async reportToggleCandidates(): Promise<void> {
    if (!this.page) return;
    // Once per run. A build opens a conversation per worker and the list is the
    // same every time; repeating it buries the step log it is meant to help.
    if (PlaywrightController.candidatesReported) return;
    PlaywrightController.candidatesReported = true;
    try {
      // This body runs in the page, where DOM globals exist. The agent compiles
      // without the "dom" lib, so it is written untyped rather than dragging
      // browser typings into a Node build for one diagnostic.
      const found: string[] = await this.page.evaluate(() => {
        const doc: any = (globalThis as any).document;
        const out: string[] = [];
        const seen: Record<string, boolean> = {};
        const nodes: any[] = Array.prototype.slice.call(doc.querySelectorAll(
          '[aria-pressed],[role="switch"],[role="radio"],[role="checkbox"],button,[role="button"]'), 0, 400);
        for (const el of nodes) {
          const label = String(el.innerText || el.getAttribute("aria-label") || "")
            .trim().replace(/\s+/g, " ");
          if (!label || label.length > 40) continue;
          const cls = String(el.getAttribute("class") || "").split(/\s+/).slice(0, 3).join(".");
          const pressed = el.getAttribute("aria-pressed") || el.getAttribute("aria-checked");
          const key = label + "|" + cls;
          if (seen[key]) continue;
          seen[key] = true;
          out.push("      " + JSON.stringify(label) +
            "  <" + String(el.tagName).toLowerCase() + (cls ? "." + cls : "") + ">" +
            (pressed === null ? "" : "  aria-pressed/checked=" + pressed));
          if (out.length >= 12) break;
        }
        return out;
      });
      if (found.length) {
        console.log("    pressable controls on this page (for re-capturing):");
        for (const line of found) console.log(line);
      }
    } catch {
      /* diagnostics must never break a run */
    }
  }

  /**
   * Resume this workspace's conversation. Returns true when the saved thread
   * actually loaded, so callers know whether the model still has the earlier
   * messages in front of it.
   */
  async navigateToChat(config: ProviderConfig): Promise<boolean> {
    if (!this.page) throw new Error("Browser not launched");
    const savedUrl = this.getChatUrlForWorkspace(this.workspace);
    if (savedUrl) {
      console.log("Resuming session chat " + describeThread(savedUrl) + " (same conversation as before).");
      await this.page.goto(savedUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      try {
        // 5s was too tight for a cold profile: the thread had loaded but the
        // composer had not mounted yet, so a perfectly good conversation was
        // abandoned and every message became a new one.
        await this.page.waitForSelector(config.selectors.chatInput, { timeout: 15000, state: "visible" });
        console.log("Session chat loaded successfully");
        return true;
      } catch {
        console.log("Session chat URL invalid, starting new chat...");
      }
    }
    console.log("Starting new chat for workspace: " + this.workspace);
    await this.page.goto(config.baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    return false;
  }

  async navigateFresh(config: ProviderConfig): Promise<void> {
    if (!this.page) throw new Error("Browser not launched");
    phase("opening", "new conversation");
    console.log("Starting fresh chat (no saved thread)...");
    await this.page.goto(config.baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  }

  /**
   * Watch the request the page streams its reply over.
   *
   * The page's own fetch is wrapped and the body tee'd, so the site behaves
   * exactly as before and we get told when the stream opens and closes. Only
   * the open/close events are used; the bytes are counted and discarded.
   *
   * Everything here is best-effort. A provider with no pattern configured, a
   * page that uses XHR instead, a binding that fails to install - all of it
   * simply leaves the old text-stability path in charge.
   */
  private async watchReplyStream(config: ProviderConfig): Promise<void> {
    const pattern = config.selectors.streamUrlPattern;
    if (!this.page || !pattern) return;

    // The wrapper, as source, so the identical code can be installed two ways.
    // Both transports, because a page may use either and DeepSeek uses only
    // one of them - XHR. The original wrapped fetch alone, so the tap never
    // fired once against the live site and completion silently fell back to
    // text stability for the whole life of the feature. Measured on 11 August:
    // 0 fetch calls, 36 XHR calls, with /api/v0/chat/completion among them.
    const tap = (pat: string) => {
      const w = globalThis as any;
      if (w.__closeniTapped) return;
      w.__closeniTapped = true;
      const re = new RegExp(pat);

      if (w.fetch) {
        const orig = w.fetch.bind(w);
        w.fetch = async (...args: any[]) => {
          const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
          const res = await orig(...args);
          try {
            if (!re.test(String(url)) || !res.body) return res;
            const [mine, theirs] = res.body.tee();
            w.__closeniStream("open");
            (async () => {
              const rd = mine.getReader();
              try { for (;;) { const r = await rd.read(); if (r.done) break; } }
              finally { w.__closeniStream("close"); }
            })();
            return new (w.Response)(theirs, res);
          } catch { return res; }
        };
      }

      // XHR needs no tee: the page reads the response itself and readyState
      // tells us the same two things a tee'd body would - it started, it
      // finished. Nothing is intercepted, so the page behaves identically.
      const X = w.XMLHttpRequest;
      if (X && X.prototype && X.prototype.open) {
        const open = X.prototype.open;
        const send = X.prototype.send;
        X.prototype.open = function (method: string, url: string, ...rest: any[]) {
          try { (this as any).__closeniUrl = String(url || ""); } catch { /* frozen */ }
          return open.apply(this, [method, url, ...rest] as any);
        };
        X.prototype.send = function (...args: any[]) {
          try {
            const url = (this as any).__closeniUrl || "";
            if (re.test(url)) {
              let opened = false;
              this.addEventListener("readystatechange", () => {
                // HEADERS_RECEIVED: the server has begun answering.
                if (!opened && this.readyState >= 2) { opened = true; w.__closeniStream("open"); }
              });
              // loadend covers load, error and abort, so a stream that fails
              // still closes and cannot leave the counter permanently unbalanced.
              this.addEventListener("loadend", () => {
                if (opened) w.__closeniStream("close");
              });
            }
          } catch { /* never break the page's own request */ }
          return send.apply(this, args as any);
        };
      }
    };

    try {
      if (!this.streamWatchInstalled) {
        await this.page.exposeBinding("__closeniStream", (_src: any, ev: string) => {
          if (ev === "open") this.streamsOpened++;
          else if (ev === "close") this.streamsClosed++;
        });
        // For any page loaded from here on.
        await this.page.addInitScript(tap, pattern);
        this.streamWatchInstalled = true;
      }
      // And for the document already open: addInitScript only runs on documents
      // loaded after it is added, so without this the tap is never installed on
      // the conversation the app is currently sitting in - which is every
      // conversation, because the watcher is armed when a prompt is sent. The
      // wrapper no-ops if it is already in place.
      await this.page.evaluate(tap, pattern);
    } catch {
      /* no stream watching; text stability still decides */
    }
  }

  async waitForLogin(timeoutMs: number = 120000): Promise<boolean> {
    if (!this.page) throw new Error("Browser not launched");
    // A login cannot happen in a window nobody can see, so a headless run gives
    // up quickly and names the fix instead of waiting out the full timeout.
    const effective = this.isHeaded ? timeoutMs : Math.min(timeoutMs, 15000);
    phase("connecting", "waiting for the composer");
    console.log("Waiting for chat input (" + Math.round(effective / 1000) + "s)...");
    try {
      await this.page.waitForSelector('textarea, div[contenteditable="true"]', { timeout: effective, state: "visible" });
      console.log("Chat input ready.");
      await this.applyControls();
      return true;
    } catch {
      console.log(this.isHeaded
        ? "No chat input appeared."
        : "No chat input appeared. If this provider needs a login, use Sign in first.");
      return false;
    }
  }

  async sendPrompt(prompt: string, config: ProviderConfig): Promise<void> {
    if (!this.page) throw new Error("Browser not launched");
    // Never type into a composer the provider has disabled because it is still
    // answering. The re-ask after a timeout used to fire immediately, so the
    // "reply" it then waited for was the tail of the previous answer rather
    // than the JSON it had just asked for.
    await this.waitUntilIdle(config);
    await this.watchReplyStream(config);
    // Per exchange: the counts answer "did a reply stream open and close since
    // this prompt", which is meaningless if earlier ones are still counted.
    this.streamsOpened = 0;
    this.streamsClosed = 0;
    phase("sending", prompt.length + " chars");
    console.log("Typing prompt into chat (length: " + prompt.length + ")...");
    let input;
    try {
      input = await this.page.waitForSelector(config.selectors.chatInput, { timeout: 15000, state: "visible" });
    } catch (e) {
      console.log("ERROR: Could not find chat input after 15 seconds");
      throw new Error("Chat input not found");
    }
    if (!input) throw new Error("Could not find chat input");
    await input.click();

    if (prompt.length > 5000) {
      console.log("Long prompt - setting the composer directly...");
      // Through the NATIVE value setter, not el.value.
      //
      // DeepSeek's composer is React-controlled, and React keeps its own copy of
      // the value. Assigning el.value updates the DOM but not that copy, so
      // React's tracker sees no change and swallows the input event: the text is
      // visible, React still believes the box is empty, the send control stays
      // disabled, and Enter does nothing.
      //
      // That is exactly what happened the first time a conversation rolled over
      // in a real build - a 6384-character seeded prompt went in, nothing was
      // sent, and the step sat at "messages=0" until its 300s timeout. The bug
      // was invisible until then because only a rollover produces a prompt long
      // enough to take this branch.
      await this.page.evaluate((text: string) => {
        const doc = (globalThis as any).document;
        const w = globalThis as any;
        const el = doc.querySelector('textarea, div[contenteditable="true"]');
        if (!el) return;
        if (el.tagName === "TEXTAREA") {
          const desc = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value");
          if (desc && desc.set) desc.set.call(el, text);
          else el.value = text;
        } else {
          el.textContent = text;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, prompt);
      await this.page.waitForTimeout(500);
    } else {
      await input.fill(prompt);
    }

    // Verify the composer actually holds the prompt before trying to send it.
    //
    // Defence that does not depend on knowing which framework the page uses: if
    // the text is not there, pressing Enter sends nothing and the step waits out
    // its whole timeout with no way to tell why. Playwright's fill() goes through
    // the browser's own input pipeline, so it is the fallback that works when a
    // hand-rolled write does not.
    const seen = await this.page.evaluate(() => {
      const doc = (globalThis as any).document;
      const el = doc.querySelector('textarea, div[contenteditable="true"]');
      if (!el) return -1;
      return (el.tagName === "TEXTAREA" ? el.value : el.textContent || "").length;
    });
    if (seen < Math.min(prompt.length, 40)) {
      console.log("The composer did not take the prompt (" + seen + " of " +
        prompt.length + " characters) - retyping it.");
      await input.fill(prompt);
      await this.page.waitForTimeout(500);
    }
    await this.page.waitForTimeout(1000);

    try {
      const sendBtn = await this.page.$(config.selectors.sendButton);
      if (sendBtn) {
        console.log("Clicking send button...");
        await sendBtn.click();
      } else {
        console.log("No send button found, pressing Enter...");
        await input.press("Enter");
      }
    } catch (e) {
      console.log("Send button click failed, pressing Enter: " + e);
      await input.press("Enter");
    }
    console.log("Prompt sent!");

    const currentUrl = this.page.url();
    if (currentUrl && currentUrl !== config.baseUrl && !currentUrl.endsWith("/")) {
      this.setChatUrlForWorkspace(this.workspace, currentUrl);
    } else {
      await sleep(2000);
      const updatedUrl = this.page.url();
      if (updatedUrl && updatedUrl !== config.baseUrl) {
        this.setChatUrlForWorkspace(this.workspace, updatedUrl);
      }
    }
  }

  /**
   * Block until the provider is not mid-answer, or the ceiling passes.
   *
   * Only meaningful for providers that expose a stop button; for the rest this
   * returns immediately and behaviour is unchanged.
   */
  private async waitUntilIdle(config: ProviderConfig, ceilingMs: number = MAX_GRACE_MS): Promise<void> {
    if (!this.page) return;
    if (!config.completionRules?.waitForStopButtonDisappear || !config.selectors.stopButton) return;
    if (!(await this.stopButtonVisible(config))) return;
    console.log("Provider is still answering - waiting for it to finish before sending.");
    const start = Date.now();
    while (Date.now() - start < ceilingMs) {
      await this.page.waitForTimeout(POLL_INTERVAL_MS);
      if (!(await this.stopButtonVisible(config))) {
        console.log("Provider idle after " + Math.round((Date.now() - start) / 1000) + "s - sending now.");
        return;
      }
    }
    console.log("Provider still busy after " + Math.round(ceilingMs / 1000) + "s - sending anyway.");
  }

  private async stopButtonVisible(config: ProviderConfig): Promise<boolean> {
    if (!this.page || !config.selectors.stopButton) return false;
    try {
      // isVisible, not count: a provider that hides its stop button with CSS
      // rather than removing it from the DOM would otherwise read as permanently
      // generating, and the signal would never fire.
      const loc = this.page.locator(config.selectors.stopButton).first();
      return (await loc.count()) > 0 && (await loc.isVisible());
    } catch {
      return false;
    }
  }

  private async assistantSelector(config: ProviderConfig): Promise<string> {
    if (this.pickedSelector) return this.pickedSelector;
    if (!this.page) return config.selectors.assistantMessage;
    const candidates = [config.selectors.assistantMessage].concat(FALLBACK_SELECTORS);
    for (const sel of candidates) {
      try {
        const n = await this.page.locator(sel).count();
        if (n > 0) { this.pickedSelector = sel; return sel; }
      } catch {}
    }
    return config.selectors.assistantMessage;
  }

  /**
   * How many nodes each configured selector matches, right now.
   *
   * Counting only - what the numbers mean is judged in selector-health, which
   * is a pure function and therefore testable without a browser.
   *
   * Every count is independently guarded. A selector with invalid CSS throws
   * inside Playwright, and one bad selector must not stop the probe from
   * reporting on the other six; a health check that dies on the first problem
   * is the least useful moment for it to die.
   */
  async probeSelectors(config: ProviderConfig): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    if (!this.page) return out;
    const sels: Record<string, string | undefined> = {
      chatInput: config.selectors.chatInput,
      sendButton: config.selectors.sendButton,
      assistantMessage: await this.assistantSelector(config).catch(() => config.selectors.assistantMessage),
      copyButton: config.selectors.copyButton,
      stopButton: config.selectors.stopButton,
    };
    for (const key of Object.keys(sels)) {
      const sel = sels[key];
      if (!sel) continue;
      try {
        out[key] = await this.page.locator(sel).count();
      } catch {
        // An unmatched selector and an invalid one both mean "found nothing
        // usable", which is what the caller acts on either way.
        out[key] = 0;
      }
    }
    return out;
  }

  /**
   * Point this controller at a page somebody else opened.
   *
   * A test seam, and the only one. It exists so the replay harness can run the
   * REAL extractors against recorded provider markup rather than a copy of them
   * - a copy would keep passing after the original broke, which is the mistake
   * the smoke test was built to avoid.
   *
   * Deliberately not the removed `attachTo`: that shared a browser context
   * between parallel build workers and went with the one-conversation decision.
   * This takes a page and does nothing else - no context, no thread, no
   * session state.
   */
  attachPageForReplay(page: Page): void {
    this.page = page;
    this.ownsContext = false;
  }

  async countMessages(config: ProviderConfig): Promise<number> {
    if (!this.page) return 0;
    try {
      const sel = await this.assistantSelector(config);
      return await this.page.locator(sel).count();
    } catch {
      return 0;
    }
  }

  async getLastMessageText(config: ProviderConfig): Promise<string> {
    if (!this.page) return "";
    try {
      const sel = await this.assistantSelector(config);
      const locs = await this.page.locator(sel).all();
      if (locs.length === 0) return "";
      return (await locs[locs.length - 1].textContent()) || "";
    } catch {
      return "";
    }
  }

  async getLastMessageInnerText(config: ProviderConfig): Promise<string> {
    if (!this.page) return "";
    try {
      const sel = await this.assistantSelector(config);
      const locs = await this.page.locator(sel).all();
      if (locs.length === 0) return "";
      return (await locs[locs.length - 1].innerText()) || "";
    } catch {
      return "";
    }
  }

  /**
   * What each poll of the wait loop saw.
   *
   * Optional, and used only by the smoke test. It exists so that test can watch
   * the REAL wait rather than a reimplementation of it - a copy would keep
   * passing after the original broke, which is the one thing a smoke test must
   * not do.
   */
  async waitForResponse(
    config: ProviderConfig,
    prevCount: number,
    prevContent: string,
    observe?: (tick: { messages: number; chars: number; stopVisible: boolean }) => void,
  ): Promise<string> {
    if (!this.page) throw new Error("Browser not launched");
    const maxWait = config.completionRules?.maxWaitMs || DEFAULT_MAX_WAIT_MS;
    console.log("Waiting for AI response (" + Math.round(maxWait / 1000) + "s timeout)...");
    const start = Date.now();
    await this.page.waitForTimeout(3000);

    let started = false;
    let lastText: string | null = null;
    let stableCount = 0;
    let waitingTicks = 0;
    let stopSeen = false;
    let stopGone = false;
    const useStopButton = !!(config.completionRules?.waitForStopButtonDisappear && config.selectors.stopButton);

    while (Date.now() - start < maxWait) {
      await this.page.waitForTimeout(POLL_INTERVAL_MS);
      const count = await this.countMessages(config);
      const text = await this.getLastMessageText(config);

      let stopVisibleNow = false;
      if (useStopButton) {
        const visible = await this.stopButtonVisible(config);
        stopVisibleNow = visible;
        if (visible) { stopSeen = true; stopGone = false; }
        else if (stopSeen) stopGone = true;
      }
      // Never allowed to break the wait: an observer that throws would turn a
      // diagnostic into the failure it was added to diagnose.
      if (observe) {
        try { observe({ messages: count, chars: (text || "").length, stopVisible: stopVisibleNow }); } catch {}
      }

      // A reply to a follow-up is usually SHORTER than the answer before it, so
      // "grew by 50 characters" never fires and the whole wait is spent thinking
      // about a reply that already arrived. Compare against the baseline text
      // instead: anything that is not still the previous message counts as new.
      const isNew = count > prevCount || (text.length > 0 && text !== prevContent);

      if (!started) {
        if (isNew) {
          phase("writing", "reply started");
          console.log("Response started!");
          started = true;
          lastText = text;
          stableCount = 0;
        } else {
          waitingTicks++;
          const elapsed = Math.round((Date.now() - start) / 1000);
          // Nothing moving at all is a broken watch, not a slow model.
          //
          // The picker caches the first selector that matches anything, and a
          // selector can match three real nodes while matching nothing that a
          // new reply is rendered into. When that happens the count and the
          // character total sit perfectly still - observed frozen at
          // "messages=3, chars=9019" for the whole 300s wait. Re-resolving lets
          // a later candidate take over instead of waiting out the clock.
          if (waitingTicks === FROZEN_TICKS && count === prevCount && text.length === prevContent.length) {
            console.log("Nothing has changed in " +
              Math.round((FROZEN_TICKS * POLL_INTERVAL_MS) / 1000) +
              "s - re-resolving which element holds the reply.");
            this.pickedSelector = null;
          }
          // The provider's own stop button is the difference between a model
          // that is composing and one that has not begun.
          phase(stopSeen && !stopGone ? "generating" : "thinking", elapsed + "s");
          if (waitingTicks % THINKING_LOG_EVERY_TICKS === 0) {
            // Say what is being watched, not just that we are waiting.
            //
            // "AI is thinking" for five minutes is indistinguishable from
            // detection that never fires, and the two need completely different
            // fixes. The selector in use and what it currently sees separate
            // them: a count that never moves and text that never changes means
            // we are watching the wrong node, not a slow model.
            const sel = await this.assistantSelector(config);
            console.log("AI is thinking... (" + elapsed + "s elapsed of " + Math.round(maxWait / 1000) + "s)" +
              " [watching " + JSON.stringify(sel.length > 60 ? sel.slice(0, 57) + "..." : sel) +
              ", messages=" + count + " (was " + prevCount + ")" +
              ", chars=" + text.length + (stopSeen ? ", stop button seen" : "") + "]");
          }
        }
        continue;
      }

      // Stability is judged on the text alone, deliberately not on `isNew`.
      //
      // isNew means "this differs from the message that was there before the
      // prompt". Once a reply has started that is the wrong question, and it
      // has one catastrophic answer: a re-ask usually makes the model resend
      // almost exactly what it sent last time, and DeepSeek renders its
      // messages in a ds-virtual-list, so countMessages does not reliably grow
      // either. Both halves of isNew then read false, stableCount never
      // increments, and a reply that finished in seconds is waited out for the
      // full five minutes. Observed twice in one run, on the re-ask after a
      // plan failed to parse.
      if (text === lastText) stableCount++;
      else { stableCount = 0; lastText = text; }
      phase("writing", text.length + " chars");

      // A closed stream means no more data is coming - but not necessarily that
      // the page has finished painting it. A provider that fetches a whole
      // reply and then renders it would be read mid-render, and truncating a
      // reply is worse than waiting a little longer for it. So the stream is
      // used to SHORTEN the stability window rather than to skip it: one quiet
      // tick instead of four. When the DOM is unreadable the text never changes
      // at all, so that tick passes immediately and the frozen-selector case
      // still ends in seconds rather than at the timeout.
      const streamDone = this.streamsOpened > 0 && this.streamsClosed >= this.streamsOpened;
      if (streamDone && stableCount >= 1) {
        console.log("Response complete (the page's reply stream closed)!");
        return await this.extractWithRetry(config);
      }

      if (isComplete({ started: started, stopSeen: stopSeen, stopGone: stopGone, stableTicks: stableCount }, useStopButton, STABLE_TICKS)) {
        console.log(useStopButton && stopSeen && stopGone
          ? "Response complete (stop button disappeared)!"
          : "Response complete (stable for " + (STABLE_TICKS * POLL_INTERVAL_MS) / 1000 + "s)!");
        return await this.extractWithRetry(config);
      }
    }

    // Hitting the ceiling is not the same as the model having stalled. When the
    // provider's own stop button is still on screen it is demonstrably still
    // writing, and extracting there yields a half-finished answer that fails to
    // parse - which then burns a retry re-asking for JSON the model was already
    // in the middle of producing. A 15-step build died exactly that way: 300s of
    // thinking, a partial extract, "No changes parsed", and every step blocked.
    //
    // So the ceiling becomes soft while the provider says it is busy, up to a
    // bounded grace period. A model that has genuinely hung shows no stop button
    // and still fails fast.
    if (useStopButton && await this.stopButtonVisible(config)) {
      const graceMs = Math.min(maxWait, MAX_GRACE_MS);
      console.log("Reached " + Math.round(maxWait / 1000) + "s but the model is still writing" +
        " - waiting up to " + Math.round(graceMs / 1000) + "s more.");
      const graceStart = Date.now();
      while (Date.now() - graceStart < graceMs) {
        await this.page.waitForTimeout(POLL_INTERVAL_MS);
        if (!(await this.stopButtonVisible(config))) {
          console.log("Response complete (finished during grace period)!");
          return await this.extractWithRetry(config);
        }
        const waited = Math.round((Date.now() - graceStart) / 1000);
        if (waited % 30 < POLL_INTERVAL_MS / 1000) {
          console.log("Still writing... (" + waited + "s into grace)");
        }
      }
      console.log("Still writing after the grace period - extracting what there is.");
    } else {
      console.log("Timeout after " + Math.round(maxWait / 1000) + "s - extracting partial response.");
    }
    return await this.extractWithRetry(config);
  }

  private async extractWithRetry(config: ProviderConfig): Promise<string> {
    phase("reading", "extracting the reply");
    let result = "";
    for (let i = 0; i < 5; i++) {
      result = await this.extractLatestResponse(config);
      if (result.trim().length > 1) return result;
      await sleep(1500);
    }
    return result;
  }

  /**
   * The code blocks as the provider itself would copy them.
   *
   * Reading <pre><code> out of the DOM is a guess about someone else's markup:
   * syntax highlighting shreds a line into spans, toolbars put "Copy Download"
   * inside the message, and a virtualised list can render only part of a long
   * block. The site's own Copy button has none of those problems - it is the
   * provider's answer to "what is the raw text of this block".
   *
   * Used to correct the DOM reading rather than replace it, because the
   * clipboard only ever holds code: the prose between blocks is what tells us
   * which file a block belongs to, and that still has to come from the page.
   *
   * Returns null whenever anything is off, so the caller keeps what it had.
   */
  /**
   * The code blocks of the last reply, read through the provider's own Copy
   * control. Public only so the smoke test can check that path directly; the
   * build path reaches it through extraction, where it corrects the DOM.
   */
  async readCodeViaCopy(config: ProviderConfig): Promise<string[] | null> {
    return this.copiedCodeBlocks(config);
  }

  private async copiedCodeBlocks(config: ProviderConfig): Promise<string[] | null> {
    const sel = config.selectors.copyButton;
    if (!this.page || !sel) return null;
    try {
      const assistant = await this.assistantSelector(config);
      const message = this.page.locator(assistant).last();
      // Text-filtered: the same markup renders Download beside Copy.
      const buttons = message.locator(sel).filter({ hasText: /^\s*copy\s*$/i });
      const n = await buttons.count();
      if (!n) return null;

      const out: string[] = [];
      for (let i = 0; i < n; i++) {
        const btn = buttons.nth(i);
        try { await btn.scrollIntoViewIfNeeded({ timeout: 2000 }); } catch { /* fine */ }
        await btn.click({ timeout: 3000 });
        await sleep(120);
        const text: string = await this.page.evaluate(
          () => (globalThis as any).navigator.clipboard.readText());
        if (typeof text !== "string" || !text.trim()) return null;
        out.push(text.replace(/\n$/, ""));
      }
      return out;
    } catch {
      return null;
    }
  }

  async extractLatestResponse(config: ProviderConfig): Promise<string> {
    if (!this.page) throw new Error("Browser not launched");
    try {
      const sel = await this.assistantSelector(config);
      const messageLocators = await this.page.locator(sel).all();
      if (messageLocators.length === 0) return "";
      const lastMessageLocator = messageLocators[messageLocators.length - 1];

      // Scope code blocks to the newest message. Querying the whole page would also
      // pick up earlier replies, so a re-ask would return the stale answer glued to
      // the new one and the parser would read the wrong JSON.
      // Blocks WITH the prose around them, in document order.
      //
      // This used to return the code blocks alone, concatenated and relabelled
      // as json - correct while JSON was the only accepted answer, since the
      // prose really was noise. It is wrong now that a reply may be one code
      // block per file: the path often lives in the sentence or heading above
      // the block, and dropping it means the file cannot be attributed to
      // anything and is silently skipped. A ten-step trial build lost three
      // files exactly that way.
      //
      // The language is kept on the fence too, because sites carry it as a
      // class on <code> and a path can ride there.
      const parts: string[] = await lastMessageLocator.evaluateAll((els: any[]) => {
        const root = els[els.length - 1];
        if (!root) return [];
        const out: string[] = [];
        const walk = (el: any): void => {
          const tag = String(el.tagName || "").toLowerCase();
          if (tag === "pre") {
            const code = el.querySelector("code") || el;
            const cls = String(code.getAttribute && code.getAttribute("class") || "");
            const lang = (cls.match(/language-([\w+#-]+)/) || [])[1] || "";
            const text = String(code.textContent || "").replace(/\n$/, "");
            if (text.trim()) out.push("```" + lang + "\n" + text + "\n```");
            return;
          }
          if (el.children && el.children.length) {
            for (const c of el.children) walk(c);
            return;
          }
          const t = String(el.textContent || "").trim();
          // "Copy Download" and friends are toolbar buttons, not content.
          if (t && !/^(?:[\w#+.-]+\s+)?(?:Copy\s+Download|Copy|Download)$/i.test(t)) out.push(t);
        };
        walk(root);
        return out;
      });

      // Upgrade the code with what the provider itself would copy, keeping the
      // prose the DOM gave us. Only when the counts agree - a mismatch means
      // the two views disagree about how many blocks there are, and guessing an
      // alignment would put one file's code under another file's heading.
      let blocks = parts.filter((t) => t.startsWith("\u0060\u0060\u0060"));
      if (blocks.length) {
        const copied = await this.copiedCodeBlocks(config);
        if (copied && copied.length === blocks.length) {
          let i = 0;
          for (let k = 0; k < parts.length; k++) {
            if (!parts[k].startsWith("\u0060\u0060\u0060")) continue;
            const lang = (parts[k].match(/^\u0060\u0060\u0060([^\n]*)/) || ["", ""])[1];
            parts[k] = "\u0060\u0060\u0060" + lang + "\n" + copied[i] + "\n\u0060\u0060\u0060";
            i++;
          }
          console.log("Read " + copied.length + " code block(s) from the provider's own Copy button.");
        }
      }

      const joined = (parts || []).join("\n\n").trim();
      if (joined) return joined;
      return (await lastMessageLocator.textContent()) || "";
    } catch {
      return "";
    }
  }

  async getLastMessageStructured(config: ProviderConfig): Promise<string> {
    if (!this.page) return "";
    const sel = await this.assistantSelector(config);
    try {
      return await this.page.evaluate(function (selector: string) {
        const doc = (globalThis as any).document;
        const nodes = doc.querySelectorAll(selector);
        if (nodes.length === 0) return "";
        const root = nodes[nodes.length - 1];
        function isJunk(t: string): boolean {
          return /^(?:[\w#+.-]+\s+)?(?:Copy\s+Download|Copy|Download)$/i.test(t);
        }
        function walk(el: any): string {
          const tag = (el.tagName || "").toLowerCase();
          if (tag === "pre") return "\n\`\`\`\n" + (el.textContent || "").replace(/\n$/, "") + "\n\`\`\`\n";
          if (/^h[1-6]$/.test(tag)) return "\n### " + (el.textContent || "").trim() + "\n";
          if (tag === "ul" || tag === "ol") { let o = "\n"; for (let i = 0; i < el.children.length; i++) o += walk(el.children[i]); return o; }
          if (tag === "li") return "- " + (el.textContent || "").trim() + "\n";
          if (tag === "p") { const t = (el.textContent || "").trim(); return (t && !isJunk(t)) ? t + "\n\n" : ""; }
          if (tag === "div" || tag === "section" || tag === "article" || tag === "table" || tag === "blockquote") {
            if (el.children.length === 0) { const t = (el.textContent || "").trim(); return (t && !isJunk(t)) ? t + "\n\n" : ""; }
            let o = ""; for (let i = 0; i < el.children.length; i++) o += walk(el.children[i]); return o;
          }
          const t = (el.textContent || "").trim();
          return (t && !isJunk(t)) ? t + " " : "";
        }
        let md = "";
        if (root.children.length === 0) md = root.innerText || root.textContent || "";
        else for (let i = 0; i < root.children.length; i++) md += walk(root.children[i]);
        return md.split("\n").filter(function (l: string) {
          const t = l.trim();
          return !/^(?:copy|download)$/i.test(t) && !/^(?:json|javascript|js|typescript|ts|python|py|bash|sh|shell|css|html|txt|text|plaintext)$/i.test(t);
        }).join("\n");
      }, sel);
    } catch {
      return "";
    }
  }

  async takeScreenshot(savePath: string): Promise<void> {
    if (this.page) {
      await this.page.screenshot({ path: savePath, fullPage: true });
      console.log("Screenshot saved: " + savePath);
    }
  }

  // The agent runs as a one-shot CLI process, so nothing survives to reuse this
  // context. Leaving it open keeps the Chromium child (and the persistent-profile
  // lock) alive, which blocks the next launch on the same profile.
  async close(): Promise<void> {
    if (!this.context) return;
    // A worker borrowed the launcher's context. Closing it would take the
    // browser out from under every other worker still mid-step.
    if (!this.ownsContext) {
      if (this.page) { await this.page.close().catch(() => {}); }
      this.page = null;
      this.context = null;
      this.pickedSelector = null;
      return;
    }
    try {
      await this.context.close();
    } catch (e) {
      console.log("Browser close failed: " + String(e));
    } finally {
      this.context = null;
      this.page = null;
      this.pickedSelector = null;
    }
  }
}
