# Releasing CloseNI

The release is driven by a tag. Everything else is automated by
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which
builds the native Qt app's installers with
[`native/package/stage.mjs`](../native/package/stage.mjs).

## Cutting a release

```bash
# 1. Everything green locally
npm run build
node local-agent/test/run-tests.cjs      # ~15s
node local-agent/test/run-e2e.cjs        # ~20min, drives a real browser
cmake -S native -B build-native -G Ninja && cmake --build build-native
ctest --test-dir build-native
node native/e2e-build.cjs                # the app runs a build, mock provider
node native/tests/code-e2e.cjs           # the Code panel, mock provider
node native/tests/chats-e2e.cjs          # the rail's conversations, mock provider

# 2. Write the release into CHANGELOG.md before tagging.
#    The tag is what people land on; an empty changelog entry is permanent.

# 3. Bump and tag. `npm version` edits package.json and creates the tag
#    together, which is what keeps the two from drifting. CMake reads its
#    version from package.json, so the app reports the same one.
npm version 1.0.1 -m "Release %s"

# 4. Push the commit and the tag
git push && git push --tags
```

The workflow runs the unit suite, builds each system's installers on that
system, and publishes one **draft** release with all of them attached, plus
`SHA256SUMS.txt`. Review it, paste the changelog entry in as the release notes,
and publish.

## What the workflow guards

- **The tag must match `package.json`.** A `v1.0.1` tag on a `1.0.0`
  `package.json` produces installers named `1.0.0`, which is only ever noticed
  after publishing. The job fails instead, and `stage.mjs` also checks that
  the built app reports the `package.json` version.
- **Unit tests run before packaging**, so a broken build never produces an
  artifact.
- **One job publishes**, after every installer is built. The build jobs only
  upload workflow artifacts; they cannot write to the repository. A re-run
  replaces the files on the draft it already made.
- **The Linux AppImage is smoke-tested as shipped**: bundled Node and agent,
  Chromium in the storage directory, a Code session against the mock provider
  (`node native/smoke.cjs --packaged <AppImage>`).
- **Installers are also kept as workflow artifacts** for 30 days, so a draft
  deleted by accident does not mean rebuilding from the tag.
- **Every download is pinned.** Node and the AppImage tools are fetched by
  `stage.mjs` and checked against SHA-256 sums in
  [`native/package/app.json`](../native/package/app.json); Node is also checked
  against its release's `SHASUMS256.txt`.

## Artifacts

| Platform | File | Built on |
|---|---|---|
| Windows x64 | `CloseNI-Setup-<version>.exe` (NSIS, per user) | `windows-latest` |
| Linux x64 | `CloseNI-<version>.AppImage` | `ubuntu-22.04` |
| Linux x64 | `closeni_<version>_amd64.deb` | `ubuntu-22.04` |
| macOS Apple silicon | `CloseNI-<version>-arm64.dmg` | `macos-15` |
| macOS Intel | `CloseNI-<version>-x64.dmg` | `macos-15` |

Linux is built on the oldest supported runner so the AppImage and the .deb run
on any distribution with glibc 2.35 or newer.

Each package holds the app, the Qt it uses (Qt Quick with the Basic style, no
web engine, no translations), Node 22 and the compiled agent with the one
package it needs at run time (Playwright). Chromium is not bundled: the app
downloads it into `<storage>/browsers` on first use, as before.

Installers are **unsigned**. Windows SmartScreen warns about an unrecognised
publisher, and macOS Gatekeeper refuses to open an app from an unidentified
developer until it is allowed in System Settings > Privacy & Security (the
.app is signed ad hoc, which is all an unsigned build can be). Say so in the
release notes rather than leaving people to guess.

### Upgrading from the Electron app (0.3.0 and before)

- **Windows:** the installer runs the Electron version's uninstaller first,
  with `/KEEP_APP_DATA`, then installs into the same
  `%LOCALAPPDATA%\Programs\CloseNI`. An Electron version installed for all
  users needs administrator rights to remove, so it is left in place and the
  installer says so.
- **Linux:** the .deb replaces the old package (`closeni`), and installs to
  `/opt/CloseNI` with `closeni` on PATH.
- **All systems:** sign-ins, sessions and downloaded browsers stay where they
  were, since the native app uses the same storage directory. Settings the
  Electron app kept in its localStorage are imported once, on first run,
  best-effort. The GitHub token has to be entered once more: Electron's
  safeStorage copy cannot be read outside Electron, and the new one goes in
  the OS keyring.

## Building locally

```bash
npm run build    # the agent, which every package bundles
npm run pack     # stage the app into dist/native/ (no installers)
npm run dist     # stage it and build this system's installers
```

Both need Qt 6.8 or newer (`qtpaths` on PATH, or `QT_ROOT_DIR`), CMake, and on
Linux `patchelf`; on Windows NSIS (`choco install nsis`). The header of `stage.mjs`
lists the options; `--exe <built CloseNI>` stages an existing build instead of
building one. Each system's installers can only be built on that system.

## Verifying a build before publishing

`npm run verify` audits the staged app (`dist/native/stage.json` and the
directory it names): no session data, `.env` or `.git`; the agent's dist,
config and exactly its run-time packages; Node 22; the Basic style only; no
web engine, translations or software OpenGL.

Then run the packaged app the way a user gets it, against the mock provider:

```bash
CLOSENI_SMOKE_BROWSERS=~/.cache/ms-playwright \
  node native/smoke.cjs --packaged dist/native/out/CloseNI-<version>.AppImage
```

Without `CLOSENI_SMOKE_BROWSERS` the app downloads Chromium itself, as a first
run does.

## Status of the native packages

| Check | Linux | Windows | macOS |
|---|---|---|---|
| Installer builds | verified locally | CI only | CI only |
| Staged app passes the audit | verified | not yet | not yet |
| Packaged app runs a Code session | verified (AppImage and .deb payload) | not yet | not yet |
| Installer installs, upgrades, uninstalls | n/a (AppImage); .deb not installed | **not yet** | **not yet** |

Windows and macOS stay unverified until someone installs the first CI build.
