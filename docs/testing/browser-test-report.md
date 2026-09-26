# Browser test report: DeepSeek × Qwen × GLM

26 September 2026. The generated per-capability matrix is in
[`provider-matrix.md`](provider-matrix.md). The design is in
[`../architecture/browser-research.md`](../architecture/browser-research.md).

## Summary, and the one fact that shapes all of it

**No live site could be reached from the machine this was built on.** The development container's
network policy refused:

- `chat.deepseek.com`, `chat.qwen.ai` and `chat.z.ai`
- every search engine tried (Bing, DuckDuckGo, Google, Brave)
- general sites (Wikipedia, MDN, python.org, example.com)

Only `api.github.com` answered. The refusal is `net::ERR_TUNNEL_CONNECTION_FAILED` from the
proxy, which `classifyNavError` reads as `blocked`.

So:

- **Every live row is `BLOCKED`.** It is not `AUTH_REQUIRED`: the run never got as far as a
  login page. `closeni webtest all` was run, and its output is in
  `results/live-results.json`.
- **No signup, sign-in, CAPTCHA or rate-limit workaround was attempted**, and the code has no
  path that would do one.
- **Whether each site allows guest chat is `UNKNOWN`.** It could not be observed.
- **Everything else was proven against local fixture pages** shaped like each provider, running
  in real Chromium: **199 checks passed, 0 failed**, plus 218 unit checks of the pure logic.

A fixture `PASS` means *the automation handles that behaviour when a page does it*. It does not
mean the live site does it that way. The first live run should be
`npm run webtest -- deepseek --headed` on a machine with a signed-in profile, followed by
`npm run web:report`.

## Browser compatibility

- Chromium through Playwright 1.62 only. Firefox and WebKit were not tried (`NOT_TESTED`).
- The container had Chromium build 1194 while Playwright wanted 1234. The suites ran through a
  mapped `PLAYWRIGHT_BROWSERS_PATH`, and `CLOSENI_CHROMIUM` can point at any Chromium binary.
- Headless and headed both work for the fixtures. Headed was used only under Xvfb.

## UI structure

| | DeepSeek | Qwen | GLM |
|---|---|---|---|
| Composer | `textarea[placeholder]`, MEASURED | textarea / contenteditable, MEASURED (config note) | UNVERIFIED |
| Send | UNVERIFIED selector misses; Enter works (MEASURED) | MEASURED | UNVERIFIED |
| Stop control | none: NOT_APPLICABLE (MEASURED) | MEASURED | UNVERIFIED |
| Assistant block | `ds-markdown`, MEASURED | UNVERIFIED | UNVERIFIED |
| Reply stream | XHR `/api/v0/chat/completion`, MEASURED | UNKNOWN | UNKNOWN |
| Reasoning markup | UNKNOWN (DeepThink never captured) | UNKNOWN | UNKNOWN |

The fixture flavours copy these facts. The DeepSeek flavour streams over XHR and has no stop
control. The Qwen flavour has a stop control and no measured stream. The GLM flavour has a
contenteditable composer and obfuscated class names, so its chains must fall back to role, text
and heuristics. The GLM rows therefore exercise the fallback chains the most.

## Extraction

The fixtures and the recorded DeepSeek replay confirm that each reply keeps:

- code blocks with their language;
- inline code;
- ordered and unordered lists;
- tables, including links inside cells;
- links, and file links as attachments;
- a reasoning section separated from the answer;
- a message id from markup and a conversation id from the URL.

Copy and Download control text never leaks into the answer. DeepSeek's own Copy control upgrades
the code text when the block counts match. An empty bubble and a reply of controls only are both
`empty`, never the previous answer.

## Streaming

- Partial snapshots arrive as previous / current / delta. A re-render is labelled `rewrite`.
- Completion signals seen: `stream-closed` (DeepSeek), `stop-button-gone` (Qwen, GLM fixture),
  `stability`.
- Pause handling. A 2.5 s mid-answer pause, longer than the 1.5 s test stability window, does not
  truncate the reply on any flavour. The stop control (Qwen, GLM) or the still-open reply request
  (DeepSeek) holds the wait open.

## Failure behaviour

| Scenario | Result |
|---|---|
| Login page on load | `AUTH_REQUIRED`, diagnostics captured, nothing sent |
| Login demanded after send | `AUTH_REQUIRED` from `submitPrompt`, not a hang |
| CAPTCHA widget | `CAPTCHA`, run stops |
| 5xx page | `ERROR` |
| 429 on the reply / rate-limit banner | `RATE_LIMITED`, wait ends in under 10 s |
| Reply request 500 | failure, quickly |
| Cookie modal / popup / `alert()` | dismissed or closed; the chat still works. A login dialog is never dismissed. |
| Late start (1.5 s) | waited for |
| Stalled reply | `partial`. DeepSeek: signal `stalled`, because the request is still open. Qwen and GLM: the stop control is still up. |
| Connection cut mid-reply | DeepSeek: `partial` / `interrupted` via the stream tap. Qwen and GLM: **PARTIAL**, because without a measured stream endpoint a cut reply looks finished. |
| Mid-conversation redesign | new reply still read through the chain |
| Renderer crash mid-reply | `interrupted`; page recreated; next prompt answered |
| Page script locks the main thread | `interrupted` after the unresponsive window; page replaced |

