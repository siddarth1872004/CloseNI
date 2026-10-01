# CloseNI — roadmap to 1.0

Written 30 September 2026, after the first live runs of the coding agent against
DeepSeek. It replaces the open parts of `NEXT.md`, `NEXT-SESSION.md` and
`HANDOFF.md` as the single list of what is left. `ROADMAP.md` stays as the record
of what was built.

---

## What "complete" means

CloseNI 1.0 is done when **a stranger can download it, install it, sign in to a
chat site, and have the coding agent finish a real task, without reading the
source.** Concretely, all of these hold:

1. **The coding agent is reliable on DeepSeek.** It passes the live scenario suite
   (Phase 1) twice in a row, on two different days.
2. **Every provider the app offers works.** A provider that doesn't work is gated
   or removed. Nothing in the UI is a control that does nothing.
3. **Every feature the UI shows has run live at least once.** This covers GitHub
   push and clone, the planned build, Research and Needle. A feature that
   can't be proven is hidden or removed.
4. **Installers for Windows and Linux have been installed and launched by a
   person.** The first-run flow completes on a clean machine.
5. **The docs say what is true.** The README's limitations list, the CHANGELOG
   and the landing page all match the shipped build.
6. **The codebase can be picked up by someone else.** It has one planning doc,
   no dead modules, and tests that run in CI on every push.

