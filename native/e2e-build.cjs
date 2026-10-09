/*
 * The Build flow end to end through the native UI, against the e2e suite's
 * mock provider: the app loads native/tests/ui/BuildFlow.qml with --ui-script,
 * which describes an app in Chat, generates the plan, builds it, runs the
 * result in the run console, sends it input, opens its address "in the
 * browser" (main.cpp stubs the browser under --ui-script and prints the
 * address), then stops and closes it. Screenshots of each screen in three
 * themes are saved along the way.
 *
 *   node native/e2e-build.cjs [path/to/CloseNI] [screenshot dir]
 *
 * This driver queues the provider's replies as the script announces each
 * stage, and checks what only the outside can see: the files on disk, the
 * saved run command and the addresses handed to the browser. Storage, the
 * workspace and the provider config are temporary, so no real profile is
 * touched. Needs a built agent (npm run build) and Playwright's Chromium.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMockProvider } = require("../local-agent/test/mock-provider.cjs");

const root = path.join(__dirname, "..");
const exe = process.argv[2] || path.join(root, "build-native", "bin", process.platform === "win32" ? "CloseNI.exe" : "CloseNI");
const F = "```";

let failed = 0;
function check(name, cond, extra) {
  if (!cond) failed++;
  console.log((cond ? "ok   " : "FAIL ") + name + (!cond && extra ? "\n       -> " + String(extra).slice(0, 800) : ""));
}

// A server on a free port that says hello, prints its address, and echoes
// stdin back so the console's input line can be checked.
const APP = [
  "import http.server, sys, threading",
  "",
  "class Hello(http.server.BaseHTTPRequestHandler):",
  "    def do_GET(self):",
  "        self.send_response(200)",
  "        self.end_headers()",
  "        self.wfile.write(b'hello')",
  "",
  "def echo():",
  "    for line in sys.stdin:",
  "        print('got: ' + line.strip(), flush=True)",
  "",
  "server = http.server.HTTPServer(('0.0.0.0', 0), Hello)",
  "print('Serving on http://0.0.0.0:%d/' % server.server_address[1], flush=True)",
  "threading.Thread(target=echo, daemon=True).start()",
  "server.serve_forever()",
  "",
].join("\n");

const PLAN = {
  summary: "A tiny Python web server that says hello",
  steps: [
    { title: "Write the server", detail: "app.py: an http.server that answers every GET with hello and prints its address", files: ["app.py"] },
    { title: "Explain how to run it", detail: "README.md with the run command", files: ["README.md"] },
  ],
};

const REPLIES = {
  chat: ["Use Python's **http.server**: one file, `app.py`, that answers every GET with hello and prints its address when it starts."],
  plan: [F + "json\n" + JSON.stringify(PLAN) + "\n" + F],
  steps: [
    F + "json\n" + JSON.stringify({ files: [{ path: "app.py", mode: "create", content: APP }] }) + "\n" + F,
    F + "json\n" + JSON.stringify({ files: [{ path: "README.md", mode: "create", content: "# Hello\n\nRun it with `python3 app.py`.\n" }] }) + "\n" + F,
  ],
};

async function main() {
  const mock = createMockProvider();
  const baseUrl = await mock.listen();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "closeni-native-e2e-build-"));
  const providers = path.join(tmp, "providers");
  const workspace = path.join(tmp, "workspace");
  const shots = path.resolve(process.argv[3] || path.join(tmp, "shots"));
  fs.mkdirSync(providers);
  fs.mkdirSync(workspace);
  fs.mkdirSync(shots, { recursive: true });
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

  const env = Object.assign({}, process.env, {
    AGENT_PROVIDER_DIR: providers,
    CLOSENI_STORAGE: path.join(tmp, "storage"),
    CLOSENI_NODE: process.execPath,
    QT_FORCE_STDERR_LOGGING: "1",
    // No session bus: nothing reaches the real keyring, and the desktop
    // portal (which warns when another app holds the connection's ID) stays
    // out of a run that fails on any warning. tst_github does the same.
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/closeni-test-bus",
  });
  if (!env.QT_QPA_PLATFORM) env.QT_QPA_PLATFORM = "offscreen";

  const script = path.join(__dirname, "tests", "ui", "BuildFlow.qml");
  const proc = spawn(exe, ["--workspace", workspace, "--provider", "mock", "--ui-script", script, shots], { env: env });
  const lines = [];
  const stages = [];
  function onLine(line) {
    lines.push(line);
    const m = line.match(/E2E stage (.*)$/);
    if (m) {
      stages.push(m[1]);
      if (REPLIES[m[1]]) mock.setReplies(REPLIES[m[1]]);
      console.log("     stage " + m[1]);
    }
    if (/E2E (PASS|FAIL)|warning|Warning|Error|ReferenceError|TypeError/.test(line)) console.log("     " + line);
  }
  function reader(stream) {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) !== -1) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
  }
  reader(proc.stdout);
  reader(proc.stderr);

  const timer = setTimeout(() => { console.log("FAIL the UI run timed out"); proc.kill(); }, 600000);
  const code = await new Promise((resolve) => proc.on("close", resolve));
  clearTimeout(timer);

  check("the UI script passed every stage", code === 0 && lines.some((l) => /E2E PASS/.test(l)),
        "exit " + code + "; last stage " + stages[stages.length - 1] + "\n" + lines.slice(-30).join("\n"));
  check("step 1 wrote app.py", fs.existsSync(path.join(workspace, "app.py")) &&
        fs.readFileSync(path.join(workspace, "app.py"), "utf8") === APP);
  check("step 2 wrote README.md", fs.existsSync(path.join(workspace, "README.md")));
  const manifest = path.join(workspace, "closeni.run.json");
  let run = "";
  try { run = JSON.parse(fs.readFileSync(manifest, "utf8")).run || ""; } catch (e) {}
  check("the finished build saved its run command", /app\.py/.test(run), run || "no manifest at " + manifest);
  const opened = lines.map((l) => (l.match(/CloseNI: ui-script: openUrl (\S+)/) || [])[1]).filter(Boolean);
  check("Open in browser, in the run console and the Build panel, handed the server's address over",
        opened.length === 2 && opened.every((u) => /^http:\/\/localhost:\d+\/$/.test(u)), JSON.stringify(opened));
  const names = ["chat", "plan", "build", "run"];
  const missing = [];
  names.forEach((n) => ["terminal", "paper", "pixel"].forEach((t) => {
    const f = path.join(shots, "build-" + n + "-" + t + ".png");
    if (!fs.existsSync(f) || fs.statSync(f).size < 1000) missing.push(path.basename(f));
  }));
  check("twelve screenshots saved to " + shots, missing.length === 0, "missing " + missing.join(", "));

  await mock.close();
  fs.rmSync(path.join(tmp, "storage"), { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
  console.log(failed ? failed + " failed" : "all passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
