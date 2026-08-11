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
- **Continue past a failed step** when nothing depends on it. Today one failure
  blocks everything behind it even when the graph says otherwise.
- **Resume a build across app restarts.** The ledger already survives; the
  builder does not use it on startup.
- **Checkpoint and roll back a step.** Backups exist per apply; there is no
  "undo step 4" in the interface.

## 3 · Make a build cheaper to run

- **Only send a file the thread has not seen** - the delta ledger exists but
  still re-sends the tree on step 1 of every build.
- **Summarise finished steps** instead of carrying them forever. A twenty-step
  build ends with a conversation the provider re-reads on every turn.
- **Detect the provider's context limit** and start a fresh thread with a
  summary rather than failing at step fifteen.

## 4 · Verification worth trusting

- **Run the tests the model wrote**, not just the ones the project shipped with.
  `Run tests` exists; nothing yet asks the model to write tests for its own step.
- **Type checking beyond syntax**: `mypy`, `tsc --strict`, `cargo clippy`.
  Compiling is a low bar and we currently stop there.
- **A diff review step** - show what changed and let the user reject a step
  before the next one builds on it.

## 5 · Providers

- **Un-gate Qwen** - page control already works; it needs a completion wait that
  survives a reasoning model, which the stream signal may simply solve.
- **Un-gate GLM** - needs its selectors confirmed against the live site.
- **Local models** (Ollama, LM Studio) - no browser, no scraping, no rate limit.
  The architecture already separates "provider" from "how you talk to it", and
  this would be the first provider that cannot break from a redesign.
- **A provider health check** on startup: are the selectors still matching? A
  five-second probe would have caught the frozen assistant selector before a
  build did.

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

- **A live-provider smoke test** that runs one real chat and reports whether
  each selector still matched. The single most valuable test this project could
  have, and the only one that would have caught today's failures before a user
  did.
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
