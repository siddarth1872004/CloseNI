/**
 * Where a provider stands, as one named state.
 *
 * The causes were already told apart - reply-trouble classifies what the page
 * said, ReplyDropped is a reply that never began - but each caller decided for
 * itself what a cause meant: retry, stop, or ask the person. This module is
 * the one place that decision lives, so a new cause is added once and every
 * caller treats it the same way.
 *
 * The groups are what a status asks of whoever is driving:
 *   active        nothing to do: the provider is idle or answering
 *   recovery      wait and send again, with a capped backoff
 *   intervention  stop and ask the person - never retried automatically
 *   handler       the caller resolves it: re-ask, or tell the person how to
 *                 continue a full conversation (never a new chat on its own)
 *   terminal      stop: nothing sent now can succeed
 */
import { TroubleKind } from "./reply-trouble.js";

export type ProviderStatus =
  | "READY" | "GENERATING"
  | "RATE_LIMITED" | "NETWORK_ERROR"
  | "AUTH_REQUIRED" | "CHALLENGE_REQUIRED"
  | "RESPONSE_INCOMPLETE" | "CONTEXT_FULL"
  | "PAGE_CHANGED" | "PAUSED" | "UNSUPPORTED";

export type StatusGroup = "active" | "recovery" | "intervention" | "handler" | "terminal";

export const STATUS_GROUP: Record<ProviderStatus, StatusGroup> = {
  READY: "active",
  GENERATING: "active",
  RATE_LIMITED: "recovery",
  NETWORK_ERROR: "recovery",
  AUTH_REQUIRED: "intervention",
  CHALLENGE_REQUIRED: "intervention",
  RESPONSE_INCOMPLETE: "handler",
  CONTEXT_FULL: "handler",
  PAGE_CHANGED: "terminal",
  PAUSED: "terminal",
  UNSUPPORTED: "terminal",
};

export function groupOf(status: ProviderStatus): StatusGroup {
  return STATUS_GROUP[status];
}

/** What the provider said instead of a reply, as a status. */
export function statusForTrouble(kind: TroubleKind): ProviderStatus {
  switch (kind) {
    case "rate-limit": return "RATE_LIMITED";
    case "busy": return "NETWORK_ERROR";
    case "signed-out": return "AUTH_REQUIRED";
    case "challenge": return "CHALLENGE_REQUIRED";
    case "full": case "too-long": return "CONTEXT_FULL";
    // A withheld reply is answered by asking again, once.
    case "refused": return "RESPONSE_INCOMPLETE";
  }
}

/**
 * Whether the controller may send the same prompt again on its own.
 *
 * Only recovery, and a reply that never came. A challenge or a sign-in page
 * waits for the person: sending into it again would at best do nothing and at
 * worst look like exactly the traffic the challenge is there to stop.
 */
export function mayRetry(status: ProviderStatus): boolean {
  return groupOf(status) === "recovery" || status === "RESPONSE_INCOMPLETE";
}

/**
 * The moves allowed from each group. Anything may end in PAUSED (Esc) or in a
 * terminal status; leaving intervention or terminal takes READY, which is only
 * set once the page has been checked again.
 */
export function canMove(from: ProviderStatus, to: ProviderStatus): boolean {
  if (from === to) return true;
  if (to === "PAUSED" || groupOf(to) === "terminal") return true;
  const g = groupOf(from);
  if (g === "intervention" || g === "terminal") return to === "READY";
  return true;
}

/**
 * The current status, moved only along canMove. A refused move is kept out
 * rather than thrown: a status line that is briefly behind is harmless, an
 * exception in the reply wait is not.
 */
export class StatusTracker {
  private current: ProviderStatus = "READY";
  private detail = "";

  constructor(private onChange?: (status: ProviderStatus, detail: string) => void) {}

  get status(): ProviderStatus { return this.current; }
  get why(): string { return this.detail; }

  /** True when the move was made. */
  set(next: ProviderStatus, detail: string = ""): boolean {
    if (!canMove(this.current, next)) return false;
    const changed = next !== this.current || detail !== this.detail;
    this.current = next;
    this.detail = detail;
    if (changed && this.onChange) {
      try { this.onChange(next, detail); } catch { /* a listener must not break the caller */ }
    }
    return true;
  }
}
