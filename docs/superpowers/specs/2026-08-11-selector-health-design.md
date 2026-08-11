# Checking a provider's selectors still match

Design, 11 August 2026. Section 5 of `docs/NEXT.md`.

## The premise in NEXT.md was wrong

It says: *"A provider health check on startup: are the selectors still matching?
A five-second probe would have caught the frozen assistant selector before a
build did."*

It would not have. Half the selectors have nothing to match on a fresh page:

| Selector | Checkable on a fresh chat? |
|---|---|
| `chatInput`, `sendButton` | yes |
| `assistantMessage` | no — there are no messages |
| `stopButton` | no — only exists while generating |
| `copyButton` | no — only on code blocks |
| `streamUrlPattern` | no — only during a reply |

The bug it is justified by — `assistantMessage` matching three stale nodes so a
step sat at `messages=3, chars=9019` for a full 300-second wait — lives entirely
in the half a fresh-page probe cannot see.

## What makes it work instead

**Probe the saved conversation, not a fresh page.**

A workspace that has been used has a thread full of real assistant messages and
real code blocks. Opening it costs nothing, sends nothing, and gives every
read-path selector something it should match. A workspace with no thread yet
falls back to the fresh page and is told, in the report, that this is all it
could verify.

## The rule the whole thing rests on

> Zero matches is only evidence of a problem when something **should** have
> matched.

`assistantMessage` finding nothing on an empty chat is not a fault. Finding
nothing in a conversation we resumed — which by definition holds an exchange —
is exactly the fault above.

Reporting the first as a failure trains everyone to ignore the check. Reporting
the second as fine is how the bug survived. `conversationResumed` is what
separates them, and it is a fact we already have: `navigateToChat` returns it.

## Severity, and why nothing blocks

- **critical** — `chatInput` missing, or `assistantMessage` dead in a resumed
  conversation. A build will fail or hang.
- **degraded** — a fallback exists and is worse. `sendButton` (prompts go via
  Enter, which has always worked), `copyButton` (code is read from the DOM, as
  it was before that existed).
- **skipped** — nothing on the page could match right now. Reported explicitly
  rather than omitted: a check that silently drops what it could not verify
  reads as "everything is fine".

A critical finding is reported and the build continues. A probe that is itself
wrong must not be able to stop a build that would have worked — and the probe is
newer than the code it is checking.

## Where it runs

**Inside the build session**, after login and before step 1. The session already
owns the browser and holds the profile, so there is no second launch and no lock
to contend for — and it is the moment the answer matters.

Running it at app startup, as NEXT.md proposed, would take the profile lock at
launch. Chromium locks that directory; a build started during the probe would
land on a profile it cannot own, come up empty, and report "Chat input not
found" — which reads like exactly the breakage this is meant to detect.

**Plus a button** in the account panel, queued through `queueAgentRun` and
refused while a build holds the profile, for the same reason.

## Testing

`judgeSelectors` is pure — the controller counts nodes, the module decides what
the counts mean — so every case is tested without a browser: the frozen selector
in a resumed conversation, the identical zero on a fresh page, a missing
composer, the two degraded fallbacks, unconfigured selectors, empty input.

`verify.mjs` pins the ordering (before step 1), that a failed probe does not stop
a build, and that the on-demand path respects the profile lock.

## Not in scope

- Sending a probe message. It is the only way to check `stopButton` and
  `streamUrlPattern` end to end, and it costs a real message, a scratch
  conversation and 15–30 seconds. That is `NEXT.md` §8's live smoke test.
- Repairing a broken selector automatically.
