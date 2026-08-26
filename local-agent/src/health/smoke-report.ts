/**
 * Judging one real round trip against a live provider.
 *
 * The passive selector check cannot see four of the seven things that matter:
 * the stop button only exists while a reply is generating, the reply stream
 * only fires during one, whether assistant text actually GROWS needs a reply in
 * flight, and how long completion takes needs a clock. Those four are where
 * every expensive failure in this project has lived.
 *
 * The one that shaped this module: the frozen assistant selector did not fail.
 * It passed, after 300 seconds, having watched a node that was the previous
 * answer. A check that asks "did a reply arrive" records that as green with a
 * large number beside it, which is exactly how it survived. So a budget is
 * asserted, not merely reported.
 *
 * Pure, like selector-health: the caller drives the browser and collects
 * observations, this decides what they mean. That is what lets every verdict
 * below be tested without an account, a network or a clock.
 */

export type SmokeHealth = "ok" | "degraded" | "critical" | "skipped";

export interface SmokeFinding {
  step: string;
  health: SmokeHealth;
  detail: string;
}

export interface SmokeReport {
  ok: boolean;
  findings: SmokeFinding[];
  summary: string;
}

export interface SmokeObservations {
  /** Did the composer accept the prompt and did it go? */
  sent?: boolean;
  /** Did the stop button appear at any point during generation? */
  stopSeen?: boolean;
  /** Is a stop button even configured for this provider? */
  stopConfigured?: boolean;
  /** Reply streams the page opened and closed while we watched. */
  streamsOpened?: number;
  streamsClosed?: number;
  /** Is a stream pattern configured? Absent means the check is skipped. */
  streamConfigured?: boolean;
  /** How many times the assistant text changed length during the wait. */
  textGrowths?: number;
  /** Milliseconds from sending to completion being detected. */
  elapsedMs?: number;
  /** The reply as CloseNI read it. */
  reply?: string;
  /** What the reply had to contain for the read path to be working. */
  expect?: string;
  /** Text read back from the provider's own Copy control, if configured. */
  copied?: string | null;
  copyConfigured?: boolean;
}

/**
 * How long a short reply may take before the wait itself is the problem.
 *
 * Not a performance target. A one-line answer arriving in ninety seconds means
 * completion is being detected by the text-stability fallback after everything
 * better has failed to fire - which is a working build today and a broken one
 * the next time the page changes.
 */
export const COMPLETION_BUDGET_MS = 60000;

