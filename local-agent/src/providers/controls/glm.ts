/**
 * GLM (Z.ai). Radix UI: menus render into a portal, and options carry both a
 * value and their own selected state.
 *
 *   <button aria-label="Select a model">
 *   <div aria-label="model-item" data-value="glm-5.2" data-selected="true">GLM-5.2
 *
 * The casing in `data-value` is inconsistent in GLM's own markup — `glm-5.2`
 * and `glm-4.7` lowercase, `GLM-5.1` and `GLM-5-Turbo` uppercase, `GLM-5v-Turbo`
 * with a lowercase v where the label shows 5V. Values are therefore copied
 * verbatim into the config and never derived from a label.
 *
 * Deep Think is a second menu whose trigger text stays "Deep Think" whatever
 * level is chosen, so its state can only be read with the menu open.
 */
import { Page, Locator } from "playwright";
import { ControlApplier, ControlResult } from "./types.js";
import { flagAction, labelAction, optionMatches, fillSelector } from "./decisions.js";
import { guard, isThere, sleep, dismissMenu, MENU_SETTLE_MS } from "./helpers.js";

/** Open a menu whose trigger is identified by the text inside it. */
async function openMenu(page: Page, triggerSelector: string, triggerText?: string): Promise<Locator | null> {
  const base = page.locator(triggerSelector);
  const trigger = (triggerText ? base.filter({ hasText: triggerText }) : base).first();
  if (!(await isThere(trigger))) return null;
  await trigger.click({ timeout: 5000 });
  await sleep(MENU_SETTLE_MS);
  return trigger;
}

/**
 * Pick a model by its `data-value`.
 *
 * The trigger shows the current model, so a correct setting is caught before
 * any menu opens. Once open, `data-selected` on the option is the authority —
 * it is what GLM itself uses.
 */
async function pickModel(page: Page, id: string, selectors: Record<string, string>, value: string): Promise<ControlResult> {
  const trigger = page.locator(selectors.modelTrigger).first();
  if (!(await isThere(trigger))) return { id, action: "unavailable", detail: "no visible " + selectors.modelTrigger };

  // Values and labels differ only by case, which normalisation removes, so the
  // trigger's text answers "is this already right?" without opening anything.
  const current = await trigger.innerText().catch(() => "");
  if (labelAction(current, value) === "already-set") return { id, action: "already-set", detail: value };

  await trigger.click({ timeout: 5000 });
  await sleep(MENU_SETTLE_MS);

  const option = page.locator(fillSelector(selectors.modelOption, value)).first();
  if (!(await isThere(option))) {
    await dismissMenu(page);
    return { id, action: "unavailable", detail: "no option with data-value " + JSON.stringify(value) };
  }

  const before = await option.getAttribute("data-selected");
  if (flagAction(before, true) === "already-set") {
    await dismissMenu(page);
    return { id, action: "already-set", detail: value };
  }

  await option.click({ timeout: 5000 });
  await sleep(MENU_SETTLE_MS);

  // Radix closes the menu on select, taking the option out of the DOM with it,
  // so confirmation has to come from the trigger.
  const after = await trigger.innerText().catch(() => "");
  await dismissMenu(page);
  if (labelAction(after, value) !== "already-set") {
    return { id, action: "unavailable", detail: "clicked but trigger reads " + JSON.stringify(String(after).split("\n")[0]) };
  }
  return { id, action: "clicked", detail: value };
}

/**
 * Pick a Deep Think level (High / Max) by its label.
 *
 * The trigger reveals nothing, so the menu is opened every time and
 * `data-selected` inside it decides whether a click is needed. Choosing a level
 * is also what engages Deep Think, which is why the separate on/off item in
 * that menu is deliberately left alone — it reports no readable state, and
 * clicking it blind could switch off the thing being configured.
 */
async function pickThinking(page: Page, id: string, selectors: Record<string, string>, want: string): Promise<ControlResult> {
  const trigger = await openMenu(page, selectors.thinkingTrigger, selectors.thinkingTriggerText || "Deep Think");
  if (!trigger) return { id, action: "unavailable", detail: "no visible Deep Think trigger" };

  const options = page.locator(selectors.thinkingOption);
  const n = await options.count();
  for (let i = 0; i < Math.min(n, 20); i++) {
    const opt = options.nth(i);
    if (!(await opt.isVisible().catch(() => false))) continue;
    const text = await opt.innerText().catch(() => "");
    if (!optionMatches(text, want)) continue;

    const before = await opt.getAttribute("data-selected");
    if (flagAction(before, true) === "already-set") {
      await dismissMenu(page);
      return { id, action: "already-set", detail: want };
    }
    await opt.click({ timeout: 5000 });
    await sleep(MENU_SETTLE_MS);
    await dismissMenu(page);
    return { id, action: "clicked", detail: want };
  }

  await dismissMenu(page);
  return { id, action: "unavailable", detail: "no option labelled " + JSON.stringify(want) };
}

export const applyControls: ControlApplier = async (page, selectors, desired) => {
  const out: ControlResult[] = [];

  if (typeof desired.model === "string" && selectors.modelTrigger && selectors.modelOption) {
    out.push(await guard("model", () => pickModel(page, "model", selectors, desired.model as string)));
  }

  if (typeof desired.thinking === "string" && selectors.thinkingTrigger && selectors.thinkingOption) {
    out.push(await guard("thinking", () => pickThinking(page, "thinking", selectors, desired.thinking as string)));
  }

  return out;
};
