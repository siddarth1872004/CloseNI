/**
 * DOM → semantic blocks → Markdown / text.
 *
 * The one converter for anything the browser reads. A reply's code block, a
 * documentation table and a link inside a paragraph all come out as the same
 * typed blocks, so everything downstream - the response normaliser, the page
 * model, the chunker - works on structure rather than on flattened text.
 *
 * Nothing here knows about a provider. Adapters pass hints (which classes mark
 * reasoning, which subtrees are toolbars); the core only applies generic rules
 * that hold on any page: buttons are controls not content, <pre> is code,
 * <table> is a table.
 */
import { DomNode, attr, textOf } from "./dom.js";

export interface Inline {
  text: string;
  href?: string;
  code?: boolean;
  strong?: boolean;
  em?: boolean;
}

export type Block =
  | { type: "heading"; level: number; text: string; id?: string }
  | { type: "paragraph"; text: string; inlines: Inline[] }
  | { type: "list"; ordered: boolean; items: Block[][] }
  | { type: "code"; lang: string; text: string }
  | { type: "table"; caption?: string; header: string[]; rows: string[][]; links?: Array<{ text: string; href: string }> }
  | { type: "quote"; blocks: Block[] }
  | { type: "image"; src: string; alt: string }
  | { type: "rule" }
  | { type: "details"; summary: string; blocks: Block[] }
  | { type: "reasoning"; label: string; blocks: Block[] }
  | { type: "citation"; text: string; href?: string };

export interface BlockHints {
  /** Subtrees whose class/testid matches are the model's reasoning, not its answer. */
  reasoning?: RegExp[];
  /** Subtrees to drop entirely (toolbars, feedback widgets). */
  drop?: RegExp[];
  /** Subtrees that are citation chips rather than prose. */
  citation?: RegExp[];
  /** Leaf text that is UI, not content. */
  dropText?: RegExp;
}

const DEFAULT_DROP_TEXT = /^(?:copy|copied!?|download|run|edit|share|retry|regenerate|复制|下载)$/i;

