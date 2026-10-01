/*
 * What to say to the model when a step did not work.
 *
 * Kept apart from index.ts so the wording can be tested without starting the
 * CLI - requiring the entry point runs main().
 */

import type { DroppedName, SourceFile } from "./context/defined-names.js";

/** How the model is asked to reply, said the same way in every repair. */
export const REPLY_FORMAT_REMINDER =
  "Reply in the same format as before: one ```json block with the files array, or one " +
  "fenced block per file with the path on the fence line. Send every file you change " +
  "COMPLETELY - no ellipses, no '... rest unchanged'.";

/** Budget for file contents quoted back into a repair prompt. */
export const REPAIR_FILES_BUDGET_CHARS = 12000;

/**
 * Cut a long failure dump without losing its end.
 *
 * pytest, jest and cargo all put the summary - which tests failed and why, in
 * one line each - at the bottom. Keeping only the head sent the model the first
 * traceback of forty-six and none of the list that said what the other
 * forty-five were.
 */
export function clipOutput(output: string, max: number): string {
  const text = String(output || "");
  if (text.length <= max) return text;
  const tail = Math.floor(max * 0.4);
  const head = max - tail;
  return text.slice(0, head) + "\n... [" + (text.length - head - tail) + " characters omitted] ...\n" +
    text.slice(text.length - tail);
}

/**
 * Workspace files a failure names, most-mentioned first.
 *
 * By path ("tests/test_level.py:113") or by module ("module 'src.settings' has
 * no attribute ..."). The second is the one that matters: the file at fault in
 * an AttributeError is the one whose path never appears in the traceback.
 */
