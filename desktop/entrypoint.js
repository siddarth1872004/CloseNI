/*
 * Works out how to run a generated project.
 *
 * Loaded as a plain <script> in the renderer (window.CNEntry) and require()d by
 * the test harness (module.exports). There is no bundler, so no import/export.
 */
(function (root) {
  // python3 rather than python: "python" alone does not exist on most Linux and
  // macOS installs, an assumption that already cost one whole build.
  var PY = "python3";

  var FILE_RULES = [
    { file: "main.py", command: PY + " main.py" },
    { file: "src/main.py", command: PY + " src/main.py" },
    { file: "app.py", command: PY + " app.py" },
    { file: "index.js", command: "node index.js" },
    { file: "src/index.js", command: "node src/index.js" },
  ];

  /**
   * Returns the command to run, or null when nothing is recognisable. null is a
   * real answer — reporting it beats running something arbitrary in the user's
   * project directory.
   */
  function detectEntrypoint(paths, packageJson) {
    var set = {};
    (paths || []).forEach(function (p) { set[String(p).replace(/\\/g, "/")] = true; });

    if (packageJson) {
      if (packageJson.scripts && packageJson.scripts.start) return "npm start";
      if (packageJson.main) return "node " + packageJson.main;
    }
    for (var i = 0; i < FILE_RULES.length; i++) {
      if (set[FILE_RULES[i].file]) return FILE_RULES[i].command;
    }
    return null;
  }

  var api = { detectEntrypoint: detectEntrypoint };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNEntry = api;
})(typeof window !== "undefined" ? window : globalThis);
