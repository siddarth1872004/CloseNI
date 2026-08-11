import { MAX_PLAN_STEPS } from "../plan-scale.js";
import { validateGraph } from "../plan-graph.js";
import { extractFencedFiles } from "./fenced-files.js";

export function extractBalanced(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.substring(start, i + 1);
    }
  }
  return null;
}

export function stripTrailingCommas(json: string): string {
  return json.replace(/,(\s*[}\]])/g, "$1");
}

export function fixStringControls(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === "\\") { out += ch; escaped = true; continue; }
      if (ch === '"') {
        let j = i + 1;
        while (j < json.length && (json[j] === " " || json[j] === "\t" || json[j] === "\n" || json[j] === "\r")) j++;
        const next = json[j];
        if (next === undefined || next === "," || next === "}" || next === "]" || next === ":") {
          inString = false; out += ch; continue;
        }
        out += '\\"'; continue;
      }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      out += ch; continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

/**
 * Rebuild a JSON object that stops in the middle.
 *
 * This is the shape a timeout leaves behind: the reply is cut off wherever
 * generation was when the wait ended, so the braces never close and every
 * variant above fails. Everything the model had already written is still good,
 * and for a build step that is usually most of the files.
 *
 * Returns candidates rather than one answer because the right salvage depends
 * on where the cut landed - mid-string, mid-key, or after a trailing comma -
 * and letting JSON.parse decide is cheaper than guessing.
 */
export function salvageTruncatedJson(text: string): string[] {
  const start = text.indexOf("{");
  if (start === -1) return [];
  const closers: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") closers.push("}");
    else if (ch === "[") closers.push("]");
    else if (ch === "}" || ch === "]") closers.pop();
  }
  // Balanced and closed: not truncated, nothing to salvage.
  if (!inString && closers.length === 0) return [];

  const body = text.substring(start);
  const shut = (s: string) => s + closers.slice().reverse().join("");

  const out: string[] = [];
  // 1. Close the open string, then the open containers.
  if (inString) out.push(shut(body + '"'));
  else out.push(shut(body));
  // 2. Same, minus a dangling "key": that never got a value.
  const noDanglingKey = (inString ? body + '"' : body)
    .replace(/,?\s*"(?:[^"\\]|\\.)*"\s*:\s*$/, "");
  out.push(shut(noDanglingKey));
  // 3. Same, minus the whole half-written last element.
  const lastComma = noDanglingKey.lastIndexOf(",");
  if (lastComma > 0) out.push(shut(noDanglingKey.substring(0, lastComma)));
  return out;
}

