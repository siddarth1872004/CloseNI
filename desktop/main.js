const os = require('os');
const fs = require("fs");
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const { hasChromium } = require("./browser-check.js");
const GH = require("./github-safe.js");
const GHAPI = require("./github-api.js");
const { safeStorage } = require("electron");
const https = require("https");

/**
 * The GitHub token lives here and nowhere else.
 *
 * Not in the renderer, and not in the agent process - the agent drives browsers
 * and has no reason to hold a GitHub credential. Not passing it is cheaper than
 * deciding later whether it leaked.
 */
let ghToken = null;
let ghLogin = null;

function tokenFile() { return path.join(app.getPath("userData"), "github.token"); }

function encryptionAvailable() {
  try { return safeStorage.isEncryptionAvailable(); } catch (e) { return false; }
}

function loadToken() {
  if (ghToken) return ghToken;
  try {
    ghToken = safeStorage.decryptString(fs.readFileSync(tokenFile()));
  } catch (e) {
    ghToken = null;   // absent, or written under a different OS key
  }
  return ghToken;
}

function saveToken(token) {
  ghToken = token;
  if (!GH.shouldPersistToken(encryptionAvailable())) return false;
  fs.writeFileSync(tokenFile(), safeStorage.encryptString(token), { mode: 0o600 });
  return true;
}

function clearToken() {
  ghToken = null;
  ghLogin = null;
  try { fs.unlinkSync(tokenFile()); } catch (e) { /* already gone */ }
}

let win = null;
let agentProc = null;

function createWindow() {
  // No File / Edit / View / Window / Help.
  //
  // Electron installs a default menu with reload, zoom and devtools on it. The
  // app has its own chrome and its own navigation, so that bar is a second,
  // conflicting one - and on Windows it sits inside the frame in a style
  // nothing else here uses. Removed before the first window is created so it
  // never flashes.
  Menu.setApplicationMenu(null);

  win = new BrowserWindow({
    width: 1400, height: 900,
    backgroundColor: "#0b0b0c",
    title: "CloseNI",
    // Belt and braces: setApplicationMenu(null) covers the menu itself, this
    // covers the bar the window would still reserve space for.
    autoHideMenuBar: true,
    // webviewTag is needed for the frontend preview. The <webview> itself
    // disables node integration and uses its own partition, so a generated page
    // cannot reach Electron APIs or the provider session cookies.
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, webviewTag: true }
  });
  win.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", function () { if (process.platform !== "darwin") app.quit(); });

/*
 * Paths that survive being packaged.
 *
 * Packaged, __dirname is inside the archive: .../resources/app.asar/desktop.
 * So path.join(__dirname, "..") is .../resources/app.asar - which is a FILE.
 * Handing that to spawn as a working directory fails with ENOENT, and Node
 * reports the error against the executable, so it reads as
 * "spawn C:\Program Files\CloseNI\CloseNI.exe ENOENT" - the one path that is
 * definitely fine. That is what an installed 1.0.1 hit on every agent run.
 *
 * resourcesPath is a real directory, and anything in asarUnpack has a real copy
 * beneath app.asar.unpacked with the same relative layout.
 */
function unpackedPath(rel) {
  if (!app.isPackaged) return path.join(__dirname, "..", rel);
  const unpacked = path.join(process.resourcesPath, "app.asar.unpacked", rel);
  if (fs.existsSync(unpacked)) return unpacked;
  return path.join(app.getAppPath(), rel);
}

/** A real directory to spawn children in. Never an archive. */
function spawnCwd() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, "..");
}

function agentPath() { return unpackedPath(path.join("local-agent", "dist", "index.js")); }

/**
 * Where the app may write. Packaged, it cannot write beside its own executable:
 * on Windows that is Program Files, and saving a session would simply fail. The
 * agent is a separate process with no Electron API, so the location is handed
 * to it in the environment.
 */
function storageRoot() { return app.getPath("userData"); }

function browsersDir() { return path.join(storageRoot(), "browsers"); }

/**
 * Spawn the agent.
 *
 * process.execPath with ELECTRON_RUN_AS_NODE rather than "node": a packaged app
 * cannot assume Node is installed on the user's machine. Note that this same
 * variable, set in a developer's shell, makes Electron itself refuse to open a
 * window - which is why scripts/wsl-env.sh unsets it. Setting it on a child
 * process is the opposite case and is what we want.
 *
 * One helper for all four call sites, so a fix cannot reach three of them and
 * miss the fourth.
 */
