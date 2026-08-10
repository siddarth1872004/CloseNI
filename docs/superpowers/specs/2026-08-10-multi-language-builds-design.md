# Multi-language builds — design

Date: 2026-08-10
Roadmap item: 5 (JS, Rust, C, C++, Java)
Sub-project: 3 · Multi-language builds
Status: agreed in brainstorming. The check-scope decision (manifest first, then
per-file) was made by the project owner; the rest is the author's.

## Problem

The agent can write Rust, C, C++ and Java — `extractSignatures` already reads
all of them, so context selection works across languages, and the file walker
already treats `.rs`, `.c`, `.cpp`, `.java` as source. But **nothing verifies
any of it**. `detectSyntaxChecks` returns commands for `.py` and `.js` and an
empty array for everything else, so a Rust step is applied to the workspace
unverified and the run reports success on code nobody compiled.

Nothing runs them either. `detectEntrypoint` knows `npm start`, `node` and
`python3`; a generated Rust project has no Run button that works.

## The obstacle

**The existing architecture is per-file, and that assumption does not survive
contact with compiled languages.** `detectSyntaxChecks(filePath)` returns a
command for one file, which works because Python and JS both have a genuine
per-file syntax check that needs no dependencies: `py_compile` and `node
--check` read one file and answer.

Rust and Java are module-aware. A `.rs` file containing `mod utils;` fails
alone even when the crate is perfect, and a `.java` file referencing another
class fails alone for the same reason. Checking those files individually would
report failures the AI would then spend its self-heal retries trying to fix —
the same class of bug as the `python` versus `python3` mistake, which cost a
whole build.

C and C++ do not have this problem. `gcc -fsyntax-only` on one file is a real
answer.

## Decisions

1. **A manifest claims its language.** When `Cargo.toml` is present, the project
   is checked once with `cargo check` and no `.rs` file is checked individually.
   Same for `Makefile`, `pom.xml` and `build.gradle`. With no manifest, per-file
   checks apply — which is what step 1 of every build looks like.
2. **A missing toolchain skips; it never fails.** The precedent is
   `resolvePythonCommand`, which returns null and emits no command rather than
   one that cannot succeed. `cargo: not found` is a machine problem, and making
   the model retry against it wastes the run.
3. **A timed-out check is a failure.** Today it is a success — see below.
4. **The decision is a pure function**, so it can be tested on a machine with no
   Rust or Java installed. That is most machines, including this one.
5. **Go and TypeScript stay out.** Neither is in item 5.

## Design

### Two modules

**`verification/toolchain.ts` — is this tool here?**

`resolveTool(candidates: string[]): string | null` generalises
`resolvePythonCommand`: probe each candidate with `--version`, cache the answer
for the process, return null when none works. Python becomes one caller rather
than a special case, keeping its existing platform-ordered candidate list.

**`verification/check-planner.ts` — what should run?**

```typescript
planChecks(changedPaths: string[], workspaceFiles: string[], tools: ToolSet): Check[]
Check = { command: string; scope: "file" | "project"; language: string; timeoutMs: number }
```

`ToolSet` is `Record<string, string | null>` — the resolved command for each
tool name (`"cargo"`, `"gcc"`, `"javac"`, …), or null when it is not installed.

Pure: the caller reads the directory and probes the tools, then passes both in.
This is the module worth testing hardest, and it needs no compilers to test.

`detectSyntaxChecks` stays as the per-file entry point it already is, now
implemented in terms of the planner.

### What it plans

A manifest at the workspace root produces one command and suppresses every
per-file check for that language:

| Manifest | Check | Claims |
|---|---|---|
| `Cargo.toml` | `cargo check` | all `.rs` |
| `Makefile` | `make -n` | all `.c`, `.cpp`, `.h`, `.hpp` |
| `pom.xml` | `mvn -q compile` | all `.java` |
| `build.gradle` | `gradle compileJava -q` | all `.java` |

`make -n` is a dry run: it verifies the Makefile parses and its targets resolve
without building anything. A real `make` would produce object files and binaries
in the user's workspace, which is more than a check should do.

With no manifest, per-file:

```
main.c      ->  gcc -fsyntax-only main.c
app.cpp     ->  g++ -fsyntax-only app.cpp
scratch.rs  ->  rustc --edition 2021 --crate-type lib --emit=metadata --out-dir <tmp> scratch.rs
App.java    ->  javac -d <tmp> App.java
```

