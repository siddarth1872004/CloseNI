# Editing a plan without breaking its graph

Design, 11 August 2026. Section 7 of `docs/NEXT.md`.

## The UI is the easy half

`dependsOn` holds **zero-based indices** into the step array. Every edit that
changes what sits at which index rewrites the whole graph — and getting it wrong
does not throw. It produces a graph that fails validation, falls back to the
plain chain, and quietly undoes §2's work, so one failure blocks everything
behind it again.

So the feature is the index remapping. The buttons are incidental.

## Two rules

Both chosen because the alternative silently discards something the model
actually said.

**Deleting a step hands its dependents its own dependencies.** If 6 needed 3 and
3 needed 1, then 6 still needs 1 — that was always true, and dropping the
reference would lose a real ordering constraint. The inherited indices are all
below the deleted one already, because a step may only depend on an earlier
step, so they survive the shift unchanged.

**Moving a step above something it depends on is refused**, naming both steps.
Allowing it and dropping the dependency would let a step run before the module
it imports exists — a build failure produced by a drag.

The refusal check runs across the **whole plan**, not just the moved step.
Moving step 2 down can strand step 5, which depended on it; a naive check looks
only at the step being dragged and finds it fine.

## Two distinctions that matter

`undefined` and `[]` mean different things to the scheduler: an empty list is an
answer, absence is a silence. An edit must not turn one into the other, or it
changes how the entire plan is scheduled. So an undeclared step stays
undeclared.

Merging keeps `testable` if **either** half had it. Losing it would quietly stop
the merged step being asked for tests.

## Where the module lives

`desktop/plan-edit.js`, not `local-agent/src/`, and as a UMD module — exactly
where `scheduler.js` lives and for the same reason. Only the renderer edits a
plan, and a browser cannot load the agent's CommonJS output. It was written in
TypeScript first and moved once that became obvious.

Edits are applied by replacing the plan object, never by mutating the array the
UI is rendering: an edit that half-applied before hitting a conflict would leave
the list describing nothing.

## Testing

The remapping is pure and tested directly against `CNSched.graphFor`, so every
result is asserted to still schedule — the failure mode is a graph that looks
fine and silently degrades, and checking indices alone would not catch it.

Covered: inheritance on delete, deleting the first step, a one-step plan,
undeclared steps staying undeclared, a refused move in both directions
(above a dependency, and below a dependent), a legal move remapping every index,
and merging — titles, details, files, `testable`, and that the merged step does
not end up depending on itself.

One test failed and **the test was wrong, not the code**: I asserted the wrong
expected mapping for a move. Hand-checking `newPos` confirmed the implementation.

## Not verified

The UI has not run. The remapping is thoroughly tested; the buttons, the
click delegation and the redraw have not been exercised in Electron.

## Not in scope

- Drag and drop. Up/down buttons are testable and unambiguous.
- Editing a step's title or detail text.
- Adding a step. Every step needs a `files` list and a `detail` the model wrote;
  an empty one invented here would be worse than re-planning.
- Editing a plan mid-build.
