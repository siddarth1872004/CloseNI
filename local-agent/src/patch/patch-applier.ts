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
