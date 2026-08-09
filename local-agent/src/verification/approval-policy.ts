/**
 * What to do when a build wants to run a terminal command.
 *
 * Kept apart from index.ts, which calls main() on import — importing that from a
 * test would launch the agent. Separating the decision from the stdin read is
 * also what makes it testable at all.
 */
export type ApprovalDecision = "allow" | "deny" | "ask";

/**
 * Anything unrecognised prompts. Silently running commands the user never
 * approved is the one outcome that must never happen by accident, so an unset
 * or corrupted policy falls back to asking rather than to allowing.
 */
export function decideApproval(autonomy: string | undefined): ApprovalDecision {
  if (autonomy === "auto") return "allow";
  if (autonomy === "never") return "deny";
  return "ask";
}