Anything not needed for those six goes to [After 1.0](#after-10).

---

## Where things stand (30 September 2026)

| Area | State |
|---|---|
| Version | `0.1.0`, unreleased. No git tags. Three earlier 1.0.x builds were published and then withdrawn. |
| Branch | `fix/venv-rewrite-and-empty-reply`: 21 files and about 1.8k lines uncommitted (selector and parser sweeps, fence rules, the agent nudge fix) |
| Unit tests | 1830 passing (`npm test`) |
| Coding agent, live | **Worked** on a first DeepSeek run: wrote a todo CLI, built a venv, 13/13 pytest, then ran the demo. Five defects were found along the way (see Phase 1). |
| Planned build, live | Worked on 11 August (3/3 steps). A 15-step Flask build later exposed venv failures, which are fixed but not re-verified. |
| DeepSeek | Works. `sendButton` misses (Enter is used instead), and the Mode control does nothing. |
| Qwen Studio | Gated: completion wait too short for a thinking model |
| GLM | Gated: selectors never confirmed, and the site declines build prompts |
| Ollama | Works for Chat only. Refused by plan and build. |
| Browser-native layer (`src/web/`) | Built and passes its fixtures. Has never met a live site, and nothing uses it. |
| Needle extraction | Built, off by default. The real model has never run. |
| GitHub (sign-in, push, clone, Actions) | Unit-tested only. Zero live requests. |
| Installers | Linux AppImage and `.deb` packed and launched headless. The Windows NSIS installer has never been installed. |
| VS Code extension | `vscode-extension/`: 97 lines, still named "Agentic Web Coder", predates the agent |
| UI | Eleven themes, and most have never been looked at by a person |

---

## The critical path

```
Phase 0  Land what's in flight
   │
Phase 1  Coding agent reliable on DeepSeek   ◄── the product; everything waits on this
   │
   ├── Phase 2  Providers (Qwen, GLM, Ollama for the agent)
   ├── Phase 3  Decide the browser-native layer's fate
   ├── Phase 4  Planned-build mode: verify or demote
   ├── Phase 5  Needle: prove or remove
   └── Phase 6  GitHub integration, live
   │
Phase 7  UI pass, by a person
   │
Phase 8  Codebase and docs cleanup
   │
Phase 9  Safety, legal and privacy review
   │
Phase 10 Release 1.0
```

Phases 2–6 are independent and can go in any order. Phase 7 comes after them,
because the UI should only be polished once it's known which features survive.

Sizes are rough: **S** is under half a day, **M** is one to two days, **L** is
three days or more.

---

## Phase 0 — Land what's in flight

**Goal:** a clean `main` with every current fix in it, and CI that runs tests.

- [x] **0.1 Commit the uncommitted work** on `fix/venv-rewrite-and-empty-reply`
      in logical commits (S):
  - parser: CommonMark `fencedBlocks`, JSON-repair linear passes (`fenced-files.ts`, `json-repair.ts`)
  - controller: DOM readers keep list items, inline code and tables (`playwright-controller.ts`)
  - agent: the four-backtick rule in the preamble, and no nudge after a terminal session (`protocol.ts`)
  - the rest of the modified files: mode, language and context work from earlier sessions
  - new files: `context/defined-names.ts`, `step-prompt.ts`, `test/fixtures/chat-labelled.html`
- [x] **0.2 Sign in `gh`** (`gh auth login`; `gh` lives in `~/.local/bin`). Open a
      PR into `main` and merge it (S).
- [x] **0.3 Add a test workflow** `.github/workflows/test.yml`. It runs on every
      push and PR: `npm ci`, `npm run build`, `npm test`, `npm run verify`,
      and `npm run test:web` and `npm run test:ui` under `xvfb-run`. Today only
      `release.yml` exists, so nothing checks a PR (M). *1 Oct:* its first
      runs failed one check, because verify audits the packaged app and CI
      never built one. CI now runs `npm run pack` before verify. The same
      pushes showed the Pages site had failed to build since 29 September:
      Jekyll read `{{` in a plan's test code. `docs/.nojekyll` turns Jekyll
      off, since the site is plain HTML.
- [x] **0.4 Decide whether e2e runs in CI.** It takes about 15 minutes (S).
      **Decided (D11):** a separate job on pull requests and by hand
      (`workflow_dispatch`), not on every push.
- [x] **0.5 Move the parse-sweep and selector-sweep checks into the suite.** The
      scratch scripts found real bugs: parse-sweep was 29/30, and its one known
      failure is a JSON object that comes before the files object. They should
      become permanent cases in `local-agent/test/run-tests.cjs` (M). Done:
      the parsing, reader and selector sweeps are sections of the unit suite,
      and the leading-object case is fixed.

**Exit:** `main` is green in CI, and no work exists only in a working tree.

---

## Phase 1 — The coding agent, reliable on DeepSeek

**Goal:** the default panel does real work without a human babysitting the
protocol. This is the product, and everything else is secondary.

### 1A · Fix what the first live runs found

- [x] **1.1 Nested fences cut writes short.** A README that contains code blocks
      was truncated at its first inner fence, silently, and a later edit to it
      leaked into the prose. The fix is a preamble rule telling the model to use
      four backticks when the payload contains fences
      (`local-agent/src/agent/protocol.ts`). **Still to do:** confirm it on a
      live run that writes a Markdown file.
- [x] **1.2 Guard against silent truncation anyway** (S–M). The prompt rule
      is advice, not a guarantee. In `readBlock` (`protocol.ts`), refuse a
      `write` whose payload opens a fence and never closes it, and whose
      block was followed by prose that looks like the rest of the file. Send
      back a `BadCall` asking for a resend with ```` ```` ````. The same
      check applies to an `edit` whose REPLACE is unterminated. It should
      error back to the model, never guess. Done, without the prose test: an
      open fence alone is enough for a `write`. For an `edit`, the open fence
      must be in a last section that has no closing marker, because a SEARCH
      may quote half a code block.
- [x] **1.3 False "pasted code" nudge.** A `$ command` demo block triggered an
      extra round trip. It is fixed, with a test. **Still to do:** confirm it
      live.
- [x] **1.4 Bash results hide pipeline failures** (S). `pytest | tail`
      reports "exit 0" while pytest fails. `runCommand`
      (`verification/command-runner.ts`) spawns with `shell: true`, which is
      `/bin/sh`. For the agent's bash tool only, use `bash -o pipefail -c` where
      bash exists, and fall back to `sh` otherwise. The model sees the output
      either way, but the UI's "exit 0" misleads the user. Done. Exit 141 (a stage
      stopped by SIGPIPE, as in `cat log | head`) still counts as success.
- [ ] **1.5 DeepSeek `sendButton`** (S). It matches only `<button>`, and
      DeepSeek's send control is a div, so every prompt logs "No send button
      found". Re-capture it with `node scripts/capture-provider-ui.mjs deepseek`
      and update `config/providers/deepseek.json`. Or, if the only stable
      selector is a hashed class, drop `sendButton` and make Enter the
      documented path. That is the "need fewer selectors" rule in `NEXT.md`.
- [x] **1.6 DeepSeek Mode control does nothing** (S). The
      `[role="radiogroup"] [data-model-type]` selector points at UI DeepSeek
      no longer has. Remove `controls[0]` and `controlSelectors.modeOption`,
      and make the smoke test report it absent rather than broken.
