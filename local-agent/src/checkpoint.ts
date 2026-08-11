/**
 * Undoing a step.
 *
 * applyPatch has always taken a backup, into .agent-backups/<ms>/, and nothing
 * has ever been able to use one. Two things stopped it. A backup only holds
 * files that already existed, so it cannot say which files a step *created* -
 * and undoing a step means deleting those. And applyPatch runs inside the
 * repair loop, so a step that needed a follow-up produced two or three backup
 * directories while StepOutcome carried only the last: restoring from it would
 * return the workspace to the middle of that step's own repair.
 *
 * A checkpoint records the state before a step instead, captured before each
 * apply and merged first-write-wins, so a repaired step still describes the
 * moment before it began.
 *
 * Deliberately free of fs. The caller reads and writes; everything here is a
 * function of its arguments, which is what makes rollback planning - the part
 * that can destroy work - testable without a workspace.
 */

import * as crypto from "crypto";

export const CHECKPOINT_DIR = "checkpoints";
const CHECKPOINT_VERSION = 1;

/**
 * Above this, a file's previous contents are not stored and the step is marked
 * as unable to restore it. Silently truncating would be worse than admitting
 * the limit: a rollback that half-restores a file is harder to notice than one
 * that says it cannot.
 */
export const MAX_PRIOR_BYTES = 512 * 1024;

export interface CheckpointEntry {
  /** Contents before the step ran. null means the step created this file. */
  prior: string | null;
  /** Hash of what the step left, so an edit made since can be spotted. */
  after: string | null;
  /** The previous contents were too large to keep; this file cannot be restored. */
  tooLarge?: boolean;
}

export interface Checkpoint {
  version: number;
  step: number;
  title?: string;
  at: string;
  files: Record<string, CheckpointEntry>;
}

export interface RollbackPlan {
  toStep: number;
  /** Which steps are being undone, ascending. */
  steps: number[];
  /** Path to the contents it should be returned to. */
  restore: Record<string, string>;
  /** Files that did not exist before, so undoing means removing them. */
  remove: string[];
  /** Touched files whose contents no longer match what the build left. */
  drifted: string[];
  /** Files whose previous contents were never stored. */
  unrestorable: string[];
}

export function hash(text: string): string {
  return crypto.createHash("sha1").update(text, "utf-8").digest("hex").slice(0, 16);
}

export function checkpointName(step: number): string {
  return "step-" + String(step + 1).padStart(3, "0") + ".json";
}

/**
 * Fold one apply's before-state into the step's checkpoint.
 *
 * First write wins. The second apply in a repair loop sees a file the first
 * one already changed, and recording that would describe the middle of the
 * step rather than the moment before it.
 */
export function mergeCheckpoint(
  existing: Checkpoint | null,
  step: number,
  priors: Record<string, string | null>,
  meta?: { title?: string; at?: string },
): Checkpoint {
  const cp: Checkpoint = existing && existing.step === step
    ? { version: CHECKPOINT_VERSION, step: step, title: existing.title, at: existing.at, files: Object.assign({}, existing.files) }
    : { version: CHECKPOINT_VERSION, step: step, title: meta && meta.title, at: (meta && meta.at) || new Date().toISOString(), files: {} };
  if (meta && meta.title && !cp.title) cp.title = meta.title;

  for (const p of Object.keys(priors || {})) {
    if (Object.prototype.hasOwnProperty.call(cp.files, p)) continue;
    const prior = priors[p];
    if (typeof prior === "string" && prior.length > MAX_PRIOR_BYTES) {
      cp.files[p] = { prior: null, after: null, tooLarge: true };
    } else {
      cp.files[p] = { prior: prior === null || prior === undefined ? null : prior, after: null };
    }
  }
  return cp;
}

