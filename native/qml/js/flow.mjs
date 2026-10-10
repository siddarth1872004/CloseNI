/*
 * The project flow: describe, plan, build, test, ship.
 *
 * An ES module imported by the QML app and by the test harness.
 *
 * The app always had this order - chat produces a plan, the plan produces a
 * build, the build is run, the result is pushed - but nothing on screen said
 * so. Six tabs of equal weight left a first-time user to discover that Builder
 * is empty until Chat has made a plan, and that Test has nothing to run until
 * Builder has written files.
 *
 * Like the getting-started checklist, every stage is derived from state the
 * app already holds and never from a flag of its own, so the bar cannot say
 * "built" beside a build that failed.
 */
var STAGES = [
  { id: "describe", label: "Describe", mode: "chat",  next: "Describe what to build in Chat." },
  { id: "plan",     label: "Plan",     mode: "chat",  next: "Generate a plan from the conversation." },
  { id: "build",    label: "Build",    mode: "build", next: "Start the build." },
  { id: "test",     label: "Test",     mode: "test",  next: "Run the project." },
  { id: "ship",     label: "Ship",     mode: "push",  next: "Commit and push it." },
];

function n(v) { return typeof v === "number" && isFinite(v) && v > 0 ? v : 0; }

/**
 * Each stage's state from a snapshot of the app:
 *   { messages, plan, stepsTotal, stepsDone, stepsFailed, building, tested, shipped }
 *
 * Returns the five stages with status "done", "active" (in progress now),
 * "failed", "next" (the first thing left to do) or "todo".
 */
function stages(snapshot) {
  var s = snapshot || {};
  var total = n(s.stepsTotal), doneSteps = n(s.stepsDone), failed = n(s.stepsFailed);
  var built = total > 0 && doneSteps >= total;
  var state = {
    describe: n(s.messages) > 0 || !!s.plan ? "done" : "todo",
    plan: s.plan ? "done" : "todo",
    build: s.building ? "active" : built ? "done" : failed > 0 ? "failed" : "todo",
    test: s.tested ? "done" : "todo",
    ship: s.shipped ? "done" : "todo",
  };
  // A later stage cannot be done while an earlier one is not - a push of an
  // empty workspace is not a shipped project. The check runs in order, so the
  // first gap stops everything after it from reading as complete.
  var gap = false;
  var out = STAGES.map(function (st) {
    var status = state[st.id];
    if (gap && status === "done") status = "todo";
    if (status !== "done") gap = true;
    return { id: st.id, label: st.label, mode: st.mode, status: status, next: st.next };
  });
  for (var i = 0; i < out.length; i++) {
    if (out[i].status === "todo") { out[i].status = "next"; break; }
    if (out[i].status === "active" || out[i].status === "failed") break;
  }
  return out;
}

/** The stage to point a person at, or null when everything is done. */
function nextStage(list) {
  for (var i = 0; i < list.length; i++) {
    if (list[i].status !== "done") return list[i];
  }
  return null;
}

export {
  STAGES,
  stages,
  nextStage,
};
