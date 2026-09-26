/**
 * From the markup of one reply to the AIResponse the rest of the system uses.
 *
 *   RawResponse        what the page gave us: a DOM snapshot and its innerText
 *   DOMResponse        the snapshot, with hidden subtrees and controls removed
 *   SemanticResponse   typed blocks: answer and reasoning separated
 *   NormalizedResponse markdown + plain text, code/tables/links pulled out
 *   StructuredResponse the AIResponse, with provenance of how it was read
 *
 * Each stage is a plain function over data, so a reply recorded once can be
 * pushed through the whole pipeline in a unit test with no browser.
 *
 * Nothing is fabricated to fill the shape: a reply with no tables has an empty
 * tables array, and reasoning is absent - not empty - when the page showed none.
 */
import { DomNode } from "../semantic/dom.js";
import { Block, BlockHints, domToBlocks, blocksToMarkdown, blocksToText, collect, collectLinks } from "../semantic/blocks.js";
import { AIResponse, Artifact, ExtractionMetadata, ResponseContent, WaitResult } from "../providers/ai-web-provider.js";

export interface RawResponse {
  provider: string;
  dom: DomNode | null;
  innerText: string;
  url: string;
  capturedAt: string;
}

export interface DOMResponse { provider: string; dom: DomNode; url: string; capturedAt: string }

export interface SemanticResponse {
  provider: string;
  answer: Block[];
  reasoning: Block[];
  url: string;
  capturedAt: string;
  messageId?: string;
}

export interface NormalizedResponse {
  provider: string;
  content: ResponseContent;
  reasoning?: { text: string; markdown: string; blocks: Block[] };
  artifacts: Artifact[];
  attachments: Array<{ label: string; href: string }>;
  url: string;
  capturedAt: string;
  messageId?: string;
}

/** Generic reasoning markers - a heuristic, reported as such in the metadata. */
export const GENERIC_REASONING = [/(^|[\s_-])(think|thinking|thought|reasoning|reason-content)([\s_-]|$)/i];

export function toDomResponse(raw: RawResponse): DOMResponse | null {
  if (!raw.dom) return null;
  return { provider: raw.provider, dom: raw.dom, url: raw.url, capturedAt: raw.capturedAt };
}

function findMessageId(n: DomNode): string | undefined {
  const a = n.a || {};
  for (const k of ["data-message-id", "data-testid", "id"]) {
    const v = a[k];
    if (v && /\d|[a-f0-9]{8,}/i.test(v) && v.length < 80) return v;
  }
  return undefined;
}

export function toSemantic(d: DOMResponse, hints: BlockHints = {}): SemanticResponse {
  const merged: BlockHints = { ...hints, reasoning: (hints.reasoning || []).concat(GENERIC_REASONING) };
  const blocks = domToBlocks(d.dom, merged);
  const answer: Block[] = [];
  const reasoning: Block[] = [];
  for (const b of blocks) (b.type === "reasoning" ? reasoning : answer).push(b);
  return { provider: d.provider, answer, reasoning, url: d.url, capturedAt: d.capturedAt, messageId: findMessageId(d.dom) };
}

