/**
 * Which steps depend on which.
 *
 * Later steps read earlier steps' files. The plan guarantees each step *writes*
 * a different set; it says nothing about what a step *imports*. Inferring that
 * from file lists is guesswork, and guessing wrong fails a step whose code was
 * correct - so the model that designed the project declares it instead.
 */

/** The implicit chain: step n waits for step n-1. Today's behaviour, exactly. */
export function serialGraph(count: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < count; i++) out.push(i === 0 ? [] : [i - 1]);
  return out;
}

/**
 * Each step's dependencies, declared or implied.
 *
 * A plan where no step declares anything is a chain. A plan where any step
 * declares something is taken at its word, including the steps that declared an
 * empty list - an empty list is an answer, not a silence.
 */
export function normaliseGraph(steps: { dependsOn?: number[] }[]): number[][] {
  const list = steps || [];
  const anyDeclared = list.some((s) => Array.isArray(s && s.dependsOn));
  if (!anyDeclared) return serialGraph(list.length);
  return list.map((s) => {
    const deps = s && s.dependsOn;
    return Array.isArray(deps) ? deps.slice() : [];
  });
}

/**
 * Is this graph usable?
 *
 * Rejected at parse time so the caller re-asks. A build that deadlocks halfway
 * through, or runs a step before the module it imports exists, is a far worse
 * outcome than one more round-trip to the model.
 */
export function validateGraph(steps: { dependsOn?: number[] }[]): { ok: boolean; reason?: string } {
  const list = steps || [];
  for (let i = 0; i < list.length; i++) {
    const deps = list[i] && (list[i] as any).dependsOn;
    if (deps === undefined) continue;
    if (!Array.isArray(deps)) return { ok: false, reason: "step " + i + " has a dependsOn that is not a list" };
    for (const d of deps) {
      if (typeof d !== "number" || !Number.isInteger(d)) {
        return { ok: false, reason: "step " + i + " depends on a non-integer" };
      }
      if (d === i) return { ok: false, reason: "step " + i + " depends on itself" };
      if (d < 0 || d >= list.length) return { ok: false, reason: "step " + i + " depends on " + d + ", which does not exist" };
      // Only backwards references. A step depending on a later one is either a
      // cycle or a plan whose order means nothing.
      if (d > i) return { ok: false, reason: "step " + i + " depends on later step " + d };
    }
  }

  // Backwards-only references cannot form a cycle, so this walk should never
  // fire. It stays explicit rather than living as a proof in a comment: a future
  // change permitting forward references would otherwise reintroduce deadlock
  // silently.
  const graph = normaliseGraph(list);
  const state = new Array(graph.length).fill(0);
  const walk = (i: number): boolean => {
    if (state[i] === 1) return false;
    if (state[i] === 2) return true;
    state[i] = 1;
    for (const d of graph[i]) if (d >= 0 && d < graph.length && !walk(d)) return false;
    state[i] = 2;
    return true;
  };
  for (let i = 0; i < graph.length; i++) if (!walk(i)) return { ok: false, reason: "the graph contains a cycle" };
  return { ok: true };
}
