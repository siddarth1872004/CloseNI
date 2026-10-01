/*
 * GitHub: the token, git's environment, and the API calls the Ship panel makes.
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn } = require("child_process");
const { app, ipcMain, safeStorage } = require("electron");
const GH = require("../github-safe.js");
const GHAPI = require("../github-api.js");

/**
 * Registers the handlers. main.js hands in getWin, as the window does not
 * exist yet when this runs.
 */
module.exports = function github(main) {
  const { getWin } = main;

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
        getWin().webContents.send("project-log", "git> " + clean.replace(/\n$/, ""));
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

  return { currentToken, gitEnv, gh };
};
