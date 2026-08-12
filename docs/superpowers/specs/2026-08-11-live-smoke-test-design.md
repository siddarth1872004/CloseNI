# One real round trip, judged strictly

Design, 11 August 2026. Section 8 of `docs/NEXT.md`.

## Why the passive check was not enough

The selector health check probes a saved conversation and reports on
`chatInput`, `sendButton`, `assistantMessage` and `copyButton`. It cannot see
four things, and every expensive failure this project has had lives in them:

- `stopButton` only exists **while a reply is generating**.
- The reply stream only fires **during one**.
- Whether the assistant text actually **grows** needs a reply in flight.
- How long completion takes needs **a clock**.

## The failure this is shaped around

The frozen assistant selector **did not fail**. It passed, after 300 seconds,
having watched three nodes that were the previous answer. A check that asks
"did a reply arrive" records that as green with a large number beside it.

That is exactly how it survived, and it is why this asserts a **budget** rather
than reporting a duration. A one-line reply taking ninety seconds means
completion is being detected by the text-stability fallback after everything
faster has failed to fire — a working build today and a broken one the next time
the page changes.

`COMPLETION_BUDGET_MS` is 60s. Not a performance target; a smoke alarm.

## Content, not presence

The prompt asks for a deterministic answer inside a code block:

```
Reply with nothing but a single Python code block containing exactly this one
line:
print('closeni-smoke-ok')
```

Three things follow from that. The reply can be checked for **content**, and
"some text was found" is satisfied by reading the wrong element while the exact
token is not. The code block gives the Copy control something real to be tested
against. And the answer is short, so the budget means something.

## Watching the real wait

The observer is an optional fourth argument to `waitForResponse`, not a
reimplementation of the poll loop. A copy would keep passing after the original
broke — the one thing a smoke test must never do.

It is wrapped in a `try`/`catch` inside the loop: an observer that throws would
turn a diagnostic into the failure it was added to diagnose.

## Severity

- **critical** — nothing sent, text never changed, completion never detected or
  over budget, reply missing the expected token. A build will fail or hang.
- **degraded** — a fallback exists and is worse: no stop button (completion
  falls back to text stability), the stream pattern matching nothing, the Copy
  control returning nothing or the wrong thing.
- **skipped** — the provider does not configure that selector. Not its failure.

Exit code 1 on any critical finding, so it can gate a release.

## Cost, and where it runs

It sends a real message against the user's account. That is why it is a command
you run — `npm run smoke [provider]` — rather than anything automatic, and it is
the same reason the passive health check was chosen for the per-build check.

It uses a **fresh conversation** with thread kind `worker` and no workspace, so
it can never adopt, resume or overwrite a thread a build is relying on.

## Testing

`judgeSmoke` is pure — the caller drives the browser, the module decides what
the observations mean — so all 28 cases run without an account, a network or a
clock. Including both halves of the frozen-selector bug together, the budget
from each side, a reply that contains text but not the right text, and every
degraded fallback.

`verify.mjs` pins that the observer watches the real `waitForResponse`, that a
slow completion is critical rather than reported, that content is checked rather
than presence, and that the test uses a thread of its own.

## What is still not verified

**This has never run against a live provider.** The gated-provider and
unknown-provider paths were exercised here and exit 1 correctly; the round trip
itself has not been executed, because doing so needs a signed-in DeepSeek
session.

That is the honest state of it: the test that exists to close this project's
"tested but never run" gap has not itself been run. One `npm run smoke` on a
machine signed in to DeepSeek changes that, and would also settle the open
`streamUrlPattern` question in §1 — if the stream check reports degraded, the
pattern is wrong.

## Not in scope

- Running the full build pipeline. A model writing poor code would fail the test
  for a reason that is not a regression in CloseNI, which makes the signal
  untrustworthy exactly where it needs to be trusted.
- Running automatically, on a schedule or before a build.
- Recording the traffic for replay. That is the next §8 item.
