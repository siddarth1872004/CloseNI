/**
 * Did the stop control appear at all since the prompt was sent?
 *
 * Polling cannot answer that. A reply that is over almost at once - an empty
 * one - shows its stop control for a few milliseconds, and whether a poll
 * lands inside that window is luck. When it does not, the wait never learns
 * the provider answered, and runs out its start timeout. That flaked in the
 * suite exactly this way.
 *
 * So the page watches for itself: a MutationObserver (attributes included -
 * showing a button is usually a style or class change, not a new node) checks
 * the stop control on every change and counts each time it goes from hidden to
 * shown. The provider reads the count; a count above what it has seen is a
 * stop control that came and went between polls.
 *
 * The chain's strategies are compiled to what can be checked in the page: CSS
 * as is, a test id as its attribute, and a button role with a name pattern as
 * a match against the button's label. Other strategy kinds are left to the
 * poll, as before.
 */
import { ChainSpec } from "../selectors/chain.js";

export interface StopProbe { css?: string; buttonName?: string }

/** The strategies of a stop chain that can be checked from inside the page. */
export function stopProbes(chain: ChainSpec): StopProbe[] {
  const out: StopProbe[] = [];
  for (const s of chain.strategies) {
    if (s.kind === "css" || s.kind === "structural") out.push({ css: s.css });
    else if (s.kind === "testid") out.push({ css: '[data-testid="' + s.id.replace(/"/g, '\\"') + '"]' });
    else if (s.kind === "role" && s.role === "button") out.push({ buttonName: s.name || "" });
  }
  return out;
}

/**
 * Runs in the page. Self-contained: Playwright serialises it with toString().
 * Safe to run again - it updates the probes and keeps one observer.
 */
export function stopWatcherInPage(probes: StopProbe[]): void {
  const w = globalThis as any;
  const doc = w.document;
  const state = w.__closeniStop || { shown: 0, visible: false, installed: false, probes: [] };
  w.__closeniStop = state;
  state.probes = probes;
  if (state.installed) return;
  state.installed = true;

  const vis = (el: any) => {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === "function") { try { if (!el.checkVisibility({ visibilityProperty: true })) return false; } catch { /* old engine */ } }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const toRe = (src: string) => {
    const m = /^\/(.*)\/([a-z]*)$/.exec(src || "");
    try { return m ? new RegExp(m[1], m[2]) : src ? new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null; } catch { return null; }
  };
  const present = () => {
    for (const pr of state.probes as any[]) {
      try {
        if (pr.css) {
          for (const el of Array.from(doc.querySelectorAll(pr.css)) as any[]) if (vis(el)) return true;
        } else if (pr.buttonName !== undefined) {
          const re = toRe(pr.buttonName);
          const buttons = (Array.from(doc.querySelectorAll('button, [role="button"]')) as any[]).slice(0, 300);
          for (const el of buttons) {
            const label = [el.getAttribute("aria-label"), el.getAttribute("title"), el.innerText].filter(Boolean).join(" ").trim();
            if ((!re || re.test(label)) && vis(el)) return true;
          }
        }
      } catch { /* a bad probe never breaks the page */ }
    }
    return false;
  };
  const check = () => {
    const v = present();
    if (v && !state.visible) state.shown++;
    state.visible = v;
  };
  const start = () => {
    if (!doc.body) return false;
    new w.MutationObserver(check).observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "hidden", "aria-hidden", "disabled"] });
    check();
    return true;
  };
  if (!start()) doc.addEventListener("DOMContentLoaded", start, { once: true });
}
