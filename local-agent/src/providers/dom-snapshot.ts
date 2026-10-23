/**
 * A copy of the page for working out why a selector stopped matching.
 *
 * What a selector fix needs is the page's structure - tags, roles, classes,
 * ARIA labels. What it must not carry is anything of the person's: their
 * messages, the model's replies about their code, their email, a session
 * token in a URL. So the snapshot keeps the elements and drops the rest:
 *
 *   - scripts, styles and inline SVG drawing data are removed outright
 *   - text longer than a control's label is masked, its length kept
 *   - form values and URL queries are removed
 *   - emails, phone numbers and token-like strings are masked anywhere left
 *
 * Pure, on the HTML string, so every rule is tested without a browser.
 */
import * as fs from "fs";
import * as path from "path";

/** Longer than this, text is someone's words rather than a control's label. */
const LABEL_MAX = 40;
/** Snapshots kept per provider; older ones are removed. */
const KEEP = 10;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /\+?\d[\d\s().-]{7,}\d/g;
// JWTs, API keys, session ids: long runs of letters and digits with no
// spaces. Both are required, so a long class name of words is left alone.
const TOKEN = /\b(?:eyJ[\w-]+\.[\w-]+\.[\w-]+|(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,})\b/g;

// Phone numbers in text only: in an attribute the same shape is a viewBox.
function maskWords(s: string): string {
  return s.replace(EMAIL, "[email]").replace(TOKEN, "[token]");
}

function maskText(t: string): string {
  const trimmed = t.trim();
  if (!trimmed) return t;
  if (trimmed.length > LABEL_MAX) return " [text: " + trimmed.length + " chars] ";
  return maskWords(t).replace(PHONE, "[number]");
}

export function scrubSnapshot(html: string): string {
  let s = String(html || "");
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "");
  s = s.replace(/\s(?:d|points)="[^"]*"/gi, "");
  s = s.replace(/<textarea\b([^>]*)>[\s\S]*?<\/textarea>/gi, "<textarea$1></textarea>");
  s = s.replace(/\svalue="[^"]*"/gi, "");
  s = s.replace(/\s(href|src|action)="([^"?#]*)[?#][^"]*"/gi, ' $1="$2"');
  // Text between tags, then what is left in attributes (titles, alt text).
  s = s.replace(/>([^<]+)</g, (_m, t: string) => ">" + maskText(t) + "<");
  s = s.replace(/="([^"]*)"/g, (_m, v: string) => '="' + maskWords(v) + '"');
  return s;
}

/**
 * Save a scrubbed snapshot under `<root>/diagnostics/` and return its path, or
 * "" when it could not be written. Keeps the newest KEEP per provider.
 */
export function saveSnapshot(root: string, providerId: string, reason: string, html: string, now: number = Date.now()): string {
  try {
    const dir = path.join(root, "diagnostics");
    fs.mkdirSync(dir, { recursive: true });
    const safe = (x: string) => x.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
    const prefix = safe(providerId) + "-";
    const file = path.join(dir, prefix + new Date(now).toISOString().replace(/[:.]/g, "-") + "-" + safe(reason) + ".html");
    fs.writeFileSync(file, "<!-- CloseNI page snapshot: " + reason + ". Text and personal data removed. -->\n" + scrubSnapshot(html));
    const old = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".html")).sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP))) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* best effort */ }
    }
    return file;
  } catch {
    return "";
  }
}
