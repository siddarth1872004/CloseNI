# Provider platform — design

Date: 2026-08-09
Roadmap items: 7 (GLM + Qwen), 9 (first-run login onboarding), 10 (provider logos)
Deferred: 8 (model / tool / effort switching) — see Deferred below
Sub-project: 2 · Provider platform
Status: agreed in brainstorming. Approach, item-8 deferral and login model chosen
by the project owner; implementation decisions are the author's.

## Problem

**More than half the provider config does nothing.** Every config specifies
`stopButton`, `codeBlock`, `copyButton`, `waitForStopButtonDisappear`,
`waitForCopyButton`, `stableMs`, `requiresLogin` and `kind`. None is read. Only
`chatInput`, `sendButton`, `assistantMessage`, `baseUrl`, `profileDir`, `enabled`
and `maxWaitMs` have any effect. Anyone adding a provider spends real effort on
fields that are decoration, and has no way to tell which is which.

**Completion detection is a slow guess.** A reply is considered finished when its
text has not changed for 8 seconds. That tax is paid on every response, every
retry, every step. `waitForStopButtonDisappear` describes a far better signal —
the provider's own stop button vanishing — and is already in every config,
unimplemented.

**The provider picker is hardcoded.** Two options in `index.html`; the two other
configs that exist are unreachable, and adding one means editing markup.

**An unauthenticated run hangs.** `waitForLogin` waits 120 seconds for a chat
input in a headless browser, where a login cannot happen, then fails confusingly
when `sendPrompt` cannot find the input.

## Decisions

1. **Implement the fields worth having, delete the rest.** `stopButton` and
   `waitForStopButtonDisappear` become real. `codeBlock`, `copyButton`,
   `waitForCopyButton`, `requiresLogin`, `kind` and `stableMs` are removed from
   the schema and every config.
2. **The picker reads the config directory** rather than hardcoded markup.
3. **Signing in is an explicit action** — a Sign in button per provider — and an
   unauthenticated run fails fast instead of hanging.
4. **Item 8 is deferred**, not attempted. See below.

## Deferred: model / tool / effort switching

Item 8 requires driving a provider's own UI — opening a model dropdown, choosing
an option, confirming the change took. The author cannot see or log into
DeepSeek, GLM or Qwen, so any click sequence would be written against a UI never
observed. Building the machinery and leaving the selectors blank would produce
something that looks finished and works nowhere.

It stays open until someone with a provider account can supply the actual markup.
Sub-project 2 therefore completes three of its four items, with the fourth
blocked on information rather than effort.

## Design

### Completion detection

`waitForResponse` gains a second completion signal. When the provider defines a
`stopButton` and sets `waitForStopButtonDisappear`, the loop also tracks whether
that button has been seen and then disappeared. If so, the reply is complete —
no stability wait.

Two constraints, because this is the code that already produced a 120-second
hang:

- The stop-button signal only applies **after** a response has been detected as
  started. A stop button absent because generation has not begun must never read
  as "finished".
- The stable-text check stays exactly as it is. It is the fallback when a
  provider has no stop button, when the selector is wrong, or when the button
  never appears. The new path can only make a wait shorter, never longer, and
  can never be the sole reason a wait ends.

### Config schema

Removed: `selectors.codeBlock`, `selectors.copyButton`,
`completionRules.waitForCopyButton`, `completionRules.stableMs`, `requiresLogin`,
`kind`. Retained and now implemented: `selectors.stopButton`,
`completionRules.waitForStopButtonDisappear`.

`stopButton` becomes optional — a provider without one falls back to stability,
which is current behaviour.

### Provider list

`main.js` reads `local-agent/config/providers/*.json` directly and returns
`{ id, name }` for each enabled provider. It does not spawn the agent; these are
plain JSON files and a process launch for a directory read would be absurd. The
renderer populates the picker from that, preserving the saved selection.

### GLM

A `glm.json` for `https://chat.z.ai/`. **Its selectors are unverified** — the
author has no account and has never seen the page. The generic fallbacks that
already cover DeepSeek and Qwen give it a reasonable chance, and a wrong
selector is a text edit rather than a code change. The config carries a comment
field recording that its selectors need checking against the live site.

### Signing in

A new one-shot mode:

```
node dist/index.js signin <provider>
```

It launches **headed regardless of `AGENT_HEADED`** — a login in an invisible
window is the bug being fixed — navigates to `baseUrl`, and waits up to five
minutes for the chat input to appear. Success means the persistent profile now
holds a session; there is no separate record, because the profile *is* the
record.

A **Sign in** button beside the provider picker runs it and reports the outcome.

Separately, `waitForLogin` stops waiting 120 seconds when running headless. If
the chat input has not appeared within 15 seconds it fails with a message naming
the Sign in button. Headed runs keep the long timeout, since a person may
genuinely be typing a password.

### Logos

A per-provider mark in the picker: the provider's initial on a coloured chip,
derived from its id, rendered in CSS. No brand assets are fetched or reproduced —
the author cannot verify a real logo, and an approximation of someone's brand is
worse than a neutral mark.

## Testing

- Unit: the completion decision as a pure function — started plus stop-button-
  gone means complete; stop button never seen falls through to stability; stop
  button absent before start does not complete.
- End-to-end: a mock provider with a stop button completes faster than one
  without; a provider with no `stopButton` still completes via stability;
  `signin` reports success when the input appears and failure when it does not.
- The picker and logo rendering are checked by driving the app.

## Non-goals

- Model, tool or effort switching (item 8, deferred above).
- Verifying GLM or Qwen selectors against the live sites.
- Reproducing brand logos.
- Any provider that is not a web chat UI driven through Playwright.

## Consequences

- Deleting config fields is a breaking change to the schema. All four shipped
  configs and the two test fixtures are updated together; there is no external
  consumer.
- A wrong `stopButton` selector degrades to today's behaviour rather than
  breaking, because stability remains the fallback.
- The five-minute `signin` timeout means a forgotten sign-in window holds a
  browser open for that long. It closes on success, so the cost is bounded.
