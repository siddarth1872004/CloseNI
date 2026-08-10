/*
 * What may start now?
 *
 * A work queue rather than waves: called after every state change, so a fast
 * step's slot is reused immediately instead of waiting for its whole wave to
 * drain.
 *
 * Loaded as a plain <script> in the renderer (window.CNSched) and require()d by
 * the test harness. There is no bundler, so no import/export.
 */
(function (root) {
  function has(list, i) { return (list || []).indexOf(i) !== -1; }

  /**
   * Every step that can no longer run because something it needed failed.
   *
   * Transitive: if 1 depends on 0 and 3 depends on 1, a failure at 0 blocks
   * both. Reported as blocked rather than failed - a step that never ran must
   * not be described as having failed.
   */
  function blockedBy(graph, failed) {
    var g = graph || [];
    var dead = (failed || []).slice();
    var out = [];
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = 0; i < g.length; i++) {
        if (dead.indexOf(i) !== -1) continue;
        for (var j = 0; j < (g[i] || []).length; j++) {
          if (dead.indexOf(g[i][j]) !== -1) {
            dead.push(i);
            out.push(i);
            changed = true;
            break;
          }
        }
      }
    }
    return out.sort(function (a, b) { return a - b; });
  }

  function runnableSteps(graph, state, limit) {
    var g = graph || [];
    var s = state || {};
    var slots = Math.max(0, (limit || 1) - (s.running || []).length);
    var out = [];
    for (var i = 0; i < g.length && out.length < slots; i++) {
      if (has(s.completed, i) || has(s.failed, i) || has(s.blocked, i) ||
          has(s.skipped, i) || has(s.running, i)) continue;
      var ready = true;
      for (var j = 0; j < (g[i] || []).length; j++) {
        var d = g[i][j];
        // A skipped dependency counts as satisfied: the user chose to move past
        // it, and blocking everything downstream would make Skip useless. A
        // failed one does not - its dependent is blocked, not runnable.
        if (!has(s.completed, d) && !has(s.skipped, d)) { ready = false; break; }
      }
      if (ready) out.push(i);
    }
    return out;
  }

  /**
   * Rebuild scheduler state from what the step list already records.
   *
   * Without this, starting a build after a partial run begins again at step 0
   * and redoes work that succeeded - which is what made recovering from a
   * failure feel like starting over.
   *
   * "running" is deliberately not carried over: a step left running when the
   * app closed is not running now, and treating it as in-flight would wedge the
   * scheduler waiting for something that will never report back.
   */
  function seedState(steps) {
    var state = { completed: [], failed: [], blocked: [], skipped: [], running: [] };
    (steps || []).forEach(function (s, i) {
      var st = s && s.status;
      if (st === "done") state.completed.push(i);
      else if (st === "failed") state.failed.push(i);
      else if (st === "blocked") state.blocked.push(i);
      else if (st === "skipped") state.skipped.push(i);
    });
    return state;
  }

  var api = { runnableSteps: runnableSteps, blockedBy: blockedBy, seedState: seedState };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNSched = api;
})(typeof window !== "undefined" ? window : globalThis);
