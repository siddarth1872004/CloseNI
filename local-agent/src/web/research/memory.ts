/**
 * What a multi-step research run remembers, so it does not rediscover it.
 *
 * Browser memory is short-term and mechanical: where it has been, what it
 * searched, what it clicked, what failed and why. Research memory is what it
 * learned: claims, evidence, sources, contradictions, and the questions still
 * open. Both are plain data, serialisable into the report.
 */
import { Conflict, Evidence } from "./types.js";
import { canonicalizeUrl } from "./url.js";

export interface VisitRecord { url: string; at: string; title: string; mode: string; ok: boolean }

export class BrowserMemory {
  readonly visited: VisitRecord[] = [];
  readonly queries: Array<{ text: string; backend: string; strategy: string; results: number; status: string }> = [];
  readonly clicked: Array<{ from: string; to: string; reason: string }> = [];
  readonly failed = new Map<string, { reason: string; kind: string; attempts: number }>();
  readonly extractedFacts: string[] = [];
  current = "";

  visit(r: VisitRecord): void {
    this.visited.push(r);
    this.current = r.url;
  }

  fail(url: string, reason: string, kind: string): void {
    const k = canonicalizeUrl(url);
    const prev = this.failed.get(k);
    this.failed.set(k, { reason, kind, attempts: (prev ? prev.attempts : 0) + 1 });
  }

  /** A URL that failed for a reason retrying cannot fix is not tried again. */
  shouldSkip(url: string): boolean {
    const f = this.failed.get(canonicalizeUrl(url));
    return !!f && (f.kind === "blocked" || f.kind === "dns" || f.kind === "tls" || f.attempts >= 2);
  }

  previous(n: number = 5): string[] {
    return this.visited.slice(-n - 1, -1).map((v) => v.url);
  }
}

export class ResearchMemory {
  readonly evidence = new Map<string, Evidence>();
  readonly conflicts = new Map<string, Conflict>();
  readonly sources = new Set<string>();
  readonly openQuestions = new Set<string>();

  /** Returns how many of these were new - the diminishing-returns signal. */
  addEvidence(list: Evidence[]): number {
    let fresh = 0;
    for (const e of list) {
      // The same claim from the same source for the same subquestion is one
      // piece of evidence however many times it is found.
      // Keyed per subquestion too: one sentence can answer two of them.
      const key = e.claim.id + "|" + canonicalizeUrl(e.provenance.url) + "|" + (e.claim.subquestionId || "");
      if (this.evidence.has(key)) continue;
      this.evidence.set(key, e);
      this.sources.add(canonicalizeUrl(e.provenance.url));
      fresh++;
    }
    return fresh;
  }

  forSubquestion(id: string): Evidence[] {
    return Array.from(this.evidence.values()).filter((e) => e.claim.subquestionId === id);
  }

  all(): Evidence[] { return Array.from(this.evidence.values()); }
}
