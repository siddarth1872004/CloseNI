/**
 * The parts every provider module needs: visibility checks that do not lie,
 * click-only-if-needed, and a guard that turns any failure into a reported
 * result rather than a thrown build.
 */
import { Page, Locator } from "playwright";
import { ControlResult } from "./types.js";
import { flagAction, fillSelector } from "./decisions.js";

/** Long enough for a Radix or Ant Design menu to finish animating open. */
export const MENU_SETTLE_MS = 600;
/** Long enough for a toggle's own state attribute to be written back. */
const STATE_SETTLE_MS = 350;

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Visible, not merely present. `count()` counts hidden elements too — that
 * exact mistake once made a CSS-hidden stop button read as permanently
 * generating, and it would be no better here.
 */
export async function isThere(loc: Locator): Promise<boolean> {
  return loc.isVisible({ timeout: 2000 }).catch(() => false);
}

/**
 * Every control is wrapped in this. A provider redesign, a detached element, a
 * menu that will not open: all become an "unavailable" line in the log and the
 * run carries on. Losing a preferred model is not worth losing a build.
 */
export async function guard(id: string, fn: () => Promise<ControlResult>): Promise<ControlResult> {
  try {
    return await fn();
  } catch (e) {
    return { id, action: "unavailable", detail: (e as Error).message.split("\n")[0].slice(0, 160) };
  }
}

/**
 * A toggle that carries its own state, found by the text inside it.
 * DeepSeek's `.ds-toggle-button` puts the label in a child span, so the
 * element is located by selector and filtered by text rather than matched on
 * text alone.
 */
export async function setFlagByText(
  page: Page,
  id: string,
  selector: string,
  text: string,
  want: boolean,
  attr: string = "aria-pressed",
): Promise<ControlResult> {
  const el = page.locator(selector).filter({ hasText: text }).first();
  if (!(await isThere(el))) return { id, action: "unavailable", detail: "no visible " + selector + " containing " + JSON.stringify(text) };

  const before = await el.getAttribute(attr);
  const decision = flagAction(before, want);
  if (decision === "unreadable") return { id, action: "unavailable", detail: "cannot read " + attr };
  if (decision === "already-set") return { id, action: "already-set", detail: attr + "=" + before };

  await el.click({ timeout: 5000 });
  await sleep(STATE_SETTLE_MS);
  const after = await el.getAttribute(attr);
  if (flagAction(after, want) !== "already-set") {
    return { id, action: "unavailable", detail: "clicked but " + attr + "=" + after };
  }
  return { id, action: "clicked", detail: attr + "=" + after };
}

/**
 * An always-present option identified by a value substituted into a selector
 * template — DeepSeek's mode radios. State is read from the option itself, so
 * a mode already chosen costs one read and no click.
 */
export async function setFlagByValue(
  page: Page,
  id: string,
  template: string,
  value: string,
  attr: string = "aria-checked",
): Promise<ControlResult> {
  const selector = fillSelector(template, value);
  const el = page.locator(selector).first();
  if (!(await isThere(el))) return { id, action: "unavailable", detail: "no visible " + selector };

  const before = await el.getAttribute(attr);
  const decision = flagAction(before, true);
  if (decision === "unreadable") return { id, action: "unavailable", detail: "cannot read " + attr };
  if (decision === "already-set") return { id, action: "already-set", detail: value };

  await el.click({ timeout: 5000 });
  await sleep(STATE_SETTLE_MS);
  const after = await el.getAttribute(attr);
  if (flagAction(after, true) !== "already-set") {
    return { id, action: "unavailable", detail: "clicked but " + attr + "=" + after };
  }
  return { id, action: "clicked", detail: value };
}

/** Close whatever menu is open, and do not care if nothing was. */
export async function dismissMenu(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(200);
}

/** One line per control, so a silent failure is at least a readable one. */
export function formatResults(providerId: string, results: ControlResult[]): string[] {
  return results.map((r) => "  " + providerId + " " + r.id + ": " + r.action + (r.detail ? " (" + r.detail + ")" : ""));
}
