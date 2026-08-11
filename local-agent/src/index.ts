import * as path from "path";
import * as fs from "fs";
import * as readline from "readline";
import { parseMarkdownToEditPlan } from "./parser/patch-parser.js";
import { parsePlanRobust } from "./parser/json-repair.js";
import { applyPatch } from "./patch/patch-applier.js";
import { PlaywrightController, ProviderConfig } from "./providers/playwright-controller.js";
import { ProviderRegistry } from "./providers/provider-registry.js";
import { runCommand, normalizeCommand } from "./verification/command-runner.js";
import { planChecksForWorkspace } from "./verification/check-planner.js";
import { needsConfirmation, isEnvironmentSetup, isGeneratedFile, GENERATED_FILES } from "./verification/command-policy.js";
import { createMutex, createPool } from "./async-pool.js";
import { decideApproval } from "./verification/approval-policy.js";
import { getProjectContext } from "./context/context-engine.js";
import { selectRelevantFiles, WorkspaceFile } from "./context/relevance.js";
import { computeDelta, nextLedger } from "./context/delta.js";
import { buildApplyFollowUp } from "./follow-up.js";
import { planBehaviourChecks, judge as judgeBehaviour } from "./verification/behaviour-checker.js";
import { resolveTool } from "./verification/toolchain.js";
import { MANIFEST_NAME } from "./run-manifest.js";
import { Checkpoint, mergeCheckpoint, sealCheckpoint, checkpointName, CHECKPOINT_DIR } from "./checkpoint.js";
import { BUILD_STATE_DIR } from "./build-state.js";

// Every extension the check planner knows about. A file the walker misses is a
// file nothing ever verifies, and the run reports success on it regardless.
const SOURCE_FILE = /\.(py|pyw|js|cjs|mjs|ts|tsx|jsx|rs|go|java|c|h|cpp|hpp|cc|cxx|rb|php|sh|bash|cs)$/;