- [ ] **1.7 Deep thinking timeouts** (S). Deep thinking on large prompts has hit
      the 300s wait. Either raise the wait while the reply stream is still open
      (the stream says the model is working), or default Deep thinking off for
      agent turns. **Decided (D1):** off for agent turns.

### 1B · Things that will break on longer sessions (not yet seen, but certain)

- [ ] **1.8 Long threads** (M–L). The agent keeps one DeepSeek conversation
      per project, and every tool result is appended to it. Nothing manages
      its length. The 30-step cap in `loop.ts` bounds one turn, not the
      thread. Needed:
  - Measure first: at what thread length does DeepSeek start forgetting the
    tool convention, or refuse? Use the scenario suite below with a long
    follow-up chain.
  - Then: when a thread passes a budget, start a new chat. Seed it with the
    preamble, `CLOSENI.md`, the todo list, a list of the files touched, and a
    short summary the model writes on request. This is `/compact`. The
    context-limit detection from `NEXT.md` §3 is where the trigger comes from.
      *Mechanism done; the measurement is still open.* Each chat's size is
      tracked (per project for DeepSeek). Past 80% of the budget
      (`contextBudgetChars`, default 150k characters), the agent asks the
      model for a summary under 400 words, starts a new chat, and seeds it
      with the preamble, that summary, the todo list and the files it changed.
      That happens between turns or between steps; a chat's first message is
      never rolled over. `/compact` does it by hand. `/clear` now also resets
      the size and the ledger. The budget is a guess until the measurement
      above is made.
- [x] **1.9 Tool-convention drift** (M). Count, per session, how many replies
      had malformed or missing tool blocks, and log the count. If drift rises
      with length, send `TURN_REMINDER` more strongly, or re-send the tool list
      every N turns.
      *Counting done:* the loop counts replies, malformed calls and nudged
      replies, and which reply number each was. The count goes out with
      `done`, and the agent logs `AGENT_DRIFT` when either is non-zero. Whether
      drift rises with length is for the 20+ turn scenario (1C, row 8).
- [x] **1.10 Big outputs** (S). Results are capped at 6000 characters for display.
      Check what the *model* receives for a 5 MB test log or a huge `read`, and
      make sure the cap is the same and says so ("…truncated, N lines omitted").
      *Done:* the model gets 24 KB, head and tail, cut on line ends, with
      "[... N lines, M characters omitted ...]". The command runner keeps only
      512 KB of each end of a stream (a flood used to be held whole), and a
      second cut adds up the first's count. `read` stops at a whole line inside
      the budget so its "offset N" is right, and refuses files over 64 MB.
