# CloseNI

Electron desktop app that drives a web-based AI chat (DeepSeek by default) through
Playwright to plan and build software projects.

```
desktop/       Electron app (main process, preload bridge, renderer, builder UI)
local-agent/   Node backend: browser control, response parsing, patch application
shared/        Types shared between the two
scripts/legacy/ One-shot patch scripts from earlier development — do not run
```

## Installing a release

Download the installer for your platform from the Releases page. Windows gets an
`.exe`; Linux gets an AppImage and a `.deb`.

**Builds are unsigned.** Windows SmartScreen will warn on first run — code
signing needs a paid certificate. Choose "More info" then "Run anyway", or build
it yourself with `npm run dist`.

**First launch downloads a browser.** CloseNI drives real browsers to talk to AI
providers and needs its own Chromium, about 389MB. It downloads once, is kept in
your user data directory, and survives reinstalling. This needs a network
connection; there is no offline install.

Settings, sessions and browser profiles live in your user data directory
(`%APPDATA%/CloseNI` on Windows, `~/.config/CloseNI` on Linux), never beside the
application — a packaged app cannot write to its own install directory.

## Setup

```bash
npm install
npm run build                  # builds shared/ then local-agent/
npx playwright install chromium
cd desktop && npm start
```

## The run file

Every project CloseNI builds gets a `closeni.run.json` describing how to start
it, plus `run.sh` and `run.bat` generated from it. The app writes them at the end
of a build, from the command the model declared while planning.

Open the project again — tomorrow, or on another machine — and the Test panel
already knows what to run. Edit the command in the panel and it is saved back;
later builds will not overwrite an edited command.

## GitHub

Ship → GitHub. Create a token with `repo` and `workflow` scopes — the button
opens GitHub's page with those pre-selected — and paste it once.

The token is encrypted with your operating system's key (Keychain, DPAPI or
libsecret) and stored in your user data directory. **If your system offers no
secure storage, it is kept in memory only** and must be re-entered each launch;
it is never written in plaintext.

It never enters `.git/config`, a command line, or a log. Pushing authenticates
through a `GIT_ASKPASS` helper that reads it from the environment. Signing out
deletes it.

Search results in Research gain two actions. **Use as reference** feeds the
repository's README and file layout into your next plan without touching your
workspace. **Clone** copies it in, after showing you its licence.

## Parallel steps

A plan declares which steps depend on which, so steps that need nothing from
each other run at the same time in separate browser tabs. Set how many in
Settings → Permissions; the default is 2.

Only the conversations run in parallel. Applying files, syntax checks and
command approvals happen one at a time, so two steps can never interleave writes
to your workspace.

**More is not always better.** Each parallel step is another conversation with
your provider, and providers rate-limit. If builds start hanging, lower it.

## Cutting a release

```bash
git tag v1.0.0
git push --tags
```

GitHub Actions builds the Windows installer on a Windows runner and the Linux
packages on Ubuntu, then attaches all three to a Release for the tag. Build
locally with `npm run dist` (current platform only) or `npm run pack` for an
unpacked directory.

The mark in `build/icon.svg` is the source of truth for the app icon;
`build/icon.png` is generated from it by `node scripts/make-icon.mjs` and
committed, so a build never needs a browser.

### On WSL

```bash
source scripts/wsl-env.sh      # then the commands above work as written
```

WSL needs three things the script handles: a Linux node ahead of the Windows one
on `PATH` (a Windows node cannot run from a `\\wsl.localhost\...` path), the
chromium/electron system libraries, and `ELECTRON_RUN_AS_NODE` unset. See the
Notes section for the underlying details.

`npm run build` must be run before starting the desktop app: it spawns
`local-agent/dist/index.js`, which does not exist until the build runs.

## Tests

```bash
npm run build
cd local-agent
npm test        # unit: parsing, JSON repair, patching, browser extraction
npm run test:e2e   # end-to-end: every agent mode against a mock provider
npm run test:all   # both
```

