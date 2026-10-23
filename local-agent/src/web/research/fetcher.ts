/**
 * Fetch a page and turn it into a WebPage, as cheaply as the page allows.
 *
 *   http     one GET, parsed with parseHtml. Enough for static documentation.
 *   browser  the isolated research context (no login, no shared cookies, popups
 *            closed, downloads cancelled): navigate, wait until the content stops
 *            changing, scroll a bounded number of times for lazy-loaded content,
 *            snapshot.
 *   auto     http first; escalate to the browser when the result looks like an
 *            app shell - almost no text, a <noscript> warning, an empty root.
 *
 * Per-domain politeness spaces requests to one host. Failures are classified
 * (blocked/dns/timeout/http) so the research loop can skip URLs that cannot
 * succeed instead of retrying them.
 */
import * as http from "http";
import * as https from "https";
import { parseHtml, snapshot } from "../semantic/dom.js";
import { buildWebPage } from "./page.js";
import { RepeatedBlocks } from "./content.js";
import { canonicalizeUrl, domainOf } from "./url.js";
import { WebPage } from "./types.js";
import { BrowserSessionManager, ManagedPage } from "../browser/session-manager.js";
import { navigate, classifyNavError, NavErrorKind } from "../browser/navigate.js";
import { TtlCache } from "./cache.js";
import { Tracer, quietTracer } from "../trace.js";
import { nowMs, sleep } from "../util.js";

export type FetchMode = "http" | "browser" | "auto";

export interface FetchOutcome {
  ok: boolean;
  url: string;
  page?: WebPage;
  mode: "http" | "browser" | "cache";
  status?: number;
  errorKind?: NavErrorKind | "not-html" | "too-large" | "empty";
  error?: string;
  durationMs: number;
  escalated?: boolean;
}

export interface FetcherOptions {
  mode?: FetchMode;
  sessions?: BrowserSessionManager;
  tracer?: Tracer;
  cache?: TtlCache<WebPage>;
  timeoutMs?: number;
  /** Minimum gap between two requests to one domain. */
  politenessMs?: number;
  maxBytes?: number;
  /** Scrolls for lazy/infinite content in browser mode. */
  maxScrolls?: number;
  userAgent?: string;
  repeated?: RepeatedBlocks;
}

const UA = "Mozilla/5.0 (X11; Linux x86_64) CloseNI-research/0.1 (+https://github.com/siddarth1872004/CloseNI)";

export function looksLikeAppShell(page: WebPage, html: string): boolean {
  if (page.main_text.length >= 400) return false;
  return /<noscript[\s>]/i.test(html) || /<div id="(root|app|__next)">\s*<\/div>/i.test(html) || page.main_text.length < 120;
}

export class WebFetcher {
  private lastHit = new Map<string, number>();
  private readonly tracer: Tracer;
  private fetchCount = 0;

  constructor(private opts: FetcherOptions = {}) {
    this.tracer = opts.tracer || quietTracer();
  }

  stats(): { fetches: number } { return { fetches: this.fetchCount }; }

  private async polite(url: string): Promise<void> {
    const d = domainOf(url);
    const gap = this.opts.politenessMs ?? 400;
    const last = this.lastHit.get(d) || 0;
    const wait = last + gap - nowMs();
    if (wait > 0) await sleep(wait);
    this.lastHit.set(d, nowMs());
  }

  async fetch(url: string, mode: FetchMode = this.opts.mode || "auto"): Promise<FetchOutcome> {
    const key = canonicalizeUrl(url);
    const cached = this.opts.cache ? this.opts.cache.get(key) : undefined;
    if (cached) {
      this.tracer.event({ action: "fetch", result: "success", url, detail: "cache" });
      return { ok: true, url, page: { ...cached, fetch: { ...cached.fetch, mode: "cache" } }, mode: "cache", durationMs: 0 };
    }
    await this.polite(url);
    this.fetchCount++;
    let out: FetchOutcome;
    if (mode === "browser") out = await this.viaBrowser(url);
    else {
      out = await this.viaHttp(url);
      if (mode === "auto" && this.opts.sessions && (
        (out.ok && out.page && looksLikeAppShell(out.page, (out as any).__html || "")) ||
        (!out.ok && (out.errorKind === "empty" || (out.status && out.status === 403))))) {
        const b = await this.viaBrowser(url);
        if (b.ok) { b.escalated = true; out = b; }
      }
    }
    delete (out as any).__html;
    if (out.ok && out.page && this.opts.cache) this.opts.cache.set(key, out.page);
    this.tracer.event({ action: "fetch", result: out.ok ? "success" : "failure", url, durationMs: out.durationMs,
      detail: out.mode + (out.escalated ? " (escalated from http)" : "") + (out.page ? " main=" + out.page.main_text.length + "ch" : ""), error: out.error });
    return out;
  }

