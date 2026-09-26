# Browser layer audit — 26 September 2026

Written before any change, for the browser-native research work. It records
what the code does today, measured where it could be and marked where it could
not.

**Verification status used throughout:** `MEASURED` (observed against the live
site, cited from the commit or config note that recorded it), `FIXTURE`
(proven against local markup only), `UNVERIFIED` (written from screenshots or
guesses), `UNKNOWN` (nobody has looked).

---

## 0 · What this machine can and cannot reach

Probed on 26 September from the development container:

| Host | Result |
|---|---|
| `chat.deepseek.com`, `chat.qwen.ai`, `chat.z.ai` | **refused by the container's network policy** |
| `www.bing.com`, `duckduckgo.com`, `html.duckduckgo.com`, `www.google.com`, `search.brave.com` | refused |
| `en.wikipedia.org`, `developer.mozilla.org`, `docs.python.org`, `example.com` | refused |
| `api.github.com` | **reachable** (200) |

So no live provider test and no live web search can run from here. Every live
row in the test matrix is therefore `BLOCKED` — a network fact about this
machine, which is a different thing from `AUTH_REQUIRED`. Nothing in this work
creates an account, signs in, or tries to get past a login, CAPTCHA or rate
limit.

---

## 1 · What exists

```
desktop/                     Electron shell, renderer, builder
local-agent/src/
  index.ts                   CLI: chat, plan, revise, build-session, research, smoke, health, signin …
  providers/
    playwright-controller.ts THE browser layer (1205 lines, one class)
    chat-session.ts          ChatSession seam: start/ready/ask/reset/close (browser + Ollama)
    ollama-session.ts        the non-browser transport
    provider-registry.ts     loads config/providers/*.json
    completion.ts            pure: stop-button-or-stability completion rule
    stream-status.ts         pure: HTTP status of the reply request → message
    controls/                per-provider model/thinking/search toggles
  health/selector-health.ts  pure: are the selectors still matching anything
  health/smoke-report.ts     pure: judges one live round trip
  research.ts                prompt prefix + URL extraction for Research
  context/, parser/, patch/, verification/ …  build pipeline, not browser
local-agent/config/providers deepseek, qwen-studio, glm, ollama (+ disabled stubs)
local-agent/test/
  mock-provider.cjs          one local chat page + a controls lab page
  run-e2e.cjs                180 tests, real Chromium against the mock
scripts/replay.mjs           real controller methods against recorded DeepSeek markup
scripts/capture-provider-ui.mjs  interactive selector capture (headed, signed-in)
```

## 2 · What works

| Area | Status | Evidence |
|---|---|---|
| DeepSeek: launch, resume thread, send, wait, extract, build | `MEASURED` | 3-step and 9-step live builds, 11 Aug (docs/NEXT.md) |
| DeepSeek reply-stream end signal (XHR `/api/v0/chat/completion`) | `MEASURED` | config `_streamNote`; completion 15.1s → 8.7s |
| DeepSeek code via its own Copy button | `MEASURED` | config `_copyButtonNote`, replay fixture |
| HTTP 429/401/403/5xx on the reply request stops the wait | `FIXTURE` + reasoning | stream-status.ts |
| Long prompt through the native value setter (React) | `MEASURED` | commit 4f999b8 |
| Qwen: input, clipboard paste, send, completion | `MEASURED` per its config note; gated because long prompts outrun the wait | `_comingSoonReason` |
| GLM: chat selectors | `UNVERIFIED` — "never been confirmed" | `_comingSoonReason` |
| Persistent profile per provider, keyed by id | works | storage-paths.ts |
| Selector health / smoke judgement | pure, unit-tested | health/ |

## 3 · What is fragile

1. **Login detection cannot tell an auth wall from anything else.**
   `waitForLogin` waits for the generic `textarea, div[contenteditable="true"]`
   (it ignores the configured `chatInput`) and reports "not signed in" on a
   timeout. A login page, a CAPTCHA, a slow load, a network error, an error
   page and a redirect all produce the same `false`. The research task needs
   `AUTH_REQUIRED` and `CAPTCHA` as distinct, honest states.
