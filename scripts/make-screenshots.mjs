/*
 * Capture the docs screenshots from the native app itself.
 *
 *   node scripts/make-screenshots.mjs [build dir]
 *
 * The build dir defaults to build-native (cmake -S native -B build-native).
 * Every shot comes from a run the tests already make, offscreen, against the
 * e2e suite's mock provider and the GitHub mock, with temporary storage and
 * workspaces, so no real profile or account is touched:
 *
 *   - native/e2e-build.cjs: Chat, Plan and Build after a real build;
 *   - native/tests/code-e2e.cjs: the Code panel with an edit waiting to be allowed;
 *   - the ship_ui test: the Test and Push panels with mock runs and a repository;
 *   - CloseNI --self-test: Settings.
 *
 * The shots are copied into docs/screenshots/ under the names the README, the
 * landing page and the site link to. Needs a built agent (npm run build) and
 * Playwright's Chromium, as the e2e runs do.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const repo = path.resolve(import.meta.dirname, "..");
const build = path.resolve(process.argv[2] || path.join(repo, "build-native"));
const exe = path.join(build, "bin", process.platform === "win32" ? "CloseNI.exe" : "CloseNI");
const out = path.join(repo, "docs", "screenshots");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "closeni-screenshots-"));
if (!fs.existsSync(exe)) throw new Error("no CloseNI at " + exe + "; build it first");

const env = Object.assign({}, process.env, {
  QT_QPA_PLATFORM: "offscreen",
  QT_FORCE_STDERR_LOGGING: "1",
  CLOSENI_STORAGE: path.join(tmp, "storage"),
});

function run(what, cmd, args) {
  console.log("-- " + what);
  const r = spawnSync(cmd, args, { cwd: repo, env: env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (r.status !== 0) {
    console.log((r.stdout + r.stderr).split("\n").slice(-40).join("\n"));
    throw new Error(what + " failed (exit " + r.status + ")");
  }
}

const dirs = { build: path.join(tmp, "build"), code: path.join(tmp, "code"), self: path.join(tmp, "self") };
run("Build flow", process.execPath, [path.join(repo, "native", "e2e-build.cjs"), exe, dirs.build, "pixel,paper,phosphor,cassette-indigo"]);
run("Code panel", process.execPath, [path.join(repo, "native", "tests", "code-e2e.cjs"), exe, dirs.code]);
run("Test and Push panels", "ctest", ["--test-dir", build, "-R", "^ship_ui$", "--output-on-failure"]);
run("Settings", exe, ["--self-test", dirs.self]);

const ship = path.join(build, "tests", "ship-ui");
const shots = {
  "code.png": path.join(dirs.code, "code-e2e.png"),
  "chat.png": path.join(dirs.build, "build-chat-pixel.png"),
  "builder.png": path.join(dirs.build, "build-build-pixel.png"),
  "test.png": path.join(ship, "ship-test-pixel.png"),
  "ship.png": path.join(ship, "ship-push-paper.png"),
  "settings.png": path.join(dirs.self, "settings-paper.png"),
  "theme-paper.png": path.join(dirs.build, "build-build-paper.png"),
  "theme-phosphor.png": path.join(dirs.build, "build-build-phosphor.png"),
  "theme-cassette.png": path.join(dirs.build, "build-chat-cassette-indigo.png"),
};
fs.mkdirSync(out, { recursive: true });
for (const [name, from] of Object.entries(shots)) {
  fs.copyFileSync(from, path.join(out, name));
  console.log("wrote docs/screenshots/" + name);
}
fs.rmSync(tmp, { recursive: true, force: true });
