import * as fs from "fs";
import * as path from "path";

export interface ChatRef {
  url: string;
  title: string;
  createdAt: string;
}

export interface LedgerEntry {
  /** Content hash of what the thread was shown. null = listed in the tree only. */
  hash: string | null;
  step: number;
}

export type BuildLedger = Record<string, LedgerEntry>;

export interface WorkspaceSession {
  chats: ChatRef[];
  activeChat: string | null;
  /**
   * Legacy: the build used to run in a thread of its own. Chat, plan and build
   * now share activeChat. Kept in the type so an existing sessions.json still
   * parses, and still cleared by resetBuildRun so nothing stale lingers.
   */
  activeBuildThread?: string | null;
  /** What that thread has already been shown. Reset when a build starts. */
  buildLedger?: BuildLedger;
  /**
   * How much has been said in this thread, so a long build can start a new one
   * before it outgrows the window. Belongs with the ledger: both describe the
   * current conversation, and both are meaningless the moment it changes.
   */
  conversationSize?: { chars: number; turns: number };
}

export type Sessions = Record<string, WorkspaceSession>;

/**
 * A corrupt or missing file reads as empty rather than throwing: losing thread
 * history is recoverable, crashing a build is not.
 */
export function readSessions(file: string): Sessions {
  try {
    if (!file || !fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeSessions(file: string, sessions: Sessions): void {
  try {
    if (!file) return;
    const dir = path.dirname(file);
    // 0700 / 0600: this file holds live conversation URLs. Anyone who can read
    // one can open the conversation in a browser that carries the session
    // cookie, so it should not be world-readable the way a config file is.
    //
    // Not encrypted, deliberately. Electron's safeStorage lives in the main
    // process, and this file is written by the agent, which runs as plain Node.
    // Encrypting here would mean shipping a key next to the ciphertext, which
    // is worse than honest file permissions because it reads as protection
    // without being any.
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(sessions, null, 2), { encoding: "utf-8", mode: 0o600 });
    // writeFileSync only applies mode when creating, so an existing file keeps
    // whatever it had - including 0644 from before this change.
    try { fs.chmodSync(file, 0o600); } catch { /* not all filesystems support it */ }
  } catch {
    /* persistence is best-effort; a failed write must not fail a build */
  }
}

/**
 * A conversation URL reduced to something safe to print.
 *
 * The full URL used to go to the run log on every resume, and the log is what
 * people paste into issues and chats. The tail is enough to tell two threads
 * apart without handing over one that is still logged in.
 */
export function describeThread(url: string | null | undefined): string | null {
  const u = String(url || "").trim();
  if (!u) return null;
  const tail = u.split("/").filter(Boolean).pop() || "";
  return tail.length > 8 ? "…" + tail.slice(-8) : tail || "thread";
}

function ensureEntry(sessions: Sessions, workspace: string): WorkspaceSession {
  if (!sessions[workspace]) sessions[workspace] = { chats: [], activeChat: null };
  if (!Array.isArray(sessions[workspace].chats)) sessions[workspace].chats = [];
  return sessions[workspace];
}

export function getBuildLedger(file: string, workspace: string): BuildLedger {
  if (!workspace) return {};
  return readSessions(file)[workspace]?.buildLedger ?? {};
}

export function setBuildLedger(file: string, workspace: string, ledger: BuildLedger): void {
  if (!workspace) return;
  const sessions = readSessions(file);
  ensureEntry(sessions, workspace).buildLedger = ledger;
  writeSessions(file, sessions);
}

export function getConversationSize(file: string, workspace: string): { chars: number; turns: number } {
  if (!workspace) return { chars: 0, turns: 0 };
  return readSessions(file)[workspace]?.conversationSize ?? { chars: 0, turns: 0 };
}

export function setConversationSize(file: string, workspace: string, size: { chars: number; turns: number }): void {
  if (!workspace) return;
  const sessions = readSessions(file);
  ensureEntry(sessions, workspace).conversationSize = size;
  writeSessions(file, sessions);
}

/**
 * Start a fresh build run. Thread and ledger belong to the same run, so they are
 * cleared together — clearing one without the other would show a new thread a
 * delta computed against the old one's history.
 */
export function resetBuildRun(file: string, workspace: string): void {
  if (!workspace) return;
  const sessions = readSessions(file);
  const entry = ensureEntry(sessions, workspace);
  entry.activeBuildThread = null;
  entry.buildLedger = {};
  entry.conversationSize = { chars: 0, turns: 0 };
  writeSessions(file, sessions);
}
