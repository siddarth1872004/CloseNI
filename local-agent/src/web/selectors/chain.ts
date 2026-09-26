/**
 * Finding an element on a page nobody here controls, and saying how.
 *
 * Every serious bug in this project came from a selector that quietly stopped
 * describing the page. A single CSS string fails silently: it matches nothing,
 * or worse, matches the wrong thing. A chain tries descriptions in order of how
 * long they tend to survive a redesign -
 *
 *   ARIA role + accessible name  →  label / placeholder  →  stable attribute
 *   →  semantic HTML  →  visible text  →  structure  →  heuristic
 *
 * - and records which link held. A chain that is being carried by its last,
 * weakest link is a warning worth surfacing before it breaks, which is what
 * diagnoseChain is for.
 *
 * Each strategy carries its provenance: MEASURED against the live site,
 * FIXTURE (proven against local markup), or UNVERIFIED. A diagnosis says which
 * kind held, so "working" on an unverified guess is not mistaken for proof.
 */
import { Page, Locator } from "playwright";

export type Provenance = "MEASURED" | "FIXTURE" | "UNVERIFIED";

export type Strategy =
  | { kind: "role"; role: string; name?: string; exact?: boolean; provenance?: Provenance }
  | { kind: "label"; text: string; provenance?: Provenance }
  | { kind: "placeholder"; text: string; provenance?: Provenance }
  | { kind: "testid"; id: string; provenance?: Provenance }
  | { kind: "css"; css: string; provenance?: Provenance; note?: string }
  | { kind: "text"; text: string; exact?: boolean; provenance?: Provenance }
  | { kind: "structural"; css: string; provenance?: Provenance }
  | { kind: "heuristic"; name: HeuristicName; provenance?: Provenance };

export type HeuristicName = "composer" | "send-button" | "stop-button" | "last-assistant-block" | "main-content";

export interface ChainSpec {
  name: string;
  strategies: Strategy[];
  /** Only count visible matches. Hidden duplicates are the classic false positive. */
  visibleOnly?: boolean;
}

export interface Resolved {
  locator: Locator;
  index: number;
  strategy: Strategy;
  count: number;
  description: string;
}

/** "/pattern/flags" → RegExp; anything else stays a string. */
function nameMatcher(name: string | undefined): string | RegExp | undefined {
  if (name === undefined) return undefined;
  const m = /^\/(.*)\/([gimsuy]*)$/.exec(name);
  if (m) { try { return new RegExp(m[1], m[2]); } catch { return name; } }
  return name;
}

export function describeStrategy(s: Strategy): string {
  switch (s.kind) {
    case "role": return "role=" + s.role + (s.name ? "[name=" + JSON.stringify(s.name) + "]" : "");
    case "label": return "label=" + JSON.stringify(s.text);
    case "placeholder": return "placeholder=" + JSON.stringify(s.text);
    case "testid": return "testid=" + JSON.stringify(s.id);
    case "css": return "css=" + s.css;
    case "text": return "text=" + JSON.stringify(s.text);
    case "structural": return "structure=" + s.css;
    case "heuristic": return "heuristic=" + s.name;
  }
}

/** Build the Playwright locator a strategy describes, scoped to root when given. */
export function locatorFor(page: Page, s: Strategy, root?: Locator): Locator {
  const base: Page | Locator = root || page;
  switch (s.kind) {
    case "role": return base.getByRole(s.role as any, { name: nameMatcher(s.name), exact: s.exact });
    case "label": return base.getByLabel(nameMatcher(s.text) as any);
    case "placeholder": return base.getByPlaceholder(nameMatcher(s.text) as any);
    case "testid": return base.getByTestId(s.id);
    case "css": return base.locator(s.css);
    case "text": return base.getByText(nameMatcher(s.text) as any, { exact: s.exact });
    case "structural": return base.locator(s.css);
    case "heuristic": return base.locator('[data-closeni-h~="' + s.name + '"]');
  }
}

/**
 * Mark elements a heuristic picks, so an ordinary locator can find them.
 *
 * Runs in the page. Heuristics are the last link: they describe what a composer
 * or a reply looks like on any chat site, with no provider knowledge, so they
 * keep a run alive through a redesign long enough for the diagnosis to say which
 * specific selector needs re-capturing.
 */
