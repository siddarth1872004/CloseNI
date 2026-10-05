/**
 * The planned build: a long-lived build session, and the one-shot build mode.
 *
 * Split out of index.ts, which keeps the dispatcher.
 */
import { PlaywrightController } from "../providers/playwright-controller.js";
import { createPool } from "../async-pool.js";
import { judgeSelectors } from "../health/selector-health.js";
import { rl, setSessionLineHandler, emit } from "../cli-io.js";
import { runBuildStep } from "./build-step.js";
import { openProviderForBuild } from "./provider.js";

export function sessionEvent(payload: any) {
  console.log("SESSION_EVENT: " + JSON.stringify(payload));
}

/**
 * One process, one browser, one thread for a whole build. Steps arrive on stdin
 * as newline-delimited JSON. The caller keeps owning the step loop, so pause,
 * skip and stop stay exactly as they are — this only removes the per-step
 * browser launch.
 */
export async function buildSessionMode(workspace: string, providerId: string, autonomy: string) {
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
  // Check the selectors before the first step, not after a step has hung.
  //
  // Free here: the session already owns the browser and the profile, so there
  // is no second launch and no lock to contend for. Reported and continued past
  // rather than blocking - a probe that is itself wrong must not be able to
  // stop a build that would have worked.
  try {
    const report = judgeSelectors(await controller.probeSelectors(config), {
      conversationResumed: resumed,
      configured: {
        sendButton: !!config.selectors.sendButton,
        assistantMessage: !!config.selectors.assistantMessage,
        copyButton: !!config.selectors.copyButton,
      },
    });
    console.log("Selector check: " + report.summary);
    for (const f of report.findings) {
      if (f.health === "critical" || f.health === "degraded") {
        console.log("  " + f.health + ": " + f.selector + " matched " + f.matched + " - " + f.note);
      }
    }
    sessionEvent({ type: "health", ok: report.ok, summary: report.summary, findings: report.findings });
  } catch (e: any) {
    console.log("Selector check could not run: " + (e && e.message ? e.message : e));
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
    setSessionLineHandler((line: string): boolean => {
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
              testable: !!msg.testable,
              title: msg.title || "",
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
    });
    rl.on("close", () => { closing = true; if (inFlight === 0) resolve(); else onIdle = resolve; });

    // Announced only now. The caller sends its first step the instant it sees
    // this, and worker setup above contains awaits - so announcing before the
    // handler exists drops that step on the floor.
    sessionEvent({ type: "ready" });
  });

  setSessionLineHandler(null);
  // Workers first: each closes only its own page. The launcher closes last and
  // takes the shared context with it.
  for (let i = 1; i < workers.length; i++) await workers[i].close();
  await controller.close();
  sessionEvent({ type: "closed" });
}

export async function buildMode(prompt: string, workspace: string, providerId: string, autonomy: string, stepIndex: number, stepDetail: string, goalSummary: string) {
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
