/**
 * The environment a build needs, made once and then actually used.
 *
 * Written after a real run on a machine with no pip. Every step suggested
 * `pip3 install -r backend/requirements.txt`, every one failed with
 * "pip3: not found", the failure was written off as environment setup, and then
 * nine consecutive steps failed on "No module named pytest" - the same single
 * fact about the machine, reported nine times as if it were nine code bugs.
 *
 * Three things were wrong and all three are fixed here:
 *
 *   1. Nothing ever created a virtualenv, so there was nowhere to install to.
 *   2. Installs were attempted with whatever `pip` name the model guessed.
 *      `<venv>/bin/python -m pip` is the only spelling that cannot be missing
 *      once the venv exists.
 *   3. Only the workspace root was looked at. The project was a monorepo -
 *      backend/requirements.txt and frontend/package.json - so nothing was
 *      found at all.
 *
 * Everything here is pure: it takes listings, hashes and a resolved interpreter
 * rather than touching the disk, so the decisions are testable without a
 * workspace, a network or a Python installation.
 */

/** Where a build keeps its virtualenv. Dot-prefixed, so `walk` already hides it. */
export const VENV_DIR = ".venv";

/**
 * The interpreter inside the workspace's venv.
 *
 * A path, not a probe: this is the one spelling of "python" that is correct by
 * construction once the venv exists, which is what stops `python: not found`
 * and `No module named pip` from coming back.
 */
export function venvPython(workspace: string, platform?: string): string {
  const plat = platform || process.platform;
  const sep = plat === "win32" ? "\\" : "/";
  const parts = plat === "win32" ? [VENV_DIR, "Scripts", "python.exe"] : [VENV_DIR, "bin", "python"];
  return String(workspace).replace(/[\\/]+$/, "") + sep + parts.join(sep);
}

export interface Manifest {
  /** Relative to the workspace root; "" for the root itself. */
  dir: string;
  file: "requirements.txt" | "package.json";
}

/** Manifests this cares about, in the order they should be installed. */
const MANIFEST_FILES = ["requirements.txt", "package.json"];

/**
 * Every dependency manifest in the workspace root or one level below it.
 *
 * One level, not arbitrary depth: `backend/` and `frontend/` is the layout that
 * broke, and recursing further would find the manifests inside node_modules and
 * try to install them.
 *
 * `list` returns a directory's entry names, or null when the path is not a
 * readable directory - which is also how a file is told from a directory here,
 * without a second callback.
 */
export function findManifests(list: (dir: string) => string[] | null): Manifest[] {
  const out: Manifest[] = [];
  const root = list("") || [];
  for (const file of MANIFEST_FILES) {
    if (root.indexOf(file) !== -1) out.push({ dir: "", file: file as any });
  }
  for (const name of root) {
    if (name.startsWith(".") || name === "node_modules" || name === VENV_DIR) continue;
    const inner = list(name);
    if (!inner) continue;
    for (const file of MANIFEST_FILES) {
      if (inner.indexOf(file) !== -1) out.push({ dir: name, file: file as any });
    }
  }
  return out;
}

export interface EnvCommand {
  command: string;
  /** Relative to the workspace; "" is the root. */
  cwd: string;
  kind: "venv" | "pip" | "npm";
  /** What to say while it runs. */
  label: string;
  /** The manifest this satisfies, so the caller can record it as installed. */
  manifest?: string;
}

export interface EnvSetupInput {
  /** The interpreter that creates the venv - the system one. */
  basePython: string | null;
  /** The interpreter inside the venv, from venvPython(). */
  venvPython: string | null;
  venvExists: boolean;
  manifests: Manifest[];
  /** Directories whose `npm install` has already run. */
  installedNodeDirs?: string[];
  /** Install pytest: the project is Python and a step wants tests run. */
  needsPytest?: boolean;
  /** Content hashes recorded when each manifest was last installed. */
  installedHashes?: Record<string, string>;
  /** Content hashes now. A manifest absent from either map is always installed. */
  hashes?: Record<string, string>;
}

function joinPath(dir: string, file: string): string {
  return dir ? dir + "/" + file : file;
}

/**
 * What to run before this step's checks.
 *
 * Ordered and idempotent: re-running it once per step is how a requirements.txt
 * that only appears at step nine still gets installed, and the hash comparison
 * is what stops that from reinstalling the world eight more times.
 */