const rl = readline.createInterface({ input: process.stdin, terminal: false });
const lineQueue: string[] = [];
let lineWaiter: ((l: string) => void) | null = null;
// Build sessions take their commands on the same stdin the approval flow reads.
// A second reader would mean step commands land in the approval queue and the
// next askApproval would parse one, find no `approved` field, and deny the
// command. One reader, dispatching by content, avoids that entirely.
let sessionLineHandler: ((line: string) => boolean) | null = null;
rl.on("line", (line) => {
  if (sessionLineHandler && sessionLineHandler(line)) return;
  if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(line); }
  else lineQueue.push(line);
});
rl.on("close", () => {
  if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w('{"approved":false}'); }
});
function readLine(): Promise<string> {
  if (lineQueue.length) return Promise.resolve(lineQueue.shift()!);
  return new Promise((res) => (lineWaiter = res));
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function askApproval(command: string, cwd: string, autonomy: string): Promise<boolean> {
  const decision = decideApproval(autonomy);
  if (decision === "allow") return true;
  // A policy denial takes the same path as a user denial, so the caller's
  // COMMAND_DENIED log and the self-heal path treat both identically.
  if (decision === "deny") return false;
  console.log("APPROVAL_REQUEST:" + JSON.stringify({ command: command, cwd: cwd }));
  const line = await readLine();
  try { return !!JSON.parse(line).approved; } catch { return false; }
}

function projLog(text: string) {
  for (const l of text.split("\n")) console.log("PROJ|" + l);
}

function emit(obj: any) {
  console.log("AGENT_OUTPUT_START");
  console.log(JSON.stringify(obj));
  console.log("AGENT_OUTPUT_END");
}

function capText(t: string, n: number): string {
  return t.length > n ? t.slice(t.length - n) : t;
}

const REASK_PROMPT = "Your previous reply was not machine-readable. Reply again with ONLY the JSON object, wrapped in a \`\`\`json code block. No explanations, no extra text.";

/**
 * The re-ask after a step produced no readable files.
 *
 * Repeating "send JSON" to a model that just failed to send JSON tends to
 * produce the same reply again. Offering the per-file code-block format gives
 * it a way out that the parser reads natively, which is usually what breaks
 * the loop.
 */
const REASK_FILES_PROMPT =
  "That reply did not contain file changes I could read. Send the files again, " +
  "either as one \`\`\`json block in the {\"files\":[{\"path\",\"mode\",\"content\"}]} format, " +
  "or as one code block per file with the path on the fence line, like \`\`\`python src/app.py. " +
  "Write each file completely - no ellipses and no '... rest unchanged'. No other text.";

async function openProvider(providerId: string, fresh: boolean = false, workspace: string = "") {
    const registry = new ProviderRegistry();
    registry.loadProviders();
    const config = registry.getUsableProvider(providerId);
    if (!config) throw new Error("Provider not found: " + providerId);
    const controller = new PlaywrightController(config);
    controller.setWorkspace(workspace);
    await controller.launch(config);
    // `resumed` tells the caller whether the model can still see the earlier
    // messages. Planning uses it to decide whether the transcript has to be
    // repeated in the prompt, so a failed resume costs a longer prompt rather
    // than a plan written with no idea what was discussed.
    let resumed = false;
    if (fresh) await controller.navigateFresh(config);
    else resumed = await controller.navigateToChat(config);
    await controller.waitForLogin();
  return { controller: controller, config: config, resumed: resumed };
}

/**
 * Chat, plan and build all run in one conversation.
 *
 * The build used to open a thread of its own, which meant every step prompt had
 * to carry the plan, the file tree and the format rules into a model that had
 * never seen any of it - step 1 of a fifteen-step build came to 9853 characters
 * and spent the entire completion wait being read rather than answered.
 *
 * Continuing the thread that already holds the discussion and the plan is both
 * what a person would do and dramatically less to send. The cost is that a
 * conversation has one composer, so steps run one at a time; buildSessionMode
 * enforces that.
 *
 * resetBuildRunForWorkspace still runs on the first step. It clears the ledger
 * of which files the thread has been shown - and only that, plus the now-unused
 * build thread; activeChat is untouched, which is what lets the conversation
 * survive the reset. Starting a build after New Chat means the thread really is
 * empty, so re-sending the context is the safe default; the cost when the
 * thread is the same one is a little repetition on step 1.
 */
async function openProviderForBuild(providerId: string, workspace: string, isFirstStep: boolean) {
  const registry = new ProviderRegistry();
  registry.loadProviders();
  const config = registry.getUsableProvider(providerId);
  if (!config) throw new Error("Provider not found: " + providerId);
  const controller = new PlaywrightController(config);
  controller.setWorkspace(workspace);
  // "chat", not "build": one conversation, tracked in one place.
  controller.setThreadKind("chat");
  await controller.launch(config);
  if (isFirstStep) controller.resetBuildRunForWorkspace();
  const resumed = await controller.navigateToChat(config);
  console.log(resumed
    ? "Building in the existing conversation (it already has the plan)."
    : "No conversation to continue - building in a new one.");
  await controller.waitForLogin();
  return { controller: controller, config: config, resumed: resumed };
}

async function chatMode(prompt: string, providerId: string, workspace: string = "") {
  // Resume, do not restart. This used to force a fresh thread on every single
  // message, so the model never saw what was said a moment earlier and each
  // turn had to be made self-contained. "New Chat" clears the saved thread,
  // which is the supported way to start over.
  const { controller, config } = await openProvider(providerId, false, workspace);
  try {
    const prevCount = await controller.countMessages(config);
    const prevContent = await controller.getLastMessageText(config);
    await controller.sendPrompt("You are in normal conversation mode. Answer with brief descriptions and high-level architecture. Do NOT include full code implementations unless explicitly asked. Use markdown for formatting.\n\nUser message:\n" + prompt, config);
    await controller.waitForResponse(config, prevCount, prevContent);
    let answer = "";
    for (let i = 0; i < 4 && answer.trim().length < 2; i++) {
      if (i > 0) await sleep(1500);
      answer = await controller.getLastMessageStructured(config);
      if (answer.trim().length < 2) answer = await controller.getLastMessageInnerText(config);
    }
    emit({ success: true, answer: answer });
  } finally { await controller.close(); }
}

async function planMode(transcript: string, workspace: string, providerId: string) {
  transcript = capText(transcript, 8000);
  const ctx = getProjectContext(workspace, transcript);
  const instructions = "Create an implementation plan as JSON:\n" +
    "{\"summary\":\"goal\",\"runCommand\":\"how to run the finished project\",\"steps\":[{\"title\":\"\",\"detail\":\"\",\"files\":[\"path\"],\"dependsOn\":[]}]}" +
    "Rules: as many steps as the work genuinely needs - a one-file script might be 2, " +
    "a full application with a database, API and UI might be 20 or more. Never pad, never compress. " +
    "Each step must touch a different set of files. Wrap in \`\`\`json.\n" +
    "runCommand is the single command that starts the finished project, e.g. \"python3 src/app/server.py\".\n" +
    "dependsOn lists the earlier steps this one builds on, as ZERO-BASED positions in " +
    "the steps array: the first step is 0, the second is 1. A step that needs nothing lists []. " +
    "Do not use the step's printed number. " +
    "Be accurate: steps with no declared dependency between them may run at the same time.\n\n" +
    "Project:\n" + ctx.tree;

  const { controller, config, resumed } = await openProvider(providerId, false, workspace);
  // Replaying the transcript into a thread that already contains it doubled the
  // prompt for no gain - and a prompt that size is what pushed generation past
  // the completion wait, so the plan came back truncated and unparseable. Only
  // send it when the thread could not be resumed and the model has no history.
  const prompt = resumed
    ? instructions + "\n\nPlan the project we have been discussing in this conversation."
    : instructions + "\n\nChat:\n" + transcript;
  console.log(resumed
    ? "Planning in the existing conversation (prompt " + prompt.length + " chars)."
    : "No thread to resume - replaying the transcript (prompt " + prompt.length + " chars).");
  try {
    let prevCount = await controller.countMessages(config);
    let prevContent = await controller.getLastMessageText(config);
    await controller.sendPrompt(prompt, config);
    let response = await controller.waitForResponse(config, prevCount, prevContent);
    let plan = parsePlanRobust(response);
    if (!plan) {
      console.log("Plan parse failed; asking AI to resend clean JSON...");
      prevCount = await controller.countMessages(config);
      prevContent = await controller.getLastMessageText(config);
      await controller.sendPrompt(REASK_PROMPT, config);
      response = await controller.waitForResponse(config, prevCount, prevContent);
      plan = parsePlanRobust(response);
    }
    if (plan && plan.steps) emit({ success: true, plan: plan });
    else emit({ success: false, error: "Could not parse plan.", raw: response });
  } finally { await controller.close(); }
}

/**
 * Answer a question about a run, and apply a fix if one is offered.
 *
 * The command and its output travel with the question, so nobody has to paste a
 * traceback into a box sitting beneath that same traceback. It reuses the build
 * thread for the reason suggestMode does: a fresh chat would answer confidently
 * with none of the project in view.
 */
async function askMode(workspace: string, providerId: string, question: string, command: string, output: string) {
  const registry = new ProviderRegistry();
  registry.loadProviders();
  const config = registry.getUsableProvider(providerId);
  if (!config) { emit({ success: false, error: "Provider not found: " + providerId }); return; }

  const controller = new PlaywrightController(config);
  controller.setWorkspace(workspace);
  controller.setThreadKind("chat");

  if (!controller.describeSavedThread(workspace)) {
    emit({ success: false, error: "No conversation for this workspace yet. Build a project before asking about a run." });
    return;
  }

  await controller.launch(config);
  try {
    const resumed = await controller.navigateToChat(config);
    if (!resumed) {
      emit({ success: false, error: "The conversation could not be reopened, so there is no context to answer against." });
      return;
    }
    await controller.waitForLogin();

    const detail =
      "The user ran this command against the project you built:\n\n" +
      "$ " + command + "\n\n" + capText(output, 4000) +
      "\n\nTheir question: " + question +
      "\n\nAnswer plainly. If a file change would fix it, reply with the JSON file-change format " +
      "using mode \"overwrite\" and full file contents. If no change is needed, just explain - do not invent one.";

    const outcome = await runBuildStep(controller, config, {
      prompt: question,
      workspace: workspace,
      autonomy: "auto",
      stepIndex: 0,
      stepDetail: detail,
      goalSummary: "",
      allowNoChanges: true,
    });
    emit({
      success: outcome.success,
      answer: outcome.raw || "",
      appliedFiles: outcome.appliedFiles || [],
      error: outcome.error,
    });
  } finally {
    await controller.close();
  }
}

async function revisePlanMode(changes: string, workspace: string, providerId: string) {
  const prompt = "Update plan with: " + changes +
    "\n\nJSON format: {\"summary\":\"\",\"runCommand\":\"how to run the finished project\",\"steps\":[{\"title\":\"\",\"detail\":\"\",\"files\":[\"\"],\"dependsOn\":[]}]}\n" +
    "As many steps as the work needs - never pad, never compress. Different files per step.\n" +
    "dependsOn lists earlier steps this one builds on, as ZERO-BASED positions in the " +
    "steps array (first step is 0); [] if it needs nothing. Not the printed step number.";
  // "Update plan with X" only means anything in the thread that holds the plan.
  // Sent to a fresh chat it asked the model to revise something it had never
  // seen, which is why revisions came back as unrelated plans.
  const { controller, config } = await openProvider(providerId, false, workspace);
  try {
    let prevCount = await controller.countMessages(config);
    let prevContent = await controller.getLastMessageText(config);
    await controller.sendPrompt(prompt, config);
    let response = await controller.waitForResponse(config, prevCount, prevContent);
    let plan = parsePlanRobust(response);
    if (!plan) {
      prevCount = await controller.countMessages(config);
      prevContent = await controller.getLastMessageText(config);
      await controller.sendPrompt(REASK_PROMPT, config);
      response = await controller.waitForResponse(config, prevCount, prevContent);
      plan = parsePlanRobust(response);
    }
    if (plan && plan.steps) emit({ success: true, plan: plan });
    else emit({ success: false, error: "Could not parse revised plan.", raw: response });
  } finally { await controller.close(); }
}

function walk(dir: string, out: string[]) {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (["node_modules", ".git", ".agent-backups", "__pycache__", "dist", "build", "venv", "env"].indexOf(e.name) !== -1) continue;
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (SOURCE_FILE.test(e.name)) out.push(p);
  }
}

