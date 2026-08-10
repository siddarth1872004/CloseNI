# Distribution — design

Date: 2026-08-10
Roadmap item: 28 (releases page, Windows + Linux packages)
Sub-project: 8 · Distribution
Status: agreed in brainstorming. The Chromium strategy and the CI approach were
chosen by the project owner; the rest is the author's.

## Problem

Item 28 reads as a packaging task — add electron-builder, produce an `.exe` and
an AppImage. The packaging config is the smallest part of it. **CloseNI cannot
currently be installed anywhere, for three reasons that have nothing to do with
electron-builder.**

### The app writes into its own install directory

`app.getPath("userData")` appears nowhere in the codebase. The agent derives its
storage location from the provider config's `profileDir`
(`local-agent/storage/browser-profiles/deepseek`), resolved relative to the
process working directory, which `main.js` sets to the repository root.

Packaged on Windows, that resolves inside `Program Files`, which is not
writable. The app would fail to save a session at all — not degrade, fail. This
is the blocking defect, and everything else is downstream of it.

### The app spawns `node`

Four sites in `desktop/main.js` run `spawn("node", [agentPath()], …)`. A
packaged application cannot assume Node is installed on the user's machine.

### Chromium is 389MB

The agent drives real browsers through Playwright. Playwright's headed Chromium
is 389MB before Electron's own 260MB. Bundling it would make every release
approximately half a gigabyte per platform.

## Decisions

1. **State moves to `userData`, passed to the agent as an environment
   variable.** The agent is a separate process with no Electron API.
2. **The agent runs on Electron's own binary** via `ELECTRON_RUN_AS_NODE`.
3. **Chromium is downloaded on first run**, not bundled. Installer stays around
   100MB; the user waits once.
4. **Releases are built by GitHub Actions on a tag.** It is the only way to
   produce a Windows installer without a Windows machine doing it by hand.
5. **Existing browser profiles are not migrated.** See below.
6. **`local-agent/storage/` is never packaged.** See below — this one is a
   security rule, not a size optimisation.

## Design

### Never package `local-agent/storage/`

`local-agent/storage/` holds **live session cookies** for the user's DeepSeek,
Qwen and GLM accounts, and `sessions.json` holds private chat URLs. It is
currently 95MB. It is git-ignored for exactly this reason, and `.gitignore` does
not constrain electron-builder.

An `files` glob that swept it into a release artifact would publish the author's
authenticated sessions to a public GitHub Release. The build config therefore
uses an **explicit allow-list** of what to include rather than an exclude-list of
what to skip: a forgotten exclusion is a credential leak, whereas a forgotten
inclusion is a missing file that fails loudly on first launch.

The same reasoning excludes `.superpowers/`, `docs/`, `samples/`, `app/`,
`instance/`, `__pycache__/` and `vscode-extension/`.

### Storage location

`main.js` sets `CLOSENI_STORAGE` to `app.getPath("userData")` when spawning the
agent. The agent resolves its storage root as:

```typescript
resolveStorageRoot(envValue: string | undefined, configuredProfileDir: string): string
```

When `CLOSENI_STORAGE` is set, profiles live at `<root>/browser-profiles/<id>`
and sessions at `<root>/sessions.json`. When it is unset, the resolution is
exactly today's — derived from the configured `profileDir`.

**The unset path is not a legacy fallback; it is what the tests use.** The
end-to-end suite spawns the agent directly with provider configs written into a
temp directory, and relies on storage following `profileDir`. Preserving that
keeps 150 e2e checks meaningful.

### Existing profiles are not migrated

The owner has signed-in profiles for three providers in the current location.
Copying live Chromium profile directories is not a reliable operation — Chromium
records absolute paths in parts of a profile, and a half-working profile
produces failures that surface much later and make no sense when they do.

Signing in again is three clicks, and the Sign in button added in item 9 exists
for exactly this. **A migration that silently half-works is worse than a
sign-in.** Recorded as a decision rather than an oversight.

### The Node runtime

```javascript
spawn(process.execPath, [agentPath(), …args], {
  env: { ...env, ELECTRON_RUN_AS_NODE: "1", CLOSENI_STORAGE: storageRoot },
});
```

`ELECTRON_RUN_AS_NODE` has bitten this project before: set in the developer's
shell, it made Electron report `v20.18.0` and reject `--no-sandbox`, so the
desktop window never opened. `scripts/wsl-env.sh` unsets it for that reason and
must keep doing so. Setting it deliberately on a **child** process is the
opposite case and is correct: a Node process is precisely what is wanted.

### Chromium on first run

`PLAYWRIGHT_BROWSERS_PATH` is set to `<userData>/browsers` **only when
`app.isPackaged`**. In development it must stay unset, or Playwright stops
seeing the browsers already in `~/.cache/ms-playwright` and the developer is
told to download 389MB they already have.

