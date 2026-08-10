const os = require('os');
const fs = require("fs");
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const { spawn } = require("child_process");

let win = null;
let agentProc = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900,
    backgroundColor: "#0b0b0c",
    title: "CloseNI",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", function () { if (process.platform !== "darwin") app.quit(); });

function agentPath() { return path.join(__dirname, "..", "local-agent", "dist", "index.js"); }

function routeLine(line) {
  if (!line.trim()) return;
  if (line.indexOf("APPROVAL_REQUEST:") === 0) {
    try { win.webContents.send("approval-request", JSON.parse(line.substring(17))); } catch (e) {}
  } else if (line.indexOf("STEP_EVENT:") === 0) {
    try { win.webContents.send("step-event", JSON.parse(line.substring(11))); } catch (e) {}
  } else if (line.indexOf("AGENT_OUTPUT_START") === 0 || line.indexOf("AGENT_OUTPUT_END") === 0) {
    return;
  } else if (line.indexOf('{"success"') === 0) {
    return;
  } else if (line.indexOf("PROJ|") === 0) {
    win.webContents.send("project-log", line.substring(5));
  } else {
    win.webContents.send("agent-log", line);
  }
}

ipcMain.handle("select-folder", async function () {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle("run-agent", function (event, payload) {
  console.log("run-agent called with payload:", JSON.stringify(payload).substring(0, 200));
  const args = payload.args || payload;
  const headed = payload.headed ? "1" : "0";
  return new Promise(function (resolve) {
    // Write long prompts to temp files to avoid Windows ENAMETOOLONG
    const finalArgs = args.map(function (arg, idx) {
      if (idx >= 1 && arg.length > 8000) {
        const tmpFile = path.join(os.tmpdir(), "agent-prompt-" + Date.now() + "-" + idx + ".txt");
        fs.writeFileSync(tmpFile, arg, "utf-8");
        return tmpFile;
      }
      return arg;
    });
    const proc = spawn("node", [agentPath()].concat(finalArgs), { cwd: path.join(__dirname, ".."), env: Object.assign({}, process.env, { AGENT_HEADED: headed }) });
    agentProc = proc;
    let output = "";
    let lineBuf = "";
    let done = false;

    function finish(killIt) {
      if (done) return;
      done = true;
      agentProc = null;
      const start = output.indexOf("AGENT_OUTPUT_START");
      const end = output.indexOf("AGENT_OUTPUT_END");
      let result = null;
      if (start !== -1 && end !== -1) {
        const between = output.substring(start + 18, end);
        const jsonLines = between.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l.indexOf("{") === 0; });
        if (jsonLines.length) { try { result = JSON.parse(jsonLines[jsonLines.length - 1]); } catch (e) {} }
      }
      if (!result) result = { success: false, error: "No structured output from agent.", raw: output.substring(Math.max(0, output.length - 1500)) };
      resolve(result);
      if (killIt) { try { proc.kill(); } catch (e) {} }
    }

    proc.stdout.on("data", function (d) {
      const text = d.toString();
      output += text;
      lineBuf += text;
      let idx;
      while ((idx = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.substring(0, idx).replace(/\r$/, "");
        lineBuf = lineBuf.substring(idx + 1);
        routeLine(line);
        if (line === "AGENT_OUTPUT_END") setTimeout(function () { finish(true); }, 150);
      }
    });
    proc.stderr.on("data", function (d) { win.webContents.send("agent-log", "[err] " + d.toString()); });
    proc.on("close", function () { finish(false); });
    proc.on("error", function () { finish(true); });
  });
});

ipcMain.on("approval-response", function (event, approved) {
  // A build may be running as a long-lived session rather than a per-step
  // process; the reply has to reach whichever one asked.
  const proc = sessionProc || agentProc;
  if (proc && proc.stdin.writable) {
    proc.stdin.write(JSON.stringify({ approved: approved }) + "\n");
  }
});

ipcMain.handle("suggest", function (event, payload) {
  return new Promise(function (resolve) {
    let proc;
    try {
      proc = spawn("node", [agentPath(), "suggest", payload.workspace, payload.provider, String(payload.stepIndex), payload.text],
        { cwd: path.join(__dirname, ".."), env: Object.assign({}, process.env, { AGENT_HEADED: payload.headed ? "1" : "0" }) });
    } catch (e) { resolve({ success: false, error: String(e) }); return; }
    agentProc = proc;
    let output = "";
    let lineBuf = "";
    proc.stdout.on("data", function (d) {
      const text = d.toString();
      output += text;
      lineBuf += text;
      let idx;
      while ((idx = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.substring(0, idx).replace(/\r$/, "");
        lineBuf = lineBuf.substring(idx + 1);
        routeLine(line);
      }
    });
    proc.stderr.on("data", function (d) { routeLine(d.toString()); });
    proc.on("close", function () {
      agentProc = null;
      const start = output.indexOf("AGENT_OUTPUT_START");
      const end = output.indexOf("AGENT_OUTPUT_END");
      let result = null;
      if (start !== -1 && end !== -1) {
        const lines = output.substring(start + 18, end).split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l.indexOf("{") === 0; });
        if (lines.length) { try { result = JSON.parse(lines[lines.length - 1]); } catch (e) {} }
      }
      resolve(result || { success: false, error: "No structured output from agent." });
    });
    proc.on("error", function (e) { agentProc = null; resolve({ success: false, error: String(e) }); });
  });
});

