const fs = require("fs");
const path = require("path");

console.log("\n=== SESSION-BASED CHAT MANAGEMENT + UI FIXES ===\n");

// 1. Rewrite controller with session management
const cPath = path.join(__dirname, "local-agent", "src", "providers", "playwright-controller.ts");
let c = fs.readFileSync(cPath, "utf-8");

// Add session storage
c = c.replace(
  'private chatUrlFile: string;',
  'private sessionStoreFile: string;\n  private workspace: string;'
);

c = c.replace(
  'constructor(config: ProviderConfig) {\n    const storageDir = path.join(config.profileDir, "..", "..");\n    if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });\n    this.chatUrlFile = path.join(storageDir, "last-chat-url.json");',
  `constructor(config: ProviderConfig) {
    const storageDir = path.join(config.profileDir, "..", "..");
    if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
    this.sessionStoreFile = path.join(storageDir, "sessions.json");
    this.workspace = "";
    this.isHeaded = process.env.AGENT_HEADED === "1";`
);

// Add session management methods
const sessionMethods = `
  setWorkspace(ws: string) {
    this.workspace = ws;
  }

  private loadSessions(): any {
    try {
      if (fs.existsSync(this.sessionStoreFile)) {
        return JSON.parse(fs.readFileSync(this.sessionStoreFile, "utf-8"));
      }
    } catch (e) {}
    return {};
  }

  private saveSessions(sessions: any) {
    fs.writeFileSync(this.sessionStoreFile, JSON.stringify(sessions, null, 2), "utf-8");
  }

  getChatUrlForWorkspace(workspace: string): string | null {
    const sessions = this.loadSessions();
    return sessions[workspace]?.activeChat || null;
  }

  setChatUrlForWorkspace(workspace: string, url: string, title?: string) {
    const sessions = this.loadSessions();
    if (!sessions[workspace]) sessions[workspace] = { chats: [], activeChat: null };
    sessions[workspace].activeChat = url;
    if (title && !sessions[workspace].chats.find((c: any) => c.url === url)) {
      sessions[workspace].chats.push({ url: url, title: title || "Chat " + (sessions[workspace].chats.length + 1), createdAt: new Date().toISOString() });
    }
    this.saveSessions(sessions);
  }

  getAllChatsForWorkspace(workspace: string): any[] {
    const sessions = this.loadSessions();
    return sessions[workspace]?.chats || [];
  }

  createNewChat(workspace: string): string | null {
    const sessions = this.loadSessions();
    if (!sessions[workspace]) sessions[workspace] = { chats: [], activeChat: null };
    sessions[workspace].activeChat = null; // Force new chat on next navigate
    this.saveSessions(sessions);
    return null;
  }

`;

if (c.indexOf("setWorkspace") === -1) {
  c = c.replace("  async launch(config: ProviderConfig)", sessionMethods + "  async launch(config: ProviderConfig)");
}

// Update navigateToChat to use session storage
c = c.replace(
  /async navigateToChat\(config: ProviderConfig\): Promise<void> \{[\s\S]*?if \(updatedUrl && updatedUrl !== config\.baseUrl\) \{\s*saveChatUrl\(updatedUrl\);\s*\}/,
  `async navigateToChat(config: ProviderConfig): Promise<void> {
    if (!this.page) throw new Error("Browser not launched");
    const savedUrl = this.getChatUrlForWorkspace(this.workspace);
    if (savedUrl) {
      console.log("Resuming session chat: " + savedUrl);
      await this.page.goto(savedUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      try {
        await this.page.waitForSelector(config.selectors.chatInput, { timeout: 5000, state: "visible" });
        console.log("Session chat loaded successfully");
        return;
      } catch {
        console.log("Session chat URL invalid, starting new chat...");
      }
    }
    console.log("Starting new chat for workspace: " + this.workspace);
    await this.page.goto(config.baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  }`
);

// Update sendPrompt to save to session storage
c = c.replace(
  /const currentUrl = this\.page\.url\(\);[\s\S]*?if \(updatedUrl && updatedUrl !== config\.baseUrl\) \{\s*saveChatUrl\(updatedUrl\);\s*\}/,
  `const currentUrl = this.page.url();
    if (currentUrl && currentUrl !== config.baseUrl && !currentUrl.endsWith("/")) {
      this.setChatUrlForWorkspace(this.workspace, currentUrl);
    } else {
      await sleep(2000);
      const updatedUrl = this.page.url();
      if (updatedUrl && updatedUrl !== config.baseUrl) {
        this.setChatUrlForWorkspace(this.workspace, updatedUrl);
      }
    }`
);

// Remove old saveChatUrl/loadChatUrl methods
c = c.replace(/private saveChatUrl[\s\S]*?return null;\n  \}\n/, "");

