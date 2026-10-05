/**
 * Live checks against a provider: webtest, smoke, health, auth, sign-in and
 * suggestions.
 *
 * Split out of index.ts, which keeps the dispatcher.
 */
import * as path from "path";
import { PlaywrightController } from "../providers/playwright-controller.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { judgeSelectors } from "../health/selector-health.js";
import { judgeSmoke, SmokeObservations } from "../health/smoke-report.js";
import { isBrowserTransport } from "../providers/chat-session.js";
import { runLive } from "../web/live.js";
import { emit } from "../cli-io.js";
import { runBuildStep } from "./build-step.js";

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
/**
 * One real round trip against a live provider, judged strictly.
 *
 * The passive check cannot see four of the things that matter - the stop button
 * only exists while a reply generates, the stream only fires during one,
 * whether the assistant text GROWS needs a reply in flight, and how long
 * completion takes needs a clock. Every expensive failure this project has had
 * lived in those four.
 *
 * It sends one short message, so it costs a real request against the account.
 * That is why it is a command you run rather than something that happens on
 * startup, and why it uses a fresh conversation of its own: it must never write
 * into a thread a build is relying on.
 *
 * The prompt asks for a deterministic answer inside a code block, which lets the
 * reply be checked for CONTENT rather than mere presence - "some text was found"
 * is satisfied by reading the wrong element - and gives the Copy control
 * something real to be tested against.
 */
export const SMOKE_TOKEN = "closeni-smoke-ok";
export const SMOKE_PROMPT =
  "Reply with nothing but a single Python code block containing exactly this one line:\n" +
  "print('" + SMOKE_TOKEN + "')\n" +
  "No explanation before or after it.";

/**
 * The identical provider scenarios against the live sites, through the
 * browser-native layer (src/web). Results merge into
 * docs/testing/results/live-results.json for the provider matrix.
 *
 * Gated providers are tested too: gating is about what the app offers, and
 * this measures whether the web interface can be driven at all. Nothing here
 * signs in - a provider that needs a login is recorded as AUTH_REQUIRED.
 */
export async function webtestMode(which: string, flags: string[]) {
  const registry = new ProviderRegistry();
  registry.loadProviders();
  const ids = which === "all" ? ["deepseek", "qwen", "glm"] : [which];
  const resultsFile = path.resolve(__dirname, "..", "..", "docs", "testing", "results", "live-results.json");
  for (const id of ids) {
    const config = registry.getProvider(id === "qwen" ? "qwen-studio" : id) || { id };
    const run = await runLive(id, config, { headed: flags.includes("--headed"), resultsFile });
    console.log("\n" + run.provider + " (" + Math.round(run.durationMs / 1000) + "s)");
    for (const r of run.rows) console.log("  " + r.status.padEnd(14) + r.capability + (r.detail ? " - " + r.detail : ""));
  }
  console.log("\nresults merged into " + resultsFile);
}

