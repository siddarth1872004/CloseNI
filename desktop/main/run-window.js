/*
 * "Run this project": the program in a CloseNI window of its own, full screen.
 *
 * One run window at a time. Asking to run again while it is open restarts the
 * program in it rather than stacking windows, each with its own process.
 */
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { app, BrowserWindow, ipcMain } = require("electron");
const { venvCommand, looksGraphical, fixPrompt, checkableHeadless, startedOk, HEADLESS } = require("../run-target.js");

const VENVS = [".venv", "venv", "env"];
const SOURCE = /\.(py|js|mjs|ts|rb|go|rs|c|cpp|java|lua)$/;
// Output kept for "Fix errors": the end is where the error is.
const KEEP = 20000;
// How long a start check lets the program run: past its imports and first frame.
const CHECK_MS = 5000;

/** The project's venv interpreter, or null. */
function venvPython(cwd) {
  for (const d of VENVS) {
    const p = path.join(cwd, d, process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** The project's top-level and src/ sources, enough to tell a game from a script. */
function sources(cwd) {
  const out = [];
  for (const dir of [cwd, path.join(cwd, "src")]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { continue; }
    for (const n of names) {
      if (!SOURCE.test(n) || out.length >= 40) continue;
      try { out.push(fs.readFileSync(path.join(dir, n), "utf-8").slice(0, 20000)); } catch (e) { /* unreadable: skip */ }
    }
  }
  return out;
}

/** Registers the handlers. Needs nothing from main.js. */
module.exports = function runWindow() {
  let win = null;
  let proc = null;
  let job = null;
  // The window that asked for the run: "Fix errors" goes back to its agent.
  let opener = null;
  // This run's command as started, the end of its output, and how it ended.
  let last = null;

  function send(channel, data) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  }

  // The whole process group: a shell running `python3 game.py` is two
  // processes, and killing only the shell leaves the game on screen.
  function stop() {
    const p = proc;
    if (!p) return;
    proc = null;
    killGroup(p);
  }

  function killGroup(p) {
    if (process.platform === "win32") { try { spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"]); } catch (e) {} return; }
    try { process.kill(-p.pid, "SIGTERM"); } catch (e) {}
    setTimeout(function () { try { process.kill(-p.pid, "SIGKILL"); } catch (e) {} }, 3000).unref();
  }

  function start() {
    stop();
    const command = venvCommand(job.command, venvPython(job.cwd));
    last = { command: command, output: "", code: null, signal: null };
    const run = last;
    send("run-started", { command: command, cwd: job.cwd, gui: job.gui });
    const p = spawn(command, {
      cwd: job.cwd, shell: true, detached: process.platform !== "win32",
      // Unbuffered, or a Python program's prints arrive only when it exits.
      env: Object.assign({}, process.env, { PYTHONUNBUFFERED: "1" }),
    });
    proc = p;
    function output(stream, text) {
      run.output = (run.output + text).slice(-KEEP);
      send("run-output", { stream: stream, text: text });
    }
    p.stdout.on("data", function (d) { output("out", d.toString()); });
    p.stderr.on("data", function (d) { output("err", d.toString()); });
    p.on("error", function (e) { output("err", String(e) + "\n"); });
    p.on("close", function (code, signal) {
      if (proc === p) proc = null;
      run.code = code; run.signal = signal;
      send("run-exit", { code: code, signal: signal });
    });
  }

  ipcMain.handle("open-run-window", function (event, payload) {
    const command = String((payload && payload.command) || "").trim();
    const cwd = payload && payload.cwd;
    if (!command || !cwd) return { ok: false, error: "nothing to run" };
    job = { command: command, cwd: cwd, gui: looksGraphical(sources(cwd)) };
    opener = event.sender;
    if (win && !win.isDestroyed()) { win.focus(); start(); return { ok: true }; }
    win = new BrowserWindow({
      fullscreen: true,
      backgroundColor: "#0b0b0c",
      title: "Run - " + path.basename(cwd),
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, "..", "run-preload.js"), contextIsolation: true, nodeIntegration: false, webviewTag: true },
    });
    win.loadFile(path.join(__dirname, "..", "run.html"));
    win.webContents.once("did-finish-load", start);
    win.on("closed", function () { stop(); win = null; });
    return { ok: true };
  });

  // Before "Run this project" is offered: start a program with a window
  // unseen for a few seconds. The Sigma game passed every unit test and died
  // on import; this catches that before the user is told it is ready.
  // stdin stays open and unwritten, so a prompt for input waits rather than
  // failing on end of file.
  ipcMain.handle("check-run", function (event, payload) {
    const cwd = payload && payload.cwd;
    const asked = String((payload && payload.command) || "").trim();
    if (!asked || !cwd || !checkableHeadless(sources(cwd))) return { checked: false };
    const command = venvCommand(asked, venvPython(cwd));
    return new Promise(function (resolve) {
      const run = { command: command, output: "", code: null, signal: null, timedOut: false };
      const p = spawn(command, {
        cwd: cwd, shell: true, detached: process.platform !== "win32",
        env: Object.assign({}, process.env, { PYTHONUNBUFFERED: "1" }, HEADLESS),
      });
      const timer = setTimeout(function () { run.timedOut = true; killGroup(p); }, CHECK_MS);
      function output(d) { run.output = (run.output + d.toString()).slice(-KEEP); }
      p.stdout.on("data", output);
      p.stderr.on("data", output);
      p.on("error", function (e) { output(String(e) + "\n"); });
      p.on("close", function (code, signal) {
        clearTimeout(timer);
        run.code = code;
        run.signal = run.timedOut ? null : signal;
        const ok = startedOk(run);
        resolve({ checked: true, ok: ok, command: command, prompt: ok ? "" : fixPrompt(Object.assign({ gui: true }, run)) });
      });
    });
  });

  ipcMain.handle("run-window-restart", function () { if (job) start(); });
  ipcMain.handle("run-window-stop", function () { stop(); });
  ipcMain.handle("run-window-input", function (event, text) {
    if (proc && proc.stdin.writable) proc.stdin.write(String(text));
  });
  ipcMain.handle("run-window-fullscreen", function (event, on) {
    if (win && !win.isDestroyed()) win.setFullScreen(!!on);
  });
  // The failed run, as a request to the agent in the window that started it.
  ipcMain.handle("run-window-fix", function () {
    if (!last || !job) return { ok: false, error: "nothing has run" };
    if (!opener || opener.isDestroyed()) return { ok: false, error: "the CloseNI window is closed" };
    opener.send("run-fix", {
      cwd: job.cwd, command: job.command,
      prompt: fixPrompt(Object.assign({ gui: job.gui }, last)),
    });
    const host = BrowserWindow.fromWebContents(opener);
    if (host) host.focus();
    return { ok: true };
  });
  ipcMain.handle("run-window-close", function () {
    if (win && !win.isDestroyed()) win.close();
  });

  app.on("before-quit", stop);
};