`npm test` covers response parsing, JSON repair, patch application (including
workspace containment) and browser text extraction against a local fixture page.

`npm run test:e2e` runs the real CLI end to end — Playwright drives a real browser,
replies are extracted from the DOM, parsed, applied to a scratch workspace and
syntax checked. Only the model's answers are faked, by `test/mock-provider.cjs`:
a local server that serves a chat-shaped page and returns whatever the test
queued. It covers plan/revise/build/chat/testall, the re-ask path, the self-heal
retry loop, command approval and denial, oversized-argument spilling, headed mode,
and a full plan → multi-step build → execute-the-result run.

Both suites skip the browser sections cleanly if Playwright's chromium is missing.

To point the agent at a different set of provider configs (the e2e suite does this
to avoid touching the shipped ones), set `AGENT_PROVIDER_DIR`.

## How a build step runs

1. The renderer sends `run-agent` over IPC with the step arguments.
2. For a build, `desktop/main.js` starts **one** `local-agent` process in
   `build-session` mode and feeds it steps over stdin, so the browser opens once
   per build rather than once per step. If the session cannot start, the builder
   logs why and falls back to spawning `local-agent/dist/index.js` per step,
   which is what the one-shot modes always do. Arguments longer than 8000 chars
   are spilled to a temp file and the path passed instead; the agent reads those
   back (`resolveArg`).

   Session commands share the stdin the approval flow reads, so both go through
   one `readline` interface in the agent and are dispatched by content. A second
   reader would queue every step command as a pending approval answer, and the
   next `askApproval` would parse one, find no `approved` field, and deny the
   command.

   Pause, skip and stop remain between-step operations owned by `builder.js`;
   the session does not change them.
3. Step 0 of a build opens a **fresh** chat thread and records its URL in
   `sessions.json` as `activeBuildThread`; every later step of the same build
   resumes that thread, so a step can see what earlier steps said. The prompt
   still carries the project tree plus signatures of the most relevant existing
   files. One-shot modes (chat, plan, revise, research, testall) keep opening a
   fresh chat each time.

   From step 2 onward the prompt carries only a delta: signatures for files the
   thread has never seen or whose content changed since it saw them, plus the
   paths that appeared since the previous step. The project structure is sent
   once, not with every step. What the thread already holds is not re-sent.

   The ledger of what it has seen lives in `sessions.json` as `buildLedger` and
   is cleared when a build starts. Files are recorded there both when their
   signatures are sent *and* when the model writes them — the workspace scan runs
   before a step executes, so files a step creates would otherwise never be
   recorded and the delta would never fire.

   Because a file that changed on disk is re-sent, a self-heal retry that
   rewrote a file cannot leave the model reasoning from what it *proposed*
   rather than what was actually applied.
4. The reply is parsed into file changes, applied under the workspace, and syntax
   checked. Failures are sent back to the model for up to two retries.

## Revising a step

The Builder shows what each step changed as a diff. `applyPatch` copies the
previous version of every overwritten file into
`<workspace>/.agent-backups/<timestamp>/` and reports that directory, so the
renderer reads both versions and diffs them; a created file has no backup and
renders as entirely added. Long runs of unchanged lines collapse so a small
change in a large file stays readable.

The suggestion box under a selected step runs
`suggest <workspace> <provider> <stepIndex> <text>`, which resumes that build's
chat thread and applies the reply through the same parse-apply-check path a
build step uses. Because the thread is still open, the model has the whole build
in view — "rename that function" needs no explanation of which function.

If the build thread is missing or will not reopen, `suggest` refuses rather than
starting a fresh chat. A model without the build conversation would answer
confidently having never seen the code it is revising.

Suggestions do not cascade: revising step 2 does not re-run steps 3 onward.
Starting a new build clears the thread, and with it the ability to revise the
previous one.


## Permissions

The sidebar's Permissions setting controls what happens when a build wants to run
a terminal command:

- **Ask each command** (default) — a modal per command, the original behaviour.
- **Auto-allow** — commands run without prompting, so a long build finishes
  unattended.