- [ ] **1.11 Windows commands** (M). `shell: true` on Windows means `cmd.exe`,
      but the tool is called `bash` and the model writes bash. Choose one:
  - tell the model the real shell in the preamble (Platform is already sent; add "commands run in cmd.exe");
  - or use PowerShell;
  - or use Git Bash when it's present.
  Test on Windows.
  *Written, not run on Windows (D12).* The bash tool runs in Git Bash when it
  is installed (found under Program Files, LocalAppData or beside a `git.exe`
  on PATH, never System32's WSL `bash.exe`), else in `cmd.exe`, and the
  preamble names the shell, telling the model to write cmd syntax in
  `cmd.exe`. Build and verify commands keep the platform shell. Commands no
  longer open a console window. Still to do: run both cases on Windows.
- [ ] **1.12 Long-running commands** (S). A dev server "left running" after its
      timeout: check it's killed when the session ends, on app quit, and on
      `/stop`, on both Linux and Windows. Orphaned servers holding ports are a
      certainty otherwise.
      *Linux done; Windows written but not run.* It was worse than orphans.
      A timeout killed only the shell, and whatever it had started kept the
      output pipe open, so the call never came back. That covered
      `sleep 20; echo x`, any pipeline, and `npm run dev &`. Now:
  - Each command runs in its own process group. A timeout kills the group
    with TERM, then KILL after 2s. On Windows it uses `taskkill /T /F`.
  - A call returns when its shell exits. Anything still in the group was put
    in the background on purpose, so it keeps running, and its output is
    drained so it doesn't die of a broken pipe.
  - Esc (`interrupt`) stops the command in flight. Closing the session stops
    the background servers too.
  - Process exit and SIGTERM, SIGINT or SIGHUP kill everything. That covers
    app quit, because the desktop sends `close` and then kills the process.
  - The bash tool tells the model how to background a server.
  - Still open: Windows can't find a background child once its `cmd.exe` has
    exited, and a SIGKILL of the agent itself orphans everything.

### 1C · The live scenario suite

Build a repeatable set of live runs, and record the results in
`docs/testing/agent-live.md`. Run each in a new folder under a scratch directory,
never inside a real project.

| # | Scenario | What it stresses |
|---|---|---|
| 1 | New Python CLI + pytest (done once: passed) | write, bash, venv setup |
| 2 | Follow-up edit in the same project ("add a `remove` command") | edit/SEARCH-REPLACE, reading before editing |
| 3 | Bug fix: a seeded project with a failing test | read, grep, edit, re-run tests |
| 4 | Multi-file web app (Flask or Express + HTML/JS) | many writes in one reply, servers, ports |
| 5 | A prompt over 5000 characters | the direct-composer path |
| 6 | A task needing a package install | the permission floor, pip/npm inside the project |
| 7 | A README-heavy task (docs with code blocks) | nested fences, item 1.1 |
| 8 | A 20+ turn session | items 1.8 and 1.9 |
| 9 | Plan mode, then approve, then execute | the plan-mode handoff |
| 10 | `/rewind` after a bad edit | the rewind path, tested live |
| 11 | A TypeScript project (`tsc`, `npm test`) | a non-Python toolchain |
| 12 | Stop mid-turn (esc), then continue | cancellation, and the state after it |

- [x] **1.13 Write the suite as a script** (M). Promote the scratch
      `drive.cjs` into `scripts/agent-live.mjs`: it drives the app over CDP,
      sends the prompt, and records the transcript, tool counts, malformed
      blocks, wall time and final test status. A person answers permission
      prompts, or the run uses auto mode in a disposable folder.
      *Done:* `node scripts/agent-live.mjs [n...] [--auto] [--record]`. The
      twelve scenarios are in the script, and each launches the app in its own
      temp folder. It never answers a permission prompt; it waits for a person.
      It reads tools, turn ends and `AGENT_DRIFT` from the app's stdout, then
      saves the transcript and runs the project's tests (in its own venv with
      pytest when the project made none). A turn that doesn't end as expected
      fails the scenario. `--record` appends the table to
      `docs/testing/agent-live.md`. Tried live in auto mode: 3 and 12 passed.
      9's plan approval and 10's `/rewind` step are still unproven, because
      DeepSeek signed out partway through.
- [ ] **1.14 Run the suite twice**, and fix whatever falls apart between runs (L,
      open-ended).

**Exit:** 12/12 scenarios finish correctly on two separate days, with zero
silent data loss. Every failure the model causes gets an error sent back to it,
not a wrong result.

---

## Phase 2 — Providers

**Goal:** every provider offered works, or isn't offered.

- [ ] **2.1 Qwen Studio** (M). Page control is verified. It's gated only
      because a thinking model outlasts the 120s completion wait. Switch its
      completion to the reply-stream signal, as DeepSeek did, or raise
      `maxWaitMs` while the stream is open. Then run scenarios 1–3 of the
      suite. If they pass, drop `comingSoon`.
- [ ] **2.2 GLM** (M). Selectors have never been confirmed, and the site declines
      build prompts. Run `capture-provider-ui.mjs glm`, fix the selectors, and try
      the *agent's* preamble, which is smaller than a build prompt and may not
      be declined. **Decision point:** if it still declines, remove GLM from the
      provider list for 1.0 rather than shipping it gated forever.
- [ ] **2.3 Ollama for the coding agent** (M). The session seam (`start`,
      `ready`, `ask`, `reset`) already exists, and the agent only needs `ask`.
      A local model is the one provider with no terms-of-service risk and no
      selectors, so it's worth offering to the agent even if plan/build stay
      browser-only. Test with a 7–14B coder model, and expect more protocol
      drift (item 1.9).
- [x] **2.4 HuggingChat and Open WebUI** (S). Configs exist in
      `config/providers/`. Confirm whether they're offered anywhere. Either test
      them or delete the configs.
      *Done:* both were `enabled: false` with no selectors, and the registry hid
      them, so nothing offered them. Configs and the README row deleted.
- [ ] **2.5 Provider health on startup, live** (S). Run `npm run smoke deepseek`
      against the real site and fix every "degraded" row, or explain why it's
      skipped.

