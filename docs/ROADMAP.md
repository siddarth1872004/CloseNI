# CloseNI Roadmap

28 items, grouped into 10 sub-projects — 9 from the original plan plus one added after using the app. **9 of 10 complete**; only 5 · GitHub & external tools remains. Each sub-project gets its own design spec
and implementation plan under `docs/superpowers/`, and is expected to leave the
application working on its own.

Two items from the original list were cut: replacing Electron with a native
toolkit, and using the discrete GPU when opening a project.

**Status vocabulary:** `todo` — not started. `partial` — real groundwork exists,
listed per item. `done` — finished and verified by tests.

---

## 1 · Conversation & context core — DONE

Roadmap items 1, 2, 3. Spec: `specs/2026-08-09-conversation-context-core-design.md`

Every step used to open a brand-new chat, so nothing carried between steps and
all context had to be rebuilt from disk each time.

| Phase | What it does | Status |
|---|---|---|
| 1 | All steps of one build share a chat thread | done — `plans/2026-08-09-build-thread-persistence.md` |
| 2 | Send only what the thread has not already seen | done — `plans/2026-08-09-delta-context.md` |
| 3 | One long-lived process per build; browser opens once | done — `plans/2026-08-09-build-session.md` |

- **1. Performance & session handling** — `done`. One Chromium launch per build
  instead of one per step, one provider-registry load, one login check.
- **2. Persistent conversations per project/session** — `done` within a build run.
  Threads deliberately do not span separate runs; that was the design decision.
- **3. Better prompts & parsing** — `done`. Prompts carry a delta rather than the
  whole project each step, and the structure is sent once.

**The intermittent empty-plan issue is resolved** — see the spec. It was
traced to concurrent end-to-end suites sharing one provider config file, not to
a race in the product; that collision was fixed in Phase 2. Plan mode ran 25/25
clean in isolation.

## 2 · Provider platform — DONE

Roadmap items 7, 8, 9, 10. Depends on nothing. Blocks sub-project 4.

- **7. GLM + Qwen Studio** — `done`. Both configured and listed. GLM's selectors
  are unverified against the live site, recorded in the file itself.
- **8. Model / tool / effort switching** — `done` —
  `plans/2026-08-10-provider-controls.md`. The owner captured all three live UIs,
  which is what this was blocked on. They differ in kind, not only in selector:
  DeepSeek reports its state in `aria-pressed`, Qwen's state is its trigger's
  visible text, GLM's is `data-selected` on options in a Radix portal. So each
  provider gets its own module and the selectors live in JSON. The user chooses
  in the sidebar and the agent applies on every conversation open, because these
  settings reset on a new chat.

  Two gaps, both recorded in the plan: GLM's Search menu is not wired (its
  trigger was never captured), and GLM's Deep Think on/off toggle is left alone
  deliberately, since it reports no readable state and blind-clicking it could
  switch off what is being configured.
- **9. First-run browser login onboarding** — `done`. A Sign in button opens a
  visible browser; a headless run with no chat input gives up in 15s instead of
  120s and names the fix.
- **10. Provider logos** — `done` as far as the control allows. The picker is a
  native `<select>`, whose options render text only, so providers are listed by
  name. A coloured mark would require replacing the control.

## 3 · Multi-language builds — DONE

Roadmap item 5. Spec: `specs/2026-08-10-multi-language-builds-design.md`,
plan: `plans/2026-08-10-multi-language-builds.md`

- **5. JS, Rust, C, C++, Java** — `done`. A manifest at the workspace root
  claims its language and yields one project-level check (`cargo check`,
  `make -n`, `mvn -q compile`, `gradle compileJava -q`); languages with no
  manifest are checked per file (`gcc -fsyntax-only`, `rustc --emit=metadata`,
  `javac`). Run Project handles Cargo, Makefiles and loose C/C++/Java files.

  Rust and Java could not be checked per file: a `.rs` file containing
  `mod utils;` fails alone even when the crate is perfect, and the model would
  have spent its self-heal retries fixing code that was never broken.

  A missing toolchain skips rather than fails, so a machine with Python but no
  Rust verifies nothing for Rust and says so in the log. Go and TypeScript are
  in the file walker but out of item 5's scope; each is a few lines in the
  planner.

  Fixed along the way: `runCommand` treated a timed-out command with no error
  output as a **success**, which is right for a model-suggested server and wrong
  for a syntax check. Checks now pass `timeoutIsFailure`.

