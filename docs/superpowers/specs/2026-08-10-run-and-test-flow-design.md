# Run & test flow — design

Date: 2026-08-10
Sub-project: 10 · Run & test experience (not in the original 28; requested after
using the app)
Status: agreed in brainstorming, with the Test panel reviewed in the visual
companion. The run-file shape, the chat's power, the animation style and the
code-quality emphases were all chosen by the project owner.

## Problem

The owner built a project and could not work out what to run. The panel said
**"no entry point found — try a custom command"** and offered an empty box.

That message is the visible end of four separate failures.

**The app throws the answer away.** Every build step may return a `commands`
array, and the model that designed the project knows how to start it. Nothing
retains either. `detectEntrypoint` then guesses from filenames — `main.py`,
`index.js`, `Cargo.toml` and a handful more. A project at `src/app/server.py`
matches nothing, so the app gives up on a question it already had the answer to.

**Nothing on disk describes the project.** Even a correct guess lives only in
the session that made it. Re-open the workspace tomorrow and the app is guessing
again.

**The Test panel is two button rows and a line of text.** It is the one panel
sub-project 7 did not restructure. When a run fails, the output is a wall of
traceback with nothing to do about it but read.

**The plan is capped at eight steps.** `"Rules: 3-8 steps"` is hardcoded in
`planMode` and again in `revisePlanMode`. Any project larger than eight steps of
work gets silently compressed into eight, which produces steps that each touch
too much.

Separately, the build prompt asks for **no code quality at all** — it specifies
JSON formatting and file separation, and nothing about error handling,
documentation, efficiency or runnability.

## Decisions

1. **The project carries its own run instructions**, as a file on disk.
2. **The app writes that file, not the model.** The model declares the command;
   the app persists it. A model that forgets is a failure mode this project has
   hit before.
3. **The Test chat can apply fixes**, through the existing patch pipeline.
4. **Step count follows the work**, with a sanity bound and a visible time
   estimate.
5. **Motion is event-driven only.** Ambient animation was built, reviewed and
   rejected earlier; that decision stands.
6. **The frontend preview is sandboxed.** It renders AI-generated code.

---

## Phase 1 — Prompts

### Step count follows the work

`"Rules: 3-8 steps"` becomes guidance rather than a cap:

> As many steps as the work genuinely needs. A one-file script might be two
> steps; a full application with a database, API and UI might be twenty or more.
> Never pad, never compress. Each step must touch a different set of files.

**A bound stays, for a different reason.** A malformed or runaway reply
proposing 500 steps must not start a build that would take a day. `parsePlanRobust`
rejects a plan with more than 40 steps as unparseable rather than truncating it —
truncating would silently drop the end of the project, which is worse than
asking the model again.

**Cost becomes visible.** Each step is a browser round-trip of a minute or two,
so a twenty-step plan is a long build. The plan sidebar shows an estimate
(`~20 steps · roughly 30-40 min`) before the Build button. The owner should be
able to see what they are agreeing to.

### Quality directives

A short block **after** the JSON rules, not woven through them:

```
CODE QUALITY:
- Handle errors and validate input. Do not write happy-path-only code.
- Docstrings on public functions. Comments explain why, not what.
- Avoid needless passes, quadratic loops over large inputs, and repeated I/O.
- The project must be runnable: keep requirements.txt / package.json in step
  with what the code actually imports.
```

**Placement is deliberate and is the risk in this phase.** The build prompt is
terse and rule-heavy because this project has already been burned by replies the
parser could not read. More prose means more chance the model explains itself
outside the code fence. The block goes last, stays four lines, and the e2e
parsing tests are the gate: if they wobble, the block shrinks.

### The plan declares how to run the project

The plan JSON gains one optional field:

```json
{ "summary": "...", "runCommand": "python3 src/app/server.py", "steps": [...] }
```

Optional, because an older plan or a hand-written one will not have it, and
`parsePlanRobust` must keep accepting those.

---

## Phase 2 — The run manifest

### What lands in the workspace

```
closeni.run.json     the app reads this
run.sh / run.bat     generated from it, so the project works outside CloseNI
```

```json
{
  "version": 1,
  "run": "python3 src/app/server.py",
  "install": "pip install -r requirements.txt",
  "language": "python",
  "userEdited": false,
  "generatedBy": "CloseNI 1.0.0"
}
```

### Who writes it, and when

**The app**, at the end of a build, from the plan's `runCommand` — falling back
to filename detection when there is none. The model is asked to declare the
command because it knows the project; the app persists it because the app does
not forget.

**An edited command is never overwritten.** The command box in the Test panel
writes the manifest and sets `userEdited: true`. Later builds then leave `run`
alone and update only the rest. Without that flag, a user correcting a wrong
command would watch the next build undo the correction, which is the kind of bug
that makes people stop trusting a tool.

`run.sh` is written with the executable bit; `run.bat` alongside it for Windows.
Both are regenerated whenever the manifest is written.

### Resolution order

A pure function, because this is the logic that produced the original complaint:

```typescript
resolveRun(manifest, planRunCommand, detected)
  -> { command: string | null; source: "manifest" | "plan" | "detected" | "none" }
```

Manifest wins, then the plan, then detection. **The source is returned, not just
the command**, because the panel says where the answer came from — "from your
plan" and "detected from main.py" are different levels of confidence and the
user deserves to know which they have.

---

## Phase 3 — The Test panel

Three regions, matching the two-column idiom the other panels already use:

