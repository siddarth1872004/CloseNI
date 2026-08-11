# Handoff brief

Copy the block below into Antigravity as the opening message.

---

You are picking up **CloseNI**, an Electron desktop app that drives free web-based
AI chat sites (DeepSeek, Qwen Studio, GLM) through Playwright and turns them into
a software build pipeline. No API keys — it signs into a provider in a real
browser, sends prompts, reads replies out of the DOM, parses them into file
changes, applies them to a workspace, and syntax-checks the result.

## Shape of the code

Two processes with one contract:

- `desktop/` — Electron. `main.js` (IPC, git, GitHub token, spawns the agent),
  `renderer.js` (panels), `builder.js` (step scheduler). **No bundler**, so
  shared renderer logic lives in UMD-style modules (`window.X` in the browser,
  `module.exports` under Node) — that is how they are unit-tested.
- `local-agent/` — TypeScript compiled to CommonJS in `local-agent/dist/`. A CLI
  you can run by hand: `node local-agent/dist/index.js plan "..." /path deepseek`.
  Modes: `chat`, `plan`, `revise`, `browser` (one step), `build-session`,
  `suggest`, `ask`, `testall`, `research`, `signin`.

Build with `npm run build`. On WSL you must `source scripts/wsl-env.sh` first —
a Windows Node on `/mnt/c` cannot run from a `\\wsl.localhost\...` path.

## State

- **128 commits, all on `main`.** The most recent commit is not yet pushed
  anywhere; the repository is being recreated.
- **536 unit tests + 155 end-to-end tests, all passing.**
  `node local-agent/test/run-tests.cjs` and `node local-agent/test/run-e2e.cjs`
  (the e2e suite takes about 15 minutes and drives a real Chromium against a
  mock chat server; only the model's answers are faked).
- **26 of 28 roadmap items done.** See `docs/ROADMAP.md`.
- Every sub-project has a design spec and an implementation plan in
  `docs/superpowers/` — 12 specs, 13 plans — including decisions that were
  rejected and why. Read the relevant one before changing an area.

## Rules that must not be broken

These are enforced by tests or exist for a reason that is not obvious:

1. **`local-agent/storage/` and `<userData>/browser-profiles/` hold live session
   cookies.** They are git-ignored, and the electron-builder `files` config is an
   allow-list so they cannot reach a release. Never widen it to a glob.
2. **The GitHub token never touches** `.git/config`, a process argument list, a
   log line, a plaintext file, the renderer, or the agent process. Pushing goes
   through a `GIT_ASKPASS` helper that reads it from its environment.
3. **git runs with `shell: false`.** With `shell: true` Node concatenates
   arguments into a shell string, so a commit message containing `; rm -rf ~`
   executes. A test asserts this never regresses.
4. **`styles.css` must contain no colour literal outside a `:root` or
   `[data-theme]` block.** A lint fails the build otherwise, because a hardcoded
   colour is one a theme can never reach.
5. **Only conversations parallelise.** Applying files, syntax checks and command
   approval all happen behind one lock — approval replies arrive on a single
   stdin queue with nothing saying which command they answer.
6. **Some commands always prompt** regardless of the autonomy setting: `sudo`,
   package managers, `rm -rf`, `dd`, `chmod 777`, and anything piping a download
   into an interpreter.
7. **`closeni.run.json`, `run.sh` and `run.bat` are generated.** They are
   stripped from any patch, because the model saw them in the workspace and
   started maintaining them.

## What is NOT verified — read this before trusting anything

The tests prove the logic. They do not prove the app works, because this
development environment has no GitHub token, no Windows machine, and no compiler
toolchains.

- **No installer has ever been launched.** `.exe`, AppImage and `.deb` are
  produced by `.github/workflows/release.yml` on a `v*` tag. Never run.
- **No GitHub request has ever been made.** Sign-in, push, repo listing, clone
  and Actions are written from the documented endpoints and unit-tested with an
  injected transport. Zero real calls.
- **Only DeepSeek has been driven end to end.** Qwen's controls were written from
  screenshots. **GLM's chat selectors have never been checked against the live
  site** — if it hangs or sends nothing, fix `chatInput`/`sendButton` in
  `local-agent/config/providers/glm.json` first; it is a text edit.
- **DeepSeek's own `sendButton` selector misses** (it falls back to pressing
  Enter, which works) and its Deep thinking / Smart Search toggles report
  not-found. Re-capture with
  `node scripts/capture-provider-ui.mjs deepseek`.
- **Go, TypeScript, Ruby, PHP, C# and shell checks were added but never run** —
  none of those toolchains exist here, so they skip.
- **The UI has barely been looked at.** Nine themes, the Test panel, the
  frontend preview and the pixel motion have never been seen by a person.
- **Recent bug fixes are unverified**: build resume after a failure, New Chat
  clearing the transcript, the command safety floor, and environment-setup
  failures no longer failing a step.

`docs/NEXT-SESSION.md` has an ordered plan for working through all of this.

## What is left on the roadmap

Two items, both credential-free, spec written at
`docs/superpowers/specs/2026-08-10-skills-and-mcp-design.md`, no code:

- **Item 15 — skills and personas.** Markdown files in the user's data directory
  that shape build prompts, importable from GitHub. The more valuable of the two:
  it turns "write better code" into editable files instead of four lines
  hardcoded in `buildPrompt`.
- **Item 13 — MCP tool support**, as a context provider that runs before a build.
  Not an agentic loop: the model drives a chat window, so a tool call costs a
  full browser round-trip of 60–90 seconds.

## Immediate task

Create the new repository and push `main` to it. Then, in this order:

1. Tag `v1.0.0` and let CI build the installers (about ten minutes — start it
   first and do other work while it runs).
2. Enable GitHub Pages: **Settings → Pages → `main` / `/docs`**. The landing page
   is already at `docs/index.html`.
3. Work through `docs/NEXT-SESSION.md`.

Do not add `Co-Authored-By` trailers to commits. The history was deliberately
cleaned of them and the author must remain Siddarth alone.
