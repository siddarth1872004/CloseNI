# Provider controls (mode, thinking, search) — design

Date: 2026-08-10
Roadmap item: 8 (model / tool / effort switching)
Sub-project: 2 · Provider platform — the deferred fourth item
Status: implemented — `plans/2026-08-10-provider-controls.md`. Control model
chosen by the project owner; markup supplied by the project owner from live
sessions.

**One non-goal below has since been met.** This spec was written when only
DeepSeek had been observed and lists shipping GLM and Qwen controls as out of
scope. The owner then captured both, and all three shipped together. The
prediction that they would differ in kind rather than only in selector held, and
is what the per-provider design was for; see the plan for the comparison.

## Problem

Item 8 was deferred because it needed click sequences against a provider UI
nobody here could observe. The owner captured DeepSeek's live markup, so it is
now writable against what is actually there rather than guessed.

DeepSeek has no model dropdown. It has two toggles and a mode radio group:

```html
<!-- toggles, label is inside the clickable element -->
<div tabindex="0" aria-pressed="true" class="ds-toggle-button ds-toggle-button--selected">
  <div class="ds-toggle-button__icon">…</div><span>Deep thinking</span>
</div>
<div tabindex="0" aria-pressed="true" class="ds-toggle-button ds-toggle-button--selected">
  <div class="ds-toggle-button__icon">…</div><span>Smart Search</span>
</div>

<!-- modes -->
<div role="radiogroup">
  <div data-model-type="default" role="radio" aria-checked="true">…Instant…</div>
  <div data-model-type="expert"  role="radio" aria-checked="false">…Advanced…</div>
  <div data-model-type="vision"  role="radio" aria-checked="false">…</div>
</div>
```

**These settings do not persist.** The owner confirmed they reset on a new chat.
Builds open a fresh thread per run and one-shot modes always start fresh, so the
agent must apply them every time it opens a conversation.

## Decisions

1. **The user chooses; the agent applies.** Settings live in the sidebar, not in
   per-task heuristics. An agent silently deciding to disable Deep thinking is a
   decision the user cannot see without reading the log.
2. **Behaviour is code, selectors are config.** Each provider gets a module that
   can express whatever its UI needs; the selectors it uses stay in JSON because
   they rot fastest.
3. **State is read before clicking, where it can be.** DeepSeek reports its own
   state via `aria-pressed` and `aria-checked`, so the agent clicks only to
   change something — blind toggling would turn a wanted setting off. A provider
   that exposes no readable state is handled explicitly rather than assumed away;
   see `state.by: "none"`.
4. **`vision` is not offered.** Two modes are enough; the owner does not want it.
5. **Nothing about DeepSeek's shape is shared.** GLM and Qwen are expected to
   differ in kind. A shared schema would have forced them into DeepSeek's mould;
   a per-provider function does not.

## Design

**Behaviour lives in code, selectors live in config.** A declarative schema was
tried first and grew `open`, `close`, `matchText` and `state.by` in a single
revision — a small programming language, badly. Providers differ in kind, not
only in selector, so each gets a function that can do whatever that provider
needs: open a menu, wait, scroll, verify, retry.

The codebase already assumed this. `deepseek.adapter.ts`, `qwen-studio.adapter.ts`
and `open-webui.adapter.ts` existed as empty files until sub-project 9 deleted
them for being stubs. This is that idea, built.

### Three layers

**1. Config declares what exists** — enough for the sidebar to render controls
and validate values. No behaviour:

```json
"controls": [
  { "id": "mode", "label": "Mode", "kind": "select", "default": "default",
    "options": [
      { "value": "default", "label": "Instant" },
      { "value": "expert",  "label": "Advanced" }
    ] },
  { "id": "deep-thinking", "label": "Deep thinking", "kind": "toggle", "default": true },
  { "id": "smart-search",  "label": "Smart Search",  "kind": "toggle", "default": false }
]
```

**2. Config carries the selectors**, because those rot fastest. A provider
renaming a class should be a text edit, not a recompile:

```json
"controlSelectors": {
  "modeOption": "[role=\"radiogroup\"] [data-model-type=\"{value}\"]",
  "toggle": ".ds-toggle-button"
}
```

**3. A module drives it.** `local-agent/src/providers/controls/deepseek.ts`
exports one function:

```typescript
applyControls(page: Page, selectors: Record<string, string>, desired: Record<string, unknown>): Promise<ControlResult[]>
ControlResult = { id: string; action: "clicked" | "already-set" | "unavailable"; detail?: string }
```

A provider with no module has no controls, which is every provider but DeepSeek
today. `controls/index.ts` maps provider id to function; an unknown id returns an
empty result rather than throwing.

### Shared helpers

The common patterns live in `controls/helpers.ts` so each provider module stays
short — DeepSeek's is about thirty lines:

- `setToggleByText(page, selector, text, want)` — finds the element whose own
  text matches, reads `aria-pressed`, clicks only if it differs, re-reads to
  confirm.
- `pickOption(page, selectorTemplate, value)` — substitutes `{value}`, reads
  `aria-checked`, clicks only if not already selected.

Both return a `ControlResult` rather than throwing. **A control that will not
change is logged and the run continues** — a build should not fail because a
toggle was stubborn.

### Reading before clicking

DeepSeek reports its own state, so the agent clicks only to change something.
Blind toggling would turn a wanted setting off. Where a provider exposes no
readable state, its module decides what to do about that — the decision belongs
with the provider that has the problem, not in a shared schema flag.

### When it runs

Immediately after the chat input appears, on every path that opens a
conversation. The settings do not persist across chats, and builds open a fresh
thread per run.

### Decoding a new provider

GLM and Qwen get no module until their markup has been observed.
`scripts/capture-provider-ui.mjs` reports **candidate controls** — every element
carrying `aria-pressed`, `aria-checked`, `role="switch"`, `role="radio"`,
`role="menuitem"`, `role="option"` or a `<select>`, with its text, data
attributes and readable state, filtering out hashed classes that change on every
deploy. Decoding a provider is reading that list, not trawling 180KB of markup.

### Settings UI

The sidebar renders each control declared by the selected provider. Values
persist per provider in `localStorage` under `closeni.controls.<providerId>` and
are passed to the agent as a JSON argument. A provider with no `controls` shows
nothing.

## Non-goals

- Per-task automatic switching. Explicitly rejected: invisible decisions.
- The `vision` mode.
- Shipping controls for GLM or Qwen. Their markup has not been observed, and
  they are expected to differ in kind rather than only in selector. The schema is
  built to accommodate them and the capture tool is built to decode them; the
  configs follow once someone with an account runs it.
- Verifying that DeepSeek's selectors still work after a DeepSeek redesign. They
  are semantic, which is the best available mitigation, not a guarantee.

## Testing

- Unit: the shared helpers' decision logic — already-correct state skipped,
  wrong state clicked, missing element reported as unavailable rather than
  throwing, unknown provider id yielding no results.
- End-to-end: the mock provider renders DeepSeek-shaped controls (a
  `ds-toggle-button` with `aria-pressed` and a `radiogroup` with
  `data-model-type`), and the DeepSeek module is driven against them: assert it
  clicks only what needs changing, leaves an already-correct control alone, and
  that a provider with no module is unaffected.
- The sidebar rendering is checked by driving the app.

## Consequences

- Every conversation open now costs a few extra reads and possibly two clicks.
  Small against a browser launch, and it happens once per thread.
- A DeepSeek redesign that renames `data-model-type` or drops `aria-pressed`
  breaks this silently — the agent would log that it could not change a control
  and carry on. That is the right failure, but it is a failure the user must
  read the log to notice.
