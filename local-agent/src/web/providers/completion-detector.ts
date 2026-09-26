/**
 * When has a reply started, and when has it finished?
 *
 * Pure and clock-free: the caller feeds observations with their own timestamps,
 * so every rule is tested with synthetic ticks instead of real waits.
 *
 * Signals, strongest first:
 *   1. the reply request closed      (exact; MEASURED on DeepSeek only)
 *   2. the stop control disappeared  (exact when the site has a distinct one)
 *   3. nothing changed for a window  (the floor that always applies)
 *
 * A strong signal only SHORTENS the stability window, it never skips it: a
 * closed stream means no more bytes, not that the page has painted them. The
 * rule is carried over from PlaywrightController, where extracting mid-render
 * truncated real replies.
 *
 * "Changed" is judged on the page's mutation counter and the reply text
 * together. The mutation counter is what makes polling cheap: when it has not
 * moved, the text is not re-read at all.
 */

export interface Tick {
  /** Milliseconds since the prompt was sent. */
  atMs: number;
  assistantCount: number;
  /** Text of the newest assistant message (may be omitted when mutationSeq did not move). */
  text?: string;
  stopVisible: boolean;
  streamsOpened: number;
  streamsClosed: number;
  /** Monotonic counter of DOM mutations under the watched region. */
  mutationSeq: number;
  /** HTTP status of the reply request, 0 if unknown. */
  streamStatus?: number;
}

export type DetectorPhase = "waiting" | "streaming" | "complete" | "failed";

export interface DetectorOptions {
  /** Quiet time required when no stronger signal is available. */
  stabilityMs: number;
  /** Quiet time required after the stream closed or the stop control went away. */
  settleMs: number;
  /** Give up if nothing starts within this. */
  startTimeoutMs: number;
  /** Hard ceiling. */
  maxWaitMs: number;
  useStopControl: boolean;
  /**
   * While the reply request is still open, stability alone does not end the
   * wait - the stream is the provider saying "more is coming". This is the
   * quiet time after which an open stream counts as stalled instead.
   */
  streamStallMs?: number;
}

export const DEFAULT_DETECTOR: DetectorOptions = {
  stabilityMs: 6000,
  settleMs: 1000,
  startTimeoutMs: 120000,
  maxWaitMs: 300000,
  useStopControl: true,
  streamStallMs: 60000,
};

export interface Verdict {
  phase: DetectorPhase;
  reason: "not-started" | "started" | "changing" | "stream-closed" | "stop-button-gone" | "stability" | "stalled" | "timeout" | "no-start" | "http-failure" | "empty-reply";
}

export class CompletionDetector {
  private started = false;
  private lastText: string;
  private lastChangeAt = 0;
  private lastSeq = -1;
  private stopSeen = false;
  private stopGoneAt = -1;
  private streamClosedAt = -1;
  private done: Verdict | null = null;

  constructor(private baseline: { count: number; text: string }, private opts: DetectorOptions = DEFAULT_DETECTOR) {
    this.lastText = baseline.text;
  }

  get hasStarted(): boolean { return this.started; }

