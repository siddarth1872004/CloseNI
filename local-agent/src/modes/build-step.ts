/**
 * One step of the planned build: prompt, apply, verify, repair.
 *
 * Split out of index.ts, which keeps the dispatcher.
 */
import * as path from "path";
import * as fs from "fs";
import { parseMarkdownToEditPlan } from "../parser/patch-parser.js";
import { applyPatch } from "../patch/patch-applier.js";
import { PlaywrightController, ProviderConfig } from "../providers/playwright-controller.js";
import { runCommand, normalizeCommand } from "../verification/command-runner.js";
import { planChecksForWorkspace } from "../verification/check-planner.js";
import { needsConfirmation, isEnvironmentSetup, isGeneratedFile, GENERATED_FILES } from "../verification/command-policy.js";
import { createMutex } from "../async-pool.js";
import { getProjectContext } from "../context/context-engine.js";
import { selectRelevantFiles, selectFilesToEdit, WorkspaceFile } from "../context/relevance.js";
import { findDroppedNames, describeDroppedNames, DroppedName, SourceFile } from "../context/defined-names.js";
import { computeDelta, nextLedger } from "../context/delta.js";
import { buildApplyFollowUp, buildTestFollowUp, buildCommandFollowUp, buildDroppedNamesFollowUp, filesNamedInOutput } from "../follow-up.js";
import { buildStepPrompt, StepPromptInput } from "../step-prompt.js";
import { planBehaviourChecks, hasTestFiles, looksLikeMissingDependency } from "../verification/behaviour-checker.js";
import { rewriteForVenv } from "../verification/python-env.js";
import { composePrompt } from "../prompt-compose.js";
import { Checkpoint, mergeCheckpoint, sealCheckpoint, checkpointName, CHECKPOINT_DIR } from "../checkpoint.js";
import { addTurn, shouldRollOver, budgetFor, describeSize } from "../context-budget.js";
import { BUILD_STATE_DIR } from "../build-state.js";
import { askApproval, projLog } from "../cli-io.js";
import { SOURCE_FILE } from "./checks.js";
import { REASK_FILES_PROMPT } from "./provider.js";
import { alreadyInstalled, environmentNotes, ensureEnvironment, venvForCommands, venvScriptResolver, workspaceResolver } from "../workspace-env.js";

/**
 * The persona, skills and MCP context for this run.
 *
 * Read once from the environment, the way provider controls already travel. A
 * new positional argument would have to be threaded through every mode and
 * every caller for something only buildPrompt uses.
 *
 * A malformed value is ignored rather than fatal: it means the user gets the
 * behaviour they had before configuring anything, which is a working build.
 */
export let preambleParts: { persona?: string; skills?: string[]; mcpContext?: string[] } | null = null;
export function readPreamble(): { persona?: string; skills?: string[]; mcpContext?: string[] } {
  if (preambleParts) return preambleParts;
  let parts: { persona?: string; skills?: string[]; mcpContext?: string[] } = {};
  try {
    const parsed = JSON.parse(process.env.AGENT_PREAMBLE || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) parts = parsed;
  } catch {
    // A malformed preamble means the behaviour the user had before configuring
    // anything, which is a working build.
  }
  preambleParts = parts;
  return parts;
}

/**
 * Put the user's preamble in front of a step prompt.
 *
 * composePrompt owns the budget, and `base` - which carries the JSON format
 * instruction - is never truncated. What was dropped is logged, because
 * silently sending less than the user configured is how a setting stops
 * meaning anything.
 */
export function withPreamble(base: string): string {
  const parts = readPreamble();
  if (!parts.persona && !(parts.skills || []).length && !(parts.mcpContext || []).length) return base;
  const composed = composePrompt({
    persona: parts.persona,
    skills: parts.skills,
    mcpContext: parts.mcpContext,
    base: base,
  });
  if (composed.truncated.length) {
    console.log("Preamble over budget; dropped: " + composed.truncated.join(", "));
  }
  return composed.text;
}

export function buildPrompt(input: StepPromptInput): string {
  return withPreamble(buildStepPrompt(Object.assign({ generatedFiles: GENERATED_FILES }, input)));
}

/** The "command" a failed names check reports as, so the follow-up can route on it. */
export const CHECK_NAMES = "check names";

/** What went wrong with an attempt, as the repair loop passes it around. */
export interface StepFailure {
  command: string;
  output: string;
  /** For "check names": what each rewritten file dropped that others still use. */
  dropped?: { path: string; names: DroppedName[] }[];
}