export function robustParseJson(text: string): any {
  const candidates: string[] = [];
  const fenced = text.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/);
  if (fenced) candidates.push(fenced[1]);
  // A fence that was opened and never closed - the other half of a truncated
  // reply - leaves no closing marker for the pattern above to find.
  const openFence = text.match(/\`\`\`(?:json)?\s*\n([\s\S]*)$/);
  if (openFence) candidates.push(openFence[1]);
  candidates.push(text);
  for (const cand of candidates) {
    const balanced = extractBalanced(cand);
    const raws = balanced ? [balanced, cand] : [cand];
    for (const raw of raws) {
      const variants = [
        raw,
        stripTrailingCommas(raw),
        fixStringControls(raw),
        fixStringControls(stripTrailingCommas(raw)),
      ];
      for (const v of variants) {
        try { return JSON.parse(v); } catch (e) { /* try next variant */ }
      }
    }
    // Only once the honest readings have failed: rebuild a truncated object.
    for (const salvaged of salvageTruncatedJson(cand)) {
      for (const v of [salvaged, stripTrailingCommas(salvaged), fixStringControls(stripTrailingCommas(salvaged))]) {
        try { return JSON.parse(v); } catch (e) { /* try next variant */ }
      }
    }
  }
  return null;
}

function unq(s: string): string {
  return s.substring(1, s.length - 1);
}

export function extractStepsHeuristic(text: string): any {
  const steps: any[] = [];
  const titleRe = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  const titles: { title: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(text)) !== null) titles.push({ title: m[1], index: m.index });
  for (let i = 0; i < titles.length; i++) {
    const chunk = text.substring(titles[i].index, i + 1 < titles.length ? titles[i + 1].index : text.length);
    const detailMatch = chunk.match(/"detail"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const filesMatch = chunk.match(/"files"\s*:\s*\[([\s\S]*?)\]/);
    let files: string[] = [];
    if (filesMatch) {
      const fm = filesMatch[1].match(/"((?:[^"\\]|\\.)*)"/g);
      if (fm) files = fm.map(unq);
    }
    steps.push({ title: titles[i].title, detail: detailMatch ? detailMatch[1] : "", files: files });
  }
  if (steps.length === 0) return null;
  const sumMatch = text.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return { summary: sumMatch ? sumMatch[1] : "", steps: steps };
}

export function parsePlanRobust(text: string): any {
  const plan = parsePlanShape(text);
  // Over the bound, treat the reply as unparseable so the caller re-asks.
  // Truncating to the bound would silently drop the end of the project.
  if (plan && plan.steps && plan.steps.length > MAX_PLAN_STEPS) return null;
  // Same reasoning for a graph that cannot be scheduled: re-asking costs one
  // round-trip, a deadlocked build costs the whole run.
  if (plan && plan.steps && !validateGraph(plan.steps).ok) return null;
  return plan;
}

function parsePlanShape(text: string): any {
  const parsed = robustParseJson(text);
  if (parsed && parsed.steps && Array.isArray(parsed.steps)) return parsed;
  if (parsed && parsed.plan && parsed.plan.steps) return parsed.plan;
  return extractStepsHeuristic(text);
}

export function parseFilesRobust(text: string): { changes: any[]; commands: string[] } | null {
  const viaJson = parseFilesFromJson(text);
  if (viaJson) return viaJson;

  // Last resort: the model answered in prose and code blocks rather than JSON.
  // Those replies contain the files that were asked for, and refusing to read
  // them fails a step over presentation.
  const fenced = extractFencedFiles(text);
  if (fenced.length) {
    return {
      changes: fenced.map((f) => ({
        filePath: f.filePath,
        mode: "create",
        language: f.language,
        newContent: f.content,
        searchBlock: undefined,
        replaceBlock: undefined,
      })),
      commands: [],
    };
  }
  return null;
}

function parseFilesFromJson(text: string): { changes: any[]; commands: string[] } | null {
  const parsed = robustParseJson(text);
  if (!parsed) return null;
  const files = parsed.files || parsed.changes || null;
  if (!files || !Array.isArray(files) || files.length === 0) return null;
  const changes: any[] = [];
  for (const f of files) {
    if (!f || typeof f !== "object") continue;
    const filePath = f.path || f.file || f.filePath;
    // A change with no path cannot be applied; keeping it only produces a
    // confusing failure once it reaches the patch applier.
    if (typeof filePath !== "string" || filePath.trim().length === 0) continue;
    changes.push({
      filePath: filePath,
      mode: f.mode || "create",
      language: f.language || "text",
      newContent: typeof f.content === "string" ? f.content : (typeof f.newContent === "string" ? f.newContent : undefined),
      searchBlock: typeof f.search === "string" ? f.search : (typeof f.searchBlock === "string" ? f.searchBlock : undefined),
      replaceBlock: typeof f.replace === "string" ? f.replace : (typeof f.replaceBlock === "string" ? f.replaceBlock : undefined),
    });
  }
  const commands: string[] = [];
  if (Array.isArray(parsed.commands)) {
    for (const c of parsed.commands) if (typeof c === "string") commands.push(c);
  }
  // Salvaging a truncated reply can recover the path of a file whose content
  // was never written. A change with a path and nothing to put in it would
  // create an empty file that overwrites a real one, so it is dropped - the
  // step then reports the files it did get rather than silently blanking one.
  const usable = changes.filter((c) =>
    c.mode === "delete" ||
    typeof c.newContent === "string" ||
    (typeof c.searchBlock === "string" && typeof c.replaceBlock === "string"));
  if (usable.length === 0) return null;
  return { changes: usable, commands: commands };
}
