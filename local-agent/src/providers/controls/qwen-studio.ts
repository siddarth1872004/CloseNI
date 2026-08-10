/**
 * Qwen Studio. Ant Design comboboxes, and nothing like DeepSeek.
 *
 *   <div aria-label="Select Model" aria-haspopup="listbox">
 *     <div class="index-module__model-selector-text___XvWe0">Qwen3.8-Max</div>
 *
 * Two things follow from that markup. The current value is **visible text on
 * the trigger**, not an attribute, so state is scraped rather than read. And
 * the options **do not exist in the DOM until the menu is opened**, so setting
 * a value is open, find, click, verify — four steps where DeepSeek needs one.
 *
 * The class there is a CSS-module hash and changes every deploy; only
 * `aria-label` and Qwen's own `qwen-` classes are safe to select on.
 */
import { Page } from "playwright";
import { ControlApplier, ControlResult } from "./types.js";
import { labelAction, optionMatches } from "./decisions.js";
import { guard, isThere, sleep, dismissMenu, MENU_SETTLE_MS } from "./helpers.js";

/**
 * Pick an option by its visible label.
 *
 * `expandSelector` is for Qwen's model list, which hides its older models
 * behind "Expand more models". The list is searched first and expanded only if
 * the wanted model is not already showing.
 */
async function pickByLabel(
  page: Page,
  id: string,
  triggerSelector: string,
  optionSelector: string,
  titleSelector: string,
  want: string,
  expandSelector?: string,
): Promise<ControlResult> {
  const trigger = page.locator(triggerSelector).first();
  if (!(await isThere(trigger))) return { id, action: "unavailable", detail: "no visible " + triggerSelector };

  // The trigger tracks the real value, so an already-correct setting never
  // opens a menu at all.
  const current = await trigger.innerText().catch(() => "");
  if (labelAction(current, want) === "already-set") return { id, action: "already-set", detail: want };

  await trigger.click({ timeout: 5000 });
  await sleep(MENU_SETTLE_MS);

  let target = await findOption(page, optionSelector, titleSelector, want);
  if (!target && expandSelector) {
    const expand = page.locator(expandSelector).first();
    if (await isThere(expand)) {
      await expand.click({ timeout: 5000 });
      await sleep(MENU_SETTLE_MS);
      target = await findOption(page, optionSelector, titleSelector, want);
    }
  }
  if (!target) {
    await dismissMenu(page);
    return { id, action: "unavailable", detail: "no option labelled " + JSON.stringify(want) };
  }

  await target.click({ timeout: 5000 });
  await sleep(MENU_SETTLE_MS);

  // Verify against the trigger rather than trusting the click. Whether picking
  // an option closes the menu is Ant Design's business, not something worth
  // assuming, so the menu is dismissed either way.
  const after = await trigger.innerText().catch(() => "");
  await dismissMenu(page);
  if (labelAction(after, want) !== "already-set") {
    return { id, action: "unavailable", detail: "clicked but trigger reads " + JSON.stringify(String(after).split("\n")[0]) };
  }
  return { id, action: "clicked", detail: want };
}

/**
 * Match on the option's **title element**, not the whole card. Each Qwen model
 * renders with a description underneath, and Qwen3.7-Max's description
 * mentions Qwen3.7 — matching the card text would pick the wrong model.
 */
async function findOption(page: Page, optionSelector: string, titleSelector: string, want: string) {
  const options = page.locator(optionSelector);
  const n = await options.count();
  for (let i = 0; i < Math.min(n, 40); i++) {
    const opt = options.nth(i);
    if (!(await opt.isVisible().catch(() => false))) continue;
    const title = titleSelector ? opt.locator(titleSelector).first() : opt;
    const text = await title.innerText().catch(() => "");
    // Fall back to the card's own text only when there is no title element:
    // a menu of plain rows (Qwen's thinking levels) has nothing to descend to.
    const compare = text || (await opt.innerText().catch(() => ""));
    if (optionMatches(compare, want)) return opt;
  }
  return null;
}

export const applyControls: ControlApplier = async (page, selectors, desired) => {
  const out: ControlResult[] = [];

  if (typeof desired.model === "string" && selectors.modelTrigger) {
    out.push(await guard("model", () => pickByLabel(
      page, "model", selectors.modelTrigger, selectors.modelOption, selectors.modelOptionTitle, desired.model as string, selectors.modelExpand)));
  }

  if (typeof desired.thinking === "string" && selectors.thinkingTrigger) {
    out.push(await guard("thinking", () => pickByLabel(
      page, "thinking", selectors.thinkingTrigger, selectors.thinkingOption, selectors.thinkingOptionTitle, desired.thinking as string)));
  }

  return out;
};
