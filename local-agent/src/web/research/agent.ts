/**
 * The research loop.
 *
 *   PLAN → SEARCH → OPEN → EXTRACT → EVALUATE → enough? ─yes→ SYNTHESISE
 *                    ↑                              │
 *                    └──── new query for the gap ←──┘ no
 *
 * Not "search five times, then answer": each round searches only for the
 * subquestions still uncovered, with a strategy not yet tried for them (broad →
 * documentation → exact → …), follows the links that the pages themselves point
 * to when those links look relevant, and measures what the round added.
 *
 * Stops when every subquestion is supported by enough evidence from enough
 * distinct sources and the sources are diverse enough - or when a round adds
 * little that is new (diminishing returns), or a budget runs out: rounds,
 * queries, pages, time, context size. Every limit is configurable, and the
 * report says which one ended the run.
 *
 * The AI website is only the last step: it is handed the built context and
 * asked to answer from it with citations. Without one, the synthesis is
 * extractive - the evidence itself, grouped and cited - which is also what the
 * tests use, since no AI site is reachable from the machine this was built on.
 */
import { Evidence, ResearchPlan, SearchQuery, SearchResult, Subquestion, WebPage, Chunk } from "./types.js";
import { decompose, decomposeWithModel, queryFor } from "./planner.js";
import { SearchBackend, SearchOutcome, aggregate } from "./search.js";
import { WebFetcher, FetchOutcome } from "./fetcher.js";
import { chunkPage } from "./chunk.js";
import { rankChunks, isRelevant } from "./relevance.js";
import { extractEvidence } from "./evidence.js";
import { detectConflicts } from "./conflicts.js";
import { nearDuplicate } from "./dedupe.js";
import { judgeLinks, Frontier } from "./links.js";
import { SourceGraph } from "./graph.js";
import { BrowserMemory, ResearchMemory } from "./memory.js";
import { buildContext, BuiltContext, checkCitations, SYNTHESIS_INSTRUCTIONS } from "./context.js";
import { ResearchCaches } from "./cache.js";
import { canonicalizeUrl, siteOf } from "./url.js";
import { AIResponse } from "../providers/ai-web-provider.js";
import { Tracer, quietTracer } from "../trace.js";
import { nowMs } from "../util.js";

export interface ResearchBudget {
  maxRounds: number;
  maxQueries: number;
  maxPages: number;
  maxTimeMs: number;
  maxContextChars: number;
  resultsPerQuery: number;
  pagesPerSubquestionPerRound: number;
  followLinksPerRound: number;
  maxLinkDepth: number;
  minEvidencePerSubquestion: number;
  minSourcesPerSubquestion: number;
  minDistinctSites: number;
  /** A round adding fewer new evidence items than this share of the total is diminishing. */
  diminishingReturns: number;
  concurrency: number;
}

export const DEFAULT_BUDGET: ResearchBudget = {
  maxRounds: 4,
  maxQueries: 24,
  maxPages: 30,
  maxTimeMs: 5 * 60 * 1000,
  maxContextChars: 12000,
  resultsPerQuery: 8,
  pagesPerSubquestionPerRound: 3,
  followLinksPerRound: 4,
  maxLinkDepth: 2,
  minEvidencePerSubquestion: 2,
  minSourcesPerSubquestion: 1,
  minDistinctSites: 1,
  diminishingReturns: 0.1,
  concurrency: 3,
};

export interface Synthesizer { ask(prompt: string): Promise<AIResponse> }

export interface ResearchDeps {
  backends: SearchBackend[];
  fetcher: WebFetcher;
  synthesizer?: Synthesizer;
  /** When set, the plan is refined by a model (decomposeWithModel). */
  planWith?: (prompt: string) => Promise<string>;
  tracer?: Tracer;
  caches?: ResearchCaches;
}

export type StopReason = "sufficient" | "diminishing-returns" | "exhausted" | "max-rounds" | "max-queries" | "max-pages" | "time-budget" | "no-backends";

