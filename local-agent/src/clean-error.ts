/**
 * An error message fit to show a person.
 *
 * Playwright errors carry a "Call log:" of internal steps and terminal colour
 * codes (ESC[2m ... ESC[22m). Passed through as they are, the app showed both:
 * raw escape characters and a navigation trace under a one-line cause. The
 * first line is the cause; the rest is for a debugger, and the trace file
 * already has it.
 */
export function cleanError(message: unknown): string {
  let s = String(message === undefined || message === null ? "" : message);
  // eslint-disable-next-line no-control-regex
  s = s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  const cut = s.search(/\n\s*Call log:/);
  if (cut >= 0) s = s.slice(0, cut);
  return s.trim();
}
