/*
 * The projects you have been working on.
 *
 * Switching between projects already worked - restoreBuild brings back a
 * workspace's plan and statuses, and sessions.json is keyed by workspace so
 * each has its own conversation. What was missing was any memory of which
 * folders you use, so every launch began with Browse.
 *
 * Paths only, deliberately. This lives in localStorage rather than
 * sessions.json: that file holds live conversation URLs at 0600 permissions
 * for a reason, and a list of folder names does not belong beside them. The
 * progress shown against each entry is read from that workspace's own
 * .closeni/build.json when the list renders, so nothing about a project is
 * duplicated into app state.
 *
 * Loaded as a plain <script> (window.CNRecent) and require()d by the test
 * harness, as scheduler.js, plan-edit.js and step-timing.js are.
 */
(function (root) {
  var MAX_RECENT = 8;

  /** Anything unreadable is "no history", which is the first-launch case. */
  function parse(raw) {
    var list = raw;
    if (typeof raw === "string") {
      try { list = JSON.parse(raw); } catch (e) { return []; }
    }
    if (!Array.isArray(list)) return [];
    return list.filter(function (p) { return typeof p === "string" && p.trim(); });
  }

  /**
   * Put a workspace at the top.
   *
   * Re-opening one you already have moves it up rather than adding a second
   * copy: a list with the same path twice is a list nobody trusts, and it is
   * the common case, not an edge one.
   */
  function remember(list, workspace) {
    var path = String(workspace || "").trim();
    if (!path) return parse(list).slice();
    var rest = parse(list).filter(function (p) { return p !== path; });
    return [path].concat(rest).slice(0, MAX_RECENT);
  }

  function forget(list, workspace) {
    var path = String(workspace || "").trim();
    return parse(list).filter(function (p) { return p !== path; });
  }

  /**
   * What to show beside a path.
   *
   * "missing" is its own answer rather than being folded into "no plan": a
   * folder that has been deleted or is on an unplugged drive is a different
   * situation from one that has never been built in, and telling them apart is
   * the difference between "I moved that" and "the app lost my project".
   */
  function describe(progress) {
    if (!progress) return "no plan";
    if (progress.missing) return "missing";
    var total = Number(progress.total) || 0;
    var done = Number(progress.done) || 0;
    if (!total) return "no plan";
    if (done >= total) return "done";
    return done + "/" + total;
  }

  var api = {
    MAX_RECENT: MAX_RECENT,
    parse: parse,
    remember: remember,
    forget: forget,
    describe: describe,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNRecent = api;
})(typeof window !== "undefined" ? window : globalThis);
