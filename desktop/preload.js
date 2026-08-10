const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("api", {
  // The renderer has no `process`. Entry point detection needs it: Windows has
  // no `./` prefix and calls the interpreter `python`, not `python3`.
  platform: process.platform,
  selectFolder: function () { return ipcRenderer.invoke("select-folder"); },
  runAgent: function (payload) { return ipcRenderer.invoke("run-agent", payload); },
  suggest: function (payload) { return ipcRenderer.invoke("suggest", payload); },
  askRun: function (p) { return ipcRenderer.invoke("ask-run", p); },
  listFiles: function (workspace) { return ipcRenderer.invoke("list-files", workspace); },
  listProviders: function () { return ipcRenderer.invoke("list-providers"); },
  readManifest: function (workspace) { return ipcRenderer.invoke("read-manifest", workspace); },
  writeManifest: function (p) { return ipcRenderer.invoke("write-manifest", p); },
  browserStatus: function () { return ipcRenderer.invoke("browser-status"); },
  installBrowser: function () { return ipcRenderer.invoke("install-browser"); },
  onBrowserProgress: function (cb) { ipcRenderer.on("browser-progress", function (e, line) { cb(line); }); },
  signIn: function (providerId) { return ipcRenderer.invoke("sign-in", providerId); },
  startSession: function (workspace, provider, autonomy, headed, controls) {
    return ipcRenderer.invoke("start-session", { workspace: workspace, provider: provider, autonomy: autonomy, headed: headed, controls: controls });
  },
  sendStep: function (index, detail, goal) {
    return ipcRenderer.invoke("send-step", { index: index, detail: detail, goal: goal });
  },
  endSession: function () { return ipcRenderer.invoke("end-session"); },
  runCommand: function (p) { return ipcRenderer.invoke("run-command", p); },
  git: function (p) { return ipcRenderer.invoke("git", p); },
  readFile: function (p, opts) { return ipcRenderer.invoke("read-file", opts ? { path: p, full: !!opts.full } : p); },
  respondApproval: function (approved) { return ipcRenderer.send("approval-response", approved); },
  onLog: function (cb) { ipcRenderer.on("agent-log", function (e, line) { cb(line); }); },
  onPLog: function (cb) { ipcRenderer.on("project-log", function (e, line) { cb(line); }); },
  onStepEvent: function (cb) { ipcRenderer.on("step-event", function (e, obj) { cb(obj); }); },
  
  getChats: (workspace) => ipcRenderer.invoke('get-chats', workspace),
  newChat: (workspace) => ipcRenderer.invoke('new-chat', workspace),
  switchChat: (workspace, url) => ipcRenderer.invoke('switch-chat', workspace, url),
  onApproval: function (cb) { ipcRenderer.on("approval-request", function (e, req) { cb(req); }); }
});
