/*
 * The coding agent (src/agent): protocol, tools, permissions and the loop.
 *
 * The loop runs against a scripted session - a list of replies standing in for
 * the model - so every path is exercised without a browser: tool calls,
 * permission answers, plan mode, interrupts, rewinds and the step limit. The
 * browser path is covered end to end in run-e2e.cjs.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const DIST = path.join(__dirname, "..", "dist");
const T = "```";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "closeni-agent-")); }

function script(replies) {
  const prompts = [];
  let n = 0;
  return {
    prompts: prompts,
    resets: 0,
    ask: async function (p) {
      prompts.push(p);
      const r = replies[Math.min(n, replies.length - 1)];
      n++;
      if (r instanceof Error) throw r;
      return typeof r === "function" ? r(p) : r;
    },
    reset: async function () { this.resets++; },
  };
}

function tool(obj, payload) {
  return T + "tool\n" + JSON.stringify(obj) + (payload !== undefined ? "\n---\n" + payload : "") + "\n" + T;
}

async function run(check, section) {
  const P = require(path.join(DIST, "agent/protocol.js"));
  const { stoppedShort } = P;
  const Tl = require(path.join(DIST, "agent/tools.js"));
  const Pm = require(path.join(DIST, "agent/permissions.js"));
  const { AgentLoop, expandMentions, loadMemory } = require(path.join(DIST, "agent/loop.js"));

  section("agent: reading tool calls out of a reply");
  let r = P.parseReply("I'll look first.\n\n" + tool({ tool: "read", path: "src/app.py" }) + "\n");
  check("a labelled block is a call", r.calls.length === 1 && r.calls[0].tool === "read" && r.calls[0].input.path === "src/app.py");
  check("the prose is kept and the block removed", r.text === "I'll look first.");
  r = P.parseReply(T + "\n{\"tool\": \"ls\"}\n" + T);
  check("an unlabelled block that names a tool is a call", r.calls.length === 1 && r.calls[0].tool === "ls");
  r = P.parseReply(T + "json\n{\"name\": \"server\", \"version\": \"1.0.0\"}\n" + T + "\n\n" + T + "python\nprint({'tool': 'x'})\n" + T);
  check("a package.json snippet is not a call", r.calls.length === 0 && r.text.indexOf("server") !== -1);
  r = P.parseReply(T + "json\n{\"tool\": \"bash\", \"command\": \"npm test\"}\n" + T);
  check("an unlabelled block with an explicit tool key is", r.calls.length === 1 && r.calls[0].input.command === "npm test");
  r = P.parseReply(tool({ tool: "write", path: "a.py" }, "print(\"a \\\"quoted\\\" string\")\nx = {'k': 1}"));
  check("write carries its payload verbatim", r.calls[0].content === "print(\"a \\\"quoted\\\" string\")\nx = {'k': 1}", JSON.stringify(r.calls[0]));
  check("and the payload is not left in the input", r.calls[0].input.content === undefined);
  r = P.parseReply("````tool\n{\"tool\":\"write\",\"path\":\"README.md\"}\n---\n# Title\n\n```sh\nnpm start\n```\n````");
  check("a longer fence carries code fences inside it", r.calls.length === 1 && r.calls[0].content.indexOf("```sh") !== -1);
  r = P.parseReply(tool({ tool: "write", path: "README.md" }, "# Title\n\n```sh\nnpm start") + "\n\nThen open the browser.\n```");
  check("a write cut short by its own inner fence is refused, not written", P.isBad(r.calls[0]) && /README\.md/.test(r.calls[0].error) && /four backticks/.test(r.calls[0].error), JSON.stringify(r.calls[0]));
  r = P.parseReply(tool({ tool: "write", path: "a.md" }, "```\none\n```\n\n````js\ntwo\n````\n```not a ``` fence"));
  check("balanced inner fences, and a line that is not a fence, pass", r.calls.length === 1 && !P.isBad(r.calls[0]), JSON.stringify(r.calls[0]));
  r = P.parseReply(tool({ tool: "edit", path: "README.md" }, "<<<<<<< SEARCH\nold\n=======\n## Run\n\n```sh\nnpm start"));
  check("an edit whose REPLACE was cut short the same way is refused", P.isBad(r.calls[0]) && /four backticks/.test(r.calls[0].error), JSON.stringify(r.calls[0]));
  r = P.parseReply(tool({ tool: "edit", path: "README.md" }, "<<<<<<< SEARCH\n```sh\nnpm start\n=======\n```sh\nnpm run dev\n>>>>>>> REPLACE"));
  check("an edit quoting half a code block is fine", r.calls.length === 1 && !P.isBad(r.calls[0]) && r.calls[0].edits[0].replace === "```sh\nnpm run dev", JSON.stringify(r.calls[0]));
  r = P.parseReply(tool({ tool: "edit", path: "a.py" }, "<<<<<<< SEARCH\nx = 1\n=======\nx = 2\n>>>>>>> REPLACE\n<<<<<<< SEARCH\ny = 1\n=======\ny = 3\n>>>>>>> REPLACE"));
  check("edit reads several search/replace sections", r.calls[0].edits.length === 2 && r.calls[0].edits[1].replace === "y = 3");
  r = P.parseReply(tool({ tool: "str_replace", path: "a.py", old_string: "a", new_string: "b" }));
  check("the usual aliases and JSON edit fields work", r.calls[0].tool === "edit" && r.calls[0].edits[0].search === "a" && r.calls[0].edits[0].replace === "b");
  r = P.parseReply(T + "tool\n{\n  \"tool\": \"grep\",\n  \"pattern\": \"TODO\"\n}\n" + T);
  check("a pretty-printed header parses", r.calls[0].tool === "grep" && r.calls[0].input.pattern === "TODO");
  r = P.parseReply(T + "tool\n{\"tool\": \"read\", \"path\": \"x\"}");
  check("an unclosed block at the end is still read", r.calls.length === 1);
  r = P.parseReply("~~~tool\n{\"tool\": \"ls\"}\n~~~");
  check("tilde fences work", r.calls.length === 1);
  r = P.parseReply(T + "tool\nread the file please\n" + T + "\n" + tool({ tool: "delete", path: "x" }) + "\n" + tool({ tool: "write", path: "x" }));
  check("a labelled block with no JSON is reported, not run", P.isBad(r.calls[0]) && /tool/.test(r.calls[0].error));
  check("an unknown tool is reported with the list", P.isBad(r.calls[1]) && /Tools: read/.test(r.calls[1].error));
  check("a write with no content is reported", P.isBad(r.calls[2]) && /---/.test(r.calls[2].error));
  r = P.parseReply(tool({ tool: "run", input: { command: "ls -la" } }));
  check("arguments nested under input are read", r.calls[0].tool === "bash" && r.calls[0].input.command === "ls -la");
  check("a fence outgrows backticks in its content", P.fenceFor("a ``` b") === "````" && P.fenceFor("plain") === "```");
  const msg = P.formatResults([{ call: { tool: "bash", input: { command: "npm test" } }, ok: false, summary: "failed", output: "boom ``` x" }]);
  check("results name the call and fence its output safely", /\[1\] bash `npm test` - failed/.test(msg) && msg.indexOf("````\nboom") !== -1);
  const pre = P.preamble({ workspace: "/w", platform: "linux", mode: "plan", memory: "Use tabs." });
  check("the preamble teaches the format, the mode and the memory", /```tool/.test(pre) && /PLAN MODE/.test(pre) && /Use tabs\./.test(pre));
  check("the preamble says to lengthen the fence around a payload with its own fences", /four backticks instead: ````tool/.test(pre));

  section("agent: tools stay inside the project");
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "src"));
  fs.writeFileSync(path.join(ws, "src", "app.py"), "import os\nx = 1   \ny = 2\nx = 1\n");
  const outside = tmp();
  fs.writeFileSync(path.join(outside, "secret.txt"), "s");
  let threw = null;
  try { Tl.resolveInside(ws, "../x"); } catch (e) { threw = e; }
  check("../ is refused", threw && /outside the project/.test(threw.message));
  threw = null;
  try { Tl.resolveInside(ws, "/etc/passwd"); } catch (e) { threw = e; }
  check("an absolute path outside is refused", !!threw);
  try { fs.symlinkSync(outside, path.join(ws, "link")); } catch (e) { /* no symlinks here */ }
  threw = null;
  if (fs.existsSync(path.join(ws, "link"))) {
    try { Tl.resolveInside(ws, "link/secret.txt"); } catch (e) { threw = e; }
    check("a symlink out of the project is refused", threw && /link/.test(threw.message));
    fs.unlinkSync(path.join(ws, "link"));
  }
  check("an absolute path inside is fine", Tl.resolveInside(ws, path.join(ws, "src", "app.py")) === path.join(ws, "src", "app.py"));

  const ctx = { workspace: ws, todos: [] };
  const call = (o, extra) => Object.assign({ tool: o.tool, input: o }, extra || {});
  let o = await Tl.runTool(call({ tool: "read", path: "src/app.py" }), ctx);
  check("read numbers the lines", o.ok && /^\s+1\timport os/.test(o.output) && o.summary === "read 4 lines", o.output);
  o = await Tl.runTool(call({ tool: "read", path: "src/app.py", offset: 2, limit: 1 }), ctx);
  check("read honours offset and limit and says there is more", /^\s+2\tx = 1/.test(o.output) && /offset 3/.test(o.output), o.output);
  o = await Tl.runTool(call({ tool: "read", path: "nope.py" }), ctx);
  check("a missing file is an error the model can read", !o.ok && /does not exist/.test(o.output));
  o = await Tl.runTool(call({ tool: "read", path: "src" }), ctx);
  check("reading a directory points at ls", !o.ok && /use ls/.test(o.output));
  fs.writeFileSync(path.join(ws, "img.bin"), Buffer.from([0, 1, 2, 0]));
  o = await Tl.runTool(call({ tool: "read", path: "img.bin" }), ctx);
  check("a binary file is described, not dumped", o.ok && /binary/.test(o.summary));

  const changed = [];
  const ctx2 = { workspace: ws, todos: [], beforeChange: (a) => changed.push(a) };
  o = await Tl.runTool(call({ tool: "write", path: "pkg/new/mod.py" }, { content: "a = 1" }), ctx2);
  check("write creates folders and ends the file with a newline", o.ok && fs.readFileSync(path.join(ws, "pkg/new/mod.py"), "utf-8") === "a = 1\n");
  check("and says it created it", /created pkg\/new\/mod\.py/.test(o.summary) && o.detail.created === true);
  check("the change is announced before it happens", changed.length === 1);
  o = await Tl.runTool(call({ tool: "write", path: ".git/config" }, { content: "x" }), ctx2);
  check(".git is not written", !o.ok && /\.git/.test(o.output));

  o = await Tl.runTool(call({ tool: "edit", path: "src/app.py" }, { edits: [{ search: "y = 2", replace: "y = 3" }] }), ctx2);
  check("edit replaces a unique match", o.ok && /y = 3/.test(fs.readFileSync(path.join(ws, "src/app.py"), "utf-8")) && /\+1 -1/.test(o.summary));
  o = await Tl.runTool(call({ tool: "edit", path: "src/app.py" }, { edits: [{ search: "x = 1", replace: "x = 9" }] }), ctx2);
  check("an ambiguous match is refused with a count", !o.ok && /matches 2 places/.test(o.output), o.output);
  o = await Tl.runTool(call({ tool: "edit", path: "src/app.py", replace_all: true }, { edits: [{ search: "x = 1", replace: "x = 9" }] }), ctx2);
  check("replace_all changes every match", o.ok && (fs.readFileSync(path.join(ws, "src/app.py"), "utf-8").match(/x = 9/g) || []).length === 2);
  fs.writeFileSync(path.join(ws, "ws.py"), "def f():   \n    return 1  \n");
  o = await Tl.runTool(call({ tool: "edit", path: "ws.py" }, { edits: [{ search: "def f():\n    return 1", replace: "def f():\n    return 2" }] }), ctx2);
  check("trailing whitespace the page dropped does not break a match", o.ok && /return 2/.test(fs.readFileSync(path.join(ws, "ws.py"), "utf-8")), o.output);
  o = await Tl.runTool(call({ tool: "edit", path: "src/app.py" }, { edits: [{ search: "nowhere", replace: "x" }] }), ctx2);
  check("a missing match says to read again", !o.ok && /not found/.test(o.output));
  o = await Tl.runTool(call({ tool: "edit", path: "ghost.py" }, { edits: [{ search: "a", replace: "b" }] }), ctx2);
  check("editing a missing file points at write", !o.ok && /use write/.test(o.output));

  o = await Tl.runTool(call({ tool: "bash", command: "echo hi" }), Object.assign({}, ctx, {
    run: async (cmd, cwd) => ({ success: true, output: "ran " + cmd + " in " + path.basename(cwd), timedOut: false }),
  }));
  check("bash runs in the workspace", o.ok && o.output === "ran echo hi in " + path.basename(ws) && o.summary === "exit 0");
  o = await Tl.runTool(call({ tool: "bash", command: "node -e \"process.stdout.write('real'); process.exit(3)\"" }), ctx);
  check("a real failing command reports its output and failure", !o.ok && /real/.test(o.output) && o.summary === "failed", JSON.stringify(o));
  if (process.platform !== "win32" && fs.existsSync("/bin/bash")) {
    o = await Tl.runTool(call({ tool: "bash", command: "node -e \"process.exit(2)\" | cat" }), ctx);
    check("a failing stage fails the whole pipeline", !o.ok && o.summary === "failed", JSON.stringify(o));
    o = await Tl.runTool(call({ tool: "bash", command: "yes | head -n 1" }), ctx);
    check("a stage stopped early by head is not a failure", o.ok && o.output === "y", JSON.stringify(o));
  }
  const CR = require(path.join(DIST, "verification/command-runner.js"));
  if (process.platform !== "win32") {
    // A command is stopped whole - not just its shell, which left the rest
    // running and holding the pipe, so the call never came back.
    const gone = (pid) => { try { process.kill(-pid, 0); return false; } catch { return true; } };
    const settle = () => new Promise((r) => setTimeout(r, 200));
    let t0 = Date.now();
    o = await Tl.runTool(call({ tool: "bash", command: "echo $$ > group.pid; sleep 30 | cat", timeout: 1 }), ctx);
    const g1 = Number(fs.readFileSync(path.join(ws, "group.pid"), "utf-8"));
    await settle();
    check("a pipeline past its timeout comes back on time", o.detail.timedOut && Date.now() - t0 < 5000 && /^stopped after 1s/.test(o.summary), (Date.now() - t0) + "ms " + o.summary);
    check("and nothing it started is left running", gone(g1));
    t0 = Date.now();
    o = await Tl.runTool(call({ tool: "bash", command: "echo $$ > group.pid; sleep 30 & echo started" }), ctx);
    const g2 = Number(fs.readFileSync(path.join(ws, "group.pid"), "utf-8"));
    check("a command that backgrounds a server returns when its shell does", o.ok && o.output === "started" && Date.now() - t0 < 3000, (Date.now() - t0) + "ms " + JSON.stringify(o.output));
    check("and the server keeps running for later commands", !gone(g2));
    check("closing the session stops it", CR.stopBackground() === 1 && (await settle(), gone(g2)));
    t0 = Date.now();
    const pending = Tl.runTool(call({ tool: "bash", command: "echo $$ > group.pid; echo partial; sleep 30" }), ctx);
    await settle();
    check("Esc stops the command in flight", CR.stopRunning() === 1);
    o = await pending;
    const g3 = Number(fs.readFileSync(path.join(ws, "group.pid"), "utf-8"));
    await settle();
    check("which returns what it printed, as a failure, straight away", !o.ok && /partial/.test(o.output) && /stopped by the user/.test(o.output) && Date.now() - t0 < 3000, (Date.now() - t0) + "ms " + o.output);
    check("and leaves nothing behind", gone(g3));
    fs.unlinkSync(path.join(ws, "group.pid"));
  }
  // What the model receives for a flood: both ends, and an honest count of
  // the lines between, across the runner's cut and the tool's.
  o = await Tl.runTool(call({ tool: "bash", command: "node -e \"for (let i = 0; i < 200000; i++) console.log('line ' + i)\"" }), ctx);
  (function () {
    const m = /\[\.\.\. (\d+) lines, \d+ characters omitted \.\.\.\]/.exec(o.output);
    const shown = o.output.split("\n").filter((l) => /^line \d+$/.test(l)).length;
    check("a flood of output keeps its first and last lines", o.ok && /^line 0\n/.test(o.output) && /\nline 199999$/.test(o.output), o.output.slice(-80));
    check("and says how many lines it left out, in total", !!m && Number(m[1]) + shown === 200000, m && m[0] + " + " + shown);
    check("and fits the model's budget", o.output.length <= Tl.MAX_OUTPUT + 100, o.output.length);
    const kept = new CR.KeptOutput(200);
    for (let i = 0; i < 1000; i++) kept.add("n " + i + "\n");
    const k = kept.text();
    const km = /\[\.\.\. (\d+) lines/.exec(k);
    const kshown = k.split("\n").filter((l) => /^n \d+$/.test(l)).length;
    check("the runner keeps whole lines at both ends of a stream and counts the rest", !!km && Number(km[1]) + kshown === 1000 && /^n 0\n/.test(k) && /\nn 999\n$/.test(k), k.slice(0, 60) + " ... " + k.slice(-60));
  })();
  o = await Tl.runTool(call({ tool: "bash", command: "  " }), ctx);
  check("an empty command is an error", !o.ok);

  fs.mkdirSync(path.join(ws, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(ws, "node_modules", "dep", "index.ts"), "x");
  fs.writeFileSync(path.join(ws, "src", "a.ts"), "export const TODO = 1;\n// todo: later\n");
  fs.mkdirSync(path.join(ws, "src", "deep"));
  fs.writeFileSync(path.join(ws, "src", "deep", "b.ts"), "const y = 2;\n");
  o = await Tl.runTool(call({ tool: "glob", pattern: "*.ts" }), ctx);
  check("a bare glob matches at any depth, skipping node_modules", o.ok && o.detail.total === 2 && o.output.indexOf("node_modules") === -1, o.output);
  o = await Tl.runTool(call({ tool: "glob", pattern: "src/**/*.{ts,py}" }), ctx);
  check("** and braces work", o.detail.total === 3, o.output);
  check("globToRegExp anchors", Tl.globToRegExp("src/*.ts").test("src/a.ts") && !Tl.globToRegExp("src/*.ts").test("src/deep/b.ts"));
  o = await Tl.runTool(call({ tool: "grep", pattern: "todo", ignore_case: true, glob: "*.ts" }), ctx);
  check("grep finds lines, case-insensitively, within a glob", o.ok && o.detail.matches === 2 && /src\/a\.ts:1:/.test(o.output), o.output);
  o = await Tl.runTool(call({ tool: "grep", pattern: "(" }), ctx);
  check("a bad regex is an error, not a crash", !o.ok && /regular expression/.test(o.output));
  o = await Tl.runTool(call({ tool: "ls" }), ctx);
  check("ls lists directories first", o.ok && o.output.split("\n")[0].endsWith("/"));
  const tctx = { workspace: ws, todos: [] };
  o = await Tl.runTool(call({ tool: "todo", items: [{ text: "a", status: "completed" }, { content: "b", status: "in progress" }, { text: "c" }, { text: "" }] }), tctx);
  check("todo normalises statuses and drops empty items", o.ok && tctx.todos.length === 3 && tctx.todos[0].status === "done" && tctx.todos[1].status === "in_progress" && tctx.todos[2].status === "pending");
  o = await Tl.runTool({ error: "bad json", raw: "{" }, ctx);
  check("a bad block becomes an error outcome", !o.ok && /bad json/.test(o.output));
  check("cap keeps both ends", (function () { const c = Tl.cap("a".repeat(5000) + "END", 1000); return c.length < 1200 && c.endsWith("END") && /omitted/.test(c); })());
  (function () {
    const text = Array.from({ length: 100 }, (_, i) => "row " + i + " " + "x".repeat(40)).join("\n");
    const c = Tl.cap(text, 1000);
    const m = /\[\.\.\. (\d+) lines, \d+ characters omitted/.exec(c);
    const rows = c.split("\n").filter((l) => /^row \d+ x+$/.test(l)).length;
    check("cap cuts on line ends and counts the lines it drops", !!m && Number(m[1]) + rows === 100, c);
    const again = Tl.cap(c, 400);
    const m2 = /\[\.\.\. (\d+) lines/.exec(again);
    const rows2 = again.split("\n").filter((l) => /^row \d+ x+$/.test(l)).length;
    check("a second cut adds up what the first dropped", !!m2 && Number(m2[1]) + rows2 === 100, again);
  })();
  fs.writeFileSync(path.join(ws, "wide.txt"), Array.from({ length: 2000 }, (_, i) => "w".repeat(100) + i).join("\n") + "\n");
  o = await Tl.runTool(call({ tool: "read", path: "wide.txt" }), ctx);
  (function () {
    const next = /read again with offset (\d+)/.exec(o.output);
    const last = /^\s*(\d+)\t/.exec(o.output.split("\n").filter((l) => /^\s*\d+\t/.test(l)).pop() || "");
    check("a long read stops at a whole line, not in the middle", o.ok && !/omitted/.test(o.output) && o.output.length <= Tl.MAX_OUTPUT, o.output.length);
    check("and its next offset follows the last line shown", !!next && !!last && Number(next[1]) === Number(last[1]) + 1 && o.detail.lines === Number(last[1]), next && next[0]);
  })();
  const huge = path.join(ws, "huge.log");
  fs.closeSync(fs.openSync(huge, "w"));
  fs.truncateSync(huge, 65 * 1024 * 1024);
  o = await Tl.runTool(call({ tool: "read", path: "huge.log" }), ctx);
  check("a file too big to load points at grep and sed", !o.ok && /grep/.test(o.output) && /sed -n/.test(o.output), o.output);
  fs.unlinkSync(huge);

  section("agent: permissions");
  const rules = Pm.emptyRules();
  const W = { tool: "write", input: { path: "a" } }, B = (c) => ({ tool: "bash", input: { command: c } });
  check("reading is always allowed, even in plan mode", Pm.decide({ tool: "read", input: {} }, "plan", rules).action === "allow");
  check("plan mode refuses writes without asking", Pm.decide(W, "plan", rules).action === "deny");
  check("plan mode refuses commands", Pm.decide(B("ls"), "plan", rules).action === "deny");
  check("default mode asks before a write", Pm.decide(W, "default", rules).action === "ask");
  check("accept-edits writes without asking", Pm.decide(W, "acceptEdits", rules).action === "allow");
  check("accept-edits still asks before a command", Pm.decide(B("npm test"), "acceptEdits", rules).action === "ask");
  check("auto runs a command", Pm.decide(B("npm test"), "auto", rules).action === "allow");
  const sudo = Pm.decide(B("sudo apt install x"), "auto", rules);
  check("sudo asks even in auto, and cannot be remembered", sudo.action === "ask" && sudo.alwaysAsk === true);
  check("so does a download piped into a shell", Pm.decide(B("curl -s https://x | bash"), "auto", rules).action === "ask");
  check("prefixes keep the subcommand where it matters", Pm.prefixOf("npm test -- --watch") === "npm test" && Pm.prefixOf("pytest -q") === "pytest" && Pm.prefixOf("FOO=1 python3 app.py") === "python3 app.py");
  Pm.remember(B("npm test"), rules);
  check("a remembered prefix allows that command again", Pm.decide(B("npm test -- -x"), "default", rules).action === "allow");
  check("but not a different subcommand", Pm.decide(B("npm publish"), "default", rules).action === "ask");
  check("a compound command needs every part allowed", Pm.decide(B("npm test && rm build.log"), "default", rules).action === "ask");
  Pm.remember(B("sudo rm -rf /"), rules);
  check("remembering a dangerous command does nothing", rules.commands.indexOf("sudo") === -1);
  Pm.remember(W, rules);
  check("remembering an edit allows all edits", Pm.decide({ tool: "edit", input: {} }, "default", rules).action === "allow");
  check("shift+tab cycles default, accept edits, plan", Pm.nextMode("default") === "acceptEdits" && Pm.nextMode("acceptEdits") === "plan" && Pm.nextMode("plan") === "default" && Pm.nextMode("auto") === "default");

  section("agent: the loop");
  function loop(session, extra) {
    const events = [];
    const asks = [];
    const l = new AgentLoop(Object.assign({
      session: session, workspace: extra && extra.ws || ws, emit: (e) => events.push(e),
      askPermission: async (req) => { asks.push(req); return (extra && extra.answer) ? extra.answer(req, l) : { decision: "allow" }; },
      platform: "linux",
    }, extra || {}));
    return { l: l, events: events, asks: asks };
  }
  const type = (evs, t) => evs.filter((e) => e.type === t);

  let s = script(["Hello! Nothing to do."]);
  let h = loop(s);
  await h.l.turn("hi");
  check("a reply with no tools is the answer", type(h.events, "assistant")[0].text === "Hello! Nothing to do." && type(h.events, "done")[0].reason === "complete");
  check("the first message carries the preamble", /You are CloseNI/.test(s.prompts[0]) && /User request:\nhi/.test(s.prompts[0]));
  await h.l.turn("again");
  check("later messages do not repeat it", !/You are CloseNI/.test(s.prompts[1]) && /^User: again/.test(s.prompts[1]) && /```tool blocks/.test(s.prompts[1]));

  const ws2 = tmp();
  fs.writeFileSync(path.join(ws2, "calc.py"), "def add(a, b):\n    return a - b\n");
  s = script([
    "Let me look.\n" + tool({ tool: "read", path: "calc.py" }),
    tool({ tool: "edit", path: "calc.py" }, "<<<<<<< SEARCH\n    return a - b\n=======\n    return a + b\n>>>>>>> REPLACE") + "\n" + tool({ tool: "bash", command: "python3 -c \"print(1)\"" }),
    "Fixed: add now adds.",
  ]);
  h = loop(s, { ws: ws2, run: async () => ({ success: true, output: "1", timedOut: false }) });
  await h.l.turn("fix the bug in @calc.py");
  check("an @mention attaches the file", /Contents of calc\.py:/.test(s.prompts[0]) && /return a - b/.test(s.prompts[0]));
  check("read ran without asking", h.asks.every((a) => a.tool !== "read"));
  check("the edit and the command each asked", h.asks.map((a) => a.tool).join() === "edit,bash");
  check("the edit's question carries a diff preview", h.asks[0].preview.after.indexOf("return a + b") !== -1 && h.asks[0].preview.before.indexOf("return a - b") !== -1);
  check("the file was changed", /return a \+ b/.test(fs.readFileSync(path.join(ws2, "calc.py"), "utf-8")));
  check("the read's result went back to the model", /Tool results \(1\)/.test(s.prompts[1]) && /return a - b/.test(s.prompts[1]));
  check("the edit and command results went back together", /Tool results \(2\)/.test(s.prompts[2]) && /updated calc\.py/.test(s.prompts[2]));
  check("the turn ends on the final answer", type(h.events, "assistant").pop().text === "Fixed: add now adds." && type(h.events, "done").pop().reason === "complete");
  check("each tool is reported running then done", type(h.events, "tool").filter((e) => e.name === "edit").map((e) => e.status).join() === "waiting,running,done");
  check("a rewind is on offer", type(h.events, "done").pop().canRewind === true);

  const files = h.l.rewind();
  check("rewind restores the file", files.join() === "calc.py" && /return a - b/.test(fs.readFileSync(path.join(ws2, "calc.py"), "utf-8")));
  s.prompts.length = 0;
  await h.l.turn("ok");
  check("and the model hears about it next time", /reverted every file change/.test(s.prompts[0]));

  const ws3 = tmp();
  s = script([tool({ tool: "write", path: "a.txt" }, "A") + "\n" + tool({ tool: "write", path: "b.txt" }, "B"), "done"]);
  h = loop(s, { ws: ws3, answer: () => ({ decision: "deny", feedback: "use a single file" }) });
  await h.l.turn("make files");
  check("a declined call ends the turn", type(h.events, "done").pop().reason === "denied" && s.prompts.length === 1);
  check("nothing after it ran", !fs.existsSync(path.join(ws3, "a.txt")) && !fs.existsSync(path.join(ws3, "b.txt")));
  await h.l.turn("fine, one file please");
  check("the next message says what was declined and why", /declined this\. They said: use a single file/.test(s.prompts[1]));

  const ws4 = tmp();
  s = script([tool({ tool: "write", path: "a.txt" }, "A"), tool({ tool: "write", path: "b.txt" }, "B"), "done"]);
  h = loop(s, { ws: ws4, answer: () => ({ decision: "always" }) });
  await h.l.turn("write two");
  check("\"don't ask again\" covers later edits", h.asks.length === 1 && fs.existsSync(path.join(ws4, "b.txt")));
  const created = h.l.rewind();
  check("rewinding removes files the turn created", created.length === 2 && !fs.existsSync(path.join(ws4, "a.txt")));

  s = script([tool({ tool: "write", path: "p.txt" }, "x") + "\n" + tool({ tool: "grep", pattern: "x" }), "Plan:\n1. Do it"]);
  h = loop(s, { ws: ws4, mode: "plan" });
  await h.l.turn("plan it");
  check("plan mode refuses a write without asking, and still reads", h.asks.length === 0 && !fs.existsSync(path.join(ws4, "p.txt")) && /Not run: plan mode/.test(s.prompts[1]) && /Tool results \(2\)/.test(s.prompts[1]));
  h.l.setMode("default");
  await h.l.turn("go ahead");
  check("switching mode is announced on the next message", /Plan mode is off/.test(s.prompts[2]));
  check("the mode change is an event", type(h.events, "mode").pop().mode === "default");

  s = script([tool({ tool: "ls" })]);
  h = loop(s, { ws: ws4, maxSteps: 4 });
  await h.l.turn("loop forever");
  check("the step limit stops a runaway turn", type(h.events, "done").pop().reason === "step-limit" && s.prompts.length === 4);

  s = script([tool({ tool: "write", path: "i1.txt" }, "1") + "\n" + tool({ tool: "write", path: "i2.txt" }, "2"), "never"]);
  h = loop(s, { ws: ws4, answer: (req, l) => { l.interrupt(); return { decision: "allow" }; } });
  await h.l.turn("go");
  check("an interrupt stops before the next call", type(h.events, "done").pop().reason === "interrupted" && fs.existsSync(path.join(ws4, "i1.txt")) && !fs.existsSync(path.join(ws4, "i2.txt")));

  s = script(["", "x"]);
  h = loop(s, { ws: ws4 });
  await h.l.turn("hello");
  check("an empty reply is an error, not an answer", type(h.events, "done").pop().reason === "error" && /No reply/.test(type(h.events, "done").pop().error));
  s = script([new Error("browser closed")]);
  h = loop(s, { ws: ws4 });
  await h.l.turn("hello");
  check("a transport failure ends the turn with its reason", type(h.events, "done").pop().error === "browser closed" && !h.l.busy);

  section("agent: a reply that stopped short");
  check("an announced next step is caught", /nothing was run/.test(stoppedShort("I read the file. Now I'll update src/ball.py to fix the bounce:")));
  check("so is 'let me' without a colon", /nothing was run/.test(stoppedShort("The tests fail on collisions.\n\nLet me check the tests to see why.")));
  check("the nudge quotes the last line", /update src\/ball\.py/.test(stoppedShort("Now I'll update src/ball.py:")));
  check("a finished summary is left alone", stoppedShort("Done. I fixed the bounce in src/ball.py and all 42 tests now pass.") === "");
  check("'let me know' is not an action", stoppedShort("Fixed it. Let me know if you want the speed changed.") === "");
  check("a question is left alone", stoppedShort("Should the paddle speed scale with the level?") === "");
  check("a colon inside a code block does not count", stoppedShort("Run it with:\n```\n./run.sh\n```") === "");
  const pastedFile = "Here is the corrected src/ball.py:\n```python\nclass Ball:\n    def __init__(self):\n        self.dy = 1\n    def bounce(self):\n        self.dy = -self.dy\n```\nThis fixes the bounce.";
  check("a file pasted as a plain block is nudged toward write/edit", /write \(whole file\)/.test(stoppedShort(pastedFile)));
  check("a short snippet is not", stoppedShort("Use `self.dy = -self.dy` in ball.py:\n```python\nself.dy = -self.dy\n```\nThat is all.") === "");
  check("a terminal session naming a file is not", stoppedShort("Demo output\n```\n$ python3 todo.py add \"buy milk\"\nAdded: buy milk\n\n$ python3 todo.py list\n1. [ ] buy milk\n2. [x] write report\n```\nAll working.") === "");
  check("a long block with no file name is not",stoppedShort("Example:\n```\na\nb\nc\nd\ne\n```\nThat's it.") === "");

  const ws5 = tmp();
  s = script(["Now I'll create hello.py:", tool({ tool: "write", path: "hello.py" }, "print(1)"), "Done.", "Done."]);
  let finals = [];
  h = loop(s, { ws: ws5, answer: () => ({ decision: "allow" }), checkFinal: async (r) => { finals.push(r); return stoppedShort(r); } });
  await h.l.turn("make hello");
  check("an unfinished reply gets one nudge instead of ending the turn", /nothing was run/.test(s.prompts[1]) && fs.existsSync(path.join(ws5, "hello.py")));
  check("the answer after the tools is not nudged again", finals.length === 1 && type(h.events, "done").pop().reason === "complete" && s.prompts.length === 3);
  s = script(["Now I'll create hello.py:", tool({ tool: "write", path: "hello.py" }, "print(1)"), "Done.", T + "tool\nnot json\n" + T, "Done."]);
  h = loop(s, { ws: ws5, answer: () => ({ decision: "allow" }), checkFinal: async (r) => stoppedShort(r) });
  await h.l.turn("make hello");
  await h.l.turn("again");
  (function () {
    const d = type(h.events, "done").pop().drift;
    check("each turn reports how often replies broke the tool convention, and where", d && d.replies === 5 && d.missing === 1 && d.malformed === 1 && JSON.stringify(d.at) === "[1,4]", JSON.stringify(d));
  })();
  await h.l.clear();
  check("a new conversation starts the count again", h.l.drift.replies === 0 && h.l.drift.at.length === 0);
  s = script(["I'll do it:", "I'll do it:", "I'll do it:"]);
  finals = [];
  h = loop(s, { ws: ws5, checkFinal: async (r) => { finals.push(r); return "go on"; } });
  await h.l.turn("x");
  check("the nudge is sent at most once a turn", finals.length === 1 && s.prompts.length === 2 && type(h.events, "done").pop().reason === "complete");
  s = script(["Plan:\n1. I'll edit a.py", "x"]);
  finals = [];
  h = loop(s, { ws: ws5, mode: "plan", checkFinal: async (r) => { finals.push(r); return "go on"; } });
  await h.l.turn("plan");
  check("plan mode's prose answer is never nudged", finals.length === 0 && s.prompts.length === 1);
  s = script(["I'll do it:", "x"]);
  h = loop(s, { ws: ws5, checkFinal: async () => { throw new Error("broken check"); } });
  await h.l.turn("x");
  check("a failing check leaves the reply as the answer", s.prompts.length === 1 && type(h.events, "done").pop().reason === "complete");

  s = script([T + "tool\nnot json\n" + T, "ok"]);
  h = loop(s, { ws: ws4 });
  await h.l.turn("x");
  check("a malformed block is reported back so the model can retry", /Could not use this tool block/.test(s.prompts[1]) && type(h.events, "tool")[0].status === "error");

  fs.writeFileSync(path.join(ws4, "CLOSENI.md"), "Always answer in French.");
  s = script(["ok", "ok"]);
  h = loop(s, { ws: ws4 });
  await h.l.turn("x");
  check("CLOSENI.md is read into the first message", /Always answer in French/.test(s.prompts[0]));
  check("loadMemory names the file", loadMemory(ws4).file === "CLOSENI.md");
  await h.l.clear();
  await h.l.turn("y");
  check("clear starts a new thread with the preamble again", s.resets === 1 && /You are CloseNI/.test(s.prompts[1]));
  check("an @ that is not a project path stays as typed", expandMentions("mail me@example.com or use @decorator", ws4).attached.length === 0);

  s = script([tool({ tool: "todo", items: [{ text: "one", status: "in_progress" }, { text: "two" }] }), "ok"]);
  h = loop(s, { ws: ws4 });
  await h.l.turn("x");
  check("the todo list is published", type(h.events, "todos").pop().items.length === 2);

  for (const d of [ws, ws2, ws3, ws4, outside]) fs.rmSync(d, { recursive: true, force: true });
}

module.exports = { run };

if (require.main === module) {
  let pass = 0, fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log("  ok   " + name); }
    else { fail++; console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
  };
  run(check, (n) => console.log("\n" + n)).then(() => {
    console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + " - " + pass + " passed, " + fail + " failed");
    process.exit(fail === 0 ? 0 : 1);
  }).catch((e) => { console.error(e); process.exit(1); });
}
