/*
 * The Build panel's decisions, without the panel.
 *
 * Everything here is pure: the step list, the plan and the
 * run state come in as arguments, and text or plain objects come back. Timers,
 * the agent session and drawing stay with the Build panel.
 */
import * as Timing from "./step-timing.mjs";

// No entry for "pending" or "skipped": nothing has happened to them, so
// nothing should move.
//
// Pixel motion marks the change: a finished step stamps in, a running one
// spins, a failed one flickers. Event-driven only - none of this runs on an
// idle screen.
var PIX_MOTION = { done: "pix-stamp", failed: "pix-flicker", running: "pix-spin", blocked: "" };

/** Done and skipped both count as finished, as progress does. */
function isFinished(s) {
  return s.status === "done" || s.status === "skipped";
}

function finishedCount(steps) {
  return steps.filter(isFinished).length;
}

/** Counts for the flow bar. Skipped steps count as finished, as progress does. */
function buildStats(steps, running) {
  return {
    total: steps.length,
    done: finishedCount(steps),
    failed: steps.filter(function (s) { return s.status === "failed"; }).length,
    running: running,
  };
}

/**
 * Which of the panel's buttons show in a given mode, by button name.
 */
function buttonVisibility(mode, steps) {
  return {
    start: mode === "idle",
    pause: mode === "running",
    skip: mode === "running",
    stop: mode === "running" || mode === "paused",
    resume: mode === "paused",
    retry: mode === "idle" && steps.some(function (s) { return s.status === "failed"; }),
  };
}

/**
 * A plan's steps as the builder tracks them.
 *
 * dependsOn is carried across deliberately. Dropping it - which this line
 * did - made every plan look like an undeclared one, so the scheduler built
 * a chain and a single failure blocked every step behind it regardless of
 * what the plan said.
 */
function stepsFromPlan(planSteps) {
  return planSteps.map(function (s) {
    return {
      title: s.title, detail: s.detail, files: s.files || [],
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.slice() : undefined,
      testable: s.testable === true,
      status: "pending", result: null,
    };
  });
}

/** The steps of a saved build, with their statuses and timings kept. */
function stepsFromSaved(savedSteps) {
  return savedSteps.map(function (s) {
    return {
      title: s.title, detail: s.detail, files: s.files || [],
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.slice() : undefined,
      testable: s.testable === true,
      timing: s.timing,
      status: s.status || "pending", result: null,
    };
  });
}

/**
 * The plan a restored build hands back, so the caller can restore currentPlan.
 * Every step is told the overall goal alongside its own detail; without the
 * summary a resumed build sends each remaining step off with no idea what it
 * is building.
 */
function planFromSaved(state, steps) {
  return {
    summary: state.summary || "",
    runCommand: state.runCommand || undefined,
    steps: steps.map(function (s) {
      return { title: s.title, detail: s.detail, files: s.files, dependsOn: s.dependsOn, testable: s.testable };
    }),
  };
}

/** Status line and log line after restoring a build with `done` of `total` finished. */
function restoredStatus(done, total) {
  return {
    status: done ? "resumable: " + done + "/" + total + " done" : "ready: " + total + " steps",
    log: done ? "found an unfinished build here: " + done + "/" + total +
      " steps done - press Build to carry on" : "",
  };
}

/**
 * What one step is told to do. A rejection is carried into the next attempt,
 * so the model is told what was wrong rather than being asked to guess a
 * second time.
 */
function stepPrompt(plan, step, rejection) {
  return "Overall: " + ((plan && plan.summary) || "") +
    "\n\nExecute ONLY this step: " + (step.title || "") + ". " + (step.detail || "") +
    (step.files && step.files.length ? " Expected files: " + step.files.join(", ") : "") +
    (rejection ? "\n\nA previous attempt at this step was rejected. What was wrong: " +
      rejection + "\nAddress that specifically." : "");
}

/**
 * Rolling back is offered only where there is something to undo. A pending
 * step never wrote anything, and a build in progress must not have the ground
 * moved.
 */
