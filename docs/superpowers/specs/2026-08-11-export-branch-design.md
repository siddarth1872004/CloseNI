# A build, replayed as git history

Design, 11 August 2026. Section 7 of `docs/NEXT.md`.

## Why this one

`git log`, `git diff`, `git revert` and `git bisect` are tools people already
have and already trust. A build that lands as eighteen commits can be reviewed,
diffed step by step, and partly undone with them — none of which CloseNI's own
rollback offers, and all of which outlive this app.

§2's checkpoint work made it cheap: the record of which files each step touched
already exists, and git already runs with `shell: false` and argument
sanitising.

## Where the content comes from

A checkpoint records the state **before** its step, plus only a **hash** of what
the step left. So the obvious reconstruction — commit each step's after-state —
has no after-state to commit.

It is recoverable by the same observation that makes `planRollback` work, run
forwards: **the content of a file after step N is the `prior` recorded by the
next step that touched it.** Nothing else can have changed it in between,
because a checkpoint is written for every step that writes anything. For a file
no later step touched, the answer is what is on disk now.

So a build can be exported retrospectively, without git having been involved
while it ran.

## The bug that only running it found

The first version staged only the paths each step touched. Against a real
repository, step 1's commit contained `db.py` — which step 2 created.

The export refuses on a dirty tree, so the user commits the finished build
first, which means `HEAD` already holds every file. Staging only what a step
touched leaves everything else at `HEAD`'s version, so early commits contain
modules that did not exist yet. The history looks plausible and is wrong, in
exactly the case the feature is for.

**Every commit now stages every build-touched path at its state as of that
step**, so a file that does not exist yet is staged as a deletion. The
per-path logic did not change; what changed is which paths each commit
considers.

The unit tests passed the whole time. Only driving `git` against a temporary
repository showed it.

## Safety

- **Refuses a dirty tree.** The export rewrites files as it replays, so
  uncommitted work would be swept into a step's commit and attributed to the
  build. Refused rather than stashed.
- **Restores the working tree in a `finally`.** The final state is captured
  before anything is written. An export that failed halfway would otherwise
  leave the project holding a version of itself from the middle of its own
  history — worse than a failed export.
- **Paths are checked against the workspace root**, as rollback does.
- **`shell: false`** on every git call. A commit subject is arbitrary text taken
  from a plan.
- A folder with no repository gets `git init`, and the branch is its whole
  history.

## Testing

`planCommits` is pure and tested directly: the after-state recovery, a file
touched twice, a file deleted by hand, an unreadable file (neither written nor
deleted — treating it as absent would turn an export into data loss), oversized
priors, and the staging bug above.

Beyond that it was **driven against a real git repository** in the realistic
sequence — build, commit the result, export — and the commits inspected with
`git show`. That is what found the bug.

## Not verified

The IPC handler itself has not run inside Electron. The git sequence it performs
was executed by hand against a temporary repository and produced correct
history; the handler wrapping it has not been exercised.

## Not in scope

- Pushing the branch. It is created locally; `push origin` already exists.
- Committing during a build rather than replaying afterwards.
- Preserving authorship or timestamps from when each step actually ran.
