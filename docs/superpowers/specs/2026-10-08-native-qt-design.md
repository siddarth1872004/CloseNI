# Native Qt app — design

Date: 2026-10-08
Sub-project: 11 · Native app and macOS
Status: the toolkit (a full Qt UI, not a webview shell) and an unsigned macOS
build were chosen by the project owner. Decisions marked *(default)* are the
author's and are open to change before the phase that needs them.

## Problem

CloseNI's desktop app is Electron: about 9,500 lines of HTML, CSS and JS in
`desktop/` (seven panels, eleven themes, a diff view, a run window), and a
main process of about 1,900 lines exposing 63 IPC handlers. The owner wants a
native C++ app instead, and wants it to run on macOS as well as Windows and
Linux.

Three facts shape everything below.

1. **The agent stays Node.** `local-agent/` is 18,600 lines of TypeScript that
   drives DeepSeek, Qwen and GLM through Playwright. Playwright has no C or C++
   binding, and the product *is* driving a real browser, so the agent is not
   ported. The Qt app replaces `desktop/` only.
2. **Electron is also the agent's Node.** The agent is spawned on Electron's
   own binary with `ELECTRON_RUN_AS_NODE`. Without Electron, a Node runtime has
   to be shipped.
3. **Chromium does not go away.** Playwright's Chromium is still downloaded on
   first run for the providers. What goes is Electron's second copy (283 MB
   unpacked here) and its renderer process tree.

So the gain is memory, start-up time and a native app, not a much smaller
download: about 45 MB of Node and 40–60 MB of Qt replace Electron, and the
installer will likely land near today's ~100–125 MB, not far below it.

## Decisions

1. **Qt 6, Qt Quick (QML) for the UI, C++20 for everything else, CMake.**
   *(default: QML over Widgets)* The themes are the reason. Pixel and Terminal
   change layout, the CRT look animates, and the other eight are palettes.
   Widgets with style sheets cannot do the first two without custom painting
   everywhere. Minimum Qt 6.8 (the current LTS), which supports macOS 12+.
2. **The agent protocol is unchanged.** The app spawns
   `local-agent/dist/...` with `QProcess` and talks JSON lines on stdin and
   stdout, as `desktop/main.js` does now. No line of `local-agent/` changes for
   this sub-project except where it names Electron.
3. **Node is bundled.** *(default)* The official Node 22 binary for each
   platform ships beside the app, and the agent runs on it. That replaces
   `ELECTRON_RUN_AS_NODE`. Node's single-executable mode is not used: it still
   needs the agent's `node_modules` (Playwright) on disk.
4. **No embedded web engine.** *(default)* Qt WebEngine is Chromium again,
   about 200 MB. The two embedded views, the preview pane
   (`index.html#preview-frame`) and the run window (`run.html#view`), become:
   the program's output in a native console, plus "Open in browser" for
   anything that serves HTTP. This is a visible loss for web projects, and the
   one decision most worth revisiting.
5. **Secrets move to the OS keychain** via QtKeychain (Keychain on macOS,
   Credential Manager on Windows, Secret Service on Linux). Tokens encrypted by
   Electron's `safeStorage` cannot be read from Qt, so GitHub sign-in happens
   once more after the switch.
6. **State stays where it is.** The Qt app computes the same storage directory
   Electron's `app.getPath("userData")` gives, and passes it to the agent as
   `CLOSENI_STORAGE`, as now. Signed-in provider profiles and per-project
   threads carry over untouched. Settings held in the renderer's
   `localStorage` (Show Browser, provider controls, theme) do not; they move to
   `QSettings` and are picked again once.
7. **macOS ships unsigned.** Ad-hoc signed (`codesign -s -`), as the Windows
   build is unsigned. The README tells users to right-click and choose Open the
   first time. Notarisation waits for an Apple Developer account. Builds for
   Apple Silicon and Intel are made by CI. There is no Mac here to run them
   on, so the first macOS release is unverified and says so.
8. **Electron keeps shipping until the Qt app matches it.** Both live in the
   tree during the port. `desktop/` is deleted only in the last phase, against
   a parity checklist.

## Design

### Layout

```
native/
  CMakeLists.txt
  src/            C++: services, the agent process, models exposed to QML
  qml/            panels, components, themes
  tests/          Qt Test (C++) and Qt Quick Test (QML)
  packaging/      per-platform deploy scripts, icons, Info.plist, NSIS
```

`local-agent/`, `shared/` and the provider configs are untouched and are built
by npm as now. The Qt build expects `local-agent/dist` to exist.

### Main process to C++ services

Each module under `desktop/main/` becomes one `QObject` service, registered
with QML. The 63 IPC handlers become its invokable methods and signals.

