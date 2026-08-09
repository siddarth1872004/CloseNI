const fs = require("fs");
const path = require("path");

console.log("Fixing verbose chat + slow plan...\n");

// ---------- 1. Fix chat framing to be less code-heavy ----------
const indexPath = path.join(__dirname, "local-agent", "src", "index.ts");
let index = fs.readFileSync(indexPath, "utf-8");

index = index.replace(
  'await controller.sendPrompt("You are in normal conversation mode. Answer naturally with markdown (short paragraphs, headings, lists, code blocks when useful). Do NOT output JSON unless the user explicitly asks for a plan or code changes.\\n\\nUser message:\\n" + prompt, config);',
  'await controller.sendPrompt("You are in normal conversation mode. Answer with brief descriptions and high-level architecture. Do NOT include full code implementations unless explicitly asked. Use markdown for formatting.\\n\\nUser message:\\n" + prompt, config);'
);

fs.writeFileSync(indexPath, index, "utf-8");
console.log("  OK index.ts (less verbose chat)");

// ---------- 2. Reduce stable wait from 16s to 8s ----------
const controllerPath = path.join(__dirname, "local-agent", "src", "providers", "playwright-controller.ts");
let controller = fs.readFileSync(controllerPath, "utf-8");

controller = controller.replace(
  'if (stableCount >= 8) {',
  'if (stableCount >= 4) {  // 8s stable (4 checks × 2s)'
);

controller = controller.replace(
  'console.log("Response complete (stable for 16s)!");',
  'console.log("Response complete (stable for 8s)!");'
);

fs.writeFileSync(controllerPath, controller, "utf-8");
console.log("  OK controller (8s stable detection instead of 16s)");

console.log("\nDone. Rebuild + launch.\n");
