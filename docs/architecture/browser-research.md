# Browser-native AI and research layer

`local-agent/src/web/` treats DeepSeek, Qwen and GLM as **web applications driven through a
browser**, not as APIs. It also holds a research engine that searches, reads and cites the web
through the same browser. It was built beside `PlaywrightController`, not over it. The audit that
explains why is at [`docs/audit/2026-09-26-browser-layer-audit.md`](../audit/2026-09-26-browser-layer-audit.md).

Hard rules the code keeps:

- No API clients, no API keys.
- No account creation, no signing in, no attempt to get past a login, a CAPTCHA or a rate limit.
  Detection exists so a run can **stop and say why**.
- Passwords, cookies, tokens and credentials are never logged. `trace.ts` redacts URLs and text
  before anything is written.
- Authenticated content is never cached. `TtlCache.set` refuses entries marked `authenticated`.
  Only the isolated, logged-out research context feeds the caches.
- A behaviour that has not been observed on the live site is marked `UNVERIFIED` or `UNKNOWN`,
  never assumed.

```
src/web/
  trace.ts, util.ts             structured events with redaction; shared helpers
  browser/                      session manager, navigation, diagnostics
  selectors/chain.ts            fallback chains with diagnosis
  semantic/                     DOM snapshot + tolerant HTML parser → typed blocks
  response/normalize.ts         Raw → DOM → Semantic → Normalized → Structured
  providers/                    AIWebProvider, UI state, completion, adapters
  research/                     planner, search, fetch, page model, evidence, context, agent
  live.ts                       the identical scenarios against the live sites
```

---

## 1 · Browser

```mermaid
flowchart LR
  subgraph SM[BrowserSessionManager]
    B[(shared Chromium<br/>relaunched on disconnect)]
    P1[provider:deepseek<br/>persistent profile]
    P2[provider:qwen<br/>persistent profile]
    P3[provider:glm<br/>persistent profile]
    R[research<br/>non-persistent, logged out]
    T[temp:* / isolated:*]
  end
  P1 & P2 & P3 -->|launchPersistentContext| Disk[(profile dirs<br/>local-agent/storage)]
  B --> R & T
  R --> SP1[scratch page per operation]
  SM -. events .-> EV[crash · close · popup · dialog · download · console · failed request]
```

- **Isolation.** Each provider has its own persistent context and profile, so cookies and storage
  never cross. The research context is fresh and logged out. Two contexts on one profile are
  refused, because they would share a login.
- **Concurrency.** Concurrent requests for one context key share a single launch (the `creating`
  map). Each research fetch or search gets its own scratch page, so parallel operations never
  navigate each other's page.
- **Page events.** Popups are judged after a short delay, so pages we opened ourselves are never
  mistaken for them. Dialogs are dismissed, and `beforeunload` is accepted. Downloads are
  cancelled unless allowed. Crashes and closes mark the page unhealthy, so the next action
  re-acquires one.
- **Bounded shutdown.** Closing a context or the browser is capped at 5 s, with a SIGKILL
  fallback. A wedged renderer cannot hang the process on exit.
- **No evasion.** The layer does not pass `--disable-blink-features=AutomationControlled`, unlike
  the old controller. The audit, item 9, covers this.

## 2 · Provider

```mermaid
classDiagram
  class AIWebProvider {
    launch() attach() close()
    healthCheck() diagnostics()
    openChat() startConversation() clearConversation()
    detectState() : StateReport
    submitPrompt(text) : SubmitResult
    waitForResponse() : WaitResult
    extractResponse() : AIResponse
    extractReasoning() extractArtifacts()
    stopGeneration() ask(text)
  }
  class ChatWebProvider
  class AdapterSpec {
    chains: composer send stop assistant newChat copy
    streamUrlPattern?  (MEASURED only)
    hints · stateHints · timing
    knowledge: MEASURED | UNVERIFIED | UNKNOWN | NOT_APPLICABLE
  }
  AIWebProvider <|.. ChatWebProvider
  ChatWebProvider --> AdapterSpec
  AdapterSpec <|-- DEEPSEEK
  AdapterSpec <|-- QWEN
  AdapterSpec <|-- GLM
```

One class drives all three sites. Each adapter is data: selector chains with provenance tags,
state hints, timing, and a `knowledge` map of what is known. Adding a site means adding an
adapter, not a class.

### UI state

```mermaid
stateDiagram-v2
  [*] --> LOADING
  LOADING --> CHAT_READY : composer visible + enabled
  LOADING --> AUTH_REQUIRED : password field / login dialog / 401·403
  LOADING --> CAPTCHA : challenge widget
  LOADING --> ERROR : 5xx / error alert, no composer
  LOADING --> READY : loaded, no composer, no login markers
  CHAT_READY --> GENERATING : sent; stop control / text changing
  GENERATING --> GENERATION_COMPLETE : completion signal
  GENERATING --> GENERATION_FAILED : reply request failed / error alert
  GENERATING --> RATE_LIMITED : 429 / rate-limit alert
  GENERATING --> AUTH_REQUIRED : login demanded on send
  GENERATION_COMPLETE --> CHAT_READY
  note right of AUTH_REQUIRED : terminal for automation.<br/>The run stops and records it.
```

