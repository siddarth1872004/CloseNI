import * as fs from "fs";
import * as path from "path";

export interface ChatRef {
  url: string;
  title: string;
  createdAt: string;
}

export interface WorkspaceSession {
  chats: ChatRef[];
  activeChat: string | null;
  /** Thread shared by every step of the current build run. */
  activeBuildThread?: string | null;
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
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(sessions, null, 2), "utf-8");
  } catch {
    /* persistence is best-effort; a failed write must not fail a build */
  }
}

function ensureEntry(sessions: Sessions, workspace: string): WorkspaceSession {
  if (!sessions[workspace]) sessions[workspace] = { chats: [], activeChat: null };
  if (!Array.isArray(sessions[workspace].chats)) sessions[workspace].chats = [];
  return sessions[workspace];
}

export function getBuildThread(file: string, workspace: string): string | null {
  if (!workspace) return null;
  return readSessions(file)[workspace]?.activeBuildThread ?? null;
}

export function setBuildThread(file: string, workspace: string, url: string): void {
  if (!workspace || !url) return;
  const sessions = readSessions(file);
  ensureEntry(sessions, workspace).activeBuildThread = url;
  writeSessions(file, sessions);
}

export function clearBuildThread(file: string, workspace: string): void {
  if (!workspace) return;
  const sessions = readSessions(file);
  ensureEntry(sessions, workspace).activeBuildThread = null;
  writeSessions(file, sessions);
}
