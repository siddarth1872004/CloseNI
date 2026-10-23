/**
 * What to keep when something fails on a page, so the adapter can be fixed
 * without reproducing the failure.
 *
 * A screenshot, a sanitised DOM, an accessibility snapshot, the URL, console
 * and network errors, and whatever the caller knows (state, selector report).
 *
 * The DOM is sanitised before it is written: input values, password fields,
 * hidden-input values and inline script bodies are removed, because a provider
 * page is an authenticated page. Artifacts go under the storage directory,
 * which is git-ignored and never packaged. Cookies and storage state are never
 * captured at all.
 */
import * as fs from "fs";
import * as path from "path";
import { ManagedPage } from "./session-manager.js";
import { redactUrl, redactText } from "../trace.js";

export interface DebugArtifacts {
  dir: string;
  files: string[];
  url: string;
  title: string;
  consoleErrors: string[];
  failedRequests: Array<{ url: string; failure: string }>;
  extra: Record<string, unknown>;
}

export interface CaptureOptions {
  screenshot?: boolean;
  dom?: boolean;
  aria?: boolean;
  /** Cap on the sanitised DOM written, in characters. */
  maxDomChars?: number;
}

/** Where diagnostics go: <storage>/diagnostics/<run>/<label>. */
export function diagnosticsRoot(): string {
  const base = process.env.CLOSENI_STORAGE || path.resolve(__dirname, "..", "..", "..", "storage");
  return path.join(base, "diagnostics");
}

export async function captureDiagnostics(mp: ManagedPage, dir: string, label: string,
  extra: Record<string, unknown> = {}, opts: CaptureOptions = {}): Promise<DebugArtifacts> {
  const safe = label.replace(/[^\w.-]+/g, "_").slice(0, 80) || "capture";
  const out = path.join(dir, safe + "-" + Date.now().toString(36));
  fs.mkdirSync(out, { recursive: true });
  const files: string[] = [];
  const page = mp.page;
  const alive = mp.healthy();
  let url = "";
  let title = "";
  try { url = redactUrl(page.url()); } catch { /* crashed */ }
  if (alive) { try { title = await page.title(); } catch { /* crashed */ } }

  if (alive && opts.screenshot !== false) {
    try {
      const f = path.join(out, "screenshot.png");
      // Viewport only: a full-page capture of a long chat is slow and huge.
      await page.screenshot({ path: f, timeout: 5000 });
      files.push(f);
    } catch { /* a crashed or hung page cannot be photographed */ }
  }

  if (alive && opts.dom !== false) {
    try {
      const html: string = await page.evaluate(() => {
        const doc: any = (globalThis as any).document;
        const clone = doc.documentElement.cloneNode(true);
        for (const el of Array.from(clone.querySelectorAll("script")) as any[]) {
          if (el.textContent) el.textContent = "/* removed */";
        }
        for (const el of Array.from(clone.querySelectorAll("input, textarea")) as any[]) {
          el.removeAttribute("value");
          if (el.tagName === "TEXTAREA") el.textContent = "";
        }
        for (const el of Array.from(clone.querySelectorAll("[contenteditable=true]")) as any[]) el.textContent = "";
        for (const el of Array.from(clone.querySelectorAll("style")) as any[]) el.textContent = "/* removed */";
        return "<!doctype html>\n" + clone.outerHTML;
      });
      const f = path.join(out, "dom.html");
      fs.writeFileSync(f, redactText(html).slice(0, opts.maxDomChars ?? 2000000));
      files.push(f);
    } catch { /* same */ }
  }

  if (alive && opts.aria !== false) {
    try {
      const snap = await page.locator("body").ariaSnapshot({ timeout: 5000 });
      const f = path.join(out, "aria.yaml");
      fs.writeFileSync(f, redactText(snap));
      files.push(f);
    } catch { /* older Playwright, or a page mid-teardown */ }
  }

  const art: DebugArtifacts = {
    dir: out, files, url, title,
    consoleErrors: mp.consoleErrors.slice(-20).map(redactText),
    failedRequests: mp.failedRequests.slice(-20).map((r) => ({ url: redactUrl(r.url), failure: r.failure })),
    extra,
  };
  const meta = path.join(out, "meta.json");
  fs.writeFileSync(meta, JSON.stringify({ ...art, crashed: mp.crashed, closed: mp.closed, dialogs: mp.dialogs,
    intendedUrl: redactUrl(mp.intendedUrl), capturedAt: new Date().toISOString() }, null, 2));
  art.files.push(meta);
  return art;
}
