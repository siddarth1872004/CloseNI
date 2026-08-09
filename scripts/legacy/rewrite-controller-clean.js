const fs = require("fs");
const path = require("path");

console.log("\n=== CLEAN REWRITE OF CONTROLLER ===\n");

const cPath = path.join(__dirname, "local-agent", "src", "providers", "playwright-controller.ts");

const content = String.raw`import { chromium, BrowserContext, Page } from "playwright";
import * as path from "path";
import * as fs from "fs";

export interface ProviderConfig {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  requiresLogin: boolean;
  enabled: boolean;
  selectors: {
    chatInput: string;
    sendButton: string;
    stopButton: string;
    assistantMessage: string;
    codeBlock: string;
    copyButton: string;
  };
  completionRules: {
    waitForStopButtonDisappear: boolean;
    waitForCopyButton: boolean;
    stableMs: number;
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

export class PlaywrightController {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private pickedSelector: string | null = null;
  private sessionStoreFile: string = "";
  private workspace: string = "";
  private isHeaded: boolean = false;

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
    try {
      if (!this.sessionStoreFile || !fs.existsSync(this.sessionStoreFile)) return {};
      return JSON.parse(fs.readFileSync(this.sessionStoreFile, "utf-8"));
    } catch (e) {
      return {};
    }
  }

  private saveSessions(sessions: any) {
    try {
      if (!this.sessionStoreFile) return;
      const dir = path.dirname(this.sessionStoreFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.sessionStoreFile, JSON.stringify(sessions, null, 2), "utf-8");
    } catch (e) {}
  }

  getChatUrlForWorkspace(workspace: string): string | null {
    if (!workspace) return null;
    const sessions = this.loadSessions();
    return sessions[workspace]?.activeChat || null;
  }

  setChatUrlForWorkspace(workspace: string, url: string, title?: string) {
    if (!workspace) return;
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
    console.log("Waiting for AI response (120s timeout)...");
    const maxWait = 120000;
    const start = Date.now();
    await this.page.waitForTimeout(3000);

    let started = false;
    let lastLength = prevContent.length;
    let stableCount = 0;

    while (Date.now() - start < maxWait) {
      await this.page.waitForTimeout(2000);
      const count = await this.countMessages(config);
      const text = await this.getLastMessageText(config);
      const currentLength = text.length;

      if (!started) {
        if (count > prevCount || currentLength > lastLength + 50) {
          console.log("Response started!");
          started = true;
          lastLength = currentLength;
          stableCount = 0;
        } else {
          const elapsed = Math.round((Date.now() - start) / 1000);
          if (elapsed % 10 === 0) console.log("AI is thinking... (" + elapsed + "s elapsed, complex planning takes 30-60s)");
        }
        continue;
      }

      if (currentLength === lastLength) {
        stableCount++;
        if (stableCount >= 4) {
          console.log("Response complete (stable for 8s)!");
          return await this.extractWithRetry(config);
        }
      } else {
        stableCount = 0;
        lastLength = currentLength;
      }
    }

    console.log("Timeout after 120s - extracting partial response.");
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
      const codeBlocks = await this.page.locator("pre code").evaluateAll((els) => els.map((el) => el.textContent || ""));
      if (codeBlocks && codeBlocks.length > 0) {
        return codeBlocks.map((block) => FENCE + "json\n" + block + "\n" + FENCE).join("\n\n");
      }
      const sel = await this.assistantSelector(config);
      const messageLocators = await this.page.locator(sel).all();
      if (messageLocators.length === 0) return "";
      const lastMessageLocator = messageLocators[messageLocators.length - 1];
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

  async close(): Promise<void> {
    console.log("Browser kept alive for next request");
  }
}
`;

fs.writeFileSync(cPath, content, "utf-8");
console.log("  OK controller (clean rewrite)");
console.log("\nDone. Rebuild + launch.\n");