`collectSignalsInPage` reports facts from the page. The pure function `classifyState` decides
what those facts mean, with a fixed precedence: CAPTCHA > login > HTTP auth > rate limit >
server error > error alert > generating > ready. Every rule is unit-tested against signal sets.
`UNKNOWN` is returned when the page does not answer within 8 s.

### Completion, without sleeps

```mermaid
flowchart TD
  tick[poll: mutation counter moved?] -->|no| cheap[reuse last text]
  tick -->|yes| read[read newest reply text]
  cheap & read --> D{CompletionDetector}
  D -->|stream closed + settle| C1[complete: stream-closed]
  D -->|stop control gone + settle| C2[complete: stop-button-gone]
  D -->|quiet for stability window,<br/>no stop control, no open request| C3[complete: stability]
  D -->|request open, quiet past stall window| P1[partial: stalled]
  D -->|request errored mid-transfer| P2[partial: interrupted]
  D -->|request HTTP ≥ 400| F1[failed]
  D -->|started and ended with nothing new| E[empty]
  D -->|nothing by start timeout| F2[no-start]
  D -->|hard ceiling| P3[partial: timeout]
```

- **Signals, strongest first.** The strongest is the reply request closing. It is measured on
  DeepSeek only (XHR `/api/v0/chat/completion`, tapped by the shared `providers/stream-tap.ts`).
  Next is the stop control disappearing (Qwen), then text stability. A strong signal shortens the
  wait but never skips the settle window.
- **Pauses.** While the stop control is visible, or the reply request is still open, stability
  alone does not end the wait. A model pausing mid-answer is not a finished answer.
- **Streaming capture.** `StreamCapture` reports each change as previous / current / delta. It
  labels re-renders as `rewrite` rather than inventing a delta.
- **Stuck pages.** Every in-wait page call is bounded. A page whose main thread is stuck ends as
  `interrupted` after `unresponsiveMs`, and the page is replaced.

## 3 · Extraction

```mermaid
flowchart LR
  A[assistant element] -->|snapshotLocator| DOM[DomNode tree<br/>whitespace kept in pre]
  A -->|innerText| TXT[visible text]
  DOM --> SEM[domToBlocks<br/>controls dropped, reasoning split,<br/>code lang from class or banner]
  SEM --> NORM[normalize<br/>code · tables · links · citations ·<br/>artifacts · file attachments]
  NORM --> STR[AIResponse]
  TXT -->|coverage check| STR
  COPY[site Copy control<br/>when counts match] -.upgrade code text.-> NORM
```

`AIResponse` fields are filled only from what was observed. `conversationId` comes from the URL,
`messageId` from markup, and `reasoning` only when a reasoning block exists. The response is
`empty` when nothing was said. Warnings record lost structure: no DOM means text only, and a
warning is added when the structured text covers under 60% of the visible text.

## 4 · Research

```mermaid
flowchart TD
  Q[question] --> PL[planner: decompose<br/>comparison × aspects, multi-part,<br/>documentation angle; distinctive words]
  PL --> LOOP{{round}}
  LOOP --> S[search: untried strategies<br/>per uncovered subquestion]
  S --> AG[aggregate: canonical URL merge,<br/>foundBy, groups]
  AG --> O[open best results per subquestion]
  O --> X[page model → chunks → BM25 rank → evidence]
  X --> FL[follow links judged against<br/>what is still missing]
  FL --> EVAL{coverage · budget}
  EVAL -->|uncovered, budget left| LOOP
  EVAL -->|sufficient / diminishing / exhausted /<br/>max rounds·queries·pages / time| CF[conflicts]
  CF --> CTX[context builder]
  CTX --> SYN[synthesis via an AIWebProvider,<br/>else extractive]
  SYN --> REP[ResearchReport + source graph]
```

### Search

```mermaid
flowchart LR
  SQ[SearchQuery<br/>text · strategy · subquestion] --> BB[BrowserSearchBackend<br/>engine adapter, scratch page]
  SQ --> GH[GitHubSearchBackend]
  SQ --> AI[AIWebSearchBackend<br/>provider's own search]
  BB & GH & AI --> N[SearchResult<br/>canonical_url · domain · source_type ·<br/>relevance signals · foundBy]
  BB -. challenge page .-> BL[status blocked, never solved]
```

Engine adapters: `FIXTURE_ENGINE` is tested. `DUCKDUCKGO_HTML` and `BING` are `UNVERIFIED`,
because they could not be reached from the development machine.

### Fetch and page model

`WebFetcher` tries plain HTTP first. It escalates to the browser when the page looks like an app
shell. The browser path waits for the text to stop changing and scrolls a bounded number of
times. `buildWebPage` produces sections with heading paths, links (with `inMain` and heading
context), tables, code, lists, images, metadata, `published_at` and a content hash. Three methods
vote on the main content: semantic tags, text density, and headings.

