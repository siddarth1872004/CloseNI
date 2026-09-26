/**
 * A fetched page as something a researcher can reason about.
 *
 * Raw HTML never reaches a model. A page becomes a WebPage: metadata, a section
 * tree with heading paths, and the tables, code, lists and links inside it - each
 * link knowing which heading it sat under and whether it was in the content or
 * the chrome. Levels of representation, cheapest first:
 *
 *   0 raw browser state   1 DOM snapshot   2 accessibility tree (captured on demand)
 *   3 semantic document   4 main content   5 evidence chunks   6 claims
 *
 * This module produces levels 3 and 4; chunk.ts and evidence.ts the rest.
 */
import { DomSnapshot, DomNode, attr, textOf } from "../semantic/dom.js";
import { Block, domToBlocks, blocksToText } from "../semantic/blocks.js";
import { selectMainContent, stripBoilerplate, RepeatedBlocks } from "./content.js";
import { canonicalizeUrl, siteOf, sourceTypeOf } from "./url.js";
import { PageLink, Section, WebPage } from "./types.js";
import { hashText } from "../util.js";

export interface BuildOptions {
  fetchedAt?: string;
  fetch?: WebPage["fetch"];
  repeated?: RepeatedBlocks;
  finalUrl?: string;
}

function collapse(s: string): string { return s.replace(/\s+/g, " ").trim(); }

/** Blocks → sections by heading hierarchy. */
export function sectionize(blocks: Block[], pageTitle: string): Section[] {
  const sections: Section[] = [];
  const stack: Array<{ level: number; text: string }> = [];
  let current: Section = { id: "s0", path: pageTitle ? [pageTitle] : [], level: 0, heading: "", blocks: [], offset: 0 };
  let offset = 0;
  const push = () => { if (current.blocks.length || current.heading) sections.push(current); };
  for (const b of blocks) {
    if (b.type === "heading") {
      push();
      while (stack.length && stack[stack.length - 1].level >= b.level) stack.pop();
      stack.push({ level: b.level, text: b.text });
      const path = (pageTitle && stack[0] && stack[0].text !== pageTitle && b.level > 1 ? [pageTitle] : []).concat(stack.map((s) => s.text));
      current = { id: "s" + (sections.length + 1), path, level: b.level, heading: b.text, blocks: [], offset };
      offset += b.text.length + 2;
      continue;
    }
    current.blocks.push(b);
    offset += blocksToText([b]).length + 2;
  }
  push();
  return sections;
}

/** Links in document order, with the heading path they sat under. */
function collectLinks(root: DomNode, main: DomNode, base: string): PageLink[] {
  const mainSet = new Set<DomNode>();
  const mark = (n: DomNode) => { mainSet.add(n); for (const c of n.c || []) mark(c); };
  mark(main);
  const out: PageLink[] = [];
  const seen = new Set<string>();
  const headings: Array<{ level: number; text: string }> = [];
  const walk = (n: DomNode) => {
    if (n.h || n.t === "#text") return;
    const hm = /^h([1-6])$/.exec(n.t);
    if (hm) {
      const level = Number(hm[1]);
      while (headings.length && headings[headings.length - 1].level >= level) headings.pop();
      headings.push({ level, text: collapse(textOf(n)) });
    }
    if (n.t === "a") {
      const href = attr(n, "href");
      if (href && !/^(javascript|mailto|tel):/i.test(href) && !href.startsWith("#")) {
        let abs = href;
        try { abs = new URL(href, base).toString(); } catch { /* keep */ }
        const text = collapse(textOf(n)) || attr(n, "aria-label") || attr(n, "title");
        const key = abs + "|" + text;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ text, href: abs, canonical: canonicalizeUrl(abs), headingPath: headings.map((h) => h.text), inMain: mainSet.has(n), ...(attr(n, "rel") ? { rel: attr(n, "rel") } : {}) });
        }
      }
    }
    for (const c of n.c || []) walk(c);
  };
  walk(root);
  return out;
}

export function buildWebPage(snap: DomSnapshot, opts: BuildOptions = {}): WebPage {
  const url = snap.url;
  const finalUrl = opts.finalUrl || url;
  const meta = snap.meta || {};
  const title = collapse(snap.title || meta["og:title"] || "");
  const canonical = meta["canonical"] ? canonicalizeUrl(meta["canonical"], finalUrl) : canonicalizeUrl(finalUrl);
  const site = siteOf(finalUrl);

  const main = selectMainContent(snap.root);
  const stripped = stripBoilerplate(main.node, opts.repeated, site);
  const mainBlocks = domToBlocks(stripped.node);
  const allBlocks = domToBlocks(snap.root);
  const sections = sectionize(mainBlocks, title);
  const mainText = blocksToText(mainBlocks);

  const headings: WebPage["headings"] = [];
  const tables: WebPage["tables"] = [];
  const code: WebPage["code_blocks"] = [];
  const lists: string[][] = [];
  const paragraphs: string[] = [];
  const images: WebPage["images"] = [];
  for (const s of sections) {
    if (s.heading) headings.push({ level: s.level, text: s.heading });
    const visit = (bs: Block[]) => {
      for (const b of bs) {
        if (b.type === "table") tables.push({ ...(b.caption ? { caption: b.caption } : {}), header: b.header, rows: b.rows, headingPath: s.path });
        else if (b.type === "code") code.push({ lang: b.lang, text: b.text, headingPath: s.path });
        else if (b.type === "list") { lists.push(b.items.map((i) => blocksToText(i))); for (const i of b.items) visit(i); }
        else if (b.type === "paragraph") paragraphs.push(b.text);
        else if (b.type === "image") images.push({ src: b.src, alt: b.alt });
        else if (b.type === "quote" || b.type === "details" || b.type === "reasoning") visit(b.blocks);
      }
    };
    visit(s.blocks);
  }

  const published = meta["article:published_time"] || meta["ld:datepublished"] || meta["date"] || meta["pubdate"] || meta["dc.date"];
  if (opts.repeated) {
    opts.repeated.observe(site, canonical, paragraphs.concat(blocksToText(allBlocks).split("\n\n")));
  }
  return {
    url,
    canonical_url: canonical,
    final_url: finalUrl,
    title,
    description: collapse(meta["description"] || meta["og:description"] || ""),
    language: snap.lang || meta["og:locale"] || "",
    metadata: meta,
    ...(published ? { published_at: published } : {}),
    headings,
    sections,
    paragraphs,
    lists,
    tables,
    code_blocks: code,
    links: collectLinks(snap.root, main.node, finalUrl),
    images,
    main_content: { method: main.method, votes: main.votes, textChars: mainText.length, boilerplateRemoved: stripped.removed },
    text: blocksToText(allBlocks),
    main_text: mainText,
    source_type: sourceTypeOf(finalUrl, title),
    fetched_at: opts.fetchedAt || new Date().toISOString(),
    fetch: opts.fetch || { mode: "http", durationMs: 0, representation: 4 },
    content_hash: hashText(mainText),
  };
}
