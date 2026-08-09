# CloseNI

Electron desktop app that drives a web-based AI chat (DeepSeek by default) through
Playwright to plan and build software projects.

```
desktop/       Electron app (main process, preload bridge, renderer, builder UI)
local-agent/   Node backend: browser control, response parsing, patch application
shared/        Types shared between the two
scripts/legacy/ One-shot patch scripts from earlier development — do not run
```

## Setup

```bash
npm install
npm run build                  # builds shared/ then local-agent/
npx playwright install chromium
cd desktop && npm start
```

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
2. `desktop/main.js` spawns `local-agent/dist/index.js`. Arguments longer than
   8000 chars are spilled to a temp file and the path is passed instead; the agent
   reads those back (`resolveArg`).
3. Step 0 of a build opens a **fresh** chat thread and records its URL in
   `sessions.json` as `activeBuildThread`; every later step of the same build
   resumes that thread, so a step can see what earlier steps said. The prompt
   still carries the project tree plus signatures of the most relevant existing
   files. One-shot modes (chat, plan, revise, research, testall) keep opening a
   fresh chat each time.
4. The reply is parsed into file changes, applied under the workspace, and syntax
   checked. Failures are sent back to the model for up to two retries.

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
