import * as path from "path";

export interface WorkspaceFile {
  /** Workspace-relative, forward-slash separated. */
  path: string;
  content: string;
  /** Last-modified time in ms. Used to favour what recent steps produced. */
  mtimeMs: number;
}

export interface SelectedFile {
  path: string;
  content: string;
}

export interface SelectOptions {
  /** Files already in the workspace, produced by earlier steps. */
  files: WorkspaceFile[];
  /** The step's instruction text, which may carry an "Expected files:" line. */
  stepDetail: string;
  /** The overall request, used for keyword hints. */
  prompt: string;
  /** Roughly how many characters of file context to spend. */
  budgetChars?: number;
  /** Hard ceiling on how many files to include. */
  maxFiles?: number;
}

const DEFAULT_BUDGET_CHARS = 2600;
const DEFAULT_MAX_FILES = 8;
const SIGNATURE_LINE_LIMIT = 40;

/**
 * Reduce a file to the part another module needs in order to call into it:
 * imports, class and function declarations, exports. Full bodies would blow the
 * prompt budget without telling the model anything it can use.
 */
export function extractSignatures(src: string, filePath: string): string {
  if (filePath.endsWith(".py")) {
    const out: string[] = [];
    let depth = 0;
    for (const raw of src.split("\n")) {
      const line = raw.replace(/\s+$/, "");
      if (/^(import|from)\s/.test(line)) out.push(line);
      else if (/^class\s+/.test(line)) { out.push(line); depth = 1; }
      else if (/^def\s+/.test(line) && depth === 0) out.push(line);
      else if (depth > 0 && /^\s{4}(def|@)/.test(line)) out.push(line);
      else if (depth > 0 && /^\S/.test(line)) depth = 0;
    }
    return out.slice(0, SIGNATURE_LINE_LIMIT).join("\n");
  }
  if (/\.(js|cjs|mjs|ts|tsx|jsx)$/.test(filePath)) {
    const out: string[] = [];
    for (const raw of src.split("\n")) {
      const line = raw.replace(/\s+$/, "");
      if (/^import\s|^export\s|^(const|let|var|function|class|async function)\s/.test(line)) out.push(line);
      // CommonJS exports are how a lot of generated JS declares its surface.
      else if (/^\s*module\.exports\s*=/.test(line) || /^\s*exports\.\w+\s*=/.test(line)) out.push(line.trim());
    }
    return out.slice(0, SIGNATURE_LINE_LIMIT).join("\n");
  }
  if (/\.(rs|go|java|c|h|cpp|hpp|cc)$/.test(filePath)) {
    const out: string[] = [];
    for (const raw of src.split("\n")) {
      const line = raw.replace(/\s+$/, "");
      if (/^\s*(pub\s+)?(fn|struct|enum|trait|impl|mod|use)\s/.test(line)) out.push(line.trim());
      else if (/^\s*(public|protected|private|package|import)\s/.test(line)) out.push(line.trim());
      else if (/^\s*#include\s/.test(line)) out.push(line.trim());
      else if (/^[A-Za-z_][\w\s*]*\s+\**\w+\s*\([^;{]*\)\s*[;{]\s*$/.test(line)) out.push(line.trim());
    }
    return out.slice(0, SIGNATURE_LINE_LIMIT).join("\n");
  }
  return "";
}

function parseExpectedFiles(stepDetail: string): string[] {
  const m = stepDetail.match(/Expected files:\s*(.+?)(?:\n|$)/);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

function keywordsFrom(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((w) => w.length > 3)
    )
  );
}

/**
 * Rank the files an upcoming step is most likely to need.
 *
 * The previous version scored almost entirely on directory match against the
 * step's expected files. That collapses whenever the step targets a file at the
 * repo root — the expected directory is "", nothing matches it, every candidate
 * scores zero, and the "top" files become whatever the directory walk happened
 * to return first. That is how a step writing main.py was handed storage and
 * services modules but not the handlers module it had to import from, and it
 * invented function names that did not exist.
 *
 * Recency is the fix that matters: a step almost always builds on what the steps
 * just before it produced.
 */
export function selectRelevantFiles(opts: SelectOptions): SelectedFile[] {
  const { files, stepDetail, prompt } = opts;
  const budget = opts.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  if (files.length === 0) return [];

  const expected = parseExpectedFiles(stepDetail);
  const expectedBasenames = expected.map((e) => path.posix.basename(e));
  const words = keywordsFrom(prompt + " " + stepDetail);

  // Newest first; index becomes the recency rank.
  const byRecency = files.slice().sort((a, b) => b.mtimeMs - a.mtimeMs);
  const recencyRank = new Map<string, number>();
  byRecency.forEach((f, i) => recencyRank.set(f.path, i));

  const scored = files.map((f) => {
    let score = 0;
    const dir = dirOf(f.path);
    const base = path.posix.basename(f.path);

    for (const ef of expected) {
      const edir = dirOf(ef);
      if (dir === edir) score += 10;
      else if (dir && edir && (dir.startsWith(edir + "/") || edir.startsWith(dir + "/"))) score += 5;
      // A step writing src/cli/main.py wants the rest of src/cli, even though the
      // expected file sits one level up from nothing.
      else if (edir === "" && dir !== "") score += 1;
      if (expectedBasenames.includes(base)) score += 3;
    }

    // What recent steps wrote is what this step builds on.
    const rank = recencyRank.get(f.path) ?? files.length;
    score += Math.max(0, 10 - rank * 2);

    const signature = extractSignatures(f.content, f.path);
    const haystackPath = f.path.toLowerCase();
    const haystackSig = signature.toLowerCase();
    for (const w of words) {
      if (haystackPath.includes(w)) score += 2;
      // Naming the symbol is a stronger hint than the path happening to match.
      else if (haystackSig.includes(w)) score += 1;
    }

    // Large files are implementation-heavy; their surface is what matters and
    // that is what the signature already gives us.
    if (f.content.length > 3000) score -= 2;
    if (f.content.length > 8000) score -= 4;

    return { file: f, signature, score };
  });

  // Sort by score, then path, so the same workspace always yields the same
  // context instead of depending on directory-walk order.
  scored.sort((a, b) => (b.score - a.score) || a.file.path.localeCompare(b.file.path));

  const selected: SelectedFile[] = [];
  let spent = 0;
  for (const entry of scored) {
    if (selected.length >= maxFiles) break;
    const sig = entry.signature;
    const body = sig.trim().length > 10 ? sig : entry.file.content.slice(0, 600);
    if (body.trim().length === 0) continue;
    // Always admit the top candidate, otherwise a single large file could leave
    // the step with no context at all.
    if (selected.length > 0 && spent + body.length > budget) continue;
    selected.push({ path: entry.file.path, content: body });
    spent += body.length;
  }
  return selected;
}
