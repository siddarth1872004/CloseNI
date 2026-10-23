/**
 * How full the conversation a build or agent runs in has grown.
 *
 * Chat, plan and build share one thread, which is what made a step prompt a
 * fraction of what it used to be. The cost is that the thread only grows: every
 * step's prompt and every reply - and a reply carries complete files - stays in
 * it, and the provider re-reads all of it on every turn. A long build eventually
 * outgrows the window, and the failure arrives at step fifteen, an hour in.
 *
 * Nothing here shortens or replaces a conversation. It is the provider's, and
 * the thread stays as long as the user keeps it; a provider that calls it full
 * says so, and the user starts a new chat. This only measures it, for the size
 * /compact reports.
 *
 * It counts our own traffic - what we sent, and the replies we already have
 * in full - rather than inspecting anything on their page. The budget is a
 * configured guess; the measurement is not.
 */

/**
 * Chars, not tokens.
 *
 * Tokenising properly would mean shipping a tokeniser per provider and keeping
 * it in step with models we do not control. Characters are within a small factor
 * across every language this builds.
 */
export const DEFAULT_BUDGET_CHARS = 150000;

export interface ConversationSize {
  /** Characters sent and received in this thread so far. */
  chars: number;
  /** Turns taken, for the log line - a conversation's age in useful units. */
  turns: number;
}

export function emptySize(): ConversationSize {
  return { chars: 0, turns: 0 };
}

/** Read a size back from storage, treating anything malformed as a new thread. */
export function readSize(raw: any): ConversationSize {
  if (!raw || typeof raw !== "object") return emptySize();
  const chars = Number(raw.chars);
  const turns = Number(raw.turns);
  return {
    chars: Number.isFinite(chars) && chars > 0 ? Math.floor(chars) : 0,
    turns: Number.isFinite(turns) && turns > 0 ? Math.floor(turns) : 0,
  };
}

/** Add one exchange. A reply we failed to read counts as its prompt alone. */
export function addTurn(size: ConversationSize, promptChars: number, replyChars: number): ConversationSize {
  const base = readSize(size);
  const p = Number.isFinite(promptChars) && promptChars > 0 ? Math.floor(promptChars) : 0;
  const r = Number.isFinite(replyChars) && replyChars > 0 ? Math.floor(replyChars) : 0;
  return { chars: base.chars + p + r, turns: base.turns + 1 };
}

export function budgetFor(configured: number | undefined): number {
  const n = Number(configured);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_BUDGET_CHARS;
}

/** The line the user reads. Percentages, because the raw number means nothing. */
export function describeSize(size: ConversationSize, budgetChars: number): string {
  const budget = budgetFor(budgetChars);
  const s = readSize(size);
  return s.turns + " turn" + (s.turns === 1 ? "" : "s") + ", " +
    Math.round((s.chars / budget) * 100) + "% of the conversation budget";
}
