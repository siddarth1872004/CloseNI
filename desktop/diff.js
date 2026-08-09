/*
 * Line diff for the Builder's file cards.
 *
 * Loaded as a plain <script> in the renderer (exposes window.CNDiff) and
 * require()d by the test harness (exposes module.exports). There is no bundler,
 * so this cannot use import/export.
 */
(function (root) {
  var GAP_THRESHOLD = 6; // unchanged runs longer than this collapse
  var GAP_CONTEXT = 2;   // lines kept either side of a collapsed run

  function splitLines(text) {
    if (text === "" || text === null || text === undefined) return [];
    var lines = String(text).split("\n");
    // "a\n" is one line, not two — a trailing newline terminates rather than adds.
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }

  /** Longest common subsequence, walked back into a list of rows. */
  function diffLines(before, after) {
    var a = splitLines(before);
    var b = splitLines(after);
    var n = a.length;
    var m = b.length;
    var i, j, k;

    var lcs = [];
    for (i = 0; i <= n; i++) lcs.push(new Array(m + 1).fill(0));
    for (i = n - 1; i >= 0; i--) {
      for (j = m - 1; j >= 0; j--) {
        lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }

    var rows = [];
    var x = 0;
    var y = 0;
    while (x < n && y < m) {
      if (a[x] === b[y]) { rows.push({ type: "same", text: a[x] }); x++; y++; }
      else if (lcs[x + 1][y] >= lcs[x][y + 1]) { rows.push({ type: "remove", text: a[x] }); x++; }
      else { rows.push({ type: "add", text: b[y] }); y++; }
    }
    while (x < n) { rows.push({ type: "remove", text: a[x] }); x++; }
    while (y < m) { rows.push({ type: "add", text: b[y] }); y++; }

    return collapse(rows);
  }

  /** Replace long runs of unchanged lines with a single gap marker. */
  function collapse(rows) {
    var out = [];
    var i = 0;
    var k;
    while (i < rows.length) {
      if (rows[i].type !== "same") { out.push(rows[i]); i++; continue; }
      var start = i;
      while (i < rows.length && rows[i].type === "same") i++;
      var run = i - start;
      if (run <= GAP_THRESHOLD) {
        for (k = start; k < i; k++) out.push(rows[k]);
        continue;
      }
      var head = start === 0 ? 0 : GAP_CONTEXT;
      var tail = i === rows.length ? 0 : GAP_CONTEXT;
      for (k = start; k < start + head; k++) out.push(rows[k]);
      out.push({ type: "gap", text: "… " + (run - head - tail) + " unchanged lines" });
      for (k = i - tail; k < i; k++) out.push(rows[k]);
    }
    return out;
  }

  var api = { diffLines: diffLines };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNDiff = api;
})(typeof window !== "undefined" ? window : globalThis);
