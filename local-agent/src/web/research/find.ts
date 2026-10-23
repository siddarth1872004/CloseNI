/**
 * Find-in-page for a researcher: "where does this page discuss authentication?"
 * answered without sending the whole page anywhere.
 *
 * Modes, from strictest to loosest:
 *   exact | ci (case-insensitive) | regex | keywords (all words, any order) |
 *   heading (section headings) | section (whole sections by heading match) |
 *   code (code blocks) | table (tables, by header or cell) | semantic (BM25 over
 *   sections, with light term expansion)
 *
 * Every hit returns its heading path and a short context window, so the caller
 * can decide what to read in full.
 */
import { WebPage } from "./types.js";
import { blocksToText } from "../semantic/blocks.js";
import { Bm25 } from "./relevance.js";
import { tokens } from "../util.js";

export type FindMode = "exact" | "ci" | "regex" | "keywords" | "heading" | "section" | "code" | "table" | "semantic";

export interface FindHit {
  mode: FindMode;
  headingPath: string[];
  /** The matched text, and some text around it. */
  match: string;
  context: string;
  /** Offset within the section's text. */
  offset: number;
  score?: number;
}

/** Small, explicit synonym expansion for the semantic mode. Not a thesaurus - just enough to connect common phrasings. */
const EXPAND: Record<string, string[]> = {
  authentication: ["auth", "login", "token", "oauth", "credentials", "sign-in"],
  auth: ["authentication", "token", "oauth", "login"],
  install: ["installation", "setup", "npm", "pip"],
  limit: ["limits", "quota", "rate", "throttle", "429"],
  rate: ["limit", "limits", "quota", "throttle"],
  performance: ["speed", "benchmark", "throughput", "latency", "fast"],
  price: ["pricing", "cost", "plan"],
  error: ["errors", "exception", "failure", "fails"],
};

function window(text: string, at: number, len: number, pad: number = 80): string {
  const s = Math.max(0, at - pad), e = Math.min(text.length, at + len + pad);
  return (s > 0 ? "…" : "") + text.slice(s, e).replace(/\s+/g, " ") + (e < text.length ? "…" : "");
}

export function findInPage(page: WebPage, query: string, mode: FindMode = "semantic", limit: number = 10): FindHit[] {
  const hits: FindHit[] = [];
  const sections = page.sections.map((s) => ({ s, text: blocksToText(s.blocks) }));

  if (mode === "exact" || mode === "ci" || mode === "regex") {
    let re: RegExp;
    try {
      re = mode === "regex" ? new RegExp(query, "g")
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), mode === "ci" ? "gi" : "g");
    } catch { return []; }
    for (const { s, text } of sections) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) && hits.length < limit) {
        hits.push({ mode, headingPath: s.path, match: m[0], context: window(text, m.index, m[0].length), offset: m.index });
        if (m[0].length === 0) re.lastIndex++;
      }
    }
    return hits;
  }

  if (mode === "keywords") {
    const want = tokens(query);
    for (const { s, text } of sections) {
      const lower = text.toLowerCase();
      if (!want.every((w) => lower.includes(w))) continue;
      const at = lower.indexOf(want[0]);
      hits.push({ mode, headingPath: s.path, match: want.join(" "), context: window(text, at, want[0].length, 160), offset: at });
    }
    return hits.slice(0, limit);
  }

  if (mode === "heading" || mode === "section") {
    const want = tokens(query);
    for (const { s, text } of sections) {
      const h = tokens(s.heading);
      const n = want.filter((w) => h.includes(w)).length;
      if (!n) continue;
      hits.push({ mode, headingPath: s.path, match: s.heading, context: mode === "section" ? text : window(text, 0, 0, 200), offset: 0, score: n / want.length });
    }
    return hits.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, limit);
  }

  if (mode === "code") {
    const q = query.toLowerCase();
    for (const c of page.code_blocks) {
      const at = c.text.toLowerCase().indexOf(q);
      if (at < 0 && q) continue;
      hits.push({ mode, headingPath: c.headingPath, match: q ? c.text.substr(at, q.length) : c.lang, context: c.text.slice(0, 400), offset: Math.max(0, at) });
    }
    return hits.slice(0, limit);
  }

  if (mode === "table") {
    const q = query.toLowerCase();
    for (const t of page.tables) {
      const flat = [t.header.join(" | "), ...t.rows.map((r) => r.join(" | "))].join("\n");
      const at = flat.toLowerCase().indexOf(q);
      if (at < 0) continue;
      hits.push({ mode, headingPath: t.headingPath, match: flat.substr(at, q.length), context: flat, offset: at });
    }
    return hits.slice(0, limit);
  }

  // semantic: BM25 over sections with the query expanded a little.
  const base = tokens(query);
  const expanded = base.concat(base.flatMap((w) => EXPAND[w] || []));
  const bm = new Bm25(sections.map(({ s, text }) => s.heading + " " + s.heading + " " + text));
  const scored = sections.map(({ s, text }, i) => ({ s, text, score: bm.score(i, expanded) })).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score);
  for (const x of scored.slice(0, limit)) {
    const lower = x.text.toLowerCase();
    const first = expanded.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
    hits.push({ mode, headingPath: x.s.path, match: x.s.heading, context: window(x.text, first, 0, 200), offset: first, score: Number(x.score.toFixed(3)) });
  }
  return hits;
}
