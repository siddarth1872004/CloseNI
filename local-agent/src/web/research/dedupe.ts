/**
 * The same content, arriving more than once.
 *
 *   same URL / canonical URL / tracking variants  →  url.ts canonicalisation
 *   mirrors, syndicated copies, near-duplicates    →  shingle Jaccard + simhash
 *   duplicate paragraphs across sources            →  exact hash of normalised text
 *   duplicate search results                       →  canonical URL, then title
 *
 * A syndicated article counts once toward "how many independent sources say
 * this": two copies of one press release are one source, however many domains
 * carry it.
 */
import { hashText } from "../util.js";

function norm(t: string): string {
  return String(t || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/** Word 4-shingles. */
export function shingles(text: string, k: number = 4): Set<string> {
  const w = norm(text).split(" ").filter(Boolean);
  const out = new Set<string>();
  if (w.length < k) { if (w.length) out.add(w.join(" ")); return out; }
  for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(" "));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 64-bit simhash as a hex string (two 32-bit halves). Robust to small edits. */
export function simhash(text: string): string {
  const v = new Array(64).fill(0);
  for (const sh of shingles(text, 3)) {
    const h = hashText(sh); // 16 hex chars = 64 bits
    for (let i = 0; i < 64; i++) {
      const nibble = parseInt(h[Math.floor(i / 4)], 16);
      v[i] += (nibble >> (3 - (i % 4))) & 1 ? 1 : -1;
    }
  }
  let out = "";
  for (let i = 0; i < 64; i += 4) {
    let nib = 0;
    for (let j = 0; j < 4; j++) nib = (nib << 1) | (v[i + j] > 0 ? 1 : 0);
    out += nib.toString(16);
  }
  return out;
}

export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

export interface NearDupVerdict { duplicate: boolean; jaccard: number; hamming: number }

/** Two texts are the same content when their shingles mostly agree. */
export function nearDuplicate(a: string, b: string, threshold: number = 0.8): NearDupVerdict {
  const j = jaccard(shingles(a), shingles(b));
  const h = hamming(simhash(a), simhash(b));
  return { duplicate: j >= threshold || (h <= 3 && j >= 0.5), jaccard: j, hamming: h };
}

/**
 * Group items by near-duplicate content. Returns a group id per item; the first
 * item of a group is its representative.
 */
export function groupDuplicates<T>(items: T[], textOf: (t: T) => string, threshold: number = 0.8): string[] {
  const reps: Array<{ id: string; sh: Set<string>; sim: string }> = [];
  const out: string[] = [];
  items.forEach((it, i) => {
    const text = textOf(it);
    const sh = shingles(text);
    const sim = simhash(text);
    let found: string | null = null;
    for (const r of reps) {
      if (hamming(sim, r.sim) > 12) continue; // cheap pre-filter
      if (jaccard(sh, r.sh) >= threshold) { found = r.id; break; }
    }
    if (!found) { found = "g" + i; reps.push({ id: found, sh, sim }); }
    out.push(found);
  });
  return out;
}

/** Paragraphs already seen elsewhere, by normalised hash. */
export class ParagraphLedger {
  private seen = new Map<string, string>(); // hash → first url

  /** Returns the URL that first carried this paragraph, or null if it is new. */
  check(url: string, paragraph: string): string | null {
    const t = norm(paragraph);
    if (t.length < 40) return null;
    const h = hashText(t);
    const first = this.seen.get(h);
    if (first && first !== url) return first;
    if (!first) this.seen.set(h, url);
    return null;
  }
}
