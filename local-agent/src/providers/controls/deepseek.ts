/**
 * DeepSeek. The simplest of the three: no menus at all.
 *
 *   <div role="radiogroup">
 *     <div data-model-type="default" role="radio" aria-checked="true">Instant</div>
 *     <div data-model-type="expert"  role="radio" aria-checked="false">Advanced</div>
 *   </div>
 *   <div aria-pressed="true" class="ds-toggle-button"><span>Deep thinking</span></div>
 *
 * Everything is on the page already and reports its own state, so each control
 * is one read and at most one click.
 */
import { ControlApplier, ControlResult } from "./types.js";
import { guard, setFlagByText, setFlagByValue } from "./helpers.js";

export const applyControls: ControlApplier = async (page, selectors, desired) => {
  const out: ControlResult[] = [];

  // Mode first. Instant and Advanced offer different toggles — Smart Search
  // exists only under Instant — so setting toggles before the mode would set
  // them on a panel that is about to be replaced.
  if (typeof desired.mode === "string" && selectors.modeOption) {
    out.push(await guard("mode", () => setFlagByValue(page, "mode", selectors.modeOption, desired.mode as string)));
  }

  if (typeof desired["deep-thinking"] === "boolean" && selectors.toggle) {
    out.push(await guard("deep-thinking", () =>
      setFlagByText(page, "deep-thinking", selectors.toggle, selectors.deepThinkingText || "Deep thinking", desired["deep-thinking"] as boolean)));
  }

  // Absent under Advanced. That reports as unavailable, which is honest: the
  // user asked for something this mode does not have.
  if (typeof desired["smart-search"] === "boolean" && selectors.toggle) {
    out.push(await guard("smart-search", () =>
      setFlagByText(page, "smart-search", selectors.toggle, selectors.smartSearchText || "Smart Search", desired["smart-search"] as boolean)));
  }

  return out;
};
