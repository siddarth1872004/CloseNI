/*
 * Reads for the renderer, which has no file access: the provider list, the
 * workspace's files, and its saved chats.
 */
const fs = require("fs");
const path = require("path");
const { ipcMain } = require("electron");

/** Registers the handlers. main.js hands in unpackedPath, storageRoot. */
module.exports = function files(main) {
  const { unpackedPath, storageRoot } = main;

  ipcMain.handle("list-providers", function () {
    // Four small JSON files; spawning the agent to read a directory would be absurd.
    const dir = unpackedPath(path.join("local-agent", "config", "providers"));
    const out = [];
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
          // `controls` goes to the renderer so the sidebar can offer them. The
          // selectors stay here: the agent reads those, the UI never needs them.
          // `termsUrl` is linked from the sign-in step.
          if (cfg && cfg.enabled && cfg.id) out.push({ id: cfg.id, name: cfg.name || cfg.id, controls: cfg.controls || [], termsUrl: cfg.termsUrl || "" });
        } catch (e) { /* a malformed config is skipped, not fatal */ }
      }
    } catch (e) { /* no directory means no providers */ }
    return out;
  });

  ipcMain.handle("list-files", function (event, workspace) {
    // The renderer has no directory access; entry point detection needs a listing.
    const out = [];
    const skip = ["node_modules", ".git", ".agent-backups", "__pycache__", "dist", "build", "venv", ".venv", "target"];
    function walkDir(dir, prefix) {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of entries) {
        if (skip.indexOf(e.name) !== -1 || e.name.startsWith(".")) continue;
        const rel = prefix ? prefix + "/" + e.name : e.name;
        if (e.isDirectory()) { if (rel.split("/").length < 4) walkDir(path.join(dir, e.name), rel); }
        else out.push(rel);
      }
    }
    try { walkDir(workspace, ""); return { ok: true, files: out }; }
    catch (e) { return { ok: false, error: e.message, files: [] }; }
  });

  ipcMain.handle("read-file", function (event, arg) {
    // Accepts a bare path (existing callers, capped) or { path, full }. Diffing a
    // truncated file would read every line past the cap as a deletion.
    const absPath = typeof arg === "string" ? arg : arg && arg.path;
    const full = typeof arg === "object" && arg && arg.full;
    try {
      const s = fs.readFileSync(absPath, "utf-8");
      if (full) return { ok: true, text: s, truncated: false };
      return { ok: true, text: s.slice(0, 4000), truncated: s.length > 4000 };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // Chat sessions live in the same file the agent's PlaywrightController reads, so
  // the renderer and the agent stay in agreement about the active thread.
  function sessionsFile() {
    // Must agree with storagePaths() in the agent: both sides read the same file,
    // and the agent is told this location via CLOSENI_STORAGE.
    return path.join(storageRoot(), "sessions.json");
  }

  function loadSessions() {
    try {
      const f = sessionsFile();
      if (!fs.existsSync(f)) return {};
      return JSON.parse(fs.readFileSync(f, "utf-8")) || {};
    } catch (e) {
      return {};
    }
  }

  function saveSessions(sessions) {
    try {
      const f = sessionsFile();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(sessions, null, 2), "utf-8");
      return true;
    } catch (e) {
      return false;
    }
  }

  ipcMain.handle("get-chats", function (event, workspace) {
    if (!workspace) return { chats: [], activeChat: null };
    const entry = loadSessions()[workspace];
    if (!entry) return { chats: [], activeChat: null };
    return { chats: entry.chats || [], activeChat: entry.activeChat || null };
  });

  ipcMain.handle("new-chat", function (event, workspace) {
    if (!workspace) return { ok: false, error: "No workspace selected" };
    const sessions = loadSessions();
    if (!sessions[workspace]) sessions[workspace] = { chats: [], activeChat: null };
    sessions[workspace].activeChat = null;
    return { ok: saveSessions(sessions) };
  });

  ipcMain.handle("switch-chat", function (event, workspace, url) {
    if (!workspace || !url) return { ok: false, error: "Missing workspace or chat url" };
    const sessions = loadSessions();
    if (!sessions[workspace]) sessions[workspace] = { chats: [], activeChat: null };
    sessions[workspace].activeChat = url;
    return { ok: saveSessions(sessions) };
  });
};
