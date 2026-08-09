# Conversation & context core — design

Date: 2026-08-09
Roadmap items: 1 (performance & session handling), 2 (persistent conversations), 3 (better prompts)
Status: agreed in brainstorming. Decisions 1 and 2 were chosen by the project
owner; the three-phase ordering is the author's call, made after the owner
delegated the technical sequencing.

## Problem

Every agent invocation opens a brand-new chat. `openProvider` takes a `fresh`
flag, and all five call sites in `index.ts` pass `true`. Because each step starts
from nothing, the only way it can know what earlier steps produced is for the
agent to rebuild that knowledge from disk and re-send it in the prompt.

This costs correctness and speed at once:

- **Correctness.** A step is told about a handful of ranked files. In a real run
  the step writing `main.py` was given the models and storage modules but not
  `src/cli/handlers.py`, so it invented `handle_delete` when the function was
  called `handle_remove`, and the step failed after exhausting its retries.
- **Speed.** A 7-step build launched Chromium 7 times, loaded the provider
  registry 7 times, and ran the login check 7 times. Each step also re-sent the
  project tree and file signatures the model had itself produced minutes earlier.

The machinery to fix the first half already exists and is simply not connected:
`sendPrompt` calls `setChatUrlForWorkspace` after every prompt, so thread URLs
are already written to `sessions.json`. `getChatUrlForWorkspace` is read in
exactly one place — `navigateToChat` — which no call site can reach.

## Decisions

1. **A conversation is scoped to one build run.** The plan and all of its steps
   share a thread; a new build starts a new thread. Bounded by plan size (3-8
   steps) rather than growing without limit across weeks.
2. **Per-step prompts carry a delta.** A file's signatures are sent only if the
   thread has never seen it, or if its content changed since the thread last saw
   it. Unchanged files are not re-sent.
3. **A build run is eventually owned by one long-lived process**, so the browser
   and thread stay open for the whole build instead of being rebuilt per step.

Decision 3 is the largest change and lands last. See Delivery.

## Non-goals

- Threads that persist across separate build runs or across days.
- Persisting the context ledger to disk.
- Changing the one-shot modes (`chat`, `plan`, `revise`, `research`, `testall`).
- Multi-agent concurrency — that is a separate sub-project which depends on this
  one.

## Delivery

Three phases. Each ends with a working application and a green test suite. The
phases are ordered so that the riskiest work happens last, against a system whose
correct behaviour has already been established.

### Phase 1 — connect the existing resume path

Give `buildMode` a thread that survives across the steps of one build.

- Introduce an explicit build-run identity so a thread belongs to a run rather
  than to a workspace forever. `sessions.json` gains a per-workspace
  `activeBuildThread` alongside the existing `activeChat`.
- Step 0 of a build starts a fresh thread and records it. Steps 1..n resume it
  via the existing `navigateToChat`.
- Follow-ups and re-asks already reuse the live page, so they are unaffected.
- `fresh: true` remains for the one-shot modes.

Prompts do not change in this phase. The model simply stops losing the thread,
and the goal and prior discussion stay in view.

**Verifiable by:** an end-to-end test that runs three steps in one build and
asserts every step landed in the same thread, and that step 3 can name a symbol
that only appeared in step 1's reply.

**Risk:** low. One flag, one new stored field, existing fallback when a saved URL
no longer loads.

### Phase 2 — delta context

Stop re-sending what the thread already holds.

- The session keeps a ledger: `Map<relativePath, { contentHash, sentAtStep }>`.
- Before each step, hash every source file. A file is *new* if absent from the
  ledger and *changed* if its hash differs from what was sent.
- Rank only new and changed files through the existing `selectRelevantFiles`;
  the character budget still decides between them when several change at once.
- Send those signatures, then update the ledger.
- The project tree is also sent as a delta: only paths that appeared since the
  previous step.

Content hashing rather than mtime: mtime already drives recency ranking, and a
retry that rewrites a file byte-identically should not trigger a resend.

This is also the drift correction. The thread remembers what it *proposed*; disk
holds what was *applied*. A retry that overwrote a file changes its hash, so the
file is re-sent and the model is reconciled against reality. That divergence is
the mechanism behind the `handle_delete` failure.

Step 1 is unchanged — an empty ledger makes everything new. Savings compound from
step 2 onward.

**Verifiable by:** a test asserting step 2's prompt omits a file step 1 already
saw and unchanged; and that a file overwritten between steps *is* re-sent.

**Risk:** medium. A wrong ledger silently starves a step of context. Mitigated by
tests asserting on actual prompt contents, which the mock provider already
captures.

### Phase 3 — long-lived build session

Remove the per-step process and browser cost.

- New mode: `node dist/index.js build-session <workspace> <provider>`. It opens
  one browser, one page, one thread, and then waits.
- Newline-delimited JSON over stdin/stdout. Framing is required because stdin
  already carries approval replies (`APPROVAL_REQUEST:` blocks on a line read).
  - In: `{"type":"step",…}`, `{"type":"approval","approved":bool}`,
    `{"type":"pause"|"resume"|"skip"|"stop"}`
  - Out: `{"type":"log",…}`, `{"type":"approval-request",…}`,
    `{"type":"step-result","index":n,"success":bool,"appliedFiles":[…]}`
- `main.js` gains `start-build-session` / `send-build-command` plus an event
  stream to the renderer. `builder.js` opens a session once and awaits
  `step-result` per step instead of calling `runAgent` per step.
- The ledger moves into the session process; no disk persistence. A crashed
  session restarts with an empty ledger and re-sends everything — slower but
  correct.
- The per-step spawn path is retained as a fallback when a session fails to
  start, so a regression here cannot make builds impossible.

**Pause / skip / stop are the real cost.** Today they work by not spawning the
next process, which is trivial because nothing runs between steps. Against a live
process they become messages that must be honoured mid-flight, including while
blocked on a model response that can take two minutes. `stop` must tear down a
browser mid-request without orphaning it.

**Verifiable by:** a test that runs a full build through one session and asserts
Chromium launched once; and tests that pause, skip and stop each take effect
while a step is in flight.

**Risk:** high, and isolated here by design. Phases 1 and 2 remain functional if
this is reverted.

## Testing

The existing suite (40 unit + 64 end-to-end) is the safety net and must stay
green at every phase boundary. The end-to-end harness already drives the real CLI
and a real browser against a mock chat provider that records every prompt sent,
so assertions about *what the model was told* are available without a live
account.

New coverage per phase is listed above. Each phase is complete only when its
tests pass and the desktop app has been launched and driven.

## Consequences

- Threads grow within a build run. A plan with many long steps may approach
  provider context limits; if that appears, the mitigation is a summarise-and-
  restart within the run, which is out of scope here.
- `sessions.json` gains a field, so the desktop IPC handlers and the agent must
  continue to agree on its shape.
- Phase 3 changes the contract between `builder.js` and the agent. The VS Code
  extension does not use that path and is unaffected.
