/**
 * Read a plan the provider wrote as prose.
 *
 * The planning prompt asks for JSON, and the parser plus one re-ask handle
 * almost every reply. What is left is the reply that answers the question well
 * and ignores the format twice: a numbered list, "Step 1: ..." headings, files
 * mentioned in passing. Rejecting it fails the whole flow over presentation.
 *
 * The work is split by what each part can be trusted with:
 *
 * - **Where the steps are** is found here, deterministically: numbered markers
 *   in sequence, outside code fences. A model is not asked to count.
 * - **Each step's detail** is the step's own text, verbatim. It is sent back to
 *   the provider when the step runs, and a paraphrase would lose what it said.
 * - **Title, files and testable** come from the extractor, one small record per
 *   step, because those need reading rather than matching. Every file it names
 *   must appear in that step's text, or it is dropped: a path the model made up
 *   would become a file a step is told to own.
 * - **Dependencies are not extracted.** Prose declares no graph, and a guessed
 *   one would let steps run at the same time that must not. A rescued plan is a
 *   chain, which is what an undeclared graph already falls back to.
 *
 * A rescue that got nothing from the extractor returns null rather than a
 * purely mechanical plan: it runs only when extraction is switched on, and the
 * switch should not quietly mean something else.
 *
 * Known limit, found while building this: the controller's reply reader
 * (`extractLatestResponse`) keeps only leaf text, so a live page's `<ol>` loses
 * its numbers and a paragraph like "<b>Step 1:</b> create app.py" loses
 * everything outside the bold. "Step N" headings survive; plain numbered lists
 * do not. That reader feeds every build prompt, so fixing it is its own change.
 */
import { MAX_PLAN_STEPS } from "../plan-scale.js";
import { normaliseDependsOn } from "../parser/json-repair.js";
import { StructuredExtractor, usable } from "./extractor.js";

export interface ProseStep {
  number: number;
  heading: string;
  body: string;
}

export interface ProsePlan {
  preamble: string;
  steps: ProseStep[];
  /** What follows the last step: sign-off, run instructions. */
  tail: string;
}

