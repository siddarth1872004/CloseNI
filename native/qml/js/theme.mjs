/*
 * Which theme to use.
 *
 * Ported from desktop/theme.js: an ES module imported by the QML app
 * and by the test harness. desktop/ was deleted with Electron in 0.4.0, so
 * this is the only copy.
 *
 * Applying a theme is setting one attribute on <html>; the styling itself is
 * entirely CSS. Nothing here knows what a colour is.
 *
 * In the QML app the palettes are in qml/singletons/Theme.qml, ported from
 * styles.css. It must have a palette for every id below and no others; the
 * unit suite checks this once Theme.qml exists.
 *
 * These themes style CloseNI's own chrome. A project built with CloseNI is
 * never touched - its appearance belongs to the project, not to a preference
 * about this application.
 */
var DEFAULT_THEME = "terminal";
var THEME_KEY = "closeni.theme";
var DECOR_KEY = "closeni.theme.decor";

// `decor` marks the themes carrying a texture - scanlines, or Blueprint's
// grid - so Appearance knows when the decoration toggle is worth showing.
// A test asserts this stays in step with which theme blocks in styles.css
// actually set --overlay-texture, because the two drifting apart shows up as
// a toggle that does nothing.
var THEMES = [
  { id: "terminal",        name: "Terminal",          decor: false },
  { id: "pixel",           name: "Pixel",             decor: true },
  { id: "midnight",        name: "Midnight",          decor: false },
  { id: "paper",           name: "Paper",             decor: false },
  { id: "phosphor",        name: "Phosphor",          decor: true },
  { id: "amber",           name: "Amber",             decor: true },
  { id: "cassette-indigo", name: "Cassette · Indigo", decor: true },
  { id: "cassette-miami",  name: "Cassette · Miami",  decor: true },
  { id: "cassette-grid",   name: "Cassette · Grid",   decor: false },
  { id: "blueprint",       name: "Blueprint",         decor: true },
  { id: "contrast",        name: "High contrast",     decor: false },
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

export {
  THEMES,
  resolveTheme,
  DEFAULT_THEME,
  THEME_KEY,
  DECOR_KEY,
};