/*
 * One browser profile, one agent at a time.
 *
 * Every agent run calls launchPersistentContext on the same profile directory,
 * and Chromium locks that directory. Start a second run while the first is
 * still generating and it lands on a profile it cannot own: the page comes up
 * empty, the composer never appears, and the run dies with "Chat input not
 * found" - which reads like a broken selector rather than two processes
 * fighting. Observed exactly that way, with a plan launching while a chat was
 * still thinking at 97 seconds.
 *
 * So agent runs queue instead of overlapping. The wait is visible in the log
 * rather than silent, because a run that appears to do nothing for a minute
 * needs to say why.
 */
let agentQueue = Promise.resolve();
function queueAgentRun(label, task) {
  const run = agentQueue.then(function () { return task(); }, function () { return task(); });
  // The queue must survive a failed run, or one rejection stalls every run after it.
  agentQueue = run.then(function () {}, function () {});
  return run;
}

/*
 * A build session holds the profile for as long as the build runs, and it is
 * not in the queue above - it cannot be, because it stays open across many
 * steps. So anything that would open the profile independently is refused
 * while one is live, with a message that says what is happening.
 *
 * Refusing beats queueing here: a chat waiting silently behind a twenty-minute
 * build looks identical to a chat that is broken.
 */
function refuseWhileBuilding(what) {
  if (!profileBusy()) return null;
  return {
    success: false,
    error: what + " cannot run while a build is using the browser. Stop the build, or wait for it to finish.",
  };
}

function spawnAgent(args, extraEnv) {
  const env = Object.assign({}, process.env, {
    ELECTRON_RUN_AS_NODE: "1",
    CLOSENI_STORAGE: storageRoot(),
  }, extraEnv || {});
  // Packaged, Playwright must look inside userData. In development it must not,
  // or it stops seeing the browsers already in ~/.cache/ms-playwright and the
  // developer is told to download 389MB they already have.
  if (app.isPackaged) env.PLAYWRIGHT_BROWSERS_PATH = browsersDir();
  return spawn(process.execPath, [agentPath()].concat(args), {
    cwd: spawnCwd(),
    env: env,
  });
}

/*
 * A phase is only true while the process that reported it is alive. Without
 * this the rail keeps showing "writing" after a run has exited, which is the
 * one thing a live status must never do.
 */
function clearPhase() {
  try { win.webContents.send("agent-phase", { phase: "idle", detail: "" }); } catch (e) {}
}

/*
 * Mirror the agent's narration to this process's stdout as well as the window.
 *
 * It only ever went to the log pane, so the terminal held nothing but IPC
 * payloads. Every time a run misbehaved the only way to see why was to copy the
 * pane by hand, and a run that was still going could not be diagnosed at all.
 * PHASE lines are excluded because they arrive every two seconds and are a live
 * status, not a record.
 */