export function filesNamedInOutput(output: string, paths: string[]): string[] {
  const text = String(output || "").replace(/\\/g, "/");
  const counts: { path: string; n: number }[] = [];
  for (const p of paths || []) {
    if (typeof p !== "string" || !p) continue;
    const rel = p.replace(/\\/g, "/");
    let n = text.split(rel).length - 1;
    const mod = rel.replace(/\.(py|[cm]?[jt]sx?)$/, "").replace(/\/__init__$/, "").replace(/\//g, ".");
    if (/\.py$/.test(rel) && mod && mod !== rel) {
      n += (text.match(new RegExp("['\"\\s(]" + mod.replace(/\./g, "\\.") + "['\"\\s):]", "g")) || []).length;
    }
    if (n > 0) counts.push({ path: rel, n: n });
  }
  counts.sort((a, b) => (b.n - a.n) || a.path.localeCompare(b.path));
  return counts.map((c) => c.path);
}

function fenceLang(p: string): string {
  const ext = (p.match(/\.([A-Za-z0-9]+)$/) || [])[1] || "";
  const known: Record<string, string> = { py: "python", js: "javascript", cjs: "javascript", mjs: "javascript",
    ts: "typescript", tsx: "tsx", jsx: "jsx", rs: "rust", go: "go", java: "java", rb: "ruby", json: "json" };
  return known[ext.toLowerCase()] || ext.toLowerCase() || "text";
}

/**
 * Files quoted in full, in the same fenced shape the model replies in.
 *
 * Whole files or nothing: half a file quoted back invites half a file in the
 * reply. What does not fit is named, so the model knows it was not shown it.
 */
export function renderFiles(files: SourceFile[], budget: number): string {
  let out = "";
  let spent = 0;
  const left: string[] = [];
  for (const f of files || []) {
    if (!f || typeof f.content !== "string") continue;
    if (spent + f.content.length > budget) { left.push(f.path); continue; }
    spent += f.content.length;
    out += "\n```" + fenceLang(f.path) + " " + f.path + "\n" + f.content +
      (f.content.endsWith("\n") ? "" : "\n") + "```\n";
  }
  if (left.length) out += "\n(Not shown, too large: " + left.join(", ") + ")\n";
  return out;
}

function currentSection(current?: SourceFile[]): string {
  if (!current || !current.length) return "";
  return "\nThese are the files the failure points at, exactly as they are on disk now. " +
    "Edit from these, not from memory:\n" + renderFiles(current, REPAIR_FILES_BUDGET_CHARS);
}

/**
 * The retry for an overwrite that removed names other files still use.
 *
 * Nothing was tested - the tests would only have said AttributeError in some
 * other file, which is what sent the model guessing three times in a row. This
 * says exactly which names, where they are used, and shows the file as it was.
 */
export function buildDroppedNamesFollowUp(
  dropped: { path: string; names: DroppedName[] }[],
  before: SourceFile[],
): string {
  const lines: string[] = [];
  for (const d of dropped || []) {
    for (const n of d.names) lines.push("- " + d.path + ": " + n.name + " (used in " + n.usedIn.join(", ") + ")");
  }
  return "Your changes were not tested, because they removed names that other files " +
    "in this project still use:\n" + lines.join("\n") + "\n\n" +
    "Put those names back, keeping their original values and behaviour, and keep " +
    "everything else the file already defined. Only remove a name if you also " +
    "change every file that uses it, and send those files too.\n" +
    (before && before.length
      ? "\nHere is each file as it was before this step:\n" + renderFiles(before, REPAIR_FILES_BUDGET_CHARS)
      : "") +
    "\n" + REPLY_FORMAT_REMINDER;
}

/**
 * The retry for a step whose own tests failed.
 *
 * Distinct from every other check, and the distinction is the whole reason this
 * exists. A compiler failing means the code is wrong; there is nothing else it
 * could mean. A test failing means the code is wrong OR the assertion is - and
 * the model wrote both, minutes apart.
 *
 * The generic follow-up says "your code failed when tested, fix the root cause".
 * Given a wrong assertion, a model told that will bend correct code until the
 * assertion passes, and that lands on disk as a green step with the behaviour
 * quietly broken. Strictly worse than having written no test at all.
 *
 * So this names the ambiguity and makes deciding it the task.
 */
export function buildTestFollowUp(output: string, priorFiles: string[], current?: SourceFile[]): string {
  return "The tests for this step did not pass.\n\n" +
    clipOutput(output, 2000) + "\n\n" +
    "You wrote both the code and the test, so either could be at fault. Decide " +
    "which one is actually wrong before changing anything:\n" +
    "- If the code does not do what the step asked for, fix the code.\n" +
    "- If the test asserts something the step never asked for, or asserts it " +
    "incorrectly, fix the test.\n" +
    "Do not change working code to satisfy a wrong assertion, and do not weaken " +
    "or delete a test to make it pass - a test that no longer checks anything is " +
    "worse than a failing one.\n" +
    "Keep every name an existing file already defines; other files depend on them.\n" +
    (priorFiles.length
      ? "\nFiles in this project: " + priorFiles.join(", ") + "\n"
      : "") +
    currentSection(current) +
    "\n" + REPLY_FORMAT_REMINDER;
}

/**
 * The retry for a compiler, type checker or command that failed.
 *
 * Moved here from index.ts so it can carry the implicated files like the test
 * retry does, and be tested without starting the CLI.
 */
export function buildCommandFollowUp(command: string, output: string, priorFiles: string[], current?: SourceFile[]): string {
  let priorNote = "";
  if (priorFiles.length > 0) {
    priorNote = "\nNote: existing files in this project are: " + priorFiles.join(", ") + ". Fix the bug in the appropriate file - do not collapse everything into one file.\n";
  }
  return "Your previous code failed when tested.\n" +
    "Command that was run:\n" + command + "\n" +
    "Error output:\n" + clipOutput(output, 3000) + "\n" +
    "IMPORTANT: Fix the ROOT CAUSE of the error. Do not silence it with try/except, and do not merge unrelated files into one.\n" +
    "Keep every name an existing file already defines; other files depend on them.\n" +
    priorNote +
    currentSection(current) +
    "\n" + REPLY_FORMAT_REMINDER;
}

/**
 * The retry for changes that could not be applied at all.
 *
 * Distinct from a test failure, and the distinction matters: nothing ran, so
 * there is no root cause to fix and no traceback to read. Sending the generic
 * "your code failed when tested, fix the root cause, do not silence it with
 * try/except" invites the model to rewrite working logic in answer to a problem
 * that was entirely about how the edit was addressed.
 *
 * A real run missed six of seven search blocks and recovered only because the
 * generic follow-up happened to prompt whole files. This asks for that
 * deliberately, names the files, and says which tactic to abandon - retrying
 * the same way is how a step burns both attempts on the same mistake.
 */
export function buildApplyFollowUp(errors: string, priorFiles: string[]): string {
  const text = String(errors || "");
  const files = Array.from(new Set(
    [...text.matchAll(/^Failed to apply ([^:]+):/gm)].map((m) => m[1].trim()),
  ));

  const searchMissed = /Search block (?:not found|appears more than once)/i.test(text);
  const abbreviated = /abbreviated file/i.test(text);
  const outside = /outside workspace/i.test(text);

  let why = "None of those edits could be applied, so nothing changed on disk.";
  if (searchMissed) {
    why = "The search_replace edits did not match the files. A search block has to " +
      "reproduce the existing text exactly, and yours did not - most likely the file " +
      "differs from what you remember of it.";
  } else if (abbreviated) {
    why = "The file was refused because it contained a placeholder such as " +
      "\"... rest of the file unchanged ...\" instead of the real contents. A partial " +
      "file would have overwritten the working one.";
  } else if (outside) {
    why = "A path pointed outside the project directory and was refused.";
  }

  const target = files.length
    ? "these files: " + files.join(", ")
    : "the files for this step";

  const instruction = outside
    ? "Use paths relative to the project root - no leading slash, no drive letter, no \"..\"."
    : "Send the COMPLETE current contents of " + target + " using mode \"overwrite\". " +
      "Do not use search_replace this time, and do not abbreviate any part of a file.";

  const priorNote = priorFiles.length
    ? "\nExisting files in this project: " + priorFiles.join(", ") +
      ". Keep them separate - do not merge unrelated files into one.\n"
    : "";

  return "The changes you sent could not be applied.\n\n" + why + "\n\n" +
    text.slice(0, 1500) + "\n\n" + instruction + "\n" + priorNote +
    "Reply with the same JSON format, wrapped in a \`\`\`json code block.";
}