- **Never run commands** — commands are skipped. Files are still written and
  syntax checked; nothing executes.

Anything unrecognised falls back to asking, so a missing or corrupted setting
cannot silently run unapproved commands. A command skipped by policy logs
`COMMAND_DENIED` exactly as a manual denial does, so the self-heal path does not
mistake "did not run" for "failed". The choice is stored in `localStorage`, so it
is per-machine and survives a restart.

## Test and Run

**Syntax-check all files** reports one row per check with its command and
outcome, plus a summary. **Run Project** detects the entry point — `scripts.start`,
then `package.json` `main`, then `main.py`, `src/main.py`, `app.py`, `index.js`,
`src/index.js` — and runs it, reporting that it found nothing rather than
guessing. Output appears in the tab as well as the Project log.


## Providers

The picker lists every enabled config in `local-agent/config/providers/`. Adding a
provider means adding a JSON file there — no code change, no markup change.

**Every field in a provider config is read.** `chatInput`, `sendButton` and
`assistantMessage` drive the conversation. `stopButton` with
`waitForStopButtonDisappear` ends a wait the moment the provider's own stop
button vanishes, instead of waiting for the reply text to sit still for eight
seconds. A provider without a stop button falls back to that stability check, so
a wrong selector costs speed rather than correctness.

That optimisation only helps replies slower than about five seconds: `sendPrompt`
sleeps 2s after sending to capture the thread URL and `waitForResponse` waits 3s
before its first poll, so a faster reply's stop button appears and vanishes
unobserved. Those are the replies where waiting does not matter anyway.

`GLM (Z.ai)` ships with **unverified selectors** — they have never been checked
against the live site. If it hangs or sends nothing, correct `chatInput` and
`sendButton` in `glm.json` first. `huggingchat.json` and `open-webui.json` are
empty placeholders with no selectors at all; they are disabled, and enabling one
without filling it in will fail immediately.

## Signing in

**Sign in** beside the provider picker opens a visible browser at that provider
and waits for the chat input to appear, then closes. It forces a visible window
regardless of the Show Browser checkbox — a login in a window nobody can see is
the bug it exists to fix. The session lives in that provider's persistent profile
under `local-agent/storage/browser-profiles/`, which is the only record of being
signed in.

A headless run that finds no chat input gives up after 15 seconds and says to
sign in, rather than waiting out the full two-minute timeout for a login that
cannot happen.


## Notes

- Chat threads per workspace are stored in `local-agent/storage/sessions.json`.
  Both the agent (`PlaywrightController`) and the desktop IPC handlers read and
  write this same file, so the two must stay in agreement on its shape:
  `{ "<workspace>": { chats: [{url,title,createdAt}], activeChat } }`.
- The "Show Browser" checkbox sets `AGENT_HEADED=1` on the spawned agent, which
  `PlaywrightController` reads in its constructor.
- On WSL, Node must be installed inside the Linux environment. A Windows Node on
  `/mnt/c` cannot run from a `\\wsl.localhost\...` path and will fail with
  "UNC paths are not supported". This repo expects it at `~/.local/node`.
- `node_modules/electron/dist` must hold the Linux build (`electron`), not
  `electron.exe`. If `npm install` was run from Windows and the tree copied into
  WSL, delete `desktop/node_modules/electron` and reinstall.
- If `ELECTRON_RUN_AS_NODE=1` is set, electron runs as plain node: it reports a
  node version, rejects `--no-sandbox` as a "bad option", and never opens a window.
- Chromium/electron need system libraries (`libnspr4`, `libnss3`, `libasound2`,
  …). Without root they can be extracted from .deb packages into a prefix and put
  on `LD_LIBRARY_PATH`; this repo expects `~/.local/chromium-deps`.
- Python syntax checks resolve the interpreter at runtime (`python3`, then
  `python`, then `py -3`) — "python" alone does not exist on most Linux/macOS
  installs.
