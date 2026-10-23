/**
 * Less of a file, where less will do.
 *
 * Every byte sent goes to the provider's chat, and a chat page is a shared
 * service with limits: a file the model has already seen in this chat need
 * not be sent again in full.
 *
 *   diff     what changed between the copy the chat last saw and the file now
 *   outline  a long file's declarations with their line numbers, so the model
 *            can read the part it needs rather than the whole
 */

/** Context lines kept around each change. */
const CONTEXT = 3;
/** The comparison grid past which a diff is not worth working out. */
const MAX_CELLS = 4_000_000;

/**
 * A unified diff of two texts, line by line, with @@ headers numbered as in
 * each text. "" when they are the same; null when the changed region is too
 * large to compare cheaply (the caller sends the file whole instead).
 */
export function unifiedDiff(before: string, after: string): string | null {
  const a = splitLines(before);
  const b = splitLines(after);
  // Edits are local: the common head and tail cut the grid down to the part
  // that changed.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (n === 0 && m === 0) return "";
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;

  // Longest common subsequence over the middle, from the end, so the walk
  // below runs forwards.
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[head + i] === b[head + j]
        ? lcs[(i + 1) * w + j + 1] + 1
        : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }

  // Every line of both texts in order, marked kept, removed or added.
  type Op = { k: " " | "-" | "+"; line: string };
  const ops: Op[] = [];
  for (let i = 0; i < head; i++) ops.push({ k: " ", line: a[i] });
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[head + i] === b[head + j]) { ops.push({ k: " ", line: a[head + i] }); i++; j++; }
    else if (i < n && (j >= m || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) { ops.push({ k: "-", line: a[head + i] }); i++; }
    else { ops.push({ k: "+", line: b[head + j] }); j++; }
  }
  for (let t = a.length - tail; t < a.length; t++) ops.push({ k: " ", line: a[t] });

  // Group changes into hunks, merging those whose context would overlap.
  const out: string[] = [];
  let at = 0;
  while (at < ops.length) {
    while (at < ops.length && ops[at].k === " ") at++;
    if (at >= ops.length) break;
    const start = Math.max(0, at - CONTEXT);
    let end = at;
    let quiet = 0;
    for (let k = at; k < ops.length; k++) {
      if (ops[k].k === " ") { quiet++; if (quiet > CONTEXT * 2) break; }
      else { quiet = 0; end = k; }
    }
    const stop = Math.min(ops.length, end + 1 + CONTEXT);
    let aLine = 1, bLine = 1;
    for (let k = 0; k < start; k++) { if (ops[k].k !== "+") aLine++; if (ops[k].k !== "-") bLine++; }
    let aCount = 0, bCount = 0;
    const body: string[] = [];
    for (let k = start; k < stop; k++) {
      if (ops[k].k !== "+") aCount++;
      if (ops[k].k !== "-") bCount++;
      body.push(ops[k].k + ops[k].line);
    }
    out.push("@@ -" + (aCount ? aLine : aLine - 1) + "," + aCount + " +" + (bCount ? bLine : bLine - 1) + "," + bCount + " @@");
    out.push(...body);
    at = stop;
  }
  return out.join("\n");
}

function splitLines(s: string): string[] {
  const lines = String(s).split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Most entries an outline lists. */
export const MAX_OUTLINE = 200;

// A declaration in the common languages, near the left margin: functions,
// classes and types, top-level bindings, and the methods one level in.
const DECLARATION = new RegExp("^(?:\\s{0,8})(?:" + [
  "(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\*?|class|interface|type|enum|namespace|module)\\s+[\\w$]",
  "(?:export\\s+)?(?:const|let|var)\\s+[\\w$]+\\s*(?::[^=]*)?=\\s*(?:async\\s+)?(?:\\([^)]*\\)|[\\w$]+)\\s*=>",
  "(?:export\\s+)?(?:const|let|var)\\s+[A-Z][\\w$]*\\s*[:=]",
  "(?:async\\s+)?def\\s+\\w|class\\s+\\w",
  "(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?(?:fn|struct|enum|trait|impl|mod|type)\\b",
  "func\\s+[\\w(]",
  "(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|readonly|get|set)\\s+)+[\\w<>\\[\\],.? ]*[\\w$]+\\s*\\(",
  "(?:[\\w$]+\\s*)\\([^)]*\\)\\s*(?::\\s*[^={]+)?\\{\\s*$",
  "#{1,6}\\s+\\S",
].join("|") + ")");
const NOT_A_DECLARATION = /^\s*(?:if|for|while|switch|catch|return|else|do|try|with|elif|except)\b/;

/** A long file's declarations, numbered as in the file; "" when none were found. */
export function outline(text: string): string {
  const rows: string[] = [];
  const lines = splitLines(text);
  let fence = false;
  for (let k = 0; k < lines.length && rows.length < MAX_OUTLINE; k++) {
    const l = lines[k];
    // A ``` block in Markdown is code, not headings.
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; continue; }
    if (fence && /^#/.test(l)) continue;
    if (!DECLARATION.test(l) || NOT_A_DECLARATION.test(l)) continue;
    rows.push(String(k + 1).padStart(6, " ") + "\t" + (l.length > 160 ? l.slice(0, 160) + " ..." : l.replace(/\s*\{\s*$/, "")));
  }
  return rows.join("\n");
}
