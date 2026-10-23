/**
 * One compact DOM representation for everything the browser reads.
 *
 * An AI reply and a documentation page are both "some markup to understand",
 * and the old controller had two separate walkers for replies alone, with
 * different rules. Everything under web/ goes through this instead:
 *
 *   page  →  snapshotInPage()  →  DomNode tree  →  blocks.ts / page.ts
 *   html  →  parseHtml()       →  DomNode tree  →  (same)
 *
 * The in-page serializer keeps only what understanding needs: tags, a short
 * whitelist of attributes, text, and a visibility flag. No styles, no scripts,
 * no event handlers - and no input values, since a provider page is an
 * authenticated page.
 *
 * parseHtml exists so the whole extraction pipeline can be tested without a
 * browser, and so a static page can be read over plain HTTP when that is the
 * cheapest representation that answers the question.
 */

export interface DomNode {
  /** Lower-case tag name, or "#text". */
  t: string;
  /** Text, for #text nodes. */
  x?: string;
  /** Whitelisted attributes. */
  a?: Record<string, string>;
  c?: DomNode[];
  /** Hidden (display:none, visibility:hidden, aria-hidden, hidden attr). */
  h?: 1;
}

export interface DomSnapshot {
  root: DomNode;
  url: string;
  title: string;
  meta: Record<string, string>;
  lang: string;
  nodeCount: number;
  truncated: boolean;
}

/** Attributes worth keeping. Everything else is noise or risk. */
export const KEEP_ATTRS = [
  "href", "src", "alt", "title", "id", "class", "role", "aria-label", "aria-hidden", "aria-level",
  "lang", "data-language", "data-lang", "colspan", "rowspan", "datetime", "cite", "name", "content",
  "rel", "type", "hidden", "open", "data-testid", "data-role", "data-message-author-role", "data-message-id",
];

/** Elements whose content is never prose. */
export const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed", "input", "select", "option", "textarea", "head", "link", "meta"]);

/**
 * Serialise a subtree in the page.
 *
 * Passed to page.evaluate / locator.evaluate as-is, so it must be
 * self-contained: no closures over module scope. `rootSel` null means the whole
 * document body.
 */
export function snapshotInPage(arg: { rootSel: string | null; maxNodes: number; keep: string[]; skip: string[] }): any {
  const doc: any = (globalThis as any).document;
  const win: any = globalThis as any;
  const keep = new Set(arg.keep);
  const skip = new Set(arg.skip);
  let count = 0;
  let truncated = false;
  const hidden = (el: any): boolean => {
    if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return true;
    if (typeof el.checkVisibility === "function") {
      try { return !el.checkVisibility({ visibilityProperty: true }); } catch { /* old engine */ }
    }
    const cs = win.getComputedStyle(el);
    return cs.display === "none" || cs.visibility === "hidden";
  };
  const walk = (node: any): any => {
    if (count >= arg.maxNodes) { truncated = true; return null; }
    if (node.nodeType === 3) {
      const text = node.nodeValue;
      // Whitespace inside <pre> is the code's line structure, not layout.
      const inPre = !!(node.parentElement && node.parentElement.closest && node.parentElement.closest("pre, textarea"));
      if (inPre) { if (!text) return null; count++; return { t: "#text", x: text }; }
      if (!text || !text.trim()) return text && text.length ? { t: "#text", x: " " } : null;
      count++;
      return { t: "#text", x: text };
    }
    if (node.nodeType !== 1) return null;
    const tag = String(node.tagName).toLowerCase();
    if (skip.has(tag)) {
      // An iframe's source is a link worth knowing about; its content is not ours.
      if (tag === "iframe" && node.getAttribute("src")) { count++; return { t: "iframe", a: { src: node.getAttribute("src") }, h: 1 }; }
      return null;
    }
    count++;
    const out: any = { t: tag };
    const attrs: any = {};
    let any = false;
    for (const name of node.getAttributeNames ? node.getAttributeNames() : []) {
      if (!keep.has(name)) continue;
      let v = String(node.getAttribute(name) || "");
      if (name === "class") v = v.split(/\s+/).slice(0, 8).join(" ");
      if (v.length > 400) v = v.slice(0, 400);
      attrs[name] = v;
      any = true;
    }
    // Resolved href: relative links are useless once the node leaves the page.
    if (tag === "a" && node.href) { attrs.href = String(node.href); any = true; }
    if (tag === "img" && node.currentSrc) { attrs.src = String(node.currentSrc); any = true; }
    if (any) out.a = attrs;
    if (tag !== "body" && tag !== "html" && hidden(node)) { out.h = 1; return out; }
    const kids: any[] = [];
    for (const child of Array.from(node.childNodes) as any[]) {
      const k = walk(child);
      if (k) kids.push(k);
      if (truncated) break;
    }
    if (kids.length) out.c = kids;
    return out;
  };
  const root = arg.rootSel ? doc.querySelector(arg.rootSel) : doc.body;
  const meta: any = {};
  for (const m of Array.from(doc.querySelectorAll("meta[name], meta[property], meta[itemprop]")) as any[]) {
    const k = m.getAttribute("name") || m.getAttribute("property") || m.getAttribute("itemprop");
    const v = m.getAttribute("content");
    if (k && v && !meta[k]) meta[String(k).toLowerCase()] = String(v).slice(0, 500);
  }
  const canon = doc.querySelector('link[rel="canonical"]');
  if (canon && canon.href) meta["canonical"] = String(canon.href);
  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]')) as any[]) {
    const m = /"datePublished"\s*:\s*"([^"]+)"/.exec(String(s.textContent || ""));
    if (m && !meta["ld:datepublished"]) meta["ld:datepublished"] = m[1];
  }
  return {
    root: root ? walk(root) || { t: "body" } : { t: "body" },
    url: String(win.location && win.location.href || ""),
    title: String(doc.title || ""),
    meta,
    lang: String(doc.documentElement && doc.documentElement.getAttribute("lang") || ""),
    nodeCount: count,
    truncated,
  };
}