/** Words a code banner may carry instead of a language class. */
const LANG_WORD = /^[a-z][a-z0-9+#.-]{0,15}$/i;

const BLOCK_TAGS = new Set(["p", "div", "section", "article", "main", "header", "footer", "aside", "nav", "ul", "ol", "li", "pre", "table", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "figure", "figcaption", "details", "summary", "dl", "dt", "dd", "form", "fieldset", "body"]);

function matches(n: DomNode, res: RegExp[] | undefined): boolean {
  if (!res || !res.length) return false;
  const key = attr(n, "class") + " " + attr(n, "data-testid") + " " + attr(n, "data-role") + " " + attr(n, "id");
  return res.some((r) => r.test(key));
}

function isControl(n: DomNode): boolean {
  return n.t === "button" || attr(n, "role") === "button" || attr(n, "role") === "toolbar" || attr(n, "role") === "menu";
}

function collapse(s: string): string {
  return s.replace(/[ \t\r\f\v ]+/g, " ").replace(/ *\n */g, "\n").trim();
}

function languageOf(pre: DomNode, container: DomNode | null): string {
  const probe = (n: DomNode | null | undefined): string => {
    if (!n) return "";
    const cls = attr(n, "class") + " " + attr(n, "data-language") + " " + attr(n, "data-lang");
    const m = /(?:language|lang)-([\w+#.-]+)/.exec(cls) || /^\s*([\w+#.-]+)\s*$/.exec(attr(n, "data-language") || attr(n, "data-lang"));
    return m ? m[1] : "";
  };
  const code = (pre.c || []).find((c) => c.t === "code");
  const direct = probe(code) || probe(pre);
  if (direct) return direct.toLowerCase();
  // A banner beside the <pre> holding a single short word (DeepSeek's layout):
  // the only leaf text in the container outside the pre and outside controls.
  if (container) {
    const words: string[] = [];
    const scan = (n: DomNode) => {
      if (n === pre || n.h || isControl(n)) return;
      if (n.t === "#text") { const t = (n.x || "").trim(); if (t) words.push(t); return; }
      for (const c of n.c || []) scan(c);
    };
    for (const c of container.c || []) scan(c);
    if (words.length === 1 && LANG_WORD.test(words[0])) return words[0].toLowerCase();
  }
  return "";
}

/** Text of <pre>, keeping line structure; highlighter spans are flattened. */
function preText(pre: DomNode): string {
  return textOf(pre).replace(/\n$/, "");
}

function inlinesOf(n: DomNode, hints: BlockHints, out: Inline[], ctx: { href?: string; strong?: boolean; em?: boolean; code?: boolean } = {}): void {
  if (n.h) return;
  if (n.t === "#text") {
    const x = (n.x || "").replace(/\s+/g, " ");
    if (!x) return;
    const last = out[out.length - 1];
    if (last && last.href === ctx.href && !!last.strong === !!ctx.strong && !!last.em === !!ctx.em && !!last.code === !!ctx.code) last.text += x;
    else out.push({ text: x, ...(ctx.href ? { href: ctx.href } : {}), ...(ctx.strong ? { strong: true } : {}), ...(ctx.em ? { em: true } : {}), ...(ctx.code ? { code: true } : {}) });
    return;
  }
  if (n.t === "br") { out.push({ text: "\n" }); return; }
  if (isControl(n) || matches(n, hints.drop)) return;
  if (n.t === "img") { const alt = attr(n, "alt"); if (alt) out.push({ text: "[" + alt + "]" }); return; }
  const next = { ...ctx };
  if (n.t === "a" && attr(n, "href")) next.href = attr(n, "href");
  if (n.t === "strong" || n.t === "b") next.strong = true;
  if (n.t === "em" || n.t === "i") next.em = true;
  if (n.t === "code" || n.t === "kbd" || n.t === "samp") next.code = true;
  for (const c of n.c || []) inlinesOf(c, hints, out, next);
}

function paragraphFrom(inl: Inline[], dropText: RegExp): Block | null {
  const cleaned = inl.map((i) => ({ ...i })).filter((i) => i.text.length);
  if (!cleaned.length) return null;
  cleaned[0].text = cleaned[0].text.replace(/^\s+/, "");
  const lastI = cleaned[cleaned.length - 1];
  lastI.text = lastI.text.replace(/\s+$/, "");
  const text = collapse(cleaned.map((i) => i.text).join(""));
  if (!text || dropText.test(text)) return null;
  return { type: "paragraph", text, inlines: cleaned.filter((i) => i.text.length) };
}

function tableFrom(n: DomNode): Block {
  const rows: string[][] = [];
  let header: string[] = [];
  let caption = "";
  const visitRows = (x: DomNode, inHead: boolean) => {
    if (x.h) return;
    if (x.t === "caption") { caption = collapse(textOf(x)); return; }
    if (x.t === "tr") {
      const cells = (x.c || []).filter((c) => c.t === "td" || c.t === "th");
      const vals = cells.map((c) => collapse(textOf(c)).replace(/\n/g, " "));
      const allTh = cells.length > 0 && cells.every((c) => c.t === "th");
      if ((inHead || (allTh && !header.length && !rows.length)) && !header.length) header = vals;
      else rows.push(vals);
      return;
    }
    for (const c of x.c || []) visitRows(c, inHead || x.t === "thead");
  };
  visitRows(n, false);
  // Links in cells: the text went into the row, the target must not be lost.
  const links: Array<{ text: string; href: string }> = [];
  const findLinks = (x: DomNode) => {
    if (x.h) return;
    if (x.t === "a" && attr(x, "href")) links.push({ text: collapse(textOf(x)), href: attr(x, "href") });
    for (const c of x.c || []) findLinks(c);
  };
  findLinks(n);
  return { type: "table", ...(caption ? { caption } : {}), header, rows, ...(links.length ? { links } : {}) };
}

/**
 * Convert a subtree to blocks.
 *
 * Inline runs between block elements are gathered into paragraphs, the way a
 * browser lays them out, so "Some <b>bold</b> text<div>…</div>" yields a
 * paragraph and then the div's blocks rather than three fragments.
 */
export function domToBlocks(root: DomNode, hints: BlockHints = {}): Block[] {
  const dropText = hints.dropText || DEFAULT_DROP_TEXT;
  const out: Block[] = [];
  convertChildren(root, out, null);
  return out;

  function convertChildren(n: DomNode, into: Block[], container: DomNode | null): void {
    let run: Inline[] = [];
    const flush = () => { const p = paragraphFrom(run, dropText); if (p) into.push(p); run = []; };
    for (const c of n.c || []) {
      if (c.h) continue;
      // An image standing on its own in a container is a figure, not a word.
      if (c.t === "img" && n.t !== "p" && n.t !== "a" && n.t !== "span") { flush(); convert(c, into, n); continue; }
      if (c.t === "#text" || !isBlockish(c)) {
        if (c.t !== "#text" && (isControl(c) || matches(c, hints.drop))) continue;
        if (c.t !== "#text" && matches(c, hints.citation)) {
          flush();
          const a = findLink(c);
          const text = collapse(textOf(c));
          if (text) into.push({ type: "citation", text, ...(a ? { href: a } : {}) });
          continue;
        }
        inlinesOf(c, hints, run);
        continue;
      }
      flush();
      convert(c, into, n);
    }
    flush();
    void container;
  }

  function convert(n: DomNode, into: Block[], parent: DomNode | null): void {
    if (n.h || isControl(n) || matches(n, hints.drop)) return;
    if (matches(n, hints.reasoning)) {
      const inner: Block[] = [];
      convertChildren(n, inner, n);
      if (inner.length) into.push({ type: "reasoning", label: attr(n, "aria-label") || "reasoning", blocks: inner });
      return;
    }
    if (matches(n, hints.citation)) {
      const text = collapse(textOf(n));
      const a = findLink(n);
      if (text) into.push({ type: "citation", text, ...(a ? { href: a } : {}) });
      return;
    }
    const t = n.t;
    if (/^h[1-6]$/.test(t)) {
      const text = collapse(textOf(n));
      if (text) into.push({ type: "heading", level: Number(t[1]), text, ...(attr(n, "id") ? { id: attr(n, "id") } : {}) });
      return;
    }
    if (attr(n, "role") === "heading") {
      const text = collapse(textOf(n));
      if (text) into.push({ type: "heading", level: Number(attr(n, "aria-level")) || 2, text });
      return;
    }
    if (t === "pre") {
      const text = preText(n);
      if (text.trim()) into.push({ type: "code", lang: languageOf(n, parent), text });
      return;
    }
    if (t === "ul" || t === "ol") {
      const items: Block[][] = [];
      for (const li of n.c || []) {
        if (li.h || li.t === "#text") continue;
        const inner: Block[] = [];
        if (li.t === "li") convertChildren(li, inner, li); else convert(li, inner, n);
        if (inner.length) items.push(inner);
      }
      if (items.length) into.push({ type: "list", ordered: t === "ol", items });
      return;
    }
    if (t === "table") { const tb = tableFrom(n); if (tb.type === "table" && (tb.header.length || tb.rows.length)) into.push(tb); return; }
    if (t === "blockquote") {
      const inner: Block[] = [];
      convertChildren(n, inner, n);
      if (inner.length) into.push({ type: "quote", blocks: inner });
      return;
    }
    if (t === "hr") { into.push({ type: "rule" }); return; }
    if (t === "img") {
      const src = attr(n, "src");
      if (src) into.push({ type: "image", src, alt: attr(n, "alt") });
      return;
    }
    if (t === "details") {
      const sum = (n.c || []).find((c) => c.t === "summary");
      const inner: Block[] = [];
      convertChildren({ ...n, c: (n.c || []).filter((c) => c !== sum) }, inner, n);
      into.push({ type: "details", summary: sum ? collapse(textOf(sum)) : "", blocks: inner });
      return;
    }
    if (t === "figure") {
      convertChildren(n, into, n);
      return;
    }
    // A code-block wrapper: one <pre> plus, at most, a banner naming the
    // language and some controls. Emitting the banner as a paragraph would put
    // a stray "python" line above every code block.
    const wrapped = codeWrapper(n);
    if (wrapped) {
      const text = preText(wrapped);
      if (text.trim()) into.push({ type: "code", lang: languageOf(wrapped, n), text });
      return;
    }
    // A container: div, section, li outside a list, p, …
    convertChildren(n, into, n);
  }
}

/** The single <pre> a wrapper exists to hold, when everything else is a label or a control. */
function codeWrapper(n: DomNode): DomNode | null {
  const pres: DomNode[] = [];
  const other: string[] = [];
  const scan = (x: DomNode) => {
    if (x.h || isControl(x)) return;
    if (x.t === "pre") { pres.push(x); return; }
    if (x.t === "#text") { const t = (x.x || "").trim(); if (t) other.push(t); return; }
    for (const c of x.c || []) scan(c);
  };
  for (const c of n.c || []) scan(c);
  if (pres.length !== 1) return null;
  if (other.length === 0 || (other.length === 1 && LANG_WORD.test(other[0]))) return pres[0];
  return null;
}

function isBlockish(n: DomNode): boolean {
  if (BLOCK_TAGS.has(n.t) || /^h[1-6]$/.test(n.t)) return true;
  if (n.t === "img") return false;
  // A span whose subtree holds a block (common in chat UIs) is a block.
  return (n.c || []).some((c) => c.t !== "#text" && isBlockish(c));
}

function findLink(n: DomNode): string {
  if (n.t === "a" && attr(n, "href")) return attr(n, "href");
  for (const c of n.c || []) { const h = findLink(c); if (h) return h; }
  return "";
}

// ---------------------------------------------------------------- render --

function inlineMd(i: Inline): string {
  let t = i.text;
  if (i.code) t = "`" + t.replace(/`/g, "\\`") + "`";
  if (i.strong) t = "**" + t + "**";
  if (i.em) t = "*" + t + "*";
  if (i.href && !/^javascript:/i.test(i.href)) t = "[" + t + "](" + i.href + ")";
  return t;
}

export function blocksToMarkdown(blocks: Block[], indent: string = ""): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "heading": parts.push(indent + "#".repeat(Math.min(6, Math.max(1, b.level))) + " " + b.text); break;
      case "paragraph": parts.push(indent + collapse(b.inlines.map(inlineMd).join(""))); break;
      case "code": {
        const fence = b.text.includes("```") ? "````" : "```";
        parts.push(indent + fence + b.lang + "\n" + b.text + "\n" + indent + fence);
        break;
      }
      case "list": {
        const lines = b.items.map((item, k) => {
          const bullet = b.ordered ? (k + 1) + ". " : "- ";
          const body = blocksToMarkdown(item, "").split("\n");
          return indent + bullet + body[0] + (body.length > 1 ? "\n" + body.slice(1).map((l) => indent + "   " + l).join("\n") : "");
        });
        parts.push(lines.join("\n"));
        break;
      }
      case "table": {
        const width = Math.max(b.header.length, ...b.rows.map((r) => r.length), 1);
        const pad = (r: string[]) => { const x = r.slice(); while (x.length < width) x.push(""); return x; };
        const esc = (s: string) => s.replace(/\|/g, "\\|");
        const head = b.header.length ? pad(b.header) : pad([]).map(() => "");
        const lines = ["| " + head.map(esc).join(" | ") + " |", "|" + head.map(() => " --- ").join("|") + "|"];
        for (const r of b.rows) lines.push("| " + pad(r).map(esc).join(" | ") + " |");
        if (b.caption) lines.unshift(indent + "*" + b.caption + "*");
        parts.push(lines.map((l) => indent + l).join("\n"));
        break;
      }
      case "quote": parts.push(blocksToMarkdown(b.blocks).split("\n").map((l) => indent + "> " + l).join("\n")); break;
      case "image": parts.push(indent + "![" + b.alt + "](" + b.src + ")"); break;
      case "rule": parts.push(indent + "---"); break;
      case "details": parts.push(indent + "<details><summary>" + b.summary + "</summary>\n\n" + blocksToMarkdown(b.blocks) + "\n\n</details>"); break;
      case "reasoning": parts.push(blocksToMarkdown(b.blocks).split("\n").map((l) => indent + "> " + l).join("\n")); break;
      case "citation": parts.push(indent + (b.href ? "[" + b.text + "](" + b.href + ")" : "[" + b.text + "]")); break;
    }
  }
  return parts.join("\n\n");
}

export function blocksToText(blocks: Block[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "heading": case "paragraph": parts.push(b.text); break;
      case "code": parts.push(b.text); break;
      case "list": parts.push(b.items.map((i) => blocksToText(i)).join("\n")); break;
      case "table": parts.push([b.header.join("\t"), ...b.rows.map((r) => r.join("\t"))].filter(Boolean).join("\n")); break;
      case "quote": case "details": case "reasoning": parts.push(blocksToText(b.blocks)); break;
      case "image": if (b.alt) parts.push(b.alt); break;
      case "citation": parts.push(b.text); break;
      case "rule": break;
    }
  }
  return parts.filter((p) => p.trim()).join("\n\n");
}

/** Every block of a type, including nested ones. */
export function collect<T extends Block["type"]>(blocks: Block[], type: T): Extract<Block, { type: T }>[] {
  const out: any[] = [];
  const visit = (bs: Block[], inReasoning: boolean) => {
    for (const b of bs) {
      if (b.type === type && !(inReasoning && type !== "reasoning")) out.push(b);
      if (b.type === "list") for (const it of b.items) visit(it, inReasoning);
      if (b.type === "quote" || b.type === "details") visit(b.blocks, inReasoning);
      if (b.type === "reasoning") visit(b.blocks, true);
    }
  };
  visit(blocks, false);
  return out;
}

/** Links carried in paragraphs and citations, answer only (not reasoning). */
export function collectLinks(blocks: Block[]): Array<{ text: string; href: string }> {
  const out: Array<{ text: string; href: string }> = [];
  const seen = new Set<string>();
  const add = (text: string, href: string) => {
    if (!href || /^javascript:/i.test(href) || seen.has(href + "|" + text)) return;
    seen.add(href + "|" + text);
    out.push({ text: collapse(text), href });
  };
  for (const p of collect(blocks, "paragraph")) for (const i of p.inlines) if (i.href) add(i.text, i.href);
  for (const c of collect(blocks, "citation")) if (c.href) add(c.text, c.href);
  for (const t of collect(blocks, "table")) for (const l of t.links || []) add(l.text, l.href);
  return out;
}
