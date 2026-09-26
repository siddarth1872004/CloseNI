/**
 * Which part of a page is the content?
 *
 * No single rule works everywhere, so several independent methods vote:
 *
 *   semantic   <main>, role=main, <article>
 *   density    the container with the most non-link text, Readability-style:
 *              text length × (1 − link density), boosted by paragraphs,
 *              penalised by boilerplate markers
 *   headings   the smallest container holding the h1 and most h2s
 *
 * The winner is the node most methods agree on; disagreement is recorded, not
 * hidden, so a page whose methods split is visible in the report.
 *
 * Boilerplate inside the chosen node - nav, aside, footer, cookie banners,
 * share bars - is then removed by structure and by class/id markers, and
 * blocks repeated across pages of the same site are removed by the
 * RepeatedBlocks tracker.
 */
import { DomNode, attr, textOf } from "../semantic/dom.js";
import { hashText } from "../util.js";

const BOILER_TAGS = new Set(["nav", "header", "footer", "aside", "form", "button", "menu"]);
const BOILER_ROLES = /^(navigation|banner|contentinfo|complementary|search|menubar|toolbar|dialog)$/;
const BOILER_MARK = /(^|[\s_-])(nav|navbar|topnav|menu|footer|header|sidebar|side-bar|cookie|consent|banner|breadcrumbs?|share|social|related|comments?|advert|ads?|promo|subscribe|newsletter|popup|modal|pagination|toc|skip)([\s_-]|$)/i;

interface Stats { text: number; linkText: number; paragraphs: number; depth: number }

function isBoilerplate(n: DomNode): boolean {
  if (BOILER_TAGS.has(n.t)) return true;
  if (BOILER_ROLES.test(attr(n, "role"))) return true;
  const mark = attr(n, "class") + " " + attr(n, "id");
  return BOILER_MARK.test(mark);
}

function computeStats(root: DomNode): Map<DomNode, Stats> {
  const stats = new Map<DomNode, Stats>();
  const visit = (n: DomNode, depth: number, inLink: boolean): Stats => {
    if (n.h) { const s = { text: 0, linkText: 0, paragraphs: 0, depth }; stats.set(n, s); return s; }
    if (n.t === "#text") {
      const len = (n.x || "").replace(/\s+/g, " ").trim().length;
      return { text: len, linkText: inLink ? len : 0, paragraphs: 0, depth };
    }
    const s: Stats = { text: 0, linkText: 0, paragraphs: n.t === "p" || n.t === "pre" || n.t === "li" ? 1 : 0, depth };
    for (const c of n.c || []) {
      const cs = visit(c, depth + 1, inLink || n.t === "a");
      s.text += cs.text; s.linkText += cs.linkText; s.paragraphs += cs.paragraphs;
    }
    stats.set(n, s);
    return s;
  };
  visit(root, 0, false);
  return stats;
}

interface Index {
  els: DomNode[];
  parent: Map<DomNode, DomNode>;
  underBoiler: Set<DomNode>;
  h2Count: Map<DomNode, number>;
}

/** One walk: elements in order, parents, boilerplate ancestry, h2 counts. Linear. */
function indexTree(root: DomNode): Index {
  const els: DomNode[] = [];
  const parent = new Map<DomNode, DomNode>();
  const underBoiler = new Set<DomNode>();
  const h2Count = new Map<DomNode, number>();
  const walk = (n: DomNode, boiler: boolean): number => {
    if (n.t === "#text" || n.h) return 0;
    els.push(n);
    if (boiler) underBoiler.add(n);
    const meBoiler = boiler || (n !== root && isBoilerplate(n));
    let h2 = n.t === "h2" ? 1 : 0;
    for (const c of n.c || []) { parent.set(c, n); h2 += walk(c, meBoiler); }
    h2Count.set(n, h2);
    return h2;
  };
  walk(root, false);
  return { els, parent, underBoiler, h2Count };
}

function ancestors(ix: Index, n: DomNode): DomNode[] {
  const out: DomNode[] = [];
  let cur = ix.parent.get(n);
  while (cur) { out.push(cur); cur = ix.parent.get(cur); }
  return out;
}

/** a contains b, via the parent map. */
function containsIx(ix: Index, a: DomNode, b: DomNode): boolean {
  let cur: DomNode | undefined = b;
  while (cur) { if (cur === a) return true; cur = ix.parent.get(cur); }
  return false;
}

export interface MainContent {
  node: DomNode;
  method: string;
  votes: Record<string, string>;
}

function label(n: DomNode | null): string {
  if (!n) return "none";
  const id = attr(n, "id");
  const cls = attr(n, "class").split(/\s+/)[0];
  return n.t + (id ? "#" + id : "") + (cls ? "." + cls : "");
}