export async function runHeuristic(page: Page, name: HeuristicName): Promise<number> {
  return page.evaluate((h: string) => {
    const doc: any = (globalThis as any).document;
    const win: any = globalThis as any;
    for (const el of Array.from(doc.querySelectorAll('[data-closeni-h]')) as any[]) {
      const rest = String(el.getAttribute("data-closeni-h")).split(" ").filter((x: string) => x !== h);
      if (rest.length) el.setAttribute("data-closeni-h", rest.join(" ")); else el.removeAttribute("data-closeni-h");
    }
    const visible = (el: any) => {
      const r = el.getBoundingClientRect();
      const cs = win.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    const mark = (el: any) => {
      const cur = el.getAttribute("data-closeni-h");
      el.setAttribute("data-closeni-h", cur ? cur + " " + h : h);
    };
    const composers = (Array.from(doc.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')) as any[])
      .filter((el) => visible(el) && !el.disabled && el.getAttribute("aria-hidden") !== "true");
    // The composer is the largest visible editable region nearest the bottom.
    const composer = composers.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (rb.bottom + rb.width * rb.height / 1e4) - (ra.bottom + ra.width * ra.height / 1e4);
    })[0];

    if (h === "composer") { if (composer) { mark(composer); return 1; } return 0; }

    if (h === "send-button" || h === "stop-button") {
      if (!composer) return 0;
      // Walk up from the composer until a container holds buttons.
      let box: any = composer.parentElement;
      for (let i = 0; i < 6 && box; i++) {
        const btns = (Array.from(box.querySelectorAll('button, [role="button"]')) as any[]).filter(visible);
        if (btns.length) {
          const want = h === "send-button" ? /send|submit|发送|提交/i : /stop|cancel|停止/i;
          const labelled = btns.filter((b) => want.test(String(b.getAttribute("aria-label") || "") + " " + String(b.textContent || "") + " " + String(b.getAttribute("title") || "")));
          const pick = labelled[0] || (h === "send-button" ? btns[btns.length - 1] : null);
          if (pick) { mark(pick); return 1; }
          return 0;
        }
        box = box.parentElement;
      }
      return 0;
    }

    if (h === "last-assistant-block") {
      // The last large text block above the composer that is not the composer
      // and not a navigation list. Deliberately returns ONE node: the newest reply.
      const cBottom = composer ? composer.getBoundingClientRect().top : Infinity;
      const blocks = (Array.from(doc.querySelectorAll("article, section, div")) as any[]).filter((el) => {
        if (!visible(el)) return false;
        const r = el.getBoundingClientRect();
        if (r.top > cBottom) return false;
        const text = String(el.innerText || "").trim();
        if (text.length < 20) return false;
        if (el.querySelector("textarea, [contenteditable=true], nav")) return false;
        const links = el.querySelectorAll("a").length;
        return links < 1 + text.length / 80;
      });
      // Innermost qualifying blocks only, then the lowest on screen.
      const leaves = blocks.filter((b) => !blocks.some((o) => o !== b && b.contains(o)));
      leaves.sort((a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom);
      const last = leaves[leaves.length - 1];
      if (last) { mark(last); return 1; }
      return 0;
    }

    if (h === "main-content") {
      const el = doc.querySelector("main, [role=main], article") || doc.body;
      if (el) { mark(el); return 1; }
      return 0;
    }
    return 0;
  }, name);
}

async function countOf(loc: Locator, visibleOnly: boolean): Promise<number> {
  const n = await loc.count();
  if (!visibleOnly || n === 0) return n;
  let v = 0;
  for (let i = 0; i < Math.min(n, 25); i++) {
    if (await loc.nth(i).isVisible().catch(() => false)) v++;
  }
  return v;
}

/** The first strategy that matches something, or null. Never throws for a bad selector. */
export async function resolveChain(page: Page, spec: ChainSpec, root?: Locator): Promise<Resolved | null> {
  for (let i = 0; i < spec.strategies.length; i++) {
    const s = spec.strategies[i];
    try {
      if (s.kind === "heuristic") await runHeuristic(page, s.name);
      const loc = locatorFor(page, s, root);
      const n = await countOf(loc, !!spec.visibleOnly);
      if (n > 0) {
        const base = spec.visibleOnly ? loc.filter({ visible: true } as any) : loc;
        return { locator: base, index: i, strategy: s, count: n, description: describeStrategy(s) };
      }
    } catch { /* invalid selector or detached root: try the next link */ }
  }
  return null;
}

export interface StrategyReport { description: string; provenance: Provenance; count: number; error?: string }

export interface ChainDiagnosis {
  name: string;
  verdict: "ok" | "fallback" | "broken";
  /** Index of the strategy that would be used, -1 when none match. */
  winner: number;
  results: StrategyReport[];
  note: string;
}

/**
 * Every strategy's count, not just the winner's.
 *
 * "fallback" means the chain still works but its primary link does not - the
 * moment to re-capture, before the fallback also goes.
 */
export async function diagnoseChain(page: Page, spec: ChainSpec): Promise<ChainDiagnosis> {
  const results: StrategyReport[] = [];
  let winner = -1;
  for (let i = 0; i < spec.strategies.length; i++) {
    const s = spec.strategies[i];
    const provenance: Provenance = (s as any).provenance || "UNVERIFIED";
    try {
      if (s.kind === "heuristic") await runHeuristic(page, s.name);
      const n = await countOf(locatorFor(page, s), !!spec.visibleOnly);
      results.push({ description: describeStrategy(s), provenance, count: n });
      if (n > 0 && winner === -1) winner = i;
    } catch (err: any) {
      results.push({ description: describeStrategy(s), provenance, count: 0, error: String(err && err.message || err).split("\n")[0].slice(0, 200) });
    }
  }
  return judgeChain(spec.name, results, winner);
}

/** Pure: what a set of strategy counts means. */
export function judgeChain(name: string, results: StrategyReport[], winner: number): ChainDiagnosis {
  if (winner === -1) {
    const errs = results.filter((r) => r.error).length;
    return { name, verdict: "broken", winner, results,
      note: "no strategy matched" + (errs ? " (" + errs + " invalid)" : "") + " - the page no longer looks the way any description expects" };
  }
  if (winner === 0) {
    return { name, verdict: "ok", winner, results, note: "primary strategy matched (" + results[0].provenance + ")" };
  }
  return { name, verdict: "fallback", winner, results,
    note: "primary " + results[0].description + " matched nothing; carried by #" + (winner + 1) + " " +
      results[winner].description + " (" + results[winner].provenance + ") - re-capture before it also breaks" };
}