/**
 * Run the project, not just compile it.
 *
 * testall answers "does this parse". This answers "does this work": the
 * project's own test suite if it has one, and a smoke run of whatever
 * closeni.run.json says starts it.
 *
 * Deliberately never invents a test command. A project with no suite reports
 * that it has none - claiming a pass for tests that do not exist would be worse
 * than saying nothing, because it is the number people would trust.
 */
async function behaviourMode(workspace: string) {
  let rootEntries: string[] = [];
  try { rootEntries = fs.readdirSync(workspace); } catch { /* unreadable root */ }

  const readManifest = (file: string): any => {
    try { return JSON.parse(fs.readFileSync(path.join(workspace, file), "utf-8")); }
    catch { return null; }
  };

  // The run command the build recorded, if any. Named apart from the imported
  // runCommand(): shadowing it made the smoke run call a string.
  let projectRun: string | null = null;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(workspace, MANIFEST_NAME), "utf-8"));
    projectRun = typeof m.run === "string" && m.run.trim() ? m.run.trim() : null;
  } catch { /* no manifest, no smoke check */ }

  const checks = planBehaviourChecks(rootEntries, readManifest, resolveTool, projectRun);
  if (!checks.length) {
    emit({
      success: true, passed: 0, failed: 0, results: [],
      note: "Nothing to run: this project declares no test suite and no run command.",
    });
    return;
  }

  const results: { command: string; kind: string; success: boolean; language: string; detail: string }[] = [];
  let pass = 0; let fail = 0; let skipped = 0;

  for (const c of checks) {
    // A suite that exists but cannot be run is reported, not counted. Treating
    // it as a pass would be the false confidence this mode exists to remove;
    // treating it as a failure would blame the project for the machine.
    if (c.available === false) {
      console.log("SKIPPED_TEST: " + c.command + " (" + c.tool + " is not installed)");
      results.push({ command: c.command, kind: c.kind, success: false, language: c.language,
        detail: "not run: " + c.tool + " is not installed" });
      skipped++;
      continue;
    }
    // A run command can be anything the model wrote, so it goes through the
    // same floor as any other command rather than being trusted for being ours.
    if (needsConfirmation(c.command)) {
      console.log("COMMAND_NEEDS_REVIEW: " + c.command);
      results.push({ command: c.command, kind: c.kind, success: false, language: c.language,
        detail: "skipped: needs confirmation" });
      continue;
    }
    console.log("RUNNING_" + c.kind.toUpperCase() + ": " + c.command);
    const r = await runCommand(c.command, workspace, c.timeoutMs);
    const verdict = judgeBehaviour(c, { success: r.success, timedOut: !!r.timedOut });
    console.log((verdict.passed ? "PASS " : "FAIL ") + c.kind + ": " + verdict.detail);
    if (r.output) projLog(r.output.slice(0, 2000));
    results.push({ command: c.command, kind: c.kind, success: verdict.passed, language: c.language, detail: verdict.detail });
    if (verdict.passed) pass++; else fail++;
  }

  emit({
    success: fail === 0, passed: pass, failed: fail, skipped: skipped, results: results,
    // Said explicitly, because "0 failed" on a project whose suite never ran is
    // the most misleading number this could report.
    note: skipped ? skipped + " check(s) could not run; install the tool named above to include them." : undefined,
  });
}

async function testAllMode(workspace: string) {
  const files: string[] = [];
  walk(workspace, files);
  let pass = 0; let fail = 0;
  const results: { command: string; success: boolean; language: string }[] = [];
  // Asked once, for every file at once: a per-file question cannot see that a
  // Cargo.toml means one cargo check instead of a rustc per module.
  const checks = planChecksForWorkspace(workspace, files.map((f) => path.relative(workspace, f)));
  for (const c of checks) {
    const r = await runCommand(c.command, workspace, c.timeoutMs, { timeoutIsFailure: true });
    console.log((r.success ? "PASS " : "FAIL ") + c.command);
    // The language travels with the result so the Test panel can mark each row.
    // A row's text is a command, not a path, so it has nothing to derive it from.
    results.push({ command: c.command, success: r.success, language: c.language });
    if (r.success) pass++; else { fail++; if (r.output) projLog(r.output.slice(0, 800)); }
  }
  emit({ success: fail === 0, passed: pass, failed: fail, results: results });
}