**Exit:** the provider dropdown lists only providers that passed scenarios 1–3.

---

## Phase 3 — The browser-native layer (`src/web/`)

**Goal:** stop carrying a parallel implementation that nothing uses.

`src/web/` (session manager, UI-state detection, fallback chains, `AIWebProvider`,
research engine) was built *beside* `PlaywrightController` and has never met a
live site.

- [ ] **3.1 Run it live once** (S). Run `npm run webtest -- deepseek --headed`,
      then `npm run web:report`.
- [ ] **3.2 Decide** (M):
  - **(a) Adopt it.** Route the agent's `ask` through `AIWebProvider`, since
    its explicit states (AUTH_REQUIRED, CAPTCHA, RATE_LIMITED) are exactly
    what a long agent session needs. Then delete the duplicate paths in
    `playwright-controller.ts`.
  - **(b) Delete it.** Keep only the pieces the controller lacks, such as
    state detection, and move them into the controller.
  - Either way, one code path reads replies at 1.0, not two.
- [ ] **3.3 Browser weight** (S–M). **Decided (D2): trim** (asked on 30
      September):
  - (1) trim Chromium now: block images, fonts and media on provider pages, and reuse one browser;
  - (2) use a system browser;
  - (3) Lightpanda as an experimental backend.
  Recommended: (1). What did you mean by "breakable, component by component"?
  If it means "each part can fail on its own without taking down the rest",
  that's an argument for 3.2(a).

**Exit:** a single reply-reading path, proven live.

---

## Phase 4 — Planned-build mode: verify or demote

**Goal:** the older Plan → Build pipeline is either proven again or clearly
labelled as secondary.

The app is agent-first now. The planned build is still reachable through
`/build` and the Plan and Build panels.

- [ ] **4.1 Re-verify the four unverified fixes** (M), from `NEXT-SESSION.md` §2:
  - `sudo` and `apt` prompt;
  - a build gets past step 1 on the venv;
  - New Chat clears the transcript and the plan;
  - Retry Failed resumes with "resuming: N/M";
  - `run.sh` is ignored.
- [ ] **4.2 One scale run** (M). A full-stack app of 15–25 steps: watch
      prompt growth, the delta, and resume after killing the app mid-build.
- [ ] **4.3 Plans that don't parse** (M). This is still a live limitation. Measure
      the rate across 20 plan requests. If it's over about 5%, prose-plan
      rescue (`extract/plan-rescue.ts`) needs the reader fixes that landed this
      session, since the readers now keep list items and inline code. Re-test.
- [ ] **4.4 Decide its future** (S). **Rule fixed (D4):**
  - keep both modes;
  - or make the planned build a feature *of* the agent (the agent writes the plan and runs steps via its own tools);
  - or retire it.
  Two engines doubles every provider fix. `index.ts` is 2145 lines, largely
  because of this.

**Exit:** the planned build passes 4.1 and 4.2, or it's removed from the UI.

---

## Phase 5 — Needle extraction: prove or remove

- [ ] **5.1 Run the real model once** (S): `closeni extractor-check warm` on a
      network that can reach Hugging Face.
- [ ] **5.2 Measure it** (M) on the plans that failed in 4.3. Does it rescue
      them? How fast is it?
- [ ] **5.3 Decide** (S). If it rescues fewer than half, or takes more than
      about 10 seconds, remove Settings → Extraction for 1.0. An optional
      Python dependency that doesn't earn its place costs support forever.

---

## Phase 6 — GitHub integration, live

Everything here has used an injected transport, with zero real calls. Use a
throwaway GitHub account or repo.

- [ ] **6.1 Sign in** through the app's flow. Check that the token lands in the OS
      keychain or `safeStorage`, and **nowhere else**: grep the logs, `.git/config`,
      `ps` output and `userData` for it (S).
- [ ] **6.2 Push** a new project to a new repo, then push again (S). Include a
      commit message containing shell metacharacters, to confirm `shell: false`.
- [ ] **6.3 List and clone** repos (S).
- [ ] **6.4 Actions**: trigger a workflow and read its status (S).
- [ ] **6.5 Export branch**: one commit per step, against a real remote (S).
- [ ] **6.6 Failure paths** (S): a revoked token, no network, a push rejected for
      being non-fast-forward, and a rate limit. Each should say what happened in
      one sentence.

**Exit:** every GitHub button in the UI has completed once against github.com.

---

