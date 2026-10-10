# Changelog

All notable changes to CloseNI are recorded here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-10-09

CloseNI is now a native Qt app. The Electron app is gone. Every screen is
Qt Quick, with no web view anywhere. The agent is the same Node and Playwright
process as before, started the same way. Installers are built by CI for
Windows, Linux and, for the first time, macOS. They are unsigned, as before.

### The native app

- **Smaller and lighter.** The unpacked Linux app is 233.5 MB, down from
  283 MB with Electron. The AppImage is 78.5 MB. At idle the app holds about
  95 MB of resident memory. The packages bundle only the Qt modules the app
  uses, Node 22 and the agent. Chromium is still downloaded on first use.
- **Build preview is now the run console plus Open in browser.** The Electron
  app showed a running project in an embedded page. The native app has no web
  view. The run window is a native console for the program's output, and
  **Open in browser** hands the address to your system browser.
- **macOS builds.** Apple silicon and Intel disk images. They are unsigned, so
  Gatekeeper has to be told to allow the app the first time.

### Upgrading from 0.3.0

- **GitHub needs one sign-in again.** The Electron app encrypted the token
  with Electron's safeStorage, and the native app cannot read that copy. The
  new token goes in the OS keyring: DPAPI on Windows, the keychain on macOS,
  and the Secret Service on Linux.
- **Settings are imported once.** On first run the native app copies the
  Electron app's settings (theme, provider, autonomy, persona, skills, recent
  workspaces and the like) from its localStorage. This is best-effort. Anything
  it cannot read keeps its default. Sign-ins, sessions and downloaded browsers
  were never in localStorage. They stay where they were, because the storage
  directory is the same.
- **The installers replace the Electron app.** On Windows, the old per-user
  install is uninstalled first and its data is kept. On Linux, the .deb
  replaces the old `closeni` package.

### Fixed

- **Export branch works when files appear after step 1.** The replay staged a
  file that a later step creates as absent from the earlier commits with
  `git add`, which git refuses for a path it neither tracks nor finds. The
  export failed at step 1 in a workspace that was not a repository yet, and
  in an existing one whenever a file appeared after step 2.
- **CloseNI's own `.closeni` folder no longer counts as an uncommitted
  change.** It made a committed project look dirty: Export branch refused to
  run, the Code panel counted a changed file, and Commit swept the build state
  and checkpoints into the project. The folder now holds a `.gitignore` that
  ignores it, and the export's check leaves it out. The project's own
  `.gitignore` is not touched.
- **DeepSeek's error notices are no longer read as the reply.** "Server
  busy", network and send failures, rate limits, an unfinished (INCOMPLETE)
  reply and a refused one are recognised from the reply stream's status and
  error events, or from the notice on the page. The strings live in
  `deepseek.json` (`replySignals`, `replyErrors`). Busy replies are sent again
  after 5, 20 and 60 seconds, a rate limit after a minute, and anything else
  ends with a message that says what happened.
- **Signed out of DeepSeek mid-session.** The agent stops at once with "Use
  Sign in, then send your message again" instead of waiting on a sign-in page.
- **A full DeepSeek conversation continues in a new chat.** When DeepSeek
  reports the context length exceeded, or moves the message to a new chat by
  itself, the agent rolls over without asking the full chat for a summary and
  sends the message again.
- **A rollover's summary survives a failed reply.** If the new chat's first
  message failed, the summary and notes were dropped and the next message
  started from nothing. They are now sent again with the next message.
- **A new chat after rollover is not mixed up with the old one.** The saved
  chat is cleared when the conversation resets, so a restart resumes the new
  thread.
- **A stuck reply ends with a message.** A reply that never started, or never
  finished, used to return the previous answer as if it were the new one. The
  agent now waits while the reply is still streaming and otherwise says that
  nothing was read.
- **Long sessions stay bounded.** The agent keeps the last 20 undo
  checkpoints, which hold whole files, and the Code panel keeps the last 500
  entries of prompt history.