const STEP_RE = /^\s{0,3}(?:#{1,6}\s*)?(?:[*_]{1,2}\s*)?step\s+(\d{1,2})\b\s*(?:[*_]{1,2})?\s*[:.)\-–—]?\s*(.*)$/i;
const NUM_RE = /^([ \t]*)(?:#{1,6}\s*)?(?:[*_]{1,2}\s*)?(\d{1,2})[.)]\s+(.*)$/;

/**
 * The name part of a marker line. "**Step 1: Setup** - create app.py" names
 * the step "Setup": the heading ends where the bold does, or at the first dash
 * or colon that introduces the description.
 */
function cleanHeading(s: string): string {
  const name = s.split(/\*\*|__|\s[-–—]\s|:\s/)[0];
  return name.replace(/[*_`#]+/g, "").replace(/\s+/g, " ").replace(/[:\-–—\s]+$/, "").trim().slice(0, 100);
}

/**
 * Where the last step ends. Nothing marks it: the reply just carries on, often
 * with "Run it with: ..." or "Let me know if ...". A blank line followed by
 * text at the margin that is not a list item is taken as the plan's closing
 * words, not the step's - otherwise a run command in the sign-off would become
 * a file the last step owns.
 */
function endOfLastStep(lines: string[], from: number): number {
  for (let i = from + 1; i < lines.length - 1; i++) {
    if (lines[i].trim() !== "") continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    if (j >= lines.length) return i;
    const next = lines[j];
    if (/^\S/.test(next) && !/^([-*+]\s|\d{1,2}[.)]\s|```|~~~)/.test(next)) return i;
  }
  return lines.length;
}

/**
 * Find the plan's steps in prose. Null when there is no sequence of at least
 * two numbered steps - a lone "1." is a list item, not a plan.
 */
export function segmentPlanProse(input: string): ProsePlan | null {
  const text = typeof input === "string" ? input : String(input ?? "");
  const lines = text.split(/\r?\n/);
  let inFence = false;
  const stepMarkers: { line: number; n: number; heading: string }[] = [];
  const numMarkers: { line: number; n: number; heading: string; indent: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const s = line.match(STEP_RE);
    if (s) { stepMarkers.push({ line: i, n: parseInt(s[1], 10), heading: cleanHeading(s[2]) }); continue; }
    const m = line.match(NUM_RE);
    if (m) numMarkers.push({ line: i, n: parseInt(m[2], 10), heading: cleanHeading(m[3]), indent: m[1].replace(/\t/g, "    ").length });
  }

  // "Step N" is unambiguous and wins outright. Plain numbers only count at the
  // outermost indent, so a numbered list inside a step stays part of that step.
  let markers: { line: number; n: number; heading: string }[];
  if (stepMarkers.length >= 2) markers = stepMarkers;
  else {
    if (numMarkers.length < 2) return null;
    const minIndent = Math.min(...numMarkers.map((m) => m.indent));
    markers = numMarkers.filter((m) => m.indent === minIndent);
  }

  // The longest run counting up from 0 or 1. A second list further down - "to
  // run it: 1. install 2. start" - starts a new run and loses to the plan.
  const runs: typeof markers[] = [];
  let cur: typeof markers = [];
  for (const m of markers) {
    if (cur.length && m.n === cur[cur.length - 1].n + 1) cur.push(m);
    else if (m.n === 0 || m.n === 1) { if (cur.length) runs.push(cur); cur = [m]; }
  }
  if (cur.length) runs.push(cur);
  let best: typeof markers = [];
  for (const r of runs) if (r.length > best.length) best = r;
  if (best.length < 2) return null;

  const lastEnd = endOfLastStep(lines, best[best.length - 1].line);
  const steps: ProseStep[] = best.map((m, i) => {
    const end = i + 1 < best.length ? best[i + 1].line : lastEnd;
    return { number: m.n, heading: m.heading, body: lines.slice(m.line, end).join("\n").trim() };
  });
  return {
    preamble: lines.slice(0, best[0].line).join("\n").trim(),
    steps: steps,
    tail: lines.slice(lastEnd).join("\n").trim(),
  };
}

const SOURCE_EXT = new Set([
  "py", "pyi", "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "html", "htm", "css", "scss", "sass", "less",
  "md", "txt", "toml", "yaml", "yml", "cfg", "ini", "env", "sql", "rs", "go", "mod", "java", "kt", "kts",
  "gradle", "c", "h", "cc", "cpp", "hpp", "cs", "csproj", "rb", "php", "sh", "bash", "bat", "ps1", "xml",
  "vue", "svelte", "lock", "dart", "swift", "lua", "r", "ipynb", "csv", "svg",
]);
const BARE_FILES = new Set(["Dockerfile", "Makefile", "Procfile", "Gemfile", "Rakefile", "LICENSE"]);
const PATH_RE = /(?:^|[\s`'"(\[*])((?:\.\/)?(?:[\w@.-]+\/)*[\w.-]*\w)(?=$|[\s`'",;:)\]*!?]|\.(?:\s|$))/g;

function normPath(p: string): string {
  return p.trim().replace(/^[`'"]+|[`'".,;:]+$/g, "").replace(/^\.\//, "").replace(/\\/g, "/");
}

function looksLikeFile(p: string): boolean {
  if (!p || p.length > 200 || /:\/\//.test(p) || p.startsWith("/")) return false;
  const base = p.split("/").pop() || "";
  if (BARE_FILES.has(base)) return true;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 && !(base.startsWith(".") && base.length > 1)) return false;
  const ext = base.substring(dot + 1).toLowerCase();
  return SOURCE_EXT.has(ext) || (base.startsWith(".") && dot === 0);
}

/** Paths named in a piece of text, in order, without guessing at any. */
export function pathsIn(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text)) !== null) {
    const p = normPath(m[1]);
    if (looksLikeFile(p) && out.indexOf(p) === -1) out.push(p);
  }
  return out;
}

function squash(s: string): string {
  return s.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
}

/** Whether a value the model returned is actually in the text it was given. */
export function grounded(value: string, text: string): boolean {
  const v = squash(value);
  return v.length > 0 && squash(text).indexOf(v) !== -1;
}

export const STEP_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "A short name for this step, a few words." },
    files: {
      type: "array",
      items: { type: "string" },
      description: "Paths of the files this step creates or edits, copied exactly as written.",
    },
    testable: {
      type: "boolean",
      description: "True when the step produces behaviour worth a test: a calculation, a parser, a route, a state change. False for scaffolding, configuration, dependency lists and static assets.",
    },
  },
  required: ["title"],
};

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "The goal of the project in one sentence." },
    run_command: { type: "string", description: "The single shell command that starts the finished project, copied exactly." },
  },
};

