# Next session — plan

Six areas, ordered so that what unblocks other work happens first, and the one
task with dead time starts before anything that has to wait on it.

---

## 0 · First thing: cut the release, then walk away from it

```bash
git tag v1.0.0 && git push --tags
```

CI takes roughly ten minutes to build the Windows `.exe` on a Windows runner and
the AppImage and `.deb` on Ubuntu. **Start it before anything else** — everything
below fills that time, and the artefacts are waiting when you come back.

Nothing here has ever been verified: no installer has been launched, on any
platform. Expect the first tag to fail on something small.

When it finishes:

- [ ] All three artefacts attached to the Release
- [ ] Run the Windows `.exe` — SmartScreen warns; More info → Run anyway
- [ ] First launch shows the browser-download gate and completes it
- [ ] `%APPDATA%/CloseNI/` gets `browsers/` and `sessions.json`
- [ ] Run the AppImage: `chmod +x` then execute

**Likely first failure:** the packaged app spawns the agent on Electron's own
binary via `ELECTRON_RUN_AS_NODE`. That path is verified on Linux from source and
never in a packaged build on Windows.

---

## 1 · Provider tests — the gate on everything else

This is first for real work because **two of three providers have never been
driven end to end**, and complex-project testing is meaningless if the provider
underneath is broken.

For **each** of DeepSeek, Qwen Studio, GLM:

- [ ] Sign in — profile appears under `<userData>/browser-profiles/<id>/`
- [ ] Chat — a reply comes back and renders
- [ ] Plan — parses, step count looks sane, `dependsOn` present
- [ ] Build a two-step project — files land, syntax checks run
- [ ] Provider controls — model/thinking actually change in the UI
- [ ] Stop-button completion — check the log says "stop button" not "stable for"

### Known problems to expect

| Provider | Expect |
|---|---|
| **DeepSeek** | `sendButton` selector misses; falls back to Enter, works. Deep thinking / Smart Search report **not found** — selectors need re-capturing. |
| **Qwen** | Controls written from screenshots, never run. Ant Design popups may not open headless. |
| **GLM** | **Chat selectors have never been checked against the live site.** If it hangs or sends nothing, fix `chatInput`/`sendButton` in `glm.json` first — a text edit, not code. |

For anything that fails:

```bash
source scripts/wsl-env.sh
node scripts/capture-provider-ui.mjs <provider>
```

That opens the provider with its saved profile, clicks the menu triggers itself,
and reports every candidate control with its selectors and readable state.

---

## 2 · The four unverified fixes

Fast, and they gate the complex-project work. Rerun the Flask build from the last
session **with autonomy on Ask**.

- [ ] **`sudo` / `apt` now prompt** rather than running silently — deny them
- [ ] The build **gets past step 1** instead of dying on the virtualenv
- [ ] Steps 2–15 actually run (last time all fourteen were blocked)
- [ ] **New Chat** clears the messages and the plan sidebar
- [ ] Break a file mid-build, then **Retry Failed** → log says
      `resuming: N/M already done` and it continues rather than restarting
- [ ] The model no longer writes `run.sh` — log says `IGNORING_GENERATED` if it tries

---

## 3 · Complex projects and scenarios

Only meaningful once 1 and 2 pass.

**Scale:** a full-stack app — API, database, migrations, tests, frontend. Expect
15–25 steps. Watch for prompt-size growth across steps and whether the delta
still fires late in a long build.

**Concurrency:** a plan with genuinely independent branches, limit 2 then 3.
Does the provider rate-limit? A throttled session looks like a slow reply, not an
error — that is the failure mode to watch for.

**Recovery:** kill the app mid-build and reopen. Break a dependency so a step
fails and check the blocked cascade is honest about what never ran.

**Languages:** a Rust project with `Cargo.toml` (one `cargo check`, not one per
file) and a Java one. Neither compiled language has been built end to end.

**Adversarial:** a request the model will answer in prose rather than JSON; a
project needing a package that cannot be installed; a plan over 40 steps
(should be rejected and re-asked, not truncated).

---

## 4 · Onboarding for first-time users

Deliberately **after** 1–3: the right onboarding is the one that removes the
friction those sessions actually hit, not the friction imagined beforehand.

What a first launch currently drops someone into: no workspace, no provider
signed in, no chat, and a Build button that will not work. Nothing explains the
order.

Sketch — to be confirmed against what testing reveals:

1. Welcome, with what this is and that it needs a provider account
2. Download the browser (already built; currently the only first-run step)
3. Pick a workspace
4. Choose a provider and sign in, with the window explained before it opens
5. A worked first prompt

Also worth deciding: whether an empty state in each panel should explain that
panel, instead of Builder's current single line of text.

---

## 5 · UI refinement

Collect issues **while doing 1–3** rather than hunting for them. Already known:

- Nine themes have never been looked at across every panel. Paper and High
  contrast are where an un-tokenised colour shows; the diff view hides one
  longest.
- Pixel motion has never been seen by a human — it may read as broken rather
  than intentional.
- The Test panel and the parallel-step display are both unverified.
- Provider control failures now log once and quietly; confirm that reads well.

---

## 6 · GitHub Pages refinement

Independent of everything else; fill gaps with it.

- [ ] Turn it on: **Settings → Pages → `main` / `/docs`**
- [ ] Real screenshots once the UI is verified — the app in two or three themes
- [ ] Download links point at real artefacts once section 0 succeeds
- [ ] Check it on a phone, and in light mode
- [ ] Consider a short screen recording of a build

---

## Still on the roadmap

**Items 13 (MCP) and 15 (skills, personas)** are the only roadmap gaps left —
26 of 28 done. The spec is written
(`specs/2026-08-10-skills-and-mcp-design.md`); there is no plan or code.

Item 15 is the more valuable: it turns "write better code" into editable `.md`
files instead of four lines hardcoded in `buildPrompt`. Item 13 is real but
structurally awkward — the model drives a chat window, so MCP can only be a
context provider that runs before a build.

Neither is worth starting before sections 1–3 pass. A feature built on an
unverified foundation is a feature built twice.