let sessionProc = null;
const pendingSteps = new Map();

ipcMain.handle("start-session", function (event, payload) {
  return new Promise(function (resolve) {
    if (sessionProc) { resolve({ ok: true }); return; }
    const headed = payload.headed ? "1" : "0";
    let proc;
    try {
      proc = spawn("node", [agentPath(), "build-session", payload.workspace, payload.provider, payload.autonomy || "ask"],
        { cwd: path.join(__dirname, ".."), env: Object.assign({}, process.env, { AGENT_HEADED: headed }) });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
      return;
    }
    sessionProc = proc;
    let lineBuf = "";
    let settled = false;

    proc.stdout.on("data", function (d) {
      lineBuf += d.toString();
      let idx;
      while ((idx = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.substring(0, idx).replace(/\r$/, "");
        lineBuf = lineBuf.substring(idx + 1);
        const m = line.match(/^SESSION_EVENT: (.*)$/);
        if (!m) { routeLine(line); continue; }
        let ev;
        try { ev = JSON.parse(m[1]); } catch (e) { continue; }
        if (ev.type === "ready" && !settled) { settled = true; resolve({ ok: true }); }
        if (ev.type === "step-result") {
          const done = pendingSteps.get(ev.index);
          if (done) { pendingSteps.delete(ev.index); done(ev); }
        }
      }
    });
    proc.stderr.on("data", function (d) { routeLine(d.toString()); });
    proc.on("close", function () {
      sessionProc = null;
      for (const done of pendingSteps.values()) done({ success: false, error: "session ended" });
      pendingSteps.clear();
      if (!settled) { settled = true; resolve({ ok: false, error: "session exited before ready" }); }
    });
    proc.on("error", function (e) {
      sessionProc = null;
      if (!settled) { settled = true; resolve({ ok: false, error: String(e) }); }
    });
  });
});

ipcMain.handle("send-step", function (event, payload) {
  return new Promise(function (resolve) {
    if (!sessionProc || !sessionProc.stdin.writable) { resolve({ success: false, error: "no session" }); return; }
    pendingSteps.set(payload.index, resolve);
    sessionProc.stdin.write(JSON.stringify({
      type: "step", index: payload.index, detail: payload.detail, goal: payload.goal, prompt: payload.detail
    }) + "\n");
  });
});

ipcMain.handle("end-session", function () {
  if (!sessionProc) return Promise.resolve();
  const proc = sessionProc;
  sessionProc = null;
  try { proc.stdin.write(JSON.stringify({ type: "close" }) + "\n"); } catch (e) {}
  // The session closes its browser before exiting; kill only if it hangs.
  setTimeout(function () { try { proc.kill(); } catch (e) {} }, 10000);
  return Promise.resolve();
});

ipcMain.handle("run-command", function (event, payload) {
  return new Promise(function (resolve) {
    const proc = spawn(payload.command, { cwd: payload.cwd, shell: true });
    let out = "";
    proc.stdout.on("data", function (d) { out += d; win.webContents.send("project-log", d.toString().replace(/\n$/, "")); });
    proc.stderr.on("data", function (d) { out += d; win.webContents.send("project-log", d.toString().replace(/\n$/, "")); });
    proc.on("close", function (code) { resolve({ success: code === 0, output: out }); });
  });
});

ipcMain.handle("git", function (event, payload) {
  return new Promise(function (resolve) {
    const proc = spawn("git", payload.args, { cwd: payload.cwd, shell: true });
    let out = "";
    proc.stdout.on("data", function (d) { out += d; win.webContents.send("project-log", "git> " + d.toString().replace(/\n$/, "")); });
    proc.stderr.on("data", function (d) { out += d; win.webContents.send("project-log", "git> " + d.toString().replace(/\n$/, "")); });
    proc.on("close", function (code) { resolve({ success: code === 0, output: out }); });
  });
});

ipcMain.handle("list-providers", function () {
  // Four small JSON files; spawning the agent to read a directory would be absurd.
  const dir = path.join(__dirname, "..", "local-agent", "config", "providers");
  const out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
        if (cfg && cfg.enabled && cfg.id) out.push({ id: cfg.id, name: cfg.name || cfg.id });
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
  return path.join(__dirname, "..", "local-agent", "storage", "sessions.json");
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
