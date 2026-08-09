const fs = require("fs");
const path = require("path");

console.log("PERFORMANCE OVERHAUL: fresh chats + minimal prompts + fast timeouts...\n");

// ---------- 1. Rewrite index.ts with fresh chats everywhere except Plan ----------
const indexPath = path.join(__dirname, "local-agent", "src", "index.ts");
let index = fs.readFileSync(indexPath, "utf-8");

// Chat mode: FRESH chat (not saved thread)
index = index.replace(
  'async function chatMode(prompt: string, providerId: string) {\n  const { controller, config } = await openProvider(providerId);',
  'async function chatMode(prompt: string, providerId: string) {\n  const { controller, config } = await openProvider(providerId, true);  // FRESH chat'
);

// Revise mode: FRESH chat
index = index.replace(
  'async function revisePlanMode(changes: string, workspace: string, providerId: string) {\n  const prompt = "Please update the implementation plan you created earlier',
  'async function revisePlanMode(changes: string, workspace: string, providerId: string) {\n  const prompt = "Update plan with: " + changes + "\\n\\nJSON format: {\\"summary\\":\\"\\",\\"steps\\":[{\\"title\\":\\"\\",\\"detail\\":\\"\\",\\"files\\":[\\"\\"]}]}\\n3-8 steps, different files per step.";\n  const { controller, config } = await openProvider(providerId, true);  // FRESH chat\n  try {\n    let prevCount = await controller.countMessages(config);\n    let prevContent = await controller.getLastMessageText(config);\n    await controller.sendPrompt(prompt, config);\n    let response = await controller.waitForResponse(config, prevCount, prevContent);\n    let plan = parsePlanRobust(response);\n    if (!plan) {\n      prevCount = await controller.countMessages(config);\n      prevContent = await controller.getLastMessageText(config);\n      await controller.sendPrompt(REASK_PROMPT, config);\n      response = await controller.waitForResponse(config, prevCount, prevContent);\n      plan = parsePlanRobust(response);\n    }\n    if (plan && plan.steps) emit({ success: true, plan: plan });\n    else emit({ success: false, error: "Could not parse revised plan.", raw: response });\n  } finally { await controller.close(); }\n}\n\nasync function revisePlanModeOld(changes: string, workspace: string, providerId: string) {\n  const prompt = "Please update the implementation plan you created earlier'
);

fs.writeFileSync(indexPath, index, "utf-8");
console.log("  OK index.ts (fresh chats for chat/revise)");

// ---------- 2. Reduce max wait from 10m to 90s ----------
const controllerPath = path.join(__dirname, "local-agent", "src", "providers", "playwright-controller.ts");
let controller = fs.readFileSync(controllerPath, "utf-8");

controller = controller.replace(
  'const maxWait = 600000;',
  'const maxWait = 90000;  // 90 seconds max (fail fast)'
);

controller = controller.replace(
  'console.log("Waiting for AI response (patient mode, up to 10m)...");',
  'console.log("Waiting for AI response (90s timeout)...");'
);

controller = controller.replace(
  'console.log("Max wait reached (10m), extracting whatever is there.");',
  'console.log("Timeout after 90s - DeepSeek may be overloaded or slow. Extracting partial response.");'
);

controller = controller.replace(
  /if \(elapsed % 15 === 0\) console\.log\("DeepSeek is planning\.\.\. \(" \+ elapsed \+ "s, this can take 2-10 minutes for complex tasks\)"\);/,
  'if (elapsed % 10 === 0) console.log("Waiting... (" + elapsed + "s / 90s)");'
);

fs.writeFileSync(controllerPath, controller, "utf-8");
console.log("  OK controller (90s timeout, faster fail)");

console.log("\nDone. Rebuild + launch.\n");