function buildPrompt(userPrompt: string, tree: string, relevantFiles: { path: string; content: string }[], priorFiles: string[], isFirstStep: boolean): string {
  let contextStr = "";
  if (tree) contextStr += "\n\nProject Structure:\n" + tree;
  if (relevantFiles.length > 0) {
    contextStr += "\n\nRelevant Existing Files (use 'overwrite' mode with FULL content to modify them):\n";
    for (const f of relevantFiles) contextStr += "\n--- " + f.path + " ---\n" + f.content + "\n";
  }
  if (priorFiles.length > 0) {
    // After the first step the thread already holds the earlier listing, so only
    // what appeared since is worth the tokens.
    contextStr += isFirstStep
      ? "\n\nFiles ALREADY in the workspace (DO NOT recreate or collapse into these):\n"
      : "\n\nNew files since the last step (DO NOT recreate or collapse into these):\n";
    for (const f of priorFiles) contextStr += "- " + f + "\n";
  }
  // The format specification runs to about two thousand characters and used to
  // be repeated on every single step, because each step was talking to a thread
  // that had never seen it. In one conversation it is said once and then
  // referred back to, which is most of why a step prompt is now a fraction of
  // what it was. A one-line reminder still goes with each step: models drift,
  // and re-stating the shape is cheaper than a re-ask.
  if (!isFirstStep) {
    return "Next step. Same reply format as before - either the " +
      "{\"files\":[{\"path\",\"mode\",\"content\"}]} JSON block, or one code block per " +
      "file with the path on the fence line. Write every file completely; no " +
      "ellipses and no '... rest unchanged'." +
      contextStr +
      "\n\nStep:\n" + userPrompt;
  }

  return "You are an autonomous coding agent assistant.\n" +
    "Reply with the file changes. There are two accepted formats. Pick ONE.\n" +
    "\n" +
    "FORMAT A - JSON (preferred, and required if you need commands or search_replace):\n" +
    "{\n  \"files\": [\n    {\n      \"path\": \"src/hello.py\",\n      \"mode\": \"create\",\n      \"content\": \"def greet():\\n    return 'Hello'\\n\"\n    }\n  ],\n  \"commands\": [\"python src/hello.py\"]\n}\n" +
    "Wrap it in one \`\`\`json code block. No prose before or after it.\n" +
    "Inside \"content\": literal \\n for newlines, exact whitespace preserved,\n" +
    "and mode must be one of create, overwrite, search_replace.\n" +
    "\n" +
    // Escaping a few hundred lines of code into a JSON string is where these
    // replies break, and a model that cannot manage it produces something
    // unparseable rather than asking for another way. Naming the alternative
    // is what stops that: this format is read natively, not as a rescue.
    "FORMAT B - one code block per file, when the code is long enough that JSON\n" +
    "escaping would be error-prone. Put the path on the fence line itself:\n" +
    "\`\`\`python src/hello.py\n" +
    "def greet():\n" +
    "    return 'Hello'\n" +
    "\`\`\`\n" +
    "One block per file, the complete file in each, no JSON at all.\n" +
    "\n" +
    "RULES THAT APPLY TO BOTH:\n" +
    "- Write every file COMPLETELY. Never abbreviate with '# ... rest unchanged',\n" +
    "  '// existing code here', ellipses, or a comment standing in for real code.\n" +
    "  A partial file overwrites the real one and destroys work.\n" +
    "- Do not mix the two formats in one reply.\n" +
    "- If the step is too large to write out fully, write fewer files completely\n" +
    "  rather than all of them partially.\n" +
    "CRITICAL ARCHITECTURE RULE:\n" +
    "- Follow clean separation of concerns. Each file has a single responsibility.\n" +
    "- DO NOT collapse multiple modules into one file.\n" +
    "- DO NOT reuse or overwrite files that are not related to the current step.\n" +
    // Deliberately last and deliberately four lines. This prompt is terse
    // because unparseable replies have cost whole builds before; more prose
    // means more chance the model explains itself outside the code fence.
    "CODE QUALITY:\n" +
    "- Handle errors and validate input. Do not write happy-path-only code.\n" +
    "- Docstrings on public functions. Comments explain why, not what.\n" +
    "- Avoid needless passes, quadratic loops over large inputs, and repeated I/O.\n" +
    "- The project must be runnable: keep requirements.txt / package.json in step with what the code imports.\n" +
    "- DO NOT create or edit " + GENERATED_FILES.join(", ") + " — the app generates those.\n" +
    "- Do not add commands that create virtualenvs or install packages unless the step is specifically about that.\n" +
    contextStr +
    "\n\nUser request:\n" + userPrompt;
}

function buildFollowUp(command: string, output: string, priorFiles: string[]): string {
  // A patch that would not apply is not a test that failed; it needs a
  // different tactic rather than a louder version of the same request.
  if (command === "apply patch") return buildApplyFollowUp(output, priorFiles);

  let priorNote = "";
  if (priorFiles.length > 0) {
    priorNote = "\nNote: existing files in this project are: " + priorFiles.join(", ") + ". Fix the bug in the appropriate file - do not collapse everything into one file.\n";
  }
  return "Your previous code failed when tested.\n" +
    "Command that was run:\n" + command + "\n" +
    "Error output:\n" + output.slice(0, 3000) + "\n" +
    "IMPORTANT: Fix the ROOT CAUSE of the error. Do not silence it with try/except, and do not merge unrelated files into one.\n" +
    priorNote +
    "Please fix the code and reply again with the same JSON format (files array, optional commands).\n" +
    "Wrap the JSON in a \`\`\`json code block. Allowed modes: create, overwrite, search_replace.";
}


interface StepRequest {
  prompt: string;
  workspace: string;
  autonomy: string;
  stepIndex: number;
  stepDetail: string;
  goalSummary: string;
  /** A question may legitimately be answered in prose. Without this, a reply
   *  with no file changes is reported as a failure - which is why asking
   *  "why did this fail?" used to display nothing at all. */
  allowNoChanges?: boolean;
  /**
   * Does the conversation still hold this build's plan and files?
   *
   * False when navigateToChat could not resume the thread. A step's prompt is
   * short precisely because it relies on the thread; sending a short prompt to
   * a conversation that has never seen the plan is the failure the
   * one-conversation design exists to avoid. Undefined means "assume it does",
   * which is what every caller before resuming existed did.
   */
  threadHasContext?: boolean;
}

interface StepOutcome {
  success: boolean;
  appliedFiles?: string[];
  /** Where applyPatch copied the previous version of any overwritten file. */
  backupDir?: string;
  error?: string;
  lastError?: string;
  raw?: string;
}


/**
 * What these paths hold right now. null means the file is not there, which is
 * how a checkpoint records that the step is about to create it.
 */
function capturePrior(workspace: string, paths: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const rel of paths || []) {
    if (!rel || typeof rel !== "string") continue;
    try {
      out[rel] = fs.readFileSync(path.join(workspace, rel), "utf-8");
    } catch {
      out[rel] = null;
    }
  }
  return out;
}

function checkpointDir(workspace: string): string {
  return path.join(workspace, BUILD_STATE_DIR, CHECKPOINT_DIR);
}

/**
 * Seal and save the step's checkpoint.
 *
 * Never fatal. A checkpoint that could not be written costs the ability to
 * undo this step; a build that stopped because of it would cost the step.
 */
