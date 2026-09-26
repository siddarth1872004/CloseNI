/**
 * From relevant chunks to claims a synthesis can cite, each pinned to its exact
 * source span.
 *
 *   claim → evidence → chunk → section → page → URL
 *
 * A claim here is one sentence from a source that states something about the
 * question's focus - not a paraphrase. Keeping the source's own words is what
 * makes the provenance exact: the span offsets point at the sentence as the page
 * printed it, so any statement in the final answer can be checked by reading
 * that span.
 */
import { Claim, Evidence, ScoredChunk, Subquestion } from "./types.js";
import { hashText, sentences, stem, stems, tokens } from "../util.js";

const NEGATION = /\b(not|no|never|none|cannot|can't|doesn't|does not|isn't|is not|aren't|are not|won't|without|lacks?|unsupported|deprecated|removed)\b/i;
const VERBISH = /\b(is|are|was|were|has|have|had|supports?|allows?|handles?|returns?|requires?|uses?|runs?|provides?|includes?|adds?|added|released|expires?|limits?|takes?|costs?|renders?|batches|register|registers|rewritten|changed|became|can|will|must|should|needs?|install|installs|installed|configure[sd]?|enables?|creates?|calls?|sets?)\b/i;

/** Numbers with the words right after them as the unit: "100 requests per minute". */
export function quantities(sentence: string): Claim["quantities"] {
  const out: Claim["quantities"] = [];
  const re = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(\s*%|\s*(?:ms|s|kb|mb|gb|tb|x)\b)?((?:\s+[a-zA-Z][\w-]*){0,3})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sentence))) {
    const raw = m[0].trim();
    const num = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(num)) continue;
    // Version numbers are identifiers, not measurements.
    if (/^\d+\.\d+$/.test(m[1]) && /version|v\d|release/i.test(sentence.slice(Math.max(0, m.index - 12), m.index))) continue;
    let unit = (m[2] || "").trim().toLowerCase();
    const after = tokens(m[3] || "").slice(0, 3).join(" ");
    if (!unit) unit = /^(19|20)\d{2}$/.test(m[1]) && !after ? "year" : after;
    out.push({ value: num, unit, raw });
  }
  return out;
}

/** The claim's subject: its leading content words, before the verb. */
function subjectOf(sentence: string): string {
  const v = VERBISH.exec(sentence);
  const head = v ? sentence.slice(0, v.index) : sentence;
  return tokens(head).slice(-5).join(" ");
}

export function toClaim(sentence: string, subquestionId?: string): Claim {
  return {
    id: hashText("claim|" + sentence.toLowerCase().replace(/\s+/g, " ")),
    text: sentence,
    subject: subjectOf(sentence),
    quantities: quantities(sentence),
    negated: NEGATION.test(sentence),
    ...(subquestionId ? { subquestionId } : {}),
  };
}

export interface EvidenceOptions {
  /** Share of the focus words a sentence must contain. */
  minFocus?: number;
  maxPerChunk?: number;
}

/**
 * Sentences from ranked chunks that speak to a subquestion.
 *
 * A sentence qualifies when it mentions enough of the subquestion's focus and
 * reads like a statement (has a verb, or carries a number). Headings and
 * navigation fragments do neither.
 */
export function extractEvidence(ranked: ScoredChunk[], sub: Subquestion, opts: EvidenceOptions = {}): Evidence[] {
  const focus = new Set((sub.focus.length ? sub.focus : tokens(sub.text)).map(stem));
  const minFocus = opts.minFocus ?? (focus.size <= 2 ? 1 / Math.max(1, focus.size) : 0.34);
  const maxPer = opts.maxPerChunk ?? 3;
  const distinctive = sub.distinctive || [];
  const out: Evidence[] = [];
  for (const sc of ranked) {
    const c = sc.chunk;
    // Code is not a claim. It stays in the page model and find-in-page.
    if (c.kind === "code") continue;
    // A sentence under a heading is about that heading: "allows 100 requests
    // per minute" under "Rate limits" answers a question about rate limits.
    const context = new Set(stems(c.headingPath.join(" ")));
    let taken = 0;
    for (const cand of candidates(c.text, c.kind, c.headingPath)) {
      const s = cand.text;
      if (s.length < 20 || s.length > 600) continue;
      const words = new Set(stems(s));
      let hit = 0;
      for (const f of focus) if (words.has(f) || context.has(f)) hit++;
      if (!focus.size || hit / focus.size < minFocus) continue;
      // It must also say something itself, not just sit under a good heading.
      if (!Array.from(focus).some((f) => words.has(f)) && !quantities(s).length) continue;
      // And it must touch what makes this subquestion different from its
      // siblings - in the sentence or its heading - or every sentence about the
      // shared subject would count as evidence for every subquestion.
      if (distinctive.length && !distinctive.some((d) => words.has(d) || context.has(d))) continue;
      const q = quantities(s);
      if (!VERBISH.test(s) && !q.length) continue;
      const claim = toClaim(s, sub.id);
      out.push({
        id: hashText("ev|" + claim.id + "|" + c.url + "|" + sub.id),
        claim,
        chunkId: c.id,
        signals: sc.signals,
        provenance: { url: c.url, title: c.title, section: c.headingPath, span: cand.span, retrieved_at: c.retrieved_at, source_type: c.source_type },
      });
      if (++taken >= maxPer) break;
    }
  }
  return out;
}

/**
 * Statement-sized pieces of a chunk, each with its exact span.
 *
 * Prose: split into paragraphs first (a heading line is its own paragraph and
 * is never glued to the sentence after it), then sentences. Tables: one
 * statement per row, "Header: value; Header: value", spanning the row's line.
 */
function candidates(text: string, kind: string, headingPath: string[]): Array<{ text: string; span: { start: number; end: number; text: string } }> {
  const out: Array<{ text: string; span: { start: number; end: number; text: string } }> = [];
  const heading = headingPath[headingPath.length - 1] || "";
  if (kind === "table") {
    const lines = text.split("\n");
    let offset = 0;
    let header: string[] = [];
    for (const line of lines) {
      const start = offset;
      offset += line.length + 1;
      if (!/^\|/.test(line)) continue;
      const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (cells.every((c) => /^-+$/.test(c))) continue;
      if (!header.length) { header = cells; continue; }
      const stmt = (heading ? heading + ": " : "") + cells.map((v, i) => (header[i] ? header[i] + " " : "") + v).join("; ");
      out.push({ text: stmt, span: { start, end: start + line.length, text: line } });
    }
    return out;
  }
  let offset = 0;
  for (const para of text.split("\n\n")) {
    const pStart = offset;
    offset += para.length + 2;
    const trimmed = para.trim();
    if (!trimmed || trimmed === heading) continue;
    let from = 0;
    for (const s of sentences(para)) {
      const at = para.indexOf(s.slice(0, Math.min(30, s.length)), from);
      const start = at >= 0 ? pStart + at : -1;
      if (at >= 0) from = at + 1;
      out.push({ text: s, span: start >= 0 ? { start, end: start + s.length, text: text.slice(start, start + s.length) } : { start: -1, end: -1, text: s } });
    }
  }
  return out;
}
