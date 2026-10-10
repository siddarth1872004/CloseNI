# CloseNI native app: architecture and rules

The app in `native/` is Qt Quick and C++. It starts the agent in
`local-agent/` (Node and Playwright) as a child process and talks to it over
stdin and stdout.

## Hard rules

1. **No web engine, anywhere.** No QtWebEngine, QtWebView, WebView2 or WKWebView,
   and no HTML rendering of app UI. Every screen is native QML.
   - A running project is shown in a native run console, and "Open in
     browser" (`App.openExternal(url)`) hands a web project to the system
     browser.
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
     A `ListView` inside anything a `Loader` can switch off sets
     `cacheBuffer: 0`. The look-ahead delegates it would otherwise build are
     built asynchronously, and a Loader clears the panel's context at once but
     deletes the panel later, so a build still in flight fails with "Object or
     context destroyed during incubation". Only the Code panel, which is never
     unloaded, keeps a cache.
   - **Bounded logs:** cap every log or transcript model, and drop the oldest
     entries.
   - **No idle work:** no timers that tick while nothing is happening. No
     animations on hidden items. Avoid `layer.enabled` and `MultiEffect`
     except where a theme genuinely needs them.
   - **Release builds:** strip them, and deploy only the plugins in use (see
     packaging).
3. **Nothing is lost or broken.**
   - The long comments in the code explain bugs that were really hit. Keep
     the reasoning next to the code it explains.
   - The README's feature list, `local-agent/test/app-unit.cjs`,
     `scripts/verify.mjs` and the end-to-end flows describe what users rely on.
4. **The agent protocol is fixed.** `AgentService` spawns `local-agent/` with
   its args, env, stdin/stdout protocol and storage directory. Do not change
   that protocol to suit the app.

## Layout

```
native/
  CMakeLists.txt        globs src/*.{h,cpp} and qml/**/*.{qml,mjs}; adding a file needs no edit
  src/main.cpp          parses the command line, then loads CloseNI/Main
  src/Paths.*           storage root, Node, agent lookup
  src/Js.h              Js::reply(this, callback, result)
  src/<X>Service.*      one QML singleton per service (table below)
  src/Prefs.*           the app's settings, in native-prefs.json
  src/platform/         SecretStore_{win,mac,linux}.cpp (picked by CMake)
  qml/Main.qml          the window: rail, top bar, panels, console, toasts, modals
  qml/singletons/*.qml  QML singletons (Theme, stores); CMake marks them automatically
  qml/components/*.qml  shared controls styled from Theme
  qml/panels/*.qml      one per panel (Code, Chat, Plan, Build, Test, Research, Push, Settings)
  qml/windows/*.qml     secondary windows (run console)
  qml/js/*.mjs          pure logic as ES modules, shared with Node
  tests/                Qt Test suites (CMake picks up tests/CMakeLists.txt)
  smoke.cjs             starts the app against the mock provider
  e2e-build.cjs         a build end to end against the mock provider
  tests/code-e2e.cjs    the Code panel end to end against the mock provider
  tests/chats-e2e.cjs   the rail's conversations end to end: new, switch, rename, remove, restart
```

QML type names must be unique across the whole module, because subdirectories
do not namespace them.

## Services

Each service is a C++ singleton. Async methods take a JS callback; events
are signals.

| QML name | Class | Does |
|---|---|---|
| `Agent` | AgentService | the agent process, sign-in, browsers |
| `Runner` | RunService | running a project and its console |
| `Builds` | BuildStore | build state and resume |
| `Files` | FilesService | workspace files, sessions, chats and transcripts |
| `Git` | GitService | git, without a shell |
| `GitHub` | GitHubService | sign-in, repositories, push, Actions |
| `Library` | LibraryService | skills, personas, MCP |
| `Prefs` | Prefs | settings |
| `App` | AppService | platform, open externally, clipboard |

The headers in `src/` are the contract. Add a public method when the UI needs
one; never rename or remove one the UI calls.

### Calling a service from QML

```qml
import "../js/api.mjs" as Api
Api.call(Files, "listFiles", workspace).then(function (files) { ... })
Files.listFiles(workspace, function (files) { ... })   // same thing
Agent.codeEvent.connect(function (ev) { ... })         // or Connections { target: Agent }
```

- In C++, every async method calls `Js::reply(this, callback, QVariantMap{...})`
  exactly once, on every path, including failures.

### Settings

`Prefs.get(key, fallback)` and `Prefs.set(key, value)` take and return strings.
The keys:
- `closeni.theme`, `closeni.theme.decor`, `closeni.provider`,
  `closeni.autonomy`, `closeni.persona`, `closeni.skills`
- `closeni.recent-workspaces`, `closeni.review-steps`, `closeni.showBrowser`,
  `closeni.console`
- `closeni.controls.<provider>`, and the onboarding dismiss key

JSON values are stored as JSON strings. The values live in
`<storage>/native-prefs.json`.

The agent panels read what Settings decides from the `SettingsStore` singleton:
- `SettingsStore.autonomy`: `ask` | `auto` | `never`.
- `SettingsStore.buildPreamble()`: a Promise of
  `{ persona?, skills?, mcpContext? }`.

The provider, its controls and Show Browser stay in `Providers`.

`Js::reply` converts lists and maps at any depth into real JS Arrays and
objects, so `Array.isArray` works on every result. Reply through it; never pass
`engine->toScriptValue` of a QVariantList straight to QML, because that is a Qt
sequence that `Array.isArray` rejects.

## QML's JavaScript engine (Qt 6.11)

**Supported:** Promises, arrow functions, classes, `const`/`let`, destructuring,
template literals, optional chaining (`?.`), `??` and ES modules (`.mjs`).

**Not supported, so do not use:**
- `async`/`await`: chain `.then()` instead.
- Object spread and rest (`{...a}`): use `Object.assign`.
- `Array.prototype.flat`, `Object.fromEntries` and `globalThis`.

The pure modules are `qml/js/<name>.mjs` with `export`. The unit suites test them through Node
22's `require(esm)`, and `local-agent/test/app-unit.cjs` checks that every
one stays inside what this engine supports.

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
    `~/.config/CloseNI`.
- **Worktrees.** `local-agent/dist` and `node_modules` are not present in a
  fresh worktree. Point at the main checkout with
  `CLOSENI_AGENT=/home/sidhu/Projects/CloseNI/local-agent/dist/index.js`.
- **Never** `pkill` by pattern. Never kill processes you did not start.
- **Commits.** Use no co-author trailer.
