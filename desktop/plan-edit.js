/*
 * Editing a plan before building it.
 *
 * Lives in desktop/ rather than local-agent/, as scheduler.js does and for the
 * same reason: only the renderer edits a plan, and a browser cannot load the
 * agent's CommonJS output. Loaded as a plain <script> (window.CNPlanEdit) and
 * require()d by the test harness. No bundler, so no import/export.
 */
(function (root) {
  function deps(step) {
    return Array.isArray(step && step.dependsOn) ? step.dependsOn : undefined;
  }

  /** Unique, ascending, and never pointing at itself. */
  function tidy(list, self, count) {
    const seen = new Set();
    const out = [];
    for (const d of list) {
      if (typeof d !== "number" || !Number.isInteger(d)) continue;
      if (d === self || d < 0 || d >= count) continue;
      if (seen.has(d)) continue;
      seen.add(d);
      out.push(d);
    }
    return out.sort((a, b) => a - b);
  }

  /**
   * Remove a step, and give whatever needed it what IT needed.
   *
   * A step with no declared dependencies keeps having none: `undefined` and `[]`
   * mean different things to the scheduler - an empty list is an answer, absence
   * is a silence - and turning one into the other here would change how the whole
   * plan is scheduled.
   */
  function deleteStep(steps, index) {
    const list = (steps || []).slice();
    if (index < 0 || index >= list.length) return { steps: list, notes: [], refused: "no such step" };
    if (list.length === 1) return { steps: list, notes: [], refused: "a plan needs at least one step" };

    const inherited = deps(list[index]) || [];
    const kept = list.filter((_, i) => i !== index);
    const notes = [];

    const out = kept.map((step, newIdx) => {
      const oldIdx = newIdx < index ? newIdx : newIdx + 1;
      const declared = deps(step);
      if (!declared) return Object.assign({}, step);

      let next = [];
      for (const d of declared) {
        if (d === index) {
          // Inherited rather than dropped. All of these are below `index`
          // already, because a step may only depend on an earlier one, so they
          // survive the shift below unchanged.
          if (inherited.length) {
            notes.push("step " + (oldIdx + 1) + " now depends on " +
              inherited.map((n) => "step " + (n + 1)).join(", ") + " instead");
          }
          next = next.concat(inherited);
        } else {
          next.push(d);
        }
      }
      next = next.map((d) => (d < index ? d : d - 1));
      return Object.assign({}, step, { dependsOn: tidy(next, newIdx, kept.length) });
    });

    return { steps: out, notes: Array.from(new Set(notes)) };
  }

  /**
   * Move a step to a new position, or refuse and explain.
   *
   * Refusal is checked across the WHOLE plan, not just the moved step: moving
   * step 2 down can put it after step 5, which depended on it, and that is the
   * case a naive check misses because the step being dragged is fine.
   */
  function moveStep(steps, from, to) {
    const list = (steps || []).slice();
    if (from < 0 || from >= list.length) return { steps: list, notes: [], refused: "no such step" };
    const target = Math.max(0, Math.min(to, list.length - 1));
    if (target === from) return { steps: list, notes: [] };

    // order[newIndex] = oldIndex
    const order = list.map((_, i) => i);
    order.splice(from, 1);
    order.splice(target, 0, from);

    const newPos = new Array(list.length);
    order.forEach((oldIdx, newIdx) => { newPos[oldIdx] = newIdx; });

    for (let oldIdx = 0; oldIdx < list.length; oldIdx++) {
      for (const d of deps(list[oldIdx]) || []) {
        if (d < 0 || d >= list.length) continue;
        if (newPos[d] >= newPos[oldIdx]) {
          return {
            steps: list,
            notes: [],
            refused: "step " + (oldIdx + 1) + " depends on step " + (d + 1) +
              ", so it cannot run before it. Move that one too, or remove the dependency first.",
          };
        }
      }
    }

    const out = order.map((oldIdx, newIdx) => {
      const step = list[oldIdx];
      const declared = deps(step);
      if (!declared) return Object.assign({}, step);
      return Object.assign({}, step, {
        dependsOn: tidy(declared.map((d) => newPos[d]), newIdx, list.length),
      });
    });

    return { steps: out, notes: [] };
  }

  /**
   * Fold a step into the one before it.
   *
   * For a plan that split something too finely. The merged step needs everything
   * both halves needed, minus each other - a step cannot wait for itself, and the
   * earlier half is now part of it.
   */
  function mergeStepUp(steps, index) {
    const list = (steps || []).slice();
    if (index <= 0 || index >= list.length) {
      return { steps: list, notes: [], refused: "there is no step above this one to merge into" };
    }

    const above = list[index - 1];
    const here = list[index];
    const bothDeps = (deps(above) || []).concat(deps(here) || [])
      .filter((d) => d !== index && d !== index - 1);
    const declared = deps(above) || deps(here) ? tidy(bothDeps, index - 1, list.length) : undefined;

    const merged = Object.assign({}, above, {
      title: [above.title, here.title].filter(Boolean).join(" + "),
      detail: [above.detail, here.detail].filter(Boolean).join("\n\n"),
      files: Array.from(new Set((above.files || []).concat(here.files || []))),
      // Testable if either half was: losing the flag would quietly stop the
      // merged step being asked for tests.
      testable: above.testable === true || here.testable === true ? true : undefined,
    });
    if (declared) merged.dependsOn = declared;

    const combined = list.slice();
    combined[index - 1] = merged;
    const after = deleteStep(combined, index);
    return {
      steps: after.steps,
      notes: ["merged step " + (index + 1) + " into step " + index].concat(after.notes),
    };
  }


  var api = { deleteStep: deleteStep, moveStep: moveStep, mergeStepUp: mergeStepUp };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNPlanEdit = api;
})(typeof window !== "undefined" ? window : globalThis);
