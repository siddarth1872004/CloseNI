# Tests the model wrote, run while it can still fix them

Design, 11 August 2026. Section 4 of `docs/NEXT.md`, second of three items.

## What was already there

`behaviour-checker.ts` discovers a project's test suite across nine ecosystems,
distinguishes "no suite" from "no runner installed", and knows that a server
passing means it is *still running* when the smoke window closes. None of that
needed rebuilding.

Two things were missing:

1. Nothing ever asked the model to write tests.
2. The suite ran only on demand from the Test panel, never during a build — so a
   failure surfaced long after the step that caused it, with no repair loop left
   to act on it.

## Which steps get tests

The plan declares it. Each step gains a `testable` flag, and the planning prompt
explains what earns one: a calculation, a parser, a route, a state change —
never scaffolding, configuration, dependency lists or static assets.

Decided **once**, while the model is designing the project as a whole, rather
than eighteen times by a model already busy writing code. An optional
"write tests if the step warrants it" appended to each step prompt becomes "no
tests, ever", quietly, and nothing records that it did.

Asking every step instead would produce, on a scaffolding step, a test asserting
that a config constant equals itself — which costs tokens, costs time, and
teaches everyone to skip the test output.

## When the suite runs

After the syntax and type checks pass, before the model's suggested commands.

Ordering is deliberate: a suite that cannot import the module it tests reports a
confusing failure when the plain answer is that the file does not compile.

**Gated on tests actually existing**, and that gate is load-bearing rather than
tidy. A project with a `pyproject.toml` matches the pytest rule from step one,
and `pytest -q` with nothing to collect exits non-zero. Without the gate, every
step before the first test was written would fail its test check, and the repair
loop would spend both its attempts fixing a suite that does not exist.

`hasTestFiles` answers it from filenames only — every convention it recognises is
one the language's own runner uses for discovery.

The whole suite runs, not just the tests this step wrote. That is the point: a
step that breaks an earlier step's tests should fail at the step that broke them.

## What a failure means

This is the risk the feature carries, and it needs its own follow-up.

Every other check is unambiguous. A compiler failing means the code is wrong;
there is nothing else it could mean. A test failing means the code is wrong **or
the assertion is** — and the model wrote both, minutes apart.

The generic follow-up says "your code failed when tested, fix the root cause".
Given a wrong assertion, a model told that will bend correct code until the
assertion passes. That lands on disk as a green step with the behaviour quietly
broken — strictly worse than having written no test at all.

So `buildTestFollowUp` names the ambiguity and makes deciding it the task: here
is the failure, work out whether the code or the assertion is wrong and fix that
one. It also forbids the two escapes — changing working code to satisfy a wrong
assertion, and weakening or deleting a test to make it pass.

Routed by `command === "run tests"`, alongside the existing `"apply patch"`
branch. Three failure classes, three different things worth saying.

## Carrying the flag

`testable` has to survive plan → renderer step list → IPC → session → step
prompt, and be remembered across a restart. That is the exact journey `dependsOn`
did not survive, where one missing field in a `map` silently killed a whole
feature with correct modules on both sides of it.

So every hop is pinned in `verify.mjs` rather than trusted.

## Testing

`hasTestFiles` and `buildTestFollowUp` are pure and tested directly: each
language's test-file convention, near-misses that must not match (`latest.py`, a
`contest/` directory), Windows separators, and every property the follow-up must
have — including that it does **not** contain the wording that asserts the code
is at fault.

## Not verified

No live build has run this. The prompt changes, the `testable` flag arriving
from a real plan, and a real test failure routing to the new follow-up have all
been tested in isolation and never end to end against a provider.

## Not in scope

- Running only the tests a step wrote. Regressions are the point.
- A coverage requirement.
- Generating tests for code the model did not write in this build.