function writeCheckpoint(workspace: string, checkpoint: Checkpoint | null): void {
  if (!checkpoint || !Object.keys(checkpoint.files).length) return;
  try {
    const afters: Record<string, string | null> = {};
    for (const rel of Object.keys(checkpoint.files)) {
      try { afters[rel] = fs.readFileSync(path.join(workspace, rel), "utf-8"); } catch { afters[rel] = null; }
    }
    const dir = checkpointDir(workspace);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, checkpointName(checkpoint.step)),
      JSON.stringify(sealCheckpoint(checkpoint, afters), null, 2) + "\n");
  } catch { /* see above */ }
}

/**
 * One build step against an already-open browser and thread. Returns its outcome
 * rather than emitting, so a long-lived session can call it repeatedly without
 * the caller having to parse stdout.
 */
/**
 * Guards everything after a reply: applying the patch, updating the ledger,
 * syntax checks, and running suggested commands.
 *
 * Conversations run in parallel; this does not. It removes every shared-state
 * race by construction rather than by careful locking.
 */
const applyLock = createMutex();

async function runBuildStep(controller: PlaywrightController, config: ProviderConfig, req: StepRequest): Promise<StepOutcome> {
  const { prompt, workspace, autonomy, stepIndex, stepDetail, goalSummary } = req;
  const maxFollowUps = 2;
  const ctx = getProjectContext(workspace, prompt);

  // Step N has to be told what steps 1..N-1 produced, or it guesses at the names
  // it imports. Collect everything in the workspace and let the ranker choose.
  const allFiles: WorkspaceFile[] = [];
  try {
    const priorPaths: string[] = [];
    const walkStack = [workspace];
    while (walkStack.length) {
      const dir = walkStack.pop()!;
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (["node_modules", ".git", ".agent-backups", "__pycache__", "dist", "build", "venv", "env", ".venv", "target"].indexOf(e.name) !== -1) continue;
        if (e.name.startsWith(".")) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkStack.push(p);
        else if (SOURCE_FILE.test(e.name)) priorPaths.push(p);
      }
    }
    for (const p of priorPaths) {
      try {
        allFiles.push({
          path: path.relative(workspace, p).replace(/\\/g, "/"),
          content: fs.readFileSync(p, "utf-8"),
          mtimeMs: fs.statSync(p).mtimeMs,
        });
      } catch {}
    }
  } catch {}

  // "Is this step 0?" was standing in for "does the conversation know about
  // this project?", and the two came apart the moment a build could be resumed.
  // Press Build on a workspace that is seven steps in and step 8 is not the
  // first step - so the prompt goes short, the tree is left out, and the delta
  // assumes the thread has files it may never have seen. When the thread did
  // resume that is exactly right and saves a great deal; when it did not, it
  // sends "implement step 8" to a model that has seen nothing.
  // Accumulated across the repair loop: one checkpoint per step, holding the
  // workspace as it was before the step's first apply.
  let checkpoint: Checkpoint | null = null;

  const isFirstStep = stepIndex <= 0;
  const coldThread = req.threadHasContext === false;
  const needsFullContext = isFirstStep || coldThread;
  if (coldThread && !isFirstStep) {
    console.log("The conversation holding this build is gone - re-sending the plan and the " +
      "current files into a new one (one-time cost).");
  }

  const effectivePrompt = stepDetail
    ? "Overall project goal: " + (goalSummary || prompt) + "\n\n" + stepDetail
    : prompt;

  // The ledger is reached through the controller so there is exactly one
  // derivation of the sessions.json path; a second one would silently diverge.
  // Empty when the thread cannot be relied on: a delta computed against what a
  // dead conversation was shown describes nothing that exists.
  const ledger = needsFullContext ? {} : controller.getLedger();
  const delta = computeDelta(allFiles, ledger);
  const relevant = selectRelevantFiles({ files: delta.candidates, stepDetail: stepDetail, prompt: prompt });
  controller.saveLedger(nextLedger(ledger, allFiles, relevant.map((r) => r.path), stepIndex));

  const filtered = allFiles
    .map(function (f) { return f.path; })
    .filter(function (f) { return needsFullContext || delta.newPaths.indexOf(f) !== -1; })
    .slice(0, 40);

  console.log("Step " + (stepIndex + 1) + ": including " + relevant.length + " files (signatures)" +
    (needsFullContext ? "" : ", skipped " + delta.unchangedCount + " the thread already has") +
    (relevant.length ? " (" + relevant.map(f => f.path + ":" + f.content.length + "c").join(", ") + ")" : ""));

  let prevCount = await controller.countMessages(config);
  let prevContent = await controller.getLastMessageText(config);
  // The thread has already been shown the project structure; re-sending it
  // every step duplicates what it holds. New paths arrive via `filtered`.
  await controller.sendPrompt(buildPrompt(effectivePrompt, needsFullContext ? ctx.tree : "", relevant, filtered, needsFullContext), config);
  let response = await controller.waitForResponse(config, prevCount, prevContent);
  let plan = parseMarkdownToEditPlan(response);
  let attempt = 0;
  let reasked = false;

  while (true) {
    if (plan.changes.length === 0) {
      if (!reasked) {
        reasked = true;
        console.log("No changes parsed; asking again, offering the per-file format...");
        prevCount = await controller.countMessages(config);
        prevContent = await controller.getLastMessageText(config);
        await controller.sendPrompt(REASK_FILES_PROMPT, config);
        response = await controller.waitForResponse(config, prevCount, prevContent);
        plan = parseMarkdownToEditPlan(response);
        continue;
      }
      if (req.allowNoChanges) return { success: true, appliedFiles: [], raw: response };
      return { success: false, error: "No file changes found in AI response.", raw: response };
    }

    // Everything from here to the end of the block runs one step at a time,
    // even when several conversations are in flight. Two workers must not
    // interleave writes to the delta ledger or both create the same backup
    // directory - and, worst of all, must not both ask for command approval:
    // replies arrive on one stdin queue with nothing saying which command they
    // answer, so a second prompt could receive the first one's "allow".
    const locked = await applyLock.run(async () => {
    // The app writes closeni.run.json, run.sh and run.bat at the end of a build.
    // They then show up in the workspace listing, and the model starts
    // maintaining them - overwriting what the app wrote with its own version.
    const adopted = plan.changes.filter((c) => isGeneratedFile(c.filePath));
    if (adopted.length) {
      console.log("IGNORING_GENERATED: " + adopted.map((c) => c.filePath).join(", "));
      plan.changes = plan.changes.filter((c) => !isGeneratedFile(c.filePath));
    }
    console.log("PHASE:" + JSON.stringify({ phase: "applying", detail: plan.changes.length + " file(s)" }));
    // Read what is there before changing it. Taken here rather than from
    // applyPatch's backup directory because a backup only holds files that
    // already existed - it cannot say which files this step created, and
    // undoing a step means deleting exactly those.
    checkpoint = mergeCheckpoint(checkpoint, stepIndex,
      capturePrior(workspace, plan.changes.map((c) => c.filePath)),
      { title: stepDetail.slice(0, 80) });
    const applyResult = applyPatch(workspace, plan);
    let failed: { command: string; output: string } | null = null;

    // The model authored these files, so the thread already knows their
    // contents. The pre-step scan cannot capture them — it runs before the
    // step exists — so without this they are re-sent next step as though the
    // thread had never seen them, and the delta never fires.
    if (applyResult.appliedFiles.length > 0) {
      const authored: WorkspaceFile[] = [];
      for (const rel of applyResult.appliedFiles) {
        try {
          authored.push({
            path: rel.replace(/\\/g, "/"),
            content: fs.readFileSync(path.join(workspace, rel), "utf-8"),
            mtimeMs: 0,
          });
        } catch { /* a file that vanished is simply not recorded */ }
      }
      if (authored.length > 0) {
        controller.saveLedger(
          nextLedger(controller.getLedger(), authored, authored.map((a) => a.path), stepIndex)
        );
      }
    }

    if (!applyResult.success) {
      failed = { command: "apply patch", output: applyResult.errors.join("\n") };
    } else {
      const checks = planChecksForWorkspace(workspace, plan.changes.map((c) => c.filePath));
      for (const c of checks) {
        console.log("PHASE:" + JSON.stringify({ phase: "checking", detail: c.language || "" }));
        console.log("RUNNING_CHECK: " + c.command);
        const r = await runCommand(c.command, workspace, c.timeoutMs, { timeoutIsFailure: true });
        console.log("CHECK_RESULT: " + (r.success ? "PASS" : "FAIL"));
        if (!r.success) { failed = { command: c.command, output: r.output }; break; }
      }
      if (!failed && plan.commands) {
        for (const suggested of plan.commands) {
          // Rewrite interpreter names that do not exist here before the user
          // approves, so what they see is what actually runs.
          const cmd = normalizeCommand(suggested);
          if (cmd !== suggested) console.log("NORMALIZED_COMMAND: " + suggested + "  ->  " + cmd);
          console.log("REQUESTING_COMMAND: " + cmd);
          // Auto-allow means "do not interrupt me for pytest". It was never
          // meant to mean "install system packages as root" or "pipe a
          // downloaded script into an interpreter" - both of which a real run
          // executed with no confirmation at all.
          const forced = needsConfirmation(cmd);
          if (forced) console.log("COMMAND_NEEDS_REVIEW: " + cmd);
          const ok = await askApproval(cmd, workspace, forced ? "ask" : autonomy);
          if (!ok) { console.log("COMMAND_DENIED: " + cmd); continue; }
          console.log("RUNNING_COMMAND: " + cmd);
          const r = await runCommand(cmd, workspace, 60000);
          console.log("COMMAND_RESULT: " + (r.success ? "PASS" : "FAIL"));
          if (r.output) projLog(r.output.slice(0, 2000));
          if (!r.success) {
            // A virtualenv that cannot be created, or a pip blocked by PEP 668,
            // is a fact about this machine - not about the code just written,
            // which has already passed its syntax checks. Failing the step for
            // it once blocked fourteen good steps behind one bad laptop.
            if (isEnvironmentSetup(cmd)) {
              console.log("ENVIRONMENT_COMMAND_SKIPPED: " + cmd);
              projLog("Environment setup did not work here, continuing: " + cmd);
              continue;
            }
            failed = { command: cmd, output: r.output };
            break;
          }
        }
      }
    }
    return { applyResult: applyResult, failed: failed };
    });
    const applyResult = locked.applyResult;
    const failed = locked.failed;

    if (!failed) {
      writeCheckpoint(workspace, checkpoint);
      return { success: true, appliedFiles: applyResult.appliedFiles, backupDir: applyResult.backupDir };
    }

    attempt++;
    console.log("TEST_FAILED: " + failed.command);
    if (attempt > maxFollowUps) {
      // A failed step still wrote files. Without this the one step most worth
      // undoing would be the only one that could not be.
      writeCheckpoint(workspace, checkpoint);
      return { success: false, error: "Still failing after " + maxFollowUps + " fix attempts.", lastError: failed.output };
    }
    console.log("FOLLOW_UP: sending error back to AI (attempt " + attempt + ")");
    prevCount = await controller.countMessages(config);
    prevContent = await controller.getLastMessageText(config);
    await controller.sendPrompt(buildFollowUp(failed.command, failed.output, filtered), config);
    response = await controller.waitForResponse(config, prevCount, prevContent);
    plan = parseMarkdownToEditPlan(response);
  }
}

