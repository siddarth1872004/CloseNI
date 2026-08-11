# Releasing CloseNI

The release is driven by a tag. Everything else is automated by
[`.github/workflows/release.yml`](../.github/workflows/release.yml).

## Cutting a release

```bash
# 1. Everything green locally
npm run build
node local-agent/test/run-tests.cjs      # ~15s
node local-agent/test/run-e2e.cjs        # ~20min, drives a real browser

# 2. Write the release into CHANGELOG.md before tagging.
#    The tag is what people land on; an empty changelog entry is permanent.

# 3. Bump and tag. `npm version` edits package.json and creates the tag
#    together, which is what keeps the two from drifting.
npm version 1.0.1 -m "Release %s"

# 4. Push the commit and the tag
git push && git push --tags
```

The workflow then runs on `windows-latest` and `ubuntu-latest`, and publishes a
**draft** release with the installers attached. Review it, paste the changelog
entry in as the release notes, and publish.

## What the workflow guards

- **The tag must match `package.json`.** A `v1.0.1` tag on a `1.0.0`
  `package.json` produces installers named `1.0.0`, which is only ever noticed
  after publishing. The job fails instead.
- **Unit tests run before packaging**, so a broken build config never produces
  an artifact.
- **The two OS jobs are serialised** (`max-parallel: 1`). Both publish into the
  same release and electron-builder creates it when missing; run them at once
  and they race, leaving one job's artifacts on a release the other replaced.
- **Installers are also uploaded as workflow artifacts**, kept 30 days, so a
  draft deleted by accident does not mean rebuilding from the tag.

## Artifacts

| Platform | File | Built on |
|---|---|---|
| Windows | `CloseNI-Setup-<version>.exe` (NSIS) | `windows-latest` |
| Linux | `CloseNI-<version>.AppImage` | `ubuntu-latest` |
| Linux | `closeni_<version>_amd64.deb` | `ubuntu-latest` |

Installers are **unsigned**. Windows SmartScreen will warn about an
unrecognised publisher, and that warning is correct — say so in the release
notes rather than leaving people to guess.

## Building locally

```bash
npm run pack     # unpacked directory only, fastest way to check packaging
npm run dist     # installers for the current platform
```

Windows installers cannot be produced from Linux without Wine; that asymmetry
is the reason the workflow exists.

## Verifying a build before publishing

The packaged `files` list is an **allow-list**. Widening it to a glob would
sweep `local-agent/storage/` — live session cookies and private chat URLs —
into a public artifact. Confirm that has not happened:

```bash
# Nothing from storage/ may appear. Expect no output.
npx asar list dist/linux-unpacked/resources/app.asar \
  | grep -iE "storage/|sessions\.json|last-chat-url|browser-profiles"

# And the things that must be there
npx asar list dist/linux-unpacked/resources/app.asar \
  | grep -E "local-agent/dist/index.js|desktop/main.js|node_modules/playwright"
```

Then confirm the packaged app actually starts and its renderer loads, rather
than only that the process survives:

```bash
./dist/linux-unpacked/closeni --no-sandbox --remote-debugging-port=9333 &
curl -s http://127.0.0.1:9333/json/list | grep -o '"title":"[^"]*"'
# → "title":"CloseNI"
```

On WSL, `ERROR:viz_main_impl.cc … Exiting GPU process` is software-rendering
noise and not a failure.

## Status of the 1.0.0 verification

| Check | Linux | Windows |
|---|---|---|
| Installer builds | verified | verified — CI, v1.0.0 |
| No session data in the artifact | verified | verified |
| Packaged app launches, renderer loads | verified | verified — started on Windows 11 |
| Installer actually installs | n/a (AppImage) | **not yet — nobody has run it** |

The Windows *application* has been packaged and started on a real machine. The
NSIS *installer* that wraps it was first produced by CI for v1.0.0 and has not
been installed by anyone. That is the one remaining unknown on Windows, and it
stays listed until someone runs it.
