/*
 * Turns a provider's declared controls plus whatever the user last chose into
 * the settings the agent should apply.
 *
 * Loaded as a plain <script> in the renderer (window.CNControls) and require()d
 * by the test harness (module.exports). There is no bundler, so no import/export.
 */
(function (root) {
  /**
   * Saved values are validated against what the provider currently declares,
   * not trusted. A model removed from a provider's line-up would otherwise sit
   * in localStorage forever, asking every run for something that no longer
   * exists and reporting "unavailable" each time.
   */
  function resolveControls(controls, saved) {
    var out = {};
    var list = controls || [];
    var have = saved || {};

    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c || !c.id) continue;
      var value = Object.prototype.hasOwnProperty.call(have, c.id) ? have[c.id] : c.default;

      if (c.kind === "toggle") {
        if (typeof value === "boolean") out[c.id] = value;
        continue;
      }
      if (c.kind === "select") {
        if (typeof value !== "string") continue;
        var options = c.options || [];
        for (var j = 0; j < options.length; j++) {
          if (options[j] && options[j].value === value) { out[c.id] = value; break; }
        }
      }
    }
    return out;
  }

  /** The label to show for a select's current value, falling back to the raw value. */
  function labelFor(control, value) {
    var options = (control && control.options) || [];
    for (var i = 0; i < options.length; i++) {
      if (options[i] && options[i].value === value) return options[i].label || options[i].value;
    }
    return String(value === undefined || value === null ? "" : value);
  }

  var api = { resolveControls: resolveControls, labelFor: labelFor };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNControls = api;
})(typeof window !== "undefined" ? window : globalThis);
