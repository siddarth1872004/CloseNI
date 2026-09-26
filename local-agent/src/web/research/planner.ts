/**
 * From a research request to subquestions, and from subquestions to queries.
 *
 * The decomposition is derived from the question itself, not a fixed template:
 *
 *   comparison  "compare X, Y and Z for …", "X vs Y"   → per-entity × per-aspect
 *   multi-part  several questions, "; ", "and also"    → one subquestion each
 *   single      everything else                          → the question, plus an
 *               "official documentation" angle when the subject looks technical
 *
 * Aspects come from the question's own words ("performance", "for production")
 * and only fall back to a small generic set when it names none. A model can
 * refine the plan (decomposeWithModel); the heuristic plan is kept alongside, so
 * a model that returns nonsense narrows nothing.
 */
import { ResearchPlan, SearchQuery, SearchStrategy, Subquestion } from "./types.js";
import { stem, tokens } from "../util.js";

/** Aspect words a question may name, mapped to the phrase searched for. */
const ASPECTS: Record<string, string> = {
  architecture: "architecture", design: "architecture", internals: "architecture",
  performance: "performance", speed: "performance", latency: "performance", benchmark: "performance", benchmarks: "performance", throughput: "performance",
  limitation: "limitations", limitations: "limitations", drawbacks: "limitations", downsides: "limitations", issues: "known issues", problems: "known issues", bugs: "known issues",
  security: "security", auth: "authentication", authentication: "authentication",
  cost: "pricing", price: "pricing", pricing: "pricing",
  deployment: "deployment", deploy: "deployment", production: "production use", scaling: "scalability", scalability: "scalability",
  ecosystem: "ecosystem", community: "ecosystem", plugins: "plugins", integrations: "integrations",
  license: "license", licensing: "license",
  "rate": "rate limits", limits: "rate limits", quota: "rate limits",
  installation: "installation", install: "installation", setup: "installation",
  api: "API", documentation: "official documentation", docs: "official documentation",
};

const GENERIC_COMPARISON_ASPECTS = ["overview", "limitations"];

function cleanEntity(s: string): string {
  return s.replace(/^(the|a|an)\s+/i, "").replace(/[?.!,;:]+$/, "").replace(/\s+/g, " ").trim();
}

/** "compare X, Y and Z for W" / "X vs Y" / "difference between X and Y" → [X,Y,Z], purpose. */
export function detectComparison(q: string): { entities: string[]; purpose: string } | null {
  const text = q.replace(/\s+/g, " ").trim();
  let m = /\b(?:compare|comparing|comparison of)\s+(.+?)(?:\s+(?:for|in|when|on|regarding|with respect to)\s+(.+))?[?.]?$/i.exec(text);
  let list = "", purpose = "";
  if (m) { list = m[1]; purpose = m[2] || ""; }
  else if ((m = /\b(?:difference|differences)\s+between\s+(.+?)(?:\s+(?:for|in|when)\s+(.+))?[?.]?$/i.exec(text))) { list = m[1]; purpose = m[2] || ""; }
  else if (/\s(?:vs\.?|versus)\s/i.test(text)) {
    const parts = text.split(/\s+(?:vs\.?|versus)\s+/i);
    const last = parts[parts.length - 1];
    const pm = /^(.+?)\s+(?:for|in|when)\s+(.+)$/i.exec(last);
    if (pm) { parts[parts.length - 1] = pm[1]; purpose = pm[2]; }
    const lead = /^(?:which is better[,:]?\s*|what is better[,:]?\s*)/i;
    parts[0] = parts[0].replace(lead, "");
    list = parts.join(", ");
  }
  if (!list) return null;
  const entities = list.split(/\s*,\s*|\s+and\s+|\s+or\s+|\s*&\s*/i).map(cleanEntity).filter((e) => e && e.split(" ").length <= 6);
  if (entities.length < 2) return null;
  return { entities: Array.from(new Set(entities)), purpose: cleanEntity(purpose) };
}

