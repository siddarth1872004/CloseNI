# CloseNI native app: architecture and porting rules

The Qt app in `native/` replaces the Electron app in `desktop/` completely.
Electron is deleted once the Qt app has every feature. The design is in
`docs/superpowers/specs/2026-10-08-native-qt-design.md`. Where this file
disagrees with that spec, this file wins: it records later decisions.

## Hard rules

1. **No web engine, anywhere.** No QtWebEngine, QtWebView, WebView2 or WKWebView,
   and no HTML rendering of app UI. Every screen is native QML.
   - The Electron preview pane and the run window's `<webview>` become:
     - a native run console;
     - an "Open in browser" action, `App.openExternal(url)`, that hands the page
       to the system browser.
   - Markdown is shown with `Text.MarkdownText` or a native rendering.
2. **Lightweight.** The app must use as little disk, memory and CPU as it can:
   - **Qt modules:** only Core, Gui, Network, Qml, Quick and QuickControls2.
     Add QuickDialogs2 only for the native file and folder dialogs. Never add
     Widgets, WebEngine, Multimedia, 3D or Charts.
   - **Controls:** use `import QtQuick.Controls.Basic` only, so deployment
     ships one style.
   - **Panels:** each panel is a `Loader` that is active only while it is
     shown. State that must survive a panel closing lives in a singleton
     store (see below), not in the view.
   - **Bounded logs:** cap every log or transcript model, and drop the oldest
     entries. The Electron code's limits are the floor.
   - **No idle work:** no timers that tick while nothing is happening. No
     animations on hidden items. Avoid `layer.enabled` and `MultiEffect`
     except where a theme genuinely needs them.
   - **Release builds:** strip them, and deploy only the plugins in use (see
     packaging).
3. **Nothing is lost or broken.**
   - Every feature, message, edge case and guard in `desktop/` is ported.
   - The long comments in `desktop/` explain bugs that were really hit. Keep
     the reasoning next to the ported code.
   - When unsure, `desktop/` is the spec. `npm run test:ui` and the README's
     feature list describe what users rely on.
4. **The agent is unchanged.** `local-agent/` (Node and Playwright) is spawned
   exactly as `desktop/main.js` spawns it. It uses the same args, env,
   stdin/stdout protocol and storage directory. Do not modify `local-agent/`
   except to remove Electron-specific code during cut-over.

## Layout

```
native/
  CMakeLists.txt        globs src/*.{h,cpp} and qml/**/*.{qml,mjs}; adding a file needs no edit
  src/main.cpp          parses the command line, then loads CloseNI/Main
  src/Paths.*           storage root (same as Electron userData), Node, agent lookup
  src/Js.h              Js::reply(this, callback, result)
  src/<X>Service.*      one QML singleton per Electron main-process module (table below)
  src/Prefs.*           localStorage replacement
  src/platform/         SecretStore_{win,mac,linux}.cpp (picked by CMake)
  qml/Main.qml          the window: rail, top bar, panels, console, toasts, modals
  qml/singletons/*.qml  QML singletons (Theme, stores); CMake marks them automatically
  qml/components/*.qml  shared controls styled from Theme
  qml/panels/*.qml      one per panel (Code, Chat, Plan, Build, Test, Research, Push, Settings)
  qml/windows/*.qml     secondary windows (run console)
  qml/js/*.mjs          pure logic ported from desktop/*.js, as ES modules
  tests/                Qt Test suites (CMake picks up tests/CMakeLists.txt)
  smoke.cjs             starts the app against the mock provider
```

QML type names must be unique across the whole module, because subdirectories
do not namespace them.

## Services

Each Electron `ipcMain.handle` becomes a method on a C++ singleton with the
same arguments. Each `webContents.send(channel)` becomes a signal.

| QML name | Class | Ports | Owner |
|---|---|---|---|
| `Agent` | AgentService | main.js, main/browser.js | agent-backend |
| `Runner` | RunService | main/run-window.js | agent-backend |
| `Builds` | BuildStore | main/build.js | data-backend |
| `Files` | FilesService | main/files.js | data-backend |
| `Git` | GitService | main/git.js | data-backend |
| `GitHub` | GitHubService | main/github.js, github-api.js, github-safe.js | data-backend |
| `Library` | LibraryService | main/settings.js | data-backend |
| `Prefs` | Prefs | renderer localStorage | data-backend (Electron import) |
| `App` | AppService | process.platform, shell.openExternal, clipboard | done |