fs.writeFileSync(cPath, c, "utf-8");
console.log("  OK controller (session management)");

// 2. Update index.ts to pass workspace to controller
const indexPath = path.join(__dirname, "local-agent", "src", "index.ts");
let index = fs.readFileSync(indexPath, "utf-8");

index = index.replace(
  /async function openProvider\(providerId: string, fresh: boolean = false\) \{[\s\S]*?await controller\.waitForLogin\(\);/,
  `async function openProvider(providerId: string, fresh: boolean = false, workspace: string = "") {
    const registry = new ProviderRegistry();
    registry.loadProviders();
    const config = registry.getProvider(providerId);
    if (!config) throw new Error("Provider not found: " + providerId);
    const controller = new PlaywrightController(config);
    controller.setWorkspace(workspace);
    await controller.launch(config);
    if (fresh) await controller.navigateFresh(config);
    else await controller.navigateToChat(config);
    await controller.waitForLogin();`
);

// Update all openProvider calls to pass workspace
index = index.replace(/await openProvider\(providerId\)/g, 'await openProvider(providerId, false, workspace)');
index = index.replace(/await openProvider\(providerId, true\)/g, 'await openProvider(providerId, true, workspace)');
index = index.replace(/await openProvider\(providerId\);  \/\/ FRESH chat/g, 'await openProvider(providerId, true, workspace);  // FRESH chat');

fs.writeFileSync(indexPath, index, "utf-8");
console.log("  OK index.ts (workspace passing)");

// 3. Add chat selection UI to renderer
const rPath = path.join(__dirname, "desktop", "renderer.js");
let r = fs.readFileSync(rPath, "utf-8");

// Add chat management functions
const chatMgmt = `
let availableChats = [];
let currentChatIndex = 0;

function updateChatSelector() {
  const select = $("chat-select");
  if (!select) return;
  select.innerHTML = '<option value="new">+ New Chat</option>';
  availableChats.forEach((chat, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = chat.title || ("Chat " + (i + 1));
    if (i === currentChatIndex) opt.selected = true;
    select.appendChild(opt);
  });
}

async function loadChatsForWorkspace() {
  if (!workspace) return;
  try {
    const res = await window.api.getChats(workspace);
    availableChats = res.chats || [];
    currentChatIndex = -1;
    updateChatSelector();
  } catch (e) {
    console.error("Failed to load chats:", e);
  }
}

$("chat-select").onchange = function (e) {
  const val = e.target.value;
  if (val === "new") {
    window.api.newChat(workspace).then(() => {
      currentChatIndex = -1;
      toast("Started new chat");
      log("New chat started", "ok");
    });
  } else {
    currentChatIndex = parseInt(val);
    const chat = availableChats[currentChatIndex];
    if (chat) {
      window.api.switchChat(workspace, chat.url).then(() => {
        toast("Switched to: " + chat.title);
        log("Switched to chat: " + chat.title, "ok");
      });
    }
  }
};

$("new-chat-btn").onclick = function () {
  window.api.newChat(workspace).then(() => {
    currentChatIndex = -1;
    toast("Started new chat");
    log("New chat started", "ok");
  });
};

`;

if (r.indexOf("updateChatSelector") === -1) {
  r = r.replace("window.CN = {", chatMgmt + "window.CN = {");
}

// Call loadChatsForWorkspace when workspace changes
r = r.replace(
  'if (f) { workspace = f; $("workspace-label").textContent = f; log("workspace: " + f, "ok"); }',
  'if (f) { workspace = f; $("workspace-label").textContent = f; log("workspace: " + f, "ok"); loadChatsForWorkspace(); }'
);

fs.writeFileSync(rPath, r, "utf-8");
console.log("  OK renderer (chat management UI)");

// 4. Add IPC handlers for chat management in main.js
const mPath = path.join(__dirname, "desktop", "main.js");
let m = fs.readFileSync(mPath, "utf-8");

const chatIpc = `
ipcMain.handle("get-chats", async (event, workspace) => {
  const sessionsFile = path.join(__dirname, "..", "local-agent", "storage", "sessions.json");
  try {
    if (fs.existsSync(sessionsFile)) {
      const sessions = JSON.parse(fs.readFileSync(sessionsFile, "utf-8"));
      return { chats: sessions[workspace]?.chats || [] };
    }
  } catch (e) {}
  return { chats: [] };
});

ipcMain.handle("new-chat", async (event, workspace) => {
  const sessionsFile = path.join(__dirname, "..", "local-agent", "storage", "sessions.json");
  try {
    let sessions = {};
    if (fs.existsSync(sessionsFile)) {
      sessions = JSON.parse(fs.readFileSync(sessionsFile, "utf-8"));
    }
    if (!sessions[workspace]) sessions[workspace] = { chats: [], activeChat: null };
    sessions[workspace].activeChat = null;
    fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2), "utf-8");
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
});

ipcMain.handle("switch-chat", async (event, workspace, url) => {
  const sessionsFile = path.join(__dirname, "..", "local-agent", "storage", "sessions.json");
  try {
    let sessions = {};
    if (fs.existsSync(sessionsFile)) {
      sessions = JSON.parse(fs.readFileSync(sessionsFile, "utf-8"));
    }
    if (!sessions[workspace]) sessions[workspace] = { chats: [], activeChat: null };
    sessions[workspace].activeChat = url;
    fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2), "utf-8");
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
});

`;

if (m.indexOf('ipcMain.handle("get-chats"') === -1) {
  m = m.replace("ipcMain.handle('run-agent'", chatIpc + "ipcMain.handle('run-agent'");
}

fs.writeFileSync(mPath, m, "utf-8");
console.log("  OK main.js (chat IPC handlers)");

// 5. Add preload methods
const pPath = path.join(__dirname, "desktop", "preload.js");
let p = fs.readFileSync(pPath, "utf-8");

const preloadMethods = `
  getChats: (workspace) => ipcRenderer.invoke('get-chats', workspace),
  newChat: (workspace) => ipcRenderer.invoke('new-chat', workspace),
  switchChat: (workspace, url) => ipcRenderer.invoke('switch-chat', workspace, url),
`;

if (p.indexOf("getChats:") === -1) {
  p = p.replace("onApproval:", preloadMethods + "  onApproval:");
}

fs.writeFileSync(pPath, p, "utf-8");
console.log("  OK preload.js (chat methods)");

// 6. Update index.html with chat selector
const hPath = path.join(__dirname, "desktop", "index.html");
let h = fs.readFileSync(hPath, "utf-8");

if (h.indexOf("chat-select") === -1) {
  h = h.replace(
    '<button id="browse-btn" class="btn">Browse</button>',
    `<button id="browse-btn" class="btn">Browse</button>
      <div class="micro" style="margin-top:10px;">Chat Session</div>
      <select id="chat-select" style="margin-bottom:6px;">
        <option value="new">+ New Chat</option>
      </select>
      <button id="new-chat-btn" class="btn" style="font-size:10px;padding:4px 8px;">New Chat</button>`
  );
}

fs.writeFileSync(hPath, h, "utf-8");
console.log("  OK index.html (chat selector UI)");

console.log("\nDone. Rebuild + launch.\n");
