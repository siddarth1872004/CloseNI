/*
 * What "Run this project" actually starts.
 *
 * Loaded as a plain <script> in the renderer (window.CNRunTarget) and
 * require()d by the main process and the test harness. There is no bundler,
 * so no import/export.
 */
(function (root) {
  /**
   * The project's own interpreter, when it has one. The agent installs into a
   * venv because a PEP 668 system Python refuses pip, so `python3 game.py`
   * against the system interpreter dies on `import pygame`.
   */
  function venvCommand(command, venvPython) {
    var cmd = String(command || "");
    if (!venvPython) return cmd;
    var m = cmd.match(/^(python3?|py -3)(?=\s|$)/);
    if (!m) return cmd;
    var quoted = /\s/.test(venvPython) ? '"' + venvPython + '"' : venvPython;
    return quoted + cmd.slice(m[0].length);
  }

  // Libraries that open a window of their own. A program using one is a game
  // or an app, not a console program, and its output is only half the story.
  var GUI = /^\s*(?:import|from)\s+(?:pygame|tkinter|Tkinter|turtle|pyglet|arcade|kivy|PyQt[56]|PySide[26]|wx|raylib|pyray|ursina|panda3d|OpenGL)\b/m;

  /** Does any of these source texts open a window? */
  function looksGraphical(sources) {
    return (sources || []).some(function (s) { return GUI.test(String(s || "")); });
  }

  var api = { venvCommand: venvCommand, looksGraphical: looksGraphical };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNRunTarget = api;
})(typeof window !== "undefined" ? window : globalThis);
