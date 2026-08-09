import * as fs from "fs";
import * as path from "path";

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".agent-backups", "__pycache__",
  "venv", "env", ".venv", "dist", "build", ".next", ".cache"
]);

const IGNORE_EXTS = new Set([
  ".exe", ".dll", ".so", ".o", ".a", ".bin", ".png", ".jpg", ".jpeg",
  ".gif", ".mp4", ".mp3", ".zip", ".tar", ".gz", ".lock"
]);

export interface ProjectContext {
  tree: string;
  relevantFiles: { path: string; content: string }[];
}

export function getProjectContext(workspaceRoot: string, userPrompt: string, maxFileCount: number = 4): ProjectContext {
  const tree = buildTree(workspaceRoot, "", 2);
  const keywords = extractKeywords(userPrompt);
  const allFiles = getAllFiles(workspaceRoot);
  
  const scoredFiles = allFiles.map(f => ({
    path: f,
    score: scoreFile(f, keywords, workspaceRoot)
  })).filter(f => f.score > 0).sort((a, b) => b.score - a.score);

  const relevantFiles = scoredFiles.slice(0, maxFileCount).map(f => ({
    path: path.relative(workspaceRoot, f.path),
    content: readSafe(f.path)
  }));

  return { tree, relevantFiles };
}

function buildTree(dir: string, indent: string, maxDepth: number): string {
  if (maxDepth < 0) return "";
  let tree = "";
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".env") continue;
      const fullPath = path.join(dir, entry.name);
      tree += indent + "- " + entry.name + "\n";
      if (entry.isDirectory()) {
        tree += buildTree(fullPath, indent + "  ", maxDepth - 1);
      }
    }
  } catch {}
  return tree;
}

function getAllFiles(dir: string): string[] {
  let files: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files = files.concat(getAllFiles(fullPath));
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (!IGNORE_EXTS.has(ext)) {
          files.push(fullPath);
        }
      }
    }
  } catch {}
  return files;
}

function extractKeywords(prompt: string): string[] {
  const words = prompt.split(/[\s\.,\/\?!\-]+/).filter(w => w.length > 3);
  return Array.from(new Set(words.map(w => w.toLowerCase())));
}

function scoreFile(filePath: string, keywords: string[], root: string): number {
  let score = 0;
  const relPath = path.relative(root, filePath).toLowerCase();
  for (const kw of keywords) {
    if (relPath.includes(kw)) score += 10;
  }
  try {
    const content = readSafe(filePath).toLowerCase();
    if (content) {
      for (const kw of keywords) {
        if (content.includes(kw)) score += 5;
      }
    }
  } catch {}
  return score;
}

function readSafe(filePath: string): string {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size > 100 * 1024) return "[File too large to read]";
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "[Error reading file]";
  }
}
