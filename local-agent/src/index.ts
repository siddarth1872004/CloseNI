import * as path from "path";
import * as fs from "fs";
import * as readline from "readline";
import { parseMarkdownToEditPlan } from "./parser/patch-parser.js";
import { parsePlanRobust } from "./parser/json-repair.js";
import { applyPatch } from "./patch/patch-applier.js";
import { PlaywrightController, ProviderConfig } from "./providers/playwright-controller.js";
import { ProviderRegistry } from "./providers/provider-registry.js";
import { runCommand, detectSyntaxChecks, normalizeCommand } from "./verification/command-runner.js";
import { getProjectContext } from "./context/context-engine.js";
import { selectRelevantFiles, WorkspaceFile } from "./context/relevance.js";
import { computeDelta, nextLedger } from "./context/delta.js";

const SOURCE_FILE = /\.(py|js|cjs|mjs|ts|tsx|jsx|rs|go|java|c|h|cpp|hpp|cc)$/;

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
  if (autonomy === "auto") return true;
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

async function openProvider(providerId: string, fresh: boolean = false, workspace: string = "") {
    const registry = new ProviderRegistry();
    registry.loadProviders();
    const config = registry.getProvider(providerId);
    if (!config) throw new Error("Provider not found: " + providerId);
    const controller = new PlaywrightController(config);
    controller.setWorkspace(workspace);
    await controller.launch(config);
    if (fresh) await controller.navigateFresh(config);
    else await controller.navigateToChat(config);
    await controller.waitForLogin();
  return { controller: controller, config: config };
}

/** Build steps share one thread: step 0 starts it, later steps resume it. */
async function openProviderForBuild(providerId: string, workspace: string, isFirstStep: boolean) {
  const registry = new ProviderRegistry();
  registry.loadProviders();
  const config = registry.getProvider(providerId);
  if (!config) throw new Error("Provider not found: " + providerId);
  const controller = new PlaywrightController(config);
  controller.setWorkspace(workspace);
  controller.setThreadKind("build");
  await controller.launch(config);
  if (isFirstStep) {
    controller.resetBuildRunForWorkspace();
    await controller.navigateFresh(config);
  } else {
    await controller.navigateToBuildThread(config);
  }
  await controller.waitForLogin();
  return { controller: controller, config: config };
}

