# Rolling a step back

Design, 11 August 2026. Item 2.4 of `docs/NEXT.md`.

## Why the existing backups were not enough

`applyPatch` has always written a backup to `.agent-backups/<ms>/`, and nothing
has ever been able to use one. Two reasons, both found while designing this:

1. **A backup only holds files that already existed.** It cannot say which files
   a step *created* — and undoing a step means deleting exactly those.
2. **`applyPatch` runs inside the repair loop.** A step that needed a follow-up
   produced two or three backup directories, while `StepOutcome` carried only
   the last. Restoring from it would return the workspace to the middle of that
   step's own repair, which looks like a successful rollback and is not one.

So the raw material was real but insufficient. A checkpoint records the state
**before a step**, captured before each apply and merged first-write-wins.

## What a rollback means

**Roll back to before step N undoes N and everything after it.**

Step 6 was written against a step 4 that is about to stop existing. Leaving it
marked done would describe a workspace no plan matches, and the next step would
then be written against that. This also matches `retryFailed`, which already
resets a failed step and everything it blocked.

## Capture

One file per step, `.closeni/checkpoints/step-004.json`. For each path the step
touched:

- `prior` — the contents before the step. `null` means the step created it.
- `after` — a hash of what the step left, so an edit made since is detectable.
- `tooLarge` — set when `prior` exceeded 512 KB and was not stored.

Contents are read *before* each `applyPatch`, not recovered from its backup
directory. That handles created files naturally and needs no backup at all.

First write wins within a step: the second apply in a repair loop sees a file
the first one already changed, and recording that would describe the middle of
the step rather than the moment before it.

A checkpoint is written on success **and** on a step that exhausted its repair
attempts — a failed step still wrote files, and without this the one step most
worth undoing would be the only one that could not be.

## Planning

`planRollback(checkpoints, toStep, current)` is a pure function.

Replaying undos in reverse is equivalent to taking, for each path, the record
from the **earliest** step at or after `toStep` — that step's `prior` is by
definition the state before `toStep`. Paths whose earliest record is `null` are
removed; the rest are restored.

Drift is judged against the **latest** step to touch each file, which holds what
the build actually left there. A path the caller did not read is not called
drifted: inventing one would block a rollback over a file nobody looked at.

## Applying

Split into `plan-rollback` and `apply-rollback` deliberately. The renderer shows
the plan, names the drifted files and waits; the plan the user confirms is the
plan that runs, rather than one recomputed after they agreed to a different one.

Restores happen before removals, so a failure part-way leaves files present
rather than a project with holes in it. Every path is resolved and checked
against the workspace root — a checkpoint is a file on disk, and one edited to
say `../../.bashrc` must not be able to write there.

Checkpoints for the undone steps are then deleted: they describe a history that
no longer happened, and keeping them would let a second rollback restore a state
that had already been rolled back. Setting a new plan clears them all, since a
checkpoint is addressed by step number and last week's step 4 has nothing to do
with this build's.

## Testing

- The planning logic — the part that can destroy work — is fs-free and tested
  directly: repair-loop merging, a file touched by two steps, hand edits, a
  file deleted by hand, oversized priors, partial knowledge, and rolling back
  to a later step.
- One test drives `applyPatch` against a real temporary workspace across two
  steps and asserts the directory afterwards is byte-for-byte what it was.
- The renderer wiring is pinned in `verify.mjs`: nothing writes without a
  confirmed plan, and the workspace check is present.

## Not in scope

- Redo. Once rolled back, forward is rebuilding.
- Rolling back a step without rolling back the steps after it.
- Cleaning up `.agent-backups`, which is now redundant but harmless.
