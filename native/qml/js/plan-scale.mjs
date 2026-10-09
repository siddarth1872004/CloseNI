/*
 * How long a plan will take to build.
 *
 * Mirrors local-agent/src/plan-scale.ts, which the renderer cannot require -
 * there is no bundler and no require in the renderer. One arithmetic function
 * is not worth an IPC round trip, so it is duplicated rather than plumbed.
 * Keep SECONDS_PER_STEP in step with the agent's copy.
 *
 * Ported from desktop/plan-scale.js: an ES module imported by the QML app
 * and by the test harness. desktop/ was deleted with Electron in 0.4.0, so
 * this is the only copy.
 */
var SECONDS_PER_STEP = 90;

function estimateDuration(stepCount) {
  var minutes = Math.round((Math.max(0, stepCount || 0) * SECONDS_PER_STEP) / 60);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return "roughly " + minutes + " min";
  var hours = Math.floor(minutes / 60);
  var rest = minutes % 60;
  return "roughly " + hours + "h" + (rest ? " " + rest + "m" : "");
}

export {
  estimateDuration,
};
