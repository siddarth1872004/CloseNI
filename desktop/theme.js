/*
 * Which theme to use.
 *
 * Loaded as a plain <script> in the renderer (window.CNTheme) and require()d by
 * the test harness (module.exports). There is no bundler, so no import/export.
 *
 * Applying a theme is setting one attribute on <html>; the styling itself is
 * entirely CSS. Nothing here knows what a colour is.
 *
 * These themes style CloseNI's own chrome. A project built with CloseNI is
 * never touched - its appearance belongs to the project, not to a preference
 * about this application.
 */
(function (root) {
  var DEFAULT_THEME = "midnight";
  var THEME_KEY = "closeni.theme";
  var DECOR_KEY = "closeni.theme.decor";

  // `crt` marks the themes carrying scanlines and glow, so Appearance knows
  // when the decoration toggle is worth showing. It must stay in step with
  // which theme blocks in styles.css set --overlay-texture to something.
  var THEMES = [
    { id: "midnight",        name: "Midnight",          crt: false },
    { id: "paper",           name: "Paper",             crt: false },
    { id: "phosphor",        name: "Phosphor",          crt: true },
    { id: "amber",           name: "Amber",             crt: true },
    { id: "cassette-indigo", name: "Cassette · Indigo", crt: true },
    { id: "cassette-miami",  name: "Cassette · Miami",  crt: true },
    { id: "cassette-grid",   name: "Cassette · Grid",   crt: false },
    { id: "blueprint",       name: "Blueprint",         crt: false },
    { id: "contrast",        name: "High contrast",     crt: false },
  ];

  /**
   * A saved theme is trusted only if it still exists. A theme dropped in a
   * later version would otherwise leave the app with no palette at all - every
   * token unresolved, which renders as black text on white.
   */
  function resolveTheme(saved, available) {
    var list = available || THEMES;
    if (typeof saved !== "string" || !saved) return DEFAULT_THEME;
    for (var i = 0; i < list.length; i++) if (list[i].id === saved) return saved;
    return DEFAULT_THEME;
  }

  var api = {
    THEMES: THEMES,
    resolveTheme: resolveTheme,
    DEFAULT_THEME: DEFAULT_THEME,
    THEME_KEY: THEME_KEY,
    DECOR_KEY: DECOR_KEY,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNTheme = api;
})(typeof window !== "undefined" ? window : globalThis);
