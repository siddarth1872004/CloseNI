/*
 * What "Run this project" actually starts, and what the agent is asked when it fails.
 *
 * An ES module imported by the QML app and by the test harness.
 */
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

// Toolkits that run without a screen, given HEADLESS: SDL draws to a dummy
// video driver, Qt to an offscreen platform. The rest would flash a window.
var NO_SCREEN = /^(?:pygame|PyQt[56]|PySide[26])$/;
var HEADLESS = { SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy", QT_QPA_PLATFORM: "offscreen" };

/**
 * Can CloseNI start this program unseen, to check it gets past startup?
 * Only a program with a window, whose every toolkit runs without a screen:
 * the agent cannot easily check those itself, and a game does not act on
 * the user's files at startup the way a console script might.
 */
function checkableHeadless(sources) {
  var kits = [];
  (sources || []).forEach(function (s) {
    var re = new RegExp(GUI.source, "gm");
    var m;
    while ((m = re.exec(String(s || "")))) kits.push(m[0].replace(/^\s*(?:import|from)\s+/, ""));
  });
  return kits.length > 0 && kits.every(function (k) { return NO_SCREEN.test(k); });
}

/** A start check passes when the program was still up at the limit, or ended cleanly. */
function startedOk(r) {
  return !!(r && (r.timedOut || r.code === 0));
}

// The end of the output is where the error is; the start is mostly banners.
var FIX_TAIL = 6000;

/**
 * What the agent is asked after a run fails: the command, how it ended and
 * the end of its output. A program that opens a window is checked headless
 * and time-limited, since a plain bash call would sit until the timeout.
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
    (run.gui ? " The program opens its own window, which would hold a plain run until its timeout: to check a fix, start it " +
      "headless and time-limited, such as SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy timeout 5 " + run.command +
      ", where exit code 124 means it stayed up. The user will run it for real." : "");
}

export {
  venvCommand,
  looksGraphical,
  fixPrompt,
  checkableHeadless,
  startedOk,
  HEADLESS,
};
