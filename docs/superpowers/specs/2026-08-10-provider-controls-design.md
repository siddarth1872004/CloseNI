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

`ProviderConfig` gains an optional `controls` array. Each entry is one of two
kinds.

```json
"controls": [
  {
    "id": "mode",
    "label": "Mode",
    "kind": "radio",
    "selector": "[role=\"radiogroup\"] [data-model-type=\"{value}\"]",
    "stateAttr": "aria-checked",
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
    "stateAttr": "aria-pressed"
  },
  {
    "id": "smart-search",
    "label": "Smart Search",
    "kind": "toggle",
    "selector": ".ds-toggle-button",
    "matchText": "Smart Search",
    "stateAttr": "aria-pressed"
  }
]
```

`{value}` in a radio selector is substituted with the chosen option. `matchText`
disambiguates toggles that share a class — the label sits inside the clickable
element, so a text filter targets it exactly.

**Hashed classes are deliberately absent.** `f79352dc` and `_9f2341b` are build
artefacts and will change on any DeepSeek deploy. `ds-toggle-button`,
`aria-pressed`, `aria-checked` and `data-model-type` are semantic and survive.

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
- Controls for GLM or Qwen. Their markup has not been observed; adding a
  `controls` block for either would be the same guesswork this item was deferred
  to avoid.
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
