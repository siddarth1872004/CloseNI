# Where CloseNI goes next

Written 11 August 2026, after a day of running the app against a live provider
rather than against tests. Ordered by what a real run actually stumbles over,
not by what is most interesting to build.

The through-line: **every serious bug this project has had came from guessing at
someone else's web page.** Frozen selectors, virtualised lists, hashed class
names, a stop button that never matched, a copy button found by an eight-level
CSS path. The work below is mostly about needing to guess less.

---

## 0 · The premise, restated

Read the page as little as possible. The browser is how we *authenticate* and
how we *send*. It should not be how we find out what happened.

Three layers, most reliable first:

| Layer | What it answers | Status |
|---|---|---|
| The page's own network stream | did a reply start, did it end | **done** for completion; not yet for text |
| The site's own controls (Copy) | what is the exact text of this block | **done** |
| The rendered DOM | everything else | fallback only |

---

## 1 · Finish the stream work

The stream currently tells us **when a reply ends**. It can also tell us **what
the reply is**, which removes the DOM from the read path entirely.

- **Read the text from the stream.** Needs each provider's chunk format. This is
  the single highest-value item left: no highlighting to un-parse, no toolbar
  text to filter, no virtualisation, and long replies stop being truncated by a
  list that only renders what is on screen.
- **Confirm DeepSeek's endpoint.** `streamUrlPattern` is currently a guess
  (`/api/.*(completion|chat_session|chat)`). One look at the Network tab
  replaces the guess with a fact.
- **Detect a refusal or a rate limit from the stream** rather than from prose.
  A provider saying "you have hit your limit" currently reads as a normal reply
  that happens not to contain JSON, and the build fails on a re-ask instead of
  telling the user to wait.

## 2 · Stop losing work to one bad step

- ~~**Per-step retry with a different tactic**, not the same one twice.~~ **Done.**
  A failed apply no longer takes the verification follow-up - which told the model
  its code had failed under test and to fix the root cause, when in fact nothing
  ran. `buildApplyFollowUp` names the files that would not apply, explains which
  of the three failure modes happened, and asks for whole-file overwrites,
  explicitly abandoning `search_replace`. That is what rescued the run on
  11 August by accident; it is now deliberate.
- ~~**Continue past a failed step** when nothing depends on it.~~ **Done.** The
  scheduler could always do this; it never got the chance. The renderer built its
  step list without carrying `dependsOn` across, so every plan looked undeclared,
  became a chain, and a failure at step 4 of eighteen blocked fourteen steps that
  did not need it. The graph now comes from `CNSched.graphFor`, which validates it
  and falls back to the chain - the old behaviour - if it cannot be scheduled.
- ~~**Resume a build across app restarts.**~~ **Done**, and the note here was
  wrong: the ledger records which *files the conversation has seen*, not which
  steps ran. Closing the app did not lose progress tracking, it lost **the plan**,
  which lived only as `let currentPlan = null` in the renderer. It now lives in
  `.closeni/build.json` in the workspace, beside `closeni.run.json` and for the
  same reason. Opening the folder restores the plan and its statuses; nothing
  runs until Build is pressed. Design: `docs/superpowers/specs/2026-08-11-resume-build-design.md`.
- ~~**Checkpoint and roll back a step.**~~ **Done**, and the per-apply backups
  turned out not to be usable material: a backup only holds files that already
  existed, so it cannot say which files a step *created*, and `applyPatch` runs
  inside the repair loop while `StepOutcome` carried only the last of its two or
  three backup directories - restoring from that would return the workspace to
  the middle of a step's own repair. Checkpoints record the state *before* a
  step instead, in `.closeni/checkpoints/`. "Roll back to here" undoes that step
  and everything after it, naming any file edited by hand since before it
  touches anything. Design:
  `docs/superpowers/specs/2026-08-11-step-rollback-design.md`.

## 3 · Make a build cheaper to run — **done**, and two of the three items were wrong

- ~~**Only send a file the thread has not seen.**~~ Already done. The delta
  ledger skips what the conversation holds, and "re-sends the tree on step 1"
  describes behaviour that is now correct: `needsFullContext` sends it on step 1
  or when the thread is cold, which is exactly when the thread lacks it.
- ~~**Summarise finished steps.**~~ **Impossible as written.** It assumes the
  conversation can be edited. It cannot - it is the provider's, and every prompt
  and every reply stays in it. There is no lever that shortens a thread.
- ~~**Detect the provider's context limit.**~~ **Done**, as the only thing §3
  really was: count what we send and receive against a per-provider budget, and
  when the next exchange would not fit, continue in a new conversation seeded by
  the cold-thread path built for resuming. Design:
  `docs/superpowers/specs/2026-08-11-conversation-rollover-design.md`.

## 4 · Verification worth trusting

