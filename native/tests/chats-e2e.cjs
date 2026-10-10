/*
 * The rail's conversations end to end, against the e2e suite's mock provider:
 * the app loads native/tests/ui/ChatsFlow.qml with --ui-script, which makes two
 * chats, switches between them, continues one, tries to change chat while a
 * reply is on its way, renames one and removes the other. Then the app is
 * started again on the same storage, and the open chat must come back with
 * its messages and name (phase=restore).
 *
 *   node native/tests/chats-e2e.cjs [path/to/CloseNI] [screenshot dir]
 *
 * This driver queues one reply per message and checks what only the outside
 * can see: which provider thread each message went to, and what sessions.json
 * and the transcript files hold. Storage, the workspace and the provider config
 * are temporary. Needs a built agent (npm run build) and Playwright's Chromium.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMockProvider } = require("../../local-agent/test/mock-provider.cjs");

const root = path.join(__dirname, "..", "..");
const exe = process.argv[2] || path.join(root, "build-native", "bin", process.platform === "win32" ? "CloseNI.exe" : "CloseNI");

let failed = 0;
function check(name, cond, extra) {
  if (!cond) failed++;
  console.log((cond ? "ok   " : "FAIL ") + name + (!cond && extra ? "\n       -> " + String(extra).slice(0, 800) : ""));
}

// One reply per message the flow sends, queued as its stage is announced.
const REPLIES = {
  send1: ["Tags as a list on each todo, filtered from a sidebar."],
  send2: ["One file, **weather.py**, that reads a city and prints the forecast."],
  continue: ["Store a due date per todo and sort by it."],
  guard: ["A dark theme follows the system setting."],
};

function runApp(env, args) {
  const proc = spawn(exe, args, { env: env });
  const lines = [];
  const stages = [];
  function onLine(line) {
    lines.push(line);
    const m = line.match(/E2E stage (.*)$/);
    if (m) {
      stages.push(m[1]);
      if (REPLIES[m[1]]) env.__mock.setReplies(REPLIES[m[1]]);
      console.log("     stage " + m[1]);
    }
    if (/E2E (PASS|FAIL|LOG)|warning|Warning|Error|ReferenceError|TypeError/.test(line)) console.log("     " + line);
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
  return new Promise((resolve) => proc.on("close", (code) => {
    clearTimeout(timer);
    resolve({ code: code, lines: lines, stages: stages });
  }));
}

async function main() {
  const mock = createMockProvider();
  const baseUrl = await mock.listen();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "closeni-native-chats-"));
  const providers = path.join(tmp, "providers");
  const workspace = path.join(tmp, "workspace");
  const storage = path.join(tmp, "storage");
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
    CLOSENI_STORAGE: storage,
    CLOSENI_NODE: process.execPath,
    QT_FORCE_STDERR_LOGGING: "1",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/closeni-test-bus",
  });
  if (!env.QT_QPA_PLATFORM) env.QT_QPA_PLATFORM = "offscreen";
  Object.defineProperty(env, "__mock", { value: mock, enumerable: false });

  const script = path.join(__dirname, "ui", "ChatsFlow.qml");
  const args = ["--workspace", workspace, "--provider", "mock", "--ui-script", script];
  const run = await runApp(env, args.concat([shots]));
  check("the UI script passed every stage", run.code === 0 && run.lines.some((l) => /E2E PASS/.test(l)),
        "exit " + run.code + "; last stage " + run.stages[run.stages.length - 1] + "\n" + run.lines.slice(-30).join("\n"));

  // Thread 1 is the first chat: its first message, then the two sent after
  // switching back to it. Thread 2 had only the second chat's message.
  const t1 = mock.promptsForThread("1").join("\n---\n");
  const t2 = mock.promptsForThread("2").join("\n---\n");
  check("the first chat's messages all went to its own thread",
        /todo app with tags/.test(t1) && /Add due dates/.test(t1) && /dark theme/.test(t1) && !/weather/.test(t1), t1.slice(0, 600));
  check("the second chat had a thread of its own", /weather CLI/.test(t2) && !/due dates/.test(t2), t2.slice(0, 600));
  check("no message went to a third thread", mock.threadCount() === 2, "threads " + mock.threadCount());

  let entry = {};
  try { entry = JSON.parse(fs.readFileSync(path.join(storage, "sessions.json"), "utf8"))[workspace] || {}; } catch (e) {}
  check("sessions.json lists the one chat left, open and renamed",
        (entry.chats || []).length === 1 && entry.chats[0].title === "Todo app" && entry.activeChat === entry.chats[0].url
        && entry.chats[0].provider === "mock", JSON.stringify(entry));
  const files = fs.existsSync(path.join(storage, "chats")) ? fs.readdirSync(path.join(storage, "chats")) : [];
  let kept = {};
  try { kept = JSON.parse(fs.readFileSync(path.join(storage, "chats", files[0]), "utf8")).chats || {}; } catch (e) {}
  check("only the open chat's transcript is kept", files.length === 1 && Object.keys(kept).length === 1
        && (kept[entry.activeChat] || {}).messages.length === 6, JSON.stringify(Object.keys(kept)));

  const again = await runApp(env, args.concat(["phase=restore", shots]));
  check("a restart brings the open chat back", again.code === 0 && again.lines.some((l) => /E2E PASS/.test(l)),
        "exit " + again.code + "; last stage " + again.stages[again.stages.length - 1] + "\n" + again.lines.slice(-30).join("\n"));

  const missing = ["list", "open"].flatMap((w) => ["terminal", "pixel"].map((t) => "chats-" + w + "-" + t + ".png"))
    .filter((f) => !fs.existsSync(path.join(shots, f)) || fs.statSync(path.join(shots, f)).size < 1000);
  check("4 screenshots saved to " + shots, missing.length === 0, "missing " + missing.join(", "));

  await mock.close();
  fs.rmSync(storage, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(path.join(tmp, "profile"), { recursive: true, force: true });
  console.log(failed ? failed + " failed" : "all passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