  private viaHttp(url: string, redirects: number = 5): Promise<FetchOutcome> {
    const t0 = nowMs();
    const maxBytes = this.opts.maxBytes ?? 3_000_000;
    return new Promise((resolve) => {
      let u: URL;
      try { u = new URL(url); } catch { resolve({ ok: false, url, mode: "http", errorKind: "unknown", error: "bad URL", durationMs: 0 }); return; }
      const lib = u.protocol === "https:" ? https : http;
      const req = lib.get(u, { headers: { "User-Agent": this.opts.userAgent || UA, Accept: "text/html,application/xhtml+xml" }, timeout: this.opts.timeoutMs ?? 15000 }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, u).toString();
          this.viaHttp(next, redirects - 1).then((r) => resolve({ ...r, durationMs: nowMs() - t0 }));
          return;
        }
        const type = String(res.headers["content-type"] || "");
        if (status >= 400) { res.resume(); resolve({ ok: false, url, mode: "http", status, errorKind: "http", error: "HTTP " + status, durationMs: nowMs() - t0 }); return; }
        if (type && !/html|xml/i.test(type)) { res.resume(); resolve({ ok: false, url, mode: "http", status, errorKind: "not-html", error: type, durationMs: nowMs() - t0 }); return; }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => { body += d; if (body.length > maxBytes) req.destroy(new Error("too-large")); });
        res.on("end", () => {
          if (!body.trim()) { resolve({ ok: false, url, mode: "http", status, errorKind: "empty", error: "empty body", durationMs: nowMs() - t0 }); return; }
          const snap = parseHtml(body, url);
          const page = buildWebPage(snap, { finalUrl: url, repeated: this.opts.repeated, fetch: { mode: "http", status, durationMs: nowMs() - t0, representation: 4 } });
          const out: any = { ok: true, url, page, mode: "http", status, durationMs: nowMs() - t0 };
          out.__html = body.slice(0, 20000);
          resolve(out);
        });
      });
      req.on("timeout", () => req.destroy(new Error("Timeout " + (this.opts.timeoutMs ?? 15000) + "ms exceeded")));
      req.on("error", (e: any) => {
        const msg = String(e && e.message || e);
        const kind: FetchOutcome["errorKind"] = msg === "too-large" ? "too-large" : /ENOTFOUND|EAI_AGAIN/.test(msg) ? "dns" : /ECONNREFUSED|ECONNRESET/.test(msg) ? "refused" : classifyNavError(msg);
        resolve({ ok: false, url, mode: "http", errorKind: kind, error: msg, durationMs: nowMs() - t0 });
      });
    });
  }

  private async viaBrowser(url: string): Promise<FetchOutcome> {
    const t0 = nowMs();
    if (!this.opts.sessions) return { ok: false, url, mode: "browser", errorKind: "unknown", error: "no browser session manager", durationMs: 0 };
    const ctx = await this.opts.sessions.context({ key: "research", kind: "research", closePopups: true });
    const mp = await ctx.scratchPage("fetch");
    try {
      return await this.readInBrowser(mp, url, t0);
    } finally {
      await ctx.closePage(mp.name);
    }
  }

  private async readInBrowser(mp: ManagedPage, url: string, t0: number): Promise<FetchOutcome> {
    const nav = await navigate(mp, url, { tracer: this.tracer, timeoutMs: this.opts.timeoutMs ?? 20000, retries: 1 });
    if (!nav.ok) return { ok: false, url, mode: "browser", status: nav.status, errorKind: nav.errorKind, error: nav.error, durationMs: nowMs() - t0 };
    try {
      // Content stops changing: two equal text lengths 300ms apart, up to 5s.
      let prev = -1;
      for (let i = 0; i < 16; i++) {
        const len: number = await mp.page.evaluate(() => { const b = (globalThis as any).document.body; return b ? String(b.innerText || "").length : 0; });
        if (len > 0 && len === prev) break;
        prev = len;
        await sleep(300);
      }
      // Lazy and infinite content: scroll while the page grows, bounded.
      const maxScrolls = this.opts.maxScrolls ?? 3;
      for (let i = 0; i < maxScrolls; i++) {
        const grew: boolean = await mp.page.evaluate(async () => {
          const w: any = globalThis as any;
          const h0 = w.document.body.scrollHeight;
          w.scrollTo(0, h0);
          await new Promise((r) => setTimeout(r, 400));
          return w.document.body.scrollHeight > h0;
        });
        if (!grew) break;
      }
      const snap = await snapshot(mp.page);
      const page = buildWebPage(snap, { finalUrl: nav.finalUrl, repeated: this.opts.repeated, fetch: { mode: "browser", status: nav.status, durationMs: nowMs() - t0, representation: 4 } });
      return { ok: true, url, page, mode: "browser", status: nav.status, durationMs: nowMs() - t0 };
    } catch (err: any) {
      const msg = String(err && err.message || err);
      return { ok: false, url, mode: "browser", errorKind: classifyNavError(msg), error: msg.split("\n")[0], durationMs: nowMs() - t0 };
    }
  }
}
