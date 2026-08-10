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
