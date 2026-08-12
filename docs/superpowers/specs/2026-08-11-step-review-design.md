# Reviewing a step before the next one builds on it

Design, 11 August 2026. Section 4 of `docs/NEXT.md`, last of three items.

## Mostly wiring, because the parts existed

Four things this needed were already built:

- The step panel renders a per-file diff (`loadFileDiffs`, `CNDiff.diffLines`).
- The build loop already has a pause concept.
- Checkpoints make undoing one step exact — that was §2's rollback work.
- The scheduler runs one step at a time in a session, so "the step under review"
  is unambiguous.

What was missing is the gate itself, and the decision about what rejecting means.

## Rejecting means "do it differently"

Not "stop". A rejected step is rolled back through its checkpoint, the user is
asked what was wrong, and the step runs again with that reason appended to its
detail. The build then carries on.

Stopping the build was the alternative, and it is worse in the common case:
rejecting one step of eighteen would mean restarting the run by hand, and the
reason for rejecting it would be recorded nowhere.

The rollback happens **before** the retry, not after it. Otherwise the second
attempt edits files the first one wrote, and the diff stops describing one
step's work.

## Which steps pause

Only a step that **succeeded and changed files**, and only while review is on.

- A failed step already stops and shows its error; pausing to ask whether to
  accept a failure is a question with one answer.
- A step that changed nothing has nothing to review.
- A build that is stopping does not stop to ask a question.

Review is read at the moment a step finishes rather than captured when the build
started, so switching it on mid-build takes effect at the next step — which is
what someone reaching for it after a bad step wants.

**Off by default.** A build you can walk away from is much of the point of one,
so this is opted into.

## Two runtime bugs the design surfaced

**Electron does not implement `window.prompt`.** It throws. The obvious way to
ask for a rejection reason would have crashed the renderer the first time
anyone pressed Reject, and no test that does not run Electron would have caught
it. The reason is an inline field in the review bar instead — which is better
anyway, since it is visible next to the diff being judged.

**Stop must release a step waiting on a verdict.** Otherwise the build sits on
an unresolved promise forever and Stop becomes the one button that does not stop
anything. Stop resolves the review as *accept*: the work is already on disk, and
silently undoing a step the user never rejected would destroy work in response
to a button that does not claim to.

A reason is required to reject. A rejection with no reason gives the next
attempt nothing to go on, it produces much the same thing, and the user learns
that Reject does not work.

## Testing

The behaviour is renderer-only and has no DOM in the test harness, so it is
pinned in `verify.mjs`: review is opt-in, a rejection sends its reason into the
next attempt, the rollback precedes the retry, `window.prompt` is never called,
Stop releases a waiting review, and a step that changed nothing does not pause.

The `prompt` check greps with comments stripped, so documenting the Electron
limitation in a comment cannot satisfy the check that the limitation is
respected.

## Not verified

No live build has run this. The gate, the retry-with-reason path and the Stop
interaction have never executed in the app.

## Not in scope

- Editing files by hand during the review and continuing with those edits. The
  checkpoint would then describe a state that never existed.
- Reviewing a step's plan before it runs. That is the plan editor, §7.
- Rejecting a step more than a bounded number of times.
