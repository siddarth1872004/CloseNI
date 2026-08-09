# CloseNI Roadmap

28 items, grouped into 9 sub-projects. Each sub-project gets its own design spec
and implementation plan under `docs/superpowers/`, and is expected to leave the
application working on its own.

Two items from the original list were cut: replacing Electron with a native
toolkit, and using the discrete GPU when opening a project.

**Status vocabulary:** `todo` — not started. `partial` — real groundwork exists,
listed per item. `done` — finished and verified by tests.

---

## 1 · Conversation & context core — IN PROGRESS

Roadmap items 1, 2, 3. Spec: `specs/2026-08-09-conversation-context-core-design.md`

The foundation. Every step currently opens a brand-new chat, so nothing carries
between steps and all context has to be rebuilt from disk each time.

| Phase | What it does | Status |
|---|---|---|
| 1 | All steps of one build share a chat thread | in progress — plan written, 3 of 5 tasks committed |
| 2 | Send only what the thread has not already seen | todo |
| 3 | One long-lived process per build; browser opens once | todo |

Plan for phase 1: `plans/2026-08-09-build-thread-persistence.md`

- **1. Performance & session handling** — `partial`. Session handling fixed (IPC
  handlers, browser lifecycle, response-detection hang). Raw speed is phase 3.
- **2. Persistent conversations per project/session** — `partial`. Phase 1.
- **3. Better prompts & parsing** — `partial`. Parsing is well covered by tests;
  prompt content is phase 2.

## 2 · Provider platform

Roadmap items 7, 8, 9, 10. Depends on nothing. Blocks sub-project 4.

- **7. GLM + Qwen Studio** — `partial`. Qwen has a config and is enabled; there is
  no GLM config; all four `*.adapter.ts` files are empty (0 bytes), so provider
  behaviour lives entirely in JSON today.
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

## 6 · Builder IDE experience

Roadmap items 16, 17, 18, 22. Benefits from sub-project 1 but is not blocked by it.

- **16. IDE-like diff view in Builder** — `todo`.
- **17. Suggestion / fix chat after generation and after tests** — `todo`.
- **18. Test/Run section complete** — `partial`. `testall` works and is tested;
  the Run and Ship sides are thin.
- **22. Permissions: auto-allow / review / ask** — `partial`. Approve and deny both
  work end to end and are tested; there is no policy setting or UI for it.

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

## 9 · Housekeeping

Roadmap items 23, 24, 25. No dependencies. The only sub-project that could be
finished in a single sitting.

- **23. Emoji cleanup** — `todo`. Exactly one source file:
  `local-agent/src/providers/provider-registry.ts` (`📋`, `❌`). This is the line
  that prints four times per build step.
- **24. Junk & redundant files** — `partial`. 16 legacy scripts archived to
  `scripts/legacy/`; `__pycache__`, backups, stale compiled duplicates and a
  stray Flask app are git-ignored. **37 empty `.ts` stub files remain** in
  `local-agent/src/` and `vscode-extension/src/`.
- **25. QoL across all features** — `todo`.

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
- Test suite from nothing to ~120 tests — unit plus an end-to-end suite that
  drives the real CLI and a real browser against a mock chat provider.
- WSL environment made reproducible (`scripts/wsl-env.sh`).
- Repository published to GitHub.