- ~~**Run the tests the model wrote.**~~ **Done.** `behaviour-checker.ts` already
  discovered and ran a project's suite; what was missing was anyone asking the
  model for tests, and the suite running during a build rather than on demand.
  The plan now declares a `testable` flag per step, so scaffolding is not asked
  for a test that restates a constant, and the suite runs after the syntax and
  type checks - gated on tests existing, because `pytest -q` with nothing to
  collect exits non-zero and would fail every early step. A failing test gets its
  own follow-up: the model wrote the code AND the assertion, so telling it "your
  code failed" makes it bend correct code to satisfy a wrong test. Design:
  `docs/superpowers/specs/2026-08-11-step-tests-design.md`.
- ~~**Type checking beyond syntax**: `mypy`, `tsc --strict`, `cargo clippy`.~~
  **Done**, and two of those three were wrong. `tsc --noEmit` already runs and
  honours the project's own tsconfig, so forcing `--strict` would override the
  author and fail correct code; `cargo check` already catches type errors and
  clippy adds lint, not types. Python was the real gap - `py_compile` proves a
  file parses and nothing more. mypy now runs per step, in default mode rather
  than `--strict`, with the flags that stop it failing a Flask project on a
  missing stub for flask. Design:
  `docs/superpowers/specs/2026-08-11-type-checking-design.md`.
- ~~**A diff review step.**~~ **Done**, and mostly wiring: the step panel already
  rendered diffs, the loop already paused, and checkpoints already made undoing
  one step exact. The decision was what rejecting means - it rolls the step back,
  asks what was wrong, and runs it again with that reason, rather than stopping
  the build. Off by default. Design:
  `docs/superpowers/specs/2026-08-11-step-review-design.md`.

**Section 4 complete.**

## 5 · Providers

- **Un-gate Qwen** - page control already works; it needs a completion wait that
  survives a reasoning model, which the stream signal may simply solve.
- **Un-gate GLM** - needs its selectors confirmed against the live site.
- ~~**Local models** (Ollama, LM Studio).~~ **Done for Chat**, and the claim here
  was false: nothing separated "provider" from "how you talk to it".
  `PlaywrightController` was a concrete class with a twenty-three method surface
  that `index.ts` used directly, most of it meaningless off a web page. The seam
  is now four methods - `start`, `ready`, `ask`, `reset` - with the browser behind
  a thin adapter and Ollama as a second implementation in the same change, because
  an abstraction with one implementor is a rename. Plan and build stay
  browser-only and refuse a local provider with a sentence. Design:
  `docs/superpowers/specs/2026-08-11-local-models-design.md`.
- ~~**A provider health check** on startup.~~ **Done**, but not as described -
  a fresh-page probe would *not* have caught the frozen assistant selector,
  because an empty chat has no replies for `assistantMessage` to match, no code
  blocks for `copyButton`, and no `stopButton` or reply stream while idle. It
  probes **this workspace's saved conversation** instead, where those selectors
  have real markup to match, and falls back to the fresh page while saying so.
  The rule it encodes: zero matches is only a fault when something should have
  matched. Runs inside the build session before step 1 - free, since the session
  already holds the profile - plus a button. Reports and continues; a probe that
  is itself wrong must not stop a build that would have worked. Design:
  `docs/superpowers/specs/2026-08-11-selector-health-design.md`.

## 6 · The Research panel

Gated because DuckDuckGo answers scripted requests with a challenge page. The
fix is not a better scraper - it is to run the search **in the browser the app
already drives**, which is the project's whole premise. Same for GitHub search,
which currently uses an unauthenticated API and is rate-limited.

## 7 · Things people will ask for

- **Multiple workspaces open at once**, with one browser profile shared.
- **A plan editor** - reorder, merge and delete steps before building.
- **Export a build** as a git branch with one commit per step.
- **Cost/time reporting**: how long each step took, where the wait went.
- **A headless CLI** - `closeni build ./project "add auth"` with no window, for
  people who want it in a script.

## 8 · Keeping the project honest

The verification work has repeatedly caught things reading could not. Worth
extending:

- ~~**A live-provider smoke test.**~~ **Built** - `npm run smoke [provider]`.
  Sends one deterministic prompt and judges the whole read path: the stop button
  appearing, the reply stream opening and closing, whether the assistant text
  actually grows, how long completion took, whether the reply contains the exact
  expected token, and what the Copy control returns. It asserts a 60s budget
  rather than reporting a duration, because the frozen selector did not fail - it
  passed after 300 seconds. **Not yet run against a live provider**, which is the
  one thing left to make it worth anything. Design:
  `docs/superpowers/specs/2026-08-11-live-smoke-test-design.md`.
- **Record and replay**: capture a real session's network traffic once, then
  replay it in tests. Real provider behaviour, no network, no account.
- **Keep every fix's evidence in the commit.** It has been the difference
  between fixing a bug and fixing the reason it was believed.

---

## What not to do

- **Do not switch browsers.** Every failure so far has been about guessing which
  element matters. Chromium, Firefox and WebKit hand back the same DOM.
- **Do not add more selectors as the answer to a broken selector.** The
  direction is to need fewer, by reading the stream instead.
- **Do not publish a build until a run completes end to end.** Three 1.0.x
  releases went out and were withdrawn the same day; each carried a defect that
  the first thing a user does would hit.