export function planEnvironmentSetup(input: EnvSetupInput): EnvCommand[] {
  const out: EnvCommand[] = [];
  const vp = input.venvPython;
  const manifests = input.manifests || [];

  if (!input.venvExists && vp && input.basePython) {
    out.push({
      command: input.basePython + " -m venv " + VENV_DIR,
      cwd: "", kind: "venv", label: "creating a virtualenv",
    });
  }

  const changed = (rel: string): boolean => {
    if (!input.hashes || !input.installedHashes) return true;
    const now = input.hashes[rel];
    const then = input.installedHashes[rel];
    if (now === undefined || then === undefined) return true;
    return now !== then;
  };

  if (vp) {
    for (const m of manifests) {
      if (m.file !== "requirements.txt") continue;
      const rel = joinPath(m.dir, m.file);
      if (!changed(rel)) continue;
      out.push({
        command: vp + " -m pip install -r " + rel,
        cwd: "", kind: "pip", label: "installing " + rel, manifest: rel,
      });
    }
    // pytest by name, and it is the only package named here. It is the runner
    // this app wants to run, not a dependency parsed out of model output -
    // pip-installing a name a model produced is one typo away from installing
    // whatever squats it.
    if (input.needsPytest) {
      out.push({
        command: vp + " -m pip install pytest",
        cwd: "", kind: "pip", label: "installing pytest",
      });
    }
  }

  const done = new Set(input.installedNodeDirs || []);
  for (const m of manifests) {
    if (m.file !== "package.json") continue;
    if (done.has(m.dir)) continue;
    out.push({
      command: "npm install",
      // In the directory that owns the package.json. `npm install --prefix` was
      // the alternative and it resolves scripts against the wrong root.
      cwd: m.dir, kind: "npm", label: "installing " + joinPath(m.dir, "package.json"),
      manifest: joinPath(m.dir, "package.json"),
    });
  }

  return out;
}

/**
 * Why no venv could be made, in a sentence someone can act on.
 *
 * Debian and Ubuntu ship a python3 whose `venv` module cannot bootstrap pip
 * until a separate package is installed, and the machine that reported this had
 * exactly that: Python 3.14, no pip, no ensurepip. Guessing the package name
 * would be wrong across distributions, so the name python itself printed is
 * preferred and python3-venv is only the fallback.
 *
 * Returns null when nothing here is the problem - this must never turn an
 * ordinary install failure into "your Python is broken".
 */
export function describePythonUnavailable(output: string | null | undefined): string | null {
  const text = String(output || "");
  if (!text.trim()) return null;
  // \s+ rather than a space: python wraps this message, and the real output
  // puts a newline between "not" and "available".
  const broken = /ensurepip is not\s+available/i.test(text)
    || /No module named ['"]?(venv|ensurepip|pip)['"]?/i.test(text);
  if (!broken) return null;

  const named = text.match(/apt(?:-get)?\s+install\s+(\S+)/i);
  const pkg = named ? named[1] : "python3-venv";
  return "Python packages cannot be installed here: ensurepip is not available, so no " +
    "virtualenv can be created. Run \"sudo apt install " + pkg + "\" once (or the " +
    "equivalent for your distribution), then build again.";
}

/**
 * Point a command at the venv.
 *
 * The model writes `pip3 install ...` and `python3 -m pytest`, both of which are
 * wrong twice over: `pip3` did not exist on the machine that reported this, and
 * `python3` is the system interpreter that will never see what the venv holds.
 * Rewritten before the user approves the command, so what they are shown is what
 * actually runs - the same contract normalizeCommand already keeps.
 *
 * A single pass, deliberately: rewriting pip first and python second would find
 * the word "python" inside the venv path it had just written.
 */
export function rewriteForVenv(command: string, venvPythonPath: string | null): string {
  const c = String(command || "");
  if (!venvPythonPath || !c.trim()) return c;
  return c.replace(/(^|[\s;&|(])(pip3|pip|python3|python)(?=\s|$)/g, (_m, pre, name) =>
    pre + venvPythonPath + (name === "pip" || name === "pip3" ? " -m pip" : ""));
}

/**
 * What a workspace must ignore once a build installs into it.
 *
 * The git export refuses to run on a dirty tree, and tells the user to commit
 * what is there. Before this, creating a venv and running `npm install` in the
 * workspace meant that message was asking them to commit .venv and
 * node_modules - hundreds of megabytes of machine-specific binaries, in a
 * branch meant to be the project's history.
 */
export const BUILD_ARTEFACTS = [VENV_DIR + "/", "node_modules/", "__pycache__/", ".closeni/", ".agent-backups/"];

/**
 * Add the missing entries to a .gitignore, or null when it already covers them.
 *
 * Appends; never rewrites. The project's own ignore rules are its business, and
 * a build that reorders them would show up as a change the user did not make.
 */
export function mergeGitignore(existing: string | null | undefined, entries?: string[]): string | null {
  const want = entries || BUILD_ARTEFACTS;
  const text = String(existing || "");
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim().replace(/^\/+/, "")));
  const missing = want.filter((e) => !have.has(e) && !have.has(e.replace(/\/$/, "")));
  if (!missing.length) return null;
  const head = text && !text.endsWith("\n") ? text + "\n" : text;
  return head + (text ? "\n" : "") + "# Added by CloseNI: build artefacts, not project history\n" +
    missing.join("\n") + "\n";
}