On launch, the main process checks whether a browser exists at that path. If not,
a first-run gate blocks the app: one button, a progress bar fed from Playwright's
own installer output, and a plain failure message if the download cannot start.
The installer is invoked the supported way — Playwright's CLI, run on
`process.execPath` under `ELECTRON_RUN_AS_NODE`, with `install chromium`.
Reaching into `playwright-core`'s internal registry would be shorter and would
break on a Playwright upgrade.

The result is cached in `userData`, so reinstalling the app does not repeat it.

### Packaging

The build runs from the **repository root**, not from `desktop/`. `playwright`
is already a root dependency, so electron-builder's dependency analysis includes
it without special handling; building from `desktop/` would require reaching
outside the app directory for the agent, its config and Playwright.

- `desktop` joins the root `workspaces` array, so one `npm install` covers
  everything and there is one copy of Electron rather than two.
- Root `package.json` gains `"main": "desktop/main.js"`, an `electron-builder`
  devDependency, and a `build` block. The `electron` devDependency moves up from
  `desktop/package.json`.
- `desktop/package.json` keeps its `start` script: `cd desktop && npm start` is
  the documented development command and must keep working. npm adds ancestor
  `node_modules/.bin` directories to PATH, so a root-installed Electron is found.
- The root version becomes `1.0.0`, matching what `desktop/package.json` already
  claims. The installer version comes from the root, so leaving it at `0.1.0`
  would ship an app whose About page and filename disagree.

Targets: NSIS for Windows, AppImage and `.deb` for Linux, icon generated from
`build/icon.svg`.

**`local-agent/**` is listed in `asarUnpack`**, for two reasons. The agent is
spawned as a child process, and the provider configs are meant to be edited by
hand — `glm.json` says in as many words that a wrong selector should be
corrected there, "a text edit, not a code change". Inside an asar archive it is
neither.

### Releases

`.github/workflows/release.yml`, triggered on a `v*` tag. `windows-latest`
produces the NSIS installer; `ubuntu-latest` produces the AppImage and `.deb`.
Both publish to a GitHub Release for the tag. The repository has no `.github`
directory today, so this is new.

The workflow runs `npm ci`, builds the TypeScript, runs the unit suite, and only
then packages. The end-to-end suite is **not** run in CI: it drives a real
Chromium against a local mock server and takes around fifteen minutes, which is
a poor trade on every tag. It stays a local gate.

## Testing

What can be tested here is the decision logic and the configuration, not the
artifacts:

- **`resolveStorageRoot`** — env set yields the userData layout; env unset
  reproduces today's `profileDir`-derived path exactly; an empty string is
  treated as unset rather than as the filesystem root.
- **Browser presence** — a directory containing a chromium build reads as
  installed; an empty or missing one does not.
- **The `build` block** — it parses, names `nsis`, `AppImage` and `deb`, points
  at an icon that exists, and lists `local-agent/**` under `asarUnpack`.
- **The allow-list** — `local-agent/storage` matches no `files` entry. This is
  the test that matters most, because its failure mode is publishing session
  cookies.
- **The workflow** — the YAML parses, so a syntax error fails locally rather
  than on a tag.

**Not testable in this environment, stated plainly:** the installers themselves.
There is no Windows machine here and no way to verify an AppImage launches. A
green suite means the configuration is coherent, not that the installer works.
The first real evidence is CI producing artifacts and someone running one.

## Non-goals

- **Code signing and notarisation.** A Windows certificate costs money annually
  and macOS notarisation needs an Apple Developer account. Unsigned builds will
  show a SmartScreen warning; that is the accepted cost.
- **macOS.** No Mac to test on, and shipping an untested `.dmg` is worse than
  shipping none.
- **Auto-update.** electron-updater needs a signed build to be trustworthy, and
  an unsigned auto-updater is a way to distribute someone else's code.
- **Bundling Chromium**, decided above.
- **Migrating existing browser profiles**, decided above.
- **Packaging the VS Code extension or the Python app** in `app/`. Neither is
  part of the desktop application.

## Consequences

- **First launch needs network and about two minutes.** A user on a metered or
  offline connection cannot start. The gate says so explicitly rather than
  failing at the first sign-in attempt.
- **Unsigned installers warn.** Windows SmartScreen will flag the `.exe` until
  it earns reputation or gets signed.
- **`npm install` reorganises `node_modules`** when `desktop` becomes a
  workspace. The README already warns that a Windows-installed tree copied into
  WSL leaves `electron.exe` where the Linux `electron` should be; that warning
  becomes more relevant, not less.
- **Two storage layouts now exist** — packaged and development. The packaged one
  is exercised only by running a packaged build, so a bug in it will not be
  caught by the test suite. This is the weakest point in the design, and the
  reason `resolveStorageRoot` is a pure function with its own tests rather than
  logic inlined at the call site.
- **The agent process is now Electron, not Node.** Any behaviour that depends on
  the Node version could differ between a development run and a packaged one.