## Phase 7 — UI pass, by a person

**Goal:** someone has looked at every screen.

- [ ] **7.1 Walk every panel in the default theme (Terminal)** (M): Code, Plan,
      Build, Test, Research, Settings, onboarding and the console drawer. Log
      each bug in one list and fix them in batches.
- [ ] **7.2 Themes** (M). Eleven themes, most never seen. **Recommendation:** ship
      three to four themes you've actually looked at (for example Terminal,
      Pixel, one light theme and one high-contrast theme) and cut the rest. Every
      theme multiplies the UI's test surface. `verify:visual` checks contrast,
      not whether the layout looks right.
- [ ] **7.3 Code panel details** (M):
  - long transcripts: scrolling performance after 500 or more tool lines;
  - copying code out of results;
  - collapsed "+N lines" expansion;
  - permission prompts with keyboard only;
  - how a queued message behaves while a permission prompt is open.
- [ ] **7.4 Error states** (S). Show each of the following to a person and make
      sure it says what to do next:
  - the provider signed out mid-session;
  - a CAPTCHA;
  - a rate limit;
  - the network down;
  - the browser download failed.
- [ ] **7.5 Onboarding on a clean profile** (S), on both Linux and Windows.
- [ ] **7.6 Accessibility basics** (S): focus order, visible focus, a screen-reader
      label on icon-only buttons, and "reduce motion" respected (already done for
      Pixel).
- [ ] **7.7 Window paint** (S). In this dev environment the Electron window
      doesn't paint frames: Wayland, `--ozone-platform=wayland`. Confirm it's
      environment-only by launching on X11 and on another machine. If a real user
      could hit it, add an `--ozone-platform-hint=auto` default or a fallback.

**Exit:** a written walkthrough with every item closed or deferred on purpose.

---

## Phase 8 — Codebase and docs cleanup

**Goal:** someone other than you, human or agent, can pick this up in an hour.

- [ ] **8.1 One planning document** (S). Fold what's still true from `NEXT.md`,
      `NEXT-SESSION.md` and `HANDOFF.md` into this file. Move the three into
      `docs/archive/`. Keep `ROADMAP.md` as the history of what was built.
- [ ] **8.2 Split `local-agent/src/index.ts`** (L). At 2145 lines it holds about
      eleven CLI modes. Give each mode its own module under `src/modes/`, keeping
      `index.ts` as the dispatcher. Do this only after Phase 4's decision, since
      the planned build may shrink.
- [ ] **8.3 Split `desktop/renderer.js` and `desktop/main.js`** (L), at 2063 and
      1625 lines, along panel lines and IPC domains. Keep the UMD pattern, since
      there's no bundler.
- [ ] **8.4 Split `test/run-tests.cjs`** (M). It's 4364 lines. Split it by area,
      with a runner that keeps the single `PASS — N passed` line.
- [x] **8.5 The VS Code extension** (S–L). **Decided (D7): delete.** The options were:
  - delete it: it's 97 lines, named "Agentic Web Coder", and predates the agent;
  - or rebuild it as a thin client of `agent-session`, so the agent runs inside VS Code. That's a real feature, so it may belong after 1.0.
      *Done:* deleted, with its workspace entry and the references in verify,
      the packaging test and the README. Rebuilding it is listed after 1.0.
- [ ] **8.6 C# language check** (S). It's the one language never run, because
      there's no .NET. Install .NET and run `npm run languages`, or drop C# from
      the "twelve languages" claim.
- [ ] **8.7 Dependency audit** (S). Run `npm audit`. Check that Electron and
      Playwright are current, and pin versions CI builds with.
      *30 Sep:* CI already builds from the lockfile (`npm ci`). `local-agent`
      and `desktop` audit clean. The root has 13 findings, all in Electron
      31.7.7 (out of support; 44 is current) and electron-builder 24 (26 is
      current), whose `tar`, `xmldom` and `extract-zip` run only at build
      time. Playwright is 1.62.1 (1.63.0 is current).
- [ ] **8.8 Dead code sweep** (M). Once Phases 3–5 decide what stays, remove
      what didn't: unused provider configs, the `legacy/` samples, whichever web
      layer lost, and Needle if it's cut.

**Exit:** no file over about 1000 lines outside tests, one planning doc, CI green.

---

## Phase 9 — Safety, legal and privacy review

