# Research without scraping a search engine

Design, 11 August 2026. Section 6 of `docs/NEXT.md`.

## The proposed fix was the project's own trap

`NEXT.md` said: *"The fix is not a better scraper — it is to run the search in
the browser the app already drives."*

That would mean a new set of selectors for result titles, links and snippets,
against a page nobody controls. Search-result markup rots **faster** than chat
UIs do, and this project's stated through-line is that every serious bug it has
had came from guessing at someone else's web page. It would also probably not
work: a fresh Chromium profile can still be served a challenge.

## What was already there

Two things, both unnoticed:

- **DeepSeek has a "Smart Search" toggle**, already wired into this app as a
  provider control (`smart-search`, default off, selector `"Search"`). The app
  could already turn on the provider's own web search.
- **The app holds a GitHub token** in `safeStorage` for push and clone, while
  the research panel used an *unauthenticated* search — rate-limited to ten
  searches a minute across the whole machine, so a second question in the same
  minute returned an error that read as the feature being broken.

So both halves were solvable with things the app already had.

## The design

**Web half.** Force `smart-search` on for that run by overriding
`AGENT_CONTROLS` in the agent process — not by writing to saved settings, since
researching once must not silently change what every later chat does. Ask the
question with a prefix that requests a short factual answer followed by a
`SOURCES:` block, then extract the URLs.

`extractSources` falls back to any URL in the text when there is no marker,
because models cite inline about half the time; a missing block means an answer
with no links, not a failed run.

A provider with no `smart-search` control is refused with a sentence, rather
than being asked a research question it would answer from memory while the panel
presents it as researched.

**GitHub half.** `searchRepos` through the existing token — thirty searches a
minute instead of ten. Only the six fields the panel shows are returned; a
search response carries about eighty per repository, and passing all of it
through IPC to display four lines is waste.

**Both at once.** Started together and reported separately: GitHub failing
because you are not signed in must not hide a good web answer, and a busy
provider must not hide the repositories.

Research uses its own chat session, so it never disturbs the build's
conversation.

## What removing the gate exposed

**147 lines of dead scraping code** were still in `index.ts` —
`researchDuckDuckGo`, `unwrapDuckDuckGoUrl`, `httpGetText`, `researchGithub` and
their helpers, unreachable since `researchMode` became a stub. Dead scraping
code is exactly what gets wired back in later, so it is deleted rather than left.

**The docs had drifted in three places.** README called Research gated in three
passages, the site called it unfinished in two. Gating a tab is a markup edit
and updating the prose is a separate act of will — the same failure the provider
counter check exists for. So there are now checks that the markup and the docs
agree about whether Research is gated, in both directions.

There is also a check that research does **not** reference a search engine
domain, with comments stripped — so explaining why we do not scrape cannot
satisfy the check that we do not.

## Testing

`extractSources` and `hasSearchControl` moved into `research.ts` so they can be
tested without starting the CLI — requiring `index.ts` runs `main()`, the same
reason `follow-up.ts` exists. `searchRepos` is tested against an injected
request function: the endpoint, the encoding, the limit, the shape returned, and
that an empty query makes no request at all.

## Not verified

No live research run. The Smart Search toggle being applied, the provider
actually searching, and the `SOURCES:` block coming back in the requested shape
have not been observed — only the parsing of them has.

## Not in scope

- GitHub *code* search, as opposed to repository search.
- Caching research answers.
- Research over a local provider — Ollama has no web search.
