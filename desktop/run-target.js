/*
 * What "Run this project" actually starts, and what the agent is asked when it fails.
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

  // The end of the output is where the error is; the start is mostly banners.
  var FIX_TAIL = 6000;

  /**
   * What the agent is asked after a run fails: the command, how it ended and
   * the end of its output. A program that opens a window must not be run by
   * the agent to check, since its bash call would sit until the timeout.
   */
  function fixPrompt(run) {
    var out = String(run.output || "");
    if (out.length > FIX_TAIL) {
      out = out.slice(-FIX_TAIL);
      var nl = out.indexOf("\n");
      if (nl !== -1 && nl < 200) out = out.slice(nl + 1);
      out = "...\n" + out;
    }
    var how = run.signal ? "was stopped by " + run.signal : "exited with code " + run.code;
    return "Running the project with `" + run.command + "` " + how + ". The end of its output:\n\n" +
      "```\n" + out.replace(/\s+$/, "") + "\n```\n\n" +
      "Find the cause and fix it, in the code or in the project's environment, whichever is at fault." +
      (run.gui ? " The program opens its own window, so do not run it yourself to check; the user will run it again." : "");
  }

  var api = { venvCommand: venvCommand, looksGraphical: looksGraphical, fixPrompt: fixPrompt };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNRunTarget = api;
})(typeof window !== "undefined" ? window : globalThis);