2. **No page-level failure handling.** Nothing listens for `page.on("crash")`,
   `close`, `dialog`, `popup` or `download`. A JavaScript `alert()` on a
   provider page would block every later action until the timeout; a crashed
   renderer surfaces as an opaque Playwright error.
3. **Navigation has one attempt.** `goto(..., domcontentloaded, 30s)` with no
   retry and no redirect check.
4. **Response completion polls whole-message text every 2 s.** `textContent`
   of the last reply is re-read on every tick even when nothing changed.
   Stable, but costs a full read per tick and adds up to 2 s latency.
5. **Two DOM walkers with different rules.** `extractLatestResponse` and
   `getLastMessageStructured` both walk the reply; one keeps code fences with
   language, the other emits `###` headings and drops language labels by a
   regex list. Tables and links are flattened to text by both.
6. **Selector fallbacks are broad CSS.** `FALLBACK_SELECTORS` ends with
   `div[class*="assistant"]`, which can match UI chrome. There is no
   accessibility-first chain and no record of *which* fallback won beyond a
   cached string.
7. **The long-prompt path writes to the first composer on the page**
   (`document.querySelector('textarea, div[contenteditable]')`), not the
   configured one.
8. **Research is a single question to one provider** with its search toggle
   on. No decomposition, no source fetching, no provenance beyond URLs the
   model chose to print.

9. **The old controller hides that it is automated.** It launches Chromium
   with `--disable-blink-features=AutomationControlled`
   (`playwright-controller.ts:310`), which removes `navigator.webdriver`. That
   is a step towards evading bot detection, which this work must not do. The
   new layer does not pass it. The existing flag is left in place, because
   removing it changes a measured, working path, but it is flagged here for
   the owner to decide on.

## 4 · What is duplicated

- The two reply walkers above.
- Login/readiness is re-implemented per CLI mode (`openProvider`,
  `openProviderForBuild`, `smokeMode`, `healthMode`, `authCheckMode`,
  `signinMode`) — each calls launch → navigate → waitForLogin with slightly
  different timeouts.
- `sleep` exists in four modules.

## 5 · What should be abstracted

- A **session manager** owning browser/context/page lifecycle, isolation
  between providers and research, and crash/popup/dialog/download events.
- A **UI state classifier** that turns page signals into a named state.
- A **selector chain** — role → accessible name → stable attributes →
  semantic HTML → text → structure → heuristic — that reports which link held.
- One **DOM → semantic document** pipeline, shared by AI replies and web pages.
- A **provider adapter** interface so a new site is one file.

## 6 · What should be replaced

Nothing, yet. `PlaywrightController` is the only path proven end to end
against a live provider. Replacing it without a live provider to re-verify
against would trade a measured component for an unmeasured one — the exact
failure mode this project's history warns about. The new layer is built
**beside** it, reachable through its own CLI modes, and can take over the
build path once it has been run live.

## 7 · What must remain untouched

- `PlaywrightController`'s build path, stream tap, Copy-button read, React
  native setter, and every `_note` in the provider configs: each encodes a
  measured fix.
- `storage-paths.ts` (profiles keyed by provider id).
- The rules in docs/HANDOFF.md: no token outside the ASKPASS helper, git with
  `shell: false`, storage never packaged.

## 8 · Unknowns carried into the new work

| Question | Status |
|---|---|
| Does DeepSeek serve a usable chat without login? | `UNKNOWN` (believed no; not verifiable here) |
| Does Qwen offer guest chat? | `UNKNOWN` |
| Does GLM offer guest chat? | `UNKNOWN` |
| Qwen/GLM reply-stream endpoints | `UNKNOWN` — never instrumented |
| Qwen/GLM reasoning ("thinking") markup | `UNKNOWN` |
| DeepSeek reasoning markup | `UNKNOWN` — DeepThink is off by default and never captured |
| Whether a search engine results page can be read in a real browser without a challenge | `UNKNOWN` (DuckDuckGo's HTML endpoint returned 202 to scripted HTTPS, 11 Aug) |
