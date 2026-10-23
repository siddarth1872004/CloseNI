/**
 * Research as a graph, so every statement can be traced to where it came from.
 *
 *   research ─has→ subquestion ─searched→ query ─found→ result ─opened→ source
 *   source ─contains→ evidence ─asserts→ claim        conflict ─between→ evidence
 *   source ─links→ source
 *
 * Nodes are keyed by stable ids (canonical URL for sources, claim hash for
 * claims) so the same page found by three queries is one node with three
 * incoming edges - which is also how "found by several independent searches"
 * becomes visible.
 */
import { Claim, Conflict, Evidence, SearchQuery, SearchResult, Subquestion, WebPage } from "./types.js";
import { canonicalizeUrl } from "./url.js";

export type NodeKind = "research" | "subquestion" | "query" | "result" | "source" | "evidence" | "claim" | "conflict";
export type EdgeKind = "has" | "searched" | "found" | "opened" | "contains" | "asserts" | "between" | "links" | "answers";

export interface GraphNode { id: string; kind: NodeKind; label: string; data?: Record<string, unknown> }
export interface GraphEdge { from: string; to: string; kind: EdgeKind }

export class SourceGraph {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges: GraphEdge[] = [];
  private edgeKeys = new Set<string>();

  constructor(readonly question: string) {
    this.add({ id: "research", kind: "research", label: question });
  }

  private add(n: GraphNode): string {
    const existing = this.nodes.get(n.id);
    if (existing) { if (n.data) existing.data = { ...(existing.data || {}), ...n.data }; return n.id; }
    this.nodes.set(n.id, n);
    return n.id;
  }

  link(from: string, to: string, kind: EdgeKind): void {
    const k = from + "|" + to + "|" + kind;
    if (this.edgeKeys.has(k)) return;
    this.edgeKeys.add(k);
    this.edges.push({ from, to, kind });
  }

  addSubquestion(s: Subquestion): string {
    const id = this.add({ id: "sq:" + s.id, kind: "subquestion", label: s.text, data: { strategies: s.strategies } });
    this.link("research", id, "has");
    return id;
  }

  addQuery(q: SearchQuery, backend: string): string {
    const id = this.add({ id: "q:" + backend + ":" + q.strategy + ":" + q.text, kind: "query", label: q.text, data: { strategy: q.strategy, backend } });
    this.link("sq:" + q.subquestionId, id, "searched");
    return id;
  }

  addResult(queryId: string, r: SearchResult): string {
    const id = this.add({ id: "r:" + r.canonical_url, kind: "result", label: r.title, data: { url: r.url, rank: r.relevance.rank, domain: r.domain } });
    this.link(queryId, id, "found");
    return id;
  }

  addSource(page: WebPage, fromResult?: string): string {
    const id = this.add({ id: "s:" + page.canonical_url, kind: "source", label: page.title || page.url,
      data: { url: page.final_url, type: page.source_type, published: page.published_at, retrieved: page.fetched_at } });
    if (fromResult) this.link(fromResult, id, "opened");
    return id;
  }

  addSourceLink(from: WebPage, toUrl: string): void {
    const to = "s:" + canonicalizeUrl(toUrl);
    if (this.nodes.has(to)) this.link("s:" + from.canonical_url, to, "links");
  }

  addEvidence(e: Evidence): string {
    const src = "s:" + canonicalizeUrl(e.provenance.url);
    const claim = this.addClaim(e.claim);
    const id = this.add({ id: "e:" + e.id, kind: "evidence", label: e.provenance.span.text.slice(0, 120),
      data: { url: e.provenance.url, section: e.provenance.section, span: [e.provenance.span.start, e.provenance.span.end] } });
    if (this.nodes.has(src)) this.link(src, id, "contains");
    this.link(id, claim, "asserts");
    if (e.claim.subquestionId) this.link(id, "sq:" + e.claim.subquestionId, "answers");
    return id;
  }

  addClaim(c: Claim): string {
    return this.add({ id: "c:" + c.id, kind: "claim", label: c.text.slice(0, 160) });
  }

  addConflict(c: Conflict): string {
    const id = this.add({ id: "x:" + c.id, kind: "conflict", label: c.context, data: { kind: c.kind, topic: c.topic } });
    this.link(id, "e:" + c.a.id, "between");
    this.link(id, "e:" + c.b.id, "between");
    return id;
  }

  /** claim → evidence → sources. */
  trace(claimId: string): { claim?: GraphNode; evidence: GraphNode[]; sources: GraphNode[] } {
    const cid = claimId.startsWith("c:") ? claimId : "c:" + claimId;
    const ev = this.edges.filter((e) => e.to === cid && e.kind === "asserts").map((e) => this.nodes.get(e.from)!).filter(Boolean);
    const srcIds = new Set(this.edges.filter((e) => e.kind === "contains" && ev.some((x) => x.id === e.to)).map((e) => e.from));
    return { claim: this.nodes.get(cid), evidence: ev, sources: Array.from(srcIds).map((s) => this.nodes.get(s)!).filter(Boolean) };
  }

  /** How many independent queries reached a source. */
  discoveryCount(sourceUrl: string): number {
    const sid = "s:" + canonicalizeUrl(sourceUrl);
    const results = this.edges.filter((e) => e.to === sid && e.kind === "opened").map((e) => e.from);
    return new Set(this.edges.filter((e) => e.kind === "found" && results.includes(e.to)).map((e) => e.from)).size;
  }

  stats(): Record<NodeKind, number> {
    const s: any = { research: 0, subquestion: 0, query: 0, result: 0, source: 0, evidence: 0, claim: 0, conflict: 0 };
    for (const n of this.nodes.values()) s[n.kind]++;
    return s;
  }

  toJSON(): { question: string; nodes: GraphNode[]; edges: GraphEdge[] } {
    return { question: this.question, nodes: Array.from(this.nodes.values()), edges: this.edges };
  }

  /** Mermaid, for the report. Sources and conflicts only - the full graph is unreadable. */
  toMermaid(maxSources: number = 12): string {
    const lines = ["graph LR", '  R["' + esc(this.question.slice(0, 60)) + '"]'];
    const sq = Array.from(this.nodes.values()).filter((n) => n.kind === "subquestion");
    sq.forEach((n, i) => { lines.push("  Q" + i + '["' + esc(n.label.slice(0, 50)) + '"]'); lines.push("  R --> Q" + i); });
    const sources = Array.from(this.nodes.values()).filter((n) => n.kind === "source").slice(0, maxSources);
    sources.forEach((s, i) => {
      lines.push("  S" + i + '(["' + esc(s.label.slice(0, 40)) + '"])');
      const evIds = this.edges.filter((e) => e.from === s.id && e.kind === "contains").map((e) => e.to);
      const qs = new Set(this.edges.filter((e) => e.kind === "answers" && evIds.includes(e.from)).map((e) => e.to));
      sq.forEach((q, k) => { if (qs.has(q.id)) lines.push("  Q" + k + " -.-> S" + i); });
    });
    return lines.join("\n");
  }
}

function esc(s: string): string { return s.replace(/"/g, "'").replace(/[\[\]{}<>]/g, " "); }
