/**
 * Small helpers shared by the browser-native layer.
 *
 * Kept apart from the rest of the agent on purpose: everything under web/ can be
 * required on its own by the test harness without pulling in index.ts, whose
 * import runs main().
 */
import * as crypto from "crypto";

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A short, stable content hash. Used for dedupe keys and cache keys, never for security. */
export function hashText(text: string): string {
  return crypto.createHash("sha1").update(String(text)).digest("hex").slice(0, 16);
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Collapse runs of whitespace and trim. */
export function squash(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

/** Monotonic milliseconds, for durations. Date.now() can jump. */
export function nowMs(): number {
  return Number(process.hrtime.bigint() / BigInt(1000000));
}

/**
 * Words for matching, lower-cased, without the words that match everything.
 *
 * Deliberately small: a stop list that removes "not" or "no" would erase the
 * difference between two sources that disagree.
 */
const STOP = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "by", "at", "from",
  "is", "are", "was", "were", "be", "been", "it", "its", "this", "that", "these", "those",
  "as", "into", "than", "then", "so", "such", "can", "will", "would", "should", "could",
  "what", "which", "who", "how", "why", "when", "where", "do", "does", "did", "about",
  "vs", "versus", "i", "you", "we", "they", "he", "she", "my", "your", "our", "their",
]);

export function tokens(text: string): string[] {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s._+#-]/gu, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[._-]+|[._-]+$/g, ""))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Split prose into sentences without breaking on "e.g." or version numbers. */
export function sentences(text: string): string[] {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    const next = t[i + 1];
    if (next !== undefined && next !== " ") continue; // 3.5, e.g.x, URLs
    const prevWord = t.slice(start, i).split(" ").pop() || "";
    if (/^(e\.g|i\.e|etc|vs|mr|mrs|dr|no|fig|approx|inc|ltd)$/i.test(prevWord)) continue;
    if (/^[A-Z]$/.test(prevWord)) continue; // initials
    out.push(t.slice(start, i + 1).trim());
    start = i + 1;
  }
  const rest = t.slice(start).trim();
  if (rest) out.push(rest);
  return out.filter((s) => s.length > 0);
}

/**
 * A very light stem, for matching only: "limits" and "limit", "handles" and
 * "handle", "supported" and "support" meet. Never shown to anyone.
 */
export function stem(w: string): string {
  if (w.length <= 4 || /\d/.test(w)) return w;
  return w.replace(/(ies)$/, "y").replace(/(sses)$/, "ss").replace(/([^s])s$/, "$1").replace(/(ing|ed)$/, "").replace(/e$/, "");
}

export function stems(text: string): string[] {
  return tokens(text).map(stem);
}
