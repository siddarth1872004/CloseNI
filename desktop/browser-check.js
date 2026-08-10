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

  var api = { hasChromium: hasChromium };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNBrowser = api;
})(typeof window !== "undefined" ? window : globalThis);
