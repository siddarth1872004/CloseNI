/*
 * The security-relevant decisions, kept pure so they can be tested without a
 * network or a credential.
 *
 * Loaded as a plain <script> in the renderer (window.CNGit), require()d by
 * main.js and by the test harness. There is no bundler, so no import/export.
 */
(function (root) {
  /**
   * Remove a token from anything about to be logged or shown.
   *
   * The git IPC pipes stdout and stderr straight into the project log, and git
   * echoes URLs on failure. A credential that reaches a log file has been
   * published - to a screenshot, a pasted error report, a support request.
   */
  function redactToken(text, token) {
    var s = text === null || text === undefined ? "" : String(text);
    if (!token) return s;
    // Split/join rather than a regex: a token can contain regex metacharacters,
    // and building a pattern out of a secret is its own kind of bug.
    return s.split(String(token)).join("[REDACTED]");
  }

  /**
   * Check git arguments before they are spawned.
   *
   * Deliberately does NOT escape content. Git runs with shell:false, so an
   * argument is data rather than syntax - a commit message containing a
   * semicolon is a commit message, and escaping it would corrupt it. Only the
   * wrong type is rejected, and it throws rather than filtering: silently
   * dropping an argument produces a git command that means something other
   * than what was asked for.
   */
  function safeGitArgs(args) {
    if (!Array.isArray(args)) throw new Error("git arguments must be a list");
    args.forEach(function (a, i) {
      if (typeof a !== "string") throw new Error("git argument " + i + " is not a string");
    });
    return args.slice();
  }

  var api = { redactToken: redactToken, safeGitArgs: safeGitArgs };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNGit = api;
})(typeof window !== "undefined" ? window : globalThis);
