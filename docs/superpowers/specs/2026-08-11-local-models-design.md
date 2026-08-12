# A provider that is not a web page

Design, 11 August 2026. Section 5 of `docs/NEXT.md`.

## The claim in NEXT.md was false

It said "the architecture already separates provider from how you talk to it".
It did not. `PlaywrightController` is a concrete class with a **twenty-three
method surface**, and `index.ts` depends on it directly. There was no interface
of any kind.

Most of that surface only means anything to a web page: `probeSelectors`,
`readCodeViaCopy`, `countMessages`, `getLastMessageText`, `waitForLogin`,
`navigateToChat`, `streamStats`. Those exist *because* we are scraping.

A local model needs one thing: send a prompt, get a reply.

## The seam is four methods

`ChatSession` — `start`, `ready`, `ask`, `reset`. None mention a page.

`ask` is deliberately one call rather than the send/poll/read triple the browser
uses. Polling is a consequence of not being told when a reply arrives; a
transport that *is* told has no use for it, and an interface that insisted would
make every non-browser provider implement three methods to satisfy a shape it
does not have.

`ready` is separate from `start` because "it opened" and "it will work" are
different questions, and the second is the one worth showing a user.

## Two implementations, on purpose

Extracting an interface from exactly one implementation produces an abstraction
shaped like that implementation. So `OllamaSession` lands in the same change:
an abstraction with one implementor is a rename.

`BrowserChatSession` is a thin adapter over the existing controller — no new
behaviour, including the read-retry that falls back to `innerText`. Thin on
purpose: a thick adapter would be a second place for browser behaviour to live,
and the point of the seam is to have exactly one.

`OllamaSession` speaks `/api/chat`, which LM Studio also serves, so one
implementation covers both. No HTTP dependency: Node's own `http` is enough for
a POST to localhost, and a tool that drives browsers has no business growing a
dependency tree to reach a port on the same machine.

`stream: false` — there is no page filling up and no user watching a partial
answer. Asking for the whole reply removes an entire class of reassembly bug
that the browser path spends real effort on.

## Chat only, and it says so

Plan and build stay browser-only. A small local model failing the strict JSON
format would read as CloseNI being broken rather than the model being too small,
and betting the build machinery on that was not worth it in a first slice.

`requireBrowser` refuses at the entry point, with a sentence naming the
provider and what to switch to. Letting it through would fail somewhere inside a
page interaction that will never happen, reporting a missing selector on a
provider that has no page.

The selector health check returns early for a non-browser transport rather than
reporting seven skipped selectors, because "no selectors to check" is the honest
answer, not "nothing matched".

## What the drift check caught

Adding an enabled provider broke `verify.mjs`: the site claims one provider
ready, the registry now had two. Bumping the number would have **overstated** —
Ollama cannot build.

So "ready" now means *can do everything*, and a `chatOnly` provider is counted
and described separately. The site's claim stays true, and two new checks
require any chat-only provider to say so in its config and in the README.

## Testing

The pure parts — transport resolution, model-name matching against versioned
tags, reply parsing, failure messages — are tested directly.

The session is tested against a **real HTTP server** started in the test, so the
request path itself runs: the conversation accumulates, `reset` empties it, the
server sees the whole history, `stream` is false, and a failed turn does not
leave its question in the history — which would otherwise have every later
request re-send a question that was never answered.

Both CLI paths were run here: `chat` against a stopped server produces "Nothing
is listening on http://127.0.0.1:11434. Start Ollama (`ollama serve`)…", and
`plan` refuses with the switch-provider sentence. Neither launched a browser.

## Not verified

No reply has come back from a real model. The request shape follows Ollama's
documented `/api/chat`, and the fake server proves the client sends what it
intends to send, but nothing here has talked to Ollama itself.

## Not in scope

- Plan and build over a local model.
- Streaming replies.
- Persisting a local conversation across app restarts — `reset` is per process.
- Discovering models to offer in a dropdown.
