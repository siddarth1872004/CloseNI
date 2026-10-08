export interface CompletionState {
  /** A reply has begun arriving. Nothing completes before this. */
  started: boolean;
  /** The provider's stop button was observed at least once. */
  stopSeen: boolean;
  /** It was observed and has since disappeared. */
  stopGone: boolean;
  /** Consecutive polls where the reply text did not change. */
  stableTicks: number;
}

/**
 * Two signals, in priority order.
 *
 * The stop button vanishing means the provider itself considers the reply
 * finished — immediate and exact. It only counts once a reply has started; a
 * stop button absent because generation has not begun is not a finished reply.
 *
 * Stability is the fallback and the floor: it applies when the provider has no
 * stop button, when the selector is wrong, or when the button never appeared.
 * The stop signal can only make a wait shorter, never end one that stability
 * would not eventually end on its own.
 */
export function isComplete(state: CompletionState, useStopButton: boolean, requiredStableTicks: number): boolean {
  if (!state.started) return false;
  if (useStopButton && state.stopSeen && state.stopGone) return true;
  return state.stableTicks >= requiredStableTicks;
}

export interface StreamState {
  /** A reply has begun arriving on the page. */
  started: boolean;
  streamsOpened: number;
  streamsClosed: number;
  /** Consecutive polls since every opened reply stream had closed. */
  ticksSinceClosed: number;
}

/**
 * The provider ended its reply before writing any of it.
 *
 * Seen live on DeepSeek, 8 October 2026: a 9146-character rollover prompt got
 * 0.3s of thinking, the server marked the message INCOMPLETE and closed the
 * stream, and the page showed no answer. Nothing more was ever coming, yet the
 * wait sat at "messages=0" for its whole 300s. A closed stream with nothing on
 * the page a few polls later is that case, and it ends the wait.
 */
export function endedWithoutReply(s: StreamState, graceTicks: number): boolean {
  if (s.started || s.streamsOpened === 0 || s.streamsClosed < s.streamsOpened) return false;
  return s.ticksSinceClosed >= graceTicks;
}

/** Thrown when the provider dropped a reply it never began, so the caller may ask again. */
export class ReplyDropped extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplyDropped";
  }
}