/** What the extractor is shown of one step: enough to read, small enough to fit. */
export const STEP_TEXT_LIMIT = 3000;

function clip(s: string, n: number): string {
  return s.length > n ? s.substring(0, n) : s;
}

export interface RescueReport {
  by: string;
  steps: number;
  /** Steps whose fields came from the extractor. */
  read: number;
  /** One line per field that fell back to the mechanical reading, and why. */
  fallbacks: string[];
}

export async function rescuePlan(
  reply: string,
  extractor: StructuredExtractor,
  minConfidence: number,
): Promise<{ plan: any; report: RescueReport } | null> {
  const prose = segmentPlanProse(reply);
  if (!prose) return null;
  // Over the bound the plan is rejected, never truncated - the same rule the
  // parser applies, for the same reason.
  if (prose.steps.length > MAX_PLAN_STEPS) return null;

  const fallbacks: string[] = [];
  let read = 0;
  const steps: any[] = [];
  for (let i = 0; i < prose.steps.length; i++) {
    const s = prose.steps[i];
    const shown = clip(s.body, STEP_TEXT_LIMIT);
    const r = await extractor.extract({
      name: "plan_step",
      description: "One step of a software project plan: its name, the files it writes, and whether it is worth testing.",
      schema: STEP_SCHEMA,
      text: shown,
      maxNewTokens: 200,
    });
    const ok = usable(r, minConfidence);
    if (ok) read++;
    const v = ok ? r.value : {};

    let title = typeof v.title === "string" ? v.title.trim() : "";
    if (!title || title.length > 120) {
      title = s.heading || squash(s.body.split("\n")[0]).slice(0, 80) || "Step " + (i + 1);
      if (ok) fallbacks.push("step " + (i + 1) + ": title taken from the heading");
    }

    let files: string[] = [];
    if (Array.isArray(v.files)) {
      for (const f of v.files) {
        if (typeof f !== "string") continue;
        const p = normPath(f);
        if (!p || files.indexOf(p) !== -1) continue;
        if (grounded(p, shown)) files.push(p);
        else fallbacks.push("step " + (i + 1) + ": dropped " + JSON.stringify(p) + ", not in the step's text");
      }
    }
    if (files.length === 0) {
      files = pathsIn(s.body);
      if (ok && files.length) fallbacks.push("step " + (i + 1) + ": files read from the text");
    }

    const step: any = {
      title: title,
      detail: s.body,
      files: files,
      dependsOn: i === 0 ? [] : [i - 1],
    };
    if (typeof v.testable === "boolean") step.testable = v.testable;
    if (!ok) fallbacks.push("step " + (i + 1) + ": no confident reading (" + describeMiss(r, minConfidence) + ")");
    steps.push(step);
  }
  if (read === 0) return null;

  const plan: any = { summary: "", steps: normaliseDependsOn(steps) || steps };
  const context = clip(prose.preamble, 2000) + "\n\n" + clip(prose.tail || prose.steps[prose.steps.length - 1].body, 1500);
  const top = await extractor.extract({
    name: "project_plan",
    description: "The goal of a software project and the command that runs it.",
    schema: PLAN_SCHEMA,
    text: context,
    maxNewTokens: 160,
  });
  if (usable(top, minConfidence)) {
    if (typeof top.value.summary === "string") plan.summary = top.value.summary.trim();
    // A run command becomes something the app executes, so it must be the
    // provider's own words, not the model's.
    const rc = top.value.run_command;
    if (typeof rc === "string" && rc.trim() && grounded(rc, reply)) plan.runCommand = rc.trim();
    else if (typeof rc === "string" && rc.trim()) fallbacks.push("run command " + JSON.stringify(rc) + " dropped, not in the reply");
  }
  if (!plan.summary) plan.summary = squash(prose.preamble.split(/(?<=[.!?])\s/)[0] || "").slice(0, 200);

  return { plan: plan, report: { by: extractor.id, steps: steps.length, read: read, fallbacks: fallbacks } };
}

function describeMiss(r: any, minConfidence: number): string {
  if (!r || !r.found) return "the model returned nothing";
  if (r.withheld) return "the engine withheld it";
  return "confidence " + (typeof r.confidence === "number" ? r.confidence.toFixed(2) : "?") + " < " + minConfidence;
}
