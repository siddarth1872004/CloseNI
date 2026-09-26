/**
 * When sources disagree, say so - never pick one quietly.
 *
 * Two kinds are detected, conservatively:
 *
 *   numeric   same topic, same unit, different value
 *             "allows 100 requests per minute" vs "allows 60 requests per minute"
 *   polarity  same statement, one negated
 *             "supports OAuth" vs "does not support OAuth"
 *
 * "Same topic" means the claims share most of their non-numeric words. That is
 * a heuristic, and it errs toward missing a conflict rather than inventing one:
 * a false conflict tells the model to doubt a fact that was fine.
 *
 * Evidence from the same page never conflicts with itself, and near-duplicate
 * pages (mirrors) are the same source, so they are not set against each other.
 */
import { Conflict, Evidence } from "./types.js";
import { canonicalizeUrl } from "./url.js";
import { hashText, tokens } from "../util.js";

const STRIP = /\b(not|no|never|none|cannot|can't|doesn't|does|isn't|is|are|aren't|was|were|won't|without)\b/gi;

function topicWords(text: string): Set<string> {
  return new Set(tokens(text.replace(/\d[\d,.]*/g, " ").replace(STRIP, " ")));
}

function similarity(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.max(1, Math.min(a.size, b.size));
}

export interface ConflictOptions {
  /** Topic similarity required. */
  minSimilarity?: number;
  /** Relative difference below which two numbers agree (rounding, "about"). */
  tolerance?: number;
  /** URLs known to be the same source (mirror → representative). */
  sameSource?: (a: string, b: string) => boolean;
}

export function detectConflicts(evidence: Evidence[], opts: ConflictOptions = {}): Conflict[] {
  const minSim = opts.minSimilarity ?? 0.6;
  const tol = opts.tolerance ?? 0.02;
  const out: Conflict[] = [];
  const seen = new Set<string>();
  const words = evidence.map((e) => topicWords(e.claim.text));
  for (let i = 0; i < evidence.length; i++) {
    for (let j = i + 1; j < evidence.length; j++) {
      const a = evidence[i], b = evidence[j];
      if (canonicalizeUrl(a.provenance.url) === canonicalizeUrl(b.provenance.url)) continue;
      if (opts.sameSource && opts.sameSource(a.provenance.url, b.provenance.url)) continue;
      const sim = similarity(words[i], words[j]);
      if (sim < minSim) continue;
      let kind: Conflict["kind"] | null = null;
      let context = "";
      for (const qa of a.claim.quantities) {
        const qb = b.claim.quantities.find((q) => q.unit === qa.unit && q.unit !== "");
        if (!qb) continue;
        const diff = Math.abs(qa.value - qb.value) / Math.max(Math.abs(qa.value), Math.abs(qb.value), 1e-9);
        if (diff > tol) { kind = "numeric"; context = qa.raw + " vs " + qb.raw + " (" + qa.unit + ")"; break; }
      }
      if (!kind && a.claim.negated !== b.claim.negated && sim >= 0.75 && !a.claim.quantities.length && !b.claim.quantities.length) {
        kind = "polarity";
        context = "one source asserts, the other denies";
      }
      if (!kind) continue;
      const key = [a.claim.id, b.claim.id].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const topic = Array.from(words[i]).filter((w) => words[j].has(w)).slice(0, 6).join(" ");
      out.push({ id: hashText("conflict|" + key), topic, a, b, kind, context });
    }
  }
  return out;
}
