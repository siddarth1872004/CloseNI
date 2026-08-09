const fs = require("fs");
const path = require("path");

console.log("\nFIXING: Smart signature extraction + tighter caps...\n");

const indexPath = path.join(__dirname, "local-agent", "src", "index.ts");
let index = fs.readFileSync(indexPath, "utf-8");

// 1. Add signature extractor before buildMode
const sigFunc = `function extractSignatures(src: string, filePath: string): string {
  if (filePath.endsWith(".py")) {
    const lines = src.split("\\n");
    const out: string[] = [];
    let depth = 0;
    for (const raw of lines) {
      const line = raw.replace(/\\s+$/, "");
      if (/^(import|from)\\s/.test(line)) out.push(line);
      else if (/^class\\s+/.test(line)) { out.push(line); depth = 1; }
      else if (/^def\\s+/.test(line) && depth === 0) out.push(line);
      else if (depth > 0 && /^\\s{4}(def|@)/.test(line)) out.push(line);
      else if (depth > 0 && /^\\S/.test(line)) depth = 0;
    }
    return out.slice(0, 40).join("\\n");
  }
  if (filePath.endsWith(".js") || filePath.endsWith(".ts")) {
    const lines = src.split("\\n");
    const out: string[] = [];
    for (const raw of lines) {
      const line = raw.replace(/\\s+$/, "");
      if (/^import\\s|^export\\s|^(const|let|var|function|class|async function)\\s/.test(line)) out.push(line);
    }
    return out.slice(0, 40).join("\\n");
  }
  return "";
}

`;

if (index.indexOf("function extractSignatures") === -1) {
  index = index.replace(
    "async function buildMode(prompt: string",
    sigFunc + "async function buildMode(prompt: string"
  );
}

// 2. Replace the scoring/content block with signature-based, tighter caps
const oldBlock = `  scored.sort((a, b) => b.score - a.score);
  const relevant = scored.slice(0, 3).map(f => ({ path: f.path, content: f.content.slice(0, 2000) }));

  console.log("Step " + (stepIndex + 1) + ": including " + relevant.length + " files from prior steps" +
    (relevant.length ? " (" + relevant.map(f => f.path).join(", ") + ")" : ""));`;

const newBlock = `  // Penalize large files - they're implementation-heavy, not public-API useful
  for (const s of scored) {
    if (s.content.length > 3000) s.score -= 5;
    if (s.content.length > 8000) s.score -= 10;
  }
  scored.sort((a, b) => b.score - a.score);

  // Use signature extraction instead of raw content - keeps prompts small and focused
  const relevant = scored.slice(0, 4).map(f => {
    const sig = extractSignatures(f.content, f.path);
    const finalContent = sig.length > 10 && sig.length < 800 ? sig : f.content.slice(0, 600);
    return { path: f.path, content: finalContent };
  }).filter(f => f.content.length > 0);

  console.log("Step " + (stepIndex + 1) + ": including " + relevant.length + " files (signatures) from prior steps" +
    (relevant.length ? " (" + relevant.map(f => f.path + ":" + f.content.length + "c").join(", ") + ")" : ""));`;

if (index.indexOf(oldBlock) !== -1) {
  index = index.replace(oldBlock, newBlock);
  fs.writeFileSync(indexPath, index, "utf-8");
  console.log("  OK index.ts (signature extraction + tighter caps)");
} else {
  console.log("  !! anchor not found");
  console.log(index.substring(index.indexOf("scored.sort"), index.indexOf("scored.sort") + 400));
}

// 3. Fix the misleading "90s" log message in the controller
const cPath = path.join(__dirname, "local-agent", "src", "providers", "playwright-controller.ts");
let c = fs.readFileSync(cPath, "utf-8");
c = c.replace(
  'console.log("Timeout after 90s - DeepSeek may be overloaded or slow. Extracting partial response.");',
  'console.log("Timeout after 120s - extracting partial response.");'
);
fs.writeFileSync(cPath, c, "utf-8");
console.log("  OK controller (fixed misleading 90s message)");

console.log("\nDone. Rebuild + launch.\n");