/** Snapshot a page, or one element of it, through Playwright. */
export async function snapshot(page: any, rootSel: string | null = null, maxNodes: number = 20000): Promise<DomSnapshot> {
  return page.evaluate(snapshotInPage, { rootSel, maxNodes, keep: KEEP_ATTRS, skip: Array.from(SKIP_TAGS) });
}

/**
 * Snapshot the element a locator points at (its last match).
 *
 * The element is tagged with a one-off attribute, serialised through the same
 * page-side walker as a whole page, and untagged - one serializer, not two.
 */
export async function snapshotLocator(page: any, locator: any, maxNodes: number = 8000): Promise<DomNode | null> {
  const mark = "s" + Math.random().toString(36).slice(2);
  const tagged: boolean = await locator.evaluateAll((els: any[], m: string) => {
    const el = els[els.length - 1];
    if (!el) return false;
    el.setAttribute("data-closeni-snap", m);
    return true;
  }, mark);
  if (!tagged) return null;
  try {
    const snap: DomSnapshot = await page.evaluate(snapshotInPage,
      { rootSel: '[data-closeni-snap="' + mark + '"]', maxNodes, keep: KEEP_ATTRS, skip: Array.from(SKIP_TAGS) });
    return snap.root;
  } finally {
    await page.evaluate((m: string) => {
      const el = (globalThis as any).document.querySelector('[data-closeni-snap="' + m + '"]');
      if (el) el.removeAttribute("data-closeni-snap");
    }, mark).catch(() => { /* page moved on */ });
  }
}

