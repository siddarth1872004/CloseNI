# Changelog

All notable changes to CloseNI are recorded here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-08-11

First release.

**What has actually been run.** The Linux AppImage and `.deb` build, contain no
session data, and the packaged app launches with its renderer loading. The
Windows application packs, audits clean, and has been started on a real Windows
machine. The NSIS installer that wraps it is built by CI on `windows-latest`
and has not been installed by anyone — treat the first one as unproven. GitHub
sign-in, push, clone and Actions are unit-tested with an injected transport and
have never made a live request. Qwen Studio and GLM ship gated.

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