function rollbackOffered(steps, i, running) {
  var ranAlready = steps.slice(i).some(function (st) {
    return st.status === "done" || st.status === "failed";
  });
  return ranAlready && !running;
}

/**
 * The confirmation for rolling back to before step i, or "" when the plan
 * undoes nothing. A file the user edited by hand since the build wrote it is
 * named rather than quietly overwritten, because the backup that would
 * recover it is the one about to be replaced.
 */
function rollbackMessage(plan, i) {
  var undone = (plan.steps || []).length;
  if (!undone) return "";
  var msg = "Roll back to before step " + (i + 1) + "?\n\n" +
    "This undoes " + undone + " step" + (undone === 1 ? "" : "s") + ": " +
    Object.keys(plan.restore || {}).length + " file(s) restored, " +
    (plan.remove || []).length + " removed.";
  if ((plan.drifted || []).length) {
    msg += "\n\nThese have changed since the build wrote them, and those " +
      "changes will be lost:\n  " + plan.drifted.join("\n  ");
  }
  if ((plan.unrestorable || []).length) {
    msg += "\n\nToo large to have been saved, so these will be left as they are:\n  " +
      plan.unrestorable.join("\n  ");
  }
  return msg;
}

/** The "time" card on a step: its total and one padded line per phase. */
function timingText(timing) {
  var rows = Timing.phaseRows({ phases: timing.phases });
  return {
    total: Timing.formatDuration(timing.totalMs),
    body: rows.map(function (r) {
      return r.phase.padEnd(14) + Timing.formatDuration(r.ms);
    }).join("\n") || "(no phases recorded)",
  };
}

/** The log line for a finished step's time: the total and its top three phases. */
function stepTimingLog(i, timing) {
  return "step " + (i + 1) + " took " + Timing.formatDuration(timing.totalMs) +
    " (" + Timing.phaseRows({ phases: timing.phases })
      .slice(0, 3)
      .map(function (r) { return r.phase + " " + Timing.formatDuration(r.ms); })
      .join(", ") + ")";
}

/** The build's time across all its steps, as log lines. Empty when nothing was timed. */
function buildTimingLog(steps) {
  var roll = Timing.summarise(steps.map(function (st) {
    return st.timing ? { totalMs: st.timing.totalMs, phases: st.timing.phases } : null;
  }));
  if (!roll.steps) return [];
  return ["build time " + Timing.formatDuration(roll.totalMs) + " across " + roll.steps + " step(s)"]
    .concat(roll.phases.map(function (r) {
      return "  " + r.phase + " " + Timing.formatDuration(r.ms) + " (" + r.percent + "%)";
    }));
}

/**
 * What to log about the dependency graph from scheduler.graphFor: a tone and
 * a line, or null when the plan declared nothing.
 */
function dependencyLog(built) {
  if (built.reason) {
    return { tone: "err", text: "plan dependencies unusable (" + built.reason + ") - running the steps in order" };
  }
  if (built.declared) {
    var independent = built.graph.filter(function (d, i) { return i > 0 && d.length === 0; }).length;
    return {
      tone: "step",
      text: "plan declares its own dependencies" +
        (independent ? "; " + independent + " step(s) do not wait on anything" : ""),
    };
  }
  return null;
}

/** The +, - or space in front of a diff row from diff.mjs. */
function diffMark(type) {
  return type === "add" ? "+" : type === "remove" ? "-" : " ";
}

/**
 * The address the preview opens, from preview-target's { kind, url } and the
 * workspace. It opens in the system browser.
 */
function previewUrl(kind, ws, url) {
  return kind === "file" ? "file://" + ws + "/" + url : url;
}

export {
  PIX_MOTION,
  isFinished,
  finishedCount,
  buildStats,
  buttonVisibility,
  stepsFromPlan,
  stepsFromSaved,
  planFromSaved,
  restoredStatus,
  stepPrompt,
  rollbackOffered,
  rollbackMessage,
  timingText,
  stepTimingLog,
  buildTimingLog,
  dependencyLog,
  diffMark,
  previewUrl,
};
