/*
 * Where a build's time actually went.
 *
 * The agent already reports seven phases - connecting, opening, reading,
 * sending, writing, applying, checking - and every one is emitted at the point
 * it was observed on the page rather than inferred from "we sent a prompt, so
 * it is probably generating". Nothing was timing them.
 *
 * That distinction is why this is worth having. A step that took four minutes
 * was either waiting on the model or running a slow test suite, and those need
 * completely different fixes; a step total alone cannot tell them apart.
 *
 * There is no money here. CloseNI drives free web chats, so "cost" can only
 * mean time.
 *
 * Loaded as a plain <script> (window.CNTiming) and require()d by the test
 * harness, as scheduler.js and plan-edit.js are. No bundler, so no
 * import/export.
 */
(function (root) {
  /**
   * Time attributed to nothing.
   *
   * A phase closes when the next one opens, so any gap between a step starting
   * and its first phase - or between the last phase and the step finishing -
   * belongs to neither. Reported as its own line rather than folded into a
   * neighbour, because silently attributing eight seconds to "checking" when
   * nobody knows where they went is how a timing report starts lying.
   */
  var UNATTRIBUTED = "unaccounted";

  function newTimer(now) {
    return { startedAt: now, phase: null, phaseAt: now, phases: {}, endedAt: null };
  }

  /** Close whatever was running and open `name`. */
  function markPhase(timer, name, now) {
    if (!timer) return timer;
    var at = typeof now === "number" ? now : Date.now();
    var elapsed = Math.max(0, at - timer.phaseAt);
    var key = timer.phase || UNATTRIBUTED;
    timer.phases[key] = (timer.phases[key] || 0) + elapsed;
    timer.phase = name || null;
    timer.phaseAt = at;
    return timer;
  }

  /** Stop the clock. Safe to call twice; the second call changes nothing. */
  function finish(timer, now) {
    if (!timer || timer.endedAt !== null) return timer;
    var at = typeof now === "number" ? now : Date.now();
    markPhase(timer, null, at);
    delete timer.phases[UNATTRIBUTED + "__none"];
    timer.endedAt = at;
    timer.totalMs = Math.max(0, at - timer.startedAt);
    return timer;
  }

  /** Phases longest first, which is the order anyone reads them in. */
  function phaseRows(timer) {
    if (!timer || !timer.phases) return [];
    return Object.keys(timer.phases)
      .filter(function (k) { return timer.phases[k] > 0; })
      .map(function (k) { return { phase: k, ms: timer.phases[k] }; })
      .sort(function (a, b) { return b.ms - a.ms; });
  }

  /**
   * Roll a build's steps together.
   *
   * Percentages come from the summed phase times rather than from the wall
   * clock: a build is only running one step at a time, but the gaps between
   * steps belong to the user reading the screen, not to the build.
   */
  function summarise(timers) {
    var list = (timers || []).filter(Boolean);
    var phases = {};
    var total = 0;
    var counted = 0;
    list.forEach(function (t) {
      total += t.totalMs || 0;
      Object.keys(t.phases || {}).forEach(function (k) {
        phases[k] = (phases[k] || 0) + t.phases[k];
        counted += t.phases[k];
      });
    });
    var rows = Object.keys(phases)
      .filter(function (k) { return phases[k] > 0; })
      .map(function (k) {
        return { phase: k, ms: phases[k], percent: counted ? Math.round((phases[k] / counted) * 100) : 0 };
      })
      .sort(function (a, b) { return b.ms - a.ms; });
    return { steps: list.length, totalMs: total, phases: rows };
  }

  /**
   * Durations a person can read at a glance.
   *
   * Sub-minute keeps a decimal, because the difference between 0.4s and 4s
   * matters when you are looking for where a step went; above a minute it does
   * not, and "1m 42s" beats "102.3s".
   */
  function formatDuration(ms) {
    var n = typeof ms === "number" && isFinite(ms) && ms > 0 ? ms : 0;
    if (n < 1000) return Math.round(n) + "ms";
    if (n < 60000) return (n / 1000).toFixed(1) + "s";
    var mins = Math.floor(n / 60000);
    var secs = Math.round((n % 60000) / 1000);
    // 59.6s rounds to 60 and would read as "3m 60s".
    if (secs === 60) return (mins + 1) + "m 00s";
    return mins + "m " + (secs < 10 ? "0" : "") + secs + "s";
  }

  /** Only what is worth storing: the live cursor fields are per-run. */
  function toRecord(timer) {
    if (!timer) return undefined;
    return { totalMs: timer.totalMs || 0, phases: Object.assign({}, timer.phases || {}) };
  }

  var api = {
    UNATTRIBUTED: UNATTRIBUTED,
    newTimer: newTimer,
    markPhase: markPhase,
    finish: finish,
    phaseRows: phaseRows,
    summarise: summarise,
    formatDuration: formatDuration,
    toRecord: toRecord,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNTiming = api;
})(typeof window !== "undefined" ? window : globalThis);