The headers in `src/` are the contract, and the method list mirrors
`desktop/preload.js`.
- **Owners** may add private members and helpers. Add public methods only when
  the Electron renderer used something the table missed.
- **Never** rename or remove a public method, because the UI calls it.
- **Stubs** reply `{ok:false, success:false, error:"not implemented yet: ..."}`.

### Calling a service from QML

```qml
import "../js/api.mjs" as Api
Api.call(Files, "listFiles", workspace).then(function (files) { ... })
Files.listFiles(workspace, function (files) { ... })   // same thing
Agent.codeEvent.connect(function (ev) { ... })         // or Connections { target: Agent }
```

- The result has exactly the JSON shape the Electron handler resolved with, so
  ported renderer code reads the same fields.
- In C++, every async method calls `Js::reply(this, callback, QVariantMap{...})`
  exactly once, on every path, including failures.

### Settings

`Prefs.get(key, fallback)` and `Prefs.set(key, value)` take and return strings.
They use the same keys the renderer used:
- `closeni.theme`, `closeni.theme.decor`, `closeni.provider`,
  `closeni.autonomy`, `closeni.persona`, `closeni.skills`
- `closeni.recent-workspaces`, `closeni.review-steps`, `closeni.showBrowser`,
  `closeni.console`
- `closeni.controls.<provider>`, and the onboarding dismiss key

JSON values stay JSON strings, as they were in localStorage. The values live in
`<storage>/native-prefs.json`.

The agent panels read what Settings decides from the `SettingsStore` singleton:
- `SettingsStore.autonomy` (`ask` | `auto` | `never`) is `CN.getAutonomy()`.
- `SettingsStore.buildPreamble()` is `CN.buildPreamble()`: a Promise of
  `{ persona?, skills?, mcpContext? }`.

The provider, its controls and Show Browser stay in `Providers`.

A callback whose result is a top-level list (for example `Files.listProviders`)
receives a Qt sequence, not an Array, so `Array.isArray` is false. Test for
`length` instead, or copy it with `Array.prototype.slice.call`.

## QML's JavaScript engine (Qt 6.11)

**Supported:** Promises, arrow functions, classes, `const`/`let`, destructuring,
template literals, optional chaining (`?.`), `??` and ES modules (`.mjs`).

**Not supported, so do not use:**
- `async`/`await`: chain `.then()` instead.
- Object spread and rest (`{...a}`): use `Object.assign`.
- `Array.prototype.flat`, `Object.fromEntries` and `globalThis`.

The pure modules in `desktop/*.js` are UMD wrappers around plain functions.
Port each one to `qml/js/<name>.mjs` with `export`.
`local-agent/test/desktop-unit.cjs` must then test the `.mjs` copies, either
through `import()` or through Node 22's `require(esm)`.

## Running and testing

- **Build.** Use a build directory of your own, not `build-native`, so that
  parallel work does not collide:

  ```
  cmake -S native -B build-<you> -G Ninja && cmake --build build-<you>
  ```
- **Logging.** Qt logs to journald on this machine. Run with
  `QT_FORCE_STDERR_LOGGING=1` to see `console.*` output and QML warnings.
- **Headless.** Use `QT_QPA_PLATFORM=offscreen` for runs that need no display.
- **Storage.** Never touch the real profile.
  - Always set `CLOSENI_STORAGE` to a scratch directory.
  - Use the mock provider (`local-agent/test/mock-provider.cjs`, see
    `smoke.cjs`) or `AGENT_PROVIDER_DIR` fixtures.
  - Never use the real DeepSeek profile, and never change
    `~/.config/CloseNI`. It may be read for migration testing: copy it to
    scratch first.
- **Worktrees.** `local-agent/dist` and `node_modules` are not present in a
  fresh worktree. Point at the main checkout with
  `CLOSENI_AGENT=/home/sidhu/Projects/CloseNI/local-agent/dist/index.js`.
- **Never** `pkill -f electron`. Never kill processes you did not start.
- **Commits.** Commit in your own branch. Use no co-author trailer, and do
  not push.
