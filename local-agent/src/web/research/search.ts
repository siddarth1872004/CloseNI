/**
 * Search, as modular backends producing one normalised SearchResult shape.
 *
 *   BrowserSearchBackend   a results page read in the isolated research context,
 *                          described by an engine adapter (URL template + result
 *                          selector chains). Engines are data, like providers.
 *   GitHubSearchBackend    the REST search API - reachable, documented, and the
 *                          one search source this project already uses.
 *   AIWebSearchBackend     an AI website with its own web search turned on; the
 *                          URLs it cites become results. The answer itself is
 *                          NOT evidence - only the pages it points at are, once
 *                          fetched - so the research never cites a model's claim
 *                          about what a page says.
 *
 * A results page that turns out to be a challenge or a login is reported as
 * "blocked", not retried and not worked around.
 *
 * Engine selectors other than the local fixture's are UNVERIFIED: no search
 * engine was reachable from the machine this was written on.
 */
import * as https from "https";
import { SearchQuery, SearchResult, SearchStrategy } from "./types.js";
import { canonicalizeUrl, domainOf, sourceTypeOf } from "./url.js";
import { BrowserSessionManager, ManagedPage } from "../browser/session-manager.js";
import { navigate } from "../browser/navigate.js";
import { ChainSpec, Provenance, resolveChain } from "../selectors/chain.js";
import { collectSignalsInPage, LOGIN_TEXT } from "../providers/state.js";
import { AIWebProvider } from "../providers/ai-web-provider.js";
import { groupDuplicates } from "./dedupe.js";
import { Tracer, quietTracer } from "../trace.js";
import { tokens } from "../util.js";

export interface SearchOutcome {
  backend: string;
  query: SearchQuery;
  results: SearchResult[];
  status: "ok" | "empty" | "blocked" | "error" | "unsupported";
  detail?: string;
  durationMs: number;
}

export interface SearchBackend {
  readonly id: string;
  supports(strategy: SearchStrategy): boolean;
  search(q: SearchQuery, limit: number): Promise<SearchOutcome>;
}

/**
 * Undo the redirect wrappers engines put around result links.
 * Patterns are the publicly visible wrapper formats; UNVERIFIED against live engines here.
 */
