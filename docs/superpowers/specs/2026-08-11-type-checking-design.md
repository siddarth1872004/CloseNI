# Type checking, not just parsing

Design, 11 August 2026. Section 4 of `docs/NEXT.md`, first of three items.

## §4 is three projects, and one is further along than it reads

| Item | Actual state |
|---|---|
| Run the tests the model wrote | `behaviour-checker.ts` already runs a project's suite and a smoke check — but only **on demand** from the Test panel, never during a build, and **nothing ever asks the model to write tests** |
| Type checking beyond syntax | Genuinely missing — this document |
| A diff review step | Genuinely missing |

They share no machinery and want separate specs. This one was taken first
because it slots into `check-planner`, which is already pure and heavily tested,
and because it runs *per step* — so a failure lands while the model still has
the context to fix it and the existing repair loop already handles it.

## Two of the three examples would have been wrong

`NEXT.md` asks for "mypy, `tsc --strict`, `cargo clippy`".

- **`tsc --strict`** — `tsc --noEmit` already runs, and it honours the project's
  own `tsconfig.json`. Forcing `--strict` would override what the project's
  author configured and fail code that is correct by its own rules.
- **`cargo clippy`** — `cargo check` already catches type errors. Clippy adds
  *lint*, which is a different thing; a step burning both repair attempts on
  style is worse than not running it.
- **mypy** — the real gap. Python gets `py_compile`, which proves a file parses
  and nothing more. No type checking of any kind, in the language this app
  generates most often.

So the substance of this item is Python, and the `TYPE_RULES` list having one
entry is the finding rather than an omission.

## The flags are the feature

```
mypy --ignore-missing-imports --follow-imports=silent --no-error-summary \
     --cache-dir "<tmp>/mypy" "<file>"
```

- **`--ignore-missing-imports`** — without it, `import flask` fails with "Cannot
  find implementation or library stub for module named 'flask'". Every step of
  every Flask project would fail on a missing type stub rather than on its code.
  This single omission would make the feature actively harmful.
- **`--follow-imports=silent`** — resolves sibling modules for type information
  but reports nothing inside them. Otherwise step 6 fails over something step 2
  wrote, and the repair loop asks the model to fix a file it was never shown.
- **`--cache-dir`** — mypy writes `.mypy_cache` into the working directory
  otherwise. A check must not leave things in the project it is inspecting. The
  temp directory is stable across runs, so the cache is still reused.
- **`--no-error-summary`** — "Found 3 errors in 1 file" adds nothing to a
  message that has just listed all three.

Deliberately **not `--strict`**. Strict demands annotations everywhere and would
report dozens of "function is missing a type annotation" findings on correct
code, failing nearly every Python step twice before reporting it broken. Default
mypy reports genuine type errors and stays quiet about missing annotations,
which is exactly the bar wanted.

## Severity and ordering

A non-zero exit fails the check, like a compile failure, and the existing repair
loop sends the error back — which is the whole reason to run it per step rather
than at the end.

Syntax checks are ordered **before** type checks. A file that does not parse
makes mypy complain about the parse, and reporting that as a type failure would
send the model hunting a bug that is really a typo.

An absent mypy means the check is **skipped, not failed**. It is not installed on
most machines, and a build that refused to run without it would be worse than
one that checks a little less. `resolveTool` also probes `python3 -m mypy`,
because mypy is often installed into a virtualenv without its console script on
PATH.

`Check.kind` distinguishes the two in the log and the phase detail: a syntax
failure is the model producing something that does not parse, a type failure is
plausible code with a real bug in it.

## What is verified, and what is not

Tested: the planner emits the right command with every flag, mypy's absence
skips rather than fails, syntax is ordered first, languages that already have
real type checking gain nothing, each Python file gets its own check, and the
timeout is longer than a syntax check's.

**Not verified:** the mypy invocation has never been run against a real mypy.
This machine has no pip and installing one is a system-level change. So the
reasoning behind each flag is documented and the command is pinned, but the
claim "this does not flood a Flask project with stub errors" rests on the
documented behaviour of `--ignore-missing-imports`, not on an observation made
here. The first real Python build will confirm or refute it.

## Not in scope

- `ruff` or any linter. Style is not correctness, and the repair budget is two.
- Type checking languages that already have it.
- Asking the model to add annotations so stricter checking becomes possible.
