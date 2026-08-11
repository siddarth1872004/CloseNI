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
        if (!originalContent.includes(change.searchBlock || "")) {
          throw new Error("Search block not found in " + change.filePath);
        }
        const newContent = originalContent.replace(change.searchBlock || "", change.replaceBlock || "");
        fs.writeFileSync(absoluteFilePath, newContent, "utf-8");
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
