/**
 * The build's own virtualenv, set up and reused across steps, and the
 * resolvers that make commands use it.
 *
 * Split out of index.ts, which keeps the dispatcher.
 */
import * as path from "path";
import * as fs from "fs";
import { runCommand } from "./verification/command-runner.js";
import { resolveTool } from "./verification/toolchain.js";
import { VENV_DIR, venvPython, findManifests, planEnvironmentSetup, describePythonUnavailable, mergeGitignore, summarizeInstallFailure } from "./verification/python-env.js";
import { CHECKPOINT_DIR } from "./checkpoint.js";
import { projLog } from "./cli-io.js";

/*
 * The build's own virtualenv.
 *
 * A run on a machine with no pip suggested `pip3 install -r
 * backend/requirements.txt` at every step, failed every time with "pip3: not
 * found", wrote each failure off as environment setup, and then failed nine
 * consecutive steps on "No module named pytest". One fact about the machine,
 * reported nine times as nine code bugs.
 *
 * Run once per step rather than once per build, because the agent is a fresh
 * process each step and because a requirements.txt often does not exist until
 * late - in one real build it arrived at step nine. The hash comparison is what
 * keeps that from reinstalling everything on the eight steps in between.
 */
export const ENV_STATE_FILE = "env.json";

export interface EnvState {
  installedHashes: Record<string, string>;
  installedNodeDirs: string[];
  /** This machine cannot create a virtualenv at all; say so once, not per step. */
  pythonUnavailable?: boolean;
  /**
   * Manifests whose install failed, by the content hash that failed. Retried
   * only once the file changes: a real build recompiled pygame from source,
   * and failed, on every one of nine steps.
   */
  failedInstalls?: Record<string, { hash: string; summary: string }>;
}

export function envStatePath(workspace: string): string {
  return path.join(workspace, CHECKPOINT_DIR, ENV_STATE_FILE);
}

export function readEnvState(workspace: string): EnvState {
  try {
    const raw = JSON.parse(fs.readFileSync(envStatePath(workspace), "utf-8"));
    return {
      installedHashes: raw.installedHashes || {},
      installedNodeDirs: Array.isArray(raw.installedNodeDirs) ? raw.installedNodeDirs : [],
      pythonUnavailable: !!raw.pythonUnavailable,
      failedInstalls: raw.failedInstalls && typeof raw.failedInstalls === "object" ? raw.failedInstalls : {},
    };
  } catch {
    return { installedHashes: {}, installedNodeDirs: [] };
  }
}

export function writeEnvState(workspace: string, state: EnvState): void {
  try {
    fs.mkdirSync(path.dirname(envStatePath(workspace)), { recursive: true });
    fs.writeFileSync(envStatePath(workspace), JSON.stringify(state, null, 2));
  } catch { /* a state file that cannot be written only costs a reinstall */ }
}

export function fileHash(file: string): string | null {
  try { return require("crypto").createHash("sha1").update(fs.readFileSync(file)).digest("hex"); }
  catch { return null; }
}

/**
 * Is this `pip install -r <file>` one the environment step already ran against
 * the file as it is now - successfully or not?
 */
