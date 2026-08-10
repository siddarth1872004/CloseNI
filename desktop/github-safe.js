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

  // Exact hosts only. A prefix or "contains" check would accept
  // github.com.evil.test, which is a different site entirely.
  var GITHUB_HOSTS = ["github.com", "www.github.com"];

  /**
   * Owner and repository from a GitHub URL, or null.
   *
   * Everything that clones or fetches goes through this, so a search result -
   * network-derived text - cannot point an operation at another host.
   */
  function parseRepoUrl(url) {
    var raw = String(url || "").trim();
    if (!raw) return null;

    // scp-like SSH form, which is not a URL and would not parse as one.
    var ssh = raw.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?\/?$/);
    if (ssh) {
      if (GITHUB_HOSTS.indexOf(ssh[1].toLowerCase()) === -1) return null;
      return { owner: ssh[2], repo: ssh[3] };
    }

    var parsed;
    try { parsed = new URL(raw); } catch (e) { return null; }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (GITHUB_HOSTS.indexOf(parsed.hostname.toLowerCase()) === -1) return null;

    var parts = parsed.pathname.split("/").filter(function (x) { return x.length > 0; });
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1].replace(/\.git$/, "") };
  }

  /**
   * Whether a token may be written to disk.
   *
   * Only when the OS can encrypt it. Anything else - including an unknown
   * state - means memory for this session and re-entry next launch.
   */
  function shouldPersistToken(encryptionAvailable) {
    return encryptionAvailable === true;
  }

  var api = {
    redactToken: redactToken,
    safeGitArgs: safeGitArgs,
    parseRepoUrl: parseRepoUrl,
    shouldPersistToken: shouldPersistToken,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNGit = api;
})(typeof window !== "undefined" ? window : globalThis);
