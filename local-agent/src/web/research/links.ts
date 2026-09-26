/**
 * Which links on a page are worth following?
 *
 * Each link is judged on signals - anchor text, URL words, the heading it sat
 * under, whether it was in the content or the chrome, its domain, and what kind
 * of document it points to - against the research objective. The verdict is
 * FOLLOW, MAYBE or IGNORE, with the reasons.
 *
 * The frontier guards the crawl: canonical visited set (tracking variants are
 * one URL), depth and per-domain caps, and file types that are never pages.
 */
import { PageLink, WebPage } from "./types.js";
import { canonicalizeUrl, domainOf, siteOf } from "./url.js";
import { tokens } from "../util.js";

export type LinkDecision = "FOLLOW" | "MAYBE" | "IGNORE";

export interface LinkJudgement {
  link: PageLink;
  decision: LinkDecision;
  signals: { anchor: number; url: number; heading: number; inMain: boolean; sameSite: boolean; docType: string };
  reasons: string[];
}

const NOT_A_PAGE = /\.(png|jpe?g|gif|svg|webp|ico|mp4|webm|mp3|zip|tar|gz|tgz|exe|dmg|pkg|deb|rpm|woff2?|ttf|css|js)(\?|$)/i;
const CHROME_WORDS = /^(home|about|privacy|terms|cookies?|contact|login|log in|sign in|sign up|register|careers|jobs|press|twitter|facebook|linkedin|youtube|instagram|github|discord|rss|feed|next|previous|prev|back|top|menu|search|help|support|status|pricing|blog|docs|documentation)$/i;
const SOCIAL = /(^|\.)(twitter|x|facebook|linkedin|instagram|youtube|tiktok|pinterest|reddit)\.(com|test)$/;

function score(words: string[], target: Set<string>): number {
  if (!words.length || !target.size) return 0;
  let n = 0;
  for (const w of new Set(words)) if (target.has(w)) n++;
  return n / Math.max(1, Math.min(target.size, new Set(words).size));
}

export function judgeLink(link: PageLink, page: WebPage, objective: string): LinkJudgement {
  const obj = new Set(tokens(objective));
  const anchorWords = tokens(link.text);
  let urlWords: string[] = [];
  try { urlWords = tokens(decodeURIComponent(new URL(link.href).pathname).replace(/[\/_.-]+/g, " ")); } catch { /* keep empty */ }
  const s = {
    anchor: score(anchorWords, obj),
    url: score(urlWords, obj),
    heading: score(tokens(link.headingPath.slice(-1).join(" ")), obj),
    inMain: link.inMain,
    sameSite: siteOf(link.href) === siteOf(page.final_url || page.url),
    docType: NOT_A_PAGE.test(link.href) ? "file" : /\.pdf(\?|$)/i.test(link.href) ? "pdf" : "page",
  };
  const reasons: string[] = [];
  if (s.docType === "file") return { link, decision: "IGNORE", signals: s, reasons: ["not a document"] };
  if (!/^https?:/i.test(link.href)) return { link, decision: "IGNORE", signals: s, reasons: ["not http(s)"] };
  if (canonicalizeUrl(link.href) === canonicalizeUrl(page.final_url || page.url)) return { link, decision: "IGNORE", signals: s, reasons: ["links to itself"] };
  if (SOCIAL.test(domainOf(link.href))) return { link, decision: "IGNORE", signals: s, reasons: ["social network"] };
  if (!link.inMain && CHROME_WORDS.test(link.text.trim())) return { link, decision: "IGNORE", signals: s, reasons: ["site chrome: " + JSON.stringify(link.text)] };

  const topical = Math.max(s.anchor, s.url);
  if (topical >= 0.5 || (topical > 0 && s.inMain)) {
    reasons.push("anchor/url match " + topical.toFixed(2) + (s.inMain ? ", in content" : ""));
    return { link, decision: "FOLLOW", signals: s, reasons };
  }
  if (topical > 0 || (s.inMain && s.heading > 0) || (s.inMain && s.sameSite)) {
    reasons.push(topical > 0 ? "weak topical match" : s.heading > 0 ? "under a relevant heading" : "in content, same site");
    return { link, decision: "MAYBE", signals: s, reasons };
  }
  reasons.push("no overlap with the objective");
  return { link, decision: "IGNORE", signals: s, reasons };
}

export function judgeLinks(page: WebPage, objective: string): LinkJudgement[] {
  return page.links.map((l) => judgeLink(l, page, objective));
}

export interface FrontierOptions { maxDepth: number; maxPerDomain: number; maxTotal: number }

/** A bounded, deduplicated queue of pages to visit. */
export class Frontier {
  private visited = new Set<string>();
  private queued = new Set<string>();
  private perDomain = new Map<string, number>();
  private queue: Array<{ url: string; depth: number; priority: number; from?: string }> = [];

  constructor(private opts: FrontierOptions = { maxDepth: 2, maxPerDomain: 8, maxTotal: 40 }) {}

  markVisited(url: string): void { this.visited.add(canonicalizeUrl(url)); }
  hasVisited(url: string): boolean { return this.visited.has(canonicalizeUrl(url)); }
  get visitedCount(): number { return this.visited.size; }

  /** Returns why it was refused, or null when queued. */
  push(url: string, depth: number, priority: number, from?: string): string | null {
    const c = canonicalizeUrl(url);
    if (this.visited.has(c)) return "visited";
    if (this.queued.has(c)) return "already queued";
    if (depth > this.opts.maxDepth) return "too deep";
    if (this.visited.size + this.queue.length >= this.opts.maxTotal) return "budget";
    const d = domainOf(url);
    const n = this.perDomain.get(d) || 0;
    if (n >= this.opts.maxPerDomain) return "domain cap";
    this.perDomain.set(d, n + 1);
    this.queued.add(c);
    this.queue.push({ url, depth, priority, ...(from ? { from } : {}) });
    this.queue.sort((a, b) => b.priority - a.priority || a.depth - b.depth);
    return null;
  }

  pop(): { url: string; depth: number; priority: number; from?: string } | undefined {
    const next = this.queue.shift();
    if (next) this.queued.delete(canonicalizeUrl(next.url));
    return next;
  }

  get size(): number { return this.queue.length; }
}
