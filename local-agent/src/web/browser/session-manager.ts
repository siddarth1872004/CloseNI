/**
 * Owns every browser, context and page the browser-native layer uses.
 *
 * The existing PlaywrightController launches one persistent context per CLI run
 * and does nothing when a page crashes, a dialog opens, a popup appears or a
 * download starts. Any of those, on a page nobody controls, can wedge a run
 * until its timeout. This class makes each of them an observed, recorded event.
 *
 * Isolation is the other job. Four kinds of context, never shared:
 *
 *   provider:<id>   persistent, one profile directory per provider. A login to
 *                   DeepSeek must never be visible to Qwen's page, and a research
 *                   fetch must never carry either.
 *   research        non-persistent. Fetches arbitrary web pages; holds no login
 *                   and keeps nothing after close.
 *   temporary / isolated   non-persistent, for tests and one-off work.
 *
 * Two persistent contexts on one directory is refused outright, because it would
 * share a login - the same rule storage-paths.ts enforces by keying profiles on
 * provider id.
 *
 * No launch argument here hides automation from the page. The old controller
 * passes --disable-blink-features=AutomationControlled; this layer does not,
 * because the brief for it rules out working around bot protection.
 */
import { chromium, Browser, BrowserContext, Page, Dialog, Download } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { Tracer, quietTracer } from "../trace.js";

export type ContextKind = "provider" | "research" | "temporary" | "isolated";

export interface ContextSpec {
  /** Unique name. "provider:deepseek", "research", "temp:abc". */
  key: string;
  kind: ContextKind;
  /** Required for kind "provider": where its login lives. */
  profileDir?: string;
  viewport?: { width: number; height: number };
  /** Grant clipboard access to this origin (for reading a provider's Copy button). */
  clipboardOrigin?: string;
  /** Downloads are cancelled unless this is set. A research fetch has no business saving files. */
  allowDownloads?: boolean;
  /** Close popups as they open instead of just recording them. */
  closePopups?: boolean;
  userAgent?: string;
}

export interface PopupRecord { url: string; at: string; closed: boolean }
export interface DialogRecord { type: string; message: string; at: string; action: "accepted" | "dismissed" }
export interface DownloadRecord { url: string; suggestedFilename: string; at: string; saved: boolean }

/** How a Playwright launch is obtained. Injectable so tests can fake a crash at launch. */
export interface Launcher {
  launch(opts: any): Promise<Browser>;
  launchPersistentContext(dir: string, opts: any): Promise<BrowserContext>;
}

export interface SessionManagerOptions {
  headless?: boolean;
  tracer?: Tracer;
  launcher?: Launcher;
  /** For environments whose Playwright build does not match the installed browser. */
  executablePath?: string;
  /** Upper bound on live pages per context; the oldest non-main page is closed beyond it. */
  maxPagesPerContext?: number;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 900 };

/** A page plus what happened to it. */
export class ManagedPage {
  crashed = false;
  closed = false;
  readonly consoleErrors: string[] = [];
  readonly failedRequests: Array<{ url: string; failure: string }> = [];
  readonly dialogs: DialogRecord[] = [];
  /** Set by whoever navigates, so diagnostics know where the page was meant to be. */
  intendedUrl = "";

  constructor(readonly name: string, readonly page: Page, private tracer: Tracer) {
    page.on("crash", () => {
      this.crashed = true;
      this.tracer.event({ action: "page-crash", result: "failure", page: name, url: safeUrl(page) });
    });
    page.on("close", () => { this.closed = true; });
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      pushCapped(this.consoleErrors, msg.text().slice(0, 300), 50);
    });
    page.on("pageerror", (err) => pushCapped(this.consoleErrors, "pageerror: " + String(err.message).slice(0, 300), 50));
    page.on("requestfailed", (req) => {
      pushCapped(this.failedRequests, { url: req.url().slice(0, 300), failure: String(req.failure()?.errorText || "failed") }, 50);
    });
    // A dialog blocks every later action on the page until it is handled. The
    // page is not ours to answer on the user's behalf, so dismiss - except a
    // beforeunload, where dismissing would trap us on the page.
    page.on("dialog", (d: Dialog) => {
      const type = d.type();
      const action: DialogRecord["action"] = type === "beforeunload" ? "accepted" : "dismissed";
      pushCapped(this.dialogs, { type, message: d.message().slice(0, 200), at: new Date().toISOString(), action }, 20);
      this.tracer.event({ action: "dialog", result: "info", page: name, detail: type + " " + action });
      (action === "accepted" ? d.accept() : d.dismiss()).catch(() => { /* already handled */ });
    });
  }

  /** Usable for another action without surprises. */
  healthy(): boolean {
    return !this.crashed && !this.closed && !this.page.isClosed();
  }
}

/** A context plus its pages and the side effects it produced. */
export class ManagedContext {
  readonly pages = new Map<string, ManagedPage>();
  readonly popups: PopupRecord[] = [];
  readonly downloads: DownloadRecord[] = [];
  closed = false;