function aspectsIn(text: string): string[] {
  const out: string[] = [];
  for (const w of tokens(text)) { const a = ASPECTS[w]; if (a && !out.includes(a)) out.push(a); }
  return out;
}

const TECHNICAL = /\b(api|sdk|library|framework|engine|cli|protocol|database|server|compiler|runtime|package|module|version|config|configure|install|deploy|error|exception|stack ?trace|python|javascript|typescript|rust|go|java|node|react|docker|kubernetes)\b/i;

/** Which strategies suit a subquestion, from its words. Ordered: first is tried first. */
export function strategiesFor(text: string): SearchStrategy[] {
  const t = text.toLowerCase();
  const s: SearchStrategy[] = [];
  if (/"[^"]{3,}"/.test(text)) s.push("exact");
  if (/\bsite:\S+/.test(text)) s.push("site");
  if (/\b(official|vendor|announcement)\b/.test(t)) s.push("official");
  if (/\b(docs?|documentation|api|reference|how to|configure|install|setup|usage)\b/.test(t)) s.push("documentation");
  if (/\b(github|repo|repository|source code|library|package|open.source|implementation)\b/.test(t)) s.push("github");
  if (/\b(paper|study|research|arxiv|survey|evaluation|peer.reviewed)\b/.test(t)) s.push("academic");
  if (/\b(news|announced|launch|release[sd]?|latest|recent|today|this (week|month|year)|20\d\d)\b/.test(t)) { s.push("news"); s.push("recency"); }
  if (/\b(error|exception|stack ?trace|crash|fails?|bug|segfault|traceback)\b/.test(t)) s.push("technical");
  if (TECHNICAL.test(text) && !s.includes("documentation")) s.push("documentation");
  s.push("broad");
  return Array.from(new Set(s));
}

function focusOf(text: string): string[] {
  return tokens(text).filter((w) => !/^(overview|limitations|official|documentation|known|issues|use)$/.test(w));
}

export function decompose(question: string): ResearchPlan {
  const q = question.trim();
  const subs: Subquestion[] = [];
  const add = (text: string) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (!t || subs.some((s) => s.text.toLowerCase() === t.toLowerCase())) return;
    subs.push({ id: "sq" + (subs.length + 1), text: t, strategies: strategiesFor(t), focus: focusOf(t) });
  };

  const cmp = detectComparison(q);
  if (cmp) {
    const named = aspectsIn(q);
    const aspects = named.length ? named : GENERIC_COMPARISON_ASPECTS;
    for (const e of cmp.entities) {
      for (const a of aspects) add(e + " " + a);
      add(e + " official documentation");
    }
    // Cross-cutting: the purpose itself, compared.
    if (cmp.purpose) add(cmp.entities.join(" vs ") + " " + cmp.purpose);
    return annotateDistinctive({ question: q, subquestions: subs, method: "heuristic" });
  }

  const parts = q.split(/\?\s+|;\s+|\s+and also\s+|\n+|(?:^|\s)\d+[.)]\s+/).map((s) => s.trim()).filter((s) => s.length > 3);
  if (parts.length > 1) {
    for (const p of parts) add(p.replace(/\?$/, ""));
  } else {
    add(q.replace(/\?$/, ""));
    const aspects = aspectsIn(q);
    // A named aspect gets its own angle only when the question has more than one.
    if (aspects.length > 1) for (const a of aspects) add(subjectOf(q) + " " + a);
  }
  if (TECHNICAL.test(q) && !subs.some((s) => /documentation/i.test(s.text))) add(subjectOf(q) + " official documentation");
  return annotateDistinctive({ question: q, subquestions: subs, method: "heuristic" });
}

/** The question's main noun phrase, crudely: its content words minus question words. */
function subjectOf(q: string): string {
  return tokens(q).filter((w) => !ASPECTS[w]).slice(0, 5).join(" ");
}

