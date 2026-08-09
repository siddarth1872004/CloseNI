import * as crypto from "crypto";
import { WorkspaceFile } from "./relevance.js";
import { BuildLedger } from "../session-store.js";

/**
 * Short sha1 — long enough to make a collision irrelevant, short enough to keep
 * sessions.json readable.
 */
export function hashContent(content: string): string {
  return crypto.createHash("sha1").update(content, "utf-8").digest("hex").slice(0, 16);
}

export interface DeltaResult {
  /** Files the thread still needs to be shown. */
  candidates: WorkspaceFile[];
  /** Paths that did not exist last step — the tree delta. */
  newPaths: string[];
  /** How many files were skipped because the thread already has them. */
  unchangedCount: number;
}

/**
 * A file needs sending when the thread has never been shown its contents, or
 * when what is on disk no longer matches what it was shown. The second case is
 * the drift correction: the thread remembers what it proposed, disk holds what
 * was applied, and a retry or a hand edit makes those differ.
 */
export function computeDelta(files: WorkspaceFile[], ledger: BuildLedger): DeltaResult {
  const candidates: WorkspaceFile[] = [];
  const newPaths: string[] = [];
  let unchangedCount = 0;

  for (const file of files) {
    const entry = ledger[file.path];
    if (!entry) {
      newPaths.push(file.path);
      candidates.push(file);
      continue;
    }
    if (entry.hash === null || entry.hash !== hashContent(file.content)) {
      candidates.push(file);
    } else {
      unchangedCount++;
    }
  }

  return { candidates: candidates, newPaths: newPaths, unchangedCount: unchangedCount };
}

/**
 * Record what the thread now knows. Files whose signatures were sent store their
 * hash; files that only appeared in the tree listing store null, so they are
 * still offered as candidates next step.
 */
export function nextLedger(
  previous: BuildLedger,
  allFiles: WorkspaceFile[],
  sentPaths: string[],
  step: number
): BuildLedger {
  const sent = new Set(sentPaths);
  const next: BuildLedger = Object.assign({}, previous);
  for (const file of allFiles) {
    if (sent.has(file.path)) {
      next[file.path] = { hash: hashContent(file.content), step: step };
    } else if (!next[file.path]) {
      next[file.path] = { hash: null, step: step };
    }
  }
  return next;
}
