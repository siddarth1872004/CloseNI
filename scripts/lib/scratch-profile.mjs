/**
 * A throwaway copy of the signed-in DeepSeek profile, for live runs.
 *
 * Live harnesses must never touch the real storage directory: a run that
 * rolled a conversation over, signed out, or wrote sessions.json there would
 * change the user's own app state. So they work on a copy under a scratch
 * directory, point CLOSENI_STORAGE at it, and delete the copy when they end,
 * because it holds the login token.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Where the app keeps its storage on this machine (Electron's userData). */
export function realStorage() {
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "CloseNI");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "CloseNI");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "CloseNI");
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Copy the provider's profile into <scratch>/storage and return that storage
 * root. Refuses a scratch directory inside the real storage or the repo.
 * The copy is removed by the returned cleanup, which also runs on exit and on
 * SIGINT/SIGTERM.
 */
export function prepareProfile(scratch, provider = "deepseek") {
  if (!scratch || !path.isAbsolute(scratch)) throw new Error("--scratch must be an absolute directory outside the repo");
  const real = realStorage();
  const root = path.resolve(scratch);
  if (inside(root, real) || inside(real, root)) throw new Error("Refusing to run on " + real + ": use a scratch directory.");
  if (inside(root, REPO)) throw new Error("Refusing a scratch directory inside the repo: " + root);
  if (process.env.CLOSENI_STORAGE && inside(path.resolve(process.env.CLOSENI_STORAGE), real)) throw new Error("CLOSENI_STORAGE points at the real storage; unset it.");
  const src = path.join(real, "browser-profiles", provider);
  if (!fs.existsSync(src)) throw new Error("No signed-in profile at " + src + " - sign in from the app first.");
  const storage = path.join(root, "storage");
  const dest = path.join(storage, "browser-profiles", provider);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Singleton* are the running browser's locks; copied, they make Chromium
  // think the profile is already open.
  fs.cpSync(src, dest, { recursive: true, filter: (p) => !path.basename(p).startsWith("Singleton") });
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    fs.rmSync(dest, { recursive: true, force: true });
    console.error("[harness] deleted the profile copy at " + dest);
  };
  process.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });
  process.env.CLOSENI_STORAGE = storage;
  return { storage, profile: dest, cleanup };
}

export function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

export const repoRoot = REPO;
