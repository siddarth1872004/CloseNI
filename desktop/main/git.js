/*
 * Git: exporting a build as one commit per step, and the Ship panel's buttons.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { ipcMain } = require("electron");
const GH = require("../github-safe.js");

/**
 * Registers the handlers. main.js hands in unpackedPath, getWin, gitEnv,
 * currentToken and readCheckpoints.
 */
module.exports = function git(main) {
  const { unpackedPath, getWin, gitEnv, currentToken, readCheckpoints } = main;

  const EXPORT = require(unpackedPath(path.join("local-agent", "dist", "export-branch.js")));

  /** One git invocation, resolved rather than thrown, so a caller can branch on it. */
  function runGit(args, cwd) {
    return new Promise(function (resolve) {
      let safe;
      try { safe = GH.safeGitArgs(args); }
      catch (e) { resolve({ ok: false, output: String(e.message) }); return; }
      // shell:false for the same reason the "git" handler uses it: a commit
      // message is arbitrary text taken from a plan, and with a shell it would run.
      const proc = spawn("git", safe, { cwd: cwd, shell: false, env: gitEnv() });
      let out = "";
      proc.stdout.on("data", function (d) { out += d.toString(); });
      proc.stderr.on("data", function (d) { out += d.toString(); });
      proc.on("error", function (e) { resolve({ ok: false, output: String(e) }); });
      proc.on("close", function (code) { resolve({ ok: code === 0, output: out }); });
    });
  }

  /**
   * Replay a build onto a branch of its own, one commit per step.
   *
   * The working tree is rewritten as it goes - each step's files are put back to
   * what that step left - so the final state is captured first and restored in a
   * finally. Without that, an export that failed halfway would leave the project
   * holding a version of itself from the middle of its own history, which is a
   * far worse outcome than a failed export.
   *
   * Only the paths a step touched are staged. Staging everything would put the
   * final state of every file into the first commit, which is exactly the history
   * this exists to avoid producing.
   */
  ipcMain.handle("export-branch", async function (event, payload) {
    const ws = payload && payload.workspace;
    if (!ws) return { ok: false, error: "no workspace" };

    const checkpoints = readCheckpoints(ws);
    if (!checkpoints.length) return { ok: false, error: "nothing to export - no build has run in this workspace" };

    // Every path the build ever touched, as it is now.
    const current = {};
    for (const cp of checkpoints) {
      for (const rel of Object.keys(cp.files || {})) {
        if (rel in current) continue;
        try { current[rel] = fs.readFileSync(path.join(ws, rel), "utf-8"); }
        catch (e) { current[rel] = null; }
      }
    }

    const titles = {};
    ((payload.steps) || []).forEach(function (t, i) { if (t) titles[i] = String(t); });
    const plan = EXPORT.planCommits(checkpoints, current, titles);
    if (!plan.commits.length) return { ok: false, error: "nothing to export" };

    const branch = EXPORT.branchName(payload.summary || "");
    const root = path.resolve(ws);
    function inside(rel) {
      const abs = path.resolve(root, rel);
      const r = path.relative(root, abs);
      return abs !== root && r && !r.startsWith("..") && !path.isAbsolute(r) ? abs : null;
    }

    try {
      const isRepo = await runGit(["rev-parse", "--git-dir"], ws);
      if (!isRepo.ok) {
        const init = await runGit(["init"], ws);
        if (!init.ok) return { ok: false, error: "could not create a repository here: " + init.output };
      } else {
        // Refused rather than stashed. The export writes files as it goes, so
        // uncommitted work would be swept into a step's commit and attributed to
        // the build.
        const status = await runGit(["status", "--porcelain"], ws);
        if (status.ok && status.output.trim()) {
          return { ok: false, error: "You have uncommitted changes. Commit or stash them first - " +
            "the export rewrites files as it replays the build, and would otherwise mix your work into a step's commit." };
        }
      }

      const made = await runGit(["checkout", "-b", branch], ws);
      if (!made.ok) return { ok: false, error: "could not create " + branch + ": " + made.output };

      for (const c of plan.commits) {
        const staged = [];
        for (const rel of Object.keys(c.writes)) {
          const abs = inside(rel);
          if (!abs) continue;
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, c.writes[rel]);
          staged.push(rel);
        }
        for (const rel of c.deletes) {
          const abs = inside(rel);
          if (!abs) continue;
          try { fs.rmSync(abs, { force: true }); } catch (e) {}
          staged.push(rel);
        }
        if (!staged.length) continue;
        // "--" so a path that looks like a flag is still treated as a path.
        const add = await runGit(["add", "--"].concat(staged), ws);
        if (!add.ok) return { ok: false, error: "git add failed at step " + (c.step + 1) + ": " + add.output };
        const commit = await runGit(["commit", "-m", EXPORT.commitMessage(c.step, c.title), "--allow-empty"], ws);
        if (!commit.ok) return { ok: false, error: "git commit failed at step " + (c.step + 1) + ": " + commit.output };
      }

      return { ok: true, branch: branch, commits: plan.commits.length, warnings: plan.warnings };
    } catch (e) {
      return { ok: false, error: String(e) };
    } finally {
      // The project goes back to how it was found, whatever happened above.
      for (const rel of Object.keys(current)) {
        const abs = inside(rel);
        if (!abs) continue;
        try {
          if (current[rel] === null) fs.rmSync(abs, { force: true });
          else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, current[rel]); }
        } catch (e) { /* the caller's own status check reports the result */ }
      }
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
        getWin().webContents.send("project-log", "git> " + clean.replace(/\n$/, ""));
      }
      proc.stdout.on("data", log);
      proc.stderr.on("data", log);
      proc.on("error", function (e) { resolve({ success: false, output: String(e) }); });
      proc.on("close", function (code) { resolve({ success: code === 0, output: out }); });
    });
  });
};