export interface RoundReport {
  round: number;
  queries: Array<{ text: string; strategy: string; backend: string; status: string; results: number }>;
  opened: Array<{ url: string; ok: boolean; mode: string; error?: string; via: "search" | "link" }>;
  newEvidence: number;
  coverage: Record<string, { evidence: number; sources: number; covered: boolean }>;
  durationMs: number;
}

export interface ResearchReport {
  question: string;
  plan: ResearchPlan;
  stopReason: StopReason;
  rounds: RoundReport[];
  answer: { text: string; via: "model" | "extractive"; citations: BuiltContext["citations"]; check?: ReturnType<typeof checkCitations>; response?: AIResponse; warnings: string[] };
  context: BuiltContext;
  evidence: Evidence[];
  conflicts: ReturnType<typeof detectConflicts>;
  coverage: Record<string, { text: string; evidence: number; sources: number; sites: number; covered: boolean }>;
  budget: ResearchBudget;
  used: { rounds: number; queries: number; pages: number; timeMs: number };
  graph: ReturnType<SourceGraph["toJSON"]>;
  graphMermaid: string;
  memory: { visited: number; failed: Array<{ url: string; reason: string; kind: string }>; queries: BrowserMemory["queries"] };
  cache?: ReturnType<ResearchCaches["stats"]>;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export class ResearchAgent {
  private readonly tracer: Tracer;
  private budget: ResearchBudget;

  constructor(private deps: ResearchDeps, budget: Partial<ResearchBudget> = {}) {
    this.tracer = deps.tracer || quietTracer();
    this.budget = { ...DEFAULT_BUDGET, ...budget };
  }

  async run(question: string): Promise<ResearchReport> {
    const t0 = nowMs();
    const B = this.budget;
    const plan = this.deps.planWith ? await decomposeWithModel(question, this.deps.planWith) : decompose(question);
    const graph = new SourceGraph(question);
    const bmem = new BrowserMemory();
    const rmem = new ResearchMemory();
    const frontier = new Frontier({ maxDepth: B.maxLinkDepth, maxPerDomain: Math.max(4, Math.ceil(B.maxPages / 2)), maxTotal: B.maxPages * 3 });
    const tried = new Map<string, Set<string>>();
    const pages = new Map<string, WebPage>();
    const pageDepth = new Map<string, number>();
    const mirrorOf = new Map<string, string>(); // canonical → representative canonical
    const publishedAt: Record<string, string> = {};
    const rounds: RoundReport[] = [];
    let queriesUsed = 0;
    let pagesUsed = 0;
    let stop: StopReason = "max-rounds";
    for (const s of plan.subquestions) { graph.addSubquestion(s); tried.set(s.id, new Set()); }
    this.tracer.event({ action: "research-plan", result: "info", detail: plan.method + ": " + plan.subquestions.map((s) => s.text).join(" | ") });
    if (!this.deps.backends.length) stop = "no-backends";

    const coverage = () => {
      const out: ResearchReport["coverage"] = {};
      for (const s of plan.subquestions) {
        const ev = rmem.forSubquestion(s.id);
        const srcs = new Set(ev.map((e) => mirrorOf.get(canonicalizeUrl(e.provenance.url)) || canonicalizeUrl(e.provenance.url)));
        const sites = new Set(ev.map((e) => siteOf(e.provenance.url)));
        out[s.id] = { text: s.text, evidence: ev.length, sources: srcs.size, sites: sites.size,
          covered: ev.length >= B.minEvidencePerSubquestion && srcs.size >= B.minSourcesPerSubquestion };
      }
      return out;
    };

    const extractFrom = (page: WebPage): number => {
      const cacheKey = page.content_hash;
      let chunks: Chunk[] | undefined = this.deps.caches ? this.deps.caches.chunks.get(cacheKey) : undefined;
      if (!chunks) {
        chunks = chunkPage(page);
        if (this.deps.caches) this.deps.caches.chunks.set(cacheKey, chunks);
      }
      const found: Evidence[] = [];
      for (const s of plan.subquestions) {
        const ranked = rankChunks(chunks, s.text + " " + s.focus.join(" "), { publishedAt }).filter((x) => isRelevant(x));
        found.push(...extractEvidence(ranked.slice(0, 6), s));
      }
      const fresh = rmem.addEvidence(found);
      for (const e of found) graph.addEvidence(e);
      return fresh;
    };

    const accept = (o: FetchOutcome, via: "search" | "link", resultNode?: string, depth: number = 0): RoundReport["opened"][number] => {
      const rec = { url: o.url, ok: o.ok, mode: o.mode, via, ...(o.error ? { error: o.error } : {}) };
      if (!o.ok || !o.page) {
        bmem.fail(o.url, o.error || "failed", String(o.errorKind || "unknown"));
        return rec;
      }
      const p = o.page;
      const c = p.canonical_url;
      bmem.visit({ url: p.final_url, at: p.fetched_at, title: p.title, mode: o.mode, ok: true });
      frontier.markVisited(o.url);
      frontier.markVisited(p.final_url);
      if (pages.has(c)) return rec;
      // A mirror or syndicated copy is the same source: remember it as such so
      // it neither counts twice nor "conflicts" with its original.
      for (const [oc, other] of pages) {
        if (nearDuplicate(p.main_text, other.main_text, 0.8).duplicate) { mirrorOf.set(c, mirrorOf.get(oc) || oc); break; }
      }
      pages.set(c, p);
      pageDepth.set(c, depth);
      if (p.published_at) publishedAt[p.final_url] = p.published_at;
      graph.addSource(p, resultNode);
      return rec;
    };

    for (let round = 1; stop !== "no-backends"; round++) {
      const rt = nowMs();
      if (round > B.maxRounds) { stop = "max-rounds"; break; }
      if (nowMs() - t0 > B.maxTimeMs) { stop = "time-budget"; break; }
      const cov = coverage();
      const uncovered = plan.subquestions.filter((s) => !cov[s.id].covered);
      if (!uncovered.length && this.diverse(rmem)) { stop = "sufficient"; break; }

      // SEARCH - one untried strategy per uncovered subquestion.
      const planned: Array<{ q: SearchQuery; backend: SearchBackend; sub: Subquestion }> = [];
      for (const s of (uncovered.length ? uncovered : plan.subquestions)) {
        const done = tried.get(s.id)!;
        const strategy = s.strategies.find((st) => !done.has(st));
        if (!strategy) continue;
        done.add(strategy);
        const q = queryFor(s, strategy);
        const capable = this.deps.backends.filter((b) => b.supports(strategy));
        const use = capable.length ? capable : this.deps.backends.filter((b) => b.supports("broad"));
        for (const b of use) planned.push({ q, backend: b, sub: s });
      }
      if (!planned.length) { stop = "exhausted"; break; }
      const budgetLeft = B.maxQueries - queriesUsed;
      if (budgetLeft <= 0) { stop = "max-queries"; break; }
      const toRun = planned.slice(0, budgetLeft);
      queriesUsed += toRun.length;
      const outcomes: SearchOutcome[] = await mapLimit(toRun, B.concurrency, async (p) => {
        const cacheKey = p.backend.id + "|" + p.q.strategy + "|" + p.q.text;
        const hit = this.deps.caches ? this.deps.caches.search.get(cacheKey) : undefined;
        if (hit) return hit as SearchOutcome;
        const o = await p.backend.search(p.q, B.resultsPerQuery);
        if (this.deps.caches && o.status === "ok") this.deps.caches.search.set(cacheKey, o);
        return o;
      });
      const queryNodes = new Map<string, string>();
      for (const o of outcomes) {
        const qid = graph.addQuery(o.query, o.backend);
        queryNodes.set(o.backend + "|" + o.query.text, qid);
        for (const r of o.results) graph.addResult(qid, r);
        bmem.queries.push({ text: o.query.text, backend: o.backend, strategy: o.query.strategy, results: o.results.length, status: o.status });
      }
      const agg = aggregate(outcomes);

      // OPEN - the best unvisited results for each uncovered subquestion.
      const toOpen: Array<{ r: SearchResult; node?: string }> = [];
      const chosen = new Set<string>();
      for (const s of (uncovered.length ? uncovered : plan.subquestions)) {
        let n = 0;
        for (const r of agg.results) {
          if (n >= B.pagesPerSubquestionPerRound) break;
          const subs = (r.metadata.subquestions as string[]) || [String(r.metadata.subquestion)];
          if (!subs.includes(s.id)) continue;
          if (chosen.has(r.canonical_url) || pages.has(r.canonical_url) || frontier.hasVisited(r.url) || bmem.shouldSkip(r.url)) continue;
          chosen.add(r.canonical_url);
          const qn = queryNodes.get(r.relevance.backend + "|" + r.search_query);
          toOpen.push({ r, node: qn ? "r:" + r.canonical_url : undefined });
          n++;
        }
      }
      const room = Math.max(0, B.maxPages - pagesUsed);
      const opening = toOpen.slice(0, room);
      pagesUsed += opening.length;
      const openedRecs: RoundReport["opened"] = [];
      const fetched = await mapLimit(opening, B.concurrency, (x) => this.deps.fetcher.fetch(x.r.url));
      let fresh = 0;
      fetched.forEach((o, i) => {
        openedRecs.push(accept(o, "search", opening[i].node, 0));
        if (o.ok && o.page && pages.get(o.page.canonical_url) === o.page) fresh += extractFrom(o.page);
      });

      // FOLLOW - links the pages point to, judged against what is still missing.
      const stillMissing = plan.subquestions.filter((s) => !coverage()[s.id].covered);
      if (stillMissing.length && B.followLinksPerRound > 0 && pagesUsed < B.maxPages) {
        const objective = stillMissing.map((s) => s.text).join(" ");
        for (const o of fetched) {
          if (!o.ok || !o.page) continue;
          const depth = (pageDepth.get(o.page.canonical_url) || 0) + 1;
          for (const j of judgeLinks(o.page, objective)) {
            if (j.decision === "IGNORE") continue;
            const prio = (j.decision === "FOLLOW" ? 2 : 1) + j.signals.anchor + j.signals.url;
            frontier.push(j.link.href, depth, prio, o.page.final_url);
          }
        }
        const follow: Array<{ url: string; depth: number; from?: string }> = [];
        while (follow.length < B.followLinksPerRound && frontier.size && pagesUsed + follow.length < B.maxPages) {
          const n = frontier.pop()!;
          if (pages.has(canonicalizeUrl(n.url)) || bmem.shouldSkip(n.url)) continue;
          follow.push(n);
        }
        pagesUsed += follow.length;
        const got = await mapLimit(follow, B.concurrency, (f) => this.deps.fetcher.fetch(f.url));
        got.forEach((o, i) => {
          const rec = accept(o, "link", undefined, follow[i].depth);
          openedRecs.push(rec);
          if (o.ok && o.page && pages.get(o.page.canonical_url) === o.page) {
            bmem.clicked.push({ from: follow[i].from || "", to: o.page.final_url, reason: "link judged relevant" });
            const fromPage = follow[i].from ? pages.get(canonicalizeUrl(follow[i].from as string)) : undefined;
            if (fromPage) graph.addSourceLink(fromPage, o.page.final_url);
            fresh += extractFrom(o.page);
          }
        });
      }

      // EVALUATE
      const covNow = coverage();
      const total = rmem.all().length;
      rounds.push({
        round,
        queries: outcomes.map((o) => ({ text: o.query.text, strategy: o.query.strategy, backend: o.backend, status: o.status, results: o.results.length })),
        opened: openedRecs,
        newEvidence: fresh,
        coverage: Object.fromEntries(Object.entries(covNow).map(([k, v]) => [k, { evidence: v.evidence, sources: v.sources, covered: v.covered }])),
        durationMs: nowMs() - rt,
      });
      this.tracer.event({ action: "research-round", result: "info", durationMs: nowMs() - rt,
        detail: "round " + round + ": " + outcomes.length + " queries, " + openedRecs.length + " pages, +" + fresh + " evidence, covered " +
          Object.values(covNow).filter((c) => c.covered).length + "/" + plan.subquestions.length });
      if (plan.subquestions.every((s) => covNow[s.id].covered) && this.diverse(rmem)) { stop = "sufficient"; break; }
      if (round >= 2 && total > 0 && fresh < Math.max(1, B.diminishingReturns * total)) { stop = "diminishing-returns"; break; }
      if (pagesUsed >= B.maxPages) { stop = "max-pages"; break; }
      if (queriesUsed >= B.maxQueries) { stop = "max-queries"; break; }
    }

    // SYNTHESISE
    const evidence = rmem.all();
    const conflicts = detectConflicts(evidence, {
      sameSource: (a, b) => {
        const ca = canonicalizeUrl(a), cb = canonicalizeUrl(b);
        return (mirrorOf.get(ca) || ca) === (mirrorOf.get(cb) || cb);
      },
    });
    for (const c of conflicts) graph.addConflict(c);
    const context = buildContext(plan, evidence, conflicts, { maxChars: B.maxContextChars, publishedAt });
    const answer = await this.synthesise(plan, context);
    const cov = coverage();
    return {
      question,
      plan,
      stopReason: stop,
      rounds,
      answer,
      context,
      evidence,
      conflicts,
      coverage: cov,
      budget: B,
      used: { rounds: rounds.length, queries: queriesUsed, pages: pagesUsed, timeMs: nowMs() - t0 },
      graph: graph.toJSON(),
      graphMermaid: graph.toMermaid(),
      memory: { visited: bmem.visited.length, failed: Array.from(bmem.failed.entries()).map(([url, f]) => ({ url, reason: f.reason, kind: f.kind })), queries: bmem.queries },
      ...(this.deps.caches ? { cache: this.deps.caches.stats() } : {}),
    };
  }

  private diverse(rmem: ResearchMemory): boolean {
    const sites = new Set(rmem.all().map((e) => siteOf(e.provenance.url)));
    return sites.size >= this.budget.minDistinctSites;
  }

  private async synthesise(plan: ResearchPlan, ctx: BuiltContext): Promise<ResearchReport["answer"]> {
    const warnings: string[] = [];
    if (this.deps.synthesizer && ctx.citations.length) {
      try {
        const res = await this.deps.synthesizer.ask(SYNTHESIS_INSTRUCTIONS + "\n\n" + ctx.text);
        const text = res.content.markdown || res.content.text;
        if (res.status !== "failed" && res.status !== "empty" && text.trim()) {
          const check = checkCitations(text, ctx.citations);
          if (check.invalid.length) warnings.push("the answer cites sources that do not exist: " + check.invalid.join(", "));
          if (!check.used.length) warnings.push("the answer cites no sources");
          return { text, via: "model", citations: ctx.citations, check, response: res, warnings };
        }
        warnings.push("the AI site returned no usable answer (" + res.status + "); falling back to extractive synthesis");
      } catch (err: any) {
        warnings.push("synthesis failed: " + String(err && err.message || err) + "; falling back to extractive synthesis");
      }
    }
    return { text: extractive(plan, ctx), via: "extractive", citations: ctx.citations, warnings };
  }
}

/** The evidence itself, grouped by subquestion and cited - no model involved. */
export function extractive(plan: ResearchPlan, ctx: BuiltContext): string {
  const lines = ["# " + plan.question, ""];
  const body = ctx.text.split("\nEvidence:\n")[1] || "";
  lines.push(body.trim());
  lines.push("", "## Sources");
  for (const c of ctx.citations) lines.push("[" + c.n + "] " + (c.title || c.url) + " - " + c.url);
  return lines.join("\n");
}