**A run bar.** The command, the source badge, a Run button, and a Syntax-check
action. The command is editable and edits persist to the manifest.

**Output, on the left.** The current run's result with its pass/fail state
colour, its output, and a short history beneath — so a syntax check does not
vanish the moment something else runs.

**Chat, on the right.** Titled *Ask about this run*.

### The chat

**It carries the run with it.** The last command and its output travel with the
question automatically. Nobody should have to paste a traceback into a box
sitting directly beneath that same traceback.

**It reuses the build thread.** The provider already holds the conversation in
which it wrote this project. A fresh chat would answer confidently with none of
it in view — the same reasoning `suggestMode` already uses, where a failed
resume is a refusal rather than a fallback.

**Answers can become changes.** A reply proposing file edits goes through
`runBuildStep`: same parser, same syntax checks, same permission policy, same
backups. Nothing new is invented for applying a fix.

**An answer with no changes is still an answer.** This is the case the current
code has no path for. Most questions — "why did this fail?", "what does this
error mean?" — have no file change, and today a prose reply parses to zero
changes and displays nothing. The new mode returns the reply text alongside any
changes, and the panel shows it.

---

## Phase 4 — Frontend preview

A **Preview** toggle in the Builder toolbar, for projects that have something to
show.

**What it points at**, in order:
1. A URL scraped from the running command's output — a server printing
   `http://127.0.0.1:5000` is the common case, and the output already streams
   through `run-command`.
2. An `index.html` in the workspace, loaded over `file://`.
3. Nothing, and the toggle is hidden rather than showing an empty frame.

### Sandboxing

**This renders code an AI wrote, inside the application.** It goes in a
`<webview>` with `nodeintegration` disabled, `contextIsolation` on, and its own
`partition`, so a generated page cannot reach Electron APIs, the preload bridge,
or the session cookies belonging to the user's provider logins in the default
partition.

That last point is the one that matters: those cookies are the user's live
DeepSeek, Qwen and GLM sessions. A generated page sharing a session with them
would be a genuine vulnerability, and a separate partition is what prevents it.

---

## Phase 5 — Pixel motion

Blocky, event-driven motion. **Nothing animates while the app is idle** — the
ambient CRT motion built earlier was reviewed and rejected, and this does not
reintroduce it.

What moves, and only when it happens:

| Event | Motion |
|---|---|
| A build step finishes | A pixel tick stamps in over 4 frames |
| A test passes or fails | The state chip flickers twice, then settles |
| The agent is waiting on a reply | A blocky spinner, `steps(8)` |
| A download or build progresses | The bar advances in chunks, not smoothly |

**`steps()` timing is what makes it pixel rather than smooth** — a linear
transition reads as modern UI, a stepped one reads as a sprite. That is the
whole technique.

Every one of these sits behind `prefers-reduced-motion` and the existing
`data-decor="off"` toggle, so the accessibility fallback and the user's own
switch both still turn everything off.

---

## Testing

Pure logic, unit-tested, is where the value is:

- **`resolveRun`** — manifest wins over plan wins over detection; `source` is
  reported correctly; all three absent yields `none` rather than a broken
  command; a manifest with an empty `run` falls through instead of returning "".
- **Manifest round-trip** — written then read yields the same command;
  `userEdited: true` survives a rebuild; a corrupt manifest is ignored rather
  than crashing the panel.
- **Script generation** — `run.sh` has a shebang and the command; `run.bat` has
  the command; a command containing quotes is not mangled.
- **Step bound** — a plan with 40 steps parses; 41 is rejected as unparseable
  rather than truncated; a plan with no `runCommand` still parses.
- **Duration estimate** — steps to a human string, and it scales.
- **Preview target** — a URL is scraped from realistic server output (Flask,
  Vite, `http.server`); an `index.html` is used when there is no URL; neither
  present yields nothing rather than a blank frame.

End-to-end, the existing mock provider covers the parsing risk in Phase 1: the
plan and build prompts change, and the suite already asserts that plans and edit
plans parse. That suite passing is the gate on the quality block.

**Not testable here:** the panel's appearance, the webview's behaviour, and
whether the motion reads as pixel-art rather than broken. Those need the app
run by a person.

## Non-goals

- **Running the preview's build tooling.** If a project needs `npm run dev`, the
  user runs it; the preview points at the result. Managing dev servers is a
  different feature.
- **A full terminal.** The Test panel runs commands and shows output; it is not
  an interactive shell.
- **Editing files in the Test panel.** Fixes come from the chat, through the
  existing pipeline.
- **Motion anywhere it does not mark an event.** No ambient effects.
- **Reproducing the manifest format anywhere else.** It describes how to run one
  project; it is not a build system.

## Consequences

- **Two files land in every built project.** `closeni.run.json` and a `run`
  script are files the user did not ask for. They are small, self-describing,
  and make the project runnable without this app — but they are clutter in a
  directory the user may commit to their own repository.
- **Longer plans mean much longer builds.** Removing the eight-step cap means a
  large project can plan twenty or thirty steps, each a browser round-trip. The
  estimate exists so this is a choice rather than a surprise.
- **The quality block may cost parse reliability.** It is four lines against a
  prompt that has been carefully kept terse. The e2e suite is the gate, and the
  fallback is to shrink it.
- **The preview widens the attack surface.** A `<webview>` rendering generated
  code is new exposure that did not exist before. Partition isolation and
  disabled node integration are the mitigations, not a guarantee.