## 4 · Concurrency & multi-agent — DONE

Roadmap item 4. Spec: `specs/2026-08-10-concurrency-design.md`,
plan: `plans/2026-08-10-concurrency.md`

- **4. Concurrent agents + inter-agent communication** — `done` for the
  concurrency half. Independent steps run at the same time in separate pages of
  one browser context.

  The blocker recorded here — that browser profiles are per provider — turned
  out to constrain two *browsers*, not two *conversations*. One context opens
  many pages, which is what a person with three tabs is doing, and it avoids the
  profile cloning sub-project 8 already refused.

  The real constraint was that later steps read earlier steps' files, which the
  plan never described. The model now declares `dependsOn`, because inferring it
  from file lists would fail steps whose code was correct.

  **Only conversations parallelise; applies are serialised.** That removes every
  shared-state race by construction, including the worst one: approval replies
  arrive on a single stdin queue with nothing saying which command they answer,
  so two concurrent prompts could hand one command's "allow" to another.

  Default 2, configurable. The realistic failure is a throttled provider
  account, not a crash — and a throttled session looks like a slow reply, which
  the completion detector will wait out. Conservative default, not cleverness.

  **Not done:** inter-agent communication in the sense of a reviewer agent on a
  second provider. It makes each step slower, which is the opposite of this
  sub-project's purpose, and deserves its own decision.

## 5 · GitHub & external tools — 3 of 5

Roadmap items 11-15. Spec: `specs/2026-08-10-github-design.md`,
plan: `plans/2026-08-10-github.md`

- **11. Repo search + integration into builds** — `done`. Results offer
  **Use as reference** (README and file tree into the plan prompt, workspace
  untouched) and **Clone** (licence shown first, into the workspace if empty and
  a named subdirectory otherwise).
- **12. In-app sign-in, repo access, push** — `done`. A pasted token encrypted
  with `safeStorage`; repository list, creation, and push through a
  `GIT_ASKPASS` helper.
- **13. MCP tool support** — `todo`. Needs no credentials.
- **14. GitHub Actions + external tooling** — `done` for Actions: recent runs
  with their state, and `workflow_dispatch`.
- **15. Skills, personas, GitHub skill-`md`** — `todo`. Needs no credentials.

**A live bug was fixed on the way.** The git IPC ran
`spawn("git", args, { shell: true })`, which concatenates arguments into a shell
string rather than passing them separately — so a commit message containing
`; rm -rf ~` would have run it. Now `shell: false`, with arguments type-checked
and every git log line redacted. Verified closed: that message now produces a
commit with it as the literal subject and executes nothing.

**Where the token must never go**, enforced rather than documented:
`.git/config`, a process argument list, a log line, a plaintext file, the
renderer, or the agent process.

**Unverified:** everything needing a real token. There is no GitHub credential
in the development environment, so sign-in, push, repository listing, cloning
and Actions have been built and compiled but never run against GitHub.

## 6 · Builder IDE experience — DONE

Roadmap items 16, 17, 18, 22. Benefits from sub-project 1 but is not blocked by it.

- **16. IDE-like diff view in Builder** — `done`. File cards show a line diff
  against the backup `applyPatch` already writes, with long unchanged runs
  collapsed.
- **17. Suggestion / fix chat after generation and after tests** — `done`. Any
  completed step can be revised through its build thread; changes do not cascade
  to later steps, and a missing thread is refused rather than guessed at.