/**
 * Ask a model to refine the plan. The model sees the heuristic plan and may add
 * or rephrase subquestions; its output is merged, never trusted alone.
 */
export async function decomposeWithModel(question: string, ask: (prompt: string) => Promise<string>, maxSubs: number = 8): Promise<ResearchPlan> {
  const base = decompose(question);
  const prompt =
    "Break this research question into at most " + maxSubs + " focused search subquestions. " +
    "Reply with JSON only, shaped {\"subquestions\": [\"...\", \"...\"]}. No prose.\n\n" +
    "Question: " + question + "\n\nA draft decomposition to improve on:\n" + base.subquestions.map((s) => "- " + s.text).join("\n");
  let raw = "";
  try { raw = await ask(prompt); } catch { return base; }
  const m = /\{[\s\S]*\}/.exec(raw);
  let list: string[] = [];
  try { const parsed = JSON.parse(m ? m[0] : raw); list = Array.isArray(parsed.subquestions) ? parsed.subquestions.map(String) : []; } catch { list = []; }
  if (!list.length) return base;
  const merged: Subquestion[] = [];
  const add = (text: string) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (t.length < 4 || t.length > 200) return;
    const tw = new Set(tokens(t));
    // Near-duplicates of an existing subquestion are dropped.
    if (merged.some((s) => { const sw = tokens(s.text); const inter = sw.filter((w) => tw.has(w)).length; return inter / Math.max(1, Math.min(sw.length, tw.size)) > 0.8; })) return;
    merged.push({ id: "sq" + (merged.length + 1), text: t, strategies: strategiesFor(t), focus: focusOf(t) });
  };
  for (const t of list.slice(0, maxSubs)) add(t);
  for (const s of base.subquestions) add(s.text);
  return annotateDistinctive({ question, subquestions: merged.slice(0, Math.max(maxSubs, base.subquestions.length)), method: "model+heuristic" });
}

/** The query text for one subquestion under one strategy. */
export function queryFor(sub: Subquestion, strategy: SearchStrategy, now: Date = new Date()): SearchQuery {
  const t = sub.text;
  let text = t;
  let site: string | undefined;
  switch (strategy) {
    case "exact": {
      const quoted = /"([^"]{3,})"/.exec(t);
      text = quoted ? "\"" + quoted[1] + "\"" : "\"" + sub.focus.slice(0, 4).join(" ") + "\"";
      break;
    }
    case "site": {
      const sm = /\bsite:(\S+)/.exec(t);
      site = sm ? sm[1] : undefined;
      text = t.replace(/\bsite:\S+/, "").trim() + (site ? " site:" + site : "");
      break;
    }
    case "official": text = t.replace(/\bofficial\b/i, "").trim() + " official"; break;
    case "documentation": text = /documentation|docs/i.test(t) ? t : t + " documentation"; break;
    case "github": text = sub.focus.slice(0, 4).join(" "); break;
    case "academic": text = t + " paper"; break;
    case "news": text = t + " news"; break;
    case "recency": text = t + " " + now.getFullYear(); break;
    case "technical": text = t; break;
    case "broad": default: text = t;
  }
  return { text: text.replace(/\s+/g, " ").trim(), strategy, subquestionId: sub.id, ...(site ? { site } : {}) };
}

/**
 * Mark each subquestion's distinctive focus: words it has that most of its
 * siblings do not. With two, that is the words only one of them has - the
 * "install" in "how do I install X" beside an "X official documentation" angle.
 */
export function annotateDistinctive(plan: ResearchPlan): ResearchPlan {
  const subs = plan.subquestions;
  if (subs.length < 2) return plan;
  const df = new Map<string, number>();
  for (const s of subs) for (const w of new Set(s.focus.map(stem))) df.set(w, (df.get(w) || 0) + 1);
  for (const s of subs) {
    s.distinctive = Array.from(new Set(s.focus.map(stem))).filter((w) => (df.get(w) || 0) <= subs.length / 2);
  }
  return plan;
}
