# Visual identity & polish — design

Date: 2026-08-10
Roadmap items: 19 (UI refresh), 20 (language logos), 21 (settings page),
26 (beautiful, detailed UI), 27 (logo)
Sub-project: 7 · Visual identity & polish
Status: agreed in brainstorming, with mockups reviewed in the visual companion.
Settings placement, logo mark, theme roster, the removal of motion and the
"CloseNI only" boundary were all chosen by the project owner.

## Problem

Three of the five items in this sub-project — 19, 26, and to a degree 20 — have
no completion criterion. "Beautiful, detailed UI" could absorb unlimited work
and never be finishable. The first job of this spec is to turn them into things
that can be finished.

The other two are concrete but blocked on nothing: there is no settings page
(item 21) and no logo (item 27). Sub-project 8 needs the logo for an installer
icon, so it is on the critical path.

### What is actually wrong today

The UI is not ugly. It has a deliberate language — near-black ground, monospace
accents, uppercase micro-labels, hairline borders, almost no colour — and that
language is worth keeping. What it lacks is *system*:

- **The rail is overloaded.** Workspace, chat session, provider, sign-in,
  provider controls, permissions and Show Browser are all stacked in a 210px
  column, and it grows every time a provider gains a control.
- **`styles.css` has no tokens worth the name.** Six variables exist; the file
  then hardcodes `#0e0e10`, `#17171a`, `#050506`, `#8fe0a8`, `#eda1a6` and more
  throughout. Nothing can restyle the app while that is true.
- **No `:focus-visible` rule exists anywhere.** Tabbing through the app shows
  nothing at all.
- **No `prefers-reduced-motion` support.** The pulse animation runs regardless.
- **Duplicated rules.** `.step-card-status.running`, `.done` and `.failed` are
  each declared twice; `#provider-select` and `#autonomy-select` re-declare what
  `input,textarea,select` already says.
- **Status chips are monochrome**, so a running step and a finished one look
  nearly identical in the step list.
- **Around ten inline `style=` attributes** in `index.html` with no system
  behind them.

## Decisions

1. **Evolve the existing language, do not replace it.** Midnight stays the
   default and the app stays recognisably itself. "Beautiful" is redefined as
   the concrete list above, which has an end.
2. **Settings is the sixth panel.** `06 Settings` beside the existing five, with
   its own section list. It reuses the numbered-nav idiom rather than inventing
   a third navigation concept.
3. **The logo is `][`** — two brackets facing inward, literally closing. Four
   strokes, legible at 16px, works as a pure silhouette.
4. **Nine themes**, selectable in Settings.
5. **Language marks are drawn, not bundled.** An extension chip in a per-language
   accent colour. Same call item 10 made for provider logos: no trademarked
   marks are reproduced and nothing is fetched or vendored.
6. **No motion is added.** Live animation was built, reviewed and rejected.
7. **Themes style CloseNI's own chrome and nothing else.**

## Design

### Themes style CloseNI only

**A project built in CloseNI gets whatever styling the model writes for it. The
app never injects a theme, a token, a stylesheet or a colour into generated
output.** This is a rule, not an oversight to be corrected later: someone will
eventually think it would be a nice touch to make generated web projects match
the user's theme, and it would be wrong. The user's theme is a preference about
*this application's chrome*. Their project's appearance belongs to their project.

The boundary is structural — theming lives entirely in `desktop/`, and nothing
under `local-agent/src/` reads or writes a theme — so honouring it costs nothing
and violating it would require deliberately reaching across.

### Tokens first

Every colour, space, radius and duration becomes a custom property on `:root`.
This is not tidying; it is the prerequisite. A theme can only reach as far as
the tokens do, and today a theme would restyle about half the app and leave the
diff view, log panes, status chips and modal untouched — which looks worse than
no theming at all.

Token groups:

- **Surface** — `--bg`, `--panel`, `--surface`, `--surface-sunken`, `--overlay`
- **Line** — `--line`, `--line-strong`, `--line-focus`
- **Text** — `--txt`, `--dim`, `--mut`, `--inverse`
- **State** — `--ok`, `--ok-bg`, `--ok-line`, and the same triples for `--warn`,
  `--err`, `--info`
- **Language accents** — `--lang-py`, `--lang-rs`, `--lang-js`, `--lang-java`,
  `--lang-c`, `--lang-go`, `--lang-default`
- **Space** — `--sp-1` … `--sp-6`
- **Radius** — `--r-sm`, `--r-md`, `--r-lg`
- **Elevation** — `--shadow-1`, `--shadow-2`
- **Motion** — `--dur-fast`, `--dur-slow`, `--ease`

**This is enforced by a test, not by discipline.** A unit test reads
`styles.css`, strips the `:root` and `[data-theme]` blocks, and fails if any
colour literal remains — hex, `rgb(`, `hsl(` or a named colour. Without it,
"themes reach the whole app" is an aspiration that decays with the next edit.
The test names the offending line, so the fix is obvious.

### The theme engine

A theme is one block of custom properties under a `[data-theme="…"]` selector.
Applying one is setting an attribute on `<html>`; there is no JavaScript
styling, no class toggling on individual elements, and no flash of the wrong
theme because the attribute is set from `localStorage` before first paint.

```
:root                        -> Midnight's values (the default)
[data-theme="paper"]         -> overrides
[data-theme="phosphor"]      -> overrides
…
```

The nine:

