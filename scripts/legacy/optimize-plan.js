const fs = require("fs");
const path = require("path");

console.log("Optimizing plan prompt for speed...\n");

const indexPath = path.join(__dirname, "local-agent", "src", "index.ts");
let index = fs.readFileSync(indexPath, "utf-8");

// Replace the verbose plan prompt with a faster, more direct one
const oldPrompt = `const prompt = "You are a senior software architect.\\n" +
    "Based on the conversation and the current project below, create a step-by-step implementation plan.\\n" +
    "Reply ONLY with a JSON object in this exact shape, wrapped in a \\\`\\\`\\\`json code block:\\n" +
    "{ \\"summary\\": \\"one line goal\\", \\"steps\\": [ { \\"title\\": \\"...\\", \\"detail\\": \\"...\\", \\"files\\": [\\"src/x.py\\"] } ] }\\n" +
    "Use 3 to 8 steps. Each step must be independently buildable and testable.\\n" +
    "IMPORTANT: Each step should create or modify DIFFERENT files. Do NOT plan to dump everything into one file.\\n\\n" +
    "Project structure:\\n" + ctx.tree + "\\n\\n" +
    "Conversation so far:\\n" + transcript;`;

const newPrompt = `const prompt = "Create an implementation plan as JSON:\\n" +
    "{\\"summary\\":\\"goal\\",\\"steps\\":[{\\"title\\":\\"\\",\\"detail\\":\\"\\",\\"files\\":[\\"path\\"]}]}" +
    "Rules: 3-8 steps, each step = different files, wrap in \\\`\\\`\\\`json.\\n\\n" +
    "Project:\\n" + ctx.tree + "\\n\\nChat:\\n" + transcript;`;

index = index.replace(oldPrompt, newPrompt);

fs.writeFileSync(indexPath, index, "utf-8");
console.log("  OK index.ts (faster plan prompt)");

// Also improve the progress logging
const controllerPath = path.join(__dirname, "local-agent", "src", "providers", "playwright-controller.ts");
let controller = fs.readFileSync(controllerPath, "utf-8");

controller = controller.replace(
  /if \(elapsed % 10 === 0\) console\.log\("Still waiting for first token\.\.\. \(" \+ elapsed \+ "s\)"\);/,
  'if (elapsed % 5 === 0) console.log("AI is thinking... (" + elapsed + "s elapsed, complex planning takes 30-60s)");'
);

fs.writeFileSync(controllerPath, controller, "utf-8");
console.log("  OK controller (better progress messages)");

console.log("\nDone. Rebuild + launch.\n");