/**
 * Open a visible browser so the user can sign in. Headed regardless of
 * AGENT_HEADED: a login in a window nobody can see is the bug this fixes.
 */
/**
 * Is this provider signed in, and what conversation is it on?
 *
 * Headless and read-only: it opens the provider, looks for a composer, and
 * closes. A composer means the saved profile still carries a live session; a
 * login wall means it does not. Nothing is typed and nothing is sent.
 */
async function authCheckMode(providerId: string, workspace: string) {
  const registry = new ProviderRegistry();
  registry.loadProviders();
  const config = registry.getProvider(providerId);
  if (!config) { emit({ success: false, error: "Provider not found: " + providerId }); return; }
  if (config.comingSoon) {
    emit({ success: true, signedIn: false, comingSoon: true, provider: config.id, name: config.name });
    return;
  }

  const controller = new PlaywrightController(config);
  controller.setWorkspace(workspace);
  // A status probe must never adopt or overwrite the conversation it reports on.
  controller.setThreadKind("worker");
  try {
    await controller.launch(config);
    await controller.navigateFresh(config);
    const signedIn = await controller.waitForLogin(20000);
    emit({
      success: true,
      signedIn: signedIn,
      provider: config.id,
      name: config.name,
      thread: controller.describeSavedThread(workspace),
    });
  } catch (e: any) {
    emit({ success: true, signedIn: false, provider: config.id, name: config.name, error: e.message });
  } finally {
    await controller.close();
  }
}

