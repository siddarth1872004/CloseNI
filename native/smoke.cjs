/*
 * Smoke test for the native app: start it against the e2e suite's mock
 * provider and check that the agent session comes up.
 *
 *   node native/smoke.cjs [path/to/CloseNI]
 *
 * Needs a built agent (npm run build) and Playwright's Chromium. Storage and the
 * provider config go in temporary directories, so no real profile is touched.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMockProvider } = require("../local-agent/test/mock-provider.cjs");

const root = path.join(__dirname, "..");
const exe = process.argv[2] || path.join(root, "build-native", "bin", process.platform === "win32" ? "CloseNI.exe" : "CloseNI");

async function main() {
  const mock = createMockProvider();
  const baseUrl = await mock.listen();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "closeni-native-smoke-"));
  const providers = path.join(tmp, "providers");
  const workspace = path.join(tmp, "workspace");
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

  const env = Object.assign({}, process.env, {
    AGENT_PROVIDER_DIR: providers,
    CLOSENI_STORAGE: path.join(tmp, "storage"),
    CLOSENI_NODE: process.execPath,
  });
  // No display needed unless one is asked for.
  if (!env.QT_QPA_PLATFORM) env.QT_QPA_PLATFORM = "offscreen";

  const proc = spawn(exe, ["--exit-on-ready", "--provider", "mock", "--workspace", workspace], { env: env });
  let out = "";
  proc.stdout.on("data", (d) => { out += d; });
  proc.stderr.on("data", (d) => { out += d; });
  const timer = setTimeout(() => proc.kill(), 120000);
  const code = await new Promise((resolve) => proc.on("close", resolve));
  clearTimeout(timer);
  await mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  const ready = /CloseNI: agent ready .*"provider":"Mock Provider"/.test(out);
  console.log(out.trim());
  console.log(ready && code === 0 ? "ok   the native app starts the agent session" : "FAIL the native app did not report ready (exit " + code + ")");
  process.exit(ready && code === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
