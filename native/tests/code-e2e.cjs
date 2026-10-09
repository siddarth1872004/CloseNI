/*
 * The Code panel end to end, against the e2e suite's mock provider: the
 * window's --self-test with --start, --provider mock and a --workspace, which (after
 * the usual theme walk) waits for the session --start opened, types a request
 * into the panel, presses enter, waits for the edit to ask, answers 1 (allow) and waits
 * for the turn to finish - all through the panel's own key handlers. See
 * qml/shell/SelfTest.qml.
 *
 *   node native/tests/code-e2e.cjs [path/to/CloseNI] [screenshot dir]
 *
 * Needs a built agent (npm run build) and Playwright's Chromium. Storage and
 * the provider config go in a temporary directory, so no real profile is
 * touched.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMockProvider } = require("../../local-agent/test/mock-provider.cjs");

const root = path.join(__dirname, "..", "..");
const exe = process.argv[2] || path.join(root, "build-native", "bin", process.platform === "win32" ? "CloseNI.exe" : "CloseNI");
const F = "```";

let failed = 0;
function check(name, cond, extra) {
  if (!cond) failed++;
  console.log((cond ? "ok   " : "FAIL ") + name + (!cond && extra ? "\n       -> " + String(extra).slice(-1500) : ""));
}

async function main() {
  const mock = createMockProvider();
  const baseUrl = await mock.listen();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "closeni-code-e2e-"));
  const providers = path.join(tmp, "providers");
  const workspace = path.join(tmp, "workspace");
  const shots = process.argv[3] ? path.resolve(process.argv[3]) : path.join(tmp, "shots");
  fs.mkdirSync(providers);
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(providers, "mock.json"), JSON.stringify({
    id: "mock",
    name: "Mock Provider",
    kind: "web",
    baseUrl: baseUrl,
    requiresLogin: false,
    enabled: false,
    selectors: { chatInput: "#input", sendButton: "#send", stopButton: "#nonexistent-stop", assistantMessage: ".assistant-msg" },
    completionRules: { waitForStopButtonDisappear: false, maxWaitMs: 30000 },
    profileDir: path.join(tmp, "profile"),
  }));
  fs.writeFileSync(path.join(workspace, "calc.py"), "def add(a, b):\n    return a - b\n");
  mock.setReplies([
    "Let me read it.\n\n" + F + "\n{\"tool\": \"read\", \"path\": \"calc.py\"}\n" + F,
    F + "\n{\"tool\": \"edit\", \"path\": \"calc.py\"}\n---\n<<<<<<< SEARCH\n    return a - b\n=======\n    return a + b\n>>>>>>> REPLACE\n" + F,
    "Fixed: add() now adds.",
  ]);

  const env = Object.assign({}, process.env, {
    AGENT_PROVIDER_DIR: providers,
    CLOSENI_STORAGE: path.join(tmp, "storage"),
    CLOSENI_NODE: process.execPath,
    QT_FORCE_STDERR_LOGGING: "1",
  });
  if (!env.QT_QPA_PLATFORM) env.QT_QPA_PLATFORM = "offscreen";

  const proc = spawn(exe, ["--self-test", shots, "--start", "--provider", "mock", "--workspace", workspace], { env: env });
  let out = "";
  proc.stdout.on("data", (d) => { out += d; });
  proc.stderr.on("data", (d) => { out += d; });
  const timer = setTimeout(() => { out += "\n(timed out)"; proc.kill(); }, 300000);
  const code = await new Promise((resolve) => proc.on("close", resolve));
  clearTimeout(timer);

  const said = (s) => out.indexOf("self-test: code e2e: " + s) !== -1;
  check("the session comes up from the panel", said("ready"), out);
  check("enter in the prompt sends the request", said("sent"), out);
  check("the edit asks in the transcript", said("permission"), out);
  check("allow lets the turn finish", said("done"), out);
  check("the model's answer is shown", said("the answer is shown"), out);
  check("the file is fixed on disk", /return a \+ b/.test(fs.readFileSync(path.join(workspace, "calc.py"), "utf-8")));
  check("the self-test exits cleanly with no warnings", code === 0, "exit " + code + "\n" + out);

  await mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? failed + " failed" : "all passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