// ---------------------------------------------------------------- parseHtml --

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
/** Opening one of these closes an open element of the listed kinds. */
const IMPLIED_CLOSE: Record<string, string[]> = {
  p: ["p"], li: ["li"], dt: ["dt", "dd"], dd: ["dt", "dd"], tr: ["tr", "td", "th"], td: ["td", "th"], th: ["td", "th"],
  option: ["option"], thead: ["tbody", "tfoot"], tbody: ["thead", "tbody", "tfoot"],
  h1: ["p"], h2: ["p"], h3: ["p"], h4: ["p"], h5: ["p"], h6: ["p"], ul: ["p"], ol: ["p"], pre: ["p"], table: ["p"], div: ["p"],
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", copy: "©", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * A tolerant HTML parser into the same DomNode shape the page serializer emits.
 *
 * Not a spec-complete HTML5 parser, and it does not need to be: it handles the
 * structures content extraction cares about - implied closes for p/li/td,
 * void elements, raw-text elements, comments, entities - and never throws on
 * malformed input. Visibility is known only from the hidden attribute,
 * aria-hidden and an inline display:none, which is all static HTML can say.
 */
export function parseHtml(html: string, url: string = ""): DomSnapshot {
  const src = String(html || "");
  const root: DomNode = { t: "#root", c: [] };
  const stack: DomNode[] = [root];
  const meta: Record<string, string> = {};
  let title = "";
  let lang = "";
  let count = 0;
  let i = 0;
  const top = () => stack[stack.length - 1];
  const append = (n: DomNode) => { const p = top(); (p.c = p.c || []).push(n); };
  const closeTo = (tag: string) => {
    for (let k = stack.length - 1; k > 0; k--) {
      if (stack[k].t === tag) { stack.length = k; return true; }
    }
    return false;
  };
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) { pushText(src.slice(i)); break; }
    if (lt > i) pushText(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src[lt + 1] === "!" || src[lt + 1] === "?") {
      const end = src.indexOf(">", lt);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    const close = src[lt + 1] === "/";
    const m = /^<\/?([a-zA-Z][\w:-]*)/.exec(src.slice(lt, lt + 64));
    if (!m) { pushText("<"); i = lt + 1; continue; }
    const tag = m[1].toLowerCase();
    const end = findTagEnd(src, lt);
    const inner = src.slice(lt + m[0].length, end);
    i = end + 1;
    if (close) { closeTo(tag); continue; }
    const attrs = parseAttrs(inner);
    const selfClosing = /\/\s*$/.test(inner);
    for (const closes of IMPLIED_CLOSE[tag] || []) {
      // Only close when the implied element is the innermost open one of a
      // block-level run - never across a table or list boundary.
      const k = findOpen(stack, closes);
      if (k > 0 && !stack.slice(k + 1).some((n) => /^(table|ul|ol|div|section|article)$/.test(n.t))) stack.length = k;
    }
    if (tag === "meta") {
      const k = (attrs.name || attrs.property || attrs.itemprop || "").toLowerCase();
      if (k && attrs.content && !meta[k]) meta[k] = attrs.content.slice(0, 500);
      continue;
    }
    if (tag === "link") {
      if (/\bcanonical\b/i.test(attrs.rel || "") && attrs.href) meta["canonical"] = absolutize(attrs.href, url);
      continue;
    }
    if (tag === "html" && attrs.lang) lang = attrs.lang;
    // <head> is transparent here: its title, meta and link are read above and
    // below; nothing inside it is content.
    if (tag === "head") continue;
    if (RAW_TEXT.has(tag)) {
      const closeRe = new RegExp("</" + tag + "\\s*>", "i");
      const rest = src.slice(i);
      const cm = closeRe.exec(rest);
      const body = cm ? rest.slice(0, cm.index) : rest;
      i = cm ? i + cm.index + cm[0].length : src.length;
      if (tag === "title") { title = decodeEntities(body).trim(); continue; }
      if (tag === "script" && /ld\+json/i.test(attrs.type || "")) {
        const d = /"datePublished"\s*:\s*"([^"]+)"/.exec(body);
        if (d && !meta["ld:datepublished"]) meta["ld:datepublished"] = d[1];
      }
      continue; // script/style/textarea contents are never prose
    }
    if (SKIP_TAGS.has(tag) && tag !== "iframe") {
      if (!VOID.has(tag) && !selfClosing) {
        const closeRe = new RegExp("</" + tag + "\\s*>", "i");
        const cm = closeRe.exec(src.slice(i));
        i = cm ? i + cm.index + cm[0].length : src.length;
      }
      continue;
    }
    const node: DomNode = { t: tag };
    const kept: Record<string, string> = {};
    let any = false;
    for (const k of Object.keys(attrs)) {
      if (!KEEP_ATTRS.includes(k)) continue;
      let v = attrs[k];
      if ((k === "href" || k === "src") && v) v = absolutize(v, url);
      kept[k] = v.slice(0, 400);
      any = true;
    }
    if (any) node.a = kept;
    if (attrs.hidden !== undefined || attrs["aria-hidden"] === "true" || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attrs.style || "")) node.h = 1;
    count++;
    append(node);
    if (tag === "iframe") { node.h = 1; continue; }
    if (!VOID.has(tag) && !selfClosing) stack.push(node);
  }
  const body = findFirst(root, "body") || root;
  if (body.t === "#root") body.t = "body";
  return { root: body, url, title, meta, lang, nodeCount: count, truncated: false };

  function pushText(raw: string) {
    if (!raw) return;
    const x = decodeEntities(raw);
    const inPre = stack.some((n) => n.t === "pre");
    if (!x.trim() && !inPre) { if (x.length) append({ t: "#text", x: " " }); return; }
    count++;
    append({ t: "#text", x });
  }
}

function findTagEnd(src: string, from: number): number {
  let q: string | null = null;
  for (let k = from + 1; k < src.length; k++) {
    const ch = src[k];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === "\"" || ch === "'") { q = ch; continue; }
    if (ch === ">") return k;
  }
  return src.length - 1;
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const k = m[1].toLowerCase();
    if (out[k] !== undefined) continue;
    out[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

function findOpen(stack: DomNode[], tag: string): number {
  for (let k = stack.length - 1; k > 0; k--) if (stack[k].t === tag) return k;
  return -1;
}

function findFirst(n: DomNode, tag: string): DomNode | null {
  if (n.t === tag) return n;
  for (const c of n.c || []) { const f = findFirst(c, tag); if (f) return f; }
  return null;
}

export function absolutize(href: string, base: string): string {
  if (!base) return href;
  try { return new URL(href, base).toString(); } catch { return href; }
}

/** All text under a node, hidden subtrees excluded. */
export function textOf(n: DomNode | null | undefined): string {
  if (!n || n.h) return "";
  if (n.t === "#text") return n.x || "";
  if (n.t === "br") return "\n";
  let s = "";
  for (const c of n.c || []) s += textOf(c);
  return s;
}

export function attr(n: DomNode, name: string): string {
  return (n.a && n.a[name]) || "";
}

export function hasClass(n: DomNode, fragment: RegExp): boolean {
  return fragment.test(attr(n, "class"));
}

/** Depth-first walk; return false from visit to skip a subtree. */
export function walkDom(n: DomNode, visit: (node: DomNode, depth: number, parent: DomNode | null) => boolean | void, depth: number = 0, parent: DomNode | null = null): void {
  if (visit(n, depth, parent) === false) return;
  for (const c of n.c || []) walkDom(c, visit, depth + 1, n);
}
