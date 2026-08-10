# CloseNI Roadmap

28 items, grouped into 9 sub-projects. **3 of 9 complete** (1 · Conversation & context core, 6 · Builder IDE experience, 9 · Housekeeping). Each sub-project gets its own design spec
and implementation plan under `docs/superpowers/`, and is expected to leave the
application working on its own.

Two items from the original list were cut: replacing Electron with a native
toolkit, and using the discrete GPU when opening a project.

**Status vocabulary:** `todo` — not started. `partial` — real groundwork exists,
listed per item. `done` — finished and verified by tests.

---

## 1 · Conversation & context core — DONE

Roadmap items 1, 2, 3. Spec: `specs/2026-08-09-conversation-context-core-design.md`

Every step used to open a brand-new chat, so nothing carried between steps and
all context had to be rebuilt from disk each time.

| Phase | What it does | Status |
|---|---|---|
| 1 | All steps of one build share a chat thread | done — `plans/2026-08-09-build-thread-persistence.md` |
| 2 | Send only what the thread has not already seen | done — `plans/2026-08-09-delta-context.md` |
| 3 | One long-lived process per build; browser opens once | done — `plans/2026-08-09-build-session.md` |

- **1. Performance & session handling** — `done`. One Chromium launch per build
  instead of one per step, one provider-registry load, one login check.
- **2. Persistent conversations per project/session** — `done` within a build run.
  Threads deliberately do not span separate runs; that was the design decision.
- **3. Better prompts & parsing** — `done`. Prompts carry a delta rather than the
  whole project each step, and the structure is sent once.

**The intermittent empty-plan issue is resolved** — see the spec. It was
traced to concurrent end-to-end suites sharing one provider config file, not to
a race in the product; that collision was fixed in Phase 2. Plan mode ran 25/25
clean in isolation.

## 2 · Provider platform

Roadmap items 7, 8, 9, 10. Depends on nothing. Blocks sub-project 4.

- **7. GLM + Qwen Studio** — `partial`. Qwen has a config and is enabled; there is
  no GLM config. Provider behaviour lives entirely in the JSON configs — the four
  empty `*.adapter.ts` placeholders were deleted in sub-project 9, so any adapter
  layer starts from nothing rather than from a stub.
- **8. Model / tool / effort switching** — `todo`. Requires simulating clicks in
  the provider's UI, which is behaviour rather than config — this is the item that
  forces the adapter question.
- **9. First-run browser login onboarding** — `todo`.
- **10. Provider logos** — `todo`.

## 3 · Multi-language builds

Roadmap item 5. Fully independent — nothing waits on it.

- **5. JS, Rust, C, C++, Java** — `partial`. Signature extraction reads all of
  them, so context selection already works across languages. Syntax checks still
  cover only `.py` and `.js`; nothing compiles or runs Rust, C or Java.

## 4 · Concurrency & multi-agent

Roadmap item 4. **Depends on sub-projects 1 and 2** — a concurrent agent cannot be
defined until a conversation has an owner and a browser profile has an owner.

- **4. Concurrent agents + inter-agent communication** — `todo`.

## 5 · GitHub & external tools

Roadmap items 11-15. The largest sub-project; likely splits again at spec time.
All of it needs a credential story the app does not have yet.

- **11. Repo search + integration into builds** — `partial`. Search works and is
  tested; nothing integrates a found repo into a project being built.
- **12. In-app sign-in, repo access, push** — `todo`.
- **13. MCP tool support** — `todo`.
- **14. GitHub Actions + external tooling** — `todo`.
- **15. Skills, personas, GitHub skill-`md`** — `todo`.

## 6 · Builder IDE experience — DONE

Roadmap items 16, 17, 18, 22. Benefits from sub-project 1 but is not blocked by it.

- **16. IDE-like diff view in Builder** — `done`. File cards show a line diff
  against the backup `applyPatch` already writes, with long unchanged runs
  collapsed.
- **17. Suggestion / fix chat after generation and after tests** — `done`. Any
  completed step can be revised through its build thread; changes do not cascade
  to later steps, and a missing thread is refused rather than guessed at.
- **18. Test/Run section complete** — `done`. The Test tab reports per-check
  pass/fail with a summary and shows command output in place; Run Project
  detects the entry point and runs it.
- **22. Permissions: auto-allow / review / ask** — `done`. Three modes in the
  sidebar, persisted, feeding both build call sites. An unrecognised value
  falls back to asking.

## 7 · Visual identity & polish

Roadmap items 19, 20, 21, 26, 27. Unblocked by the decision to stay on Electron.
Blocks sub-project 8.

- **19. UI refresh — 3D elements, transitions, animations** — `todo`.
- **20. Programming-language logos** — `todo`.
- **21. Detailed settings page** — `todo`.
- **26. Beautiful, detailed UI** — `todo`.
- **27. Logo** — `todo`.

## 8 · Distribution

Roadmap item 28. **Depends on sub-project 7** being presentable.

- **28. Releases page, Windows + Linux packages** — `todo`. electron-builder
  produces NSIS/`.exe` and AppImage/`.deb`; staying on Electron keeps this simple.

## 9 · Housekeeping — DONE

Roadmap items 23, 24, 25.

- **23. Emoji cleanup** — `done`. The two lines in
  `local-agent/src/providers/provider-registry.ts` were the only emoji in the
  project's own source; everything else lives in third-party `node_modules`.
- **24. Junk & redundant files** — `done`. 16 legacy scripts archived to
  `scripts/legacy/`; `__pycache__`, backups, stale compiled duplicates and a
  stray Flask app git-ignored; **46 empty files deleted** — 37 `.ts` stubs
  across `local-agent/src` and `vscode-extension/src`, 8 dead sample fixtures,
  and an unreferenced `config/safety.json`. The three `.gitkeep` files stay:
  they are what keep `storage/runs`, `storage/backups` and
  `storage/browser-profiles` in the repository.
- **25. QoL across all features** — `done` for this sub-project's scope. QoL
  belonging to a specific feature is tracked with that feature.

Verified with a clean build after the deletions.

---

## Dependency order

```
9 Housekeeping ──── independent, do any time
3 Multi-language ── independent
7 Visual ────────── independent ──> 8 Distribution
6 Builder UX ────── independent (better after 1)
5 GitHub/tools ──── independent (needs an auth story first)

1 Conversation ──┐
2 Providers ─────┴──> 4 Concurrency
```

Only sub-project 4 has hard prerequisites. Everything else can be picked up in any
order, which means the sequence is a question of what is worth having soonest
rather than what is possible.

---

## Not on the list

Work already completed that no roadmap item covers, but which the items above
depend on:

- Four bugs fixed: `python` vs `python3` in syntax checks and model-suggested
  commands (was failing every Python step); response-detection hanging for the
  full timeout on short replies; context ranking that omitted the module a step
  had to import from; dead IPC handlers behind the New Chat button.
- Test suite from nothing to 226 tests (110 unit + 116 end-to-end) — unit coverage
  plus a suite that drives the real CLI and a real browser against a mock chat
  provider.
- Two bugs found by reading code rather than by a failing test, both invisible to
  the suite: build-session commands sharing stdin with the approval flow, which
  would have denied every terminal command; and approval replies written to the
  per-step process, which a session is not.
- WSL environment made reproducible (`scripts/wsl-env.sh`).
- Repository published to GitHub.