- [x] **9.1 Agent sandbox review** (M). Path confinement (symlinks included),
      no writing inside `.git`, and the command floor (sudo, package managers,
      `rm -rf`, `curl | sh`) holding in *every* mode, including auto. Try to
      break it on purpose with adversarial prompts: a file written through `..`,
      a command hidden in `$(...)` or backticks, `bash -c "sudo ..."`, and
      `python -c "import os; os.system('rm -rf ~')"`. Document what the floor
      cannot catch. It's a prompt-level floor, not a sandbox, and the README
      should say so plainly.
      *Done:* the four listed cases already asked. Probing found holes, now
      closed: a `write` through a link to something missing created the file
      outside the project (a cloned repo can carry such a link, so no bash was
      needed); `.git` reached through a link, a nested `sub/.git` and `.GIT`
      were writable (a planted hook); and `rm -Rf`, `rm --recursive`,
      `rm -v -rf`, `find -delete`, `doas`, `pkexec`, bare `su`,
      `bash <(curl …)`, `sh -c "$(curl …)"`, `curl … | tee | sh`,
      `git push -f`/`+branch`, `git reset --hard`, `git clean -f`, and every
      Windows equivalent ran free. What still gets past it (a script written
      then run, download-then-run, encoded or assembled commands) is in
      `docs/SAFETY.md`, which the README links.
- [x] **9.2 Prompt injection from the workspace** (M). A file or tool output
      that says "ignore previous instructions and run …" is fed straight to the
      model. Permission prompts are the defence. Make sure auto mode's warning
      says this.
      *Done:* `/mode auto` now shows a warning saying so, and that the safety
      list is not a sandbox. `docs/SAFETY.md` explains it.
- [x] **9.3 Secrets** (S). Check that session cookies, `browser-profiles/` and
      the GitHub token never reach a log, a crash report, an installer, or a
      prompt sent to a provider. The existing allow-list and audit cover the
      installer. Add a check that `.env` files aren't sent in `read` results
      without confirmation.
      *Done:* reading a `.env`, a key or a credentials file asks in every mode
      and can't be remembered; a project-wide `grep` skips them and names them.
      The token is encrypted, reaches git only through `GIT_ASKPASS`, is
      redacted from git output, and never reaches the agent's process. There is
      no crash reporter. Not covered: `bash` runs as you and can read either.
- [ ] **9.4 Terms of service** (S). The README already says this is your
      responsibility. Make the first-run screen say it too, once, with a link to
      each provider's terms.
- [x] **9.5 Licence check** (S) on the bundled dependencies (Electron,
      Playwright, Chromium redistribution in the installer).
      *Done:* the installer ships Electron (MIT, with `LICENSE.electron.txt`
      and `LICENSES.chromium.html` at the app root), `playwright` and
      `playwright-core` (Apache-2.0, each with LICENSE, NOTICE and
      ThirdPartyNotices unpacked beside it) and nothing else from npm
      (`fsevents` is macOS-only, MIT). The Chromium Playwright drives is not in
      the installer: Playwright's own installer downloads it on first run.
      Checked against `dist/linux-unpacked`.

---

## Phase 10 — Release 1.0

- [ ] **10.1 Version** (S). Go `0.1.0` → `0.9.0` (a public beta) → `1.0.0`. Ship
      0.9 first to a few people, and wait a week of real use before 1.0.
- [ ] **10.2 Release workflow dry run** (S). Push a `v0.9.0-rc.1` tag and confirm
      the `.exe`, AppImage and `.deb` attach to a draft release.
- [ ] **10.3 Install every artefact by hand** (M):
  - [ ] Windows `.exe`: SmartScreen → Run anyway → the browser-download gate
        completes → `%APPDATA%/CloseNI/` is populated → the agent spawns via
        `ELECTRON_RUN_AS_NODE` (never verified packaged on Windows) → scenario 1
        of the suite passes.
  - [ ] AppImage: `chmod +x`, launch, scenario 1.
  - [ ] `.deb`: install, launch from the menu, scenario 1, uninstall cleanly.
- [ ] **10.4 Code signing** (S decision, M work). **Decided (D9): unsigned for 1.0.** The choice was: ship
      unsigned (the README already says so) or buy a certificate. Unsigned is
      fine for 0.9. For 1.0, SmartScreen's warning will cost users.
