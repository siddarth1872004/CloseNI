# Provider controls — implementation

Date: 2026-08-10
Spec: `docs/superpowers/specs/2026-08-10-provider-controls-design.md`
Roadmap item: 8 (model / tool / effort switching)
Sub-project: 2 · Provider platform — the deferred fourth item

## What changed since the spec

The spec was written when only DeepSeek had been observed, and said GLM and
Qwen would get no module until their markup was seen. All three have now been
captured. The spec's central bet — that they would differ in kind, not only in
selector — held:

| | Find the control | Read its state | Options |
|---|---|---|---|
| DeepSeek | `.ds-toggle-button`, `[data-model-type]` | `aria-pressed` / `aria-checked` | inline, always present |
| Qwen | `[aria-label="Select Model"]` | the trigger's **visible text** | Ant Design popup, created on open |
| GLM | `button[aria-label="Select a model"]` | `data-selected` | Radix portal, keyed by `data-value` |

Reading DeepSeek's state is `getAttribute`. Reading Qwen's is scraping a label.
Setting DeepSeek's is one click; setting Qwen's is open, find, click, verify.
A single declarative schema would have had to become a small programming
language to cover that, which is exactly what the spec rejected.

## Build order

1. **`controls/decisions.ts`** — the pure decisions: does this state mean click,
   skip, or "I cannot read it"; does this option's label match; parse the
   settings that arrive as JSON. Testable without a browser, which is where the
   subtle bugs are.
2. **`controls/helpers.ts`** — visibility that does not lie (`isVisible`, never
   `count`), click-only-if-needed with a read-back, and `guard`, which turns any
   failure into a reported result rather than a thrown build.
3. **`controls/deepseek.ts`, `qwen-studio.ts`, `glm.ts`** — one per provider.
4. **`controls/index.ts`** — id to module. An unknown provider yields no
   results rather than an error.
5. **Config blocks** — `controls[]` for the sidebar, `controlSelectors{}` for
   the modules.
6. **`waitForLogin` applies them** — the single point every path that opens a
   conversation already passes through, right after the chat input appears.
7. **Sidebar panel** — rendered from the selected provider's `controls[]`,
   persisted per provider, passed down as `AGENT_CONTROLS`.

## Decisions made while building

**Applied from `waitForLogin`, not from each navigation path.** Six call sites
open a conversation; all six call `waitForLogin` immediately afterwards, and it
is already the place that waits for the chat input. Wiring it there means a
seventh path added later gets controls without anyone remembering to. The
config is held from `launch()` so nothing needs a new parameter.

**Settings travel as an environment variable, not an argument.** Every mode —
chat, plan, build, build-session, suggest — opens a conversation, so a
positional argument would have to be threaded through all of them and kept in
step. `AGENT_CONTROLS` is read once, in the controller.

**GLM's Deep Think on/off toggle is deliberately not wired.** The menu has one,
but it reports no readable state, and picking a level is what engages Deep Think
anyway. Clicking it blind could switch off the very thing being configured.

**GLM's Search menu is not wired.** Its trigger was never captured — the
selector guess timed out. Shipping model and thinking for all three providers
beat stalling on one menu of one provider. It can be added from the same
capture tool later.

**GLM's `data-value` casing is copied verbatim.** GLM's own markup is
inconsistent: `glm-5.2` and `glm-4.7` lowercase, `GLM-5.1` and `GLM-5-Turbo`
uppercase, `GLM-5v-Turbo` with a lowercase v against a label reading 5V. Values
are never derived from labels.

**Saved settings are validated against what the provider declares now.** A
model dropped from a line-up would otherwise sit in localStorage forever, asking
for something that no longer exists and reporting "unavailable" on every run.

## Testing

**Unit (25 checks).** The decisions with no browser: an already-correct state is
skipped, a wrong one is clicked, a missing attribute is "unreadable" rather than
a guess, a longer name does not satisfy a request for a shorter one, malformed
settings JSON yields no controls rather than a crash, and an unknown provider id
has no module. Plus 13 on the sidebar's settings resolution.

**End-to-end.** The mock provider serves `/__controls`, a page carrying all
three shapes with working behaviour — clicking really does move `aria-pressed`,
`data-selected` and the trigger text — and each module is driven against its
own shape. The checks that matter:

- Re-applying identical settings clicks **nothing**. This is what makes it safe
  to run on every conversation open.
- A toggle with no `aria-pressed` is reported, never clicked. The mock's
  "Mystery" toggle *does* move on click, so a module that toggled blind would
  otherwise look successful.
- Qwen does not match `Qwen3.7` against `Qwen3.7-Max`, whose description
  mentions Qwen3.7.
- A selector matching nothing is a log line, not a thrown build.

The modules are driven directly rather than through the CLI: the mock chat page
has no model picker, and giving it one would make it a fourth shape resembling
nothing real.

## Consequences

- Every conversation open costs a few reads and at most a click or two. Small
  against a browser launch, and settings do not persist across chats, so it has
  to happen every time.
- A provider redesign breaks this quietly: the agent logs that it could not
  change a control and carries on. That is the right failure — a build should
  not die over a toggle — but it is one the user only sees by reading the log.
- The selectors are semantic, which is the best available mitigation against a
  redesign, not a guarantee. They live in JSON so fixing one is a text edit.