### For developers

- `scripts/deepseek-faults.mjs` breaks DeepSeek's reply live (busy, rate
  limit, HTTP errors, a dropped stream, sign-out) and checks what the agent
  does. `scripts/long-session.mjs` runs a long agent session with rollovers and
  records latency and memory per turn. Both work on a copy of the signed-in
  profile, refuse the real one, and delete the copy when they end.
- `npm start` runs the native build (`cmake -S native -B build-native -G Ninja
  && cmake --build build-native`). `desktop/`, `electron` and
  `electron-builder` are removed.
- The unit suite checks the native sources. The old `desktop-unit.cjs` is now
  `app-unit.cjs`, and it also checks every theme's contrast. `test:ui` and
  `verify:visual` are retired. The Code panel and build flows run end to end
  in CI against the mock provider (`native/tests/code-e2e.cjs`,
  `native/e2e-build.cjs`). The site and SVG checks are `npm run verify:site`.
- `closeni build` (headless) uses the app's own scheduler from
  `native/qml/js/`.

## [0.3.0] — 2026-10-08

DeepSeek is hardened for the coding agent and was checked against the live site
on 8 October 2026. Its reasoning now shows while it thinks. When DeepSeek drops
a reply, the agent asks again instead of waiting out the clock. Qwen Studio and
GLM have not been touched since 0.2.0.

Installers are built by CI from the `v0.3.0` tag and are unsigned, as before:
Windows SmartScreen will warn about an unrecognised publisher. These are the
first installers since 0.1.0 (see the note under 0.2.0).

### Thinking

- **DeepSeek's reasoning shows in the Code panel.** With Deep thinking on, the
  model's reasoning is copied from the page as it grows. It appears under a
  "Thinking…" line, which folds to "Thought" once the reply or a tool call
  follows. Click the line to open it again. Only the newest turn's reasoning is
  read. DeepSeek removes a collapsed block from the page rather than hiding it,
  so a collapsed block is expanded before it is read. `npm run agent` prints the
  reasoning ahead of the reply it led to.
- **The reply is never read from the reasoning.** DeepSeek renders its reasoning
  as Markdown too, so a pause in the thinking could pass for a finished answer.
  Reading the reply now skips the reasoning container.
- **A changed control now reaches the agent.** The provider, its controls (Deep
  thinking, Smart Search) and Show Browser are applied when the agent starts.
  Before, a change did nothing until the app restarted. Now the next message
  reopens the provider with the new settings, and the project's thread resumes.

### Reliability

- **A dropped reply is asked for again.** Seen live: DeepSeek gave a
  9k-character prompt 0.3 s of thinking, marked the message INCOMPLETE and
  closed the stream. The wait then sat out its full 300 s. Now, if the reply
  stream has closed and nothing is on the page a few polls later, the reply
  counts as dropped and the prompt is sent once more. A second drop is
  reported. Checked live by injecting four faults: an empty stream, a cut
  connection, an INCOMPLETE reply and a stall. Every one got the right answer on
  the resend. The first three took about 28 s in all. The stall took 85 s,
  because DeepSeek's own page ends it at about 60 s.
- **DeepSeek's resumed streams are watched.** When a reply stream ends without
  its close event, the page fetches the rest from `/api/v0/chat/resume_stream`.
  That request was not watched. The wait could read a reply before it finished,
  or resend a prompt the page was still fetching. The stream pattern now covers
  both endpoints and nothing else.
- **Navigation is retried when Chromium asks for it.** A headed browser's first
  navigation could fail with `ERR_CERT_VERIFIER_CHANGED` while its certificate
  store was still loading, and that failed the session before any prompt was
  sent. These errors now retry the navigation.
- **A provider that fails to open no longer holds the agent.** When start-up
  fails, the browser is now closed, so the process exits and releases the
  profile. The app no longer treats a failed start as a running session.

### Tool calls

