/*
 * The browser the agent drives: whether it is installed, and installing it.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { app, ipcMain } = require("electron");
const { hasChromium, stripAnsi, describeInstallFailure } = require("../browser-check.js");

/** Registers the handlers. main.js hands in browsersDir, spawnCwd, getWin. */
module.exports = function browser(main) {
  const { browsersDir, spawnCwd, getWin } = main;

  ipcMain.handle("browser-status", function () {
    // Development uses the developer's own ~/.cache/ms-playwright, which
    // PLAYWRIGHT_BROWSERS_PATH deliberately does not override there.
    if (!app.isPackaged) return { ready: true, path: "(development: system Playwright cache)" };
    let entries = [];
    try { entries = fs.readdirSync(browsersDir()); } catch (e) { /* not created yet */ }
    return { ready: hasChromium(entries), path: browsersDir() };
  });

  /**
   * Download Chromium through Playwright's own CLI.
   *
   * Reaching into playwright-core's internal registry would be shorter and would
   * break on the next Playwright upgrade. The CLI is the supported entry point,
   * and it already prints progress worth forwarding to the window.
   */
  ipcMain.handle("install-browser", function () {
    return new Promise(function (resolve) {
      // Resolved through package.json rather than directly.
      //
      // require.resolve("playwright/cli.js") throws even though the file is right
      // there: Playwright declares an "exports" map that does not list ./cli.js,
      // and Node refuses deep imports outside it. The old code read that throw as
      // "Playwright is missing from this build", so the Download button reported
      // a broken build on an install that was completely intact.
      //
      // ./package.json is in the map, so its directory is reachable, and the CLI
      // sits beside it. Checked with existsSync so a genuinely missing file still
      // reports honestly.
      let cli;
      try {
        cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
      } catch (e) {
        cli = null;
      }
      if (!cli || !fs.existsSync(cli)) {
        resolve({ ok: false, error: "Playwright's installer was not found in this build." });
        return;
      }
      const proc = spawn(process.execPath, [cli, "install", "chromium"], {
        cwd: spawnCwd(),
        env: Object.assign({}, process.env, {
          ELECTRON_RUN_AS_NODE: "1",
          PLAYWRIGHT_BROWSERS_PATH: browsersDir(),
        }),
      });
      // Kept whole, not just forwarded: the reason a download failed is printed
      // first and then buried under generic lines, and the dialog shows the last.
      let output = "";
      function forward(d) {
        output += String(d);
        if (output.length > 65536) output = output.slice(-65536);
        const line = stripAnsi(d).trim();
        if (line && getWin()) getWin().webContents.send("browser-progress", line);
      }
      proc.stdout.on("data", forward);
      proc.stderr.on("data", forward);
      proc.on("error", function (e) { resolve({ ok: false, error: String(e) }); });
      proc.on("close", function (code) {
        resolve(code === 0 ? { ok: true } : { ok: false, error: describeInstallFailure(output, code) });
      });
    });
  });
};
