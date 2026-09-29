/*
 * Structured extraction (src/extract): the optional Needle backend.
 *
 * Three layers, each tested against the next one down:
 *   - the pure logic (segmentation, grounding, gating) against an in-process
 *     fake extractor;
 *   - the Node client and the real Python bridge against a stand-in `needle`
 *     package (fixtures/fake-needle), which answers by rule rather than by
 *     model - so these prove plumbing, time bounds and failure handling, not
 *     reading quality;
 *   - the CLI modes, end to end through that same bridge.
 * The real model is never run here: its weights come from Hugging Face.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnSync, execFileSync } = require("child_process");

const DIST = path.join(__dirname, "..", "dist");
const FAKE = path.join(__dirname, "fixtures", "fake-needle");
const BRIDGE = path.join(__dirname, "..", "python", "needle_bridge.py");

function pythonCommand() {
  for (const cmd of process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
    try {
      const r = spawnSync(cmd, ["-c", "import sys; print(sys.version_info[0])"], { encoding: "utf-8", timeout: 10000 });
      if (r.status === 0 && String(r.stdout).trim() === "3") return cmd;
    } catch (e) { /* try next */ }
  }
  return null;
}

function fakeExtractor(answer) {
  const calls = [];
  return {
    id: "fake",
    calls: calls,
    extract: async function (req) {
      calls.push(req);
      const a = answer(req);
      if (a instanceof Error) throw a;
      return Object.assign({ found: true, value: {}, confidence: 0.9, withheld: false, reasoning: "", ungrounded: [] }, a);
    },
    close: async function () {},
  };
}

const PROSE_PLAN = [
  "Here is how I would build the notes API.",
  "",
  "**Step 1: Project setup** - create requirements.txt and src/app.py with a Flask app.",
  "",
  "**Step 2: Models** - add src/models.py holding the Note model, with tests in tests/test_models.py.",
  "   1. an id",
  "   2. a body",
  "",
  "**Step 3: Routes** - wire the CRUD routes in src/routes.py.",
  "",
  "Run it with: `python3 src/app.py`",
].join("\n");

