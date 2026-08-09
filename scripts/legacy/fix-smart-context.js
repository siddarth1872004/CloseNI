const fs = require("fs");
const path = require("path");

console.log("\nFIXING: Smart context (only step-specific files)...\n");

const indexPath = path.join(__dirname, "local-agent", "src", "index.ts");
let index = fs.readFileSync(indexPath, "utf-8");

// Replace buildMode to pass step's expected files and filter context
const oldBuildMode = `async function buildMode(prompt: string, workspace: string, providerId: string, autonomy: string, stepIndex: number, stepDetail: string, goalSummary: string) {
  const maxFollowUps = 2;
  const ctx = getProjectContext(workspace, prompt);
  const relevant = ctx.relevantFiles.map(function (f) { return { path: f.path, content: (f.content || "").slice(0, 4000) }; });
  console.log("Found " + relevant.length + " relevant files.");`;

const newBuildMode = `async function buildMode(prompt: string, workspace: string, providerId: string, autonomy: string, stepIndex: number, stepDetail: string, goalSummary: string) {
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

index = index.replace(oldBuildMode, newBuildMode);

fs.writeFileSync(indexPath, index, "utf-8");
console.log("  OK index.ts (smart context filtering)");

console.log("\nDone. Rebuild + launch.\n");
