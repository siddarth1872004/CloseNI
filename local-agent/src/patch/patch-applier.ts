import * as fs from "fs";
import * as path from "path";
import { EditPlan, FileChange, PatchApplyResult } from "@agentic/shared";

// A plain startsWith would treat /work/proj-backup as living inside /work/proj,
// so compare on path segments instead.
function isInsideWorkspace(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = path.relative(root, target);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Does this content stand in for a file rather than being one?
 *
 * Deliberately narrow: it wants an elision AND a word that says the rest was
 * left out. "..." alone is legitimate (Python Ellipsis, ranges, prose in a
 * docstring), and refusing on that would block real code.
 */
export function isAbbreviated(content: string): boolean {
  const text = String(content || "");
  if (!text.trim()) return false;
  const ELISION = [
    /(?:\.\.\.|…|\/\/|#|--|\/\*)\s*(?:the\s+)?rest\s+of\s+(?:the\s+)?(?:file|code|method|class|function|implementation)/i,
    /(?:\.\.\.|…)\s*rest\s+(?:unchanged|of\s+it|remains)/i,
    /(?:existing|previous|original)\s+(?:code|content|implementation)\s+(?:here|unchanged|remains|stays)/i,
    /(?:unchanged|omitted|truncated|abbreviated|snipped)\s*(?:\.\.\.|…)/i,
    /(?:\.\.\.|…)\s*(?:unchanged|omitted|as\s+before|same\s+as\s+(?:above|before))/i,
    /keep\s+(?:the\s+)?(?:rest|remaining|existing)\s+(?:of\s+)?(?:the\s+)?(?:file|code)\s+as[- ]is/i,
  ];
  return ELISION.some((re) => re.test(text));
}

/**
 * Where a search block sits in a file, tolerating the ways models mistype one.
 *
 * The matcher was `content.includes(searchBlock)` - one exact substring, or
 * nothing. A model reproducing a block from memory gets the code right and the
 * whitespace slightly wrong: a stripped trailing space, CRLF against LF. A real
 * run missed six of seven blocks that way, failed the step, and only recovered
 * because the follow-up made the model resend whole files instead.
 *
 * Matching is line-wise, comparing lines with trailing whitespace and line
 * endings normalised away. Leading indentation is compared exactly and
 * deliberately: in Python it is the meaning of the code, and a matcher that
 * shrugged at indentation could patch a block inside the wrong scope.
 *
 * A block that appears more than once returns "ambiguous" rather than the first
 * hit. String.replace silently took the first, which can edit a place nobody
 * looked at; making the model be specific is cheaper than finding that later.
 */
export function findSearchBlock(
  content: string,
  block: string,
): { start: number; end: number } | null | "ambiguous" {
  const norm = (s: string) => s.replace(/\r\n?/g, "\n").replace(/[ \t]+$/, "");
  const fileLines = content.replace(/\r\n?/g, "\n").split("\n");
  const blockLines = block.replace(/\r\n?/g, "\n").split("\n");
  // A trailing newline on the block yields an empty last line that matches
  // nothing; models include one about half the time.
  while (blockLines.length > 1 && blockLines[blockLines.length - 1].trim() === "") blockLines.pop();
  if (!blockLines.length || blockLines.every((l) => l.trim() === "")) return null;

  const normFile = fileLines.map(norm);
  const normBlock = blockLines.map(norm);

  const hits: { start: number; end: number }[] = [];
  for (let i = 0; i + normBlock.length <= normFile.length; i++) {
    let ok = true;
    for (let j = 0; j < normBlock.length; j++) {
      if (normFile[i + j] !== normBlock[j]) { ok = false; break; }
    }
    if (ok) hits.push({ start: i, end: i + normBlock.length, kind: "lines" } as any);
    if (hits.length > 1) return "ambiguous";
  }
  if (hits.length === 1) return hits[0];

  // Fall back to a plain substring, which is what the old matcher did and the
  // only way to change a token inside a line - replacing "v2" with "v3" in
  // print('v2') is a whole-file rewrite otherwise. Exact, because a fragment
  // has no line structure to normalise against.
  const first = content.indexOf(block);
  if (first === -1 || !block) return null;
  if (content.indexOf(block, first + 1) !== -1) return "ambiguous";
  return { start: first, end: first + block.length, kind: "chars" } as any;
}

/** Swap a match for new text, keeping the file's own line endings. */
export function applyReplacement(
  content: string,
  at: { start: number; end: number; kind?: string },
  replacement: string,
): string {
  if (at.kind === "chars") {
    return content.slice(0, at.start) + replacement + content.slice(at.end);
  }
  return replaceLines(content, at.start, at.end, replacement);
}

export function replaceLines(content: string, start: number, end: number, replacement: string): string {
  const crlf = /\r\n/.test(content);
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const repl = replacement.replace(/\r\n?/g, "\n").split("\n");
  const out = lines.slice(0, start).concat(repl, lines.slice(end)).join("\n");
  return crlf ? out.replace(/\n/g, "\r\n") : out;
}

export function applyPatch(workspaceRoot: string, plan: EditPlan): PatchApplyResult {
  const appliedFiles: string[] = [];
  const errors: string[] = [];
  const backupDir = path.join(workspaceRoot, ".agent-backups", Date.now().toString());
  const absoluteWorkspaceRoot = path.resolve(workspaceRoot);

  for (const change of plan.changes) {
    try {
      if (!change.filePath || typeof change.filePath !== "string") {
        throw new Error("Change is missing a file path");
      }

      const absoluteFilePath = path.resolve(workspaceRoot, change.filePath);

      if (!isInsideWorkspace(absoluteWorkspaceRoot, absoluteFilePath)) {
        throw new Error("Security Error: Attempted to write outside workspace: " + change.filePath);
      }

      // An abbreviated file must never land on top of a real one.
      //
      // Models elide the middle of a long file - "# ... rest of the file
      // unchanged ..." - even when told not to. Written as an overwrite that is
      // silent, total data loss: a trial build replaced a working config.py
      // with two lines and reported the step as a success. The backup taken
      // just above is the only reason it was recoverable.
      //
      // Refused rather than repaired, because the repair loop will re-ask and
      // the model usually sends the whole file the second time. Only checked
      // against an existing file: the same text in a new file is wrong but
      // destroys nothing, and guessing there risks refusing legitimate code.
      if (fs.existsSync(absoluteFilePath) && typeof change.newContent === "string"
          && isAbbreviated(change.newContent)) {
        throw new Error(
          "Refusing to overwrite " + change.filePath + " with an abbreviated file: it " +
          "contains an \"unchanged\"/\"existing code\" placeholder instead of the real " +
          "contents. Send the complete file.");
      }

      const dir = path.dirname(absoluteFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      if (fs.existsSync(absoluteFilePath)) {
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        const backupPath = path.join(backupDir, change.filePath);
        const backupFileDir = path.dirname(backupPath);
        if (!fs.existsSync(backupFileDir)) fs.mkdirSync(backupFileDir, { recursive: true });
        fs.copyFileSync(absoluteFilePath, backupPath);
      }

      if (change.mode === "create" || change.mode === "overwrite") {
        if (change.mode === "create" && fs.existsSync(absoluteFilePath)) {
          console.log("File exists, overwriting with backup: " + change.filePath);
        }
        fs.writeFileSync(absoluteFilePath, change.newContent || "");
      } else if (change.mode === "search_replace") {
        if (!fs.existsSync(absoluteFilePath)) {
          throw new Error("File not found for search_replace: " + change.filePath);
        }
        const originalContent = fs.readFileSync(absoluteFilePath, "utf-8");
        const at = findSearchBlock(originalContent, change.searchBlock || "");
        if (at === "ambiguous") {
          throw new Error("Search block appears more than once in " + change.filePath +
            "; include enough surrounding lines to make it unique, or send the whole file.");
        }
        if (!at) {
          throw new Error("Search block not found in " + change.filePath +
            "; send the whole file with mode \"overwrite\" instead.");
        }
        fs.writeFileSync(absoluteFilePath,
          applyReplacement(originalContent, at, change.replaceBlock || ""), "utf-8");
      } else {
        throw new Error("Unknown patch mode: " + change.mode);
      }

      appliedFiles.push(change.filePath);
      console.log("Applied " + change.mode + " to: " + change.filePath);
    } catch (error: any) {
      const errMsg = "Failed to apply " + change.filePath + ": " + error.message;
      errors.push(errMsg);
      console.error(errMsg);
    }
  }

  return {
    success: errors.length === 0,
    appliedFiles,
    backupDir: fs.existsSync(backupDir) ? backupDir : undefined,
    errors,
  };
}
