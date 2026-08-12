/**
 * A build, replayed as one commit per step.
 *
 * The point is recovery that outlives this app. `git log`, `git diff` and
 * `git revert` are tools people already have and already trust, and a build that
 * lands as eighteen commits can be reviewed, bisected and partly undone with
 * them - none of which CloseNI's own rollback offers.
 *
 * The interesting problem is where the content comes from. A checkpoint records
 * the state BEFORE its step, plus only a HASH of what the step left - so the
 * obvious reconstruction, "commit each step's after-state", has no after-state
 * to commit.
 *
 * It is recoverable, and by the same observation that makes planRollback work,
 * run forwards: the content of a file after step N is the `prior` recorded by
 * the NEXT step that touched it. Nothing else can have changed it in between,
 * because a checkpoint is written for every step that writes anything. For a
 * file no later step touched, the answer is simply what is on disk now.
 *
 * Pure. The caller reads the workspace and runs git; this works out what each
 * commit should contain, which is the part worth testing without a repository.
 */

import { Checkpoint } from "./checkpoint.js";

export interface Commit {
  /** Zero-based step index, as the plan numbers them. */
  step: number;
  title: string;
  /** Path to the contents it should have at this commit. */
  writes: Record<string, string>;
  /** Files that do not exist yet at this point in the build. */
  deletes: string[];
}

export interface ExportPlan {
  commits: Commit[];
  /** Things the export cannot represent faithfully, named rather than hidden. */
  warnings: string[];
}

/** Branch names come from a plan summary, which is arbitrary human text. */
export function branchName(summary: string): string {
  const slug = String(summary || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return "closeni/" + (slug || "build");
}

/** A commit subject that reads usefully in `git log --oneline`. */
export function commitMessage(step: number, title: string): string {
  const clean = String(title || "").replace(/\s+/g, " ").trim().slice(0, 60);
  return "step " + (step + 1) + ": " + (clean || "changes");
}

/**
 * What each commit should contain.
 *
 * `current` is every touched path's contents on disk now, or null if it is gone.
 * A path the caller did not read is treated as unknown and left out of the final
 * step rather than guessed at.
 */
export function planCommits(
  checkpoints: Checkpoint[],
  current: Record<string, string | null>,
  titles?: Record<number, string>,
): ExportPlan {
  const steps = (checkpoints || [])
    .filter((c) => c && typeof c.step === "number")
    .slice()
    .sort((a, b) => a.step - b.step);

  const warnings: string[] = [];
  const commits: Commit[] = [];

  // For each path, the ordered list of steps that touched it. Built once: the
  // naive version rescans every later checkpoint per file per step, which is
  // quadratic in a way an eighteen-step build would notice.
  const touchedAt: Record<string, number[]> = {};
  for (const cp of steps) {
    for (const p of Object.keys(cp.files || {})) {
      (touchedAt[p] = touchedAt[p] || []).push(cp.step);
    }
  }

  const byStep: Record<number, Checkpoint> = {};
  for (const cp of steps) byStep[cp.step] = cp;

  // Every path the build touches anywhere, considered at every step.
  //
  // Not just the paths a step changed, and this is the difference between a
  // correct history and a plausible-looking wrong one. The export refuses to
  // run on a dirty tree, so the user commits the finished build first - which
  // means HEAD already contains every file. Staging only what a step touched
  // leaves the rest at HEAD's version, so step 1's commit would contain a
  // module step 5 created. Staging every path at its state AS OF that step
  // makes a file that does not exist yet a deletion, which is the truth.
  const allPaths = Object.keys(touchedAt).sort();

  for (const cp of steps) {
    const writes: Record<string, string> = {};
    const deletes: string[] = [];

    for (const p of allPaths) {
      if (cp.files && cp.files[p] && cp.files[p].tooLarge) {
        warnings.push(p + " was too large to record, so its history is approximate");
      }

      // The next step to touch this file holds, as its `prior`, exactly what
      // this step left behind.
      const later = (touchedAt[p] || []).filter((n) => n > cp.step).sort((a, b) => a - b);
      let after: string | null | undefined;
      if (later.length) {
        const nextCp = byStep[later[0]];
        after = nextCp && nextCp.files[p] ? nextCp.files[p].prior : undefined;
      } else {
        after = Object.prototype.hasOwnProperty.call(current || {}, p) ? current[p] : undefined;
      }

      if (after === undefined) {
        // Unknown rather than absent. Deleting a file because we failed to read
        // it would turn an export into data loss. Only worth reporting for a
        // path this step actually touched - the others are simply not its
        // business.
        if (cp.files && cp.files[p]) {
          warnings.push(p + " could not be read, so it is left as it is at step " + (cp.step + 1));
        }
        continue;
      }
      if (after === null) deletes.push(p);
      else writes[p] = after;
    }

    commits.push({
      step: cp.step,
      title: (titles && titles[cp.step]) || cp.title || "",
      writes: writes,
      deletes: deletes.sort(),
    });
  }

  return { commits: commits, warnings: Array.from(new Set(warnings)) };
}