async function signinMode(providerId: string) {
  const registry = new ProviderRegistry();
  registry.loadProviders();
  const config = registry.getUsableProvider(providerId);
  if (!config) { emit({ success: false, error: "Provider not found: " + providerId }); return; }

  process.env.AGENT_HEADED = "1";
  const controller = new PlaywrightController(config);
  await controller.launch(config);
  try {
    await controller.navigateFresh(config);
    const ok = await controller.waitForLogin(300000);
    emit(ok
      ? { success: true }
      : { success: false, error: "No chat input appeared. The sign-in may not have completed." });
  } finally {
    await controller.close();
  }
}

/**
 * Revise one step of a finished or in-flight build. Resumes the build's thread
 * so the model still has the whole build in view, then applies the reply through
 * the same path a step uses.
 */
async function suggestMode(workspace: string, providerId: string, stepIndex: number, suggestion: string) {
  const registry = new ProviderRegistry();
  registry.loadProviders();
  const config = registry.getUsableProvider(providerId);
  if (!config) { emit({ success: false, error: "Provider not found: " + providerId }); return; }

  const controller = new PlaywrightController(config);
  controller.setWorkspace(workspace);
  controller.setThreadKind("chat");

  if (!controller.describeSavedThread(workspace)) {
    emit({ success: false, error: "No conversation for this workspace yet. Run a build before suggesting changes." });
    return;
  }

  await controller.launch(config);
  try {
    // A fresh chat would answer confidently with none of the build in view, so
    // a failed resume is a refusal rather than a fallback.
    const resumed = await controller.navigateToChat(config);
    if (!resumed) {
      emit({ success: false, error: "The conversation could not be reopened, so there is no context to revise against." });
      return;
    }
    await controller.waitForLogin();

    const detail =
      "Revise ONLY what step " + (stepIndex + 1) + " produced. Change requested:\n" + suggestion +
      "\n\nReply with the full updated contents of any file you change, using mode \"overwrite\".";

    emit(await runBuildStep(controller, config, {
      prompt: suggestion,
      workspace: workspace,
      autonomy: "auto",
      stepIndex: stepIndex,
      stepDetail: detail,
      goalSummary: "",
    }));
  } finally {
    await controller.close();
  }
}

function sessionEvent(payload: any) {
  console.log("SESSION_EVENT: " + JSON.stringify(payload));
}

/**
 * One process, one browser, one thread for a whole build. Steps arrive on stdin
 * as newline-delimited JSON. The caller keeps owning the step loop, so pause,
 * skip and stop stay exactly as they are — this only removes the per-step
 * browser launch.
 */
async function buildSessionMode(workspace: string, providerId: string, autonomy: string) {
  // Resuming keeps the ledger. Clearing it belongs to starting a build, not to
  // opening a browser: a build picked up at step 8 is rejoining a conversation
  // that has already been shown these files, and wiping the record of that
  // would re-send the entire project on the step it happens to resume at.
  const resuming = process.env.AGENT_RESUMING === "1";
  const { controller, config, resumed } = await openProviderForBuild(providerId, workspace, !resuming);
  if (resuming) console.log("Resuming a build - keeping what this conversation has already been shown.");

  // One conversation means one composer, so steps run one at a time.
  //
  // Parallel workers each needed a thread of their own, which is exactly what
  // made every step prompt carry the whole plan: a worker had never seen the
  // discussion. Sharing the conversation is worth more than the parallelism -
  // a serial step in a thread that already has the context is smaller, faster
  // to answer and far more likely to come back parseable than a parallel one
  // that has to re-explain the project from nothing.
  const requested = Math.max(1, Math.min(4, parseInt(process.env.AGENT_CONCURRENCY || "2", 10) || 2));
  if (requested > 1) {
    console.log("Steps run one at a time: chat, plan and build share a single conversation.");
  }
  const workers: PlaywrightController[] = [controller];
  console.log("Build session ready (one conversation).");
  const pool = createPool(workers);

  let closing = false;
  let inFlight = 0;
  let onIdle: (() => void) | null = null;

  await new Promise<void>((resolve) => {
    const finishIfIdle = () => { if (closing && inFlight === 0 && onIdle) { const f = onIdle; onIdle = null; f(); } };

    // Returning false leaves the line for the approval queue, so an
    // {"approved":...} reply sent mid-step still reaches askApproval.
    sessionLineHandler = (line: string): boolean => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return false; }
      if (!msg || typeof msg !== "object") return false;

      if (msg.type === "close") {
        closing = true;
        // Let work already in flight finish: cutting off a step mid-apply would
        // leave the workspace in a state nobody asked for.
        if (inFlight === 0) resolve();
        else onIdle = resolve;
        return true;
      }

      if (msg.type === "step" && !closing) {
        inFlight++;
        void (async () => {
          const worker = await pool.acquire();
          try {
            const outcome = await runBuildStep(worker, config, {
              prompt: msg.prompt || msg.detail || "",
              workspace: workspace,
              autonomy: autonomy,
              stepIndex: msg.index,
              stepDetail: msg.detail || "",
              goalSummary: msg.goal || "",
              // Whether the conversation came back. A resumed build whose thread
              // is gone must be told so before it sends a short prompt into a
              // model that has never seen the plan.
              threadHasContext: resumed,
            });
            sessionEvent(Object.assign({ type: "step-result", index: msg.index }, outcome));
          } catch (e: any) {
            sessionEvent({ type: "step-result", index: msg.index, success: false, error: String(e && e.message ? e.message : e) });
          } finally {
            pool.release(worker);
            inFlight--;
            finishIfIdle();
          }
        })();
        return true;
      }

      return false;
    };
    rl.on("close", () => { closing = true; if (inFlight === 0) resolve(); else onIdle = resolve; });

    // Announced only now. The caller sends its first step the instant it sees
    // this, and worker setup above contains awaits - so announcing before the
    // handler exists drops that step on the floor.
    sessionEvent({ type: "ready" });
  });

  sessionLineHandler = null;
  // Workers first: each closes only its own page. The launcher closes last and
  // takes the shared context with it.
  for (let i = 1; i < workers.length; i++) await workers[i].close();
  await controller.close();
  sessionEvent({ type: "closed" });
}