export function readWorkspaceFiles(workspace: string, rels: string[]): SourceFile[] {
  const out: SourceFile[] = [];
  for (const rel of rels) {
    try { out.push({ path: rel, content: fs.readFileSync(path.join(workspace, rel), "utf-8") }); } catch { /* gone */ }
  }
  return out;
}

/**
 * Top-level names this step's overwrites removed while other files still use
 * them. Compared with the file as it was before the step, not before this
 * attempt: a name the step itself added and then dropped broke nothing that
 * existed.
 */
export function checkDroppedNames(workspace: string, checkpoint: Checkpoint | null, changed: string[],
  knownPaths: string[]): { path: string; names: DroppedName[] }[] {
  if (!checkpoint) return [];
  const rels = Array.from(new Set(knownPaths.map((p) => p.replace(/\\/g, "/"))));
  const others = readWorkspaceFiles(workspace, rels);
  const out: { path: string; names: DroppedName[] }[] = [];
  for (const raw of Array.from(new Set(changed))) {
    const rel = raw.replace(/\\/g, "/");
    const entry = checkpoint.files[raw] || checkpoint.files[rel];
    if (!entry || entry.tooLarge || typeof entry.prior !== "string") continue;
    let now: string | null = null;
    try { now = fs.readFileSync(path.join(workspace, rel), "utf-8"); } catch { now = null; }
    const names = findDroppedNames(rel, entry.prior, now, others);
    if (names.length) out.push({ path: rel, names: names });
  }
  return out;
}

/** Each touched file as it was before the step, from its checkpoint. */
export function priorsOf(checkpoint: Checkpoint | null): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (!checkpoint) return out;
  for (const p of Object.keys(checkpoint.files)) out[p.replace(/\\/g, "/")] = checkpoint.files[p].prior;
  return out;
}

/**
 * The repair prompt for a failed attempt.
 *
 * `priors` holds each touched file as it was before the step, which is what a
 * dropped-names repair needs to put things back. Everything else is shown the
 * files the failure names as they are on disk now - a model repairing a file
 * from its memory of it is how one missing constant became twelve.
 */
export function buildFollowUp(failed: StepFailure, priorFiles: string[], workspace: string,
  knownPaths: string[], priors: Record<string, string | null>): string {
  // A patch that would not apply is not a test that failed; it needs a
  // different tactic rather than a louder version of the same request.
  if (failed.command === "apply patch") return buildApplyFollowUp(failed.output, priorFiles);
  if (failed.command === CHECK_NAMES) {
    const before: SourceFile[] = [];
    for (const d of failed.dropped || []) {
      const prior = priors[d.path];
      if (typeof prior === "string") before.push({ path: d.path, content: prior });
    }
    return buildDroppedNamesFollowUp(failed.dropped || [], before);
  }
  const current = readWorkspaceFiles(workspace, filesNamedInOutput(failed.output, knownPaths).slice(0, 4));
  // Nor is a failing test the same as a failing compiler. The model wrote the
  // assertion as well as the code, so which of the two is wrong is the question
  // - and the generic wording answers it for the model, incorrectly.
  if (failed.command === "run tests") return buildTestFollowUp(failed.output, priorFiles, current);
  return buildCommandFollowUp(failed.command, failed.output, priorFiles, current);
}


export interface StepRequest {
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
  /**
   * The step's title, for the checkpoint and anything reading it later.
   *
   * Separate from `stepDetail`, which is the whole prompt - "Overall: <goal>
   * Execute ONLY this step: ..." - and makes a useless commit subject. A real
   * build exported to git produced "step 1: Overall: Temperature converter
   * Execute ONLY this step: Tempe" before this existed.
   */
  title?: string;
  /**
   * Did the plan say this step has behaviour worth asserting?
   *
   * Declared once while the model was designing the whole project, rather than
   * decided eighteen times by a model already busy writing the code - which is
   * how an optional instruction becomes "no tests, ever" without anyone
   * noticing it did.
   */
  testable?: boolean;
}