| Electron | Qt |
|---|---|
| `main.js` agent spawn, `codeProc`, JSON lines | `AgentProcess` (`QProcess`), one per session |
| `main/files.js` | `FileService` (`QFile`, `QDir`, `QFileSystemWatcher`) |
| `main/git.js`, `main/github.js` clone | `GitService` (`QProcess` running `git`, same safe-args rules) |
| `main/github.js` API, `github-api.js` | `GitHubService` (`QNetworkAccessManager`) |
| `main/build.js` | `BuildService` |
| `main/browser.js` (Chromium install) | `BrowserService` (runs Playwright's installer on bundled Node) |
| `main/run-window.js` | `RunService` and a native console window |
| `main/settings.js`, `safeStorage` | `SettingsStore` (`QSettings`) and `SecretStore` (QtKeychain) |
| `dialog.showOpenDialog` | `FileDialog` in QML |
| `shell.openExternal` | `QDesktopServices::openUrl` |

The pure modules in `desktop/` (`diff.js`, `plan-scale.js`, `scheduler.js`,
`step-timing.js`, `github-safe.js`, `preview-target.js`, `run-target.js`,
`flow.js`, `recent-workspaces.js`) are ported to C++ one for one. Their checks
in `local-agent/test/` move to `native/tests/` with them.

### The UI

One QML file per panel: Code, Chat, Plan, Build, Test, Research, Push, and
Settings. The rail, Console drawer and stage bar are shared components.

- **Markdown:** `QTextDocument::setMarkdown` (md4c, CommonMark with GitHub
  tables) for replies, reasoning and docs.
- **Code and diffs:** KSyntaxHighlighting *(default)* for highlighting. The
  diff view is drawn by a C++ item fed by the ported `diff.js`.
- **Themes:** a `Theme` singleton holding every colour and spacing token from
  `styles.css` and `theme.js`. The eight palette themes are data. Pixel and
  Terminal also swap a few components.

### Packaging

| OS | Tooling | Output |
|---|---|---|
| Linux | `linuxdeploy` + its Qt plugin | AppImage and `.deb` |
| Windows | `windeployqt` + NSIS | `CloseNI-Setup-x.y.z.exe` |
| macOS | `macdeployqt`, ad-hoc `codesign` | `.dmg` for arm64 and x86_64 |

`release.yml` gains a macOS job and builds the Qt app instead of running
`electron-builder` once the cut-over phase starts. Until then, it is unchanged.

## Phases

Each phase leaves both apps working.

0. **Skeleton.** `native/` with CMake. A QML window that finds bundled or
   system Node, spawns the agent and shows its `ready` event. CI builds it on
   Linux, Windows and macOS. *Exit:* green on all three; runs on Linux here.
1. **Code panel.** The product first: transcript, tool cards, the reasoning
   block, diffs, permission prompts, the message queue, Esc, slash commands
   and `@file`. *Exit:* a live DeepSeek agent run from the Qt app, with the
   same results as the Electron app on the same prompt.
2. **Provider and account.** Onboarding, the Chromium install, provider sign-in
   (headed browser through the agent), controls, Show Browser, Settings, and
   GitHub sign-in through the keychain.
3. **The planned build.** Chat, Plan, Build, Test, Research and Push, and the
   run console.
4. **Themes.** All eleven, checked by eye on Linux, and by CI screenshots on
   Windows and macOS.
5. **Packaging.** Installers for all three systems from a tag. The macOS
   `.dmg` is unsigned.
6. **Cut-over.** A parity checklist built from the README's feature list. Then
   delete `desktop/` and the Electron dependencies, port or retire `test:ui`
   and the e2e suite, and update the README, roadmap and changelog.

## Testing

- `local-agent` suites (`npm test`, `web-unit`, `verify`) are unchanged and
  keep passing throughout.
- New: Qt Test for every service and every ported pure module. Their checks are
  translations of the existing ones, so a count can be compared.
- `npm run test:ui` (48 checks, drives the Electron renderer over CDP) and
  `npm run test:e2e` are Electron-only. Phase 6 replaces them with Qt Quick
  Test, plus an end-to-end run of the Qt app against the mock provider.

## Non-goals

- Porting the agent, Playwright or the provider page control to C++.
- Signing or notarising for macOS (see decision 7).
- Mac App Store or Microsoft Store builds.
- A smaller download than today (see "Problem").

## Risks

- **Effort.** This is the largest sub-project so far: every panel is rebuilt.
  Phase 1 alone is the size of a past sub-project.
- **No Mac.** CI can build and unit-test on macOS, but nobody can click
  through it until someone with a Mac does.
- **Lost web preview** (decision 4).
- **Two apps in one tree** for the length of the port. Fixes to the Electron
  UI made meanwhile have to be made twice, so it should change as little as
  possible until cut-over.