/** Record what the step left, so a later edit to the same file is detectable. */
export function sealCheckpoint(cp: Checkpoint, afters: Record<string, string | null>): Checkpoint {
  const files: Record<string, CheckpointEntry> = {};
  for (const p of Object.keys(cp.files)) {
    const left = afters ? afters[p] : undefined;
    files[p] = Object.assign({}, cp.files[p], {
      after: typeof left === "string" ? hash(left) : null,
    });
  }
  return { version: CHECKPOINT_VERSION, step: cp.step, title: cp.title, at: cp.at, files: files };
}

/** Absent, corrupt or wrong-version all read as "no checkpoint for this step". */
export function parseCheckpoint(raw: any): Checkpoint | null {
  let obj = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  if (obj.version !== CHECKPOINT_VERSION) return null;
  if (typeof obj.step !== "number" || !Number.isInteger(obj.step) || obj.step < 0) return null;
  if (!obj.files || typeof obj.files !== "object" || Array.isArray(obj.files)) return null;

  const files: Record<string, CheckpointEntry> = {};
  for (const p of Object.keys(obj.files)) {
    const e = obj.files[p];
    if (!e || typeof e !== "object") continue;
    // tooLarge is set only when true. Writing `false` onto every entry would
    // mean a checkpoint read back did not equal the one written, which is the
    // kind of difference that makes a round-trip test look like a bug.
    files[p] = {
      prior: typeof e.prior === "string" ? e.prior : null,
      after: typeof e.after === "string" ? e.after : null,
    };
    if (e.tooLarge) files[p].tooLarge = true;
  }
  return {
    version: CHECKPOINT_VERSION,
    step: obj.step,
    title: typeof obj.title === "string" ? obj.title : undefined,
    at: typeof obj.at === "string" ? obj.at : "",
    files: files,
  };
}

/**
 * What returning the workspace to just before `toStep` would take.
 *
 * Undoing a step means undoing everything after it too. Step 6 was written
 * against a step 4 that is about to stop existing, and leaving it in place
 * would produce a workspace that no plan describes and that the next step
 * would then be written against.
 *
 * Replaying the undos in reverse is the same as taking, for each path, the
 * record from the EARLIEST step that touched it - that step's `prior` is by
 * definition the state before `toStep`. Drift is judged against the LATEST
 * step to touch the file, which holds what the build actually left there.
 *
 * `current` maps a path to its contents now, or null if it is gone. A caller
 * that omits a path is treated as not knowing, and no drift is claimed:
 * inventing one would block a rollback over a file nobody looked at.
 */
export function planRollback(
  checkpoints: Checkpoint[],
  toStep: number,
  current: Record<string, string | null>,
): RollbackPlan {
  const relevant = (checkpoints || [])
    .filter((c) => c && typeof c.step === "number" && c.step >= toStep)
    .sort((a, b) => a.step - b.step);

  const earliest: Record<string, CheckpointEntry> = {};
  const latest: Record<string, CheckpointEntry> = {};
  for (const cp of relevant) {
    for (const p of Object.keys(cp.files)) {
      if (!Object.prototype.hasOwnProperty.call(earliest, p)) earliest[p] = cp.files[p];
      latest[p] = cp.files[p];
    }
  }

  const restore: Record<string, string> = {};
  const remove: string[] = [];
  const drifted: string[] = [];
  const unrestorable: string[] = [];

  for (const p of Object.keys(earliest).sort()) {
    const first = earliest[p];
    if (first.tooLarge) unrestorable.push(p);
    else if (first.prior === null) remove.push(p);
    else restore[p] = first.prior;

    const left = latest[p];
    const now = current ? current[p] : undefined;
    if (left && left.after !== null && now !== undefined) {
      // A file the build wrote and that no longer matches has been edited
      // since - or deleted. Either way the user should be told before it goes.
      if (now === null || hash(now) !== left.after) drifted.push(p);
    }
  }

  return {
    toStep: toStep,
    steps: relevant.map((c) => c.step),
    restore: restore,
    remove: remove,
    drifted: drifted.sort(),
    unrestorable: unrestorable,
  };
}
