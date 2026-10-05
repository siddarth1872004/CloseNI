/**
 * Chat, plan, ask and revise-plan: the modes that hold one conversation and
 * answer once.
 *
 * Split out of index.ts, which keeps the dispatcher.
 */
import { parsePlanRobust } from "../parser/json-repair.js";
import { PlaywrightController } from "../providers/playwright-controller.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { getProjectContext } from "../context/context-engine.js";
import { emit, capText } from "../cli-io.js";
import { runBuildStep } from "./build-step.js";
import { REASK_PROMPT, openProvider, openChatSession } from "./provider.js";

export async function chatMode(prompt: string, providerId: string, workspace: string = "") {
  // Resume, do not restart. This used to force a fresh thread on every single
  // message, so the model never saw what was said a moment earlier and each
  // turn had to be made self-contained. "New Chat" clears the saved thread,
  // which is the supported way to start over.
  const { session } = await openChatSession(providerId, workspace);
  try {
    const answer = await session.ask(
      "You are in normal conversation mode. Answer with brief descriptions and high-level " +
      "architecture. Do NOT include full code implementations unless explicitly asked. " +
      "Use markdown for formatting.\n\nUser message:\n" + prompt);
    emit({ success: true, answer: answer });
  } finally { await session.close(); }
}

export async function planMode(transcript: string, workspace: string, providerId: string) {
  transcript = capText(transcript, 8000);
  const ctx = getProjectContext(workspace, transcript);
  const instructions = "Create an implementation plan as JSON:\n" +
    "{\"summary\":\"goal\",\"runCommand\":\"how to run the finished project\",\"steps\":[{\"title\":\"\",\"detail\":\"\",\"files\":[\"path\"],\"dependsOn\":[],\"testable\":true}]}" +
    "testable is true when the step produces behaviour worth asserting - a calculation, " +
    "a parser, a route, a state change. It is false for scaffolding, configuration, " +
    "dependency lists and static assets, where a test would only restate the file. " +
    "A testable step will be asked to write tests alongside its code.\n" +
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
export async function askMode(workspace: string, providerId: string, question: string, command: string, output: string) {
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

export async function revisePlanMode(changes: string, workspace: string, providerId: string) {
  const prompt = "Update plan with: " + changes +
    "\n\nJSON format: {\"summary\":\"\",\"runCommand\":\"how to run the finished project\",\"steps\":[{\"title\":\"\",\"detail\":\"\",\"files\":[\"\"],\"dependsOn\":[],\"testable\":true}]}\n" +
    "testable is true when the step produces behaviour worth asserting, false for " +
    "scaffolding, configuration and dependency lists.\n" +
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
