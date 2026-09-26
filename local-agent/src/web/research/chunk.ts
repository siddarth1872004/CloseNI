/**
 * Pages into evidence-sized pieces, split where the page itself splits.
 *
 *   page → section → paragraph group → chunk
 *
 * A fixed token window cuts a table in half and glues the end of one topic to
 * the start of the next. Chunks here follow the section tree, group adjacent
 * paragraphs up to a size, and keep code blocks and tables whole. Every chunk
 * carries its URL, title, heading path, position and retrieval time, so it can
 * always be quoted back to where it came from.
 */
import { Block, blocksToText, blocksToMarkdown } from "../semantic/blocks.js";
import { Chunk, WebPage } from "./types.js";
import { hashText } from "../util.js";
import { cleanUrl } from "./url.js";

export interface ChunkOptions {
  /** Soft target; a chunk closes at the first paragraph boundary past this. */
  targetChars?: number;
  /** A single paragraph longer than this is split at sentence boundaries. */
  maxChars?: number;
}

function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = "";
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    if (cur && (cur + " " + s).length > max) { out.push(cur); cur = s; } else cur = cur ? cur + " " + s : s;
  }
  if (cur) out.push(cur);
  return out;
}

export function chunkPage(page: WebPage, opts: ChunkOptions = {}): Chunk[] {
  const target = opts.targetChars ?? 900;
  const max = opts.maxChars ?? 2000;
  const chunks: Chunk[] = [];
  let position = 0;
  const emit = (text: string, headingPath: string[], offset: number, kind: Chunk["kind"]) => {
    const t = text.trim();
    if (t.length < 20 && kind === "prose") return;
    chunks.push({
      id: hashText(page.canonical_url + "|" + position + "|" + t.slice(0, 80)),
      url: cleanUrl(page.final_url || page.url),
      title: page.title,
      headingPath,
      text: t,
      position: position++,
      offset,
      source_type: page.source_type,
      retrieved_at: page.fetched_at,
      kind,
    });
  };
  for (const s of page.sections) {
    let group: string[] = [];
    let groupLen = 0;
    const flush = () => {
      if (group.length) emit((s.heading ? s.heading + "\n\n" : "") + group.join("\n\n"), s.path, s.offset, "prose");
      group = []; groupLen = 0;
    };
    for (const b of s.blocks as Block[]) {
      if (b.type === "code" || b.type === "table") {
        flush();
        const body = b.type === "code" ? blocksToMarkdown([b]) : blocksToMarkdown([b]);
        emit((s.heading ? s.heading + "\n\n" : "") + body, s.path, s.offset, b.type === "code" ? "code" : "table");
        continue;
      }
      const text = blocksToText([b]);
      if (!text.trim()) continue;
      for (const piece of splitLong(text, max)) {
        if (groupLen && groupLen + piece.length > target) flush();
        group.push(piece);
        groupLen += piece.length;
      }
    }
    flush();
  }
  return chunks;
}