const FILE_EXT = /\.(zip|tar|gz|tgz|pdf|csv|xlsx?|docx?|pptx?|json|ya?ml|txt|md|png|jpe?g|gif|svg|webp|mp4|py|js|ts|java|rs|go)(\?|#|$)/i;

export function normalize(s: SemanticResponse): NormalizedResponse {
  const code = collect(s.answer, "code").map((c) => ({ lang: c.lang, text: c.text }));
  const tables = collect(s.answer, "table").map((t) => ({ ...(t.caption ? { caption: t.caption } : {}), header: t.header, rows: t.rows }));
  const links = collectLinks(s.answer);
  const citations = collect(s.answer, "citation").map((c) => ({ text: c.text, ...(c.href ? { href: c.href } : {}) }));
  const images = collect(s.answer, "image");
  const artifacts: Artifact[] = [];
  code.forEach((c, i) => artifacts.push({ kind: "code", label: (c.lang || "code") + " block " + (i + 1), value: c.text, ...(c.lang ? { lang: c.lang } : {}) }));
  for (const im of images) artifacts.push({ kind: "image", label: im.alt || "image", value: im.src });
  const attachments: Array<{ label: string; href: string }> = [];
  for (const l of links) {
    if (FILE_EXT.test(l.href)) { artifacts.push({ kind: "file-link", label: l.text || l.href, value: l.href }); attachments.push({ label: l.text || l.href, href: l.href }); }
  }
  const content: ResponseContent = {
    text: blocksToText(s.answer),
    markdown: blocksToMarkdown(s.answer),
    code, tables, links, citations,
  };
  const out: NormalizedResponse = { provider: s.provider, content, artifacts, attachments, url: s.url, capturedAt: s.capturedAt, messageId: s.messageId };
  if (s.reasoning.length) {
    const inner = s.reasoning.flatMap((r) => (r.type === "reasoning" ? r.blocks : [r]));
    out.reasoning = { text: blocksToText(inner), markdown: blocksToMarkdown(inner), blocks: inner };
  }
  return out;
}

export interface StructureOptions {
  conversationIdPattern?: RegExp;
  meta: Omit<ExtractionMetadata, "domNodes"> & { domNodes?: number };
  wait?: WaitResult;
  keepDom?: DomNode | null;
}

export function countNodes(n: DomNode | null | undefined): number {
  if (!n) return 0;
  let c = 1;
  for (const k of n.c || []) c += countNodes(k);
  return c;
}

export function toStructured(n: NormalizedResponse, opts: StructureOptions): AIResponse {
  let conversationId: string | undefined;
  if (opts.conversationIdPattern) {
    const m = opts.conversationIdPattern.exec(n.url);
    if (m) conversationId = m[1];
  }
  const empty = (!n.content.text.trim() && !n.content.code.length) || (!!opts.wait && opts.wait.signal === "empty");
  const status: AIResponse["status"] = empty ? "empty" : (opts.wait ? opts.wait.status : "complete");
  const res: AIResponse = {
    provider: n.provider,
    timestamp: n.capturedAt,
    status,
    content: n.content,
    attachments: n.attachments,
    artifacts: n.artifacts,
    extraction_metadata: { ...opts.meta, domNodes: opts.meta.domNodes ?? 0 },
  };
  if (conversationId) res.conversationId = conversationId;
  if (n.messageId) res.messageId = n.messageId;
  if (n.reasoning) res.reasoning = n.reasoning;
  if (opts.keepDom) res.raw_dom_snapshot = opts.keepDom;
  if (opts.wait) {
    res.extraction_metadata.completionSignal = opts.wait.signal;
    res.extraction_metadata.waitedMs = opts.wait.waitedMs;
    res.extraction_metadata.partialCount = opts.wait.partials.length;
  }
  return res;
}

/**
 * The whole pipeline in one call. When no DOM could be read, the innerText is
 * still turned into a response - flagged, so a flattened reply is never
 * mistaken for a structured one.
 */
export function pipeline(raw: RawResponse, hints: BlockHints, opts: StructureOptions): AIResponse {
  const d = toDomResponse(raw);
  if (!d) {
    const text = raw.innerText.trim();
    const res = toStructured({
      provider: raw.provider,
      content: { text, markdown: text, code: [], tables: [], links: [], citations: [] },
      artifacts: [], attachments: [], url: raw.url, capturedAt: raw.capturedAt,
    }, opts);
    res.extraction_metadata.warnings.push("no DOM snapshot - text only, structure lost");
    return res;
  }
  const res = toStructured(normalize(toSemantic(d, hints)), { ...opts, meta: { ...opts.meta, domNodes: countNodes(d.dom) } });
  // Cross-check: the structured text should account for what the page shows.
  const shown = raw.innerText.replace(/\s+/g, " ").trim().length;
  const got = (res.content.text + " " + (res.reasoning ? res.reasoning.text : "")).replace(/\s+/g, " ").trim().length;
  if (shown > 50 && got < shown * 0.6) {
    res.extraction_metadata.warnings.push("structured text covers " + Math.round((got / shown) * 100) + "% of the visible text - a hint or chain may be dropping content");
  }
  return res;
}
