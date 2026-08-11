/**
 * Are this provider's selectors still matching anything?
 *
 * Every serious bug this project has had came from a selector that stopped
 * describing the page. The worst of them was silent: `assistantMessage` matched
 * three nodes that were the PREVIOUS answer and never updated, so a build step
 * sat at "messages=3, chars=9019" for a full 300-second wait and then failed on
 * a timeout, which reads like a slow model rather than a broken selector.
 *
 * The rule this encodes, and the reason a naive check would not have caught it:
 *
 *   Zero matches is only evidence of a problem when something SHOULD have
 *   matched.
 *
 * `assistantMessage` finding nothing on an empty chat is not a fault - there
 * are no messages. Finding nothing in a conversation we resumed, which by
 * definition holds an exchange, is exactly the fault above. Reporting the first
 * as a failure would train everyone to ignore the check; reporting the second
 * as fine is how the bug survived.
 *
 * Pure. The controller counts nodes, this decides what the counts mean.
 */

export type Health = "ok" | "degraded" | "critical" | "skipped";

export interface SelectorFinding {
  selector: string;
  matched: number;
  health: Health;
  note: string;
}

export interface HealthReport {
  /** False only for a critical finding: a degraded one still builds. */
  ok: boolean;
  findings: SelectorFinding[];
  summary: string;
}

export interface ProbeCounts {
  chatInput?: number;
  sendButton?: number;
  assistantMessage?: number;
  copyButton?: number;
  stopButton?: number;
}

export interface ProbeContext {
  /**
   * Did we land in a conversation that already holds an exchange?
   *
   * The whole basis for judging assistantMessage. True means messages exist on
   * this page, so a selector matching none of them is broken rather than idle.
   */
  conversationResumed: boolean;
  /** Selectors this provider does not configure are not its failures. */
  configured?: Record<string, boolean>;
}

function n(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export function judgeSelectors(counts: ProbeCounts, context: ProbeContext): HealthReport {
  const c = counts || {};
  const resumed = !!(context && context.conversationResumed);
  const configured = (context && context.configured) || {};
  const has = (k: string) => configured[k] !== false;
  const findings: SelectorFinding[] = [];

  // The composer. Nothing else matters if a prompt cannot be typed, and this is
  // the one selector the controller already treats as fatal - it waits 15s and
  // throws "Chat input not found".
  findings.push(n(c.chatInput) > 0
    ? { selector: "chatInput", matched: n(c.chatInput), health: "ok", note: "the composer is where we expect it" }
    : { selector: "chatInput", matched: 0, health: "critical", note: "no composer found - nothing can be sent to this provider" });

  // Optional in practice: sendPrompt falls back to pressing Enter, and that has
  // always worked. Worth reporting, never worth blocking.
  findings.push(n(c.sendButton) > 0
    ? { selector: "sendButton", matched: n(c.sendButton), health: "ok", note: "" }
    : { selector: "sendButton", matched: 0, health: "degraded", note: "no send button - prompts will be sent with Enter, which normally works" });

  // The one that matters, and the one a fresh-page probe cannot judge.
  if (!has("assistantMessage")) {
    findings.push({ selector: "assistantMessage", matched: 0, health: "skipped", note: "not configured for this provider" });
  } else if (!resumed) {
    findings.push({ selector: "assistantMessage", matched: n(c.assistantMessage), health: "skipped",
      note: "no saved conversation to check against - an empty chat has no replies to match" });
  } else if (n(c.assistantMessage) > 0) {
    findings.push({ selector: "assistantMessage", matched: n(c.assistantMessage), health: "ok",
      note: "matched real replies in the saved conversation" });
  } else {
    findings.push({ selector: "assistantMessage", matched: 0, health: "critical",
      note: "matched nothing in a conversation that has replies - this is the failure that makes a build wait out its full timeout and then report a slow model" });
  }

  // An optimisation with a working fallback: without it, code is read from the
  // DOM as it always was.
  if (!has("copyButton")) {
    findings.push({ selector: "copyButton", matched: 0, health: "skipped", note: "not configured for this provider" });
  } else if (!resumed) {
    findings.push({ selector: "copyButton", matched: n(c.copyButton), health: "skipped",
      note: "no saved conversation to check against" });
  } else if (n(c.copyButton) > 0) {
    findings.push({ selector: "copyButton", matched: n(c.copyButton), health: "ok", note: "matched code blocks in the saved conversation" });
  } else {
    findings.push({ selector: "copyButton", matched: 0, health: "degraded",
      note: "no copy controls found - code will be read from the page instead, which is what happened before this existed. Expected if the conversation contains no code blocks" });
  }

  // Only exists while a reply is generating, so an idle page proves nothing
  // either way. Saying so is the point: a check that quietly omits it invites
  // the reading that everything was verified.
  findings.push({ selector: "stopButton", matched: n(c.stopButton), health: "skipped",
    note: "only present while a reply is generating, so an idle page cannot tell us" });

  const critical = findings.filter((f) => f.health === "critical");
  const degraded = findings.filter((f) => f.health === "degraded");
  const checked = findings.filter((f) => f.health !== "skipped").length;

  let summary: string;
  if (critical.length) {
    summary = critical.length + " selector" + (critical.length === 1 ? "" : "s") +
      " no longer match this provider's page: " + critical.map((f) => f.selector).join(", ") +
      ". A build will fail or hang until this is fixed.";
  } else if (degraded.length) {
    summary = checked + " selectors checked, all usable; " + degraded.length +
      " falling back: " + degraded.map((f) => f.selector).join(", ") + ".";
  } else {
    summary = checked + " selectors checked, all matching.";
  }
  if (!resumed) {
    summary += " Only a fresh page was available, so the read path could not be checked - " +
      "open this workspace's conversation and run it again for the full check.";
  }

  return { ok: critical.length === 0, findings: findings, summary: summary };
}
