import { chromium, BrowserContext, Page } from "playwright";
import * as path from "path";
import * as fs from "fs";
import { readSessions, writeSessions, getBuildThread, setBuildThread, resetBuildRun, getBuildLedger, setBuildLedger, BuildLedger } from "../session-store.js";
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
    assistantMessage: string;
  };
  completionRules: {
    waitForStopButtonDisappear: boolean;
    maxWaitMs: number;
  };
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

/** Ceiling on the soft extension given to a model that is still writing. */
const MAX_GRACE_MS = 180000;

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
  private threadKind: "chat" | "build" | "worker" = "chat";
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

  setThreadKind(kind: "chat" | "build" | "worker") {
    this.threadKind = kind;
  }

  getBuildThreadUrl(): string | null {
    return getBuildThread(this.sessionStoreFile, this.workspace);
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

  setChatUrlForWorkspace(workspace: string, url: string, title?: string) {
    if (!workspace) return;
    // A worker's thread is transient by design: recording it would clobber the
    // main build thread that a resume depends on.
    if (this.threadKind === "worker") return;
    if (this.threadKind === "build") {
      setBuildThread(this.sessionStoreFile, workspace, url);
      return;
    }
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
    this.launchedConfig = config;
  }

  /** The context this controller launched, for workers to attach to. */
  getContext(): BrowserContext | null {
    return this.context;
  }

  /**
   * Open another page in an existing context.
   *
   * This is how concurrency happens: one launchPersistentContext, several
   * pages. Chromium locks a profile directory, so a second launch on the same
   * profile would collide - but a second page in the same context is exactly
   * what a person with two tabs open is doing.
   *
   * The context is not owned here: close() shuts only this controller's page,
   * so one worker finishing does not take the browser out from under the rest.
   */
  async attachTo(context: BrowserContext, config: ProviderConfig): Promise<void> {
    this.context = context;
    this.ownsContext = false;
    this.page = await context.newPage();
    this.launchedConfig = config;
  }

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
      console.log("Resuming session chat: " + savedUrl);
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

  /**
   * Resume this workspace's build thread. Returns false (and lands on a fresh
   * chat) when there is nothing to resume or the saved thread will not load.
   */
  async navigateToBuildThread(config: ProviderConfig): Promise<boolean> {
    if (!this.page) throw new Error("Browser not launched");
    const saved = this.getBuildThreadUrl();
    if (!saved) {
      await this.navigateFresh(config);
      return false;
    }
    console.log("Resuming build thread: " + saved);
    try {
      await this.page.goto(saved, { waitUntil: "domcontentloaded", timeout: 30000 });
      await this.page.waitForSelector(config.selectors.chatInput, { timeout: 5000, state: "visible" });
      return true;
    } catch {
      console.log("Build thread would not load; starting a fresh one.");
      await this.navigateFresh(config);
      return false;
    }
  }

  async navigateFresh(config: ProviderConfig): Promise<void> {
    if (!this.page) throw new Error("Browser not launched");
    console.log("Starting fresh chat (no saved thread)...");
    await this.page.goto(config.baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  }

  async waitForLogin(timeoutMs: number = 120000): Promise<boolean> {
    if (!this.page) throw new Error("Browser not launched");
    // A login cannot happen in a window nobody can see, so a headless run gives
    // up quickly and names the fix instead of waiting out the full timeout.
    const effective = this.isHeaded ? timeoutMs : Math.min(timeoutMs, 15000);
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
      console.log("Using clipboard paste for long prompt...");
      await this.page.evaluate(async (text: string) => {
        const doc = (globalThis as any).document;
        const el = doc.querySelector('textarea, div[contenteditable="true"]');
        if (el) {
          if (el.tagName === "TEXTAREA") el.value = text;
          else el.textContent = text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, prompt);
      await this.page.waitForTimeout(500);
    } else {
      await input.fill(prompt);
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

  async waitForResponse(config: ProviderConfig, prevCount: number, prevContent: string): Promise<string> {
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

      if (useStopButton) {
        const visible = await this.stopButtonVisible(config);
        if (visible) { stopSeen = true; stopGone = false; }
        else if (stopSeen) stopGone = true;
      }

      // A reply to a follow-up is usually SHORTER than the answer before it, so
      // "grew by 50 characters" never fires and the whole wait is spent thinking
      // about a reply that already arrived. Compare against the baseline text
      // instead: anything that is not still the previous message counts as new.
      const isNew = count > prevCount || (text.length > 0 && text !== prevContent);

      if (!started) {
        if (isNew) {
          console.log("Response started!");
          started = true;
          lastText = text;
          stableCount = 0;
        } else {
          waitingTicks++;
          if (waitingTicks % THINKING_LOG_EVERY_TICKS === 0) {
            const elapsed = Math.round((Date.now() - start) / 1000);
            console.log("AI is thinking... (" + elapsed + "s elapsed of " + Math.round(maxWait / 1000) + "s)");
          }
        }
        continue;
      }

      if (text === lastText && isNew) stableCount++;
      else { stableCount = 0; lastText = text; }

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
    let result = "";
    for (let i = 0; i < 5; i++) {
      result = await this.extractLatestResponse(config);
      if (result.trim().length > 1) return result;
      await sleep(1500);
    }
    return result;
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
      const codeBlocks = await lastMessageLocator
        .locator("pre code")
        .evaluateAll((els) => els.map((el) => el.textContent || ""));
      const nonEmpty = (codeBlocks || []).filter((b) => b.trim().length > 0);
      if (nonEmpty.length > 0) {
        return nonEmpty.map((block) => FENCE + "json\n" + block + "\n" + FENCE).join("\n\n");
      }
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
