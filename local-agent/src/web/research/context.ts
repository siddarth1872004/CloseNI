/**
 * What the model is shown: the question, then only the evidence that answers
 * it, each line citing its source by number.
 *
 *   question → relevant sources → relevant sections → evidence → dedupe → order → text
 *
 * Pages are never dumped in. Evidence is chosen per subquestion so a
 * well-covered subquestion cannot crowd out a thin one, duplicates are dropped,
 * conflicts get their own section so the model is told that sources disagree,
 * and subquestions with no evidence are listed as gaps rather than left for the
 * model to fill from memory.
 */
import { Conflict, Evidence, ResearchPlan } from "./types.js";
import { canonicalizeUrl } from "./url.js";
import { Bm25 } from "./relevance.js";
import { stems } from "../util.js";

export interface Citation { n: number; url: string; title: string; source_type: string; published_at?: string; retrieved_at: string }

export interface BuiltContext {
  text: string;
  citations: Citation[];
  includedEvidence: string[];
  omitted: number;
  gaps: string[];
  chars: number;
}

export interface ContextOptions {
  maxChars?: number;
  perSubquestion?: number;
  publishedAt?: Record<string, string>;
}

export const SYNTHESIS_INSTRUCTIONS =
  "Answer the research question using ONLY the evidence below. Cite every factual " +
  "statement with its source number in square brackets, like [2]. Where the " +
  "evidence lists a conflict, say that the sources disagree and give both values " +
  "with their citations - do not pick one silently. Where a subquestion is listed " +
  "under gaps, say it could not be answered from the sources found. Do not use " +
  "knowledge that is not in the evidence.";

export function buildContext(plan: ResearchPlan, evidence: Evidence[], conflicts: Conflict[], opts: ContextOptions = {}): BuiltContext {
  const maxChars = opts.maxChars ?? 12000;
  const per = opts.perSubquestion ?? 6;
  const citations: Citation[] = [];
  const citeIndex = new Map<string, number>();
  const cite = (e: Evidence): number => {
    const key = canonicalizeUrl(e.provenance.url);
    let n = citeIndex.get(key);
    if (!n) {
      n = citations.length + 1;
      citeIndex.set(key, n);
      const pub = opts.publishedAt && opts.publishedAt[e.provenance.url];
      citations.push({ n, url: e.provenance.url, title: e.provenance.title, source_type: e.provenance.source_type, ...(pub ? { published_at: pub } : {}), retrieved_at: e.provenance.retrieved_at });
    }
    return n;
  };

  const lines: string[] = [];
  const included: string[] = [];
  const gaps: string[] = [];
  let omitted = 0;
  const body: string[] = [];

  for (const sq of plan.subquestions) {
    // Deduplicated within a subquestion. A sentence that answers two
    // subquestions appears under both - hiding it from the second would
    // report that subquestion as a gap it is not.
    const seenClaims = new Set<string>();
    const ev = evidence.filter((e) => e.claim.subquestionId === sq.id);
    // Ranked again here, across every page at once. Chunk scores were computed
    // page by page, and BM25 over a one-chunk page is on a different scale
    // from BM25 over a twenty-chunk page, so they cannot be compared directly.
    const texts = ev.map((e) => e.claim.text + " " + e.provenance.section.join(" "));
    const bm = new Bm25(texts);
    const q = stems(sq.text + " " + (sq.distinctive || []).join(" "));
    const score = new Map<Evidence, number>();
    ev.forEach((e, i) => score.set(e, bm.score(i, q) + (e.claim.quantities.length ? 0.2 : 0)));
    ev.sort((a, b) => (score.get(b) || 0) - (score.get(a) || 0));
    const picked: Evidence[] = [];
    const bySource = new Map<string, number>();
    for (const e of ev) {
      const norm = e.claim.text.toLowerCase().replace(/\s+/g, " ");
      if (seenClaims.has(norm)) continue;
      const src = canonicalizeUrl(e.provenance.url);
      if ((bySource.get(src) || 0) >= Math.ceil(per / 2)) continue; // no single source dominates
      picked.push(e);
      seenClaims.add(norm);
      bySource.set(src, (bySource.get(src) || 0) + 1);
      if (picked.length >= per) break;
    }
    omitted += ev.length - picked.length;
    if (!picked.length) { gaps.push(sq.text); continue; }
    body.push("## " + sq.text);
    for (const e of picked) {
      const n = cite(e);
      const where = e.provenance.section.length ? " (" + e.provenance.section.slice(-2).join(" > ") + ")" : "";
      body.push("- " + e.claim.text + " [" + n + "]" + where);
      included.push(e.id);
    }
    body.push("");
  }

  const conflictLines: string[] = [];
  for (const c of conflicts) {
    const na = cite(c.a), nb = cite(c.b);
    conflictLines.push("- " + (c.kind === "numeric" ? "Numbers differ" : "Sources contradict") + " on \"" + c.topic + "\": " +
      JSON.stringify(c.a.claim.text) + " [" + na + "] vs " + JSON.stringify(c.b.claim.text) + " [" + nb + "] - " + c.context);
  }

  lines.push("Research question: " + plan.question, "");
  lines.push("Sources:");
  for (const c of citations) lines.push("[" + c.n + "] " + (c.title || c.url) + " - " + c.url + " (" + c.source_type + (c.published_at ? ", published " + c.published_at : "") + ")");
  lines.push("", "Evidence:", "");
  lines.push(...body);
  if (conflictLines.length) lines.push("Conflicts between sources:", ...conflictLines, "");
  if (gaps.length) lines.push("Gaps (no evidence found):", ...gaps.map((g) => "- " + g), "");

  // Trim evidence lines from the end until it fits; the header and conflicts stay.
  let text = lines.join("\n");
  while (text.length > maxChars) {
    const idx = lines.map((l, i) => (l.startsWith("- ") && !l.includes("] vs ") ? i : -1)).filter((i) => i >= 0).pop();
    if (idx === undefined) break;
    lines.splice(idx, 1);
    omitted++;
    text = lines.join("\n");
  }
  return { text, citations, includedEvidence: included, omitted, gaps, chars: text.length };
}

/** Which [n] citations an answer used, and which of those do not exist. */
export function checkCitations(answer: string, citations: Citation[]): { used: number[]; invalid: number[]; uncitedSentences: number } {
  const used = new Set<number>();
  for (const m of answer.matchAll(/\[(\d{1,3})\]/g)) used.add(Number(m[1]));
  const valid = new Set(citations.map((c) => c.n));
  const invalid = Array.from(used).filter((n) => !valid.has(n));
  const sentences = answer.split(/(?<=[.!?])\s+/).filter((s) => s.length > 40 && /\d|is|are|was|were/.test(s));
  const uncited = sentences.filter((s) => !/\[\d{1,3}\]/.test(s)).length;
  return { used: Array.from(used).sort((a, b) => a - b), invalid, uncitedSentences: uncited };
}