export function resolveResultUrl(href: string): string {
  try {
    const u = new URL(href);
    for (const key of ["uddg", "url", "q", "u", "target"]) {
      const v = u.searchParams.get(key);
      if (v && /^https?:\/\//i.test(v) && /\/(l|url|ck|redirect|out)\b/i.test(u.pathname)) return v;
      if (key === "u" && v && /^a1/.test(v)) {
        // Base64url after an "a1" prefix, as seen in some engines' click trackers.
        try { const d = Buffer.from(v.slice(2), "base64url").toString("utf8"); if (/^https?:\/\//.test(d)) return d; } catch { /* not that format */ }
      }
    }
  } catch { /* relative or malformed: return as is */ }
  return href;
}

function mkResult(r: { title: string; url: string; snippet: string }, q: SearchQuery, rank: number, backend: string, meta: Record<string, unknown> = {}): SearchResult {
  const url = resolveResultUrl(r.url);
  const qWords = new Set(tokens(q.text));
  const tw = tokens(r.title + " " + r.snippet);
  const overlap = tw.length ? tw.filter((w) => qWords.has(w)).length / Math.max(1, qWords.size) : 0;
  return {
    title: r.title.replace(/\s+/g, " ").trim(),
    url,
    canonical_url: canonicalizeUrl(url),
    domain: domainOf(url),
    snippet: r.snippet.replace(/\s+/g, " ").trim(),
    source_type: sourceTypeOf(url, r.title),
    discovered_at: new Date().toISOString(),
    search_query: q.text,
    relevance: { query: Number(Math.min(1, overlap).toFixed(3)), rank, backend },
    metadata: { strategy: q.strategy, subquestion: q.subquestionId, ...meta },
  };
}

// ------------------------------------------------------------ engines --

export interface EngineAdapter {
  id: string;
  /** Build the results URL. `site` is appended by the backend when set. */
  urlFor(query: string): string;
  item: ChainSpec;
  /** Relative to an item. */
  link: string;
  title?: string;
  snippet: string;
  provenance: Provenance;
  strategies: SearchStrategy[];
}

export const FIXTURE_ENGINE = (base: string): EngineAdapter => ({
  id: "fixture",
  urlFor: (q) => base + "/search?q=" + encodeURIComponent(q),
  item: { name: "result", strategies: [{ kind: "css", css: "li.result", provenance: "FIXTURE" }] },
  link: "a.result-link",
  snippet: ".snippet",
  provenance: "FIXTURE",
  strategies: ["broad", "exact", "site", "official", "documentation", "technical", "news", "recency", "academic"],
});

export const DUCKDUCKGO_HTML: EngineAdapter = {
  id: "duckduckgo-html",
  urlFor: (q) => "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q),
  item: { name: "result", strategies: [
    { kind: "css", css: ".result:not(.result--ad)", provenance: "UNVERIFIED" },
    { kind: "css", css: "[data-testid='result']", provenance: "UNVERIFIED" },
  ] },
  link: "a.result__a, h2 a",
  snippet: ".result__snippet",
  provenance: "UNVERIFIED",
  strategies: ["broad", "exact", "site", "official", "documentation", "technical", "news", "recency", "academic"],
};

export const BING: EngineAdapter = {
  id: "bing",
  urlFor: (q) => "https://www.bing.com/search?q=" + encodeURIComponent(q),
  item: { name: "result", strategies: [{ kind: "css", css: "li.b_algo", provenance: "UNVERIFIED" }] },
  link: "h2 a",
  snippet: ".b_caption p, p",
  provenance: "UNVERIFIED",
  strategies: ["broad", "exact", "site", "official", "documentation", "technical", "news", "recency", "academic"],
};

export class BrowserSearchBackend implements SearchBackend {
  readonly id: string;
  constructor(private engine: EngineAdapter, private sessions: BrowserSessionManager, private tracer: Tracer = quietTracer()) {
    this.id = "browser:" + engine.id;
  }

  supports(s: SearchStrategy): boolean { return this.engine.strategies.includes(s); }

  async search(q: SearchQuery, limit: number): Promise<SearchOutcome> {
    const t0 = Date.now();
    const text = q.site && !/\bsite:/.test(q.text) ? q.text + " site:" + q.site : q.text;
    const ctx = await this.sessions.context({ key: "research", kind: "research", closePopups: true });
    const mp = await ctx.scratchPage("search");
    try {
      return await this.read(mp, q, text, limit, t0);
    } finally {
      await ctx.closePage(mp.name);
    }
  }

  private async read(mp: ManagedPage, q: SearchQuery, text: string, limit: number, t0: number): Promise<SearchOutcome> {
    const nav = await navigate(mp, this.engine.urlFor(text), { tracer: this.tracer, timeoutMs: 20000, retries: 1 });
    const done = (status: SearchOutcome["status"], results: SearchResult[], detail?: string): SearchOutcome => {
      this.tracer.event({ action: "search", result: status === "ok" ? "success" : status === "empty" ? "info" : "failure", detail: this.id + " " + JSON.stringify(text) + " → " + results.length, error: detail, durationMs: Date.now() - t0 });
      return { backend: this.id, query: q, results, status, ...(detail ? { detail } : {}), durationMs: Date.now() - t0 };
    };
    if (!nav.ok) return done(nav.errorKind === "blocked" || nav.errorKind === "dns" ? "blocked" : "error", [], nav.errorKind + ": " + (nav.error || ""));
    const sig = await mp.page.evaluate(collectSignalsInPage, { composer: null, stop: null, send: null, assistant: null, loginText: LOGIN_TEXT }).catch(() => null);
    if (sig && sig.captcha) return done("blocked", [], "the results page is a challenge");
    const items = await resolveChain(mp.page, this.engine.item);
    if (!items) return done("empty", [], "no result items matched " + this.engine.item.strategies.length + " strategies");
    const raw: Array<{ title: string; url: string; snippet: string }> = await items.locator.evaluateAll((els: any[], a: any) => {
      return els.map((el) => {
        const link = el.querySelector(a.link);
        const title = a.title ? el.querySelector(a.title) : link;
        const snip = el.querySelector(a.snippet);
        return { title: String((title && title.innerText) || "").trim(), url: String((link && link.href) || ""), snippet: String((snip && snip.innerText) || "").trim() };
      }).filter((r: any) => r.url && r.title);
    }, { link: this.engine.link, title: this.engine.title || null, snippet: this.engine.snippet });
    const results = raw.slice(0, limit).map((r, i) => mkResult(r, q, i + 1, this.id, { engineProvenance: this.engine.provenance }));
    return done(results.length ? "ok" : "empty", results);
  }
}

// ------------------------------------------------------------- GitHub --

export class GitHubSearchBackend implements SearchBackend {
  readonly id = "github";
  constructor(private token: string | undefined = process.env.CLOSENI_GITHUB_TOKEN, private tracer: Tracer = quietTracer(),
    private get: (url: string, headers: Record<string, string>) => Promise<{ status: number; body: string }> = httpsGet) {}

  supports(s: SearchStrategy): boolean { return s === "github" || s === "technical"; }

  async search(q: SearchQuery, limit: number): Promise<SearchOutcome> {
    const t0 = Date.now();
    const url = "https://api.github.com/search/repositories?per_page=" + Math.min(limit, 20) + "&q=" + encodeURIComponent(q.text);
    const headers: Record<string, string> = { "User-Agent": "CloseNI-research", Accept: "application/vnd.github+json" };
    if (this.token) headers.Authorization = "Bearer " + this.token;
    try {
      const res = await this.get(url, headers);
      if (res.status === 403 || res.status === 429) return this.out(q, [], "blocked", "GitHub rate limit (HTTP " + res.status + ")" + (this.token ? "" : " - unauthenticated search allows 10/min"), t0);
      if (res.status !== 200) return this.out(q, [], "error", "HTTP " + res.status, t0);
      const data = JSON.parse(res.body);
      const results = (data.items || []).slice(0, limit).map((it: any, i: number) => mkResult(
        { title: String(it.full_name || it.name), url: String(it.html_url), snippet: String(it.description || "") }, q, i + 1, this.id,
        { stars: it.stargazers_count, updated: it.pushed_at, language: it.language, license: it.license && it.license.spdx_id }));
      for (const r of results) if (r.metadata.updated) r.published_at = String(r.metadata.updated);
      return this.out(q, results, results.length ? "ok" : "empty", undefined, t0);
    } catch (err: any) {
      return this.out(q, [], "error", String(err && err.message || err), t0);
    }
  }

  private out(q: SearchQuery, results: SearchResult[], status: SearchOutcome["status"], detail: string | undefined, t0: number): SearchOutcome {
    this.tracer.event({ action: "search", result: status === "ok" ? "success" : "failure", detail: "github " + JSON.stringify(q.text) + " → " + results.length + (detail ? " (" + detail + ")" : ""), durationMs: Date.now() - t0 });
    return { backend: this.id, query: q, results, status, ...(detail ? { detail } : {}), durationMs: Date.now() - t0 };
  }
}

function httpsGet(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 15000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { body += d; if (body.length > 2e6) req.destroy(new Error("response too large")); });
      res.on("end", () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

// ------------------------------------------------------ AI web search --

export class AIWebSearchBackend implements SearchBackend {
  readonly id: string;
  constructor(private provider: AIWebProvider, private tracer: Tracer = quietTracer()) {
    this.id = "ai:" + provider.id;
  }

  supports(s: SearchStrategy): boolean { return s === "broad" || s === "news" || s === "recency" || s === "official"; }

  async search(q: SearchQuery, limit: number): Promise<SearchOutcome> {
    const t0 = Date.now();
    const prompt = "Search the web for: " + q.text + "\n\nList the most relevant sources as a markdown list of links, one per line, with a one-sentence note each. Only include pages you actually found.";
    try {
      const res = await this.provider.ask(prompt);
      if (res.status === "failed" || res.status === "empty") {
        return { backend: this.id, query: q, results: [], status: "error", detail: res.extraction_metadata.warnings.join("; ") || res.status, durationMs: Date.now() - t0 };
      }
      const links = res.content.links.concat(res.content.citations.filter((c) => c.href).map((c) => ({ text: c.text, href: c.href as string })));
      const seen = new Set<string>();
      const results: SearchResult[] = [];
      for (const l of links) {
        const c = canonicalizeUrl(l.href);
        if (seen.has(c)) continue;
        seen.add(c);
        results.push(mkResult({ title: l.text || l.href, url: l.href, snippet: "" }, q, results.length + 1, this.id, { via: this.provider.id }));
        if (results.length >= limit) break;
      }
      this.tracer.event({ action: "search", result: results.length ? "success" : "info", detail: this.id + " " + JSON.stringify(q.text) + " → " + results.length, durationMs: Date.now() - t0 });
      return { backend: this.id, query: q, results, status: results.length ? "ok" : "empty", durationMs: Date.now() - t0 };
    } catch (err: any) {
      return { backend: this.id, query: q, results: [], status: "error", detail: String(err && err.message || err), durationMs: Date.now() - t0 };
    }
  }
}

// ------------------------------------------------------------ aggregate --

export interface Aggregated {
  results: SearchResult[];
  duplicatesRemoved: number;
  groups: number;
}

/**
 * Many result lists → one: deduplicated by canonical URL, near-duplicate titles
 * and snippets grouped, and ordered by how many queries found a result, then its
 * best rank, then query overlap. Every result keeps its signals.
 */
export function aggregate(outcomes: SearchOutcome[]): Aggregated {
  const byUrl = new Map<string, SearchResult & { __found: Set<string>; __bestRank: number }>();
  let total = 0;
  for (const o of outcomes) {
    for (const r of o.results) {
      total++;
      const key = r.canonical_url;
      const prev = byUrl.get(key);
      if (!prev) {
        byUrl.set(key, { ...r, __found: new Set([o.backend + "|" + r.search_query]), __bestRank: r.relevance.rank });
      } else {
        prev.__found.add(o.backend + "|" + r.search_query);
        prev.__bestRank = Math.min(prev.__bestRank, r.relevance.rank);
        prev.relevance.query = Math.max(prev.relevance.query, r.relevance.query);
        if (!prev.snippet && r.snippet) prev.snippet = r.snippet;
        const before: string[] = (prev.metadata.subquestions as string[]) || [String(prev.metadata.subquestion || "")];
        prev.metadata.subquestions = Array.from(new Set(before.concat([String(r.metadata.subquestion || "")]))).filter(Boolean);
      }
    }
  }
  const list = Array.from(byUrl.values());
  const groups = groupDuplicates(list, (r) => r.title + " " + r.snippet, 0.85);
  list.forEach((r, i) => { r.duplicate_group = groups[i]; r.metadata.foundBy = r.__found.size; });
  list.sort((a, b) => b.__found.size - a.__found.size || a.__bestRank - b.__bestRank || b.relevance.query - a.relevance.query);
  const results = list.map((r) => { const { __found, __bestRank, ...rest } = r; void __found; void __bestRank; return rest as SearchResult; });
  return { results, duplicatesRemoved: total - results.length, groups: new Set(groups).size };
}
