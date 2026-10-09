/*
 * The live scenario suite: the real app, the real provider, one scratch folder
 * per scenario.
 *
 *   node scripts/agent-live.mjs                 all twelve
 *   node scripts/agent-live.mjs 3 8             only these
 *   node scripts/agent-live.mjs --auto          auto mode, no prompts to answer
 *   node scripts/agent-live.mjs --record        also add the results to docs/testing/agent-live.md
 *   node scripts/agent-live.mjs --root DIR      where the scratch folders go (default: the temp dir)
 *   node scripts/agent-live.mjs --app PATH      the CloseNI binary (default: build-native/bin/CloseNI)
 *   node scripts/agent-live.mjs --mock          the e2e mock provider with scripted replies, in
 *                                               scratch storage: proves the plumbing, not the model
 *
 * Each scenario launches the native app with --live <scenario.json> --start
 * --workspace <a new folder>. The app's shell/LiveFlow.qml types the prompts
 * into the Code panel of a real window and waits for each turn to finish; no
 * web engine or debugging port is involved. A permission prompt is never
 * answered from here: without --auto a person answers it in the window, and
 * the flow waits. The provider must already be signed in (the app's own
 * browser profile), except with --mock.
 *
 * What is recorded comes from the app's own output - the [agent] AGENT tool
 * and done lines and AGENT_DRIFT on stdout, the flow's "closeni-live:" lines
 * (turn ends and the transcript as the panel shows it) on stderr - and the
 * project's tests run once the last turn is done.
 */
import { spawn, spawnSync } from "child_process";
import { createRequire } from "module";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const repo = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const AUTO = args.includes("--auto");
const RECORD = args.includes("--record");
const MOCK = args.includes("--mock");
const valueOf = (flag) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : null);
const rootArg = valueOf("--root");
const APP = path.resolve(valueOf("--app") || path.join(repo, "build-native", "bin", process.platform === "win32" ? "CloseNI.exe" : "CloseNI"));
const only = args.filter((a, i) => /^\d+$/.test(a) && args[i - 1] !== "--root" && args[i - 1] !== "--app").map(Number);
const TURN_TIMEOUT = 20 * 60 * 1000;

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runDir = path.resolve(rootArg || path.join(os.tmpdir(), "closeni-live"), stamp);
if (!path.relative(repo, runDir).startsWith("..")) { console.error("The scratch folders must be outside the repository: " + runDir); process.exit(2); }
if (!fs.existsSync(APP)) { console.error("No app at " + APP + " - build it (cmake --build build-native) or pass --app PATH"); process.exit(2); }

// ------------------------------------------------------------ scenarios
//
// steps: { say } types a message and waits for its turn; { command } types a
// slash command that runs no turn; { mode } switches the panel's mode;
// { approvePlan } accepts the plan offered at the end of a plan-mode turn;
// { interrupt, say } presses Esc once the turn's first tool has run.