## Research

On the fixture web, "What are the Widget Engine rate limits and performance?":

- stops as `sufficient`;
- finds both planted contradictions: 100 vs 60 requests per minute, and 10,000 vs 12,000 widgets
  per second;
- does not count the syndicated mirror as a second source;
- strips tracking parameters from every citation;
- cites every evidence line.

A page no search returned (the install page) is reached by following a docs-sidebar link, and
its sentence is used as evidence. Page budgets and "no backends" stop the run with a named
reason. The live search engine adapters are `UNVERIFIED`.

## Context

The context builder:

- re-ranks evidence across pages per subquestion;
- keeps any one source from dominating;
- numbers citations;
- lists conflicts and gaps;
- trims to budget.

When a provider synthesises the answer, `checkCitations` reports the citations used, invalid
citation numbers and uncited sentences. All three fixture flavours pass that check.

## Tool interaction

`NOT_APPLICABLE`. A chat web page cannot call local tools. Research runs outside the model and
hands it a built context.

## Reliability

- The full fixture suite passes on one run from a cold start. 199/199 checks in about four minutes.
- Running it found real defects that reading the code had not:
  1. The stream binding reported to the first provider object on a page, so later objects never
     saw the reply stream.
  2. A login shown after the composer emptied was read as "sent".
  3. Stability ended DeepSeek replies during a pause while the request was still open.
  4. Long prompts in a contenteditable composer lost their line breaks.
  5. The empty-reply signal was lost when a stop control came and went during the post-send
     check.
  6. With two subquestions, no word counted as distinctive, so any sentence about the subject
     was "evidence" for a how-to question.
  7. The health check called a Copy or stop control "broken" on a page state that cannot have
     one.

  All seven are fixed and have tests.
- Chaos:
  - SIGKILL of the shared browser: relaunched on next use.
  - Closed tab: recovered.
  - Removed selector: fallback held.
  - Viewport change mid-reply: complete.
  - Malformed or empty DOM: `empty`, no throw.
  - Reload mid-generation: **PARTIAL**. The wait ends, but whether a live site restores the
    reply after reload is `UNKNOWN`.

## Performance bottlenecks

The fixture timings (in the matrix) measure the automation's own overhead. A short reply is
answered and extracted in roughly 0.6–1 s over a scripted stream. The known costs:

- **Stability window.** When no strong signal exists, the stability window is the floor: 6 s by
  default. That is why a measured stream endpoint for Qwen and GLM would cut their latency the
  most.
- **Re-rendered long replies.** Pages that re-render the whole message per chunk make long
  replies quadratic in the page, not in the automation. The mutation counter means the reply
  text is re-read only when the DOM changed.
- **Research.** Browser fetches cost about 10× an HTTP fetch, so the fetcher only escalates app
  shells.

## Known limitations

- Qwen and GLM have no measured reply stream. A cut connection there ends like a finished reply
  (PARTIAL).
- Reload mid-generation is PARTIAL (see above).
- Selector health is PARTIAL on every flavour. The primary new-chat selector (and on DeepSeek and
  GLM, the send selector) misses, and a fallback carries it. The DeepSeek fixture reproduces the
  measured live miss of its send selector. The others are unverified guesses that a live
  `webtest` will confirm or replace.
- The GLM selectors are all UNVERIFIED.
- Reasoning markup is UNKNOWN on all three providers. Extraction uses a generic marker.
- The old `PlaywrightController` still launches with
  `--disable-blink-features=AutomationControlled`. The new layer does not. See the audit, item 9.
- The build path still uses `PlaywrightController`. The new layer should replace it for one
  provider only after `webtest` passes live for that provider.

## Authentication requirements

| | Guest chat? | Evidence |
|---|---|---|
| DeepSeek | UNKNOWN (believed no) | site unreachable from the test machine |
| Qwen | UNKNOWN | site unreachable |
| GLM | UNKNOWN | site unreachable |

When a login is required, the run records `AUTH_REQUIRED` and continues with everything that
needs no login. It never signs in.

## Reproducing

```
npm run build
npm test                   # unit, includes the web layer's pure logic
npm run test:web           # real Chromium against the fixtures; writes results/fixture-results.json
npm run webtest -- all     # live; merges results/live-results.json
npm run web:report         # regenerates provider-matrix.md
```