`--crate-type lib` so that a file without `fn main` is not rejected for lacking
one; a file that has one still compiles as a library.

**Per-file checks write nothing into the workspace.** `rustc` and `javac` both
emit artifacts, so both are pointed at a temp directory — a check that leaves
`.class` files beside the sources has modified the project it was inspecting.
Project-level checks are different and are left alone: `cargo check` and `mvn`
write into `target/`, which belongs to the project by convention and is what a
developer running the same command would get.

### The timeout trap

`runCommand` currently treats "timed out with no error output" as **success**,
reported as *"[Process ran for Ns with no errors. Assuming it's a running
server/background task.]"*. That is a reasonable reading of a command the model
suggested — `python -m http.server` should not count as a failure — and a wrong
reading of a syntax check, which is supposed to terminate.

It is already latently wrong for Python and JS. It becomes actively wrong here,
because `cargo check` on a first run downloads and compiles the dependency tree
and will exceed any short timeout.

`runCommand` gains an option, defaulting to today's behaviour so nothing that
currently works changes:

```typescript
runCommand(command, cwd, timeoutMs, { timeoutIsFailure: true })
```

Checks pass it. Model-suggested commands do not. Project checks get 180000ms;
per-file checks keep the existing 15000ms, which is ample for one file.

### Running

`detectEntrypoint` gains manifest-first rules, extending the precedence chain it
already has rather than replacing it:

```
Cargo.toml              ->  cargo run
Makefile with `run:`    ->  make run
Makefile                ->  make
main.c                  ->  gcc main.c -o main && ./main
main.cpp                ->  g++ main.cpp -o main && ./main
Main.java               ->  javac Main.java && java Main
```

Detecting a `run` target means reading the Makefile, so `detectEntrypoint` takes
the manifest contents it needs alongside the paths, the way it already takes
`packageJson`. It stays pure.

Maven and Gradle get checks but no Run. Running a Maven application needs an
exec plugin and a main class that cannot be inferred from the file listing, and
a Run button that fails confusingly is worse than one that is absent.

## Testing

**Unit — the planner, with no toolchain installed.** This is where the design
either holds or does not:

- `Cargo.toml` plus three `.rs` files yields **one** command, not three.
- The same three files without it yield three.
- A `.java` file under a `pom.xml` gets the project check and **no** per-file
  `javac`.
- An unavailable tool yields **zero** commands rather than one that cannot
  succeed.
- A manifest for one language does not suppress another's per-file checks: a
  `Cargo.toml` beside a `main.c` still checks the C.
- Per-file Rust and Java commands write to a temp directory, not the workspace.
- Project checks carry the long timeout; per-file checks the short one.

**Unit — entry point.** Manifest precedence, the `run` target, and the existing
Python and JS rules still winning where they should.

**End-to-end.** A temp workspace with a real C file and a real Rust file: the
check passes on valid code and fails on a deliberate syntax error. Skipped
cleanly when the toolchain is absent, the way the chromium-dependent tests
already skip, so the suite stays green on a machine without `gcc` or `rustc`.

## Non-goals

- Go and TypeScript. Both appear in the file walker and neither is in item 5.
  Each is a few lines in the planner once wanted.
- Running Maven or Gradle projects, for the reason above.
- Dependency installation. `cargo check` will fetch crates because that is what
  it does; nothing here runs `npm install`, `pip install` or `cargo add` on the
  user's behalf.
- Linting, formatting or type-checking beyond what the compiler does as part of
  answering "does this compile".
- Cross-compilation, toolchain version pinning, or build profiles.

## Consequences

- **Rust steps get slower.** `cargo check` on a first run is measured in tens of
  seconds. It is once per step rather than once per file, which is the better
  end of the trade, but it is real.
- **`make -n` checks the Makefile, not the C.** It verifies the build graph
  resolves; it does not compile anything. A project with a Makefile therefore
  gets a weaker check than one without, which is the price of not building
  artifacts into the user's workspace during verification.
- **A machine without the toolchain silently verifies nothing.** The run reports
  success on Rust nobody compiled — the same position as today, but now with a
  log line saying so. Making it a hard failure would break every machine that
  has Python but not Rust, which is most of them.
- The `timeoutIsFailure` fix changes behaviour for Python and JS checks too: a
  hanging `py_compile` now fails instead of passing. That is a bug fix, but it
  is a behaviour change and could surface as a newly-failing check on a slow
  machine.
