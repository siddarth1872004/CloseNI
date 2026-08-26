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
  readBuildState: function (workspace) { return ipcRenderer.invoke("read-build-state", workspace); },
  writeBuildState: function (p) { return ipcRenderer.invoke("write-build-state", p); },
  clearBuildState: function (workspace) { return ipcRenderer.invoke("clear-build-state", workspace); },
  clearCheckpoints: function (workspace) { return ipcRenderer.invoke("clear-checkpoints", workspace); },
  workspaceProgress: function (paths) { return ipcRenderer.invoke("workspace-progress", paths); },
  listSkills: function () { return ipcRenderer.invoke("list-skills"); },
  readSkill: function (kind, name) { return ipcRenderer.invoke("read-skill", { kind: kind, name: name }); },
  writeSkill: function (kind, name, text) { return ipcRenderer.invoke("write-skill", { kind: kind, name: name, text: text }); },
  deleteSkill: function (kind, name) { return ipcRenderer.invoke("delete-skill", { kind: kind, name: name }); },
  importSkill: function (p) { return ipcRenderer.invoke("import-skill", p); },
  readMcpConfig: function () { return ipcRenderer.invoke("read-mcp-config"); },
  writeMcpConfig: function (text) { return ipcRenderer.invoke("write-mcp-config", text); },
  gatherMcpContext: function () { return ipcRenderer.invoke("gather-mcp-context"); },
  planRollback: function (workspace, toStep) { return ipcRenderer.invoke("plan-rollback", { workspace: workspace, toStep: toStep }); },
  applyRollback: function (workspace, plan) { return ipcRenderer.invoke("apply-rollback", { workspace: workspace, plan: plan }); },
  browserStatus: function () { return ipcRenderer.invoke("browser-status"); },
  installBrowser: function () { return ipcRenderer.invoke("install-browser"); },
  onBrowserProgress: function (cb) { ipcRenderer.on("browser-progress", function (e, line) { cb(line); }); },
  signIn: function (providerId) { return ipcRenderer.invoke("sign-in", providerId); },
  authStatus: function (providerId, workspace) {
    return ipcRenderer.invoke("auth-status", { provider: providerId, workspace: workspace });
  },
  providerHealth: function (providerId, workspace) {
    return ipcRenderer.invoke("provider-health", { provider: providerId, workspace: workspace });
  },
  signOutProvider: function (providerId) { return ipcRenderer.invoke("provider-sign-out", providerId); },
  openThread: function (url) { return ipcRenderer.invoke("open-thread", url); },
  startSession: function (workspace, provider, autonomy, headed, controls, concurrency, resuming, preamble) {
    return ipcRenderer.invoke("start-session", { workspace: workspace, provider: provider, autonomy: autonomy, headed: headed, controls: controls, concurrency: concurrency, resuming: resuming, preamble: preamble });
  },
  sendStep: function (index, detail, goal, testable) {
    return ipcRenderer.invoke("send-step", { index: index, detail: detail, goal: goal, testable: testable });
  },
  endSession: function () { return ipcRenderer.invoke("end-session"); },
  runCommand: function (p) { return ipcRenderer.invoke("run-command", p); },
  git: function (p) { return ipcRenderer.invoke("git", p); },
  exportBranch: function (p) { return ipcRenderer.invoke("export-branch", p); },
  // No token getter, deliberately. The renderer never holds the credential - it
  // asks the main process to make calls on its behalf.
  ghStatus: function () { return ipcRenderer.invoke("gh-status"); },
  ghSignIn: function (token) { return ipcRenderer.invoke("gh-sign-in", token); },
  ghSignOut: function () { return ipcRenderer.invoke("gh-sign-out"); },
  ghCall: function (method, args) { return ipcRenderer.invoke("gh-call", { method: method, args: args }); },
  ghClone: function (p) { return ipcRenderer.invoke("gh-clone", p); },
  readFile: function (p, opts) { return ipcRenderer.invoke("read-file", opts ? { path: p, full: !!opts.full } : p); },
  respondApproval: function (approved) { return ipcRenderer.send("approval-response", approved); },
  onPhase: function (cb) { ipcRenderer.on("agent-phase", function (e, p) { cb(p); }); },
  onLog: function (cb) { ipcRenderer.on("agent-log", function (e, line) { cb(line); }); },
  onPLog: function (cb) { ipcRenderer.on("project-log", function (e, line) { cb(line); }); },
  onStepEvent: function (cb) { ipcRenderer.on("step-event", function (e, obj) { cb(obj); }); },
  
  getChats: (workspace) => ipcRenderer.invoke('get-chats', workspace),
  newChat: (workspace) => ipcRenderer.invoke('new-chat', workspace),
  switchChat: (workspace, url) => ipcRenderer.invoke('switch-chat', workspace, url),
  onApproval: function (cb) { ipcRenderer.on("approval-request", function (e, req) { cb(req); }); }
});
