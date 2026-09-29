/*
 * Extraction settings: whether a local Needle model may read replies the
 * parser could not, and how.
 *
 * Loaded by index.html (window.CNExtraction), require()d by main.js to turn
 * the saved settings into the agent's environment, and by the test harness.
 * There is no bundler, so no import/export.
 *
 * The settings live in one file in userData rather than localStorage, because
 * the main process has to read them at every agent spawn - including the ones
 * the renderer does not start, like a build session's steps.
 */
(function (root) {
  var DEFAULTS = { backend: "builtin", python: "", weights: "", minConfidence: 0.5 };

  /**
   * Whatever was saved, or typed, as a complete and valid settings object.
   * Anything unrecognised falls back to the default rather than being passed
   * on: these become environment variables of a process that runs a program.
   */
  function normalize(raw) {
    var r = raw && typeof raw === "object" ? raw : {};
    var backend = r.backend === "needle" ? "needle" : "builtin";
    var python = typeof r.python === "string" ? r.python.trim() : "";
    var weights = typeof r.weights === "string" ? r.weights.trim() : "";
    var c = typeof r.minConfidence === "number" ? r.minConfidence : parseFloat(r.minConfidence);
    var minConfidence = isFinite(c) && c >= 0 && c <= 1 ? c : DEFAULTS.minConfidence;
    // A path, not a command line: nothing here is ever given to a shell, and a
    // value with a newline in it is not a path anyone meant.
    if (/[\r\n\0]/.test(python)) python = "";
    if (/[\r\n\0]/.test(weights)) weights = "";
    return { backend: backend, python: python, weights: weights, minConfidence: minConfidence };
  }

  /** The agent's environment for these settings. Empty when extraction is off. */
  function toEnv(settings) {
    var s = normalize(settings);
    if (s.backend !== "needle") return {};
    var env = { CLOSENI_EXTRACTOR: "needle", CLOSENI_NEEDLE_MIN_CONFIDENCE: String(s.minConfidence) };
    if (s.python) env.CLOSENI_NEEDLE_PYTHON = s.python;
    if (s.weights) env.CLOSENI_NEEDLE_WEIGHTS = s.weights;
    return env;
  }

  /** One line for the Settings panel, from the agent's extractor-check answer. */
  function describeCheck(result) {
    if (!result) return "No answer from the agent.";
    if (result.backend === "builtin") return "Built-in parser only - nothing to check.";
    if (!result.success) return "Not available: " + (result.error || "unknown error");
    return "Ready: cactus-needle " + (result.version || "?") + (result.weights && result.weights !== "base" ? ", weights " + result.weights : "") +
      (result.warmed ? ", model downloaded." : ". The model downloads on first use (~35 MB) - Download model fetches it now.");
  }

  var api = { DEFAULTS: DEFAULTS, normalize: normalize, toEnv: toEnv, describeCheck: describeCheck };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNExtraction = api;
})(typeof window !== "undefined" ? window : globalThis);
