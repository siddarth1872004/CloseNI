/*
 * How long a plan will take to build.
 *
 * Mirrors local-agent/src/plan-scale.ts, which the renderer cannot require -
 * there is no bundler and no require in the renderer. One arithmetic function
 * is not worth an IPC round trip, so it is duplicated rather than plumbed.
 * Keep SECONDS_PER_STEP in step with the agent's copy.
 *
 * Loaded as a plain <script> (window.CNScale) and require()d by the test
 * harness (module.exports).
 */
(function (root) {
  var SECONDS_PER_STEP = 90;

  function estimateDuration(stepCount) {
    var minutes = Math.round((Math.max(0, stepCount || 0) * SECONDS_PER_STEP) / 60);
    if (minutes < 1) return "under a minute";
    if (minutes < 60) return "roughly " + minutes + " min";
    var hours = Math.floor(minutes / 60);
    var rest = minutes % 60;
    return "roughly " + hours + "h" + (rest ? " " + rest + "m" : "");
  }

  var api = { estimateDuration: estimateDuration };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNScale = api;
})(typeof window !== "undefined" ? window : globalThis);
