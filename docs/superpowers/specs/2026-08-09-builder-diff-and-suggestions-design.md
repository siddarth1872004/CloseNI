# Builder diff view and suggestion chat — design

Date: 2026-08-09
Roadmap items: 16 (IDE-like diff view), 17 (suggestion chat after generation and tests)
Sub-project: 6 · Builder IDE experience
Status: agreed in brainstorming. Layout and interaction model chosen by the
project owner; implementation decisions are the author's.

## Problem

When a build step finishes, the Builder tab shows a card per written file
containing the file's **entire** contents. For an overwrite that is close to
useless — the change might be three lines inside two hundred, and nothing marks
which three.

And having read it, there is nothing to do about it. If the model named a
function badly or picked the wrong structure, the only recourse is to edit by
hand outside the app, or re-run the whole build.

## Decisions

1. **Diffs replace full contents in the existing file cards.** The card layout
   stays; its body becomes a line-level diff.
2. **A suggestion box is pinned to the bottom of the step detail pane**, always
   visible for whichever step is selected.
3. **Any completed step can be revised at any time** — during a build or long
   after it finished. The build is never blocked waiting for input.
4. **Suggestions do not cascade.** Revising step 2 does not re-run steps 3-7.

## What already exists

Two pieces of this are further along than they look:

- `applyPatch` already writes the previous version of each overwritten file to
  `<workspace>/.agent-backups/<timestamp>/` and **already returns `backupDir`**
  in its result. It is simply not propagated past `runBuildStep`. The "before"
  side of every diff is on disk today.
- A build's chat thread is persisted in `sessions.json` as `activeBuildThread`
  and can be resumed by `navigateToBuildThread`. A suggestion can therefore be
  sent into the conversation that produced the code, with the model still
  holding the entire build in view.

Neither was true before sub-project 1. This design is cheap because of it.

## Design

### Diff data

`StepOutcome` gains `backupDir?: string`, propagated from `applyPatch` through
`runBuildStep`, the `step-result` session event, and the `run-agent` result.

The renderer reads the previous version from
`<backupDir>/<relative path>` and the current version from
`<workspace>/<relative path>`, and diffs them line by line. A file with no
backup entry was created rather than overwritten and renders as entirely added.

Diffing is a small line-level LCS in the renderer — roughly forty lines, no new
dependency. Output is a list of `{ type: "same" | "add" | "remove", text }`.
Runs of unchanged lines longer than six are collapsed to a context marker so a
three-line change in a large file is readable.

### Suggestion flow

A new one-shot agent mode:

```
node dist/index.js suggest <workspace> <provider> <stepIndex> <suggestion>
```

It resumes the workspace's build thread (`openProviderForBuild(..., false)`),
sends the suggestion scoped to the named step, then parses, applies and syntax
checks the reply exactly as a build step does — `runBuildStep`'s tail is reused
rather than reimplemented.

It emits the same `{ success, appliedFiles, backupDir }` shape a step does, so
the renderer refreshes the step's cards through the path it already has.

The desktop exposes `CN.suggest(stepIndex, text)`; the Builder's pinned input
calls it, disables itself while in flight, and re-renders the step on return.

### Error handling

- **No build thread** (never built, or a newer build cleared it): the suggestion
  is refused with a message saying so, rather than silently starting a fresh
  chat with no context — which would produce confident, uninformed edits.
- **Thread will not load**: `navigateToBuildThread` already falls back to a
  fresh chat. For suggestions that fallback is wrong, so `suggest` checks
  whether the resume succeeded and refuses if it did not.
- **Reply parses to no changes**: reported as "no changes suggested", the step
  is left untouched.
- **Syntax check fails after applying**: the same self-heal retry a build step
  uses, capped identically.

### Testing

- Unit: the diff function — additions, removals, unchanged runs, collapsing,
  empty-before (create), identical files.
- End-to-end: `suggest` against the mock provider — that it resumes the existing
  thread rather than opening a new one, applies the change, and refuses cleanly
  when no build thread exists.
- The renderer's rendering is not covered by the suite; it is checked by driving
  the app.

## Non-goals

- Re-running later steps after a revision. That needs dependency tracking
  between steps; guessing wrong would rewrite code the user was happy with.
- Editing files by hand in the app.
- Diffing anything other than what a step wrote — no arbitrary file browser.
- Preserving suggestion history across builds. A new build clears the thread,
  and with it the ability to revise the previous one.

## Consequences

- `.agent-backups/` becomes load-bearing rather than incidental. It is
  git-ignored and never cleaned up, so a long-lived workspace accumulates one
  directory per patch. Worth a retention policy eventually; not now.
- Suggestions extend the build thread, so a heavily revised build has a longer
  conversation and slower replies — the same ceiling any long thread has.
