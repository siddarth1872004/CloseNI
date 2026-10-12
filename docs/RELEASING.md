# Releasing CloseNI

CloseNI's native Qt installers are built by
[release.yml](../.github/workflows/release.yml) when a version tag is pushed.
The workflow builds Windows x64, Linux x64, and macOS arm64/x64 packages,
tests the built agent, smoke-tests the packaged Linux AppImage, then creates
or updates a **draft GitHub Release** with all installers and SHA-256 checksums.

## Before choosing the release version

Check the branch, tag, and version together. The current release workflow
packages the Qt/C++ application in `native/`; do not use an old Electron
release branch or its build instructions for these installers.

```bash
git switch main
git pull --ff-only
node -p "require('./package.json').version"
git tag --list 'v*' --sort=-version:refname | head
```

Pick the intended version from the changelog and release plan. Do not create a
tag until the release commit's root, `local-agent/`, and `shared/` package
versions agree and the changelog entry is complete.

## Preflight on the release commit

Use Node 22 and install dependencies from the committed lockfile:

```bash
npm ci
npm run build
node local-agent/test/run-tests.cjs
node local-agent/test/run-e2e.cjs
cmake -S native -B build-native -G Ninja
cmake --build build-native
ctest --test-dir build-native --output-on-failure
node native/e2e-build.cjs
node native/tests/code-e2e.cjs
node native/tests/chats-e2e.cjs
```

The browser E2E suite can take around twenty minutes. Packaging also needs Qt
6.8+ (CI installs Qt 6.10), CMake 3.21+, Ninja, and target-specific tooling.
Run `npm run verify` against a staged package when testing a packaging change.

## Tag and build the release

1. Update all three package versions, refresh the npm lockfile, and write the
   complete entry at the top of `CHANGELOG.md`.
2. Commit and review the release commit. Confirm the version fields agree.
3. Push a versioned tag that exactly matches the root package version, e.g.
   `vX.Y.Z`. The tag is immutable release input; do not retarget it to fix a
   broken build. Use a new version instead.
4. Wait for the `release` workflow to complete. It must build all four targets
   and pass the Linux packaged smoke test before the publish job runs.
5. Review the draft release, open the installers on the target systems, compare
   `SHA256SUMS.txt`, add the relevant changelog notes and publish manually.

```bash
# Only after the release commit is approved and all checks pass:
git push origin main
git push origin vX.Y.Z
```

## Native release artifacts

| Platform | Asset |
|---|---|
| Windows x64 | `CloseNI-Setup-<version>.exe` |
| Linux x64 | `CloseNI-<version>.AppImage` |
| Linux x64 | `closeni_<version>_amd64.deb` |
| macOS Apple silicon | `CloseNI-<version>-arm64.dmg` |
| macOS Intel | `CloseNI-<version>-x64.dmg` |
| Integrity | `SHA256SUMS.txt` |

The packages bundle the Qt modules used by the application, Node 22, and the
compiled local agent. Chromium downloads on first use and is not included in
installers. Installers are unsigned; Windows SmartScreen and macOS Gatekeeper
may warn or block first launch. Do not describe them as signed or notarised.

Linux is built on Ubuntu 22.04 for a glibc 2.35 baseline. CI keeps installer
artifacts for 30 days in addition to attaching them to the draft release.

## If a release fails

- Fix the cause on a new commit and build a new version/tag; never move an
  existing public tag.
- A failed package job must not result in a published release. Fix the job and
  rerun it for the same tag only when the source at that immutable tag is
  already correct.
- Confirm each expected file exists before publishing, and confirm the
  checksum file includes every installer exactly once.
- Windows and macOS installers are not considered fully verified until they
  have been installed and launched on their respective platforms. Record
  install/upgrade/uninstall testing separately from “installer built”.
