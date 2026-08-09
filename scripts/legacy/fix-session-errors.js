const fs = require("fs");
const path = require("path");

console.log("\n=== FIXING SESSION FILE ERRORS ===\n");

// 1. Fix controller - make session loading defensive
const cPath = path.join(__dirname, "local-agent", "src", "providers", "playwright-controller.ts");
let c = fs.readFileSync(cPath, "utf-8");

// Make loadSessions more defensive
c = c.replace(
  /private loadSessions\(\): any \{[\s\S]*?return \{\};\s*\}/,
  `private loadSessions(): any {
    try {
      if (!this.sessionStoreFile || !fs.existsSync(this.sessionStoreFile)) {
        return {};
      }
      const content = fs.readFileSync(this.sessionStoreFile, "utf-8");
      return JSON.parse(content);
    } catch (e) {
      console.log("Failed to load sessions: " + e);
      return {};
    }
  }`
);

// Make saveSessions defensive
c = c.replace(
  /private saveSessions\(sessions: any\) \{[\s\S]*?\}/,
  `private saveSessions(sessions: any) {
    try {
      if (!this.sessionStoreFile) return;
      const dir = path.dirname(this.sessionStoreFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.sessionStoreFile, JSON.stringify(sessions, null, 2), "utf-8");
    } catch (e) {
      console.log("Failed to save sessions: " + e);
    }
  }`
);

// Make getChatUrlForWorkspace defensive
c = c.replace(
  /getChatUrlForWorkspace\(workspace: string\): string \| null \{[\s\S]*?return sessions\[workspace\]\?\.activeChat \|\| null;/,
  `getChatUrlForWorkspace(workspace: string): string | null {
    if (!workspace) return null;
    const sessions = this.loadSessions();
    return sessions[workspace]?.activeChat || null;
  }`
);

fs.writeFileSync(cPath, c, "utf-8");
console.log("  OK controller (defensive session handling)");

// 2. Fix renderer - handle getChats error
const rPath = path.join(__dirname, "desktop", "renderer.js");
let r = fs.readFileSync(rPath, "utf-8");

r = r.replace(
  /async function loadChatsForWorkspace\(\) \{[\s\S]*?\}\s*\}/,
  `async function loadChatsForWorkspace() {
    if (!workspace) return;
    try {
      const res = await window.api.getChats(workspace);
      availableChats = res.chats || [];
      currentChatIndex = -1;
      updateChatSelector();
    } catch (e) {
      console.log("Failed to load chats (first time?):", e);
      availableChats = [];
      currentChatIndex = -1;
      updateChatSelector();
    }
  }`
);

fs.writeFileSync(rPath, r, "utf-8");
console.log("  OK renderer (error handling)");

// 3. Fix main.js - make IPC handlers defensive
const mPath = path.join(__dirname, "desktop", "main.js");
let m = fs.readFileSync(mPath, "utf-8");

m = m.replace(
  /ipcMain\.handle\("get-chats"[\s\S]*?return \{ chats: \[\] \};/,
  `ipcMain.handle("get-chats", async (event, workspace) => {
    if (!workspace) return { chats: [] };
    const sessionsFile = path.join(__dirname, "..", "local-agent", "storage", "sessions.json");
    try {
      if (fs.existsSync(sessionsFile)) {
        const sessions = JSON.parse(fs.readFileSync(sessionsFile, "utf-8"));
        return { chats: sessions[workspace]?.chats || [] };
      }
    } catch (e) {
      console.log("get-chats error:", e);
    }
    return { chats: [] };`
);

fs.writeFileSync(mPath, m, "utf-8");
console.log("  OK main.js (defensive IPC)");

// 4. Ensure storage directory exists
const storageDir = path.join(__dirname, "local-agent", "storage");
if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir, { recursive: true });
  console.log("  Created storage directory");
}

console.log("\nDone. Rebuild + launch.\n");