| id | Name | Character |
|---|---|---|
| `midnight` | Midnight | The current look, tidied. Default. |
| `paper` | Paper | Light mode |
| `phosphor` | Phosphor | Green CRT — square corners, static scanlines, glow |
| `amber` | Amber | The same CRT in amber |
| `cassette-indigo` | Cassette · Indigo | Violet ground, cyan and magenta |
| `cassette-miami` | Cassette · Miami | Hot pink and gold on plum |
| `cassette-grid` | Cassette · Grid | Electric blue on ink, no magenta |
| `blueprint` | Blueprint | Cyan on navy over a drafting grid |
| `contrast` | High contrast | No colour, glow or decoration |

CRT themes carry two extra tokens the others leave empty: `--overlay-texture`
(a `repeating-linear-gradient` of scanlines, or a grid for Blueprint) and
`--glow` (a `text-shadow` value). Both are applied by a single decorative
element and a single rule, so a theme without them simply has nothing happen.
`contrast` sets both to `none` deliberately rather than by omission.

**Decoration is static.** Scanlines, glow and bloom do not move. Live animation
— drift, sweep, bloom breathing, glow pulse, blinking caret — was built,
reviewed in the companion and rejected. The only animations in the application
remain the two that already exist and carry meaning: the progress bar filling
and a toast sliding in. Both stay behind `prefers-reduced-motion`.

### Settings, the sixth panel

`06 Settings` joins the nav. Its own left-hand section list, four sections:

- **Provider** — the picker, Sign in, and the per-provider controls that
  currently crowd the rail
- **Permissions** — the autonomy selector and Show Browser
- **Appearance** — theme swatches, and a toggle for CRT decoration on themes
  that have it
- **About** — version, the logo, and where the storage directory lives

The rail keeps only what belongs to *right now*: the workspace, the chat
session picker, and the nav itself. Everything moved to Settings keeps its
existing `localStorage` key and its existing behaviour; this is a relocation,
not a rewrite, and the provider-controls panel built in item 8 moves intact.

### The logo

An SVG mark of two inward-facing brackets, drawn on a 32×32 grid so it lands on
whole pixels at 16, 32 and 256. Monochrome, `currentColor`, so it inherits the
theme without needing a variant per theme.

It appears in the rail header beside the wordmark, in the About section, and —
for sub-project 8 — as `build/icon.svg`, from which the `.ico` and `.png` an
installer needs are generated. No raster asset is committed that cannot be
regenerated from the SVG.

### Language marks

`languageMark(path)` returns a label and a token name for a file path:
`src/main.rs` → `{ label: "rs", token: "--lang-rs" }`. Unknown extensions get
`--lang-default` rather than nothing, so the layout does not shift. It is a pure
function in a UMD-style module beside `diff.js` and `entrypoint.js`, which is
how the renderer's logic is made testable without a bundler.

Marks appear on file cards in the Builder and in the Test panel's result rows.

### Depth, not 3D

Item 19 asks for 3D. Literal 3D in a dev tool costs GPU and startup time and
fights a flat aesthetic. The intent — depth — is met with layered elevation and
a backdrop blur behind modals: two CSS properties, no GPU budget, no new
dependency. Recorded here because it is a deliberate reinterpretation of the
roadmap item rather than an omission.

### Focus and reduced motion

A `:focus-visible` ring on every interactive element, drawn with `box-shadow` in
two layers so it reads against any theme's background. `prefers-reduced-motion`
disables the progress-bar transition and the toast slide, and the Appearance
section can force it on independently of the OS setting.

## Testing

The repository's existing pattern applies: pure logic goes in UMD-style modules
and is unit-tested; appearance is checked by driving the app.

- **Token completeness** — the lint described above. The single most valuable
  test here, because it is what keeps every theme reaching the whole app.
- **Theme resolution** — `resolveTheme(saved, available)`: a saved theme that
  still exists wins; one that has been removed falls back to `midnight` rather
  than leaving the app unstyled; absent or corrupt storage yields the default.
- **Every theme defines every token** — for each `[data-theme]` block, assert it
  declares the full token set. A theme missing `--err-bg` would look correct
  until the day a build failed.
- **Language marks** — extension mapping, unknown extensions falling back,
  paths with no extension, uppercase extensions, dotfiles.
- **Settings persistence** — each moved control keeps its existing key, so the
  existing tests for the provider controls and autonomy policy must still pass
  untouched.
- **Logo geometry** — the SVG parses and its viewBox is 32×32, so icon
  generation in sub-project 8 has a known input.

## Non-goals

- **Theming generated projects.** Stated above as a rule.
- **Live animation.** Built, reviewed, rejected.
- **Literal 3D or WebGL.**
- **Reproducing language or provider brand logos.**
- **A custom title bar or window chrome.** Electron's default frame stays; that
  is a distribution concern if it is one at all.
- **Restyling the generated project preview.** The Builder shows file contents
  in the app's own type; making that a full syntax-highlighted editor is a
  different sub-project.
- **Per-panel layout changes** beyond moving controls into Settings. The Chat,
  Builder, Test, Research and Ship panels keep their current structure.

## Consequences

- **Nine themes means nine token blocks to maintain.** Every new token added
  later must be added nine times, or the completeness test fails. That test
  turns a silent visual bug into a build failure, which is the trade being
  made deliberately.
- **Paper is the expensive one.** Light mode forces every hardcoded colour into
  a token with a light counterpart, including the diff view and log panes. It is
  the reason the token work has to be thorough rather than partial.
- **Moving controls out of the rail changes muscle memory** for the one person
  currently using the app. The rail keeps workspace and chat session, which are
  the two touched most often mid-task.
- **The logo is a silhouette,** so it carries no colour identity. That is what
  makes it work at 16px and inside any of nine themes, but it means the brand is
  the wordmark plus a shape rather than a colour.
- This sub-project is large enough that the implementation plan will likely
  phase it: tokens and the theme engine first, since the settings page, language
  marks and state colours all depend on them.