function n(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export function judgeSmoke(obs: SmokeObservations): SmokeReport {
  const o = obs || {};
  const findings: SmokeFinding[] = [];

  // Read up front: the assistant-selector verdict depends on whether the
  // expected answer came back, not only on whether the text was seen changing.
  const expect = String(o.expect || "");
  const reply = String(o.reply || "");

  findings.push(o.sent
    ? { step: "send", health: "ok", detail: "the prompt reached the composer and went" }
    : { step: "send", health: "critical", detail: "the prompt could not be sent - nothing else below means anything" });

  // Only observable during generation, which is the entire reason this test
  // exists rather than the passive one.
  if (o.stopConfigured === false) {
    findings.push({ step: "stopButton", health: "skipped", detail: "not configured for this provider" });
  } else if (o.stopSeen) {
    findings.push({ step: "stopButton", health: "ok", detail: "appeared while the reply was generating" });
  } else {
    findings.push({ step: "stopButton", health: "degraded",
      detail: "never appeared during generation - completion falls back to waiting for the text to stop changing, which is slower and breaks quietly" });
  }

  if (o.streamConfigured === false) {
    findings.push({ step: "replyStream", health: "skipped", detail: "no streamUrlPattern configured" });
  } else if (n(o.streamsOpened) === 0) {
    findings.push({ step: "replyStream", health: "degraded",
      detail: "the configured streamUrlPattern matched no request - it is a guess until confirmed from the Network tab, and until it matches, completion is decided by text stability alone" });
  } else if (n(o.streamsClosed) < n(o.streamsOpened)) {
    findings.push({ step: "replyStream", health: "degraded",
      detail: n(o.streamsOpened) + " stream(s) opened but only " + n(o.streamsClosed) + " closed" });
  } else {
    findings.push({ step: "replyStream", health: "ok",
      detail: n(o.streamsOpened) + " stream(s) opened and closed" });
  }

  // The frozen selector, caught directly - but only where zero really is
  // evidence of one.
  //
  // waitForResponse waits three seconds before it starts polling, so a short
  // reply is already finished by the first tick and its length never changes
  // again. The first live run against DeepSeek hit exactly that: 43 characters,
  // textGrowths 0, and the reply nonetheless read back perfectly - the exact
  // token present and the Copy button returning the exact code. Calling that a
  // frozen selector is the same mistake the passive check exists to avoid.
  //
  // Correct content proves the selector read the live answer. Zero growth then
  // means the reply beat us to it, which is a fast provider, not a fault. Zero
  // growth with content that is NOT ours is the real thing: a selector watching
  // somebody else's answer, which is what made a build wait out 300 seconds.
  const sawContent = !!expect && reply.includes(expect);
  if (n(o.textGrowths) > 0) {
    findings.push({ step: "assistantMessage", health: "ok",
      detail: "the text changed " + n(o.textGrowths) + " time(s) while the reply arrived" });
  } else if (sawContent) {
    findings.push({ step: "assistantMessage", health: "ok",
      detail: "the reply was already complete before polling started, so no change was observed - the expected answer was read back, so the selector is on the live message" });
  } else {
    findings.push({ step: "assistantMessage", health: "critical",
      detail: "the assistant text never changed while a reply was being generated, and the expected answer was not read back - the selector is watching something that is not the live answer, which is the failure that makes a build wait out its whole timeout and then report a slow model" });
  }

  const elapsed = n(o.elapsedMs);
  if (!elapsed) {
    findings.push({ step: "completion", health: "critical", detail: "completion was never detected" });
  } else if (elapsed > COMPLETION_BUDGET_MS) {
    findings.push({ step: "completion", health: "critical",
      detail: "took " + Math.round(elapsed / 1000) + "s for a one-line reply, over the " +
        Math.round(COMPLETION_BUDGET_MS / 1000) + "s budget - the fast signals are not firing and this is passing on the fallback" });
  } else {
    findings.push({ step: "completion", health: "ok", detail: "detected in " + (elapsed / 1000).toFixed(1) + "s" });
  }

  // Content, not merely presence. "Some text was found" is satisfied by reading
  // the wrong element; only the expected answer proves the read path.
  if (!expect) {
    findings.push({ step: "replyContent", health: "skipped", detail: "no expected content given" });
  } else if (!reply.trim()) {
    findings.push({ step: "replyContent", health: "critical", detail: "the reply came back empty" });
  } else if (reply.includes(expect)) {
    findings.push({ step: "replyContent", health: "ok", detail: "contains the expected answer" });
  } else {
    findings.push({ step: "replyContent", health: "critical",
      detail: "the reply did not contain " + JSON.stringify(expect) + " - either the model ignored the instruction or we are reading the wrong element. Read back: " +
        JSON.stringify(reply.slice(0, 200)) });
  }

  if (o.copyConfigured === false) {
    findings.push({ step: "copyButton", health: "skipped", detail: "not configured for this provider" });
  } else if (o.copied === null || o.copied === undefined) {
    findings.push({ step: "copyButton", health: "degraded",
      detail: "no code could be read from the provider's Copy control - code will be taken from the page instead, as it was before that existed" });
  } else if (expect && !String(o.copied).includes(expect)) {
    findings.push({ step: "copyButton", health: "degraded",
      detail: "the Copy control returned something unexpected: " + JSON.stringify(String(o.copied).slice(0, 120)) });
  } else {
    findings.push({ step: "copyButton", health: "ok", detail: "returned the code block's exact text" });
  }

  const critical = findings.filter((f) => f.health === "critical");
  const degraded = findings.filter((f) => f.health === "degraded");
  const checked = findings.filter((f) => f.health !== "skipped").length;

  let summary: string;
  if (critical.length) {
    summary = critical.length + " of " + checked + " checks failed: " +
      critical.map((f) => f.step).join(", ") + ". A build against this provider will fail or hang.";
  } else if (degraded.length) {
    summary = checked + " checks passed, " + degraded.length + " on a fallback: " +
      degraded.map((f) => f.step).join(", ") + ". Builds will work and will be slower than they should be.";
  } else {
    summary = checked + " checks passed. The whole read path is working.";
  }

  return { ok: critical.length === 0, findings: findings, summary: summary };
}
