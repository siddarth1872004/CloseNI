const fs = require("fs");
const path = require("path");

console.log("\nFIXING: Share previous-step files across fresh chats...\n");

const indexPath = path.join(__dirname, "local-agent", "src", "index.ts");
let index = fs.readFileSync(indexPath, "utf-8");

// Replace buildMode to accumulate files across steps
const oldBuildMode = `async function buildMode(prompt: string, workspace: string, providerId: string, autonomy: string, stepIndex: number, stepDetail: string, goalSummary: string) {
  const maxFollowUps = 2;
  const ctx = getProjectContext(workspace, prompt);
  
  // Extract expected files from stepDetail (they're listed as "Expected files: x.py, y.py")
  const expectedMatch = stepDetail.match(/Expected files: (.+?)(?:\\n|$)/);
  const expectedFiles = expectedMatch ? expectedMatch[1].split(",").map(f => f.trim()).filter(Boolean) : [];
  
  // Only include files that are in the expected list OR are dependencies
  const relevant = ctx.relevantFiles
    .filter(f => expectedFiles.length === 0 || expectedFiles.some(ef => f.path.includes(ef) || ef.includes(f.path)))
    .map(f => ({ path: f.path, content: (f.content || "").slice(0, 1000) }))
    .slice(0, 3);
  
  console.log("Found " + relevant.length + " relevant files for step " + (stepIndex + 1));`;

const newBuildMode = `async function buildMode(prompt: string, workspace: string, providerId: string, autonomy: string, stepIndex: number, stepDetail: string, goalSummary: string) {
  const maxFollowUps = 2;
  const ctx = getProjectContext(workspace, prompt);

  // Smart context: scan ALL existing files in workspace (from prior steps) and pick the most relevant ones
  // This is the KEY fix - step N sees what steps 1..N-1 created
  const allFiles: { path: string; content: string }[] = [];
  try {
    const priorPaths: string[] = [];
    const walkStack = [workspace];
    while (walkStack.length) {
      const dir = walkStack.pop()!;
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (["node_modules", ".git", ".agent-backups", "__pycache__", "dist", "build", "venv", "env", ".venv"].indexOf(e.name) !== -1) continue;
        if (e.name.startsWith(".")) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkStack.push(p);
        else if (e.name.endsWith(".py") || e.name.endsWith(".js") || e.name.endsWith(".ts")) priorPaths.push(p);
      }
    }
    for (const p of priorPaths) {
      try {
        const content = fs.readFileSync(p, "utf-8");
        allFiles.push({ path: path.relative(workspace, p).replace(/\\\\/g, "/"), content: content });
      } catch {}
    }
  } catch {}

  // Score files: prioritize files that share package roots or keywords with expected files
  const expectedMatch = stepDetail.match(/Expected files: (.+?)(?:\\n|$)/);
  const expectedFiles = expectedMatch ? expectedMatch[1].split(",").map(f => f.trim()).filter(Boolean) : [];

  const scored = allFiles.map(f => {
    let score = 0;
    const dir = f.path.split("/").slice(0, -1).join("/");
    for (const ef of expectedFiles) {
      const edir = ef.split("/").slice(0, -1).join("/");
      if (dir === edir) score += 10;
      else if (dir && edir && (dir.startsWith(edir) || edir.startsWith(dir))) score += 5;
      if (f.path.indexOf(path.basename(ef)) !== -1) score += 3;
    }
    // Also boost by keyword match in prompt/stepDetail
    const words = (prompt + " " + stepDetail).toLowerCase().split(/\\W+/).filter(w => w.length > 3);
    for (const w of words) {
      if (f.path.toLowerCase().indexOf(w) !== -1) score += 2;
    }
    return { ...f, score: score };
  });

  scored.sort((a, b) => b.score - a.score);
  const relevant = scored.slice(0, 3).map(f => ({ path: f.path, content: f.content.slice(0, 2000) }));

  console.log("Step " + (stepIndex + 1) + ": including " + relevant.length + " files from prior steps" +
    (relevant.length ? " (" + relevant.map(f => f.path).join(", ") + ")" : ""));`;

if (index.indexOf(oldBuildMode) !== -1) {
  index = index.replace(oldBuildMode, newBuildMode);
  fs.writeFileSync(indexPath, index, "utf-8");
  console.log("  OK index.ts (cross-step file sharing)");
} else {
  console.log("  !! Could not find buildMode anchor, dumping current...");
  console.log(index.substring(index.indexOf("async function buildMode"), index.indexOf("async function buildMode") + 400));
}

console.log("\nDone. Rebuild + launch.\n");