async function chatMode(prompt: string, providerId: string, workspace: string = "") {
  const { controller, config } = await openProvider(providerId, true, workspace);  // FRESH chat
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
  const prompt = "Create an implementation plan as JSON:\n" +
    "{\"summary\":\"goal\",\"steps\":[{\"title\":\"\",\"detail\":\"\",\"files\":[\"path\"]}]}" +
    "Rules: 3-8 steps, each step = different files, wrap in \`\`\`json.\n\n" +
    "Project:\n" + ctx.tree + "\n\nChat:\n" + transcript;
  const { controller, config } = await openProvider(providerId, true, workspace);  // FRESH chat
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

async function revisePlanMode(changes: string, workspace: string, providerId: string) {
  const prompt = "Update plan with: " + changes + "\n\nJSON format: {\"summary\":\"\",\"steps\":[{\"title\":\"\",\"detail\":\"\",\"files\":[\"\"]}]}\n3-8 steps, different files per step.";
  const { controller, config } = await openProvider(providerId, true, workspace);  // FRESH chat
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

async function revisePlanModeOld(changes: string, workspace: string, providerId: string) {
  const prompt = "Please update the implementation plan you created earlier with these changes:\n" + changes +
    "\n\nReply with ONLY the complete updated plan as a JSON object wrapped in a \`\`\`json code block, using the exact same format as before (summary + steps with title, detail, files). No extra text.";
  const { controller, config } = await openProvider(providerId, true, workspace);  // FRESH chat
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

async function testAllMode(workspace: string) {
  const files: string[] = [];
  walk(workspace, files);
  let pass = 0; let fail = 0;
  for (const f of files) {
    for (const cmd of detectSyntaxChecks(path.relative(workspace, f))) {
      const r = await runCommand(cmd, workspace);
      console.log((r.success ? "PASS " : "FAIL ") + cmd);
      if (r.success) pass++; else { fail++; if (r.output) projLog(r.output.slice(0, 800)); }
    }
  }
  emit({ success: fail === 0, passed: pass, failed: fail });
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
  return "You are an autonomous coding agent assistant.\n" +
    "You must reply with a valid JSON object containing the file changes.\n" +
    "Do not include any explanations outside the JSON.\n" +
    "The JSON format must be exactly like this:\n" +
    "{\n  \"files\": [\n    {\n      \"path\": \"src/hello.py\",\n      \"mode\": \"create\",\n      \"content\": \"def greet():\\n    return 'Hello'\\n\"\n    }\n  ],\n  \"commands\": [\"python src/hello.py\"]\n}\n" +
    "The optional \"commands\" array may contain terminal commands to test your changes.\n" +
    "CRITICAL JSON RULES FOR CODE CONTENT:\n" +
    "1. Inside the \"content\" field, you MUST use the literal two characters \\n for newlines.\n" +
    "2. You MUST preserve all exact whitespace and indentation.\n" +
    "3. Use single quotes for strings in your code.\n" +
    "4. You MUST wrap the whole JSON in a markdown code block that starts with \`\`\`json and ends with \`\`\`.\n" +
    "5. The only allowed values for mode are: create, overwrite, search_replace.\n" +
    "CRITICAL ARCHITECTURE RULE:\n" +
    "- Follow clean separation of concerns. Each file has a single responsibility.\n" +
    "- DO NOT collapse multiple modules into one file.\n" +
    "- DO NOT reuse or overwrite files that are not related to the current step.\n" +
    contextStr +
    "\n\nUser request:\n" + userPrompt;
}

function buildFollowUp(command: string, output: string, priorFiles: string[]): string {
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
 * One build step against an already-open browser and thread. Returns its outcome
 * rather than emitting, so a long-lived session can call it repeatedly without
 * the caller having to parse stdout.
 */
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

  const isFirstStep = stepIndex <= 0;

  const effectivePrompt = stepDetail
    ? "Overall project goal: " + (goalSummary || prompt) + "\n\n" + stepDetail
    : prompt;

  // The ledger is reached through the controller so there is exactly one
  // derivation of the sessions.json path; a second one would silently diverge.
  const ledger = isFirstStep ? {} : controller.getLedger();
  const delta = computeDelta(allFiles, ledger);
  const relevant = selectRelevantFiles({ files: delta.candidates, stepDetail: stepDetail, prompt: prompt });
  controller.saveLedger(nextLedger(ledger, allFiles, relevant.map((r) => r.path), stepIndex));

  const filtered = allFiles
    .map(function (f) { return f.path; })
    .filter(function (f) { return isFirstStep || delta.newPaths.indexOf(f) !== -1; })
    .slice(0, 40);

  console.log("Step " + (stepIndex + 1) + ": including " + relevant.length + " files (signatures)" +
    (isFirstStep ? "" : ", skipped " + delta.unchangedCount + " the thread already has") +
    (relevant.length ? " (" + relevant.map(f => f.path + ":" + f.content.length + "c").join(", ") + ")" : ""));

  let prevCount = await controller.countMessages(config);
  let prevContent = await controller.getLastMessageText(config);
  // The thread has already been shown the project structure; re-sending it
  // every step duplicates what it holds. New paths arrive via `filtered`.
  await controller.sendPrompt(buildPrompt(effectivePrompt, isFirstStep ? ctx.tree : "", relevant, filtered, isFirstStep), config);
  let response = await controller.waitForResponse(config, prevCount, prevContent);
  let plan = parseMarkdownToEditPlan(response);
  let attempt = 0;
  let reasked = false;

  while (true) {
    if (plan.changes.length === 0) {
      if (!reasked) {
        reasked = true;
        console.log("No changes parsed; asking AI to resend strict JSON...");
        prevCount = await controller.countMessages(config);
        prevContent = await controller.getLastMessageText(config);
        await controller.sendPrompt(REASK_PROMPT, config);
        response = await controller.waitForResponse(config, prevCount, prevContent);
        plan = parseMarkdownToEditPlan(response);
        continue;
      }
      return { success: false, error: "No file changes found in AI response.", raw: response };
    }

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
      const checks: string[] = [];
      for (const c of plan.changes) for (const s of detectSyntaxChecks(c.filePath)) checks.push(s);
      for (const cmd of checks) {
        console.log("RUNNING_CHECK: " + cmd);
        const r = await runCommand(cmd, workspace);
        console.log("CHECK_RESULT: " + (r.success ? "PASS" : "FAIL"));
        if (!r.success) { failed = { command: cmd, output: r.output }; break; }
      }
      if (!failed && plan.commands) {
        for (const suggested of plan.commands) {
          // Rewrite interpreter names that do not exist here before the user
          // approves, so what they see is what actually runs.
          const cmd = normalizeCommand(suggested);
          if (cmd !== suggested) console.log("NORMALIZED_COMMAND: " + suggested + "  ->  " + cmd);
          console.log("REQUESTING_COMMAND: " + cmd);
          const ok = await askApproval(cmd, workspace, autonomy);
          if (!ok) { console.log("COMMAND_DENIED: " + cmd); continue; }
          console.log("RUNNING_COMMAND: " + cmd);
          const r = await runCommand(cmd, workspace, 60000);
          console.log("COMMAND_RESULT: " + (r.success ? "PASS" : "FAIL"));
          if (r.output) projLog(r.output.slice(0, 2000));
          if (!r.success) { failed = { command: cmd, output: r.output }; break; }
        }
      }
    }

    if (!failed) return { success: true, appliedFiles: applyResult.appliedFiles, backupDir: applyResult.backupDir };

    attempt++;
    console.log("TEST_FAILED: " + failed.command);
    if (attempt > maxFollowUps) {
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
  const { controller, config } = await openProviderForBuild(providerId, workspace, true);
  sessionEvent({ type: "ready" });

  let closing = false;
  // Steps run one at a time; the chain stops a fast writer from interleaving two
  // steps in the same browser.
  let chain: Promise<void> = Promise.resolve();

  await new Promise<void>((resolve) => {
    // Returning false leaves the line for the approval queue, so an
    // {"approved":...} reply sent mid-step still reaches askApproval.
    sessionLineHandler = (line: string): boolean => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return false; }
      if (!msg || typeof msg !== "object") return false;

      if (msg.type === "close") {
        closing = true;
        chain = chain.then(() => { resolve(); });
        return true;
      }

      if (msg.type === "step" && !closing) {
        chain = chain.then(async () => {
          try {
            const outcome = await runBuildStep(controller, config, {
              prompt: msg.prompt || msg.detail || "",
              workspace: workspace,
              autonomy: autonomy,
              stepIndex: msg.index,
              stepDetail: msg.detail || "",
              goalSummary: msg.goal || "",
            });
            sessionEvent(Object.assign({ type: "step-result", index: msg.index }, outcome));
          } catch (e: any) {
            sessionEvent({ type: "step-result", index: msg.index, success: false, error: String(e && e.message ? e.message : e) });
          }
        });
        return true;
      }

      return false;
    };
    rl.on("close", () => { chain = chain.then(() => resolve()); });
  });

  sessionLineHandler = null;
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
      "User-Agent": "agentic-web-coder",
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
        results.push({ source: "github", title: r.full_name, url: r.html_url, snippet: short + "  [" + (r.stargazers_count || 0) + " stars]", stars: r.stargazers_count || 0 });
      }
    }
  } catch (e) {
    console.log("GitHub search failed: " + String(e));
  }
  return results;
}

async function researchMode(query: string) {
  console.log("Researching: " + query);
  const web = await researchDuckDuckGo(query);
  const gh = await researchGithub(query);
  emit({ success: true, web: web, github: gh });
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
    else if (mode === "research") await researchMode(prompt);
    // Positional layout differs from the other modes: workspace and provider
    // come straight after the mode, because there is no per-step prompt.
    else if (mode === "build-session") await buildSessionMode(args[1] || path.resolve(process.cwd()), args[2] || "deepseek", args[3] || "auto");
    else await buildMode(prompt, workspace, providerId, autonomy, stepIndex, stepDetail, goalSummary);
  } catch (e: any) {
    emit({ success: false, error: e.message });
  }
}

main()
  .catch((e) => emit({ success: false, error: String(e) }))
  .finally(() => { rl.close(); });
