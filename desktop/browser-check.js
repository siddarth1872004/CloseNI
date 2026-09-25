/*
 * Is a usable browser installed?
 *
 * Loaded by main.js (window/global CNBrowser) and require()d by the test
 * harness. There is no bundler, so no import/export.
 *
 * Playwright names each browser directory <name>-<revision>. Only a full
 * chromium counts: the headless shell cannot display a login page, and signing
 * in to a provider is the entire reason the app opens a visible browser.
 */
(function (root) {
  var CHROMIUM = /^chromium-\d+$/;

  function hasChromium(entries) {
    if (!entries || !entries.length) return false;
    for (var i = 0; i < entries.length; i++) {
      if (CHROMIUM.test(String(entries[i]))) return true;
    }
    return false;
  }

  /*
   * Terminal colour codes. Playwright's installer dims the download URL with
   * them, and forwarded verbatim they showed up in the setup dialog as literal
   * "[2m" and "[22m" around the text.
   */
  var ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

  function stripAnsi(text) {
    return String(text == null ? "" : text).replace(ANSI, "");
  }

  /**
   * Why a browser download failed, in one line a person can act on.
   *
   * The installer retries, then ends on "Failed to install browsers" and
   * "Download failure, code=1" - which say nothing. The specific reason comes
   * first and gets buried: "server returned code 403 body 'request blocked'",
   * a DNS failure, a full disk. Reporting only the exit code, as the gate used
   * to, left someone behind a proxy with "Download failed (exit 1)" and no way
   * to tell a firewall from a broken build.
   */
  var GENERIC = /^(Failed to install browsers|Error: Failed to download |Error: Download failure, code=)/;

  function describeInstallFailure(output, code) {
    var lines = stripAnsi(output).split(/\r?\n/).map(function (l) { return l.trim(); });
    var reason = null;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      // "Error: Download failed: server returned..." - the head below already
      // says the download failed, so only what follows is kept.
      if (/^Error:/.test(l) && !GENERIC.test(l)) { reason = l.replace(/^Error:\s*(Download failed:\s*)?/, ""); break; }
    }
    var head = "Download failed (exit " + code + ")";
    if (!reason) return head + ". Check the connection and try again.";
    if (reason.length > 240) reason = reason.slice(0, 237) + "...";
    // Blocked by the network rather than broken: say where the file comes from,
    // because that is the one thing an administrator needs to allow.
    var blocked = /\b(403|407|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|blocked|proxy)\b/i.test(reason);
    return head + ": " + reason + (blocked
      ? " The browser downloads from cdn.playwright.dev - a proxy or firewall has to allow it."
      : "");
  }

  var api = { hasChromium: hasChromium, stripAnsi: stripAnsi, describeInstallFailure: describeInstallFailure };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNBrowser = api;
})(typeof window !== "undefined" ? window : globalThis);