  feed(t: Tick): Verdict {
    if (this.done) return this.done;
    if (t.streamStatus && t.streamStatus >= 400) return this.finish({ phase: "failed", reason: "http-failure" });

    const text = t.text !== undefined ? t.text : this.lastText;
    const seqMoved = t.mutationSeq !== this.lastSeq;
    this.lastSeq = t.mutationSeq;

    if (this.opts.useStopControl) {
      if (t.stopVisible) { this.stopSeen = true; this.stopGoneAt = -1; }
      else if (this.stopSeen && this.stopGoneAt < 0) this.stopGoneAt = t.atMs;
    }
    if (t.streamsOpened > 0 && t.streamsClosed >= t.streamsOpened) {
      if (this.streamClosedAt < 0) this.streamClosedAt = t.atMs;
    } else {
      this.streamClosedAt = -1;
    }

    if (!this.started) {
      // Anything that is not still the previous message counts as a new reply.
      // A follow-up's answer is often SHORTER than the one before it, so
      // "grew" is the wrong test - the controller learned that the hard way.
      const isNew = t.assistantCount > this.baseline.count || (text.length > 0 && text !== this.baseline.text);
      if (isNew) {
        this.started = true;
        this.lastText = text;
        this.lastChangeAt = t.atMs;
        return { phase: "streaming", reason: "started" };
      }
      // The provider said it answered - its stream opened and closed, or its
      // stop control came and went - and nothing new is on the page. That is an
      // empty reply, known now rather than after the whole start timeout.
      const streamEnded = this.streamClosedAt >= 0 && t.atMs - this.streamClosedAt >= this.opts.settleMs * 2;
      const stopEnded = this.stopGoneAt >= 0 && t.atMs - this.stopGoneAt >= this.opts.settleMs * 2;
      if (streamEnded || stopEnded) return this.finish({ phase: "complete", reason: "empty-reply" });
      if (t.atMs >= this.opts.startTimeoutMs && !t.stopVisible) return this.finish({ phase: "failed", reason: "no-start" });
      if (t.atMs >= this.opts.maxWaitMs) return this.finish({ phase: "failed", reason: "no-start" });
      return { phase: "waiting", reason: "not-started" };
    }

    if (text !== this.lastText || (seqMoved && t.text === undefined)) {
      this.lastText = text;
      this.lastChangeAt = t.atMs;
    }
    const quietFor = t.atMs - this.lastChangeAt;

    if (this.streamClosedAt >= 0 && quietFor >= this.opts.settleMs && t.atMs - this.streamClosedAt >= this.opts.settleMs) {
      return this.finish({ phase: "complete", reason: "stream-closed" });
    }
    if (this.stopGoneAt >= 0 && quietFor >= this.opts.settleMs && t.atMs - this.stopGoneAt >= this.opts.settleMs) {
      return this.finish({ phase: "complete", reason: "stop-button-gone" });
    }
    // While the provider says it is still writing - its stop control is up, or
    // its reply request is still open - stability alone does not end the wait:
    // a model pausing mid-answer is not a finished answer.
    const streamOpen = t.streamsOpened > t.streamsClosed;
    const stillWriting = (this.opts.useStopControl && t.stopVisible) || streamOpen;
    if (!stillWriting && quietFor >= this.opts.stabilityMs) return this.finish({ phase: "complete", reason: "stability" });
    const stallMs = this.opts.streamStallMs ?? DEFAULT_DETECTOR.streamStallMs!;
    if (streamOpen && !t.stopVisible && quietFor >= Math.max(stallMs, this.opts.stabilityMs)) return this.finish({ phase: "complete", reason: "stalled" });
    if (t.atMs >= this.opts.maxWaitMs) return this.finish({ phase: "complete", reason: "timeout" });
    return { phase: "streaming", reason: "changing" };
  }

  private finish(v: Verdict): Verdict { this.done = v; return v; }
}

/**
 * The reply as it grows: previous, current, and what arrived in between.
 *
 * A rewrite - the current text no longer extends the previous one, which
 * happens when a site re-renders markdown or a model revises - is reported as
 * such rather than as a nonsense delta.
 */
export class StreamCapture {
  private previous = "";
  readonly partials: Array<{ atMs: number; chars: number; delta: string; kind: "append" | "rewrite" }> = [];

  constructor(private maxPartials: number = 200) {}

  update(current: string, atMs: number): { delta: string; kind: "append" | "rewrite" | "none" } {
    if (current === this.previous) return { delta: "", kind: "none" };
    let kind: "append" | "rewrite";
    let delta: string;
    if (current.startsWith(this.previous)) { kind = "append"; delta = current.slice(this.previous.length); }
    else {
      // Longest common prefix, so a re-render of the last paragraph reports
      // only that paragraph as changed.
      let i = 0;
      const n = Math.min(current.length, this.previous.length);
      while (i < n && current.charCodeAt(i) === this.previous.charCodeAt(i)) i++;
      kind = "rewrite";
      delta = current.slice(i);
    }
    this.previous = current;
    this.partials.push({ atMs, chars: current.length, delta: delta.slice(0, 2000), kind });
    if (this.partials.length > this.maxPartials) this.partials.splice(0, this.partials.length - this.maxPartials);
    return { delta, kind };
  }

  get text(): string { return this.previous; }
}
