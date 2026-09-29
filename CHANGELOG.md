# Changelog

All notable changes to CloseNI are recorded here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — unreleased

**Not published.** Installers build in CI and have been withdrawn: plans do not
always parse. A binary that fails on the first thing someone tries is worse than
no binary.

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
request. Qwen Studio and GLM ship gated.

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

### Optional local extraction with Needle (off by default)

- **Settings → Extraction** can add a second reader after the built-in parser:
  [Needle](https://github.com/cactus-compute/needle), a small local model
  (`pip install cactus-needle`) whose decode grammar guarantees its output
  matches the schema it is given. It runs in a Python bridge
  (`local-agent/python/needle_bridge.py`) that the agent starts on first use.
  Every call to it has a time limit, and its telemetry is switched off.
- **What it does.** A plan that still fails to parse after the re-ask is read
  out of its prose. The steps are found by fixed rules, not by the model. Each
  step's detail is the provider's own text. Needle supplies only the title, the
  files and whether the step is testable. A file or run command that does not
  appear in the reply is dropped. A rescued plan runs its steps in order.
- **It also says what a reply was.** "Could not parse plan" and "No file changes
  found" now say when the provider declined (quoting it) or asked a question
  instead. This is the content-refusal detection `docs/NEXT.md` left open. It
  only changes the message, never what runs.
- **What it never does:** write or repair code, or change how a reply that
  parses is read. If the bridge is missing, slow or crashes, extraction logs
  one line, turns itself off for the rest of the run, and the run fails or
  succeeds exactly as it did before.
- `closeni extractor-check [warm]` checks the setup and, with `warm`,
  downloads the model. `closeni rescue-plan <file>` runs a saved reply through
  the parser and then the extractor, with no browser, for measuring real plan
  replies.
- **Not verified with the real model.** The development container's network
  refused Hugging Face, so the weights never downloaded. The real
  `cactus-needle` 3.0.6 package was imported through the bridge, and its API
  matches. Everything else ran against a stand-in `needle` package that answers
  by rule. That proves the plumbing, the limits and the grounding checks, not
  how well Needle reads a plan. First real run: `closeni extractor-check warm`,
  then `closeni rescue-plan` over saved replies.

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
