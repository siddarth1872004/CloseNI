/**
 * Where sessions and browser profiles live.
 *
 * Packaged, the app cannot write next to its own executable - on Windows that
 * is Program Files, and saving a session would simply fail. So the desktop app
 * passes a writable root down as CLOSENI_STORAGE.
 *
 * Pure, and separated from the controller, because this is the one part of
 * packaging that cannot be exercised by running the app from source: the
 * packaged layout only happens in a packaged build.
 */
import * as path from "path";

export interface StoragePaths {
  /** Directory holding sessions.json and browser-profiles/. */
  root: string;
  sessionsFile: string;
  profileDir: string;
}

export function storagePaths(root: string | undefined, config: { id: string; profileDir: string }): StoragePaths {
  const trimmed = (root || "").trim();

  if (!trimmed) {
    // Today's behaviour, preserved exactly. This is the path the end-to-end
    // suite takes: it writes provider configs into a temp directory and expects
    // storage to follow profileDir there.
    const dir = path.join(config.profileDir, "..", "..");
    return {
      root: dir,
      sessionsFile: path.join(dir, "sessions.json"),
      profileDir: path.resolve(config.profileDir),
    };
  }

  return {
    root: trimmed,
    sessionsFile: path.join(trimmed, "sessions.json"),
    // Keyed by provider id, not by the configured path: two providers sharing a
    // profile directory would share a login.
    profileDir: path.join(trimmed, "browser-profiles", config.id),
  };
}

/**
 * Where the desktop app keeps its storage, worked out without Electron.
 *
 * The desktop app passes CLOSENI_STORAGE down to every agent it spawns, so an
 * agent started by the app finds the profile the user signed in to. A CLI entry
 * point sets nothing, and storagePaths then falls back to the shipped relative
 * profileDir - a different directory entirely.
 *
 * That is not theoretical. The first live smoke run reported "not signed in"
 * while the app, minutes earlier and on the same machine, reported "signed in":
 * two profiles, 9.9M and 28M, and only one of them logged in. Every CLI added
 * here - the smoke test, the selector check, the headless build - had the same
 * problem.
 *
 * This reproduces Electron's app.getPath("userData") convention: the platform's
 * per-user config directory plus the product name. It must agree with what
 * Electron actually creates, so APP_NAME is asserted against package.json's
 * productName in the tests rather than being a hopeful constant.
 *
 * Returns "" when there is no home directory to work from, so the caller can
 * leave CLOSENI_STORAGE unset and keep today's behaviour rather than being
 * handed a path built out of undefined.
 */
export const APP_NAME = "CloseNI";

export function defaultStorageRoot(
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
): string {
  if (platform === "win32") {
    const appData = (env.APPDATA || "").trim();
    return appData ? path.join(appData, APP_NAME) : "";
  }
  const home = (env.HOME || "").trim();
  if (platform === "darwin") {
    return home ? path.join(home, "Library", "Application Support", APP_NAME) : "";
  }
  const xdg = (env.XDG_CONFIG_HOME || "").trim();
  if (xdg) return path.join(xdg, APP_NAME);
  return home ? path.join(home, ".config", APP_NAME) : "";
}
