/**
 * Opening a provider for a mode, the re-ask prompts, and the provider
 * controls a mode forces for its own run.
 *
 * Split out of index.ts, which keeps the dispatcher.
 */
import { PlaywrightController } from "../providers/playwright-controller.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { withControl, parseDesiredControls } from "../providers/controls/decisions.js";
import { ChatSession, BrowserChatSession, transportOf, isBrowserTransport } from "../providers/chat-session.js";
import { OllamaSession } from "../providers/ollama-session.js";
import { sleep } from "../cli-io.js";

export const REASK_PROMPT = "Your previous reply was not machine-readable. Reply again with ONLY the JSON object, wrapped in a \`\`\`json code block. No explanations, no extra text.";

/**
 * The re-ask after a step produced no readable files.
 *
 * Repeating "send JSON" to a model that just failed to send JSON tends to
 * produce the same reply again. Offering the per-file code-block format gives
 * it a way out that the parser reads natively, which is usually what breaks
 * the loop.
 */
export const REASK_FILES_PROMPT =
  "That reply did not contain file changes I could read. Send the files again, " +
  "either as one \`\`\`json block in the {\"files\":[{\"path\",\"mode\",\"content\"}]} format, " +
  "or as one code block per file with the path on the fence line, like \`\`\`python src/app.py. " +
  "Write each file completely - no ellipses and no '... rest unchanged'. No other text.";

/**
 * Refuse a provider that has no browser, in the paths that need one.
 *
 * Plan and build are browser-only for now. Saying so here costs one sentence;
 * letting it through means failing somewhere inside a page interaction that
 * will never happen, with an error about a selector on a provider that has no
 * page at all.
 */
export function requireBrowser(config: any, what: string): void {
  if (isBrowserTransport(config)) return;
  throw new Error(
    config.name + " runs locally and is chat-only for now - " + what +
    " still needs a browser provider. Switch to DeepSeek in Settings for this, " +
    "and use " + config.name + " for Chat.");
}

export async function openProvider(providerId: string, fresh: boolean = false, workspace: string = "") {
    const registry = new ProviderRegistry();
    registry.loadProviders();
    const config = registry.getUsableProvider(providerId);
    if (!config) throw new Error("Provider not found: " + providerId);
    requireBrowser(config, "this");
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
export async function openProviderForBuild(providerId: string, workspace: string, isFirstStep: boolean) {
  const registry = new ProviderRegistry();
  registry.loadProviders();
  const config = registry.getUsableProvider(providerId);
  if (!config) throw new Error("Provider not found: " + providerId);
  requireBrowser(config, "building");
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

/**
 * A session for whatever this provider is, browser or not.
 *
 * The only place that knows both transports exist. Everything above it works
 * against four methods and never asks which kind it got.
 */
export async function openChatSession(providerId: string, workspace: string): Promise<{ session: ChatSession; config: any }> {
  const registry = new ProviderRegistry();
  registry.loadProviders();
  const config = registry.getUsableProvider(providerId);
  if (!config) throw new Error("Provider not found: " + providerId);

  if (transportOf(config as any) === "ollama") {
    const session = new OllamaSession({
      endpoint: (config as any).endpoint,
      model: (config as any).model,
      timeoutMs: (config as any).timeoutMs,
    });
    await session.start();
    // Checked before a prompt is sent, because "nothing is listening on
    // 127.0.0.1:11434" is a sentence someone can act on and a failure five
    // layers down is not.
    const state = await session.ready();
    if (!state.ok) throw new Error(state.detail);
    console.log(state.detail);
    return { session: session, config: config };
  }

  const controller = new PlaywrightController(config);
  const session = new BrowserChatSession(controller, config, { workspace: workspace, sleep: sleep });
  try {
    await session.start();
  } catch (e) {
    // The browser is already open by the time the page can fail. Left open it
    // keeps this process alive after it has reported the failure, holding the
    // profile, and the app goes on treating it as a session that is running.
    try { await session.close(); } catch {}
    throw e;
  }
  return { session: session, config: config };
}

/**
 * Research, using the provider's own web search.
 *
 * The panel was gated because it fetched DuckDuckGo over plain HTTPS and got a
 * challenge page. NEXT.md proposed driving a browser to a search engine and
 * reading the results instead - which would mean a new set of selectors against
 * a page nobody controls, in a project whose every serious bug came from exactly
 * that. Search-result markup rots faster than chat UIs do.
 *
 * DeepSeek already has a "Smart Search" toggle, already wired into this app as a
 * provider control and already off by default. Turning it on and asking the
 * question uses their product as intended: no scraping, no new selectors, and
 * nothing that breaks when a results page is redesigned.
 *
 * Forced on for this run only, by overriding AGENT_CONTROLS in this process
 * rather than writing to the user's saved settings - researching once must not
 * silently change what every later chat does.
 */
export function forceControl(id: string, value: string | boolean): void {
  process.env.AGENT_CONTROLS = withControl(process.env.AGENT_CONTROLS, id, value);
}

/**
 * Controls for the coding agent, for this process only so Chat is untouched.
 *
 * Deep thinking follows the user's saved choice and defaults to off when they
 * have not made one: agent turns are many and short, and a thinking turn on a
 * large prompt spent the whole 300s wait reasoning (roadmap 1.7, D1), so off is
 * the right default, but someone who turned it on in settings asked for it.
 * Search is always off: left on from research, it searched the web on fix turns
 * and filled replies with citation badges, while the agent's facts come from
 * its tools.
 */
export function agentControls(): void {
  const saved = parseDesiredControls(process.env.AGENT_CONTROLS);
  if (typeof saved["deep-thinking"] !== "boolean") forceControl("deep-thinking", false);
  forceControl("smart-search", false);
}
