import * as path from "path";
import * as fs from "fs";
import { defaultStorageRoot } from "./storage-paths.js";
import { rl, emit } from "./cli-io.js";
import { agentSessionMode, agentOnceMode } from "./modes/agent.js";
import { buildSessionMode, buildMode } from "./modes/build.js";
import { chatMode, planMode, askMode, revisePlanMode } from "./modes/chat-plan.js";
import { behaviourMode, testAllMode } from "./modes/checks.js";
import { webtestMode, smokeMode, healthMode, authCheckMode, signinMode, suggestMode } from "./modes/provider-checks.js";
import { researchMode } from "./modes/research.js";

// The desktop app spills oversized arguments to a temp file to stay under the
// command-line length limit and passes the path instead. Read those back, or the
// prompt the model receives is literally a filename.
const SPILL_FILE = /agent-prompt-\d+-\d+\.txt$/;

function resolveArg(arg: string | undefined): string {
  if (!arg) return "";
  if (!SPILL_FILE.test(arg)) return arg;
  try {
    if (!fs.statSync(arg).isFile()) return arg;
    return fs.readFileSync(arg, "utf-8");
  } catch {
    return arg;
  }
}

async function main() {
  // Point a CLI run at the same storage the desktop app uses.
  //
  // Without this, storagePaths falls back to the shipped relative profileDir
  // and a CLI looks at a browser profile nobody has ever signed in to - which
  // is exactly what made the first live smoke run report "not signed in" while
  // the app reported the opposite, minutes apart, on the same machine.
  //
  // Skipped when AGENT_PROVIDER_DIR is set: that means fixture providers, and a
  // run pointed at fixture providers must keep fixture storage. The end-to-end
  // suite depends on it.
  if (!process.env.CLOSENI_STORAGE && !process.env.AGENT_PROVIDER_DIR) {
    const root = defaultStorageRoot();
    if (root) process.env.CLOSENI_STORAGE = root;
  }

  const args = process.argv.slice(2);
  const mode = args[0] || "browser";
  const prompt = resolveArg(args[1]);
  const workspace = args[2] || path.resolve(process.cwd());
  const providerId = args[3] || "deepseek";
  const autonomy = args[4] || "ask";
  const stepIndex = args[5] ? parseInt(args[5]) : -1;
  const stepDetail = resolveArg(args[6]);
  const goalSummary = resolveArg(args[7]);

  try {
    if (mode === "chat") await chatMode(prompt, providerId, workspace);
    else if (mode === "plan") await planMode(prompt, workspace, providerId);
    else if (mode === "revise") await revisePlanMode(prompt, workspace, providerId);
    else if (mode === "testall") await testAllMode(workspace);
    // Positional layout: workspace only.
    else if (mode === "behaviour") await behaviourMode(args[1] || workspace);
    else if (mode === "research") await researchMode(prompt, workspace, providerId);
    // Positional layout differs from the other modes: workspace and provider
    // come straight after the mode, because there is no per-step prompt.
    else if (mode === "smoke") await smokeMode(args[1] || "deepseek");
    // Positional layout: deepseek|qwen|glm|all, then flags (--headed).
    else if (mode === "webtest") await webtestMode(args[1] || "all", args.slice(2));
    else if (mode === "health") await healthMode(args[1] || "deepseek", args[2] || "");
    else if (mode === "build-session") await buildSessionMode(args[1] || path.resolve(process.cwd()), args[2] || "deepseek", args[3] || "auto");
    // Positional layout: workspace, provider, step index, suggestion text.
    else if (mode === "signin") await signinMode(args[1] || "deepseek");
    // Positional layout: provider, workspace.
    else if (mode === "authcheck") await authCheckMode(args[1] || "deepseek", args[2] || "");
    else if (mode === "suggest") await suggestMode(args[1] || path.resolve(process.cwd()), args[2] || "deepseek", args[3] ? parseInt(args[3]) : 0, resolveArg(args[4]));
    // Positional layout: workspace, provider, mode (default|acceptEdits|plan|auto).
    else if (mode === "agent-session") await agentSessionMode(args[1] || path.resolve(process.cwd()), args[2] || "deepseek", args[3] || "default");
    // Positional layout like chat: prompt, workspace, provider, then mode.
    else if (mode === "agent") await agentOnceMode(prompt, workspace, providerId, args[4] || "default");
    else if (mode === "ask") await askMode(args[1] || path.resolve(process.cwd()), args[2] || "deepseek", resolveArg(args[3]), resolveArg(args[4]), resolveArg(args[5]));
    else await buildMode(prompt, workspace, providerId, autonomy, stepIndex, stepDetail, goalSummary);
  } catch (e: any) {
    emit({ success: false, error: e.message });
  }
}

main()
  .catch((e) => emit({ success: false, error: String(e) }))
  .finally(() => rl.close());
