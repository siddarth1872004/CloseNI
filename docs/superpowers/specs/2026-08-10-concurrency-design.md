# Concurrency & multi-agent — design

Date: 2026-08-10
Roadmap item: 4 (concurrent agents + inter-agent communication)
Sub-project: 4 · Concurrency & multi-agent
Status: agreed in brainstorming. The shape of concurrency — parallel steps with
a model-declared dependency graph — was chosen by the project owner.

## Problem

Every build step is a browser round-trip of roughly 90 seconds, and they run
strictly one after another. `buildSessionMode` chains them deliberately:

> Steps run one at a time; the chain stops a fast writer from interleaving two
> steps in the same browser.

That was the right call when a plan was capped at eight steps. Sub-project 10
removed the cap, because compressing a large project into eight steps produced
steps that each did too much. A twenty-step plan is now possible and takes
around half an hour, all of it spent waiting on one conversation at a time while
nothing else happens.

## The blocker that dissolved

The roadmap recorded this as blocked on browser profiles: `launchPersistentContext`
locks a profile directory, so two agents on the same provider would collide over
`storage/browser-profiles/deepseek`.

That is true of two *browsers*. It is not a constraint on two *conversations*.
One context can open many pages, which is exactly what a person with three tabs
open is doing. Concurrency within a provider is `context.newPage()`.

This also avoids profile cloning, which sub-project 8 already refused for
migration on the grounds that Chromium records absolute paths inside a profile
and a half-working copy fails much later in ways that make no sense. The same
reasoning applies here; refusing it twice for the same reason is consistent
rather than repetitive.

## The real constraint

**Later steps read earlier steps' files.** The plan prompt requires each step to
*write* a different set of files. It says nothing about what a step *imports*.
Run step 3 beside step 2 and it may import a module step 2 has not written yet.

Inferring that graph from the declared file lists is guesswork. A step listing
`api.py` gives no indication that `api.py` imports `models.py`. Guessing wrong
produces a build that fails for a reason nobody can see, on a step whose code
was correct.

## Decisions

1. **The model declares the graph.** It designed the project; it knows the
   dependencies. Inference does not.
2. **Only the conversation parallelises. Applies are serialised.**
3. **Pages within one context**, not profiles or processes.
4. **The default limit is 2**, because the failure mode is the user's account
   getting throttled.
5. **A plan without a graph runs exactly as it does today.**

## Design

### The graph

Each step gains an optional field:

```json
{ "title": "Build the API", "detail": "...", "files": ["api.py"], "dependsOn": [0, 2] }
```

Indices refer to earlier steps. The prompt asks for it directly:

> `dependsOn` lists the steps whose files this step imports or builds on. A step
> that needs nothing from another lists `[]`. Be accurate — steps with no
> declared dependency between them may run at the same time.

**Validated at parse time, not discovered at run time.** A cycle, a
self-reference, a forward reference or an index outside the plan makes the plan
unparseable, so the caller re-asks. A build that deadlocks halfway through is a
far worse outcome than one that asks the model to try again.

**Absent means serial.** A plan with no `dependsOn` anywhere is treated as a
chain — step *n* depends on step *n-1* — which reproduces today's behaviour
exactly. Older plans, hand-written plans and a model that ignores the field all
keep working.

### Parallel conversations, serialised applies

A step is two phases with very different characters:

| Phase | Duration | Touches |
|---|---|---|
| Talking to the model | 60–90s | nothing shared |
| Applying the patch | milliseconds | the workspace, `applyPatch` backups, the delta ledger |

**Only the first phase runs concurrently.** Applies queue behind a lock.

This removes every shared-state race by construction rather than by careful
locking. Two workers cannot interleave writes to the ledger, cannot both create
the same backup directory, and cannot both syntax-check a half-written tree —
not because the code is careful, but because only one of them is ever in that
phase. It costs almost nothing: the apply phase is a rounding error against the
wait it follows.

### Threads, and what parallelism costs

Each concurrent worker opens its own page and its own conversation thread.

That interacts with the delta optimisation from sub-project 1, which sends only
what a thread has not already seen — on the assumption there is one thread that
has seen the project listing. A fresh thread has seen nothing.

