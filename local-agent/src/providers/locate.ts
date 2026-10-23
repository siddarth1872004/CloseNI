/**
 * Finding a control when the page has been redesigned.
 *
 * A CSS selector is the first thing a redesign breaks: class names are
 * rebuilt, often hashed. What a control is for changes far less often - the
 * composer stays a textbox, the copy button keeps saying Copy. So a control
 * can be described in tiers, tried in order of how well they survive:
 *
 *   1. its ARIA role and accessible name
 *   2. its visible text
 *   3. its CSS selector - the `selectors` entry, as before
 *
 * Tiers come from the provider config's `locate` map and only ever add to the
 * CSS selector, so a config without them behaves exactly as it always did.
 * Every tier must be measured on the live site before it goes into a config:
 * a guessed tier that matches the wrong element is worse than none.
 */
import type { Locator, Page } from "playwright";

export interface TargetTier {
  /** An ARIA role, such as "textbox" or "button". */
  role?: string;
  /** The accessible name, as a case-insensitive regex source. Needs `role`. */
  name?: string;
  /** Visible text, as a case-insensitive regex source. */
  text?: string;
  /** A CSS selector. */
  css?: string;
}

export type TierKind = "role" | "text" | "css";

export interface Found {
  locator: Locator;
  tier: TierKind;
  /** Which entry of the tier list matched, for the log. */
  index: number;
}

function regex(src: string): RegExp | null {
  try { return new RegExp(src, "i"); } catch { return null; }
}

function kindOf(t: TargetTier): TierKind | null {
  if (t.role) return "role";
  if (t.text) return "text";
  if (t.css) return "css";
  return null;
}

/**
 * The tiers for one control, best first: the configured ones sorted role,
 * text, css (stable within a kind), then the plain CSS selector. Entries that
 * describe nothing, or whose patterns do not compile, are dropped.
 */
export function tiersFor(locate: TargetTier[] | undefined, css: string | undefined): TargetTier[] {
  const rank: Record<TierKind, number> = { role: 0, text: 1, css: 2 };
  const valid = (locate || []).filter((t) => {
    const k = t && kindOf(t);
    if (!k) return false;
    if (k === "role" && t.name && !regex(t.name)) return false;
    if (k === "text" && !regex(t.text as string)) return false;
    return true;
  });
  const sorted = valid
    .map((t, i) => ({ t: t, i: i }))
    .sort((a, b) => rank[kindOf(a.t) as TierKind] - rank[kindOf(b.t) as TierKind] || a.i - b.i)
    .map((x) => x.t);
  if (css && css.trim() && !sorted.some((t) => t.css === css)) sorted.push({ css: css });
  return sorted;
}

function locatorFor(page: Page, t: TargetTier): Locator {
  if (t.role) {
    const name = t.name ? regex(t.name) : null;
    return page.getByRole(t.role as any, name ? { name: name } : {});
  }
  if (t.text) return page.getByText(regex(t.text) as RegExp);
  return page.locator(t.css as string);
}

/** The first tier with a visible match right now, or null. */
export async function findNow(page: Page, tiers: TargetTier[]): Promise<Found | null> {
  for (let i = 0; i < tiers.length; i++) {
    const loc = locatorFor(page, tiers[i]);
    try {
      const n = await loc.count();
      for (let k = 0; k < n && k < 5; k++) {
        const one = loc.nth(k);
        if (await one.isVisible()) return { locator: one, tier: kindOf(tiers[i]) as TierKind, index: i };
      }
    } catch { /* an invalid selector finds nothing */ }
  }
  return null;
}

/** findNow, polled until `timeoutMs`. */
export async function findWithin(page: Page, tiers: TargetTier[], timeoutMs: number, pollMs: number = 250): Promise<Found | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const f = await findNow(page, tiers);
    if (f || Date.now() >= end) return f;
    await page.waitForTimeout(pollMs);
  }
}
