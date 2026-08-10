/**
 * Is this tool installed here, and under what name?
 *
 * Generalises what resolvePythonCommand did for one interpreter. Guessing wrong
 * is not a harmless mistake: every check for that language fails with "not
 * found" and the model spends its self-heal retries on a machine problem it
 * cannot fix. That already cost one whole build, with `python` vs `python3`.
 */
import { spawnSync } from "child_process";

/**
 * Candidate names per tool, in the order to try.
 *
 * Plain names only. In WSL, `gcc.exe` resolves to a Windows binary that cannot
 * read a /tmp path, so probing .exe fallbacks would find a compiler that then
 * fails on every file. Windows resolves `gcc` to `gcc.exe` on its own.
 */
export const TOOL_CANDIDATES: Record<string, string[]> = {
  python: process.platform === "win32" ? ["python", "py -3", "python3"] : ["python3", "python"],
  node: ["node"],
  gcc: ["gcc", "cc"],
  // Keyed `gxx` rather than `g++`: the key names a candidate list, and a `+`
  // in it reads as part of a command. The resolved command is still `g++`.
  gxx: ["g++", "c++"],
  rustc: ["rustc"],
  cargo: ["cargo"],
  javac: ["javac"],
  make: ["make", "mingw32-make"],
  mvn: ["mvn"],
  gradle: ["gradle"],
};

const cache = new Map<string, string | null>();

/** Test seam: the cache is per-process and would otherwise outlive a test. */
export function resetToolCache(): void {
  cache.clear();
}

export function resolveTool(name: string): string | null {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;

  const candidates = TOOL_CANDIDATES[name] || [name];
  for (const candidate of candidates) {
    try {
      if (spawnSync(candidate + " --version", { shell: true, stdio: "ignore", timeout: 10000 }).status === 0) {
        cache.set(name, candidate);
        return candidate;
      }
    } catch {
      /* try the next candidate */
    }
  }
  console.log("No " + name + " found; checks needing it are skipped.");
  cache.set(name, null);
  return null;
}