**So a parallel worker sends full context for its step.** The trade is tokens
for wall-clock time, and it applies only to steps that actually run in parallel;
a serial plan keeps its delta. This is a real cost, not a free win, and it is
the reason the concurrency limit is a setting rather than "as many as possible".

The main build thread is still recorded per workspace as it is today. Worker
threads are transient and are not persisted — resuming a build resumes the main
thread, and any steps that were mid-flight are simply re-run.

### The scheduler

A pure function, which is what makes any of this testable:

```typescript
runnableSteps(steps, state, limit): number[]
// state: { completed: number[]; failed: number[]; blocked: number[]; running: number[] }
```

Given what has finished, failed and is in flight, it returns which steps may
start now. Called after every state change, so a fast step's slot is reused
immediately rather than waiting for a wave to drain.

**A failed step blocks its dependents, and blocked is not failed.** If step 2
fails, step 4 depending on it never starts and is reported as `blocked`. Calling
it failed would claim something about code that was never run. The distinction
shows in the step list and in the final count.

### The limit

**Default 2, configurable in Settings, with the risk stated in the UI.**

These are free chat services being driven by automation. Three concurrent
conversations is materially more aggressive than one, and the realistic failure
is not a crash — it is the user's provider account being rate-limited or
suspended. That costs far more than a slow build ever saves.

The setting says so rather than presenting a number with no context.

### The step list

Several steps can now be `running` at once, and `blocked` is a new state
alongside `done`, `failed` and `skipped`. It gets the same treatment as the
others: a state colour and, since sub-project 10, the pixel spinner on each
running step rather than just one.

## Testing

The scheduler carries the weight, and needs no browser:

- No graph yields strictly serial order — the guarantee that nothing regresses.
- Independent steps are returned together, up to the limit.
- The limit is never exceeded, counting steps already running.
- A dependent does not start until its dependency completes.
- A failed step blocks its dependents, and their dependents, transitively.
- A blocked step is not reported as failed.
- Everything complete returns nothing rather than looping.
- A step already running is not returned twice.

Plan validation, also pure: cycles, self-reference, forward references, indices
past the end, a negative index, and `dependsOn` present on some steps but not
others.

End-to-end, the mock provider runs a four-step plan with a diamond graph and
asserts the middle two overlap in time while the last waits for both.

**Not testable here:** whether a real provider tolerates two or three concurrent
threads from one session. That needs the owner's account and a real build, and
it is the one assumption in this design that could prove wrong in a way the
tests cannot catch.

## Non-goals

- **Inter-agent communication in the sense of agents negotiating.** Item 4
  mentions it; a reviewer agent on a second provider was considered and set
  aside. It makes each step slower, which is the opposite of this sub-project's
  purpose, and it deserves its own decision rather than being smuggled in here.
- **Parallelism across providers.** The mechanism would support it, but it
  requires being signed into several and multiplies the rate-limit exposure. One
  provider, several pages, is enough to prove the design.
- **Concurrent builds in different workspaces.** Simpler than this and largely
  falls out of it, but it is not what was asked for.
- **Inferring dependencies from imports.** Parsing every generated file to build
  an import graph is a different project, and would be wrong for every language
  the parser did not cover.
- **Resuming mid-flight parallel steps.** A resumed build re-runs anything that
  was in progress.

## Consequences

- **Parallel steps cost more tokens**, because each fresh thread sends full
  context. A build can be faster or cheaper, not both.
- **The failure mode of a wrong graph is a failed build**, not a corrupted one —
  a step importing something not yet written fails its syntax check and self-heals
  or reports. That is the right failure, and it is why a model-declared graph is
  acceptable where inference would not be.
- **Rate limiting is a real risk the app cannot detect well.** A provider
  throttling a session looks like a slow reply, which the completion detector
  will wait out. The mitigation is a conservative default, not cleverness.
- **The step list is no longer a sequence.** Reading a build becomes slightly
  harder: several things happen at once, and the order in the list stops
  matching the order of events.
- **Nothing regresses for a plan without a graph**, which is every plan that
  exists today.
