/**
 * How relevant is each chunk to a question - as signals, not a score.
 *
 * BM25 over the chunk set gives lexical relevance; heading and title matches,
 * query-term coverage, source type, freshness and position are reported beside
 * it. Nothing collapses these into a universal "quality" number: ordering uses
 * them in a stated order (coverage-weighted lexical first), and every consumer
 * can see why a chunk ranked where it did.
 */
import { Chunk, RelevanceSignals, ScoredChunk, SourceType } from "./types.js";
import { stem, stems, tokens } from "../util.js";

export interface RankOptions {
  k1?: number;
  b?: number;
  /** ISO dates by URL, for freshness. */
  publishedAt?: Record<string, string>;
  now?: Date;
}

/** BM25 statistics for a fixed set of documents. */
export class Bm25 {
  private df = new Map<string, number>();
  private docs: string[][];
  private avgLen: number;

  constructor(texts: string[], private k1: number = 1.2, private b: number = 0.75) {
    this.docs = texts.map((t) => stems(t));
    for (const d of this.docs) for (const w of new Set(d)) this.df.set(w, (this.df.get(w) || 0) + 1);
    this.avgLen = this.docs.reduce((s, d) => s + d.length, 0) / Math.max(1, this.docs.length);
  }

  score(i: number, queryWords: string[]): number {
    const query = queryWords.map(stem);
    const d = this.docs[i];
    if (!d || !d.length) return 0;
    const tf = new Map<string, number>();
    for (const w of d) tf.set(w, (tf.get(w) || 0) + 1);
    const N = this.docs.length;
    let s = 0;
    for (const q of new Set(query)) {
      const f = tf.get(q) || 0;
      if (!f) continue;
      const n = this.df.get(q) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * d.length / this.avgLen));
    }
    return s;
  }
}

function overlap(a: string[], b: Set<string>): number {
  if (!a.length) return 0;
  let n = 0;
  for (const w of new Set(a)) if (b.has(w)) n++;
  return n / new Set(a).size;
}

/** How much a source type is worth for a given strategy - a tie-breaker, stated openly. */
const TYPE_ORDER: SourceType[] = ["documentation", "official", "academic", "code-repository", "encyclopedia", "news", "blog", "forum", "unknown", "ai-answer", "search-engine"];

export function rankChunks(chunks: Chunk[], question: string, opts: RankOptions = {}): ScoredChunk[] {
  const q = tokens(question);
  const qs = stems(question);
  const bm = new Bm25(chunks.map((c) => c.text), opts.k1, opts.b);
  const now = (opts.now || new Date()).getTime();
  const scored: ScoredChunk[] = chunks.map((c, i) => {
    const words = new Set(stems(c.text));
    const pub = opts.publishedAt && opts.publishedAt[c.url];
    const days = pub && !isNaN(Date.parse(pub)) ? Math.round((now - Date.parse(pub)) / 86400000) : undefined;
    const signals: RelevanceSignals = {
      lexical: bm.score(i, q),
      headingMatch: overlap(qs, new Set(stems(c.headingPath.join(" ")))),
      titleMatch: overlap(qs, new Set(stems(c.title))),
      coverage: overlap(qs, words),
      sourceType: c.source_type,
      ...(days !== undefined ? { freshnessDays: days } : {}),
      position: c.position,
    };
    return { chunk: c, signals, order: 0 };
  });
  scored.sort((a, b) => {
    // Stated order: lexical relevance scaled by how many query terms appear,
    // then heading match, then source type, then earlier in the page.
    const pa = a.signals.lexical * (0.5 + a.signals.coverage) + a.signals.headingMatch;
    const pb = b.signals.lexical * (0.5 + b.signals.coverage) + b.signals.headingMatch;
    if (Math.abs(pb - pa) > 1e-9) return pb - pa;
    const ta = TYPE_ORDER.indexOf(a.signals.sourceType), tb = TYPE_ORDER.indexOf(b.signals.sourceType);
    if (ta !== tb) return ta - tb;
    return a.signals.position - b.signals.position;
  });
  scored.forEach((s, i) => (s.order = i));
  return scored;
}

/** A chunk is relevant at all when it shares meaningful terms with the question. */
export function isRelevant(s: ScoredChunk, minCoverage: number = 0.25): boolean {
  return s.signals.lexical > 0 && (s.signals.coverage >= minCoverage || s.signals.headingMatch >= 0.5);
}
