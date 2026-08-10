import { chromium, BrowserContext, Page } from "playwright";
import * as path from "path";
import * as fs from "fs";
import { readSessions, writeSessions, getBuildThread, setBuildThread, resetBuildRun, getBuildLedger, setBuildLedger, BuildLedger } from "../session-store.js";
import { isComplete } from "./completion.js";

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
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

export class PlaywrightController {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private pickedSelector: string | null = null;
  private sessionStoreFile: string = "";
  private workspace: string = "";
  private isHeaded: boolean = false;
  // Build steps share a thread that is tracked separately from the Chat/Plan
  // thread, so the two never overwrite each other in sessions.json.
  private threadKind: "chat" | "build" = "chat";

  constructor(config: ProviderConfig) {
    const storageDir = path.join(config.profileDir, "..", "..");
    if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
    this.sessionStoreFile = path.join(storageDir, "sessions.json");
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

  setThreadKind(kind: "chat" | "build") {
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

  getChatUrlForWorkspace(workspace: string): string | null {
    if (!workspace) return null;
    const sessions = this.loadSessions();
    return sessions[workspace]?.activeChat || null;
  }

  setChatUrlForWorkspace(workspace: string, url: string, title?: string) {
    if (!workspace) return;
    if (this.threadKind === "build") {
      setBuildThread(this.sessionStoreFile, workspace, url);
      return;
    }
    const sessions = this.loadSessions();
    if (!sessions[workspace]) sessions[workspace] = { chats: [], activeChat: null };
    sessions[workspace].activeChat = url;
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
    const profilePath = path.resolve(config.profileDir);
    if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true });
    const isHeadless = !this.isHeaded;
    console.log("Launching browser (" + (isHeadless ? "headless" : "HEADED - watch me!") + ") for " + config.name + "...");
    this.context = await chromium.launchPersistentContext(profilePath, {
      headless: isHeadless,
      viewport: { width: 1280, height: 900 },
      args: ["--disable-blink-features=AutomationControlled"],
    });
    this.page = this.context.pages()[0] || (await this.context.newPage());
  }

  async navigateToChat(config: ProviderConfig): Promise<void> {
    if (!this.page) throw new Error("Browser not launched");
    const savedUrl = this.getChatUrlForWorkspace(this.workspace);
    if (savedUrl) {
      console.log("Resuming session chat: " + savedUrl);
      await this.page.goto(savedUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      try {
        await this.page.waitForSelector(config.selectors.chatInput, { timeout: 5000, state: "visible" });
        console.log("Session chat loaded successfully");
        return;
      } catch {
        console.log("Session chat URL invalid, starting new chat...");
      }
    }
    console.log("Starting new chat for workspace: " + this.workspace);
    await this.page.goto(config.baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
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
    console.log("Waiting for manual login...");
    try {
      await this.page.waitForSelector('textarea, div[contenteditable="true"]', { timeout: timeoutMs, state: "visible" });
      console.log("Login detected!");
      return true;
    } catch {
      console.log("Login timeout. Continuing anyway...");
      return false;
    }
  }

  async sendPrompt(prompt: string, config: ProviderConfig): Promise<void> {
    if (!this.page) throw new Error("Browser not launched");
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

    console.log("Timeout after " + Math.round(maxWait / 1000) + "s - extracting partial response.");
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
