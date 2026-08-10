# Provider controls (mode, thinking, search) — design

Date: 2026-08-10
Roadmap item: 8 (model / tool / effort switching)
Sub-project: 2 · Provider platform — the deferred fourth item
Status: agreed in brainstorming. Control model chosen by the project owner;
markup supplied by the project owner from a live DeepSeek session.

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
2. **Controls are declared in the provider config**, not hardcoded. A provider
   without a `controls` block simply has none, which is every provider but
   DeepSeek today.
3. **State is read before clicking.** Every control reports its own state
   (`aria-pressed`, `aria-checked`), so the agent clicks only to change it.
   Blind toggling would turn a wanted setting off.
4. **`vision` is not offered.** Two modes are enough; the owner does not want it.

## Design

### Config

`ProviderConfig` gains an optional `controls` array. The schema is deliberately
**not** shaped around DeepSeek: GLM and Qwen have not been observed and are
likely to differ in kind, not just in selector.

Three things vary between providers, so all three are declared rather than
assumed:

**1. Whether options must be revealed first.** DeepSeek shows its modes inline.
A provider with a dropdown has no options in the DOM until a trigger is clicked.
An optional `open` selector covers that; absent, the control is already visible.

**2. How state is read.** DeepSeek exposes `aria-pressed` and `aria-checked`.
Another provider may mark the selection with a CSS class, or expose nothing.

**3. What kind of interaction it is.** A toggle flips; a select chooses one of
several.

```json
"controls": [
  {
    "id": "mode",
    "label": "Mode",
    "kind": "select",
    "selector": "[role=\"radiogroup\"] [data-model-type=\"{value}\"]",
    "state": { "by": "attr", "attr": "aria-checked", "on": "true" },
    "options": [
      { "value": "default", "label": "Instant" },
      { "value": "expert",  "label": "Advanced" }
    ]
  },
  {
    "id": "deep-thinking",
    "label": "Deep thinking",
    "kind": "toggle",
    "selector": ".ds-toggle-button",
    "matchText": "Deep thinking",
    "state": { "by": "attr", "attr": "aria-pressed", "on": "true" }
  }
]
```

A provider whose menu must be opened, and which marks selection with a class:

```json
{
  "id": "model",
  "label": "Model",
  "kind": "select",
  "open": "button[class*=\"model-picker\"]",
  "selector": "[role=\"menuitem\"]",
  "matchText": "{label}",
  "state": { "by": "class", "class": "is-selected" },
  "close": "Escape",
  "options": [{ "value": "pro", "label": "GLM-4 Pro" }]
}
```

And one that exposes nothing readable:

```json
{ "id": "x", "label": "X", "kind": "toggle", "selector": "…",
  "state": { "by": "none" } }
```

`state.by` is one of `attr`, `class` or `none`. With `none`, the agent cannot
tell whether a click is needed, so it does not guess: it clicks only when the
desired value differs from what it last set in this session, and logs that the
state is unverifiable. Silently flipping a setting the user wanted is worse than
leaving it alone.

`{value}` and `{label}` are substituted from the chosen option, so a provider can
target either a data attribute or visible text. `close` names an optional key to
press after choosing, for menus that stay open.

**Hashed classes are deliberately absent.** `f79352dc` and `_9f2341b` are build
artefacts and will change on any DeepSeek deploy. `ds-toggle-button`,
`aria-pressed`, `aria-checked` and `data-model-type` are semantic and survive.

### Decoding a new provider

GLM and Qwen get no `controls` block until their markup has been observed.
`scripts/capture-provider-ui.mjs` is extended to report **candidate controls** —
every element carrying `aria-pressed`, `aria-checked`, `role="switch"`,
`role="radio"`, `role="menuitem"`, or a `data-*` attribute whose name suggests a
mode or model — printed in roughly the shape the config wants, so decoding a
provider is reading a list rather than trawling markup.

### Applying

A pure function decides what to do, so the decision is testable without a
browser:

```
planControlActions(controls, desired, current) -> { id, action: "click" | "skip", reason }[]
```

`current` is what the page reports. A control already in the wanted state is
skipped, and the reason is logged — so a run states plainly that it left Deep
thinking alone because it was already on.

`applyProviderControls(page, config, desired)` reads each control's state,
consults the planner, clicks what needs changing, then re-reads to confirm. A
control that will not change state is logged and the run continues: a build
should not fail because a toggle was stubborn.

Applied immediately after the chat input appears, in every path that opens a
conversation.

### Settings UI

The sidebar renders controls for the selected provider, read from its config.
Values persist per provider in `localStorage` under
`closeni.controls.<providerId>`, and are passed to the agent as a JSON argument.
Switching providers re-renders; a provider with no `controls` shows nothing.

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

- Unit: `planControlActions` — already-correct state skipped, wrong state
  clicked, unknown control ignored, missing desired value left alone.
- End-to-end: a mock provider with a toggle and a radio group; assert the agent
  clicks only what needs changing, reports state it could not change, and that a
  provider without a `controls` block is unaffected.
- The sidebar rendering is checked by driving the app.

## Consequences

- Every conversation open now costs a few extra reads and possibly two clicks.
  Small against a browser launch, and it happens once per thread.
- A DeepSeek redesign that renames `data-model-type` or drops `aria-pressed`
  breaks this silently — the agent would log that it could not change a control
  and carry on. That is the right failure, but it is a failure the user must
  read the log to notice.