async function run(check, section) {
  const { segmentPlanProse, pathsIn, grounded, rescuePlan } = require(path.join(DIST, "extract/plan-rescue.js"));
  const { classifyReply, describeReply, sampleReply } = require(path.join(DIST, "extract/reply-kind.js"));
  const ext = require(path.join(DIST, "extract/extractor.js"));
  const { rescueUnparsedPlan, explainUnparsed } = require(path.join(DIST, "extract/fallback.js"));
  const { NeedleClient } = require(path.join(DIST, "extract/needle-client.js"));
  const { MAX_PLAN_STEPS } = require(path.join(DIST, "plan-scale.js"));

  section("extraction: finding a plan's steps in prose");
  let p = segmentPlanProse(PROSE_PLAN);
  check("three 'Step N' markers are three steps", p && p.steps.length === 3, p && JSON.stringify(p.steps.map((s) => s.number)));
  check("a numbered list inside a step stays inside it", p && p.steps[1].body.indexOf("2. a body") !== -1);
  check("the heading loses its markdown", p && p.steps[0].heading === "Project setup", p && p.steps[0].heading);
  check("the preamble is kept apart", p && p.preamble === "Here is how I would build the notes API.");

  p = segmentPlanProse("Plan:\n1. Scaffold the app\n2. Add the parser\n   1. tokens\n   2. tree\n3. Add the CLI\n\nTo use it:\n1. install\n2. run");
  check("plain numbers at the outer indent", p && p.steps.length === 3, p && p.steps.map((s) => s.heading).join("|"));
  check("a later, shorter list loses to the plan", p && p.steps[2].heading === "Add the CLI");

  p = segmentPlanProse("1. one\n```\n2. not a step\n```\n2. two");
  check("markers inside a code fence are ignored", p && p.steps.length === 2 && p.steps[1].heading === "two");
  check("a lone numbered line is not a plan", segmentPlanProse("1. just this") === null);
  check("no numbers, no plan", segmentPlanProse("I think you should use Flask.") === null);
  check("non-string input is not a crash", segmentPlanProse(null) === null);
  check("numbers that do not count up are not a plan", segmentPlanProse("3. c\n7. d") === null);

  section("extraction: paths and grounding");
  const found = pathsIn("create `src/app.py`, README.md and a Dockerfile; see https://x.io/a.py, v1.2 and e.g. this");
  check("paths are found", found.indexOf("src/app.py") !== -1 && found.indexOf("README.md") !== -1, JSON.stringify(found));
  check("bare well-known names are files", found.indexOf("Dockerfile") !== -1);
  check("a path ending a sentence is found", pathsIn("wire the routes in src/routes.py.").join() === "src/routes.py");
  check("a URL is not a file", !found.some((f) => f.indexOf("x.io") !== -1));
  check("a version or an abbreviation is not a file", found.indexOf("v1.2") === -1 && found.indexOf("e.g") === -1);
  check("grounded ignores markdown and spacing", grounded("python3  src/app.py", "Run: `python3 src/app.py`"));
  check("an invented value is not grounded", !grounded("python3 main.py", "Run: python3 src/app.py"));
  check("an empty value is not grounded", !grounded("", "anything"));

  section("extraction: gating an answer");
  check("a confident answer is used", ext.usable({ found: true, withheld: false, confidence: 0.8 }, 0.5));
  check("an unsure one is not", !ext.usable({ found: true, withheld: false, confidence: 0.3 }, 0.5));
  check("a withheld one is not, whatever its score", !ext.usable({ found: true, withheld: true, confidence: 0.99 }, 0.5));
  check("a refusal is not", !ext.usable({ found: false, withheld: false, confidence: 0.9 }, 0.5));
  check("no calibration head is accepted", ext.usable({ found: true, withheld: false, confidence: null }, 0.5));

  section("extraction: settings");
  let s = ext.readExtractionSettings({});
  check("off by default", s.backend === "builtin");
  check("default threshold", s.minConfidence === ext.DEFAULT_MIN_CONFIDENCE);
  s = ext.readExtractionSettings({ CLOSENI_EXTRACTOR: " Needle ", CLOSENI_NEEDLE_MIN_CONFIDENCE: "0.8", CLOSENI_NEEDLE_PYTHON: "/opt/py/bin/python" });
  check("needle is selected case-insensitively", s.backend === "needle");
  check("a threshold is read", s.minConfidence === 0.8);
  check("the interpreter is read", s.python === "/opt/py/bin/python");
  check("an out-of-range threshold falls back", ext.readExtractionSettings({ CLOSENI_NEEDLE_MIN_CONFIDENCE: "7" }).minConfidence === ext.DEFAULT_MIN_CONFIDENCE);
  check("an unknown backend is builtin", ext.readExtractionSettings({ CLOSENI_EXTRACTOR: "gpt" }).backend === "builtin");

  section("extraction: rescuing a prose plan");
  let fake = fakeExtractor(function (req) {
    if (req.name === "plan_step") {
      if (req.text.indexOf("Models") !== -1) return { value: { title: "Note model", files: ["src/models.py", "tests/test_models.py", "src/invented.py"], testable: true } };
      if (req.text.indexOf("Routes") !== -1) return { value: { title: "", files: [] } };
      return { value: { title: "Setup", files: ["requirements.txt", "src/app.py"], testable: false } };
    }
    if (req.name === "project_plan") return { value: { summary: "A notes API.", run_command: "python3 src/app.py" } };
    return { found: false };
  });
  let r = await rescuePlan(PROSE_PLAN, fake, 0.5);
  check("a prose plan is rescued", r && r.plan.steps.length === 3);
  check("titles come from the model", r && r.plan.steps[1].title === "Note model");
  check("an empty title falls back to the heading", r && r.plan.steps[2].title === "Routes", r && r.plan.steps[2].title);
  check("a file not in the step's text is dropped", r && r.plan.steps[1].files.indexOf("src/invented.py") === -1 && r.plan.steps[1].files.length === 2,
    r && JSON.stringify(r.plan.steps[1].files));
  check("and the drop is reported", r && r.report.fallbacks.some((f) => f.indexOf("src/invented.py") !== -1));
  check("no files from the model means files read from the text", r && r.plan.steps[2].files.join() === "src/routes.py");
  check("detail is the step's own text", r && r.plan.steps[1].detail.indexOf("the Note model") !== -1);
  check("a rescued plan is a chain", r && JSON.stringify(r.plan.steps.map((x) => x.dependsOn)) === "[[],[0],[1]]");
  check("testable is carried when stated", r && r.plan.steps[0].testable === false && r.plan.steps[1].testable === true);
  check("a grounded run command is kept", r && r.plan.runCommand === "python3 src/app.py");
  check("the summary comes from the model", r && r.plan.summary === "A notes API.");
  check("the report counts what the model read", r && r.report.read === 3 && r.report.by === "fake");

  fake = fakeExtractor(function (req) {
    if (req.name === "project_plan") return { value: { summary: "x", run_command: "npm start" } };
    return { value: { title: "t", files: [] } };
  });
  r = await rescuePlan(PROSE_PLAN, fake, 0.5);
  check("an invented run command is dropped", r && r.plan.runCommand === undefined);

  fake = fakeExtractor(function () { return { confidence: 0.1 }; });
  check("nothing confident means no rescue, not a mechanical one", (await rescuePlan(PROSE_PLAN, fake, 0.5)) === null);
  fake = fakeExtractor(function () { return { found: false }; });
  check("a model that refuses every step rescues nothing", (await rescuePlan(PROSE_PLAN, fake, 0.5)) === null);

  const huge = Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, i) => (i + 1) + ". step " + (i + 1) + " writes f" + i + ".py").join("\n");
  fake = fakeExtractor(function () { return { value: { title: "t" } }; });
  check("a plan over the bound is rejected, not truncated", (await rescuePlan(huge, fake, 0.5)) === null);
  check("and the model is never asked", fake.calls.length === 0);
  check("prose with no plan never reaches the model", (await rescuePlan("Sure, what language?", fake, 0.5)) === null && fake.calls.length === 0);

  const long = "Step 1: a\n" + "x".repeat(10000) + "\nStep 2: b writes b.py";
  fake = fakeExtractor(function () { return { value: { title: "t" } }; });
  await rescuePlan(long, fake, 0.5);
  check("the model is shown a bounded slice of a long step", fake.calls[0].text.length <= 3000);

  section("extraction: saying what a reply was");
  fake = fakeExtractor(function () { return { value: { kind: "refusal", quote: "I can't help with that." } }; });
  let reading = await classifyReply("Sorry. I can't help with that. Try something else.", fake, 0.5);
  check("a refusal is read", reading && reading.kind === "refusal");
  check("with the provider's own words", reading && reading.quote === "I can't help with that.");
  check("and described", /declined/.test(describeReply(reading, "plan")) && /can't help/.test(describeReply(reading, "plan")));
  fake = fakeExtractor(function () { return { value: { kind: "question", quote: "Which database do you want?" } }; });
  reading = await classifyReply("Before I plan: Which database would you like?", fake, 0.5);
  check("a quote the reply never said is dropped", reading && reading.kind === "question" && reading.quote === undefined);
  check("a question is described", /asked a question/.test(describeReply(reading, "code")));
  fake = fakeExtractor(function () { return { value: { kind: "banana" } }; });
  check("a kind outside the enum is ignored", (await classifyReply("text", fake, 0.5)) === null);
  check("an empty reply is not classified", (await classifyReply("   ", fake, 0.5)) === null);
  check("a reply that looks like what was asked adds nothing", describeReply({ kind: "plan", confidence: 0.9 }, "plan") === "");
  check("a long reply is sampled at both ends", (function () {
    const t = "HEAD" + "m".repeat(5000) + "TAIL";
    const sm = sampleReply(t);
    return sm.length < 2500 && sm.indexOf("HEAD") === 0 && sm.endsWith("TAIL");
  })());

  section("extraction: failures never cost the run");
  ext.setExtractorForTest(null);
  const savedEnv = process.env.CLOSENI_EXTRACTOR;
  delete process.env.CLOSENI_EXTRACTOR;
  check("off: no extractor", ext.getExtractor() === null);
  check("off: no rescue", (await rescueUnparsedPlan([PROSE_PLAN])) === null);
  check("off: no explanation", (await explainUnparsed("I can't help", "plan")) === "");
  ext.setExtractorForTest(fakeExtractor(function () { return new Error("bridge died"); }));
  check("a failing extractor yields no rescue", (await rescueUnparsedPlan([PROSE_PLAN])) === null);
  process.env.CLOSENI_EXTRACTOR = "needle";
  check("and is not tried again in the same run", ext.getExtractor() === null);
  ext.setExtractorForTest(fakeExtractor(function (req) {
    return req.name === "plan_step" ? { value: { title: "t", files: [] } } : { found: false };
  }));
  r = await rescueUnparsedPlan(["no plan here", PROSE_PLAN]);
  check("the first reply with a plan in it is used", r && r.plan.steps.length === 3);
  ext.setExtractorForTest(null);
  if (savedEnv === undefined) delete process.env.CLOSENI_EXTRACTOR; else process.env.CLOSENI_EXTRACTOR = savedEnv;

  section("extraction: desktop settings");
  const X = require(path.join(__dirname, "..", "..", "desktop", "extraction-settings.js"));
  check("nothing saved is the default", JSON.stringify(X.normalize(null)) === JSON.stringify(X.DEFAULTS));
  check("off means no environment", Object.keys(X.toEnv({ backend: "builtin", python: "/x" })).length === 0);
  let xe = X.toEnv({ backend: "needle", python: " /opt/py ", weights: "", minConfidence: "0.7" });
  check("needle sets the backend and threshold", xe.CLOSENI_EXTRACTOR === "needle" && xe.CLOSENI_NEEDLE_MIN_CONFIDENCE === "0.7");
  check("the interpreter is trimmed", xe.CLOSENI_NEEDLE_PYTHON === "/opt/py");
  check("blank weights are not passed", !("CLOSENI_NEEDLE_WEIGHTS" in xe));
  check("an unknown backend is off", X.normalize({ backend: "rm -rf" }).backend === "builtin");
  check("a path with a newline is refused", X.normalize({ backend: "needle", python: "python3\nrm" }).python === "");
  check("a threshold out of range is the default", X.normalize({ minConfidence: 3 }).minConfidence === 0.5);
  check("the agent reads what the app writes", ext.readExtractionSettings(X.toEnv({ backend: "needle", minConfidence: 0.7 })).minConfidence === 0.7);
  check("a failed check says why", /Not available: no pip/.test(X.describeCheck({ backend: "needle", success: false, error: "no pip" })));
  check("a good check names the version", /cactus-needle 3\.0\.6/.test(X.describeCheck({ backend: "needle", success: true, version: "3.0.6" })));

  const py = pythonCommand();
  if (!py) {
    section("extraction: bridge (skipped - no Python 3 on PATH)");
    return;
  }
  const withFake = Object.assign({}, process.env, { PYTHONPATH: FAKE });

  section("extraction: the Python bridge, against a stand-in needle package");
  let client = new NeedleClient({ python: py, env: withFake });
  const hello = await client.start();
  check("the bridge starts and says hello", hello.ok === true && hello.version === "fake-0", JSON.stringify(hello));
  let x = await client.extract({ name: "plan_step", description: "d", schema: { type: "object" }, text: "Step 1: Models\nWrite src/models.py and tests" });
  check("an extraction round-trips", x.found && x.value.title === "Models" && x.value.files[0] === "src/models.py", JSON.stringify(x));
  check("confidence is carried", x.confidence === 0.9);
  x = await client.extract({ name: "plan_step", description: "d", schema: { type: "object" }, text: "Step 2: WITHHOLD this" });
  check("a withheld record is reported as withheld", x.found && x.withheld === true && !ext.usable(x, 0.5));
  x = await client.extract({ name: "ping", description: "d", schema: { type: "object" }, text: "anything" });
  check("an empty call is a refusal", x.found === false);
  let err = null;
  try { await client.extract({ name: "x", description: "", schema: "not an object", text: "t" }); } catch (e) { err = e; }
  check("a bad request is an error, not a dead bridge", err && /schema/.test(err.message));
  x = await client.extract({ name: "ping", description: "d", schema: { type: "object" }, text: "still alive" });
  check("and the bridge still answers after it", x.found === false);
  await client.close();

  client = new NeedleClient({ python: py, env: withFake, callTimeoutMs: 1500, firstCallTimeoutMs: 1500 });
  const t0 = Date.now();
  err = null;
  try { await client.extract({ name: "plan_step", description: "d", schema: { type: "object" }, text: "HANG" }); } catch (e) { err = e; }
  check("a hung model is cut off by the deadline", err && /did not answer/.test(err.message) && Date.now() - t0 < 6000, err && err.message);
  err = null;
  try { await client.extract({ name: "plan_step", description: "d", schema: { type: "object" }, text: "fine" }); } catch (e) { err = e; }
  check("and the bridge is not trusted again", err !== null);
  await client.close();

  client = new NeedleClient({ python: py, env: withFake });
  err = null;
  try { await client.extract({ name: "plan_step", description: "d", schema: { type: "object" }, text: "CRASH" }); } catch (e) { err = e; }
  check("a crashed bridge fails the call rather than hanging", err && /exited/.test(err.message), err && err.message);
  await client.close();

  client = new NeedleClient({ python: py, env: Object.assign({}, process.env, { PYTHONPATH: "" }) });
  err = null;
  try { await client.start(); } catch (e) { err = e; }
  check("a missing package says how to install it", err && /pip install cactus-needle/.test(err.message), err && err.message);
  await client.close();

  client = new NeedleClient({ python: "closeni-no-such-python", env: withFake });
  err = null;
  try { await client.start(); } catch (e) { err = e; }
  check("a missing interpreter is an error", err && /could not start|exited/.test(err.message), err && err.message);
  await client.close();

  client = new NeedleClient({ python: py, env: withFake });
  const GHOSTED = PROSE_PLAN.replace("wire the CRUD routes", "wire the CRUD routes GHOST");
  r = await rescuePlan(GHOSTED, client, 0.5);
  check("a prose plan is rescued through the bridge", r && r.plan.steps.length === 3, r && JSON.stringify(r.report));
  check("the stand-in's invented path is dropped", r && r.plan.steps[2].files.indexOf("ghost/invented.py") === -1 && r.plan.steps[2].files.join() === "src/routes.py",
    r && JSON.stringify(r.plan.steps[2].files));
  check("the run command is the reply's own", r && r.plan.runCommand === "python3 src/app.py", r && r.plan.runCommand);
  await client.close();

  section("extraction: CLI modes");
  const agent = path.join(DIST, "index.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "closeni-extract-"));
  const replyFile = path.join(tmp, "reply.txt");
  fs.writeFileSync(replyFile, PROSE_PLAN);
  function cli(args, env) {
    const out = execFileSync(process.execPath, [agent].concat(args), {
      encoding: "utf-8", timeout: 60000, input: "",
      env: Object.assign({}, process.env, { AGENT_PROVIDER_DIR: tmp, CLOSENI_STORAGE: tmp }, env || {}),
    });
    const m = out.match(/AGENT_OUTPUT_START\n(.*)\nAGENT_OUTPUT_END/);
    return m ? JSON.parse(m[1]) : { raw: out };
  }
  const needleEnv = { CLOSENI_EXTRACTOR: "needle", CLOSENI_NEEDLE_PYTHON: py, PYTHONPATH: FAKE };
  let out = cli(["rescue-plan", replyFile], { CLOSENI_EXTRACTOR: "builtin" });
  check("rescue-plan with extraction off says so", out.success === false && /extraction is off/.test(out.error), JSON.stringify(out));
  out = cli(["rescue-plan", replyFile], needleEnv);
  check("rescue-plan reads the prose plan", out.success === true && out.via === "extraction" && out.plan.steps.length === 3, JSON.stringify(out).slice(0, 300));
  fs.writeFileSync(replyFile, "```json\n{\"summary\":\"s\",\"steps\":[{\"title\":\"a\",\"detail\":\"\",\"files\":[\"a.py\"]}]}\n```");
  out = cli(["rescue-plan", replyFile], needleEnv);
  check("a reply the parser reads never reaches the extractor", out.success === true && out.via === "parser");
  out = cli(["extractor-check"], needleEnv);
  check("extractor-check reports the bridge", out.success === true && out.backend === "needle" && out.version === "fake-0", JSON.stringify(out));
  out = cli(["extractor-check"], { CLOSENI_EXTRACTOR: "needle", CLOSENI_NEEDLE_PYTHON: py, PYTHONPATH: "" });
  check("extractor-check explains a missing package", out.success === false && /pip install/.test(out.error), JSON.stringify(out));
  out = cli(["extractor-check"], {});
  check("extractor-check with extraction off", out.success === true && out.backend === "builtin");
  fs.rmSync(tmp, { recursive: true, force: true });
}

module.exports = { run };

if (require.main === module) {
  let pass = 0, fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log("  ok   " + name); }
    else { fail++; console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
  };
  const section = (name) => console.log("\n" + name);
  run(check, section).then(() => {
    console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + " - " + pass + " passed, " + fail + " failed");
    process.exit(fail === 0 ? 0 : 1);
  }).catch((e) => { console.error(e); process.exit(1); });
}