- [ ] **10.5 Auto-update** (M, optional). `electron-updater` against GitHub
      Releases. Without it, every provider selector fix means users reinstall.
      **Alternative:** fetch provider configs (the JSON selector files) from the
      repo at startup, with a signed or pinned fallback. Most fixes are JSON
      edits, and this ships them without a release.
- [ ] **10.6 Docs match the build** (S):
  - README limitations;
  - CHANGELOG `[1.0.0]`;
  - the landing page (`docs/index.html`) and screenshots regenerated with the shipped theme set;
  - GitHub Pages enabled (Settings → Pages → `main` / `/docs`).
- [x] **10.7 Issue templates** (S). Add a bug template that asks for the
      provider, the OS, and the console drawer's last 50 lines. Selector breakage
      will be the most common report, so make it easy to file.
      *Done:* `.github/ISSUE_TEMPLATE/bug.yml`, a form: provider, where it
      broke (a provider not sending, finishing or being read comes first), OS,
      version and install type, and the Agent and Project panes' last 50 lines.

**Exit:** `v1.0.0` tagged, with installers that were each installed by a person,
and the README true.

---

## Decisions

On 1 October you handed these over ("do what's best for the project"), so each
row now records what was decided and why. D3–D6 still wait on the live runs
they name; the rule for each is fixed now so the run decides, not a debate.

| # | Question | Decided | Why |
|---|---|---|---|
| D1 | Deep thinking on by default for agent turns? (1.7) | Off for agent turns; Chat keeps your choice | Agent turns are many and short, and thinking is what hit the 300 s wait |
| D2 | Browser weight: trim, system browser, or Lightpanda? (3.3) | Trim Chromium | The other two change the engine every selector was measured on |
| D3 | Adopt or delete `src/web/`? (3.2) | Adopt for the agent if 3.1 passes live, delete if it fails | Two reply-reading paths is the worst of both |
| D4 | Keep the planned build as a separate mode? (4.4) | Keep for 1.0 only if 4.1 and 4.2 pass, otherwise demote it behind the agent | The agent is the product; a mode that fails live costs trust |
| D5 | GLM: fix or drop for 1.0? (2.2) | Drop if it declines the agent preamble too | One reliable provider beats three gated ones |
| D6 | Needle: keep? (5.3) | Keep only if it rescues most failed plans in seconds | It is off by default and unproven |
| D7 | VS Code extension: delete or rebuild? (8.5) | Delete now, rebuild after 1.0 | 97 stale lines that predate the agent |
| D8 | How many themes ship? (7.2) | All eleven | Eight are a single palette block that `verify:visual` contrast-checks; only Pixel and Terminal change layout, and those get the look by hand |
| D9 | Code signing? (10.4) | Ship 1.0 unsigned, and say so | A certificate costs money every year before there are users; free signing for open-source projects (SignPath Foundation) is the first thing to try after |
| D10 | Auto-update, or remote provider configs? (10.5) | Remote provider configs first | Most fixes are selector JSON, and this ships them without a release |
| D11 | e2e in CI? (0.4) | On pull requests and by hand, not on every push | The repo is public, so minutes are free, and a PR is where a break should be caught |
| D12 | Windows shell for `bash`? (1.11) | Git Bash when it is installed, else `cmd.exe`, and the preamble names the one in use | The model writes bash; when it can't have bash, it must be told |

---

## After 1.0

Deliberately out of scope. Each is real, and none is needed for the six criteria
at the top.

- Two builds or agent sessions running at the same time (architectural; see `NEXT.md` §7)
- Reading reply text from the network stream (investigated and declined; see `NEXT.md` §1)
- Content-refusal detection beyond Needle's message
- An agent inside VS Code (see 8.5)
- macOS builds (no Mac to test on; unsigned macOS apps are a worse experience than Windows)
- MCP servers as agent tools, not only as pre-build context
- Images and screenshots in agent prompts
- Sub-agents and parallel tool calls across providers

## Rules that still hold

These are carried over from `HANDOFF.md`, and the tests enforce most of them:

- Never widen the electron-builder `files` allow-list to a glob.
- The GitHub token never touches `.git/config`, argv, logs, plaintext, the
  renderer or the agent.
- git runs with `shell: false`.
- No colour literal in `styles.css` outside `:root` or `[data-theme]`.
- The always-ask command floor holds in every mode.
- Don't fix a broken selector by adding more selectors. Need fewer.
- Don't publish a build until a run completes end to end.
- Commits are authored by Siddarth alone, with no co-author trailers.