export interface StepOutcome {
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
export function capturePrior(workspace: string, paths: string[]): Record<string, string | null> {
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

export function checkpointDir(workspace: string): string {
  return path.join(workspace, BUILD_STATE_DIR, CHECKPOINT_DIR);
}

/**
 * Seal and save the step's checkpoint.
 *
 * Never fatal. A checkpoint that could not be written costs the ability to
 * undo this step; a build that stopped because of it would cost the step.
 */
export function writeCheckpoint(workspace: string, checkpoint: Checkpoint | null): void {
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
    ignoreBuildStateDir(workspace);
  } catch { /* see above */ }
}

/**
 * Make .closeni ignore itself, as the app does when it saves build.json
 * (native/src/BuildStore.cpp): a .gitignore inside it matching everything.
 *
 * An untracked .closeni made a committed project look dirty to git, so the
 * export refused to run and a Commit swept the checkpoints into the project's
 * history. This covers a headless build, which writes no build.json. Never
 * the project's own .gitignore, and never rewritten once it exists.
 */
export function ignoreBuildStateDir(workspace: string): void {
  const file = path.join(workspace, BUILD_STATE_DIR, ".gitignore");
  if (!fs.existsSync(file)) fs.writeFileSync(file, "# CloseNI's build state and checkpoints: not project history.\n*\n");
}

/**
 * Undo a step that failed for good: every file it touched goes back to what it
 * was, and what it created is removed. The attempt itself is copied to
 * .agent-backups first, so nothing the model wrote is lost.
 *
 * Files too large to have been checkpointed are left as they are and reported;
 * the checkpoint is then kept so they can still be dealt with by hand.
 */
export function restoreFailedStep(workspace: string, checkpoint: Checkpoint | null, stepIndex: number):
  { saved: string; unrestorable: string[] } {
  const result = { saved: "", unrestorable: [] as string[] };
  if (!checkpoint || !Object.keys(checkpoint.files).length) return result;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const saveRel = path.join(".agent-backups", "failed-step-" + (stepIndex + 1) + "-" + stamp);
  const saveDir = path.join(workspace, saveRel);
  const undone: string[] = [];
  for (const rel of Object.keys(checkpoint.files).sort()) {
    const entry = checkpoint.files[rel];
    const abs = path.join(workspace, rel);
    try {
      if (fs.existsSync(abs)) {
        fs.mkdirSync(path.dirname(path.join(saveDir, rel)), { recursive: true });
        fs.copyFileSync(abs, path.join(saveDir, rel));
        result.saved = saveRel;
      }
    } catch { /* a copy that failed must not stop the restore */ }
    if (entry.tooLarge) { result.unrestorable.push(rel); continue; }
    try {
      if (entry.prior === null) { if (fs.existsSync(abs)) fs.unlinkSync(abs); }
      else fs.writeFileSync(abs, entry.prior);
      undone.push(rel);
    } catch { result.unrestorable.push(rel); }
  }
  console.log("STEP_ROLLED_BACK: " + JSON.stringify({ step: stepIndex + 1, files: undone,
    kept: result.unrestorable, savedTo: result.saved }));
  projLog("Step " + (stepIndex + 1) + " failed, so its changes were undone (" + undone.length +
    " file(s)). The failed attempt is saved in " + (result.saved || "(nothing to save)") + ".");
  return result;
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
export const applyLock = createMutex();

export async function runBuildStep(controller: PlaywrightController, config: ProviderConfig, req: StepRequest): Promise<StepOutcome> {
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
  // Sent in full whatever the ledger says: the step is about to replace them.
  const toEdit = selectFilesToEdit(allFiles, stepDetail);
  controller.saveLedger(nextLedger(ledger, allFiles, relevant.map((r) => r.path).concat(toEdit.map((f) => f.path)), stepIndex));
  const envNotes = environmentNotes(workspace);

  const filtered = allFiles
    .map(function (f) { return f.path; })
    .filter(function (f) { return needsFullContext || delta.newPaths.indexOf(f) !== -1; })
    .slice(0, 40);

  console.log("Step " + (stepIndex + 1) + ": including " + relevant.length + " files (signatures)" +
    (needsFullContext ? "" : ", skipped " + delta.unchangedCount + " the thread already has") +
    (relevant.length ? " (" + relevant.map(f => f.path + ":" + f.content.length + "c").join(", ") + ")" : "") +
    (toEdit.length ? "; in full: " + toEdit.map((f) => f.path).join(", ") : ""));

  // Would this exchange outgrow the conversation?
  //
  // Asked here, before anything is sent, because a step already waiting on a
  // reply has to finish in the thread it started in - rolling over underneath
  // it would abandon the answer it is waiting for.
  //
  // A rolled-over thread is a thread that has never seen this project, which is
  // a case that already exists and is already tested: the cold-thread path
  // sends the plan, the tree and the files, and the reset ledger makes the
  // delta describe the new conversation rather than the abandoned one.
  const budget = budgetFor(config.contextBudgetChars);
  let promptText = buildPrompt({
    task: effectivePrompt, tree: needsFullContext ? ctx.tree : "", toEdit: toEdit, outlines: relevant,
    newFiles: filtered, isFirstStep: needsFullContext, testable: req.testable, environmentNotes: envNotes,
  });
  if (shouldRollOver(controller.getConversationSize(), budget, promptText.length)) {
    console.log("This conversation is nearly full (" +
      describeSize(controller.getConversationSize(), budget) +
      ") - continuing in a new one, seeded with the plan and the current files.");
    await controller.startFreshConversation(config);
    // Rebuild against an empty ledger: the new thread has been shown nothing.
    const freshDelta = computeDelta(allFiles, {});
    const freshRelevant = selectRelevantFiles({ files: freshDelta.candidates, stepDetail: stepDetail, prompt: prompt });
    controller.saveLedger(nextLedger({}, allFiles, freshRelevant.map((r) => r.path).concat(toEdit.map((f) => f.path)), stepIndex));
    promptText = buildPrompt({
      task: effectivePrompt, tree: ctx.tree, toEdit: toEdit, outlines: freshRelevant,
      newFiles: allFiles.map((f) => f.path).slice(0, 40), isFirstStep: true, testable: req.testable,
      environmentNotes: envNotes,
    });
  }

  let prevCount = await controller.countMessages(config);
  let prevContent = await controller.getLastMessageText(config);
  // The thread has already been shown the project structure; re-sending it
  // every step duplicates what it holds. New paths arrive via `filtered`.
  await controller.sendPrompt(promptText, config);
  let response = await controller.waitForResponse(config, prevCount, prevContent);
  controller.saveConversationSize(
    addTurn(controller.getConversationSize(), promptText.length, (response || "").length));
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
      { title: (req.title || stepDetail).slice(0, 80) });
    const applyResult = applyPatch(workspace, plan);
    let failed: StepFailure | null = null;

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

    let dropped: { path: string; names: DroppedName[] }[] = [];
    if (applyResult.success) {
      dropped = checkDroppedNames(workspace, checkpoint, plan.changes.map((c) => c.filePath),
        allFiles.map((f) => f.path).concat(applyResult.appliedFiles));
    }

    if (!applyResult.success) {
      failed = { command: "apply patch", output: applyResult.errors.join("\n") };
    } else if (dropped.length) {
      // Before the tests, which would only report an AttributeError in some other
      // file and leave the model to guess which name, in which file, went where.
      const summary = dropped.map((d) => describeDroppedNames(d.path, d.names)).join("\n");
      console.log("NAMES_DROPPED: " + dropped.map((d) => d.path + " -> " +
        d.names.map((n) => n.name).join(", ")).join("; "));
      projLog(summary);
      failed = { command: CHECK_NAMES, output: summary, dropped: dropped };
    } else {
      // Before anything is checked: the venv exists and holds what the project
      // declares, so `python` below means the interpreter that can see flask.
      await ensureEnvironment(workspace);
      const resolveHere = workspaceResolver(workspace);
      const checks = planChecksForWorkspace(workspace, plan.changes.map((c) => c.filePath), resolveHere);
      for (const c of checks) {
        // "types" and "syntax" read differently and should say so: a syntax
        // failure is the model producing something that does not parse, a type
        // failure is plausible code with a real bug in it.
        const what = c.kind === "types" ? (c.language + " types") : (c.language || "");
        console.log("PHASE:" + JSON.stringify({ phase: "checking", detail: what }));
        console.log("RUNNING_CHECK: " + c.command);
        const r = await runCommand(c.command, workspace, c.timeoutMs, { timeoutIsFailure: true });
        console.log("CHECK_RESULT: " + (r.success ? "PASS" : "FAIL"));
        if (!r.success) { failed = { command: c.command, output: r.output }; break; }
      }

      // Then the project's own tests, if it has any yet.
      //
      // Gated on tests actually existing, and that gate is load-bearing rather
      // than tidy: a project with a pyproject.toml matches the pytest rule from
      // step one, and `pytest -q` with nothing to collect exits non-zero. Every
      // step before the first test was written would fail, and the repair loop
      // would spend its attempts fixing a suite that does not exist.
      //
      // After the syntax and type checks, never before: a suite that cannot
      // import the module it tests reports a confusing failure when the plain
      // answer is that the file does not compile.
      if (!failed) {
        let workspaceNames: string[] = [];
        try { workspaceNames = allFiles.map((f) => f.path).concat(applyResult.appliedFiles); } catch {}
        if (hasTestFiles(workspaceNames)) {
          let rootNames: string[] = [];
          try { rootNames = fs.readdirSync(workspace); } catch {}
          const suite = planBehaviourChecks(rootNames, (file: string) => {
            try { return JSON.parse(fs.readFileSync(path.join(workspace, file), "utf-8")); } catch { return null; }
          }, resolveHere, null).filter((b) => b.kind === "test" && b.available);

          for (const t of suite) {
            console.log("PHASE:" + JSON.stringify({ phase: "checking", detail: t.language + " tests" }));
            console.log("RUNNING_CHECK: " + t.command);
            const r = await runCommand(t.command, workspace, t.timeoutMs, { timeoutIsFailure: true });
            console.log("CHECK_RESULT: " + (r.success ? "PASS" : "FAIL"));
            if (!r.success) {
              // A dependency that is not installed is a fact about this machine,
              // not about the code just written - the same call isEnvironmentSetup
              // makes for a pip blocked by PEP 668. Failing the step here would
              // have the repair loop asking the model to fix an ImportError only
              // `pip install` can, on every step, for the rest of the build.
              if (looksLikeMissingDependency(r.output, workspaceNames)) {
                console.log("Tests could not run: a dependency is not installed here. " +
                  "Reporting it and carrying on - this is the machine, not the code.");
                projLog(r.output.slice(0, 600));
                continue;
              }
              // "run tests" routes to buildTestFollowUp, which says the code or
              // the assertion could be wrong. The generic wording would tell the
              // model its code failed, and a wrong assertion then gets satisfied
              // by bending correct code - a green step with broken behaviour.
              failed = { command: "run tests", output: r.output };
              break;
            }
          }
        }
      }

      if (!failed && plan.commands) {
        const venvScripts = venvScriptResolver(workspace);
        for (const suggested of plan.commands) {
          // Rewrite interpreter names that do not exist here before the user
          // approves, so what they see is what actually runs.
          // rewriteForVenv second: the model writes `pip3 install ...` and
          // `python3 -m pytest`, and on the machine that reported this `pip3`
          // did not exist at all while `python3` was the one interpreter
          // guaranteed not to see what the venv holds.
          const cmd = rewriteForVenv(normalizeCommand(suggested), venvForCommands(workspace), venvScripts);
          if (cmd !== suggested) console.log("NORMALIZED_COMMAND: " + suggested + "  ->  " + cmd);
          if (alreadyInstalled(workspace, cmd)) {
            // ensureEnvironment already ran exactly this against the same file,
            // this step or an earlier one. Running it again only repeats the
            // result - which, for a failed build from source, costs a minute.
            console.log("SKIPPED_ALREADY_HANDLED: " + cmd);
            continue;
          }
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
      // Put the workspace back the way the step found it. Left in place, a
      // failed step's files became every later step's failure: a real build
      // failed steps 8 and 9 on step 7's broken settings module, and each spent
      // both its repairs on an error it had not caused. What the step wrote is
      // kept in .agent-backups, and the step can be run again.
      const restored = await applyLock.run(async () => restoreFailedStep(workspace, checkpoint, stepIndex));
      // Only what could not be put back still needs undoing by hand.
      if (restored.unrestorable.length) writeCheckpoint(workspace, checkpoint);
      return { success: false, error: "Still failing after " + maxFollowUps + " fix attempts." +
        (restored.saved ? " Its changes were undone; the failed attempt is in " + restored.saved + "." : ""),
        lastError: failed.output };
    }
    console.log("FOLLOW_UP: sending error back to AI (attempt " + attempt + ")");
    prevCount = await controller.countMessages(config);
    prevContent = await controller.getLastMessageText(config);
    const followUp = buildFollowUp(failed, filtered, workspace,
      allFiles.map((f) => f.path).concat(plan.changes.map((c) => c.filePath.replace(/\\/g, "/"))),
      priorsOf(checkpoint));
    await controller.sendPrompt(followUp, config);
    response = await controller.waitForResponse(config, prevCount, prevContent);
    // A repair is a turn too. A step that needed two of them added three
    // exchanges to the thread, and counting only the first understates it.
    controller.saveConversationSize(
      addTurn(controller.getConversationSize(), followUp.length, (response || "").length));
    plan = parseMarkdownToEditPlan(response);
  }
}
