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

- **1202 unit tests + 180 end-to-end tests, all passing.** Two e2e cases open
  a visible browser, so on a machine with no display run the suite under
  `xvfb-run`.
  `node local-agent/test/run-tests.cjs` and `node local-agent/test/run-e2e.cjs`
  (the e2e suite takes about 15 minutes and drives a real Chromium against a
  mock chat server; only the model's answers are faked).
- **All 28 roadmap items done.** See `docs/ROADMAP.md`. What remains is
  verification that needs an account, a token or a Windows machine.
- **`npm run verify` passes all 173 checks** including the packaged-artifact
  audit, and **`npm run languages`** runs every language check against the real
  compiler (see below).
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
- **C# is the one language check never run** - no .NET on any machine it has
  been tried on. The other eleven ran on 24 September against a working and a
  broken sample each (`npm run languages`), which found Go had been silently
  skipped everywhere (the probe used `go --version`) and Java in packages
  failing on correct code. Both fixed.
- **The UI has barely been looked at.** Nine themes, the Test panel, the
  frontend preview and the pixel motion have never been seen by a person.
  The Linux build has been packed and launched headless under Xvfb: the
  window loads, the agent spawns on Electron's binary, the browser gate and
  the getting-started guide appear on a clean profile. The browser download
  itself could not be completed there (the network blocked the CDN), which
  is how the gate's "Download failed (exit 1)" was found to hide the reason.
- **Recent bug fixes are unverified**: build resume after a failure, New Chat
  clearing the transcript, the command safety floor, and environment-setup
  failures no longer failing a step.

`docs/NEXT-SESSION.md` has an ordered plan for working through all of this.

## What is left on the roadmap

Nothing. Items 13 (MCP, as a context provider run once before a build) and 15
(skills and personas as Markdown files) were the last two and are done - see
`docs/superpowers/plans/2026-08-11-skills-and-mcp.md`. First-run onboarding,
the one piece of `NEXT-SESSION.md` that needed no account, is done too.

## Immediate task

Create the new repository and push `main` to it. Then, in this order:

1. Tag `v1.0.0` and let CI build the installers (about ten minutes — start it
   first and do other work while it runs).
2. Enable GitHub Pages: **Settings → Pages → `main` / `/docs`**. The landing page
   is already at `docs/index.html`.
3. Work through `docs/NEXT-SESSION.md`.

Do not add `Co-Authored-By` trailers to commits. The history was deliberately
cleaned of them and the author must remain Siddarth alone.
