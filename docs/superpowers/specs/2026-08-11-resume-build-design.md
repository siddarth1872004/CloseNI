# Resuming a build across app restarts

Design, 11 August 2026. Item 2.3 of `docs/NEXT.md`.

## The problem, corrected

`docs/NEXT.md` records this as *"the ledger already survives; the builder does
not use it on startup."* That is wrong, and the correction is the design.

The build ledger records **which files the conversation has been shown**
(`session-store.ts`, `BuildLedger`). It says nothing about which steps ran. The
thing that would let a build resume is the plan and its per-step statuses, and
those live in `desktop/renderer.js` as `let currentPlan = null` — in memory,
nowhere else.

So closing the app does not lose progress *tracking*. It loses **the plan**.

The resume machinery itself already exists and works within a single session:
`CNSched.seedState` rebuilds scheduler state from step statuses, and `startBuild`
logs `resuming: N/M already done`. There is simply nothing on disk to seed it
from after a restart.

## What is being added

One file, one read, one write.

### Storage

`.closeni/build.json`, inside the workspace. This follows the precedent set by
`closeni.run.json`, which was put in the project for exactly this reason: the
answer survives closing the app, and the project is not dependent on this
install to be understood.

```json
{
  "version": 1,
  "summary": "Flask habit tracker",
  "runCommand": "python app.py",
  "provider": "deepseek",
  "startedAt": "2026-08-11T10:04:00.000Z",
  "updatedAt": "2026-08-11T10:31:12.000Z",
  "steps": [
    { "title": "…", "detail": "…", "files": ["app.py"], "dependsOn": [], "status": "done" },
    { "title": "…", "detail": "…", "files": ["streaks.py"], "dependsOn": [0], "status": "failed" }
  ]
}
```

Step **results** are deliberately not stored. File diffs can be large, they are
recoverable by reading the workspace, and writing them turns a 2 KB file written
once per step into something much larger written just as often.

A missing or corrupt file reads as "no build", following `readSessions`: losing
the ability to resume is recoverable, crashing the builder is not.

### Write path

`settle(i, ok)` in `desktop/builder.js` already runs on every step transition and
is the only place that knows the outcome. The write hangs off there, plus once
from `setPlan` so a plan that is generated and never built still survives.

Whole-file rewrite, no merge. Unlike the run manifest there is no user-edited
field to preserve, and merging would be a way to lose a status.

### Read path

On workspace selection, read the file. If it holds a build, restore the step
list with its statuses and log `resumed: N/M already done`. **Nothing runs.**
A restart is often a crash or a deliberate escape, and resuming into one
automatically would repeat whatever went wrong, unattended.

From there `seedState` and `CNSched.graphFor` work unchanged — that part is
already built and tested.

### The lost-thread case

Chat, plan and build share one conversation, and a resumed step's prompt is
short *because* it relies on that thread. `activeChat` survives in
`sessions.json`, so a resume usually lands back in the thread holding the plan.
Sometimes it will not: an expired session, a deleted chat, a different provider.

`startBuild` therefore learns whether it is resuming — any step already `done`
at start — and when `navigateToChat` reports the conversation did not resume, it
resets the ledger and re-sends the plan and file tree before the next step,
logging plainly that it happened. One long prompt; the build survives.

This also fixes a latent bug. `resetBuildRun` currently fires on "the first
step", which after a resume is step 8, not step 0 — it would wipe the ledger of a
thread that is alive and re-send every file the conversation already has. The
condition has to key off *resume* rather than *index*.

## Testing

- Serialise, parse, round-trip, and corruption in the unit suite, against a
  plain module the harness can `require` — the only reason the run-manifest work
  is testable today.
- The renderer's read and write calls pinned in `scripts/verify.mjs`. The last
  bug of this exact shape (`dependsOn` dropped in a `map`) was a single line of
  renderer code with correct modules on both sides of it, and only a structural
  check would have caught it.

## Not in scope

- Resuming *mid-step*. A step interrupted halfway is re-run from the start; its
  backup already exists under `.agent-backups`.
- Syncing build state between machines.
- A history of past builds. One current build per workspace.
