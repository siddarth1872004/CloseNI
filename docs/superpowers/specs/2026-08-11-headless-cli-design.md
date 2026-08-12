# A build with no window

Design, 11 August 2026. Section 7 of `docs/NEXT.md`.

## The refactor turned out to be unnecessary

The premise was that the scheduler and step loop live in `desktop/builder.js`,
inside the renderer, so a CLI would need them extracted.

Half of that is true. `builder.js` is 772 lines bound to 21 element ids and 18
`CN` methods. But the part that **decides what runs next** was never in there:
`desktop/scheduler.js` is pure, UMD, and has been `require`d from Node by the
unit suite for weeks. Nobody noticed it was already reusable outside a browser.

So this is a driver, not an extraction: load the plan, run `CNSched`, speak the
`build-session` protocol the agent already has.

## What it does, and does not

`closeni build ./project` runs the plan in `.closeni/build.json` — the file the
app already writes — with the same scheduling, dependency graph, checkpoints,
resume and timing.

It **does not plan**. The plan is the thing most worth a human eye before
eighteen steps run against it, and a headless command is the one place nobody
looks at it. Plan in the app, build headless — on a server, or overnight.

`--autonomy never` by default. The desktop app can ask before running a
suggested command; a headless run cannot, so the choice is between running
whatever the model suggests unattended and running none of it. Nobody is
watching, so the default is the one that cannot surprise you.

`--json` emits one object per event, for scripts. Exit code is 0 only if every
step finished; 1 if any failed; 2 for a usage or missing-plan problem.

## Timing comes free

The agent already prints `PHASE:` lines, and the CLI parses the same stream the
renderer listens to. So a headless build reports where its time went using the
identical module, with no second implementation to drift.

## What this actually bought

**The build path can now run outside Electron, and that is the surface nothing
could test.** Scheduling, dependency blocking, resume, per-step state on disk and
timing all lived in the renderer; exercising any of them needed Electron, a
provider and an account.

A stub agent that speaks the protocol and drives no browser now runs the whole
path in the test suite. Eighteen assertions, including the one that matters
most: **step 4 completes while step 2 has failed and step 3 is blocked** —
§2's scheduler work executing for real rather than being asserted about in
isolation.

Resume is covered the same way: a second run picks up the two completed steps,
retries the failed one, runs what it had blocked, and exits 0.

## Testing

Beyond the suite, all four paths were run by hand: a build with a failure, a
resume, `--json`, and the missing-plan refusal. Exit codes 1, 0, 0 and 2.

`verify.mjs` pins that the CLI **reuses** the app's scheduler and timing modules
rather than reimplementing them — a copy would drift and keep passing — and that
it is in the packaging allow-list, since a packaged app shipping without its CLI
would be a silent omission.

## Not verified

No headless build against a real provider. Every run so far used the stub. The
driver is exercised end to end; the agent it drives is not, in this path.

## Not in scope

- Planning from the CLI.
- Watching or streaming a build the desktop app is running.
- Multiple workspaces at once — that fights the Chromium profile lock and is its
  own item.
