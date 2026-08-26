/*
 * The GitHub calls this app makes.
 *
 * The transport is injected rather than imported, so every call shape is tested
 * without a token and without touching GitHub - which matters, because there is
 * no credential in the development environment and there will not be one.
 */
(function (root) {
  function describeFailure(status, body) {
    var message = (body && body.message) || "";
    if (status === 401) return new Error("GitHub rejected the token (401): " + message);
    // A rate limit is a wait, not a breakage, and saying which is the
    // difference between "try again later" and "something is wrong".
    if (status === 403 && /rate limit/i.test(message)) {
      return new Error("GitHub rate limit reached: " + message);
    }
    if (status === 403) return new Error("GitHub refused (403), usually a missing scope: " + message);
    if (status === 404) return new Error("Not found (404): " + message);
    return new Error("GitHub returned " + status + ": " + message);
  }

  function createGitHubApi(request) {
    async function call(method, apiPath, body) {
      var res = await request(method, apiPath, body);
      if (res.status < 200 || res.status >= 300) throw describeFailure(res.status, res.body);
      return res.body;
    }

    return {
      listRepos: function () {
        return call("GET", "/user/repos?sort=updated&per_page=50");
      },
      createRepo: function (name, isPrivate) {
        return call("POST", "/user/repos", { name: name, private: !!isPrivate });
      },
      getReadme: async function (owner, repo) {
        var body = await call("GET", "/repos/" + owner + "/" + repo + "/readme");
        // The API returns base64; anything putting this in a prompt needs text.
        return Buffer.from(String(body.content || ""), "base64").toString("utf-8");
      },
      /**
       * Any file in a repository, decoded.
       *
       * Importing a skill needs a path; getReadme only ever reaches one file.
       * Each path segment is encoded separately so a directory separator stays
       * a separator rather than becoming %2F.
       */
      getFile: async function (owner, repo, filePath) {
        var body = await call("GET", "/repos/" + owner + "/" + repo + "/contents/" +
          String(filePath).split("/").map(encodeURIComponent).join("/"));
        return Buffer.from(String(body.content || ""), "base64").toString("utf-8");
      },
      getTree: async function (owner, repo) {
        var body = await call("GET", "/repos/" + owner + "/" + repo + "/git/trees/HEAD?recursive=1");
        return (body.tree || [])
          .filter(function (t) { return t.type === "blob"; })
          .map(function (t) { return t.path; });
      },
      listRuns: async function (owner, repo) {
        var body = await call("GET", "/repos/" + owner + "/" + repo + "/actions/runs?per_page=10");
        return (body.workflow_runs || []).map(function (r) {
          return { name: r.name, status: r.status, conclusion: r.conclusion, url: r.html_url };
        });
      },
      /**
       * Repository search, through the user's token.
       *
       * Authenticated deliberately. The Research panel used an unauthenticated
       * call, which GitHub rate-limits to ten searches a minute across the
       * whole machine - so a second question in the same minute returned an
       * error that read as the feature being broken. The token is already held
       * for push and clone; using it here costs nothing and raises the limit to
       * thirty.
       *
       * Only the fields the panel shows are kept: a search response carries
       * about eighty per repository, and passing all of it to the renderer
       * would put a megabyte through IPC to display four lines.
       */
      searchRepos: async function (query, limit) {
        var q = String(query || "").trim();
        if (!q) return [];
        var n = Math.min(Math.max(Number(limit) || 8, 1), 30);
        var body = await call("GET", "/search/repositories?sort=stars&order=desc&per_page=" + n +
          "&q=" + encodeURIComponent(q));
        return (body.items || []).map(function (r) {
          return {
            fullName: r.full_name,
            description: r.description || "",
            stars: r.stargazers_count || 0,
            language: r.language || "",
            url: r.html_url,
            updatedAt: r.pushed_at || r.updated_at || "",
          };
        });
      },
      dispatchWorkflow: function (owner, repo, workflowId, ref) {
        return call("POST", "/repos/" + owner + "/" + repo + "/actions/workflows/" + workflowId + "/dispatches",
          { ref: ref || "main" });
      },
    };
  }

  var api = { createGitHubApi: createGitHubApi };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNGitHubApi = api;
})(typeof window !== "undefined" ? window : globalThis);