export async function smokeMode(providerId: string) {
  const registry = new ProviderRegistry();
  registry.loadProviders();
  const config = registry.getProvider(providerId);
  if (!config) { console.log("Provider not found: " + providerId); process.exitCode = 1; return; }
  if (config.comingSoon) {
    console.log(config.name + " is gated, so there is nothing to smoke test.");
    process.exitCode = 1;
    return;
  }

  const controller = new PlaywrightController(config);
  // No workspace, and "worker" as the thread kind: this must not adopt, resume
  // or overwrite any conversation a build might be using.
  controller.setWorkspace("");
  controller.setThreadKind("worker");

  const obs: SmokeObservations = {
    stopConfigured: !!config.selectors.stopButton,
    streamConfigured: !!config.selectors.streamUrlPattern,
    copyConfigured: !!config.selectors.copyButton,
    expect: SMOKE_TOKEN,
  };

  try {
    await controller.launch(config);
    await controller.navigateFresh(config);
    const signedIn = await controller.waitForLogin(30000);
    if (!signedIn) {
      console.log("Not signed in to " + config.name + " - sign in through the app first.");
      process.exitCode = 1;
      return;
    }

    const prevCount = await controller.countMessages(config);
    const prevContent = await controller.getLastMessageText(config);

    const started = Date.now();
    await controller.sendPrompt(SMOKE_PROMPT, config);
    obs.sent = true;

    // Observing the REAL wait, not a copy of it. A reimplementation here would
    // keep passing after the original broke, which is the one thing a smoke
    // test must never do.
    let growths = 0;
    let lastChars = -1;
    let stopSeen = false;
    const reply = await controller.waitForResponse(config, prevCount, prevContent, (tick) => {
      if (tick.stopVisible) stopSeen = true;
      if (tick.chars !== lastChars) { if (lastChars !== -1) growths++; lastChars = tick.chars; }
    });
    obs.elapsedMs = Date.now() - started;
    obs.textGrowths = growths;
    obs.stopSeen = stopSeen;
    obs.reply = reply || "";

    const streams = controller.streamStats();
    obs.streamsOpened = streams.opened;
    obs.streamsClosed = streams.closed;

    if (config.selectors.copyButton) {
      const blocks = await controller.readCodeViaCopy(config);
      obs.copied = blocks && blocks.length ? blocks.join("\n") : null;
    }
  } catch (e: any) {
    console.log("Smoke test could not complete: " + (e && e.message ? e.message : e));
    obs.error = String(e && e.message ? e.message : e);
  } finally {
    await controller.close();
  }

  const report = judgeSmoke(obs);
  console.log("");
  console.log("  " + config.name + " - live smoke test");
  console.log("  " + "-".repeat(62));
  for (const f of report.findings) {
    const mark = f.health === "ok" ? " ok " : f.health === "skipped" ? "  - " : f.health.slice(0, 4).toUpperCase();
    console.log("  " + mark + "  " + f.step.padEnd(18) + f.detail);
  }
  console.log("  " + "-".repeat(62));
  console.log("  " + (report.ok ? "PASS" : "FAIL") + " - " + report.summary);
  console.log("");
  if (!report.ok) process.exitCode = 1;
}

/**
 * Check a provider's selectors without running a build.
 *
 * Resumes this workspace's conversation when there is one, because that is the
 * only place the read-path selectors have anything to match: an empty chat has
 * no replies for assistantMessage and no code blocks for copyButton, so a probe
 * of a fresh page cannot see the class of breakage that has actually cost
 * builds here.
 *
 * Read-only. The thread kind is "worker" so reporting on a conversation can
 * never adopt or overwrite it.
 */
export async function healthMode(providerId: string, workspace: string) {
  const registry = new ProviderRegistry();
  registry.loadProviders();
  const config = registry.getProvider(providerId);
  if (!config) { emit({ success: false, error: "Provider not found: " + providerId }); return; }
  if (config.comingSoon) {
    emit({ success: false, error: config.name + " is not enabled yet, so there is nothing to check." });
    return;
  }

  if (!isBrowserTransport(config as any)) {
    emit({ success: true, provider: config.id, name: config.name, resumed: false, ok: true,
           summary: config.name + " does not use a browser, so it has no selectors to check. " +
             "Its health is whether the local server is reachable and holding the model.",
           findings: [] });
    return;
  }
  const controller = new PlaywrightController(config);
  controller.setWorkspace(workspace);
  controller.setThreadKind("worker");
  try {
    await controller.launch(config);
    const resumed = await controller.navigateToChat(config);
    const signedIn = await controller.waitForLogin(20000);
    if (!signedIn) {
      emit({ success: false, error: "Not signed in to " + config.name + " - sign in first, then check." });
      return;
    }
    const report = judgeSelectors(await controller.probeSelectors(config), {
      conversationResumed: resumed,
      configured: {
        sendButton: !!config.selectors.sendButton,
        assistantMessage: !!config.selectors.assistantMessage,
        copyButton: !!config.selectors.copyButton,
      },
    });
    emit({ success: true, provider: config.id, name: config.name, resumed: resumed,
           ok: report.ok, summary: report.summary, findings: report.findings });
  } catch (e: any) {
    emit({ success: false, error: e && e.message ? e.message : String(e) });
  } finally {
    await controller.close();
  }
}

export async function authCheckMode(providerId: string, workspace: string) {
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

export async function signinMode(providerId: string) {
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
export async function suggestMode(workspace: string, providerId: string, stepIndex: number, suggestion: string) {
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