// The project's own virtualenv when it made one (the agent names it either
// way). Otherwise one made here with pytest in it, so a machine without
// pytest does not fail code that works.
const bin = (env) => path.join(env, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const py = (ws) => {
  const env = [".venv", "venv"].find((d) => fs.existsSync(path.join(ws, d)));
  if (env) return bin(path.join(ws, env));
  const own = path.join(runDir, ".check-venv");
  if (!fs.existsSync(bin(own))) {
    run(runDir, process.platform === "win32" ? "python" : "python3", ["-m", "venv", own]);
    run(runDir, bin(own), ["-m", "pip", "install", "-q", "pytest"]);
  }
  return bin(own);
};
const pytest = (ws) => run(ws, py(ws), ["-m", "pytest", "-q"]);
const fileHas = (ws, f, re) => { try { return re.test(fs.readFileSync(path.join(ws, f), "utf8")) ? { ok: true, output: f + " matches" } : { ok: false, output: f + " does not match " + re }; } catch (e) { return { ok: false, output: String(e.message) }; } };

const TODO = "Create a small Python command-line todo app in this folder: todo.py with add, list and done commands that keep the items in todo.json, and pytest tests in test_todo.py. Run the tests.";
const CALC = {
  "calc.py": "def add(a, b):\n    return a + b\n\n\ndef mean(xs):\n    return sum(xs) / (len(xs) - 1)\n",
  "test_calc.py": "from calc import add, mean\n\n\ndef test_add():\n    assert add(2, 3) == 5\n\n\ndef test_mean():\n    assert mean([1, 2, 3]) == 2\n",
};
const UNITS = ["metre", "kilometre", "centimetre", "millimetre", "mile", "yard", "foot", "inch", "gram", "kilogram", "pound", "ounce",
  "litre", "millilitre", "gallon", "pint", "second", "minute", "hour", "day", "celsius", "fahrenheit", "kelvin"];
const LONG = "Write units.py, a unit converter, and test_units.py with pytest tests, then run the tests. The requirements follow in full; follow every one.\n\n" +
  UNITS.map((u, i) => (i + 1) + ". Support '" + u + "' as a unit name, its plural, and its usual abbreviation. convert(value, from_unit, to_unit) must accept any of those spellings, " +
    "case-insensitively and ignoring surrounding spaces, and raise ValueError naming the unit when the spelling is not known. Converting '" + u + "' to itself returns the value unchanged. " +
    "Add at least one test that converts '" + u + "' to another unit of the same kind and checks the result to six decimal places.").join("\n") +
  "\n\nConverting between kinds (a length to a mass, say) raises ValueError that names both kinds. Temperatures convert through kelvin, and a temperature below absolute zero raises ValueError. " +
  "Keep the conversion factors in one table at the top of the module, not spread through the code.";
const INVENTORY = ["Create inventory.py with an empty Inventory class and test_inventory.py that imports it. Run the tests.",
  "Add Inventory.add(name, qty) that adds stock, with a test. Run the tests.",
  "Add Inventory.remove(name, qty) that raises ValueError when there is not enough stock, with tests. Run the tests.",
  "Add Inventory.count(name), returning 0 for an unknown item, with a test. Run the tests.",
  "Add Inventory.total() for the number of items across all names, with a test. Run the tests.",
  "Add prices: Inventory.set_price(name, price) and Inventory.value() for the stock's total value, with tests. Run the tests.",
  "Make names case-insensitive everywhere, with a test. Run the tests.",
  "Add Inventory.low_stock(threshold) returning names below it, sorted, with a test. Run the tests.",
  "Add save(path) and load(path) using JSON, with a test that uses tmp_path. Run the tests.",
  "Add a history list recording every add and remove as (action, name, qty), with a test. Run the tests.",
  "Add Inventory.undo() that reverses the last history entry, with tests. Run the tests.",
  "Reject negative or zero quantities in add and remove with ValueError, with tests. Run the tests.",
  "Add a __len__ that counts distinct names in stock, with a test. Run the tests.",
  "Add Inventory.rename(old, new), merging stock when new already exists, with tests. Run the tests.",
  "Add a cli.py using argparse with add, remove and list subcommands over a JSON file, with tests that call main(argv). Run the tests.",
  "Add docstrings to every public method in inventory.py. Run the tests.",
  "Add Inventory.search(prefix) returning matching names, sorted, with a test. Run the tests.",
  "Add a report() method returning a fixed-width text table of name, qty and value, with a test. Run the tests.",
  "Refactor inventory.py so all validation lives in one private helper, keeping the behaviour. Run the tests.",
  "Add a README.md describing the module and the CLI, with examples. Run the tests.",
  "List what inventory.py now supports, and confirm the tests all pass by running them."];

const SCENARIOS = [
  { n: 1, name: "New Python CLI + pytest", steps: [{ say: TODO }], check: pytest },
  { n: 2, name: "Follow-up edit in the same project", steps: [{ say: TODO }, { say: "Add a remove command that deletes an item by its number, with a test. Run the tests." }], check: pytest },
  { n: 3, name: "Bug fix: a seeded project with a failing test", seed: CALC, steps: [{ say: "The tests are failing. Find the bug, fix it, and run the tests." }], check: pytest },
  { n: 4, name: "Multi-file web app", steps: [{ say: "Build a small Flask notes app here: app.py with a JSON API to add and list notes, templates/index.html and static/app.js for the page, and pytest tests using Flask's test client. Install Flask in a virtualenv in this folder, run the tests, then start the server in the background and check with curl that it answers." }], check: pytest },
  { n: 5, name: "A prompt over 5000 characters", steps: [{ say: LONG }], check: pytest },
  { n: 6, name: "A task needing a package install", steps: [{ say: "Write fetch_title.py, which uses requests and beautifulsoup4 to print a web page's <title>, and a pytest test that parses a local HTML string (no network). Install the packages in a virtualenv in this folder and run the tests." }], check: pytest },
  { n: 7, name: "A README-heavy task", seed: { "calc.py": "def add(a, b):\n    return a + b\n" }, steps: [{ say: "Write a README.md for this project: install steps and shell usage, a Python example, and a section on writing docs for it that shows a Markdown sample which itself contains a fenced code block. Use fenced code blocks throughout." }],
    check: (ws) => fileHas(ws, "README.md", /(`{4,}|~{3,})[\s\S]*```[\s\S]*```[\s\S]*\1/) },
  { n: 8, name: "A 20+ turn session", steps: INVENTORY.map((say) => ({ say })), check: pytest },
  { n: 9, name: "Plan mode, then approve, then execute", steps: [{ mode: "plan" }, { say: "Plan slugify.py with a slugify(text) function (lowercase, ASCII, hyphens between words) and pytest tests." }, { approvePlan: true }], check: pytest },
  { n: 10, name: "/rewind after a bad edit", seed: { "calc.py": CALC["calc.py"].replace(" - 1)", ")"), "test_calc.py": CALC["test_calc.py"] }, steps: [{ say: "Rename the function add to plus everywhere, then run the tests." }, { command: "/rewind" }],
    check: (ws) => fileHas(ws, "calc.py", /^def add\(a, b\):/m) },
  { n: 11, name: "A TypeScript project", steps: [{ say: "Create a small TypeScript project here: package.json, tsconfig.json, src/stack.ts with a generic Stack class, and tests using node:test. Scripts: build runs tsc, test builds and then runs the compiled tests with node --test. Install the dependencies, then run npm run build and npm test." }],
    check: (ws) => run(ws, "npm", ["test"]) },
  { n: 12, name: "Stop mid-turn (esc), then continue", steps: [{ say: "Create primes.py with is_prime and primes_up_to, and pytest tests for both. Run the tests.", interrupt: true }, { say: "Carry on from where you stopped, and run the tests." }], check: pytest },
];

// ------------------------------------------------------------ the mock
//
// --mock: the e2e suite's mock provider (local-agent/test/mock-provider.cjs)
// answers with these replies, in order, one per message the agent sends; the
// last repeats. Only scenarios with replies here run under --mock.

const F = "```";
const tool = (obj, content) => F + "\n" + JSON.stringify(obj) + (content === undefined ? "" : "\n---\n" + content) + "\n" + F;
const SLUGIFY = "import re\nimport unicodedata\n\n\ndef slugify(text):\n    text = unicodedata.normalize(\"NFKD\", text).encode(\"ascii\", \"ignore\").decode(\"ascii\")\n    return \"-\".join(re.findall(r\"[a-z0-9]+\", text.lower()))\n";
const SLUGIFY_TEST = "from slugify import slugify\n\n\ndef test_words():\n    assert slugify(\"Hello World\") == \"hello-world\"\n\n\ndef test_ascii():\n    assert slugify(\"Café au lait!\") == \"cafe-au-lait\"\n";
const PRIMES = "def is_prime(n):\n    if n < 2:\n        return False\n    return all(n % d for d in range(2, int(n ** 0.5) + 1))\n\n\ndef primes_up_to(n):\n    return [p for p in range(2, n + 1) if is_prime(p)]\n";
const PRIMES_TEST = "from primes import is_prime, primes_up_to\n\n\ndef test_is_prime():\n    assert is_prime(7) and not is_prime(9) and not is_prime(1)\n\n\ndef test_primes_up_to():\n    assert primes_up_to(20) == [2, 3, 5, 7, 11, 13, 17, 19]\n";
const MOCK_REPLIES = {
  // A plan (plan mode: read-only, no tools), then the approved turn writes it.
  9: ["Plan:\n\n1. slugify.py: slugify(text) lowercases, drops accents to ASCII and joins the words with hyphens.\n2. test_slugify.py: pytest tests for plain words and accented text.",
    tool({ tool: "write", path: "slugify.py" }, SLUGIFY) + "\n\n" + tool({ tool: "write", path: "test_slugify.py" }, SLUGIFY_TEST),
    "Done: slugify.py and test_slugify.py are written."],
  // The rename, which /rewind then takes back.
  10: [tool({ tool: "edit", path: "calc.py" }, "<<<<<<< SEARCH\ndef add(a, b):\n=======\ndef plus(a, b):\n>>>>>>> REPLACE") + "\n\n" +
    tool({ tool: "edit", path: "test_calc.py" }, "<<<<<<< SEARCH\nfrom calc import add, mean\n=======\nfrom calc import plus, mean\n>>>>>>> REPLACE\n<<<<<<< SEARCH\n    assert add(2, 3) == 5\n=======\n    assert plus(2, 3) == 5\n>>>>>>> REPLACE"),
  "Renamed add to plus in calc.py and test_calc.py."],
  // A slow command first, so esc lands while it runs and the write after it
  // is never reached; the next turn carries on.
  12: [tool({ tool: "bash", command: "sleep 3" }) + "\n\n" + tool({ tool: "write", path: "primes.py" }, PRIMES),
    tool({ tool: "write", path: "primes.py" }, PRIMES) + "\n\n" + tool({ tool: "write", path: "test_primes.py" }, PRIMES_TEST),
    "Done: primes.py and test_primes.py are written."],
};

let mock = null;
async function mockEnv() {
  const { createMockProvider } = createRequire(import.meta.url)(path.join(repo, "local-agent", "test", "mock-provider.cjs"));
  mock = createMockProvider();
  const baseUrl = await mock.listen();
  const dir = path.join(runDir, ".mock");
  fs.mkdirSync(path.join(dir, "providers"), { recursive: true });
  fs.writeFileSync(path.join(dir, "providers", "mock.json"), JSON.stringify({
    id: "mock", name: "Mock Provider", kind: "web", baseUrl: baseUrl, requiresLogin: false, enabled: false,
    selectors: { chatInput: "#input", sendButton: "#send", stopButton: "#nonexistent-stop", assistantMessage: ".assistant-msg" },
    completionRules: { waitForStopButtonDisappear: false, maxWaitMs: 30000 },
    profileDir: path.join(dir, "profile"),
  }));
  return {
    AGENT_PROVIDER_DIR: path.join(dir, "providers"),
    CLOSENI_STORAGE: path.join(dir, "storage"),
    CLOSENI_NODE: process.execPath,
    // No session bus, so nothing reaches the real keyring (as in native/tests/code-e2e.cjs).
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/closeni-test-bus",
    QT_LOGGING_RULES: "qt.qpa.theme.dbus.warning=false;qt.qpa.theme.gnome.warning=false",
  };
}

// ------------------------------------------------------------ the app

function run(cwd, cmd, argv) {
  const r = spawnSync(cmd, argv, { cwd, encoding: "utf8", timeout: 10 * 60 * 1000, shell: process.platform === "win32" });
  return { ok: r.status === 0, output: ((r.stdout || "") + (r.stderr || "") + (r.error ? String(r.error) : "")).trim().split("\n").slice(-15).join("\n") };
}

const LIVE = /closeni-live: (\w+)(?: (.*))?$/;

/**
 * The app on one scenario, until it exits. `lines` gathers stdout (the
 * [agent] lines), `onLive(what, data)` gets each of the flow's reports.
 */
function launch(ws, scenarioFile, logFile, extraEnv, onLive) {
  const env = Object.assign({}, process.env, { QT_FORCE_STDERR_LOGGING: "1" }, extraEnv);
  const argv = ["--live", scenarioFile, "--start", "--workspace", ws].concat(MOCK ? ["--provider", "mock"] : []);
  const app = spawn(APP, argv, { env });
  const log = fs.createWriteStream(logFile);
  const lines = [];
  let ended = false;
  let killer = null;
  const splitter = (out) => {
    let buf = "";
    return (d) => {
      log.write(d);
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { out(buf.slice(0, i)); buf = buf.slice(i + 1); }
    };
  };
  app.stdout.on("data", splitter((l) => lines.push(l)));
  app.stderr.on("data", splitter((l) => {
    const m = l.match(LIVE);
    if (!m) return;
    let data = null;
    try { data = m[2] ? JSON.parse(m[2]) : null; } catch (e) { data = m[2]; }
    if (m[1] === "end") {
      ended = true;
      // The flow closes the session and exits; if it does not, it is stopped.
      killer = setTimeout(() => app.kill("SIGTERM"), 30000);
    }
    onLive(m[1], data);
  }));
  const exited = new Promise((resolve) => app.on("close", (code, signal) => {
    clearTimeout(killer);
    log.end();
    resolve({ code, signal, ended });
  }));
  return { lines, exited };
}

const count = (lines, re) => lines.filter((l) => re.test(l)).length;

async function runScenario(s, extraEnv) {
  const ws = path.join(runDir, String(s.n).padStart(2, "0") + "-" + s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
  fs.mkdirSync(ws, { recursive: true });
  for (const [f, text] of Object.entries(s.seed || {})) fs.writeFileSync(path.join(ws, f), text);
  console.log("\n" + s.n + ". " + s.name + "\n   " + ws);
  const t0 = Date.now();
  const base = path.join(ws, "..", path.basename(ws));
  fs.writeFileSync(base + ".scenario.json", JSON.stringify({ auto: AUTO, turnTimeoutMs: TURN_TIMEOUT, steps: s.steps }, null, 2));
  if (mock) mock.setReplies(MOCK_REPLIES[s.n]);

  const turns = [];
  const transcript = [];
  let error = "";
  const { lines, exited } = launch(ws, base + ".scenario.json", base + ".app.log", extraEnv, (what, data) => {
    if (what === "step" && data.say) console.log("   > " + data.say.slice(0, 90) + (data.say.length > 90 ? "..." : ""));
    else if (what === "step" && (data.command || data.mode)) console.log("   > " + (data.command || "/mode " + data.mode));
    else if (what === "step" && data.approvePlan) console.log("   > (approve the plan)");
    else if (what === "permission") console.log("      waiting for a person to answer a permission prompt in the window: " + data.question);
    else if (what === "turn") { turns.push(data); console.log("     " + data.reason + " in " + data.seconds + "s"); }
    else if (what === "transcript") transcript.push(data);
    else if (what === "end" && data.error) error = data.error;
  });
  const exit = await exited;
  if (!exit.ended && !error) error = "the app exited (" + (exit.signal || exit.code) + ") before the scenario finished";
  if (error) console.log("   ERROR " + error);
  fs.writeFileSync(base + ".transcript.txt", transcript.join("\n") + "\n");

  const tools = {};
  for (const l of lines) {
    const m = l.match(/^\[agent\] AGENT tool: (\S+) .* -> (\S+)/);
    if (m && m[2] !== "running") tools[m[1] + " " + m[2]] = (tools[m[1] + " " + m[2]] || 0) + 1;
  }
  const drift = { malformed: 0, missing: 0 };
  for (const l of lines) {
    const m = l.match(/AGENT_DRIFT: (\{.*\})/);
    // Each is the thread's running count at the end of a turn; the last is the total.
    if (m) { try { const d = JSON.parse(m[1]); drift.malformed = d.malformed; drift.missing = d.missing; drift.at = d.at; } catch (e) { /* skip */ } }
  }
  // The flow's turn ends, checked against the agent's own.
  if (!error && turns.length !== count(lines, /^\[agent\] AGENT done:/)) error = "the app reported " + turns.length + " turn ends, the agent " + count(lines, /^\[agent\] AGENT done:/);
  const check = error ? { ok: false, output: "not run: " + error } : s.check(ws);
  const result = { n: s.n, name: s.name, workspace: ws, auto: AUTO, mock: MOCK, seconds: Math.round((Date.now() - t0) / 1000), turns, tools, drift, error, check };
  console.log("   " + (check.ok && !error ? "PASS" : "FAIL") + " - " + result.seconds + "s, drift " + drift.malformed + " malformed / " + drift.missing + " missing");
  if (!check.ok) console.log(check.output.split("\n").map((l) => "     " + l).join("\n"));
  return result;
}

// ------------------------------------------------------------ run

fs.mkdirSync(runDir, { recursive: true });
let chosen = SCENARIOS.filter((s) => !only.length || only.includes(s.n));
if (MOCK) {
  const unscripted = chosen.filter((s) => !MOCK_REPLIES[s.n]);
  if (unscripted.length) console.log("No scripted replies for " + unscripted.map((s) => s.n).join(", ") + ", so --mock skips them");
  chosen = chosen.filter((s) => MOCK_REPLIES[s.n]);
}
if (!chosen.length) { console.error("No scenarios to run"); process.exit(2); }
const extraEnv = MOCK ? await mockEnv() : {};
const results = [];
for (const s of chosen) results.push(await runScenario(s, extraEnv));
if (mock) await mock.close();
fs.writeFileSync(path.join(runDir, "results.json"), JSON.stringify(results, null, 2));

const toolText = (t) => Object.entries(t).map(([k, v]) => k + " " + v).join(", ") || "-";
const table = ["| # | Scenario | Result | Turns | Time | Tools | Drift (malformed / missing) |", "|---|---|---|---|---|---|---|"].concat(results.map((r) =>
  "| " + r.n + " | " + r.name + " | " + (r.check.ok && !r.error ? "pass" : "**fail**") + " | " + r.turns.map((t) => t.reason).join(", ") + " | " +
  r.seconds + "s | " + toolText(r.tools) + " | " + r.drift.malformed + " / " + r.drift.missing + " |")).join("\n");
const passed = results.filter((r) => r.check.ok && !r.error).length;
console.log("\n" + table + "\n\n" + (passed === results.length ? "PASS" : "FAIL") + " - " + passed + " of " + results.length + " scenarios. Results: " + runDir);

if (RECORD) {
  const doc = path.join(repo, "docs", "testing", "agent-live.md");
  const head = fs.existsSync(doc) ? "" : "# The live scenario suite\n\nWritten by `node scripts/agent-live.mjs --record`: one section a run, newest last.\n";
  fs.appendFileSync(doc, head + "\n## " + stamp.slice(0, 10) + " " + stamp.slice(11).replace(/-/g, ":") + (AUTO ? " (auto mode)" : "") + (MOCK ? " (mock provider)" : "") + "\n\n" + table + "\n");
  console.log("Recorded in " + path.relative(repo, doc));
}
process.exit(passed === results.length ? 0 : 1);