function routeLine(line) {
  if (!line.trim()) return;
  if (line.indexOf("PHASE:") !== 0) {
    try { process.stdout.write("[agent] " + line + "\n"); } catch (e) {}
  }
  if (line.indexOf("APPROVAL_REQUEST:") === 0) {
    try { win.webContents.send("approval-request", JSON.parse(line.substring(17))); } catch (e) {}
  } else if (line.indexOf("STEP_EVENT:") === 0) {
    try { win.webContents.send("step-event", JSON.parse(line.substring(11))); } catch (e) {}
  } else if (line.indexOf("PHASE:") === 0) {
    // Kept out of the log pane on purpose: this is a live status, and one line
    // every two seconds would drown the narration it sits next to.
    try { win.webContents.send("agent-phase", JSON.parse(line.substring(6))); } catch (e) {}
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

/**
 * Provider settings ride on the environment rather than the argument list.
 * Every mode opens a conversation and every mode would otherwise need a new
 * positional argument threaded through it; the controller reads this once.
 *
 * Returns only its own keys - spawnAgent does the merging with process.env.
 */
function agentEnv(headed, controls) {
  const env = { AGENT_HEADED: headed };
  if (controls && Object.keys(controls).length) env.AGENT_CONTROLS = JSON.stringify(controls);
  return env;
}

ipcMain.handle("run-agent", function (event, payload) {
  console.log("run-agent called with payload:", JSON.stringify(payload).substring(0, 200));
  const args = payload.args || payload;
  const headed = payload.headed ? "1" : "0";
  const label = Array.isArray(args) ? String(args[0]) : "agent";
  const busy = refuseWhileBuilding(label === "chat" ? "Chat" : label === "plan" ? "Planning" : "That");
  if (busy) return Promise.resolve(busy);
  if (agentProc) console.log("queued: " + label + " is waiting for the current run to finish");
  return queueAgentRun(label, function () { return new Promise(function (resolve) {
    // Write long prompts to temp files to avoid Windows ENAMETOOLONG
    const finalArgs = args.map(function (arg, idx) {
      if (idx >= 1 && arg.length > 8000) {
        const tmpFile = path.join(os.tmpdir(), "agent-prompt-" + Date.now() + "-" + idx + ".txt");
        fs.writeFileSync(tmpFile, arg, "utf-8");
        return tmpFile;
      }
      return arg;
    });
    const proc = spawnAgent(finalArgs, agentEnv(headed, payload.controls));
    agentProc = proc;
    let output = "";
    let lineBuf = "";
    let done = false;

    function finish(killIt) {
      if (done) return;
      done = true;
      agentProc = null;
      clearPhase();
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
  }); });
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
      proc = spawnAgent(["suggest", payload.workspace, payload.provider, String(payload.stepIndex), payload.text],
        agentEnv(payload.headed ? "1" : "0", payload.controls));
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

/**
 * Ask about a run. Same shape as "suggest" - the difference is entirely in what
 * the agent does with it, not in how the process is driven.
 */
ipcMain.handle("ask-run", function (event, payload) {
  return new Promise(function (resolve) {
    let proc;
    try {
      proc = spawnAgent(["ask", payload.workspace, payload.provider, payload.question,
        payload.command || "", payload.output || ""],
        agentEnv(payload.headed ? "1" : "0", payload.controls));
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
/*
 * Set while a previous session is shutting down.
 *
 * end-session used to null sessionProc and return immediately, so starting
 * another build a moment later spawned a second agent onto a Chromium profile
 * the first one still had open. Both then misbehaved: the dying session's
 * in-flight step failed with "Target page, context or browser has been closed",
 * and the new one reported "no session". Waiting for the old process to
 * actually exit is what makes back-to-back builds safe.
 */
let sessionClosing = null;
const pendingSteps = new Map();

/** True while the browser profile is held by a build session. */
function profileBusy() { return !!(sessionProc || sessionClosing); }

ipcMain.handle("start-session", async function (event, payload) {
  // Let the previous session release the profile before opening it again.
  if (sessionClosing) { try { await sessionClosing; } catch (e) {} }
  return new Promise(function (resolve) {
    if (sessionProc) { resolve({ ok: true }); return; }
    const headed = payload.headed ? "1" : "0";
    let proc;
    try {
      proc = spawnAgent(["build-session", payload.workspace, payload.provider, payload.autonomy || "ask"],
        Object.assign(agentEnv(headed, payload.controls),
          { AGENT_CONCURRENCY: String(payload.concurrency || 2) }));
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
    // Guarded on identity: an old session closing must never clear the handle
    // to the one that replaced it, or every step after it reports "no session".
    proc.on("close", function () {
      if (sessionProc === proc) sessionProc = null;
      clearPhase();
      for (const done of pendingSteps.values()) done({ success: false, error: "session ended" });
      pendingSteps.clear();
      if (!settled) { settled = true; resolve({ ok: false, error: "session exited before ready" }); }
    });
    proc.on("error", function (e) {
      if (sessionProc === proc) sessionProc = null;
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
  if (!sessionProc) return sessionClosing || Promise.resolve();
  const proc = sessionProc;
  sessionProc = null;
  // Resolves only once the process is really gone, so the Chromium profile is
  // free before anything else opens it.
  sessionClosing = new Promise(function (resolve) {
    let settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      sessionClosing = null;
      resolve();
    }
    proc.once("close", finish);
    proc.once("exit", finish);
    try { proc.stdin.write(JSON.stringify({ type: "close" }) + "\n"); } catch (e) {}
    // The session closes its browser before exiting; kill only if it hangs.
    setTimeout(function () { try { proc.kill(); } catch (e) {} }, 10000);
    // And never leave the interface waiting on a process that will not die.
    setTimeout(finish, 15000);
  });
  return sessionClosing;
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

function currentToken() { return ghToken; }

/**
 * A helper that echoes the token from its own environment.
 *
 * The script never contains the token - a credential written into a file on
 * disk is the same mistake in a different place.
 */
function askPassScript() {
  const isWin = process.platform === "win32";
  const file = path.join(app.getPath("userData"), isWin ? "askpass.bat" : "askpass.sh");
  const body = isWin
    ? "@echo off\r\necho %CLOSENI_GH_TOKEN%\r\n"
    : "#!/bin/sh\necho \"$CLOSENI_GH_TOKEN\"\n";
  try {
    fs.writeFileSync(file, body);
    if (!isWin) fs.chmodSync(file, 0o700);
  } catch (e) { /* a missing helper just means git asks and fails fast */ }
  return file;
}

/**
 * Git's environment.
 *
 * GIT_ASKPASS rather than a token in the remote URL - which lands in
 * .git/config and stays there - or in a push argument, which is visible in ps
 * to every process on the machine. Here it exists only in this child's env.
 */
function gitEnv() {
  const env = Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: "0" });
  const token = currentToken();
  if (token) {
    env.GIT_ASKPASS = askPassScript();
    env.CLOSENI_GH_TOKEN = token;
    env.GIT_USERNAME = "x-access-token";
  }
  return env;
}

function ghRequest(method, apiPath, body) {
  return new Promise(function (resolve, reject) {
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      "Accept": "application/vnd.github+json",
      "User-Agent": "CloseNI",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const token = currentToken();
    if (token) headers.Authorization = "Bearer " + token;
    if (data) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(data);
    }
    const req = https.request({ host: "api.github.com", path: apiPath, method: method, headers: headers }, function (res) {
      let raw = "";
      res.on("data", function (c) { raw += c; });
      res.on("end", function () {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = { message: raw.slice(0, 200) }; }
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const gh = GHAPI.createGitHubApi(ghRequest);

ipcMain.handle("gh-status", function () {
  loadToken();
  return {
    signedIn: !!ghToken,
    encryptionAvailable: encryptionAvailable(),
    persisted: !!ghToken && GH.shouldPersistToken(encryptionAvailable()),
    login: ghLogin,
  };
});

ipcMain.handle("gh-sign-in", async function (event, token) {
  const trimmed = String(token || "").trim();
  if (!trimmed) return { ok: false, error: "No token given." };
  const previous = ghToken;
  ghToken = trimmed;
  try {
    const me = await ghRequest("GET", "/user");
    if (me.status !== 200) {
      ghToken = previous;
      return { ok: false, error: "GitHub rejected that token (" + me.status + ")." };
    }
    ghLogin = me.body && me.body.login;
    return { ok: true, login: ghLogin, persisted: saveToken(trimmed) };
  } catch (e) {
    ghToken = previous;
    // Redacted even though the token rides in a header rather than the URL.
    // The habit is the point: the next error path may not be so careful.
    return { ok: false, error: GH.redactToken(String(e && e.message), trimmed) };
  }
});

ipcMain.handle("gh-sign-out", function () { clearToken(); return { ok: true }; });

/**
 * Clone a repository into the workspace.
 *
 * Into the workspace when it is empty, otherwise into a subdirectory named
 * after the repository - and the caller is told which. Scattering someone
 * else's files through a project already under way, without saying so, would be
 * its own kind of bug.
 */
ipcMain.handle("gh-clone", function (event, payload) {
  return new Promise(function (resolve) {
    const parsed = GH.parseRepoUrl(payload.url);
    if (!parsed) { resolve({ ok: false, error: "Not a GitHub repository URL." }); return; }
    let entries = [];
    try { entries = fs.readdirSync(payload.workspace); } catch (e) {}
    const visible = entries.filter(function (e) { return e.indexOf(".") !== 0; });
    const into = visible.length === 0 ? payload.workspace : path.join(payload.workspace, parsed.repo);
    const url = "https://github.com/" + parsed.owner + "/" + parsed.repo + ".git";

    const proc = spawn("git", GH.safeGitArgs(["clone", "--depth", "1", url, into]),
      { cwd: payload.workspace, shell: false, env: gitEnv() });
    let out = "";
    function log(d) {
      const clean = GH.redactToken(d.toString(), currentToken());
      out += clean;
      win.webContents.send("project-log", "git> " + clean.replace(/\n$/, ""));
    }
    proc.stdout.on("data", log);
    proc.stderr.on("data", log);
    proc.on("error", function (e) { resolve({ ok: false, error: String(e) }); });
    proc.on("close", function (code) {
      resolve(code === 0 ? { ok: true, into: into } : { ok: false, error: out.slice(-300) });
    });
  });
});

ipcMain.handle("gh-call", async function (event, payload) {
  try {
    const fn = gh[payload.method];
    if (typeof fn !== "function") return { ok: false, error: "Unknown call: " + payload.method };
    return { ok: true, result: await fn.apply(gh, payload.args || []) };
  } catch (e) {
    return { ok: false, error: GH.redactToken(String(e && e.message), currentToken()) };
  }
});

ipcMain.handle("git", function (event, payload) {
  return new Promise(function (resolve) {
    let args;
    try {
      args = GH.safeGitArgs(payload.args);
    } catch (e) {
      resolve({ success: false, output: String(e.message) });
      return;
    }
    // shell:false, because with shell:true Node concatenates the arguments into
    // a shell string rather than passing them separately - so a commit message
    // containing "; rm -rf ~" would run it. Git needs no shell.
    const proc = spawn("git", args, { cwd: payload.cwd, shell: false, env: gitEnv() });
    let out = "";
    function log(d) {
      const clean = GH.redactToken(d.toString(), currentToken());
      out += clean;
      win.webContents.send("project-log", "git> " + clean.replace(/\n$/, ""));
    }
    proc.stdout.on("data", log);
    proc.stderr.on("data", log);
    proc.on("error", function (e) { resolve({ success: false, output: String(e) }); });
    proc.on("close", function (code) { resolve({ success: code === 0, output: out }); });
  });
});

/*
 * Is the provider signed in, and which conversation is it on?
 *
 * Queued like every other agent run - it opens the same browser profile, so
 * probing while a build is mid-answer would be the profile-contention bug all
 * over again, this time triggered by a status light.
 */
ipcMain.handle("auth-status", function (event, payload) {
  const providerId = (payload && payload.provider) || "deepseek";
  const workspace = (payload && payload.workspace) || "";
  const busy = refuseWhileBuilding("The account check");
  if (busy) return Promise.resolve(busy);
  return queueAgentRun("authcheck", function () {
    return new Promise(function (resolve) {
      let proc;
      try { proc = spawnAgent(["authcheck", providerId, workspace], agentEnv("0", null)); }
      catch (e) { resolve({ success: false, error: String(e) }); return; }
      let out = "";
      proc.stdout.on("data", function (d) { out += d.toString(); });
      proc.on("close", function () {
        const start = out.indexOf("AGENT_OUTPUT_START");
        const end = out.indexOf("AGENT_OUTPUT_END");
        let result = null;
        if (start !== -1 && end !== -1) {
          const lines = out.substring(start + 18, end).split(/\r?\n/)
            .map(function (l) { return l.trim(); })
            .filter(function (l) { return l.indexOf("{") === 0; });
          if (lines.length) { try { result = JSON.parse(lines[lines.length - 1]); } catch (e) {} }
        }
        resolve(result || { success: false, signedIn: false, error: "no answer from the agent" });
      });
      proc.on("error", function (e) { resolve({ success: false, error: String(e) }); });
    });
  });
});

/*
 * Sign out by deleting the provider's browser profile.
 *
 * The session lives in that directory as cookies; there is nothing else to
 * revoke. Refused while an agent is running, because removing a profile
 * Chromium currently has open corrupts it.
 */
ipcMain.handle("provider-sign-out", function (event, providerId) {
  if (agentProc || sessionProc) {
    return { success: false, error: "Something is still running. Let it finish first." };
  }
  try {
    const dir = path.join(storageRoot(), "browser-profiles", String(providerId).replace(/[^a-z0-9-]/gi, ""));
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e && e.message ? e.message : e) };
  }
});

/*
 * Open the saved conversation in the user's own browser.
 *
 * Only http(s), and only after the URL parses - shell.openExternal will hand a
 * file:// or a custom scheme straight to the OS handler.
 */
ipcMain.handle("open-thread", function (event, url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      return { success: false, error: "Refusing to open a " + u.protocol + " link." };
    }
    shell.openExternal(u.toString());
    return { success: true };
  } catch (e) {
    return { success: false, error: "Not a URL." };
  }
});

ipcMain.handle("sign-in", function (event, providerId) {
  return new Promise(function (resolve) {
    let proc;
    try {
      proc = spawnAgent(["signin", providerId], { AGENT_HEADED: "1" });
    } catch (e) { resolve({ success: false, error: String(e) }); return; }
    agentProc = proc;
    let output = "";
    let lineBuf = "";
    proc.stdout.on("data", function (d) {
      const t = d.toString();
      output += t;
      lineBuf += t;
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
      resolve({ success: output.indexOf('"success":true') !== -1 });
    });
    proc.on("error", function (e) { agentProc = null; resolve({ success: false, error: String(e) }); });
  });
});

// The agent's compiled module, so the rules about which command wins and what
// an edited command means live in one place rather than two.
const RUN = require(unpackedPath(path.join("local-agent", "dist", "run-manifest.js")));

function manifestPath(workspace) { return path.join(workspace, RUN.MANIFEST_NAME); }

ipcMain.handle("read-manifest", function (event, workspace) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(workspace), "utf-8"));
  } catch (e) {
    // Absent and corrupt both mean "no manifest". A malformed file must not
    // stop the panel from loading.
    return null;
  }
});

/**
 * Write the manifest and the scripts beside it.
 *
 * The scripts are regenerated every time, so they cannot drift from the
 * manifest the app actually reads.
 */
ipcMain.handle("write-manifest", function (event, payload) {
  try {
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(manifestPath(payload.workspace), "utf-8")); } catch (e) {}
    const merged = RUN.mergeManifest(existing, payload.run, {
      userEdited: !!payload.userEdited,
      install: payload.install,
      language: payload.language,
    });
    fs.writeFileSync(manifestPath(payload.workspace), JSON.stringify(merged, null, 2) + "\n");

    const sh = path.join(payload.workspace, "run.sh");
    fs.writeFileSync(sh, RUN.renderRunScript(merged, "posix"));
    try { fs.chmodSync(sh, 0o755); } catch (e) { /* chmod is meaningless on Windows */ }
    fs.writeFileSync(path.join(payload.workspace, "run.bat"), RUN.renderRunScript(merged, "win32"));

    return { ok: true, manifest: merged };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle("browser-status", function () {
  // Development uses the developer's own ~/.cache/ms-playwright, which
  // PLAYWRIGHT_BROWSERS_PATH deliberately does not override there.
  if (!app.isPackaged) return { ready: true, path: "(development: system Playwright cache)" };
  let entries = [];
  try { entries = fs.readdirSync(browsersDir()); } catch (e) { /* not created yet */ }
  return { ready: hasChromium(entries), path: browsersDir() };
});

/**
 * Download Chromium through Playwright's own CLI.
 *
 * Reaching into playwright-core's internal registry would be shorter and would
 * break on the next Playwright upgrade. The CLI is the supported entry point,
 * and it already prints progress worth forwarding to the window.
 */
ipcMain.handle("install-browser", function () {
  return new Promise(function (resolve) {
    // Resolved through package.json rather than directly.
    //
    // require.resolve("playwright/cli.js") throws even though the file is right
    // there: Playwright declares an "exports" map that does not list ./cli.js,
    // and Node refuses deep imports outside it. The old code read that throw as
    // "Playwright is missing from this build", so the Download button reported
    // a broken build on an install that was completely intact.
    //
    // ./package.json is in the map, so its directory is reachable, and the CLI
    // sits beside it. Checked with existsSync so a genuinely missing file still
    // reports honestly.
    let cli;
    try {
      cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
    } catch (e) {
      cli = null;
    }
    if (!cli || !fs.existsSync(cli)) {
      resolve({ ok: false, error: "Playwright's installer was not found in this build." });
      return;
    }
    const proc = spawn(process.execPath, [cli, "install", "chromium"], {
      cwd: spawnCwd(),
      env: Object.assign({}, process.env, {
        ELECTRON_RUN_AS_NODE: "1",
        PLAYWRIGHT_BROWSERS_PATH: browsersDir(),
      }),
    });
    function forward(d) {
      const line = String(d).trim();
      if (line && win) win.webContents.send("browser-progress", line);
    }
    proc.stdout.on("data", forward);
    proc.stderr.on("data", forward);
    proc.on("error", function (e) { resolve({ ok: false, error: String(e) }); });
    proc.on("close", function (code) {
      resolve(code === 0 ? { ok: true } : { ok: false, error: "Download failed (exit " + code + ")." });
    });
  });
});

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
        if (cfg && cfg.enabled && cfg.id) out.push({ id: cfg.id, name: cfg.name || cfg.id, controls: cfg.controls || [] });
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