### Evidence

```mermaid
flowchart LR
  CH[chunks<br/>section-based, code/table whole] --> RK[BM25 over stems +<br/>heading · title · coverage ·<br/>source type · freshness · position]
  RK --> EV[candidate sentences / table rows<br/>exact spans, code skipped]
  EV --> F{focus hit ≥ threshold<br/>+ a distinctive word<br/>+ reads as a statement}
  F --> CL[Claim + Provenance<br/>URL → section → span]
  CL --> DD[dedupe: shingles · Jaccard · simhash]
  CL --> CO[conflicts: same unit, >2% apart, similar claim;<br/>polarity; never within one page]
```

Relevance is a set of named signals. There is no single made-up "quality score".

### Context

```mermaid
flowchart LR
  EVs[evidence by subquestion] --> GR[global BM25 re-rank<br/>per subquestion]
  GR --> DV[dedupe · no single source dominates]
  DV --> NUM[numbered citations]
  NUM --> T[context text:<br/>sources · evidence · conflicts · gaps]
  T -->|trim to maxContextChars| OUT
  OUT --> CHK[checkCitations on the answer:<br/>used · invalid · uncited sentences]
```

## 5 · Failure recovery

```mermaid
flowchart TD
  E1[renderer crash / page closed] --> R1[wait ends interrupted] --> R2[recover: context from<br/>session manager → page → lastUrl]
  E2[browser killed] --> R3[sharedBrowser relaunches] --> R2
  E3[main thread stuck] --> R4[bounded calls time out → unresponsive<br/>→ page closed, replaced]
  E4[selector stops matching] --> R5[next link in chain; health check<br/>reports fallback / broken]
  E5[navigation error] --> R6{classify}
  R6 -->|timeout · refused · aborted| R7[retry with backoff]
  R6 -->|dns · blocked · tls · crash| R8[stop: terminal]
  E6[AUTH_REQUIRED / CAPTCHA] --> R9[stop, diagnostics captured, recorded]
```

Diagnostics are written to `storage/diagnostics/`: a viewport screenshot, a sanitised DOM (script
bodies, input values and editable text removed, then redacted), an ARIA snapshot, and
`meta.json`. They are captured on every terminal state.

## 6 · Caching

| Namespace | TTL | Holds |
|---|---|---|
| `search` | 30 min | normalised results per backend+query |
| `page` | 6 h | fetched page models, keyed by canonical URL |
| `parsed` | 6 h | parsed DOM |
| `chunks` | 7 d | chunks by content hash |
| `evidence` | 7 d | evidence by content hash + subquestion |
| `meta` | 24 h | robots, redirects |

The caches use LRU eviction (500 entries) and can be mirrored to disk. Provider chat content is
never cached: it is authenticated.

## 7 · Testing harness

```mermaid
flowchart LR
  subgraph fixtures[test/web-fixtures/server.cjs]
    AI["/ai/deepseek|qwen|glm/&lt;scenario&gt;/"]
    WEB["/web/... docs, blog, mirror, spa, feed, slow, hang"]
    SE["/search?q="]
  end
  U[web-unit.cjs<br/>pure logic, in npm test] --> RES
  W[run-web.cjs<br/>real Chromium] --> fixtures
  W --> FR[fixture-results.json]
  L[closeni webtest<br/>live sites] --> LR[live-results.json]
  FR & LR --> REP[scripts/web-report.mjs] --> M[docs/testing/provider-matrix.md]
```

The three provider flavours run **the same scenarios**. Each flavour mirrors that provider's
known structure: DeepSeek uses XHR and has no stop control, Qwen has a stop control, and GLM is
contenteditable with obfuscated classes. The scenarios cover login, CAPTCHA, errors, modal,
popup, dialog, pause, late start, rewrite, stall, cut, layout change, slow stream, a locked main
thread, and an empty bubble.

| Command | Runs |
|---|---|
| `npm test` | whole unit suite, including `web-unit.cjs` |
| `npm run test:browser` | session manager, lifecycle, navigation, chains, diagnostics |
| `npm run test:providers` / `test:deepseek` / `test:qwen` / `test:glm` | identical scenarios per flavour |
| `npm run test:extraction` | normalisation units + recorded DeepSeek markup |
| `npm run test:research` | fetcher, search, loop, dedupe, conflicts, links, budgets |
| `npm run test:chaos` | killed browser, closed tab, removed selector, viewport, reload, malformed DOM |
| `npm run test:web` | all of the above (writes `fixture-results.json`) |
| `npm run test:all` | unit + web + e2e |
| `npm run webtest -- <deepseek\|qwen\|glm\|all> [--headed]` | live sites, results merged into `live-results.json` |
| `npm run web:report` | regenerates the matrix |

In a container where Playwright's pinned Chromium build is missing, point `CLOSENI_CHROMIUM` at a
Chromium binary.
