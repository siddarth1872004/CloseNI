const os = require('os');
const fs = require("fs");
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const GH = require("./github-safe.js");
const EXTRACT = require("./extraction-settings.js");

// Before ready, or Chromium has already chosen its key store.
const passwordStore = GH.linuxPasswordStore(process.platform, process.env.XDG_CURRENT_DESKTOP,
  app.commandLine.hasSwitch("password-store"));
if (passwordStore) app.commandLine.appendSwitch("password-store", passwordStore);

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
  // The Code panel's session holds the profile between messages. Anything else
  // that needs the browser gets it: the session yields, and the panel starts
  // a new one - rejoining the same conversation - on its next message.
  const go = function () { return releaseCode().then(task); };
  const run = agentQueue.then(go, go);
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
function agentEnv(headed, controls, preamble) {
  // Extraction settings go to every agent, read fresh each spawn so a change in
  // Settings applies to the next run without a restart.
  const env = Object.assign({ AGENT_HEADED: headed }, EXTRACT.toEnv(settings.readExtraction()));
  if (controls && Object.keys(controls).length) env.AGENT_CONTROLS = JSON.stringify(controls);
  // One environment variable, read once by the agent, exactly as controls
  // travel. A positional argument would have to be threaded through every mode.
  if (preamble && Object.keys(preamble).length) env.AGENT_PREAMBLE = JSON.stringify(preamble);
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
    const proc = spawnAgent(finalArgs, agentEnv(headed, payload.controls, payload.preamble));
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

ipcMain.handle("suggest", async function (event, payload) {
  await releaseCode();
  return new Promise(function (resolve) {
    let proc;
    try {
      proc = spawnAgent(["suggest", payload.workspace, payload.provider, String(payload.stepIndex), payload.text],
        agentEnv(payload.headed ? "1" : "0", payload.controls, payload.preamble));
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
ipcMain.handle("ask-run", async function (event, payload) {
  await releaseCode();
  return new Promise(function (resolve) {
    let proc;
    try {
      proc = spawnAgent(["ask", payload.workspace, payload.provider, payload.question,
        payload.command || "", payload.output || ""],
        agentEnv(payload.headed ? "1" : "0", payload.controls, payload.preamble));
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

/*
 * The coding agent's session: one long-lived process for the Code panel.
 *
 * It opens the same browser profile as everything else, so it never runs
 * beside a build or a one-off run. A build refuses to start it; anything
 * queued ends it first (see queueAgentRun), and the panel reopens it on its
 * next message.
 */
let codeProc = null;
let codeClosing = null;

function releaseCode() {
  if (!codeProc) return codeClosing || Promise.resolve();
  const proc = codeProc;
  codeProc = null;
  codeClosing = new Promise(function (resolve) {
    let settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      codeClosing = null;
      try { win.webContents.send("code-event", { type: "closed" }); } catch (e) {}
      resolve();
    }
    proc.once("close", finish);
    try { proc.stdin.write(JSON.stringify({ type: "close" }) + "\n"); } catch (e) {}
    // Closing waits for a reply in flight; a stuck page must not hold the app.
    setTimeout(function () { try { proc.kill(); } catch (e) {} }, 20000);
    setTimeout(finish, 25000);
  });
  return codeClosing;
}

ipcMain.handle("code-start", async function (event, payload) {
  if (codeClosing) { try { await codeClosing; } catch (e) {} }
  if (codeProc) return { ok: true };
  if (sessionProc || sessionClosing) return { ok: false, error: "A build is using the browser. Stop it, or wait for it to finish." };
  if (agentProc) return { ok: false, error: "Something else is using the browser. Try again in a moment." };
  return new Promise(function (resolve) {
    let proc;
    try {
      proc = spawnAgent(["agent-session", payload.workspace, payload.provider || "deepseek", payload.mode || "default"],
        agentEnv(payload.headed ? "1" : "0", payload.controls, payload.preamble));
    } catch (e) { resolve({ ok: false, error: String(e) }); return; }
    codeProc = proc;
    let lineBuf = "";
    let settled = false;
    proc.stdout.on("data", function (d) {
      lineBuf += d.toString();
      let idx;
      while ((idx = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.substring(0, idx).replace(/\r$/, "");
        lineBuf = lineBuf.substring(idx + 1);
        const m = line.match(/^AGENT_EVENT: (.*)$/);
        if (!m) {
          // A failure before the session is ready arrives as the usual output
          // block; it is the reason the panel needs to show.
          if (line.indexOf('{"success"') === 0 && !settled) {
            try { const r = JSON.parse(line); if (r && r.success === false) { settled = true; resolve({ ok: false, error: r.error || "the agent stopped" }); } } catch (e) {}
          }
          routeLine(line);
          continue;
        }
        let ev;
        try { ev = JSON.parse(m[1]); } catch (e) { continue; }
        if (ev.type === "ready" && !settled) { settled = true; resolve(Object.assign({ ok: true }, ev)); }
        // The chat controller's last phase is "reading - extracting the reply",
        // and nothing after it in the agent loop sets another. Any event past
        // "thinking" means the page has been read, so the bar would otherwise
        // say "extracting" while the agent waits on an approval, or is done.
        if (ev.type !== "thinking") clearPhase();
        // Mirrored like routeLine does the narration: these went only to the
        // window, so a run that stalled on a tool could not be diagnosed.
        if (ev.type === "tool" || ev.type === "done" || ev.type === "error") {
          const what = ev.type === "tool" ? ev.name + " " + (ev.title || "") + " -> " + ev.status + (ev.summary ? " (" + ev.summary + ")" : "")
            : ev.type === "done" ? "turn " + ev.reason + (ev.error ? ": " + ev.error : "") : ev.message;
          try { process.stdout.write("[agent] AGENT " + ev.type + ": " + String(what).slice(0, 300) + "\n"); } catch (e) {}
        }
        try { win.webContents.send("code-event", ev); } catch (e) {}
      }
    });
    proc.stderr.on("data", function (d) { routeLine(d.toString()); });
    proc.on("close", function () {
      if (codeProc === proc) { codeProc = null; try { win.webContents.send("code-event", { type: "closed" }); } catch (e) {} }
      clearPhase();
      if (!settled) { settled = true; resolve({ ok: false, error: "the agent exited before it was ready" }); }
    });
    proc.on("error", function (e) {
      if (codeProc === proc) codeProc = null;
      if (!settled) { settled = true; resolve({ ok: false, error: String(e) }); }
    });
  });
});

/* Everything the panel sends once the session is up is one JSON line. */
function codeSend(msg) {
  if (!codeProc || !codeProc.stdin.writable) return { ok: false, error: "no session" };
  codeProc.stdin.write(JSON.stringify(msg) + "\n");
  return { ok: true };
}
ipcMain.handle("code-send", function (event, text) { return codeSend({ type: "user", text: String(text || "") }); });
ipcMain.handle("code-permission", function (event, p) {
  return codeSend({ type: "permission", id: p && p.id, decision: p && p.decision, feedback: p && p.feedback });
});
ipcMain.handle("code-mode", function (event, mode) { return codeSend({ type: "mode", mode: mode }); });
ipcMain.handle("code-interrupt", function () { return codeSend({ type: "interrupt" }); });
ipcMain.handle("code-rewind", function () { return codeSend({ type: "rewind" }); });
ipcMain.handle("code-clear", function () { return codeSend({ type: "clear" }); });
ipcMain.handle("code-compact", function () { return codeSend({ type: "compact" }); });
ipcMain.handle("code-end", function () { return releaseCode(); });

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
  // Let the previous session release the profile before opening it again -
  // the Code panel's included.
  if (sessionClosing) { try { await sessionClosing; } catch (e) {} }
  await releaseCode();
  return new Promise(function (resolve) {
    if (sessionProc) { resolve({ ok: true }); return; }
    const headed = payload.headed ? "1" : "0";
    let proc;
    try {
      proc = spawnAgent(["build-session", payload.workspace, payload.provider, payload.autonomy || "ask"],
        Object.assign(agentEnv(headed, payload.controls, payload.preamble),
          { AGENT_CONCURRENCY: String(payload.concurrency || 2),
            // A resumed build keeps the ledger: the conversation it is
            // rejoining has already been shown these files, and wiping it would
            // re-send the whole project on the step it happens to stop at.
            AGENT_RESUMING: payload.resuming ? "1" : "0" }));
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
      type: "step", index: payload.index, detail: payload.detail, goal: payload.goal, prompt: payload.detail,
      // Whether the plan said this step has behaviour worth asserting. Dropped
      // here and the step is never asked for tests, silently - which is exactly
      // how dependsOn died between the plan and the scheduler.
      testable: !!payload.testable, title: payload.title || ""
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


/*
 * The IPC domains that need nothing of the agent and session processes above.
 * Each takes what it uses from here and returns what another needs.
 */
const github = require("./main/github.js")({ getWin: function () { return win; } });
const settings = require("./main/settings.js")({
  unpackedPath, storageRoot, spawnAgent, gh: github.gh, currentToken: github.currentToken,
});
const build = require("./main/build.js")({ unpackedPath });
require("./main/git.js")({
  unpackedPath, getWin: function () { return win; }, gitEnv: github.gitEnv,
  currentToken: github.currentToken, readCheckpoints: build.readCheckpoints,
});
require("./main/browser.js")({ browsersDir, spawnCwd, getWin: function () { return win; } });
require("./main/files.js")({ unpackedPath, storageRoot });

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

/**
 * Check a provider's selectors on demand.
 *
 * Same shape as auth-status, and queued for the same reason: it opens the
 * browser profile, and Chromium locks that directory - a second run landing on
 * a profile it cannot own comes up empty and reports "Chat input not found",
 * which reads like the very breakage this is meant to detect.
 */
ipcMain.handle("provider-health", function (event, payload) {
  const providerId = (payload && payload.provider) || "deepseek";
  const workspace = (payload && payload.workspace) || "";
  const busy = refuseWhileBuilding("The selector check");
  if (busy) return Promise.resolve(busy);
  return queueAgentRun("health", function () {
    return new Promise(function (resolve) {
      let proc;
      try { proc = spawnAgent(["health", providerId, workspace], agentEnv("0", null)); }
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
        resolve(result || { success: false, error: "no answer from the agent" });
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

ipcMain.handle("sign-in", async function (event, providerId) {
  await releaseCode();
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