- **18. Test/Run section complete** — `done`. The Test tab reports per-check
  pass/fail with a summary and shows command output in place; Run Project
  detects the entry point and runs it.
- **22. Permissions: auto-allow / review / ask** — `done`. Three modes in the
  sidebar, persisted, feeding both build call sites. An unrecognised value
  falls back to asking.

## 7 · Visual identity & polish — DONE

Roadmap items 19, 20, 21, 26, 27. Spec: `specs/2026-08-10-visual-identity-design.md`,
plan: `plans/2026-08-10-visual-identity.md`

- **19. UI refresh — 3D elements, transitions, animations** — `done`,
  reinterpreted twice and both times deliberately. 3D became layered elevation
  and a backdrop blur: literal 3D costs GPU and startup time and fights a flat
  terminal aesthetic. Live animation was built, reviewed in the visual companion
  and **rejected by the owner** — decoration is static, and the only animations
  left are the progress bar and the toast, both behind `prefers-reduced-motion`.
- **20. Programming-language logos** — `done` as drawn marks. The extension in a
  per-language accent colour; no trademarked asset is reproduced or vendored,
  matching the call item 10 made for provider logos.
- **21. Detailed settings page** — `done`. `06 Settings` with Provider,
  Permissions, Appearance and About. The provider controls, autonomy policy and
  Show Browser moved out of the rail keeping their ids and storage keys, so
  nothing was rewritten and their tests never changed.
- **26. Beautiful, detailed UI** — `done`, made finite. 47 colour literals became
  32 tokens; nine themes; focus rings where there were none at all;
  reduced-motion support; state carried by colour instead of four identical grey
  chips; six duplicated rules and 14 inline styles removed.
- **27. Logo** — `done`. Two inward-facing brackets — closing. One 32×32 SVG in
  `currentColor`, serving the rail, the About section and, for sub-project 8,
  the installer icon.

**Themes: Midnight, Paper, Phosphor, Amber, Cassette · Indigo, Cassette · Miami,
Cassette · Grid, Blueprint, High contrast.** They style CloseNI's own chrome and
never the projects built with it.

Token completeness is enforced by a lint that fails on any colour literal
outside a theme block, because a theme reaches exactly as far as the tokens do
and a single stray hex fails silently. A second check ties each theme's
decoration flag to whether its CSS actually declares a texture — it caught
Blueprint being flagged as undecorated while declaring a grid, which would have
shipped a toggle that did nothing.

## 8 · Distribution — DONE

Roadmap item 28. Spec: `specs/2026-08-10-distribution-design.md`,
plan: `plans/2026-08-10-distribution.md`

- **28. Releases page, Windows + Linux packages** — `done`. electron-builder
  produces an NSIS `.exe`, an AppImage and a `.deb`; GitHub Actions builds all
  three on a `v*` tag and attaches them to a Release.

  The packaging config was the small part. Three defects blocked it and were
  fixed first: the app wrote state into its own install directory (on Windows,
  `Program Files` — it would have failed to save a session at all), it spawned
  `node` and cannot assume Node exists on a user's machine, and Playwright's
  Chromium is 389MB. State now lives in `userData`, the agent runs on Electron's
  own binary via `ELECTRON_RUN_AS_NODE`, and the browser is fetched on first run
  behind a gate rather than shipped.

  `local-agent/storage/` holds live session cookies, and `.gitignore` does not
  constrain electron-builder, so the `files` config is an explicit allow-list.
  It is checked twice — against the config, and against the actual packed output
  — because a forgotten exclusion publishes authenticated sessions to a public
  release, while a forgotten inclusion just fails loudly on first launch.

  Not done, deliberately: code signing (needs a paid certificate), macOS (no Mac
  to test on), and auto-update (untrustworthy while unsigned).

  **Unverified:** no installer has been launched. The development environment
  has no Windows machine and no way to run an AppImage. The tests prove the
  configuration is coherent, not that the installer works.

## 10 · Run & test experience — DONE