export function selectMainContent(root: DomNode): MainContent {
  const stats = computeStats(root);
  const ix = indexTree(root);
  const els = ix.els;
  const contains = (a: DomNode, b: DomNode) => containsIx(ix, a, b);
  const total = stats.get(root)?.text || 0;

  // 1 · semantic
  let semantic: DomNode | null = null;
  const mains = els.filter((n) => n.t === "main" || attr(n, "role") === "main");
  const articles = els.filter((n) => n.t === "article");
  if (mains.length) semantic = mains.sort((a, b) => (stats.get(b)?.text || 0) - (stats.get(a)?.text || 0))[0];
  if (articles.length) {
    const bestArticle = articles.sort((a, b) => (stats.get(b)?.text || 0) - (stats.get(a)?.text || 0))[0];
    // An article inside main is the tighter answer.
    if (!semantic || contains(semantic, bestArticle)) semantic = bestArticle;
  }

  // 2 · density
  let density: DomNode | null = null;
  let best = -1;
  for (const n of els) {
    if (n === root || isBoilerplate(n)) continue;
    const s = stats.get(n);
    if (!s || s.text < 80) continue;
    if (ix.underBoiler.has(n)) continue;
    const linkDensity = s.text ? s.linkText / s.text : 1;
    // Containers that are mostly links are menus, whatever they are called.
    if (linkDensity > 0.5) continue;
    const score = s.text * (1 - linkDensity) * (1 + Math.min(s.paragraphs, 20) / 10) / (1 + s.depth / 40);
    if (score > best) { best = score; density = n; }
  }
  // Prefer the smallest ancestor that still holds ~all of the best node's text
  // plus its siblings' - i.e. walk up while the parent adds real prose.
  if (density) {
    let cur = density;
    for (;;) {
      const p = ix.parent.get(cur);
      if (!p || p === root || isBoilerplate(p)) break;
      const ps = stats.get(p)!, cs = stats.get(cur)!;
      const added = ps.text - cs.text, addedLinks = ps.linkText - cs.linkText;
      if (added > cs.text * 0.3 && addedLinks < added * 0.3) cur = p; else break;
    }
    density = cur;
  }

  // 3 · headings
  let headings: DomNode | null = null;
  const h1 = els.find((n) => n.t === "h1");
  if (h1 && !ix.underBoiler.has(h1)) {
    // Only ancestors of the h1 can hold it. Innermost first; keep the smallest
    // one that reaches the highest h2 count.
    let bestCount = -1;
    // Containers of the h1 - never the h1 itself, which holds nothing but its title.
    for (const n of ancestors(ix, h1)) {
      if (n === root || isBoilerplate(n)) continue;
      const count = ix.h2Count.get(n) || 0;
      if (count > bestCount) { bestCount = count; headings = n; }
    }
  }

  const candidates: Array<[string, DomNode | null]> = [["semantic", semantic], ["density", density], ["headings", headings]];
  const votes: Record<string, string> = {};
  for (const [m, n] of candidates) votes[m] = label(n);

  // Agreement: a candidate that contains or equals the others' picks.
  const picks = candidates.filter(([, n]) => n) as Array<[string, DomNode]>;
  if (!picks.length) return { node: root, method: "whole-page", votes };
  let chosen: [string, DomNode] | null = null;
  for (const p of picks) {
    const agree = picks.filter(([, n]) => contains(p[1], n) || contains(n, p[1])).length;
    const pText = stats.get(p[1])?.text || 0;
    // Too big to be "the content": most of the page including chrome.
    if (pText > total * 0.98 && picks.length > 1 && p[1] !== density) continue;
    if (agree === picks.length) { chosen = !chosen || (stats.get(p[1])?.text || 0) < (stats.get(chosen[1])?.text || 0) ? p : chosen; }
  }
  if (!chosen) {
    // Methods disagree: trust semantic markup when it holds real text, else density.
    const sem = picks.find(([m]) => m === "semantic");
    const den = picks.find(([m]) => m === "density");
    if (sem && den && (stats.get(sem[1])?.text || 0) >= (stats.get(den[1])?.text || 0) * 0.6) chosen = sem;
    else chosen = den || sem || picks[0];
    return { node: chosen[1], method: chosen[0] + " (methods disagreed)", votes };
  }
  return { node: chosen[1], method: picks.length > 1 ? "consensus:" + chosen[0] : chosen[0], votes };
}

/** A copy of the node with boilerplate subtrees removed. Returns how many were removed. */
export function stripBoilerplate(n: DomNode, repeated?: RepeatedBlocks, site?: string): { node: DomNode; removed: number } {
  let removed = 0;
  const walk = (x: DomNode, top: boolean): DomNode | null => {
    if (x.t === "#text") return x;
    if (x.h) return null;
    if (!top && isBoilerplate(x)) { removed++; return null; }
    if (repeated && site && !top && isBlockCandidate(x) && repeated.isBoilerplate(site, textOf(x))) { removed++; return null; }
    const kids: DomNode[] = [];
    for (const c of x.c || []) { const k = walk(c, false); if (k) kids.push(k); }
    return { ...x, c: kids };
  };
  return { node: walk(n, true) || { t: n.t }, removed };
}

function isBlockCandidate(n: DomNode): boolean {
  return /^(p|div|section|ul|ol|li|span)$/.test(n.t);
}

/**
 * Blocks that appear on many pages of one site are chrome, not content:
 * "Was this page helpful?", a newsletter pitch, a license footer.
 */
export class RepeatedBlocks {
  private seen = new Map<string, Map<string, Set<string>>>(); // site → hash → pages

  constructor(private threshold: number = 3) {}

  observe(site: string, pageUrl: string, blocks: string[]): void {
    let m = this.seen.get(site);
    if (!m) { m = new Map(); this.seen.set(site, m); }
    for (const b of blocks) {
      const t = b.replace(/\s+/g, " ").trim();
      if (t.length < 15 || t.length > 400) continue;
      const h = hashText(t);
      let pages = m.get(h);
      if (!pages) { pages = new Set(); m.set(h, pages); }
      pages.add(pageUrl);
    }
  }

  isBoilerplate(site: string, text: string): boolean {
    const t = text.replace(/\s+/g, " ").trim();
    if (t.length < 15 || t.length > 400) return false;
    const pages = this.seen.get(site)?.get(hashText(t));
    return !!pages && pages.size >= this.threshold;
  }
}
