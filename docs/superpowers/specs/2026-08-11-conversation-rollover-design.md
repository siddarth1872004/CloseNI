# Keeping a build inside its conversation

Design, 11 August 2026. Section 3 of `docs/NEXT.md`.

## What §3 actually turned out to be

Three items were listed. Two do not survive being looked at:

**"Only send a file the thread has not seen"** — already done. The delta ledger
skips files the conversation holds. The complaint that it "still re-sends the
tree on step 1 of every build" describes behaviour that is now *correct*:
`needsFullContext` sends the tree on step 1 or when the thread is cold, which is
exactly when the thread does not have it.

**"Summarise finished steps instead of carrying them forever"** — impossible as
written. It assumes the conversation can be edited. It cannot: it is the
provider's, and every step's prompt and every reply, complete file contents and
all, stays in it permanently. There is no lever that shortens a thread.

So §3 is one thing: **notice the conversation filling up, and continue in a new
one**. Item 2 exists only as part of that.

## Measuring

Characters sent and received, counted by us, against a per-provider budget.

Deliberately not read from the page. Every serious bug this project has had came
from guessing at someone else's DOM, and "is this conversation nearly full" is a
question we can answer from our own traffic: we wrote every prompt and we hold
every reply in full.

Characters rather than tokens. A tokeniser per provider, kept in step with
models we do not control, buys precision that the safety threshold makes
irrelevant.

The count lives in `sessions.json` beside the build ledger, keyed by workspace.
Both describe *the current thread*; both are meaningless the moment it changes,
and `resetBuildRun` clears them together. In-memory would not survive a resume,
which rejoins a conversation whose accumulated size would then count as zero.

Follow-ups count. A step that needed two repairs added three exchanges to the
thread, and counting only the first understates it badly.

## Deciding

`contextBudgetChars` per provider, defaulting to 150,000, rolling over at 80%.

The budget is a guess and is marked as one in each config, in the same spirit as
`streamUrlPattern`. Nothing can read a provider's real window. Being wrong in
the safe direction costs one seeded prompt; being wrong the other way loses a
step fifteen deep, an hour in.

80% rather than 100% because the step that tips the conversation over is also
the step whose reply has to fit in what is left. Arriving at the boundary
exactly means a truncated reply, which reads as a model that cannot follow the
format rather than a thread that ran out of room.

The decision includes the size of the prompt about to be sent. A thread at 70%
about to receive a 40,000-character prompt should move now, while moving is
free.

## Rolling over

Checked **before** a step sends anything. A step already waiting on a reply must
finish in the thread it started in — rolling over underneath it would abandon
the answer it is waiting for.

The new conversation is seeded by the cold-thread path built for resuming: the
plan, the file tree, the relevant files, the format rules. The ledger resets so
the delta describes the new thread rather than the abandoned one.

Nothing new was written for the hard part. A rolled-over thread *is* a thread
that has never seen this project, and that case already existed, was already
tested and was already in use.

Deliberately not: asking the old conversation to summarise itself first. That
requests more work from the one thing that has just run out of room, and a
summary that is wrong is worse than none because it reads as authoritative. The
workspace on disk is ground truth.

## Testing

- The budget arithmetic is fs-free and tested directly: accumulation, unreadable
  replies, the threshold from both sides, a large next prompt bringing the
  rollover forward, malformed stored values, and the rule that a fresh thread
  never rolls over however large the prompt — which would otherwise loop.
- Every provider config is asserted to declare a budget, so a new provider
  cannot silently inherit the default.
- `verify.mjs` pins the ordering that matters: the decision happens before the
  prompt is sent, a rolled-over thread is seeded as a cold one, repairs are
  counted, and the size resets with the ledger.

## Not in scope

- Reading the provider's real context limit. There is no way to.
- Carrying conversational nuance across a rollover. Files are what matter.
- Warning the user before a build that its plan looks too long for one thread.