Not in the original 28. Added after using the app: a built project gave no
indication of how to run it. Spec: `specs/2026-08-10-run-and-test-flow-design.md`,
plan: `plans/2026-08-10-run-and-test-flow.md`

- **Run manifest** — `closeni.run.json` plus `run.sh`/`run.bat`, written by the
  app from the command the model declares while planning. The app writes it
  rather than the model, because a model that forgets is a failure mode this
  project has already hit. An edited command is never overwritten.
- **Test panel** — a run bar showing the command and where it came from
  (`SAVED` / `FROM YOUR PLAN` / `DETECTED` / `NOT FOUND`), output with history,
  and a chat beside it.
- **Ask about this run** — carries the last command and its output into the
  build thread automatically, and can apply fixes through the existing patch
  pipeline. **A prose answer is now a success**; previously a reply with no file
  changes was reported as an error and displayed nothing, which is the common
  case for a question.
- **Plan length follows the work** — `"Rules: 3-8 steps"` was hardcoded in two
  places and silently compressed larger projects into eight. Now guidance,
  bounded at 40, which **rejects rather than truncates**: truncating drops the
  end of a project while looking like it worked. The plan shows an estimated
  duration, because each step is a browser round-trip.
- **Code quality directives** in the build prompt — error handling, docstrings,
  efficiency, and dependency files kept in step with imports. Placed last and
  kept to four lines; the e2e suite was the gate and passed unchanged.
- **Frontend preview** in a `<webview>` with its own partition and node
  integration off, because it renders AI-written code and the default partition
  holds live provider session cookies.
- **Pixel motion on events only** — `steps()` timing on step completion, failure
  and progress. Nothing animates on an idle screen; ambient motion stays
  rejected.

## 9 · Housekeeping — DONE

Roadmap items 23, 24, 25.

- **23. Emoji cleanup** — `done`. The two lines in
  `local-agent/src/providers/provider-registry.ts` were the only emoji in the
  project's own source; everything else lives in third-party `node_modules`.
- **24. Junk & redundant files** — `done`. 16 legacy scripts archived to
  `scripts/legacy/`; `__pycache__`, backups, stale compiled duplicates and a
  stray Flask app git-ignored; **46 empty files deleted** — 37 `.ts` stubs
  across `local-agent/src` and `vscode-extension/src`, 8 dead sample fixtures,
  and an unreferenced `config/safety.json`. The three `.gitkeep` files stay:
  they are what keep `storage/runs`, `storage/backups` and
  `storage/browser-profiles` in the repository.
- **25. QoL across all features** — `done` for this sub-project's scope. QoL
  belonging to a specific feature is tracked with that feature.

Verified with a clean build after the deletions.

---

## Dependency order

```
9 Housekeeping ──── independent, do any time
3 Multi-language ── independent
7 Visual ────────── independent ──> 8 Distribution
6 Builder UX ────── independent (better after 1)
5 GitHub/tools ──── independent (needs an auth story first)

1 Conversation ──┐
2 Providers ─────┴──> 4 Concurrency
```

Only sub-project 4 has hard prerequisites. Everything else can be picked up in any
order, which means the sequence is a question of what is worth having soonest
rather than what is possible.

---

## Not on the list

Work already completed that no roadmap item covers, but which the items above
depend on:

- Four bugs fixed: `python` vs `python3` in syntax checks and model-suggested
  commands (was failing every Python step); response-detection hanging for the
  full timeout on short replies; context ranking that omitted the module a step
  had to import from; dead IPC handlers behind the New Chat button.
- Test suite from nothing to 246 tests (118 unit + 128 end-to-end) — unit coverage
  plus a suite that drives the real CLI and a real browser against a mock chat
  provider.
- Two bugs found by reading code rather than by a failing test, both invisible to
  the suite: build-session commands sharing stdin with the approval flow, which
  would have denied every terminal command; and approval replies written to the
  per-step process, which a session is not.
- WSL environment made reproducible (`scripts/wsl-env.sh`).
- Repository published to GitHub.