export function alreadyInstalled(workspace: string, cmd: string): boolean {
  const m = cmd.match(/\bpip3?(?:\.exe)?["']?\s+install\s+(?:--?\S+\s+)*-r\s+["']?([^\s"']+)["']?\s*$/);
  if (!m) return false;
  const rel = m[1].replace(/\\/g, "/").replace(/^\.\//, "");
  const now = fileHash(path.join(workspace, rel));
  if (!now) return false;
  const state = readEnvState(workspace);
  return state.installedHashes[rel] === now || failedHashes(state)[rel] === now;
}

/** "Python 3.14.7", from the venv - the reason a pin with no wheel for it fails. */
export function pythonVersionIn(workspace: string): string {
  const vp = venvPython(workspace);
  if (!vp || !fs.existsSync(vp)) return "";
  try {
    return String(require("child_process").execFileSync(vp, ["--version"],
      { encoding: "utf-8", timeout: 5000 })).trim();
  } catch { return ""; }
}

export function failedHashes(state: EnvState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(state.failedInstalls || {})) out[k] = state.failedInstalls![k].hash;
  return out;
}

/**
 * What the next prompt should know about this machine.
 *
 * A failed install used to be logged and forgotten. The model went on writing
 * code against a package that was never installed, and the first it heard of
 * it was an ImportError steps later - or never, while tests did not import it.
 */
export function environmentNotes(workspace: string): string[] {
  const state = readEnvState(workspace);
  const notes: string[] = [];
  if (state.pythonUnavailable) notes.push("Python packages cannot be installed here (no working venv/pip).");
  for (const manifest of Object.keys(state.failedInstalls || {})) {
    const f = state.failedInstalls![manifest];
    let current: string | null = null;
    try { current = fileHash(path.join(workspace, manifest)); } catch { current = null; }
    if (current !== f.hash) continue;
    const version = pythonVersionIn(workspace);
    notes.push("Installing " + manifest + " FAILS on this machine" +
      (version ? " (" + version + ")" : "") + ": " + f.summary +
      " Fix " + manifest + " (a version that installs here, or a maintained alternative) " +
      "if this step needs those packages. Until then nothing that imports them can run.");
  }
  return notes;
}

/** Does this project want pytest, or is the standard library enough? */
export function wantsPytest(workspace: string): boolean {
  try {
    const names = fs.readdirSync(workspace);
    return ["pytest.ini", "pyproject.toml", "setup.cfg", "tests", "test"]
      .some((n) => names.indexOf(n) !== -1);
  } catch { return false; }
}

/**
 * Create the venv and install into it, before anything is checked.
 *
 * Never fails the step. A machine that cannot install packages is not a build
 * that wrote bad code - that call is the one isEnvironmentSetup already makes,
 * and getting it wrong is how a PEP 668 error once blocked fourteen good steps.
 */
export async function ensureEnvironment(workspace: string): Promise<void> {
  const state = readEnvState(workspace);
  const list = (dir: string): string[] | null => {
    try { return fs.readdirSync(path.join(workspace, dir)); } catch { return null; }
  };
  const manifests = findManifests(list);
  if (!manifests.length) return;

  const vp = venvPython(workspace);
  const hashes: Record<string, string> = {};
  for (const m of manifests) {
    const rel = m.dir ? m.dir + "/" + m.file : m.file;
    const h = fileHash(path.join(workspace, rel));
    if (h) hashes[rel] = h;
  }

  // Before the first install, not after: the export's dirty-tree message must
  // never be asking the user to commit node_modules.
  if (!fs.existsSync(vp) || !state.installedNodeDirs.length) {
    const ignoreFile = path.join(workspace, ".gitignore");
    let current: string | null = null;
    try { current = fs.readFileSync(ignoreFile, "utf-8"); } catch { current = null; }
    const merged = mergeGitignore(current);
    if (merged !== null) {
      try { fs.writeFileSync(ignoreFile, merged); } catch { /* not worth failing a build over */ }
    }
  }

  const commands = planEnvironmentSetup({
    basePython: resolveTool("python"),
    venvPython: vp,
    venvExists: fs.existsSync(vp),
    manifests: manifests,
    installedNodeDirs: state.installedNodeDirs,
    needsPytest: wantsPytest(workspace) && manifests.some((m) => m.file === "requirements.txt"),
    // A manifest that failed at this exact content counts as handled until it changes.
    installedHashes: Object.assign({}, state.installedHashes, failedHashes(state)),
    hashes: hashes,
  });

  for (const c of commands) {
    // Nothing Python can succeed on a machine whose venv module cannot
    // bootstrap pip. Node still can, so only the Python half is skipped.
    if (state.pythonUnavailable && c.kind !== "npm") continue;
    console.log("PHASE:" + JSON.stringify({ phase: "checking", detail: c.label }));
    console.log("RUNNING_CHECK: " + c.command);
    const r = await runCommand(c.command, path.join(workspace, c.cwd), 300000, { timeoutIsFailure: true });
    if (!r.success) {
      const why = describePythonUnavailable(r.output);
      if (why) {
        // Said once, in a sentence that names the command that fixes it. The
        // alternative - which is what happened - is nine steps each reporting
        // "No module named pytest" as though the code were at fault.
        console.log(why);
        projLog(why);
        state.pythonUnavailable = true;
      } else {
        console.log("ENVIRONMENT_COMMAND_SKIPPED: " + c.command);
        const summary = summarizeInstallFailure(r.output);
        projLog("Could not finish " + c.label + ", continuing: " + summary);
        if (c.manifest && c.kind === "pip" && hashes[c.manifest]) {
          state.failedInstalls = Object.assign({}, state.failedInstalls,
            { [c.manifest]: { hash: hashes[c.manifest], summary: summary } });
        }
      }
      continue;
    }
    if (c.kind === "npm") state.installedNodeDirs = state.installedNodeDirs.concat([c.cwd]);
    else if (c.manifest) {
      state.installedHashes[c.manifest] = hashes[c.manifest] || "";
      if (state.failedInstalls) delete state.failedInstalls[c.manifest];
    }
  }
  writeEnvState(workspace, state);
}

/**
 * Tool resolution that prefers the build's own virtualenv.
 *
 * Creating a venv and then checking the code with the system interpreter would
 * install flask somewhere nothing ever looks - the venv has to be what "python"
 * means for the rest of the step, or none of the above is worth doing.
 */
/** The venv interpreter, or null when there is not one to point at. */
export function venvForCommands(workspace: string): string | null {
  const vp = venvPython(workspace);
  return fs.existsSync(vp) ? vp : null;
}

/**
 * A console script the venv installed, by absolute path, or null.
 *
 * The venv is where flask, alembic and uvicorn end up, and nothing adds its bin
 * directory to PATH - so a model's `flask db init` ran against the system PATH
 * and failed with "command not found" while .venv/bin/flask existed. The path
 * rather than `python -m <name>`: not every console script is a runnable
 * module, and the file that is there is the one thing known to work.
 */
export function venvScriptResolver(workspace: string): (name: string) => string | null {
  const binDir = path.join(workspace, VENV_DIR, process.platform === "win32" ? "Scripts" : "bin");
  return (name: string) => {
    const exe = path.join(binDir, process.platform === "win32" ? name + ".exe" : name);
    return fs.existsSync(exe) ? exe : null;
  };
}

export function workspaceResolver(workspace: string): (name: string) => string | null {
  const vp = venvPython(workspace);
  const haveVenv = fs.existsSync(vp);
  const binDir = path.join(workspace, VENV_DIR, process.platform === "win32" ? "Scripts" : "bin");
  return (name: string) => {
    if (haveVenv) {
      if (name === "python") return vp;
      // Only when it is really in there: claiming pytest that is not installed
      // turns a missing runner into a failing suite.
      const exe = path.join(binDir, process.platform === "win32" ? name + ".exe" : name);
      if (fs.existsSync(exe)) return vp + " -m " + name;
    }
    return resolveTool(name);
  };
}