async function buildMode(prompt: string, workspace: string, providerId: string, autonomy: string, stepIndex: number, stepDetail: string, goalSummary: string) {
  // Step 0 opens the build's thread; later steps rejoin it so they can see what
  // earlier steps said.
  const { controller, config } = await openProviderForBuild(providerId, workspace, stepIndex <= 0);
  try {
    emit(await runBuildStep(controller, config, {
      prompt: prompt, workspace: workspace, autonomy: autonomy,
      stepIndex: stepIndex, stepDetail: stepDetail, goalSummary: goalSummary,
    }));
  } finally { await controller.close(); }
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// DuckDuckGo wraps every result in //duckduckgo.com/l/?uddg=<url-encoded target>.
function unwrapDuckDuckGoUrl(href: string): string {
  const decoded = decodeEntities(href);
  const m = decoded.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { /* fall through */ }
  }
  return decoded.startsWith("//") ? "https:" + decoded : decoded;
}

// DuckDuckGo answers bot-shaped requests with a 202 challenge page instead of results,
// so the full browser header set (Accept-Language especially) is load-bearing here.
async function httpGetText(url: string, headers: Record<string, string>): Promise<string> {
  const https = await import("https");
  const zlib = await import("zlib");
  return new Promise<string>((resolve, reject) => {
    https
      .get(url, { headers: headers }, (res) => {
        const status = res.statusCode || 0;
        if (status !== 200) {
          res.resume();
          reject(new Error("HTTP " + status + " from " + new URL(url).host));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (ch: Buffer) => chunks.push(ch));
        res.on("end", () => {
          let buf = Buffer.concat(chunks);
          const enc = res.headers["content-encoding"];
          try {
            if (enc === "gzip") buf = zlib.gunzipSync(buf);
            else if (enc === "br") buf = zlib.brotliDecompressSync(buf);
            else if (enc === "deflate") buf = zlib.inflateSync(buf);
          } catch (e) {
            reject(new Error("Could not decompress " + enc + " response"));
            return;
          }
          resolve(buf.toString("utf8"));
        });
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

async function researchDuckDuckGo(query: string): Promise<any[]> {
  const results: any[] = [];
  try {
    const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
    const body = await httpGetText(url, {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate",
    });
    const linkRe = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    const links: { url: string; title: string }[] = [];
    while ((m = linkRe.exec(body)) !== null) {
      links.push({ url: unwrapDuckDuckGoUrl(m[1]), title: decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim() });
    }
    const snippets: string[] = [];
    while ((m = snippetRe.exec(body)) !== null) {
      snippets.push(decodeEntities(m[1].replace(/<[^>]+>/g, "")).trim());
    }
    if (links.length === 0) {
      console.log("DuckDuckGo returned no parseable results (markup may have changed).");
    }
    for (let i = 0; i < Math.min(links.length, 8); i++) {
      results.push({ source: "web", title: links[i].title, url: links[i].url, snippet: snippets[i] || "" });
    }
  } catch (e) {
    console.log("DuckDuckGo scrape failed: " + String(e));
  }
  return results;
}

async function researchGithub(query: string): Promise<any[]> {
  const results: any[] = [];
  try {
    const url = "https://api.github.com/search/repositories?q=" + encodeURIComponent(query) + "&sort=stars&order=desc&per_page=5";
    const body = await httpGetText(url, {
      "User-Agent": "CloseNI",
      Accept: "application/vnd.github.v3+json",
    });
    const data = JSON.parse(body);
    if (data.message && !data.items) {
      console.log("GitHub search rejected the query: " + data.message);
    }
    if (data.items && Array.isArray(data.items)) {
      for (const r of data.items) {
        // Repo descriptions are arbitrary remote text and spam repos stuff whole
        // pages into them, which floods the results panel.
        const description = (r.description || "").replace(/\s+/g, " ").trim();
        const short = description.length > 200 ? description.slice(0, 200) + "..." : description;
        // The licence is shown before a clone, so the user accepts it knowingly.
        // Without forwarding it the confirmation could only say "an unknown
        // licence" - true, but useless for the decision it is asking for.
        const licence = r.license && (r.license.spdx_id || r.license.name);
        results.push({
          source: "github",
          title: r.full_name,
          url: r.html_url,
          snippet: short + "  [" + (r.stargazers_count || 0) + " stars]",
          stars: r.stargazers_count || 0,
          license: licence && licence !== "NOASSERTION" ? licence : null,
        });
      }
    }
  } catch (e) {
    console.log("GitHub search failed: " + String(e));
  }
  return results;
}

/**
 * Gated, and refuses rather than trying.
 *
 * The web half scraped html.duckduckgo.com, which now answers every non-browser
 * client with a 202 challenge page - confirmed with the full browser header
 * set, including the Accept-Language the old comment called load-bearing. So the
 * request cannot succeed, and it was still being made on every click: eight
 * searches in one session produced eight failures and no results.
 *
 * Worse, it emitted { success: true } with an empty list, so a total failure
 * looked like a search that found nothing.
 *
 * Refusing here matches the gate on the panel and stops the pointless traffic.
 * The way back is to run the search in the browser this app already drives,
 * rather than over plain HTTPS - that is the whole premise of the project, and
 * it is why the panel is gated instead of the scraper being patched.
 */
async function researchMode(query: string) {
  console.log("Research is not available: DuckDuckGo answers scripted requests " +
    "with a challenge page, so the web search cannot work over plain HTTPS.");
  emit({
    success: false,
    web: [],
    github: [],
    error: "Research is not available yet. Ask in Chat instead - it reaches the same " +
      "provider and the same conversation.",
  });
}

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
    else if (mode === "research") await researchMode(prompt);
    // Positional layout differs from the other modes: workspace and provider
    // come straight after the mode, because there is no per-step prompt.
    else if (mode === "build-session") await buildSessionMode(args[1] || path.resolve(process.cwd()), args[2] || "deepseek", args[3] || "auto");
    // Positional layout: workspace, provider, step index, suggestion text.
    else if (mode === "signin") await signinMode(args[1] || "deepseek");
    // Positional layout: provider, workspace.
    else if (mode === "authcheck") await authCheckMode(args[1] || "deepseek", args[2] || "");
    else if (mode === "suggest") await suggestMode(args[1] || path.resolve(process.cwd()), args[2] || "deepseek", args[3] ? parseInt(args[3]) : 0, resolveArg(args[4]));
    else if (mode === "ask") await askMode(args[1] || path.resolve(process.cwd()), args[2] || "deepseek", resolveArg(args[3]), resolveArg(args[4]), resolveArg(args[5]));
    else await buildMode(prompt, workspace, providerId, autonomy, stepIndex, stepDetail, goalSummary);
  } catch (e: any) {
    emit({ success: false, error: e.message });
  }
}

main()
  .catch((e) => emit({ success: false, error: String(e) }))
  .finally(() => { rl.close(); });