- **An empty write over a real file is refused.** A ```` line inside a ```tool
  block closes the block early, which leaves a write with no payload. That used
  to empty the file. A write whose payload is empty or only whitespace is now
  refused when the file has content, and the error names the likely cause. To
  empty a file on purpose, run `: > file` with bash.
- **A tool call lost to a broken fence is reported.** Calls that came after a
  broken fence were read as plain text, so they never ran, and the model was not
  told. Now each lost call goes back to the model as an error asking it to send
  that call again. This covers a tool opener in a code block that never closed,
  and one in any plain block after a malformed call or empty write in the same
  reply. A closed example block in a clean reply is left alone.
- **Clearer fence instructions.** The preamble and the resend message now say
  that the opening line itself must be ````tool. Wrapping only the payload in
  four backticks is not enough. Checked live: a README rewrite with nested
  fences came out whole after one malformed reply.

### Desktop

- **Show Browser is saved and is on the rail.** It used to be off after every
  restart. A second checkbox under the provider controls changes the same
  setting.

## [0.2.0] — 2026-10-07

Qwen Studio and GLM can be picked, and the coding agent respects the DeepSeek
Deep thinking setting.

**No installers were built for 0.2.0.** It was tagged `0.2.0` without the `v`,
and the release workflow runs only on `v*` tags. Its GitHub release has no
files. Use 0.3.0, which includes everything here.

### Providers

- **Qwen Studio and GLM are selectable.** Both were gated as "coming soon".
  They are ungated without a live re-check, so treat them as experimental: each
  config keeps its old gate reason in `_ungatedNote`. Qwen gained a terms link.
- **The coding agent keeps your DeepSeek Deep thinking choice.** It used to force
  Deep thinking off on every agent run. It now follows the saved setting and
  still defaults to off when none is saved. Smart Search stays off for the agent.

## [0.1.0] — 2026-10-05

**Published as an early release.** Installers for Windows (NSIS) and Linux
(AppImage and `.deb`) are built by CI from the `v0.1.0` tag and attached to a
GitHub release. They are unsigned. Earlier 1.0.x builds were withdrawn because
plans did not always parse; this one is numbered for what it is.

**Why 0.1 and not 1.0.** The version says what this is: one provider driven end
to end, a Windows installer nobody has run yet, and a GitHub integration that
has never made a live request. Calling that 1.0 would have claimed a stability
nothing here has earned. Three 1.0.x builds were published and withdrawn on the
day; the defects they carried are listed below because they are the reason the
number changed.

**What has actually been run.** The Linux AppImage and `.deb` build, contain no
session data, and the packaged app launches with its renderer loading and its
agent spawning. The Windows application packs, audits clean, and has been
started on Windows 11. The NSIS installer is built by CI and has not been
installed by anyone — treat it as unproven. GitHub sign-in, push, clone and
Actions are unit-tested with an injected transport and have never made a live
request. Qwen Studio and GLM shipped gated in this release; see 0.2.0.

### A coding agent, first

- **The Code panel is the new default: a coding agent.** You ask in plain words.
  It reads and searches the project, edits files, runs commands and checks its
  own work, turn by turn, until it has an answer. No plan is required. The
  planned build (plan, then build step by step) is still here as a separate
  mode: `/build`, or the Plan and Build panels.
- **Tool calls over a chat site.** A web chat has no function-calling API, so
  the agent's first message teaches a convention. The model replies with fenced
  blocks naming a tool, the agent runs them and sends the results back, and a
  reply with no tool blocks is the answer. Write and edit carry their payload
  raw after `---`, and edits use SEARCH/REPLACE sections
  (`local-agent/src/agent/protocol.ts`).
- **Tools:** read, write, edit, bash, glob, grep, ls and todo. Every path is
  confined to the project, symlinks included, and `.git` is never written.
  Edits need one exact match, tolerating the trailing whitespace a page drops.
  Outputs are capped.
- **Modes and permissions.** Default asks before edits and commands. Accept
  edits asks only before commands. Plan is read-only and ends with a plan you
  approve. Auto runs everything. The existing safety list (sudo, package
  managers, `rm -rf`, `curl | sh`...) always asks, in every mode. "Yes, and
  don't ask again" remembers edits, or a command prefix such as `npm test`,
  for the session.
- **In the panel:**
  - a transcript of tool lines, with results and diffs under them;
  - permission prompts answered with 1/2/3 or esc, and "No" can say what to do
    instead;
  - a spinner with elapsed time, and esc to stop;
  - queued messages, and slash commands (`/help`, `/clear`, `/plan`, `/mode`,
    `/rewind`, `/init`, `/memory`, `/build`, `/model`, `/theme`, `/stop`);
  - `@file` attachments with completion, shift+tab to change mode, and history
    on up and down;
  - a todo list above the input.
- **Memory and rewind.** `CLOSENI.md` (or `AGENTS.md` / `CLAUDE.md`) is read at
  the start of each conversation, and `/init` writes one. `/rewind` restores
  every file the last turn changed and tells the model it happened.
- **Terminal** is the new default theme: monospace, near-black and
  monochrome, with colour only where it carries meaning (diffs, results). Eleven themes in all. A theme someone already chose is kept.
- **One long-lived session per project** (`agent-session`). It yields the
  browser to anything else that needs it, and reopens the same conversation on
  the next message. `npm run agent -- "<request>" <folder> <provider> [mode]`
  runs one request from a terminal.
- **Tests:** 100 unit checks of the agent (a scripted model), 24 of the panel's
  vocabulary, 14 end-to-end checks through a real browser against the mock
  chat, and `npm run test:ui`, 46 checks driving the panel in Chromium.
- **Not verified live.** No real provider has run the agent. The first thing to
  measure on a signed-in machine is whether DeepSeek keeps to the tool-block
  convention across a long session.

### Pixel theme and a flow overhaul

- **Pixel**, briefly the default and now one of eleven themes, is the README's look in the app. It has
  GitHub-dark surfaces and a stepped green gradient for the wordmark, with a
  blinking block cursor and a one-time boot sweep. The top bar has
  window-chrome squares. Blocks are square, with hard offset shadows, and cards
  carry the stat tiles' coloured top edge. The build bar fills in chunks. A
  sparse starfield twinkles behind the panels.
- The other nine themes are unchanged and still selectable. A theme someone
  already chose is kept.
- **Ambient motion is new, and limited to Pixel.** It was rejected for the app
  before. Here the theme is the request, so the motion is slow and stepped. The
  Appearance decoration toggle stops it, and so does the OS "reduce motion"
  setting. Pixel's worst contrast is 5.07:1 (`verify:visual`).
- **A flow bar** across the top shows Describe, Plan, Build, Test, Ship. Each
  stage comes from real state: the conversation, the plan, step statuses, a run
  and a successful push. A failed build reads as failed, and a later stage
  cannot tick while an earlier one has not. The next stage is outlined, and
  clicking a stage opens its panel (`desktop/flow.js`, unit-tested).
- **The logs became a Console drawer.** They had taken the bottom third of every
  panel, empty or not. Closed, the drawer counts new lines. It opens itself when
  a build starts or an error is logged, and remembers being opened or closed.
- **The rail is three cards**, Provider, Project and Conversation, instead of
  one column of controls. It scrolls on short windows.
- Screenshots regenerated. The main panels are shown in Pixel.

### Needle extraction: tried, measured, removed

- An optional second reader, [Needle](https://github.com/cactus-compute/needle)
  (a small local model run through a Python bridge), was added behind
  Settings → Extraction to read plans written as prose. It was removed before
  release after its first run with the real model, on 2 October. It rescued none
  of six prose plans. Five never reached the model, because steps were found
  only by "Step N" markers. On the sixth it took 17–30 s a step, both answers
  fell below the confidence floor, and one named a file that was not in the
  reply. An optional Python dependency that does not earn its place is support
  cost with no return. Plans that do not parse are still re-asked once and then
  reported.

### Browser-native provider and research layer (not wired into builds)

- `local-agent/src/web/`: session manager with isolated contexts, crash, popup,
  dialog and download handling, bounded shutdown; classified navigation;
  selector fallback chains with diagnosis; debug artifacts with sanitised DOM.
- UI states `AUTH_REQUIRED`, `CAPTCHA`, `RATE_LIMITED`, `ERROR`,
  `GENERATION_FAILED` and others, detected and recorded. A login or challenge
  stops the run.
- One extraction pipeline (Raw → DOM → Semantic → Normalized → Structured) that
  keeps code with language, tables, links, citations and reasoning.
- A research engine that plans, searches, reads, cites, deduplicates and flags
  conflicting sources.
- `closeni webtest <provider>`, `npm run test:web` and its groups, and
  `npm run web:report`. Live results so far: `BLOCKED`, because the
  development container's network refused every provider host.
- The reply-stream tap moved to `providers/stream-tap.ts`, shared by the
  controller and the new layer. The controller's behaviour is unchanged.
- A full regression pass (29 September) found and fixed:
  - **The live smoke test blamed selectors when the site was unreachable.** With
    no network it reported the assistant selector as "watching something that
    is not the live answer". It now says the site could not be reached, and
    marks every check after the send as not run.
  - **Errors shown in the app carried Playwright's call log and terminal colour
    codes.** The agent now sends the one-line cause.
  - **An empty reply on Qwen- and GLM-style pages was detected only by luck.**
    Their stop control is up for milliseconds, and detection depended on a poll
    landing inside that window. The page now counts the control's appearances
    itself.
  - **A reply that never started returned the previous answer's text.**
  - **A failed or never-started wait was reported as `empty`.**
  - **A page with a frozen main thread could hang the wait forever.** One
    selector lookup in the wait loop had no time bound; now none do.

### Fixed before release

Three defects that only appeared once the app was installed, each found by
running the packaged build rather than reading it:

- **Every agent run failed** with `spawn …\CloseNI.exe ENOENT`, naming the one
  path that was fine. Packaged, `__dirname` sits inside the archive, so the
  spawn working directory resolved to `app.asar` — a file. Children now run in
  a real directory, and the agent is read from where its unpacked copy lives.
- **The browser download reported "Playwright is missing from this build"** on
  an intact install: Playwright's `exports` map does not list `./cli.js`, so
  Node refused the deep import. Resolved through its `package.json` instead,
  and Playwright is unpacked from the archive so it can spawn real executables.
- **The default File / Edit / View menu** carried a reload and a devtools item,
  duplicating navigation the app already has.
- **A failed browser download said only "Download failed (exit 1)."** The
  installer prints the real reason first - a 403 from a proxy, a DNS failure -
  and then buries it under generic lines. The gate now reports that reason, and
  for a network refusal names `cdn.playwright.dev` as the host to allow. Found
  by launching the packaged Linux build on a network that blocked the CDN.

### Gated

- **Qwen Studio** and **GLM** — listed in Settings, not selectable, each with
  the reason recorded in its config.

### Getting started

- A first launch shows a **Getting started** checklist above the chat: browser,
  project folder, provider sign-in, first prompt - in that order, with only the
  current step explained and one button that does it. Every tick is read from
  state the app already holds (the browser gate, the workspace, the account
  light, the conversation), never from a flag of its own, so it cannot report a
  sign-in done that failed. An unchecked account offers a check rather than a
  sign-in, since you may already be signed in. The last step fills in a worked
  example small enough to plan in two or three steps.
- It goes away when every step is done, or for good when hidden. Settings,
  About brings it back.

### Providers

- Drives **DeepSeek** through a real Chromium session, with no API key and no
  billing account. Plan, build, repair and verify have all been run end to end
  against the live site.
- **Qwen Studio and GLM ship gated as "coming soon."** They are listed in
  Settings so it is clear they are planned rather than missing, but cannot be
  selected, and the agent refuses them if one arrives from anywhere else — a
  preference saved before the gate cannot start a session on one.
  - Qwen's page control works: input located, long prompts pasted via the
    clipboard, send and completion detection both confirmed live. It is gated
    because a build-sized prompt outruns the 120s completion wait while the
    model is still thinking, so the step returns no changes and blocks the rest
    of the build. Raising `maxWaitMs` is the likely fix and is untested.
  - GLM's live site declines the build prompts, and its model and thinking
    controls were not found on the page.
- Each provider is a config of its own rather than a shared schema, because the
  sites disagree about almost everything — where the composer is, when a reply
  has finished streaming, and what counts as the last message. Configs are read
  at runtime, so correcting a selector is a text edit rather than a rebuild.
- One persistent browser profile per provider. Sign in once; the session
  survives restarts.
- Chromium is downloaded on demand from Settings, with progress reported.

### Planning

- A prompt becomes a structured plan: numbered steps, the files each one owns,
  a `dependsOn` list, and a run command for the finished project.
- Step count follows the described scope. It was previously capped at eight,
  which silently truncated anything larger.
- Duration is estimated before you approve, at roughly ninety seconds per step.
- Plans can be revised as many times as you like. Nothing reaches disk until you
  approve.

### Building

- **Chat, planning and building share one conversation** with the provider, so a
  step prompt is an instruction to a model that already has the plan rather than
  a re-explanation of the project. Steps run against a dependency graph, one at a
  time: a conversation has one composer. Parallel steps needed a thread each,
  which is what forced step prompts past the completion wait.
- Live unified diffs per step, with the target path and whether the file is
  being created or edited.
- A per-step suggestion box steers a single step without restarting the build.
- Two log streams, kept apart on purpose: CloseNI's own narration, and raw
  toolchain output.
- A frontend preview opens from the Builder header when the project serves one.
- Interrupted builds resume from the first unfinished step instead of starting
  over.

### Verifying generated projects

- **`Run tests` in the Test panel** runs the project's own test suite and then
  starts its entry point. Syntax checks prove code parses; this is the only
  thing that answers whether it behaves — a module whose every function returns
  the wrong value compiles perfectly.
- Suites are detected from the project rather than invented: npm (only when a
  test script is declared), cargo, go, maven, gradle, pytest, rspec, phpunit,
  and a bare `tests/` directory. One suite runs, not every suite a polyglot
  repo could plausibly have.
- A smoke run starts the entry point. A server that is still up when the window
  closes has passed; a script is judged by its exit code. The two have opposite
  success conditions, so they are judged apart.
- A suite whose runner is not installed is reported as **not run**, never as a
  pass. A green "0 failed" on a project whose tests never executed is the most
  misleading number this could produce.

### Verification

- Syntax and compilation checks across twelve languages: Rust, Go, TypeScript,
  Java, C#, C, C++, Python, JavaScript, Ruby, PHP and shell.
- A manifest claims its language — `Cargo.toml`, `go.mod`, `tsconfig.json`,
  `pom.xml`, `build.gradle[.kts]`, `*.csproj`, `Makefile` — so projects whose
  files cannot be validated in isolation are checked once as a project.
- Failures send the compiler's own stderr back to the model, twice per step,
  then stop with an explanation rather than looping.
- Environment failures are classified separately from code failures. A `venv`
  blocked by PEP 668 no longer fails a step whose code was already correct.
- **Eleven of the twelve checks have now run against a real toolchain**, a
  working and a broken sample each, through `npm run languages`. C# is the one
  left: there is no .NET on the machine that ran it. Running them found three
  defects no unit test could:
  - **Go was never checked, on any machine.** The tool probe ran `go --version`,
    which is not a flag (`go version` is), and `gofmt --version`, which has no
    version flag at all - so Go resolved as not installed beside a working
    compiler, and every Go check was skipped.
  - **Java in packages failed on correct code** when there was no build file:
    `javac` could not find a sibling package, so a file importing another
    failed its check and the model would have spent its repairs on it. The check
    now offers every ancestor directory as a source root.
  - **The Python syntax check left `__pycache__` in the workspace**, which made
    the git export refuse the tree as dirty for any Python project without a
    `requirements.txt`. Bytecode now goes to a temp directory.

### Running what was built

- Every build writes `closeni.run.json` plus `run.sh` and `run.bat`, so a
  finished project runs without CloseNI installed.
- The Test panel resolves the run command as `SAVED` → `FROM YOUR PLAN` →
  `DETECTED` → `NOT FOUND`, and shows which one you got.
- A command you edit is never overwritten by a later build.
- Entry-point detection understands Node, Python, Go, Rust, Ruby, PHP, .NET and
  static sites, and reports honestly when a library has no entry point.
- The Test panel carries its own chat, holding the run in context, so asking why
  something failed gets an answer about your output rather than the error class.

### Version control

- `git init`, status, commit-all, push, and clone from the Ship panel.
- GitHub sign-in with a fine-grained or classic token, sealed with the operating
  system keystore and passed to git through `GIT_ASKPASS`.
- GitHub Actions runs are listed with their conclusions, and workflows can be
  dispatched by filename.

### Safety

- Auto-allow has a floor. `sudo`, package managers, `rm -rf`, `dd`, `mkfs`,
  `chmod 777`, `chown`, power commands, `curl … | sh`, writes to raw block
  devices and `git push --force` without `--with-lease` always prompt, whatever
  the autonomy setting says. The test runs against the whole command string,
  because a real reply hid `sudo apt install` behind an `||`.
- Git runs with `shell: false` and array arguments, so a commit message
  containing `; echo …` is a commit message and nothing else.
- File writes are contained to the workspace root; escaping paths are refused,
  not sanitised. Overwrites are backed up first.
- Tokens are redacted from logs by exact-string replacement rather than a
  pattern that a new token format could slip past.
- Browser profiles, cookies and chat URLs are excluded from version control and
  from the packaged application. The installer's file list is an allow-list.

### Interface

- Six panels: Chat, Builder, Test, Research, Ship, Settings.
- Nine themes — Midnight, Paper, Phosphor, Amber, three Cassette variants,
  Blueprint and High contrast — covering light, high-contrast and CRT palettes,
  with a texture toggle for the ones that carry one. Themes style CloseNI only;
  projects built with it are never touched.
- Pixel-art motion on step spinners, progress, status transitions and
  confirmations, driven by `steps()` timing so frames land discretely.
- Two CSS lints run as tests: no colour literal may sit outside a theme block,
  and every theme must redefine the whole palette.

### Distribution

- Windows NSIS installer, Linux AppImage and `.deb`, built and published by a
  tagged release workflow. The workflow checks the tag against `package.json`,
  runs the unit suite before packaging, serialises its two OS jobs so they
  cannot race to create the same release, and publishes a draft.

### Verification

- `npm run verify` — 41 structural checks covering documentation claims against
  the code, asset and anchor integrity, SVG safety, release configuration, and
  an audit of the packaged artifact for leaked session data.
- `npm run verify:visual` — renders the app in a real browser under all nine
  themes and measures contrast on every element that carries meaning, plus the
  Pages site at desktop and mobile widths.
- Midnight's `--mut` moved from `#5b5b63` to `#66666e`. The default theme was
  putting micro labels, hints and blocked steps at 2.9:1 — the lowest contrast
  of any of the nine, in the one most people will use. Found by the contrast
  pass, which the palette-completeness lint could not have caught.

### Known limitations

- Provider control is page automation; a site redesign can break extraction.
- Checks prove code parses and compiles, not that it is correct.
- Installers are unsigned.
- Builds beyond a few dozen steps are untested.

[1.0.0]: https://github.com/siddarth1872004/CloseNI/releases/tag/v1.0.0
