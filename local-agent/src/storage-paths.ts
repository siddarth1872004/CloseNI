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
