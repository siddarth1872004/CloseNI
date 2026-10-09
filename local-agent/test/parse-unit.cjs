/*
 * Unit tests: Reading a reply into changes, and applying them: plan and patch parsing,
 * search/replace matching, diffs, context selection and repair follow-ups.
 *
 * Run by run-tests.cjs (npm test), against the compiled output.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const DIST = path.join(__dirname, "..", "dist");
const { parseMarkdownToEditPlan } = require(path.join(DIST, "parser/patch-parser.js"));
const { parsePlanRobust } = require(path.join(DIST, "parser/json-repair.js"));
const { applyPatch } = require(path.join(DIST, "patch/patch-applier.js"));
const { selectRelevantFiles, extractSignatures } = require(path.join(DIST, "context/relevance.js"));
const F = "```";

// Handed in by run-tests.cjs, which keeps the one count.
let check, section, skipped;

function emptyPlan(changes) {
  return { changes: changes, warnings: [], errors: [], commands: [], rawMarkdown: "" };
}

function testEditPlanParsing() {
  section("edit-plan parsing");

  let r = parseMarkdownToEditPlan(
    F + 'json\n{"files":[{"path":"a.py","mode":"create","content":"print(1)\\n"}],"commands":["python a.py"]}\n' + F
  );
  check("clean json", r.changes.length === 1 && r.changes[0].filePath === "a.py" && r.changes[0].newContent === "print(1)\n");
  check("commands parsed", r.commands.length === 1);

  r = parseMarkdownToEditPlan(
    "Sure! Here is the code:\n\n" + F + 'json\n{"files":[{"path":"b.py","mode":"create","content":"x=1"}]}\n' + F + "\n\nLet me know!"
  );
  check("ignores prose around the fence", r.changes.length === 1 && r.changes[0].filePath === "b.py");

  r = parseMarkdownToEditPlan(F + 'json\n{"files":[{"path":"c.py","mode":"create","content":"y=2",},],}\n' + F);
  check("repairs trailing commas", r.changes.length === 1 && r.changes[0].filePath === "c.py");

  // Models routinely emit real newlines inside a JSON string, which is invalid JSON.
  r = parseMarkdownToEditPlan(F + 'json\n{"files":[{"path":"d.py","mode":"create","content":"def f():\n    return 1\n"}]}\n' + F);
  check("repairs raw newlines inside content", r.changes.length === 1 && String(r.changes[0].newContent).includes("return 1"));

  r = parseMarkdownToEditPlan('{"files":[{"path":"e.py","mode":"create","content":"z=3"}]}');
  check("accepts unfenced json", r.changes.length === 1);

  r = parseMarkdownToEditPlan(F + 'json\n{"files":[{"mode":"create","content":"orphan"}]}\n' + F);
  check("drops a change with no path", r.changes.every((c) => !!c.filePath), "got " + JSON.stringify(r.changes));

  r = parseMarkdownToEditPlan("I cannot help with that request.");
  check("prose-only reply yields no changes", r.changes.length === 0);
}

function testPlanParsing() {
  section("plan parsing");

  let p = parsePlanRobust(
    F + 'json\n{"summary":"build api","steps":[{"title":"s1","detail":"d1","files":["a.py"]},{"title":"s2","detail":"d2","files":["b.py"]}]}\n' + F
  );
  check("clean plan", !!p && p.steps.length === 2 && p.summary === "build api");

  p = parsePlanRobust("Here's the plan:\n" + F + 'json\n{"summary":"x","steps":[{"title":"only","detail":"dd","files":["q.py"]}]}\n' + F + "\nHope that helps");
  check("plan wrapped in prose", !!p && p.steps.length === 1);

  p = parsePlanRobust('{"plan":{"summary":"nested","steps":[{"title":"n","detail":"","files":[]}]}}');
  check("plan nested under a plan key", !!p && p.steps.length === 1);

  p = parsePlanRobust("no json whatsoever here");
  check("unparseable plan returns null", p === null);
}

function testDependsOnNumbering() {
  section("dependsOn numbering");
  const { parsePlanRobust, normaliseDependsOn } = require(path.join(DIST, "parser/json-repair.js"));

  // The real failure: a model numbers its steps 1..N and references them by
  // those numbers, so step 3 saying dependsOn:[2] reads as depending on itself
  // once treated as a zero-based index. An eighteen-step Flask plan was thrown
  // away twice in one run for this, and the re-ask resent the same good plan.
  const oneBased = {
    summary: "s",
    steps: [
      { title: "1", files: ["a"], dependsOn: [] },
      { title: "2", files: ["b"], dependsOn: [] },
      { title: "3", files: ["c"], dependsOn: [2] },
      { title: "4", files: ["d"], dependsOn: [3] },
      { title: "5", files: ["e"], dependsOn: [3, 4] },
    ],
  };
  const parsed = parsePlanRobust(JSON.stringify(oneBased));
  check("a 1-based plan is accepted", !!parsed, "rejected");
  // Step 3 -> step 2 is index 1; step 5 -> steps 3 and 4 are indices 2 and 3.
  check("its references are shifted to indices",
    parsed && JSON.stringify(parsed.steps.map((s) => s.dependsOn)) === "[[],[],[1],[2],[2,3]]",
    parsed && JSON.stringify(parsed.steps.map((s) => s.dependsOn)));

  // Zero-based is what the prompt asks for and must be left alone.
  const zeroBased = [
    { title: "a", files: ["a"], dependsOn: [] },
    { title: "b", files: ["b"], dependsOn: [0] },
    { title: "c", files: ["c"], dependsOn: [0, 1] },
  ];
  const kept = normaliseDependsOn(zeroBased);
  check("a 0-based plan is untouched",
    JSON.stringify(kept.map((s) => s.dependsOn)) === "[[],[0],[0,1]]",
    JSON.stringify(kept && kept.map((s) => s.dependsOn)));

  // A graph that is broken under both readings stays rejected: shifting must
  // not turn one unschedulable plan into a different unschedulable plan.
  check("a real cycle is still rejected",
    normaliseDependsOn([
      { title: "a", files: ["a"], dependsOn: [1] },
      { title: "b", files: ["b"], dependsOn: [0] },
    ]) === null);
  check("a forward dependency is still rejected",
    normaliseDependsOn([
      { title: "a", files: ["a"], dependsOn: [] },
      { title: "b", files: ["b"], dependsOn: [5] },
    ]) === null);
  check("an empty plan is rejected", normaliseDependsOn([]) === null);
}

function testRobustFileParsing() {
  section("robust file parsing");
  const { parseFilesRobust, salvageTruncatedJson } = require(path.join(DIST, "parser/json-repair.js"));
  const { extractFencedFiles, looksLikePath } = require(path.join(DIST, "parser/fenced-files.js"));

  const paths = function (text) {
    const r = parseFilesRobust(text);
    return r ? r.changes.map(function (c) { return c.filePath; }).join(",") : null;
  };

  // The control: nothing below may break the format that already worked.
  check("plain json still parses", paths('{"files":[{"path":"ok.py","content":"x=1"}]}') === "ok.py");
  check("fenced json still parses",
    paths('```json\n{"files":[{"path":"ok.py","content":"x=1"}]}\n```') === "ok.py");

  // Truncation - what a completion timeout leaves behind.
  check("a reply cut off mid-file keeps the files completed before the cut",
    paths('{"files":[{"path":"a.py","content":"x=1"},{"path":"b.py","content":"import os\\nprint(') === "a.py");
  check("a reply cut off after a key keeps the complete entries",
    paths('{"files":[{"path":"a.py","content":"x=1"},{"path":"b.py","content":') === "a.py");
  // The half-written file is dropped rather than written truncated. Closing an
  // open string recovers content that was cut off mid-write, which for source
  // means a file that will not compile - and may overwrite one that did. An
  // end-to-end build caught this: `"import os\nprint(` was salvaged into b.py
  // and failed the step. One re-ask is cheaper than a broken file.
  check("a single file cut off mid-content is refused, not written partial",
    parseFilesRobust('```json\n{"files":[{"path":"a.py","content":"import os\\nprint(1)') === null);
  check("salvage does nothing to already-balanced json",
    salvageTruncatedJson('{"a":1}').length === 0);

  // The model answered in code blocks instead of JSON.
  check("path from a comment on the first line",
    paths("Here:\n\n```python\n# src/app/config.py\nDEBUG = True\n```") === "src/app/config.py");
  check("path from the fence info string",
    paths("```python src/models.py\nclass A: pass\n```") === "src/models.py");
  check("path from a heading above the fence",
    paths("**src/routes.py**\n```python\nx = 1\n```") === "src/routes.py");
  check("several files with prose between them",
    paths("A:\n**src/a.py**\n```python\na=1\n```\nB:\n```python\n# src/b.py\nb=2\n```") === "src/a.py,src/b.py");

  // The naming comment must not survive into the file it named.
  const c = parseFilesRobust("```python\n# src/app.py\nDEBUG = True\n```");
  check("the path comment is stripped from the content",
    c.changes[0].newContent.indexOf("src/app.py") === -1 && /DEBUG/.test(c.changes[0].newContent));

  // A file written twice is the model correcting itself.
  const twice = parseFilesRobust("```python\n# a.py\nold\n```\nthen:\n```python\n# a.py\nnew\n```");
  check("a file written twice keeps the later version",
    twice.changes.length === 1 && /new/.test(twice.changes[0].newContent));

  // Guards. A false positive writes a junk file, which is worse than a miss.
  check("an illustrative block with no path is ignored",
    parseFilesRobust("For example:\n```python\nprint('hi')\n```") === null);
  check("prose is not mistaken for a path", !looksLikePath("Here is the file"));
  check("an absolute path is refused", !looksLikePath("/etc/passwd"));
  check("a traversing path is refused", !looksLikePath("../../etc/passwd"));
  check("a url is refused", !looksLikePath("https://example.com/a.py"));
  check("a real path is accepted", looksLikePath("src/app/config.py"));
  check("a bare known filename is accepted", looksLikePath("Dockerfile"));

  // Salvage can recover a path whose content never arrived; writing that would
  // blank a real file.
  check("a file with a path but no content is dropped",
    parseFilesRobust('{"files":[{"path":"b.py"}]}') === null);

  check("empty blocks are ignored", extractFencedFiles("```python x.py\n\n```").length === 0);

  // Reading a reply back out of a page loses the fence info string: the
  // language becomes a class on <code> and anything after it lands as the first
  // line of the code. A trial build lost two files to this before the bare
  // first line was accepted as a path.
  check("a bare path on the block's first line is accepted",
    paths("\n```\n src/store.py\nHABITS = []\n```\n") === "src/store.py");
  check("a block that is only a path is not a file",
    parseFilesRobust("```\nsrc/x.py\n```") === null);
  check("a normal first line is not mistaken for a path",
    parseFilesRobust("```\nimport os\nprint(1)\n```") === null);
}

function testSearchBlockMatching() {
  section("search_replace matching");
  const { findSearchBlock, replaceLines, applyPatch } =
    require(path.join(DIST, "patch/patch-applier.js"));

  const file = "def add(a, b):\n    return a + b\n\ndef sub(a, b):\n    return a - b\n";
  const found = (blk) => {
    const r = findSearchBlock(file, blk);
    return r && r !== "ambiguous" ? r.start + "-" + r.end : String(r);
  };

  // A real run missed six of seven blocks on an exact substring match. Models
  // get the code right and the whitespace slightly wrong.
  check("an exact block matches", found("def add(a, b):\n    return a + b") === "0-2");
  check("trailing spaces are tolerated", found("def add(a, b):   \n    return a + b") === "0-2");
  check("CRLF is tolerated", found("def add(a, b):\r\n    return a + b") === "0-2");
  check("a trailing newline is tolerated", found("def add(a, b):\n    return a + b\n") === "0-2");

  // Indentation is the meaning of the code in Python, so it is compared
  // exactly: a matcher that shrugged at it could patch the wrong scope.
  check("wrong indentation does NOT match", found("def add(a, b):\n        return a + b") === "null");
  check("absent text does not match", found("def mul(a, b):\n    return a * b") === "null");
  check("an empty block does not match everything", found("") === "null");
  check("a whitespace-only block does not match", found("   \n  ") === "null");

  // String.replace silently took the first hit, which can edit a place nobody
  // looked at.
  check("a repeated block is ambiguous, not the first hit",
    findSearchBlock("x = 1\nx = 1\n", "x = 1") === "ambiguous");

  check("replacement leaves the rest of the file alone",
    replaceLines(file, 0, 2, "def add(a, b):\n    return a + b + 0") ===
    "def add(a, b):\n    return a + b + 0\n\ndef sub(a, b):\n    return a - b\n");
  check("a CRLF file stays CRLF",
    replaceLines("a\r\nb\r\n", 0, 1, "z") === "z\r\nb\r\n");

  // End to end through the applier, with the whitespace drift that failed live.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sr-"));
  fs.writeFileSync(path.join(ws, "m.py"), file);
  const res = applyPatch(ws, {
    changes: [{
      filePath: "m.py", mode: "search_replace", language: "python",
      searchBlock: "def add(a, b):   \n    return a + b",
      replaceBlock: "def add(a, b):\n    return a + b + 0",
    }],
  });
  check("the applier accepts a block with drifted whitespace",
    res.appliedFiles.length === 1, JSON.stringify(res.errors));
  check("and writes the change", fs.readFileSync(path.join(ws, "m.py"), "utf8").includes("a + b + 0"));

  // A miss must say what to do instead.
  const miss = applyPatch(ws, {
    changes: [{ filePath: "m.py", mode: "search_replace", language: "python",
      searchBlock: "nope", replaceBlock: "x" }],
  });
  check("a miss names the way out", (miss.errors || []).some((e) => /overwrite/.test(e)),
    JSON.stringify(miss.errors));

  fs.rmSync(ws, { recursive: true, force: true });
}

function testAbbreviationGuard() {
  section("abbreviated files never overwrite real ones");
  const { isAbbreviated, applyPatch } = require(path.join(DIST, "patch/patch-applier.js"));

  // Flagged: a stand-in for the file rather than the file.
  check("'rest of the file unchanged' is caught", isAbbreviated("A = 1\n# ... rest of the file unchanged ...\n"));
  check("'existing code here' is caught", isAbbreviated("function a(){}\n// existing code here\n"));
  check("'same as before' is caught", isAbbreviated("x = 1\n# ... same as before\n"));
  check("'keep the rest as-is' is caught", isAbbreviated("x = 1\n// keep the rest of the file as-is\n"));

  // Allowed: an ellipsis on its own is ordinary code.
  check("python Ellipsis is not flagged", !isAbbreviated("def f():\n    ...\n"));
  check("slicing is not flagged", !isAbbreviated("xs = data[...]\n"));
  check("prose using the word rest is not flagged",
    !isAbbreviated('"""Handles the rest of the pipeline."""\nx = 1\n'));
  check("empty content is not flagged", !isAbbreviated(""));

  // And the behaviour that matters: it must not reach disk.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-abbrev-"));
  const target = path.join(ws, "config.py");
  fs.writeFileSync(target, "DEBUG = True\nDB_PATH = 'habits.db'\n");

  const res = applyPatch(ws, {
    changes: [{ filePath: "config.py", mode: "overwrite", language: "python",
      newContent: "DEBUG = True\n# ... rest of the file unchanged ...\n" }],
  });
  check("the overwrite is refused", res.appliedFiles.length === 0, JSON.stringify(res.appliedFiles));
  check("the error names the problem", (res.errors || []).some(function (e) { return /abbreviated/i.test(e); }), JSON.stringify(res.errors));
  check("the real file is untouched",
    fs.readFileSync(target, "utf8").includes("DB_PATH"), fs.readFileSync(target, "utf8"));

  // Creating a NEW file with the same text destroys nothing, so it is allowed:
  // refusing there would risk blocking legitimate code on a guess.
  const fresh = applyPatch(ws, {
    changes: [{ filePath: "brand-new.py", mode: "create", language: "python",
      newContent: "A = 1\n# ... rest of the file unchanged ...\n" }],
  });
  check("a new file with the same text is allowed", fresh.appliedFiles.length === 1, JSON.stringify(fresh.errors));

  fs.rmSync(ws, { recursive: true, force: true });
}

function testPatchApplier() {
  section("patch applier");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-test-"));
  const ws = path.join(root, "ws");
  const sibling = path.join(root, "ws-evil");
  fs.mkdirSync(ws);
  fs.mkdirSync(sibling);

  let r = applyPatch(ws, emptyPlan([{ filePath: "src/app.py", mode: "create", newContent: "print('hi')\n" }]));
  check("creates a nested file", r.success && fs.readFileSync(path.join(ws, "src/app.py"), "utf8") === "print('hi')\n", r.errors.join("|"));

  r = applyPatch(ws, emptyPlan([{ filePath: "src/app.py", mode: "overwrite", newContent: "print('v2')\n" }]));
  check("overwrite takes a backup", r.success && !!r.backupDir, r.errors.join("|"));

  r = applyPatch(ws, emptyPlan([{ filePath: "src/app.py", mode: "search_replace", searchBlock: "v2", replaceBlock: "v3" }]));
  check("search_replace edits in place", r.success && fs.readFileSync(path.join(ws, "src/app.py"), "utf8").includes("v3"), r.errors.join("|"));

  r = applyPatch(ws, emptyPlan([{ filePath: "../ws-evil/pwned.py", mode: "create", newContent: "bad" }]));
  check("blocks ../ traversal", !r.success && !fs.existsSync(path.join(sibling, "pwned.py")));

  // A sibling directory sharing the workspace name as a prefix must not count as inside it.
  const prefixEscape = path.join("..", path.basename(ws) + "-evil", "x.py");
  r = applyPatch(ws, emptyPlan([{ filePath: prefixEscape, mode: "create", newContent: "bad" }]));
  check("blocks sibling-prefix escape", !r.success && !fs.existsSync(path.join(sibling, "x.py")));

  const abs = path.join(root, "abs-pwned.py");
  r = applyPatch(ws, emptyPlan([{ filePath: abs, mode: "create", newContent: "bad" }]));
  check("blocks absolute paths", !r.success && !fs.existsSync(abs));

  r = applyPatch(ws, emptyPlan([{ mode: "create", newContent: "x" }]));
  check("reports a missing path clearly", !r.success && r.errors[0].includes("missing a file path"), r.errors.join("|"));

  fs.rmSync(root, { recursive: true, force: true });
}

// The parsing sweep: adversarial replies through the text parsers, and a
// pathological input for every regex path. It found real bugs when it was a
// scratch script, so it stays.
function testParseSweep() {
  section("parsing sweep: fences, stray braces and slow paths");
  const { parseFilesRobust, robustParseJson, extractStepsHeuristic } = require(path.join(DIST, "parser/json-repair.js"));
  const { extractFencedFiles } = require(path.join(DIST, "parser/fenced-files.js"));
  const T = "```";
  const filesOf = (t) => { const r = parseFilesRobust(t); return r ? r.changes : []; };
  const contentOf = (t, p) => { const c = filesOf(t).find((x) => x.filePath === p); return c ? c.newContent : undefined; };
  const README = "# Tool\n\nInstall:\n\n" + T + "bash\nnpm i tool\n" + T + "\n\nDone.";

  check("a four-backtick fence carries a README with its own fence",
    contentOf("````markdown README.md\n" + README + "\n````", "README.md") === README + "\n");
  check("so does a tilde fence", contentOf("~~~markdown README.md\n" + README + "\n~~~", "README.md") === README + "\n");
  const PYSTR = 'FENCE = "' + T + '"\nprint(FENCE)';
  check("a triple backtick mid-line does not close the block", contentOf(T + "python app.py\n" + PYSTR + "\n" + T, "app.py") === PYSTR + "\n");
  check("a closing fence may carry trailing spaces", contentOf(T + "python a.py\nx = 1\n" + T + "   \n\nnext", "a.py") === "x = 1\n");
  check("a closing fence may be indented up to 3 spaces", contentOf(T + "python a.py\nx = 1\n   " + T, "a.py") === "x = 1\n");
  check("a CRLF reply reads", /x = 1/.test(contentOf(T + "python\r\n# a.py\r\nx = 1\r\n" + T + "\r\n", "a.py") || ""));
  check("an unclosed last block (a truncated reply) is not written",
    filesOf("**a.py**\n" + T + "python\nx=1\n" + T + "\n**b.py**\n" + T + "python\nprint(").map((c) => c.filePath).join(",") === "a.py");
  const two = "**a.py**\n" + T + "python\nx=1\n" + T + "\n\n**README.md**\n````md\n" + README + "\n````";
  check("two files, the second holding a fence inside a longer one",
    filesOf(two).map((c) => c.filePath + ":" + (c.newContent === README + "\n" || c.newContent === "x=1\n")).join(",") === "a.py:true,README.md:true", JSON.stringify(filesOf(two)));
  check("a shorter fence inside does not close a longer one", contentOf("````md docs/x.md\na\n" + T + "\nb\n````", "docs/x.md") === "a\n" + T + "\nb\n");
  check("inline triple backticks in prose do not open a block",
    contentOf("Use " + T + "code" + T + " spans.\n\n" + T + "python\n# a.py\nx=1\n" + T, "a.py") === "x=1\n");

  check("json after a shell block with ${VAR}",
    filesOf("Run:\n" + T + "bash\necho ${HOME}\n" + T + "\n" + T + 'json\n{"files":[{"path":"a.py","content":"x=1"}]}\n' + T).map((c) => c.filePath).join(",") === "a.py");
  check("json after prose with a brace placeholder",
    filesOf('Replace {name} below.\n{"files":[{"path":"a.py","content":"x=1"}]}').map((c) => c.filePath).join(",") === "a.py");
  check("json whose content holds a fence",
    contentOf(T + 'json\n{"files":[{"path":"README.md","content":"' + T + 'bash\\nnpm i\\n' + T + '"}]}\n' + T, "README.md") === T + "bash\nnpm i\n" + T);
  const lead = '{"note":"x"}\n{"files":[{"path":"a.py","content":"x=1"}]}';
  check("json with another object before the files object", filesOf(lead).map((c) => c.filePath).join(",") === "a.py", JSON.stringify(filesOf(lead)));
  check("robustParseJson never throws on junk", [null, undefined, 3, {}, "{", "}", "{\"", T, T + "json\n{", "\\", "{\"a\":\"\\"].every((j) => {
    try { robustParseJson(j); return true; } catch (e) { return false; }
  }));
  check("the patch parser never throws on junk", ["", "\"path\": \"", "\"path\":\"a\",\"mode\":\"x\",\"content\":\"", "{".repeat(50)].every((j) => {
    try { parseMarkdownToEditPlan(j); return true; } catch (e) { return false; }
  }));

  // A quadratic path takes tens of seconds at this size (one did, on 200 KB of
  // spaces); a linear one takes milliseconds. The limit sits far from both.
  const N = 200000;
  const slow = [];
  const inputs = {
    backticks: T.repeat(N / 3),
    openFences: (T + "x\n").repeat(N / 5),
    braces: "{".repeat(N),
    quotes: '"'.repeat(N),
    backslashes: "\\".repeat(N),
    commas: ",".repeat(N) + " ".repeat(N),
    keys: '{"a":' + '"x":'.repeat(N / 4),
    spaces: "{" + " ".repeat(N) + ",",
    titles: '"title":"'.repeat(N / 9),
    paths: '"path":"'.repeat(N / 8),
    pathmode: ('"path":"a","mode":"c","content":"' + "x".repeat(50)).repeat(N / 90),
    leadins: ("x\n".repeat(50) + T + "\na\n" + T + "\n").repeat(N / 110),
    fencedJunk: (T + "json\n{" + '"a":'.repeat(20) + "\n").repeat(N / 100),
    objects: '{"note":"x"}\n'.repeat(N / 13),
  };
  const parsers = { parseFilesRobust: parseFilesRobust, extractFencedFiles: extractFencedFiles, patchParser: parseMarkdownToEditPlan, steps: extractStepsHeuristic };
  for (const [k, v] of Object.entries(inputs)) {
    for (const [name, fn] of Object.entries(parsers)) {
      const t = Date.now();
      try { fn(v); } catch (e) { slow.push(name + "/" + k + " threw " + e.message); }
      const ms = Date.now() - t;
      if (ms > 5000) slow.push(name + "/" + k + " " + ms + "ms");
    }
  }
  check("no parser is quadratic or throws on 200 KB of pathological input", slow.length === 0, slow.join("; "));
}

function testDelta() {
  section("delta context");
  const delta = require(path.join(DIST, "context/delta.js"));
  const f = (p, c) => ({ path: p, content: c, mtimeMs: 1000 });

  check("hash is stable", delta.hashContent("abc") === delta.hashContent("abc"));
  check("hash differs on different content", delta.hashContent("abc") !== delta.hashContent("abd"));

  const files = [f("a.py", "one"), f("b.py", "two"), f("c.py", "three")];

  // Empty ledger: everything is new, which keeps step 0 identical to today.
  const first = delta.computeDelta(files, {});
  check("empty ledger makes every file a candidate", first.candidates.length === 3, "candidates: " + first.candidates.length);
  check("empty ledger reports every path as new", first.newPaths.length === 3);
  check("empty ledger has nothing unchanged", first.unchangedCount === 0);

  // After sending a.py and b.py, and listing c.py in the tree only.
  const ledger = delta.nextLedger({}, files, ["a.py", "b.py"], 0);
  check("sent files record a hash", ledger["a.py"].hash === delta.hashContent("one"));
  check("listed-only files record a null hash", ledger["c.py"].hash === null, JSON.stringify(ledger["c.py"]));
  check("ledger records the step", ledger["a.py"].step === 0);

  const second = delta.computeDelta(files, ledger);
  check("unchanged sent files are not candidates", !second.candidates.some((x) => x.path === "a.py"), second.candidates.map((x) => x.path).join(","));
  check("listed-only files are still candidates", second.candidates.some((x) => x.path === "c.py"));
  check("nothing is newly appeared", second.newPaths.length === 0, second.newPaths.join(","));
  check("unchanged files are counted", second.unchangedCount === 2, "unchanged: " + second.unchangedCount);

  // A file rewritten between steps must be re-sent — this is the drift correction.
  const edited = [f("a.py", "one EDITED"), f("b.py", "two"), f("c.py", "three")];
  const third = delta.computeDelta(edited, ledger);
  check("a changed file becomes a candidate again", third.candidates.some((x) => x.path === "a.py"), third.candidates.map((x) => x.path).join(","));
  check("a changed file is not reported as new", third.newPaths.indexOf("a.py") === -1);

  // A file created by the previous step appears in the tree delta.
  const grown = edited.concat([f("d.py", "four")]);
  const fourth = delta.computeDelta(grown, ledger);
  check("a brand new file is reported as new", fourth.newPaths.length === 1 && fourth.newPaths[0] === "d.py", fourth.newPaths.join(","));

  // Deleting a file must not resurrect it or throw.
  const shrunk = [f("a.py", "one")];
  const fifth = delta.computeDelta(shrunk, ledger);
  check("deleted files are simply absent", fifth.candidates.length === 0 && fifth.newPaths.length === 0, JSON.stringify(fifth.newPaths));

  check("ledger carries forward untouched entries", (() => {
    const l2 = delta.nextLedger(ledger, files, [], 1);
    return l2["a.py"].hash === delta.hashContent("one") && l2["a.py"].step === 0;
  })());
}

function testDiff() {
  section("line diff");
  const { diffLines } = require(path.join(__dirname, "..", "..", "native", "qml", "js", "diff.mjs"));
  const types = (rows) => rows.map((r) => r.type).join(",");
  const texts = (rows, t) => rows.filter((r) => r.type === t).map((r) => r.text);

  check("identical files are all same", types(diffLines("a\nb", "a\nb")) === "same,same");

  const added = diffLines("a\nc", "a\nb\nc");
  check("an added line is marked add", texts(added, "add").join() === "b", JSON.stringify(added));
  check("adding does not mark removals", texts(added, "remove").length === 0, JSON.stringify(added));

  const removed = diffLines("a\nb\nc", "a\nc");
  check("a removed line is marked remove", texts(removed, "remove").join() === "b", JSON.stringify(removed));

  const changed = diffLines("a\nold\nc", "a\nnew\nc");
  check("a changed line is a remove plus an add", texts(changed, "remove").join() === "old" && texts(changed, "add").join() === "new", JSON.stringify(changed));

  // A created file has no previous version: everything is an addition.
  const created = diffLines("", "x\ny");
  check("empty before means all added", types(created) === "add,add", JSON.stringify(created));
  check("empty both sides yields nothing", diffLines("", "").length === 0);

  // Long unchanged runs collapse so a small change in a big file stays readable.
  const big = Array.from({ length: 40 }, (_, i) => "line" + i).join("\n");
  const collapsed = diffLines(big, big + "\nEXTRA");
  check("long unchanged runs collapse to a gap", collapsed.some((r) => r.type === "gap"), types(collapsed).slice(0, 60));
  check("collapsing keeps the change visible", collapsed.some((r) => r.type === "add" && r.text === "EXTRA"));
  check("collapsed output is far shorter than the file", collapsed.length < 20, "rows: " + collapsed.length);

  // Trailing newlines must not invent a phantom final line.
  check("trailing newline is not a spurious line", diffLines("a\n", "a\n").every((r) => r.type === "same"), JSON.stringify(diffLines("a\n", "a\n")));
}

function testRelevance() {
  section("context selection");

  // The workspace exactly as it stood when the real run reached step 5. Steps 1-4
  // produced models, storage, services and cli; step 5 writes main.py at the root
  // and has to import from cli/handlers.py.
  let t = 1000;
  const f = (p, content) => ({ path: p, content: content, mtimeMs: (t += 1000) });
  const todoWorkspace = [
    f("src/models/__init__.py", "from .task import Task\n"),
    f("src/models/task.py", "class Task:\n    def __init__(self, title):\n        self.title = title\n"),
    f("src/storage/__init__.py", "from .json_storage import JsonStorage\n"),
    f("src/storage/json_storage.py", "import json\n\nclass JsonStorage:\n    def load(self):\n        pass\n"),
    f("src/services/__init__.py", "from .task_service import TaskService\n"),
    f("src/services/task_service.py", "class TaskService:\n    def add(self, t):\n        pass\n"),
    f("src/cli/parser.py", "import argparse\n\ndef create_parser():\n    pass\n"),
    // Written last, by step 4 — and the one main.py must import from.
    f("src/cli/handlers.py", "def handle_add(a):\n    pass\ndef handle_remove(a):\n    pass\ndef handle_done(a):\n    pass\n"),
    f("src/cli/__init__.py", "from .parser import create_parser\n"),
  ];
  const step5 = "Overall: Build a to-do CLI\n\nExecute ONLY this step: Implement Main Entry Point. Create the entrypoint. Expected files: main.py";

  const picked = selectRelevantFiles({ files: todoWorkspace, stepDetail: step5, prompt: "build a todo cli" });
  const pickedPaths = picked.map((p) => p.path);

  check("selects something", picked.length > 0);
  check(
    "includes the handlers module the entrypoint imports",
    pickedPaths.includes("src/cli/handlers.py"),
    pickedPaths.join(", ")
  );
  check(
    "the handler names are visible to the model",
    picked.some((p) => p.path === "src/cli/handlers.py" && p.content.includes("handle_remove")),
    JSON.stringify(picked.find((p) => p.path === "src/cli/handlers.py"))
  );
  check("recent work outranks older work", pickedPaths.indexOf("src/cli/handlers.py") < pickedPaths.indexOf("src/models/task.py") || !pickedPaths.includes("src/models/task.py"), pickedPaths.join(", "));

  // Deterministic: same input, same context, regardless of walk order.
  const shuffled = todoWorkspace.slice().reverse();
  const again = selectRelevantFiles({ files: shuffled, stepDetail: step5, prompt: "build a todo cli" });
  check("selection is deterministic", JSON.stringify(again.map((p) => p.path)) === JSON.stringify(pickedPaths), again.map((p) => p.path).join(", "));

  // Same-directory work still wins when the step targets a subdirectory.
  const stepInCli = "Execute ONLY this step: Extend the CLI. Expected files: src/cli/commands.py";
  const cliPick = selectRelevantFiles({ files: todoWorkspace, stepDetail: stepInCli, prompt: "cli" }).map((p) => p.path);
  check("directory match still applies", cliPick.includes("src/cli/parser.py") && cliPick.includes("src/cli/handlers.py"), cliPick.join(", "));

  // Budget: a pile of large files must not blow up the prompt.
  const many = [];
  for (let i = 0; i < 40; i++) many.push({ path: "src/mod" + i + ".py", content: "def f" + i + "():\n    pass\n".repeat(200), mtimeMs: 1000 + i });
  const bounded = selectRelevantFiles({ files: many, stepDetail: "Expected files: main.py", prompt: "x", budgetChars: 1200 });
  const totalChars = bounded.reduce((n, p) => n + p.content.length, 0);
  check("respects the character budget", bounded.length <= 8 && totalChars <= 1200 + 800, "files=" + bounded.length + " chars=" + totalChars);
  check("always returns at least one file", bounded.length >= 1);

  check("empty workspace yields nothing", selectRelevantFiles({ files: [], stepDetail: "x", prompt: "y" }).length === 0);

  section("signature extraction");
  check(
    "python: keeps defs and imports, drops bodies",
    (() => {
      const s = extractSignatures("import os\n\nclass A:\n    def go(self):\n        secret_body = 1\n        return secret_body\n", "a.py");
      return s.includes("import os") && s.includes("class A:") && s.includes("def go") && !s.includes("secret_body");
    })()
  );
  check(
    "javascript: picks up module.exports",
    extractSignatures("const x = 1;\nfunction go() { return 2; }\nmodule.exports = { go };\n", "a.js").includes("module.exports"),
    extractSignatures("const x = 1;\nfunction go() { return 2; }\nmodule.exports = { go };\n", "a.js")
  );
  check(
    "rust: picks up pub fn and struct",
    (() => {
      const s = extractSignatures("use std::io;\n\npub struct Store {}\n\npub fn load() -> u32 {\n    42\n}\n", "a.rs");
      return s.includes("pub struct Store") && s.includes("pub fn load") && !s.includes("42");
    })()
  );
  check(
    "java: picks up declarations",
    extractSignatures("package app;\n\npublic class Main {\n    public static void main(String[] a) {}\n}\n", "Main.java").includes("public class Main"),
  );
}

function testApplyFollowUp() {
  section("a failed patch is retried with a different tactic");
  const { buildApplyFollowUp } = require(path.join(DIST, "follow-up.js"));

  // The case from the 11 August run: six of seven search blocks missed. The
  // step recovered only because the generic follow-up happened to ask for
  // whole files. This asks deliberately.
  const missed = buildApplyFollowUp([
    "Failed to apply src/storage.py: Search block not found in src/storage.py",
    "Failed to apply src/cli/parser.py: Search block not found in src/cli/parser.py",
  ].join("\n"), ["src/storage.py", "src/cli/parser.py", "main.py"]);

  check("it names both failed files",
    /src\/storage\.py/.test(missed) && /src\/cli\/parser\.py/.test(missed), missed);
  check("it asks for a whole-file overwrite", /mode "overwrite"/.test(missed), missed);
  check("it says not to retry search_replace",
    /[Dd]o not use search_replace/.test(missed), missed);
  check("it says the blocks did not match", /did not match/i.test(missed), missed);
  check("it carries the raw errors through", /Search block not found/.test(missed), missed);
  check("it lists the project's other files", /main\.py/.test(missed), missed);

  // The generic verification follow-up tells the model its code failed under
  // test and to fix the root cause. Nothing ran here, so that wording would
  // send it rewriting working logic over an addressing mistake.
  check("it does not claim a test failed", !/failed when tested|root cause/i.test(missed), missed);

  const abbrev = buildApplyFollowUp(
    "Failed to apply config.py: Refusing to overwrite config.py with an abbreviated file: it contains an \"unchanged\" placeholder", []);
  check("an abbreviated file gets its own reason", /placeholder/i.test(abbrev), abbrev);
  check("and is still asked for in full", /COMPLETE/.test(abbrev), abbrev);
  check("with no file list when nothing is known", !/Existing files in this project/.test(abbrev), abbrev);

  // An escape attempt is the one case where resending the same content is
  // right - only the path was wrong, so asking for an overwrite would be
  // answering the wrong question.
  const outside = buildApplyFollowUp(
    "Failed to apply /etc/passwd: Security Error: Attempted to write outside workspace: /etc/passwd", ["app.py"]);
  check("a path escape is explained as a path problem",
    /outside the project directory/.test(outside), outside);
  check("and asks for relative paths", /relative to the project root/.test(outside), outside);
  check("rather than for another overwrite", !/mode "overwrite"/.test(outside), outside);

  // Unparseable errors must still produce a usable instruction rather than
  // "these files: " with nothing after it.
  const vague = buildApplyFollowUp("something went wrong", ["a.py"]);
  check("an unrecognised error still asks for whole files",
    /the files for this step/.test(vague) && /mode "overwrite"/.test(vague), vague);
  check("empty input does not throw",
    typeof buildApplyFollowUp("", []) === "string" && buildApplyFollowUp(null, []).length > 0);

  // Long error dumps are truncated so the retry prompt stays smaller than the
  // reply it is asking for.
  const flood = buildApplyFollowUp("Failed to apply x.py: " + "e".repeat(9000), []);
  check("a huge error dump is capped", flood.length < 2500, String(flood.length));
}

function testStepSafety() {
  section("a step cannot silently drop names, and repairs see the files");
  const D = require(path.join(DIST, "context/defined-names.js"));
  const FU = require(path.join(DIST, "follow-up.js"));
  const R = require(path.join(DIST, "context/relevance.js"));
  const SP = require(path.join(DIST, "step-prompt.js"));
  const E = require(path.join(DIST, "verification/python-env.js"));

  // --- what a module defines ---
  const settings = "import os\n\nWIDTH = 800\nBRICK_SCORE: int = 10\n__all__ = []\n" +
    "class Colors:\n    RED = 1\n\ndef load():\n    return 1\nif WIDTH == 800:\n    pass\n";
  const names = D.topLevelNames(settings, "src/settings.py");
  check("python constants, classes and defs are names",
    ["WIDTH", "BRICK_SCORE", "Colors", "load"].every((n) => names.includes(n)), names.join(","));
  check("dunders and comparisons are not", !names.includes("__all__") && !names.includes("if"), names.join(","));
  check("a class attribute is not top-level", !names.includes("RED"), names.join(","));
  const js = D.topLevelNames("export const A = 1;\nexport async function b() {}\nmodule.exports = { c, d: 2 };\n", "x.js");
  check("js exports are names", ["A", "b", "c", "d"].every((n) => js.includes(n)), js.join(","));

  // --- the settings.py regression ---
  const after = "WIDTH = 800\nclass Colors:\n    RED = 1\n\ndef load():\n    return 1\n";
  const others = [
    { path: "src/game.py", content: "from src import settings\nprint(settings.BRICK_SCORE, settings.WIDTH)\n" },
    { path: "src/other.py", content: "import json\nBRICK_SCORE = 3\n" },
  ];
  const dropped = D.findDroppedNames("src/settings.py", settings, after, others);
  check("a dropped constant a caller uses is reported",
    dropped.length === 1 && dropped[0].name === "BRICK_SCORE" && dropped[0].usedIn.join() === "src/game.py",
    JSON.stringify(dropped));
  check("a file that does not import the module is not a caller",
    !dropped.some((d) => d.usedIn.includes("src/other.py")));
  const renamed = D.findDroppedNames("src/settings.py", settings, after.replace("WIDTH", "SCREEN_WIDTH"),
    [{ path: "src/game.py", content: "from src.settings import SCREEN_WIDTH, BRICK_SCORE_V2\n" }]);
  check("a rename with its callers updated is not flagged", renamed.length === 0, JSON.stringify(renamed));
  const commented = D.findDroppedNames("src/settings.py", settings, after,
    [{ path: "src/game.py", content: "from src import settings\n# used to use BRICK_SCORE\n" }]);
  check("a comment is not a use", commented.length === 0, JSON.stringify(commented));
  check("a new file has nothing to drop", D.findDroppedNames("a.py", null, "x = 1\n", others).length === 0);
  check("unknown languages are left alone", D.findDroppedNames("a.rb", "X = 1\n", "", others).length === 0);
  check("the description names file and caller",
    /src\/settings\.py[\s\S]*BRICK_SCORE \(used in src\/game\.py\)/.test(D.describeDroppedNames("src/settings.py", dropped)));

  // --- failure output keeps its summary ---
  const dump = "HEAD" + "x".repeat(8000) + "FAILED tests/test_level.py::test_x - AttributeError";
  const clipped = FU.clipOutput(dump, 2000);
  check("clipped output keeps the head", clipped.startsWith("HEAD"));
  check("and the pytest summary at the end", /FAILED tests\/test_level\.py::test_x/.test(clipped), clipped.slice(-200));
  check("and says how much was cut", /characters omitted/.test(clipped));
  check("short output is untouched", FU.clipOutput("abc", 10) === "abc");

  const named = FU.filesNamedInOutput(
    "tests/test_level.py:12: in test_x\nAttributeError: module 'src.settings' has no attribute 'BRICK_GAP'\n" +
    "tests/test_level.py:40: AttributeError",
    ["src/settings.py", "tests/test_level.py", "main.py"]);
  check("files are found by path and by module name",
    named.join() === "tests/test_level.py,src/settings.py", named.join());

  const rendered = FU.renderFiles([{ path: "a.py", content: "x = 1" }, { path: "big.py", content: "y".repeat(50) }], 20);
  check("rendered files use the reply's fence shape", /```python a\.py\nx = 1\n```/.test(rendered), rendered);
  check("files over budget are named, not cut", /Not shown, too large: big\.py/.test(rendered) && !/yyyy/.test(rendered));

  // --- the repair prompts ---
  const dn = FU.buildDroppedNamesFollowUp([{ path: "src/settings.py", names: dropped }],
    [{ path: "src/settings.py", content: settings }]);
  check("the dropped-names repair lists name and caller", /src\/settings\.py: BRICK_SCORE \(used in src\/game\.py\)/.test(dn), dn);
  check("and quotes the file as it was", /```python src\/settings\.py\n[\s\S]*BRICK_SCORE: int = 10/.test(dn));
  check("and restates the reply format", dn.includes(FU.REPLY_FORMAT_REMINDER));

  const tf = FU.buildTestFollowUp("AttributeError", ["src/settings.py"], [{ path: "src/settings.py", content: "WIDTH = 1\n" }]);
  check("the test repair quotes the implicated file", /```python src\/settings\.py\nWIDTH = 1/.test(tf), tf);
  check("and says to keep existing names", /Keep every name/.test(tf));
  const cf = FU.buildCommandFollowUp("python -m py_compile a.py", "SyntaxError: bad", ["a.py"], [{ path: "a.py", content: "def f(:\n" }]);
  check("the command repair carries command, error and file",
    /py_compile a\.py/.test(cf) && /SyntaxError: bad/.test(cf) && /```python a\.py/.test(cf), cf);
  check("the command repair caps its output",
    FU.buildCommandFollowUp("x", "e".repeat(20000), []).length < 4500);

  // --- the step prompt ---
  const wf = [
    { path: "src/settings.py", content: settings, mtimeMs: 1 },
    { path: "src/game.py", content: "x = 1\n", mtimeMs: 2 },
  ];
  const toEdit = R.selectFilesToEdit(wf, "Execute ONLY this step: levels. Expected files: src/settings.py, src/levels.py");
  check("expected files that exist are sent in full",
    toEdit.length === 1 && toEdit[0].path === "src/settings.py" && toEdit[0].content === settings, JSON.stringify(toEdit));
  check("no expected files, nothing in full", R.selectFilesToEdit(wf, "no list here").length === 0);
  check("the edit budget is respected", R.selectFilesToEdit(wf, "Expected files: src/settings.py", 10).length === 0);

  const sig = R.extractSignatures(settings, "src/settings.py");
  check("a python outline keeps module constants", /BRICK_SCORE: int = 10/.test(sig), sig);
  check("and a def that follows a class", /def load\(\)/.test(sig), sig);

  const first = SP.buildStepPrompt({
    task: "Overall: breakout. Execute ONLY this step: levels.",
    tree: "src/\n  settings.py", toEdit: toEdit,
    outlines: [{ path: "src/settings.py", content: sig }, { path: "src/game.py", content: "x = 1" }],
    newFiles: ["src/settings.py"], isFirstStep: true, testable: true,
    environmentNotes: ["requirements.txt FAILS here"], generatedFiles: ["README.md"],
  });
  check("the first prompt has the full format spec", /FORMAT A/.test(first) && /FORMAT B/.test(first));
  check("it says to keep names", first.includes(SP.KEEP_NAMES_RULE));
  check("the file being changed is quoted in full", /### Files this step changes[\s\S]*```python src\/settings\.py/.test(first));
  check("and not repeated as an outline", !/src\/settings\.py \(outline\)/.test(first));
  check("other files are labelled as outlines", /src\/game\.py \(outline\)/.test(first) && /NOT the full files/.test(first));
  check("environment notes are passed on", /### Environment on this machine\n- requirements\.txt FAILS here/.test(first));
  check("generated files are off limits", /DO NOT create or edit README\.md/.test(first));
  check("the task comes last", /### User request\nOverall: breakout\. Execute ONLY this step: levels\.$/.test(first));
  const next = SP.buildStepPrompt({ task: "do it", tree: "", toEdit: [], outlines: [], newFiles: ["b.py"], isFirstStep: false });
  check("a later prompt is short but keeps the rule",
    !/FORMAT A/.test(next) && next.includes(SP.KEEP_NAMES_RULE) && /### New files since the last step\n[\s\S]*- b\.py/.test(next), next);
  check("a later prompt ends with the step", /### Step\ndo it$/.test(next));

  // --- a pip failure, reduced to what matters ---
  const pip = [
    "Collecting pygame==2.5.2", "  error: subprocess-exited-with-error",
    "  × Getting requirements to build wheel did not run successfully.",
    "ERROR: Failed to build 'pygame' when getting requirements to build wheel",
    "ERROR: Failed to build 'pygame' when getting requirements to build wheel",
  ].join("\n");
  const sum = E.summarizeInstallFailure(pip);
  check("the pip summary keeps the real error", /Failed to build 'pygame'/.test(sum), sum);
  check("once", sum.split("Failed to build").length === 2, sum);
  check("without the subprocess noise", !/subprocess-exited-with-error/.test(sum), sum);
  check("an empty install log does not throw", typeof E.summarizeInstallFailure("") === "string");
}

async function run(c, s, sk) {
  check = c; section = s; skipped = sk;
  testEditPlanParsing();
  testPlanParsing();
  testDelta();
  testDiff();
  testDependsOnNumbering();
  testRobustFileParsing();
  testSearchBlockMatching();
  testAbbreviationGuard();
  testRelevance();
  testPatchApplier();
  testParseSweep();
  testApplyFollowUp();
  testStepSafety();
}

module.exports = { run };
