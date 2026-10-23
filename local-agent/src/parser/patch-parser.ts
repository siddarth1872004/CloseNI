import { EditPlan, FileChange, PatchMode } from "@agentic/shared";
import { parseFilesRobust } from "./json-repair.js";

function normalizeChange(change: FileChange): FileChange {
  if (change.mode !== "create" && change.mode !== "overwrite" && change.mode !== "search_replace") {
    if (change.searchBlock && change.replaceBlock !== undefined) change.mode = "search_replace";
    else if (change.newContent !== undefined) change.mode = "overwrite";
    else change.mode = "create";
  }
  return change;
}

export function parseMarkdownToEditPlan(markdown: string): EditPlan {
  const warnings: string[] = [];
  const errors: string[] = [];
  const commands: string[] = [];

  // Layer 1+2: robust JSON parse with repair engine
  const robust = parseFilesRobust(markdown);
  if (robust) {
    const changes = robust.changes.map((c: any) => normalizeChange({
      filePath: c.filePath,
      mode: c.mode,
      language: c.language,
      newContent: c.newContent,
      searchBlock: c.searchBlock,
      replaceBlock: c.replaceBlock,
    }));
    return { changes: changes, warnings: warnings, errors: errors, commands: robust.commands, rawMarkdown: markdown };
  }

  // Layer 3: regex rescue for completely broken JSON
  const changes: FileChange[] = [];
  const blocks = markdown.split(/"path"\s*:\s*"/);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const pathMatch = block.match(/^([^"]+)"\s*,\s*"mode"\s*:\s*"([^"]+)"[\s\S]*?"content"\s*:\s*"([\s\S]*)"\s*\}/);
    if (pathMatch) {
      let content = pathMatch[3];
      content = content.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\t/g, "\t");
      changes.push(normalizeChange({
        filePath: pathMatch[1],
        mode: pathMatch[2] as PatchMode,
        newContent: content,
      }));
    }
  }

  if (changes.length === 0 && markdown.trim().length > 0) {
    warnings.push("Could not parse response as JSON or Regex fallback.");
  }

  return { changes: changes, warnings: warnings, errors: errors, commands: commands, rawMarkdown: markdown };
}
