/**
 * How big is a plan, and how long will it take?
 *
 * Every step is a browser round-trip: send a prompt, wait for a model to write
 * files, apply and syntax-check them. That is a minute or two each, so a
 * twenty-step plan is a long build. The estimate exists so the user chooses
 * that rather than discovering it.
 */

/**
 * Upper bound on plan length.
 *
 * Not a design cap - it is a guard against a malformed reply proposing hundreds
 * of steps and starting a build that runs for a day. A plan over this is
 * rejected and re-asked, never truncated: truncating drops the end of the
 * project - deployment, tests - which is worse than asking again.
 */
export const MAX_PLAN_STEPS = 40;

/** Roughly what a step costs door to door, measured against real builds. */
const SECONDS_PER_STEP = 90;

export function estimateDuration(stepCount: number): string {
  const minutes = Math.round((Math.max(0, stepCount) * SECONDS_PER_STEP) / 60);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return "roughly " + minutes + " min";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return "roughly " + hours + "h" + (rest ? " " + rest + "m" : "");
}
