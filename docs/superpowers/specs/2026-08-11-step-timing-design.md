# Where a build's time went

Design, 11 August 2026. Section 7 of `docs/NEXT.md`.

## There is no cost

The item is listed as "cost/time reporting". CloseNI drives free web chats —
no API billing, no tokens to price. So cost can only mean time, and saying that
plainly is better than inventing a currency.

## The signal already existed

The agent reports seven phases — `connecting`, `opening`, `reading`, `sending`,
`writing`, `applying`, `checking` — and each is emitted **at the point it was
observed on the page**, never inferred from "we sent a prompt, so it is probably
generating". That property is why timing them is worth anything.

Nothing was measuring them. The renderer already receives every transition and
already knows which step is running, so this costs a clock and a map.

## Why phases and not step totals

A step that took four minutes was either waiting on the model or running a slow
test suite. Those need completely different fixes, and a step total cannot tell
them apart. Splitting `writing` from `checking` is the entire point.

## Attribution, and refusing to guess

A phase closes when the next one opens, so time between a step starting and its
first phase — or between the last phase and the step finishing — belongs to
neither. It is reported as `unaccounted` rather than folded into a neighbour.

Silently attributing eight seconds to `checking` when nobody knows where they
went is how a timing report starts lying, and a report that lies about small
numbers cannot be trusted about large ones. Every millisecond of a step's total
is accounted for, and that is asserted in a test.

Build percentages come from summed phase time rather than the wall clock: the
gaps *between* steps belong to whoever is reading the screen, not to the build.

## Which step a phase belongs to

A session runs one step at a time, so the question has exactly one answer —
the same property that lets the review gate work. A phase arriving with no step
running belongs to a chat or a plan and is dropped.

## Storage

`timing: { totalMs, phases }` on each step in `build.json`, so it survives a
restart and travels with an export.

Re-validated on read rather than trusted: this round-trips through JSON on disk
that a person can edit, and a `NaN` reaching `formatDuration` would put
`"NaNms"` in the report. Phase names are deliberately **not** checked against a
list — a new phase should appear in the report the day it is added, not the day
someone remembers to update a constant.

## Where the module lives

`desktop/step-timing.js`, UMD, beside `scheduler.js` and `plan-edit.js`. Only
the renderer times a build, and a browser cannot load the agent's CommonJS.

## Testing

The arithmetic is pure and tested directly: attribution across five phases,
unaccounted time at both ends, that every millisecond adds up to the total,
double-`finish`, build rollup, and the duration formatter — including the
rounding carry where 239600ms would otherwise read as `3m 60s`.

## Not verified

No build has been timed. The phase stream, the per-step clock and the report
have been tested against synthetic timestamps; none has run in Electron against
a real build.

## Not in scope

- Timing chat or plan runs. They are one round trip with nothing to break down.
- Comparing runs, or storing a history of builds.
- Estimating a build's duration before it runs — `plan-scale.js` already guesses
  from the step count.
