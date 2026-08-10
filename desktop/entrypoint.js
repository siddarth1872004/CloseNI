/*
 * Works out how to run a generated project.
 *
 * Loaded as a plain <script> in the renderer (window.CNEntry) and require()d by
 * the test harness (module.exports). There is no bundler, so no import/export.
 */
(function (root) {
  /**
   * Returns the command to run, or null when nothing is recognisable. null is a
   * real answer - reporting it beats running something arbitrary in the user's
   * project directory.
   *
   * `manifests` carries the contents this needs to read rather than guess at;
   * today that is only the Makefile, to see whether it has a `run` target.
   * `platform` is a process.platform value: Windows has no `./`, and "python"
   * alone does not exist on most Linux and macOS installs - an assumption that
   * already cost one whole build.
   */
  function detectEntrypoint(paths, packageJson, manifests, platform) {
    var isWin = platform === "win32";
    var py = isWin ? "python" : "python3";
    var run = isWin ? "" : "./";
    var files = manifests || {};

    var set = {};
    (paths || []).forEach(function (p) { set[String(p).replace(/\\/g, "/")] = true; });

    // An explicit start script is the most deliberate answer available.
    if (packageJson) {
      if (packageJson.scripts && packageJson.scripts.start) return "npm start";
      if (packageJson.main) return "node " + packageJson.main;
    }

    // A manifest describes the whole project; loose files describe one file.
    if (set["Cargo.toml"]) return "cargo run";
    if (set["Makefile"]) return /^run\s*:/m.test(files.makefile || "") ? "make run" : "make";

    // Maven and Gradle are deliberately absent: running one needs an exec
    // plugin and a main class that cannot be inferred from a file listing, and
    // a Run button that fails confusingly is worse than no Run button.

    var fileRules = [
      { file: "main.py", command: py + " main.py" },
      { file: "src/main.py", command: py + " src/main.py" },
      { file: "app.py", command: py + " app.py" },
      { file: "index.js", command: "node index.js" },
      { file: "src/index.js", command: "node src/index.js" },
      { file: "main.c", command: "gcc main.c -o main && " + run + "main" },
      { file: "src/main.c", command: "gcc src/main.c -o main && " + run + "main" },
      { file: "main.cpp", command: "g++ main.cpp -o main && " + run + "main" },
      { file: "src/main.cpp", command: "g++ src/main.cpp -o main && " + run + "main" },
      { file: "Main.java", command: "javac Main.java && java Main" },
      { file: "App.java", command: "javac App.java && java App" },
    ];
    for (var i = 0; i < fileRules.length; i++) {
      if (set[fileRules[i].file]) return fileRules[i].command;
    }
    return null;
  }

  var api = { detectEntrypoint: detectEntrypoint };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNEntry = api;
})(typeof window !== "undefined" ? window : globalThis);
