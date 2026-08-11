/*
 * Recover files from an answer that never was JSON.
 *
 * The build asks for {"files":[…]}. Models comply most of the time and then,
 * without warning, answer the way they answer everything else: prose and
 * fenced code blocks. That reply is not malformed - it contains exactly the
 * files that were asked for - but the JSON parser sees nothing in it, the step
 * fails with "No file changes found", and every step behind it blocks.
 *
 * So the fences are read as a last resort, after JSON and JSON salvage have
 * both failed. This is a fallback, never the primary path: a model that
 * answers in JSON is easier to be sure about, and the prompt still demands it.
 *
 * The whole problem is deciding which file a block belongs to. Four places
 * carry that, in descending order of how explicit they are.
 */

export interface FencedFile {
  filePath: string;
  content: string;
  language: string;
}

const FENCE = "`".repeat(3);

/** Extensions worth trusting as a path when there is no other signal. */
const PATHY = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|php|go|rs|java|cs|c|h|cpp|hpp|cc|sh|bash|sql|json|ya?ml|toml|ini|cfg|env|md|txt|html?|css|scss|xml|gradle|properties|dockerfile|lock)$/i;

const BARE_FILES = /^(Dockerfile|Makefile|Procfile|Gemfile|Rakefile|\.gitignore|\.env|requirements\.txt|package\.json)$/i;

/**
 * Does this look like a path rather than prose?
 *
 * Deliberately strict. A false positive writes a file named after a sentence,
 * which is worse than missing one - the miss is reported, the stray file is not.
 */
export function looksLikePath(raw: string): boolean {
  const s = String(raw || "").trim().replace(/^[`'"*#\s]+|[`'"*:\s]+$/g, "");
  if (!s || s.length > 200) return false;
  if (/\s/.test(s)) return false;                 // paths in these replies never have spaces
  // Absolute, drive-qualified, or a UNC share: none of them are ours to write.
  // The UNC form was accepted until an edge-case run tried \\server\share\x.py,
  // which the applier would still have contained but which should never have
  // been read as a workspace path in the first place.
  if (s.startsWith("/") || s.startsWith("\\")) return false;
  if (/^[a-zA-Z]:[\\/]/.test(s)) return false;
  if (s.includes("\\")) return false;            // backslash paths are not used here
  if (s.includes("..")) return false;             // escaping the workspace
  if (/^https?:/i.test(s)) return false;
  return PATHY.test(s) || BARE_FILES.test(s) || (s.includes("/") && /\.[a-z0-9]+$/i.test(s));
}

/** Strip the decoration people put around a path: **bold**, `code`, "File: x". */
function cleanPath(raw: string): string | null {
  let s = String(raw || "").trim();
  s = s.replace(/^(?:file|path|filename)\s*[:=]\s*/i, "");
  s = s.replace(/^[`'"*#\s]+/, "").replace(/[`'"*:,\s]+$/, "");
  s = s.replace(/^(?:\.\/)+/, "");
  return looksLikePath(s) ? s : null;
}

/** A path declared on the fence itself: ```python src/app.py  or  title="src/app.py" */
function pathFromInfo(info: string): string | null {
  const titled = info.match(/(?:title|file|path|name)\s*=\s*["']([^"']+)["']/i);
  if (titled) return cleanPath(titled[1]);
  for (const token of info.trim().split(/\s+/)) {
    const p = cleanPath(token);
    if (p) return p;
  }
  return null;
}

/** A path on one of the last few lines before the fence. */
function pathFromLeadIn(before: string): string | null {
  const lines = before.split(/\r?\n/).filter((l) => l.trim().length);
  for (const line of lines.slice(-3).reverse()) {
    const direct = cleanPath(line);
    if (direct) return direct;
    // "Create `src/app.py` with:" - a path quoted inside a sentence.
    const quoted = line.match(/[`"']([^`"']+)[`"']/);
    if (quoted) {
      const p = cleanPath(quoted[1]);
      if (p) return p;
    }
  }
  return null;
}

/**
 * A path in the first line of the block, as a comment - or bare.
 *
 * Bare matters because of what the DOM does to a fence. `\`\`\`python src/x.py`
 * renders as a <pre> whose language becomes a class, and the rest of the info
 * string ends up as the first line of the code. By the time the reply has been
 * read back out of the page, the path is sitting there on its own with no
 * comment marker, and a trial build lost two files to exactly that.
 *
 * Safe because looksLikePath is strict: a bare line only counts when it has no
 * spaces and a real extension, which ordinary first lines of source do not.
 */
function pathFromFirstLine(body: string): { filePath: string; body: string } | null {
  const nl = body.indexOf("\n");
  if (nl === -1) return null;
  const first = body.substring(0, nl);
  const rest = body.substring(nl + 1);
  // A block that is only a path is not a file.
  if (!rest.trim()) return null;

  const commented = first.match(/^\s*(?:#|\/\/|--|;|<!--|\/\*)\s*(.+?)\s*(?:-->|\*\/)?\s*$/);
  const candidate = commented ? commented[1] : first;
  const p = cleanPath(candidate);
  if (!p) return null;
  // The line named the file; it is not part of the file.
  return { filePath: p, body: rest };
}

/**
 * Every fenced block that can be attributed to a file.
 *
 * Blocks with no discoverable path are skipped rather than guessed at - an
 * illustrative snippet in the middle of an explanation is not a file, and
 * writing it somewhere invented is worse than ignoring it.
 */
export function extractFencedFiles(text: string): FencedFile[] {
  const src = String(text || "");
  const out: FencedFile[] = [];
  const seen: Record<string, number> = {};
  const re = new RegExp(FENCE + "([^\\n]*)\\n([\\s\\S]*?)" + FENCE, "g");
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  while ((m = re.exec(src)) !== null) {
    const info = m[1] || "";
    let body = m[2] || "";
    const language = (info.trim().split(/\s+/)[0] || "text").replace(/[^a-z0-9+#-]/gi, "") || "text";

    let filePath = pathFromInfo(info);
    if (!filePath) {
      const fromComment = pathFromFirstLine(body);
      if (fromComment) { filePath = fromComment.filePath; body = fromComment.body; }
    }
    if (!filePath) filePath = pathFromLeadIn(src.substring(lastEnd, m.index));
    lastEnd = re.lastIndex;
    if (!filePath) continue;
    if (!body.trim()) continue;

    // A file written twice in one reply is the model correcting itself; the
    // later block wins, which is what a reader would assume too.
    if (seen[filePath] !== undefined) {
      out[seen[filePath]] = { filePath, content: body, language };
      continue;
    }
    seen[filePath] = out.length;
    out.push({ filePath: filePath, content: body, language: language });
  }
  return out;
}
