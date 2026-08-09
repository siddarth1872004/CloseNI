# Test/Run section and permission policy — design

Date: 2026-08-09
Roadmap items: 18 (Test/Run section complete), 22 (permissions: auto-allow / review / ask)
Sub-project: 6 · Builder IDE experience — the remaining half
Status: agreed in brainstorming. Mode set and Test/Run scope chosen by the
project owner; implementation decisions are the author's.

## Problem

**Test/Run has nowhere to put its results.** The Test tab offers a
"Syntax-check all files" button and a custom command box, and both send their
output to the Agent and Project log panes shared by every tab. A syntax check
across forty files scrolls past mixed in with build chatter, and the only
summary is a count buried in the same stream. There is also no way to simply run
the thing that was just built — you must remember and type the command.

**Permissions are hardcoded.** `builder.js` passes the literal `"ask"` in two
places, so every terminal command a build wants to run opens a modal and waits.
A seven-step build with checks in each step interrupts constantly, and there is
no way to say "just run it" or "never run anything".

## Decisions

1. **Three permission modes:** `ask` (today's modal, the default), `auto`
   (run without prompting), `never` (skip commands entirely — files are still
   written and syntax checked, nothing executes).
2. **The Test tab gets its own results area.** Per-check pass/fail with a
   summary line, and command output shown in place rather than in the shared log.
3. **A Run Project button** detects the entry point and runs it.

## Design

### Permission policy

A `<select>` in the sidebar beside the provider picker, persisted to
`localStorage` so it survives a restart. `CN.getAutonomy()` returns the current
value; `builder.js` uses it at both call sites instead of the hardcoded string.

The agent currently treats `"auto"` as run-everything and anything else as
prompt, so `never` needs a change. The decision becomes a pure function:

```
decideApproval(autonomy) -> "allow" | "deny" | "ask"
```

`askApproval` calls it and only reaches stdin in the `"ask"` case. Pulling the
decision out of the stdin-reading function is what makes it testable at all.

A denied-by-policy command logs `COMMAND_DENIED` exactly as a user denial does,
so the build's self-heal path treats both identically — a command that did not
run is not a command that failed.

### Test results

`testAllMode` emits counts only. It gains `results: { command, success }[]` so
the renderer can render per-check rows rather than scraping log lines. The
existing `passed` and `failed` counts stay, because the end-to-end suite asserts
on them.

The Test panel gains a results area rendering one row per check with its command
and outcome, a summary line, and the output of any custom or project command.
Output still streams to the Project log — that is not removed, only supplemented.

### Entry point detection

A pure function in `desktop/entrypoint.js`, exposed both as `window.CNEntry` and
as `module.exports`, following `desktop/diff.js` — the desktop has no bundler,
but detection logic with this many branches needs unit tests.

```
detectEntrypoint(paths: string[], packageJson: object | null) -> string | null
```

Precedence, first match wins:

1. `package.json` with `scripts.start` → `npm start`
2. `package.json` with `main` → `node <main>`
3. `main.py` → `<python> main.py`
4. `src/main.py` → `<python> src/main.py`
5. `app.py` → `<python> app.py`
6. `index.js` → `node index.js`
7. `src/index.js` → `node src/index.js`
8. otherwise `null`

`<python>` is `python3`, matching the interpreter resolution the agent already
does for syntax checks — `python` alone does not exist on most Linux and macOS
installs, and that assumption already cost a whole build once.

Returning `null` is a real outcome, not a failure: the button reports that it
could not find an entry point rather than guessing and running something
arbitrary.

## Non-goals

- Remembering per-command approvals. A global policy first; an allow-list is a
  separate feature with its own storage and clearing story.
- A test runner. "Run project" runs the entry point; it does not discover or run
  a test suite.
- Reworking the Ship tab. Git remains as it is.
- Removing the shared log panes.

## Testing

- Unit: `decideApproval` for all three modes and an unknown value; and
  `detectEntrypoint` across every precedence branch, including the `null` case
  and a `package.json` that exists but has neither `scripts.start` nor `main`.
- End-to-end: `testall` reports a `results` array whose entries match the counts;
  a build with `never` skips its commands and still succeeds; a build with
  `auto` runs them without prompting.
- The Test tab's rendering is not covered by the suite and is checked by driving
  the app.

## Consequences

- `never` mode means a build's commands never run, so the model's own
  verification step is skipped. Syntax checks still run — they are not
  model-suggested commands — so a build is not left unverified, only less
  verified.
- Persisting the policy in `localStorage` means it is per-machine and invisible
  to the agent, which continues to receive it as an argument.
