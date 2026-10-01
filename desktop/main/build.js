/*
 * A build's records in the workspace: the run manifest, the saved build state,
 * and the checkpoints that rollback restores.
 */
const fs = require("fs");
const path = require("path");
const { ipcMain } = require("electron");

/** Registers the handlers. main.js hands in unpackedPath. */
module.exports = function build(main) {
  const { unpackedPath } = main;

  // The agent's compiled module, so the rules about which command wins and what
  // an edited command means live in one place rather than two.
  const RUN = require(unpackedPath(path.join("local-agent", "dist", "run-manifest.js")));

  function manifestPath(workspace) { return path.join(workspace, RUN.MANIFEST_NAME); }

  const BUILDSTATE = require(unpackedPath(path.join("local-agent", "dist", "build-state.js")));

  function buildStatePath(workspace) {
    return path.join(workspace, BUILDSTATE.BUILD_STATE_DIR, BUILDSTATE.BUILD_STATE_NAME);
  }

  ipcMain.handle("read-build-state", function (event, workspace) {
    try {
      if (!workspace) return null;
      // parseBuildState treats absent, corrupt, wrong-version and empty alike:
      // there is no build here. A malformed file must not stop a workspace from
      // opening - that would make resuming worse than not having it.
      return BUILDSTATE.parseBuildState(fs.readFileSync(buildStatePath(workspace), "utf-8"));
    } catch (e) {
      return null;
    }
  });

  /**
   * Save the build so closing the app does not lose the plan.
   *
   * Written whole rather than merged. The run manifest merges because it has a
   * field the user edits; this file has none, and merging would be a way to keep
   * a status that is no longer true.
   */
  ipcMain.handle("write-build-state", function (event, payload) {
    try {
      if (!payload || !payload.workspace) return { ok: false, error: "no workspace" };
      const state = BUILDSTATE.serialiseBuildState(payload.plan || null, payload.steps || [], {
        provider: payload.provider,
        startedAt: payload.startedAt,
      });
      const file = buildStatePath(payload.workspace);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
      return { ok: true, startedAt: state.startedAt };
    } catch (e) {
      // A build must not fail because its bookkeeping could not be written -
      // a read-only workspace should cost the resume, not the run.
      return { ok: false, error: String(e) };
    }
  });

  const CHK = require(unpackedPath(path.join("local-agent", "dist", "checkpoint.js")));

  function checkpointDir(workspace) {
    return path.join(workspace, BUILDSTATE.BUILD_STATE_DIR, CHK.CHECKPOINT_DIR);
  }

  /** Every checkpoint in this workspace, oldest step first. */
  function readCheckpoints(workspace) {
    const dir = checkpointDir(workspace);
    let names = [];
    try { names = fs.readdirSync(dir).filter(function (n) { return n.endsWith(".json"); }); } catch (e) { return []; }
    const out = [];
    for (const n of names) {
      try {
        const cp = CHK.parseCheckpoint(fs.readFileSync(path.join(dir, n), "utf-8"));
        if (cp) out.push(cp);
      } catch (e) { /* a corrupt checkpoint is one step that cannot be undone */ }
    }
    return out.sort(function (a, b) { return a.step - b.step; });
  }

  /**
   * What rolling back to before `toStep` would do, without doing any of it.
   *
   * Split from the apply deliberately: the renderer shows the drifted files and
   * waits for an answer, and a plan computed twice could differ from the one the
   * user agreed to. The plan it confirms is the plan that runs.
   */
  ipcMain.handle("plan-rollback", function (event, payload) {
    try {
      if (!payload || !payload.workspace) return { ok: false, error: "no workspace" };
      const checkpoints = readCheckpoints(payload.workspace);
      if (!checkpoints.length) return { ok: false, error: "nothing recorded for this build yet" };

      // Only the files the plan would touch are read, so a large workspace costs
      // nothing here.
      const touched = {};
      for (const cp of checkpoints) {
        if (cp.step < payload.toStep) continue;
        for (const rel of Object.keys(cp.files)) touched[rel] = true;
      }
      const current = {};
      for (const rel of Object.keys(touched)) {
        try { current[rel] = fs.readFileSync(path.join(payload.workspace, rel), "utf-8"); }
        catch (e) { current[rel] = null; }
      }
      return { ok: true, plan: CHK.planRollback(checkpoints, payload.toStep, current) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  /**
   * Put the workspace back to just before a step.
   *
   * Restores before removing, so a failure part-way leaves files present rather
   * than a project with holes in it. Every path is resolved and checked against
   * the workspace root: a checkpoint is a file on disk, and one that had been
   * edited to say "../../.bashrc" must not be able to write there.
   */
  ipcMain.handle("apply-rollback", function (event, payload) {
    try {
      const ws = payload && payload.workspace;
      const plan = payload && payload.plan;
      if (!ws || !plan) return { ok: false, error: "no plan" };
      const root = path.resolve(ws);

      function inside(rel) {
        const abs = path.resolve(root, rel);
        const r = path.relative(root, abs);
        return abs !== root && r && !r.startsWith("..") && !path.isAbsolute(r) ? abs : null;
      }

      const restored = [];
      const removed = [];
      const refused = [];

      for (const rel of Object.keys(plan.restore || {})) {
        const abs = inside(rel);
        if (!abs) { refused.push(rel); continue; }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, plan.restore[rel]);
        restored.push(rel);
      }
      for (const rel of plan.remove || []) {
        const abs = inside(rel);
        if (!abs) { refused.push(rel); continue; }
        try { fs.rmSync(abs, { force: true }); removed.push(rel); } catch (e) {}
      }

      // The checkpoints for the undone steps go too: they describe a history that
      // no longer happened, and keeping them would let a second rollback restore
      // a state that was already rolled back.
      for (const cp of readCheckpoints(ws)) {
        if (cp.step < plan.toStep) continue;
        try { fs.rmSync(path.join(checkpointDir(ws), CHK.checkpointName(cp.step)), { force: true }); } catch (e) {}
      }

      return { ok: true, restored: restored, removed: removed, refused: refused };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  /**
   * Drop the checkpoints for a build that is being replaced.
   *
   * A checkpoint is addressed by step number. Keeping last week's alongside a new
   * plan means "roll back to step 4" could restore a file from a build that has
   * nothing to do with this one - and it would look like it worked.
   */
  /**
   * How far along each remembered workspace is.
   *
   * One call for the whole list rather than one per entry: the rail redraws on
   * every switch, and eight round-trips to render eight lines is waste.
   *
   * A path that is gone reports missing rather than absent. A deleted folder and
   * a folder never built in are different situations, and telling them apart is
   * the difference between "I moved that" and "the app lost my project".
   */
  ipcMain.handle("workspace-progress", function (event, paths) {
    const out = {};
    for (const ws of Array.isArray(paths) ? paths : []) {
      if (typeof ws !== "string" || !ws.trim()) continue;
      try {
        if (!fs.existsSync(ws)) { out[ws] = { missing: true }; continue; }
        const state = BUILDSTATE.parseBuildState(
          fs.readFileSync(path.join(ws, BUILDSTATE.BUILD_STATE_DIR, BUILDSTATE.BUILD_STATE_NAME), "utf-8"));
        out[ws] = state ? BUILDSTATE.describeProgress(state) : null;
      } catch (e) {
        // Present but with no readable build: a real workspace nobody has built
        // in yet, which is not an error.
        out[ws] = null;
      }
    }
    return { ok: true, progress: out };
  });

  ipcMain.handle("clear-checkpoints", function (event, workspace) {
    try {
      if (workspace) fs.rmSync(checkpointDir(workspace), { recursive: true, force: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle("clear-build-state", function (event, workspace) {
    try {
      if (workspace) fs.rmSync(buildStatePath(workspace), { force: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

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

  return { readCheckpoints };
};
