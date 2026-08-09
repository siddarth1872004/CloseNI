const fs = require("fs");
const path = require("path");

console.log("\n=== FIXING BUILD ERRORS ===\n");

// 1. Fix controller - remove all old references, initialize properties
const cPath = path.join(__dirname, "local-agent", "src", "providers", "playwright-controller.ts");
let c = fs.readFileSync(cPath, "utf-8");

// Fix property declarations
c = c.replace(
  'private sessionStoreFile: string;\n  private workspace: string;',
  'private sessionStoreFile: string = "";\n  private workspace: string = "";'
);

// Remove old chatUrlFile reference
c = c.replace('this.chatUrlFile = path.join(storageDir, "last-chat-url.json");', "");

// Remove old loadChatUrl call in navigateToChat
c = c.replace('const savedUrl = this.loadChatUrl();', 'const savedUrl = this.getChatUrlForWorkspace(this.workspace);');

// Remove old saveChatUrl calls
c = c.replace(/this\.saveChatUrl\(currentUrl\);/g, 'this.setChatUrlForWorkspace(this.workspace, currentUrl);');
c = c.replace(/this\.saveChatUrl\(updatedUrl\);/g, 'this.setChatUrlForWorkspace(this.workspace, updatedUrl);');

fs.writeFileSync(cPath, c, "utf-8");
console.log("  OK controller (removed old references)");

// 2. Fix index.ts - chatMode doesn't have workspace in scope
const indexPath = path.join(__dirname, "local-agent", "src", "index.ts");
let index = fs.readFileSync(indexPath, "utf-8");

// chatMode needs workspace parameter
index = index.replace(
  'async function chatMode(prompt: string, providerId: string) {',
  'async function chatMode(prompt: string, providerId: string, workspace: string = "") {'
);

// Update the chatMode call in main()
index = index.replace(
  'if (mode === "chat") await chatMode(prompt, providerId);',
  'if (mode === "chat") await chatMode(prompt, providerId, workspace);'
);

fs.writeFileSync(indexPath, index, "utf-8");
console.log("  OK index.ts (workspace parameter)");

console.log("\nDone. Rebuild + launch.\n");