  constructor(readonly spec: ContextSpec, readonly context: BrowserContext, private tracer: Tracer,
    private maxPages: number) {
    context.on("close", () => { this.closed = true; });
    context.on("page", (p: Page) => {
      // A page we did not create through page() is a popup or a target=_blank.
      // The event fires inside our own newPage() too, before page() has had a
      // chance to register the result - so decide a moment later, once our own
      // pages are registered. Deciding immediately closed every page we opened.
      setTimeout(() => {
        if (this.creatingPages > 0 && !p.isClosed() && !Array.from(this.pages.values()).some((mp) => mp.page === p)) {
          // Still inside a newPage() call: check again shortly.
          setTimeout(() => this.judgeNewPage(p), 250);
          return;
        }
        this.judgeNewPage(p);
      }, 50);
    });
  }

  alive(): boolean { return !this.closed; }

  private creatingPages = 0;

  private judgeNewPage(p: Page): void {
    if (p.isClosed()) return;
    if (Array.from(this.pages.values()).some((mp) => mp.page === p)) return;
    const rec: PopupRecord = { url: safeUrl(p), at: new Date().toISOString(), closed: false };
    pushCapped(this.popups, rec, 50);
    this.tracer.event({ action: "popup", result: "info", url: rec.url });
    if (this.spec.closePopups) {
      rec.closed = true;
      p.close().catch(() => { /* gone */ });
    }
  }

  /**
   * The named page, created on first use and recreated if it crashed or closed.
   * "main" is the page a provider chat lives on.
   */
  async page(name: string = "main"): Promise<ManagedPage> {
    if (this.closed) throw new Error("context " + this.spec.key + " is closed");
    const existing = this.pages.get(name);
    if (existing && existing.healthy()) return existing;
    if (existing) {
      this.tracer.event({ action: "page-recreate", result: "info", page: name,
        detail: existing.crashed ? "renderer crashed" : "page closed" });
      await existing.page.close().catch(() => { /* already gone */ });
      this.pages.delete(name);
    }
    // A persistent context opens with one blank page; adopt it for "main"
    // rather than leaving an orphan tab.
    let page: Page | undefined;
    if (name === "main") {
      page = this.context.pages().find((p) => !Array.from(this.pages.values()).some((mp) => mp.page === p) && p.url() === "about:blank");
    }
    if (!page) {
      this.creatingPages++;
      try { page = await this.context.newPage(); } finally { this.creatingPages--; }
    }
    const mp = new ManagedPage(name, page, this.tracer.child({ page: name }));
    page.on("download", (dl: Download) => this.onDownload(dl));
    this.pages.set(name, mp);
    this.enforcePageCap();
    return mp;
  }

  /**
   * A page of its own for one operation, closed by the caller. Parallel
   * searches and fetches must never share a page: two navigations on one page
   * abort each other.
   */
  private seq = 0;
  async scratchPage(prefix: string): Promise<ManagedPage> {
    return this.page(prefix + "-" + (++this.seq));
  }

  async closePage(name: string): Promise<void> {
    const mp = this.pages.get(name);
    if (!mp) return;
    this.pages.delete(name);
    await mp.page.close().catch(() => { /* gone */ });
  }

  private enforcePageCap(): void {
    if (this.pages.size <= this.maxPages) return;
    for (const [name, mp] of this.pages) {
      if (name === "main") continue;
      this.pages.delete(name);
      mp.page.close().catch(() => { /* gone */ });
      this.tracer.event({ action: "page-evict", result: "info", page: name });
      if (this.pages.size <= this.maxPages) return;
    }
  }

  private onDownload(dl: Download): void {
    const rec: DownloadRecord = { url: dl.url().slice(0, 300), suggestedFilename: dl.suggestedFilename(), at: new Date().toISOString(), saved: false };
    pushCapped(this.downloads, rec, 50);
    this.tracer.event({ action: "download", result: "info", url: rec.url, detail: rec.suggestedFilename });
    if (!this.spec.allowDownloads) dl.cancel().catch(() => { /* finished already */ });
  }
}

export class BrowserSessionManager {
  private browser: Browser | null = null;
  private browserLaunching: Promise<Browser> | null = null;
  private contexts = new Map<string, ManagedContext>();
  private creating = new Map<string, Promise<ManagedContext>>();
  private readonly tracer: Tracer;
  private readonly launcher: Launcher;
  private launches = 0;

  constructor(private opts: SessionManagerOptions = {}) {
    this.tracer = opts.tracer || quietTracer();
    this.launcher = opts.launcher || (chromium as unknown as Launcher);
  }

  /** How many real browser launches happened - reuse is a performance property worth asserting. */
  stats(): { launches: number; contexts: string[]; browserConnected: boolean } {
    return {
      launches: this.launches,
      contexts: Array.from(this.contexts.keys()),
      browserConnected: !!(this.browser && this.browser.isConnected()),
    };
  }

