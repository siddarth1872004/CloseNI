const fs = require("fs");
const path = require("path");

console.log("\nFIXING: Fresh chats everywhere + optimized prompts...\n");

const indexPath = path.join(__dirname, "local-agent", "src", "index.ts");
let index = fs.readFileSync(indexPath, "utf-8");

// 1. Make plan mode use FRESH chat (not saved thread)
index = index.replace(
  'const { controller, config } = await openProvider(providerId);\n  try {\n    let prevCount = await controller.countMessages(config);\n    let prevContent = await controller.getLastMessageText(config);\n    await controller.sendPrompt(prompt, config);',
  'const { controller, config } = await openProvider(providerId, true);  // FRESH chat\n  try {\n    let prevCount = await controller.countMessages(config);\n    let prevContent = await controller.getLastMessageText(config);\n    await controller.sendPrompt(prompt, config);'
);

// 2. Make revise mode use FRESH chat
index = index.replace(
  'const { controller, config } = await openProvider(providerId);\n  try {\n    let prevCount = await controller.countMessages(config);\n    let prevContent = await controller.getLastMessageText(config);\n    await controller.sendPrompt(prompt, config);',
  'const { controller, config } = await openProvider(providerId, true);  // FRESH chat\n  try {\n    let prevCount = await controller.countMessages(config);\n    let prevContent = await controller.getLastMessageText(config);\n    await controller.sendPrompt(prompt, config);'
);

// 3. Optimize buildPrompt to be more concise
const oldBuildPrompt = `function buildPrompt(userPrompt: string, tree: string, relevantFiles: { path: string; content: string }[], priorFiles: string[]): string {
  let contextStr = "";
  if (tree) contextStr += "\\n\\nProject Structure:\\n" + tree;
  if (relevantFiles.length > 0) {
    contextStr += "\\n\\nRelevant Existing Files (use 'overwrite' mode with FULL content to modify them):\\n";
    for (const f of relevantFiles) contextStr += "\\n--- " + f.path + " ---\\n" + f.content + "\\n";
  }
  if (priorFiles.length > 0) {
    contextStr += "\\n\\nFiles ALREADY in the workspace (DO NOT recreate or collapse into these):\\n";
    for (const f of priorFiles) contextStr += "- " + f + "\\n";
  }
  return "You are an autonomous coding agent assistant.\\n" +
    "You must reply with a valid JSON object containing the file changes.\\n" +
    "Do not include any explanations outside the JSON.\\n" +
    "The JSON format must be exactly like this:\\n" +
    "{\\n  \\"files\\": [\\n    {\\n      \\"path\\": \\"src/hello.py\\",\\n      \\"mode\\": \\"create\\",\\n      \\"content\\": \\"def greet():\\\\n    return 'Hello'\\\\n\\"\\n    }\\n  ],\\n  \\"commands\\": [\\"python src/hello.py\\"]\\n}\\n" +
    "The optional \\"commands\\" array may contain terminal commands to test your changes.\\n" +
    "CRITICAL JSON RULES FOR CODE CONTENT:\\n" +
    "1. Inside the \\"content\\" field, you MUST use the literal two characters \\\\n for newlines.\\n" +
    "2. You MUST preserve all exact whitespace and indentation.\\n" +
    "3. Use single quotes for strings in your code.\\n" +
    "4. You MUST wrap the whole JSON in a markdown code block that starts with \`\`\`json and ends with \`\`\`.\\n" +
    "5. The only allowed values for mode are: create, overwrite, search_replace.\\n" +
    "CRITICAL ARCHITECTURE RULE:\\n" +
    "- Follow clean separation of concerns. Each file has a single responsibility.\\n" +
    "- DO NOT collapse multiple modules into one file.\\n" +
    "- DO NOT reuse or overwrite files that are not related to the current step.\\n" +
    contextStr +
    "\\n\\nUser request:\\n" + userPrompt;
}`;

const newBuildPrompt = `function buildPrompt(userPrompt: string, tree: string, relevantFiles: { path: string; content: string }[], priorFiles: string[]): string {
  let ctx = "";
  if (tree) ctx += "\\nStructure:\\n" + tree;
  if (relevantFiles.length > 0) {
    ctx += "\\n\\nExisting files (modify with overwrite mode):\\n";
    for (const f of relevantFiles) ctx += "--- " + f.path + " ---\\n" + f.content.slice(0, 2000) + (f.content.length > 2000 ? "\\n...(truncated)" : "") + "\\n";
  }
  if (priorFiles.length > 0) {
    ctx += "\\n\\nAlready created (don't recreate): " + priorFiles.slice(0, 20).join(", ");
  }
  return "Reply ONLY with JSON: {\\"files\\":[{\\"path\\":\\"\\",\\"mode\\":\\"create\\",\\"content\\":\\"\\"}],\\"commands\\":[]}" +
    "\\nRules: content uses \\\\n for newlines, wrap in \`\`\`json, mode=create|overwrite|search_replace." +
    "\\nKeep separate files, don't collapse into one." +
    ctx +
    "\\n\\nTask: " + userPrompt;
}`;

index = index.replace(oldBuildPrompt, newBuildPrompt);

fs.writeFileSync(indexPath, index, "utf-8");
console.log("  OK index.ts (fresh chats + concise prompts)");

console.log("\nDone. Rebuild + launch.\n");