  private launchOptions(): any {
    const o: any = { headless: this.opts.headless !== false };
    if (this.opts.executablePath) o.executablePath = this.opts.executablePath;
    return o;
  }

  /** The shared non-persistent browser, relaunched if it died. */
  private async sharedBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (this.browserLaunching) return this.browserLaunching;
    this.browserLaunching = this.tracer.span("browser-launch", {}, async () => {
      const b = await this.launcher.launch(this.launchOptions());
      this.launches++;
      b.on("disconnected", () => {
        this.tracer.event({ action: "browser-disconnected", result: "failure" });
        // Every non-persistent context died with it.
        for (const [key, mc] of this.contexts) if (mc.spec.kind !== "provider") { mc.closed = true; this.contexts.delete(key); }
      });
      return b;
    });
    try {
      this.browser = await this.browserLaunching;
      return this.browser;
    } finally {
      this.browserLaunching = null;
    }
  }

  /**
   * The context for this spec - reused while alive, relaunched when not.
   *
   * Reuse is the default because a Chromium launch costs a second or more; a
   * dead context is replaced rather than reported, because the caller wanted a
   * working one and the crash is already in the trace.
   */
  async context(spec: ContextSpec): Promise<ManagedContext> {
    const existing = this.contexts.get(spec.key);
    if (existing && existing.alive()) return existing;
    if (existing) this.contexts.delete(spec.key);
    // Concurrent callers asking for the same key share one creation. Without
    // this, three parallel searches each launched a context for "research" and
    // the later ones replaced - and orphaned - the first mid-navigation.
    const pending = this.creating.get(spec.key);
    if (pending) return pending;
    const p = this.createContext(spec);
    this.creating.set(spec.key, p);
    try { return await p; } finally { this.creating.delete(spec.key); }
  }

  private async createContext(spec: ContextSpec): Promise<ManagedContext> {

    if (spec.kind === "provider") {
      if (!spec.profileDir) throw new Error("provider context " + spec.key + " needs a profileDir");
      const dir = path.resolve(spec.profileDir);
      for (const mc of this.contexts.values()) {
        if (mc.spec.profileDir && path.resolve(mc.spec.profileDir) === dir && mc.alive()) {
          throw new Error("profile " + dir + " is already open as " + mc.spec.key + " - two contexts on one profile would share a login");
        }
      }
      fs.mkdirSync(dir, { recursive: true });
    }

    const ctx = await this.tracer.span("context-create", { detail: spec.key + " (" + spec.kind + ")" }, async () => {
      const common: any = { viewport: spec.viewport || DEFAULT_VIEWPORT, acceptDownloads: !!spec.allowDownloads };
      if (spec.userAgent) common.userAgent = spec.userAgent;
      if (spec.kind === "provider") {
        const c = await this.launcher.launchPersistentContext(path.resolve(spec.profileDir as string),
          { ...this.launchOptions(), ...common });
        this.launches++;
        return c;
      }
      const b = await this.sharedBrowser();
      return b.newContext(common);
    });

    if (spec.clipboardOrigin) {
      try {
        await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: spec.clipboardOrigin });
      } catch { /* not every browser/origin accepts it; reading the DOM still works */ }
    }
    const mc = new ManagedContext(spec, ctx, this.tracer.child({ page: spec.key }), this.opts.maxPagesPerContext || 6);
    this.contexts.set(spec.key, mc);
    return mc;
  }

  get(key: string): ManagedContext | undefined {
    const mc = this.contexts.get(key);
    return mc && mc.alive() ? mc : undefined;
  }

  async closeContext(key: string): Promise<void> {
    const mc = this.contexts.get(key);
    if (!mc) return;
    this.contexts.delete(key);
    // Bounded: closing a context whose browser crashed can wait forever.
    await withTimeout(mc.context.close(), 5000).catch(() => { /* already closed or wedged */ });
  }

  async closeAll(): Promise<void> {
    for (const key of Array.from(this.contexts.keys())) await this.closeContext(key);
    if (this.browser) {
      const b = this.browser;
      this.browser = null;
      await withTimeout(b.close(), 5000).catch(() => {
        const proc = (b as any).process ? (b as any).process() : null;
        if (proc && proc.kill) proc.kill("SIGKILL");
      });
    }
  }

  /** Test seam for chaos tests: kill the shared browser as if it crashed. */
  async killSharedBrowserForTest(): Promise<void> {
    if (!this.browser) return;
    const proc = (this.browser as any).process ? (this.browser as any).process() : null;
    if (proc && proc.kill) proc.kill("SIGKILL");
    else await this.browser.close();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out after " + ms + "ms")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function pushCapped<T>(arr: T[], v: T, cap: number): void {
  arr.push(v);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

function safeUrl(p: Page): string {
  try { return p.url(); } catch { return ""; }
}
