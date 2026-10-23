/**
 * How often prompts go to a provider.
 *
 * One prompt is in flight at a time already: the controller waits for the
 * composer to go idle before it types. This adds the two limits a person sets
 * on top of that - a fixed gap between prompts, and a daily budget - and keeps
 * them in one file per provider in the storage directory, because every
 * one-shot run is its own process and a gap or a count held in memory would
 * start from nothing each time.
 *
 * The decisions are pure (paceDecision) so they are tested without a clock or
 * a disk; Pacer is the thin part that reads the file, sleeps and writes.
 */
import * as fs from "fs";
import * as path from "path";

export interface PacingRules {
  /** The least time between one prompt going out and the next. */
  minGapMs?: number;
}

export interface PacingRecord {
  /** The local day the count is for, as YYYY-MM-DD. */
  day: string;
  /** Prompts sent that day. */
  count: number;
  /** When the last prompt went out, in ms since the epoch. */
  lastSentAt: number;
}

export type PaceDecision =
  | { action: "send"; waitMs: number }
  | { action: "stop"; reason: string };

/** The local calendar day: a budget resets at the person's midnight, not UTC's. */
export function dayOf(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => (n < 10 ? "0" : "") + n;
  return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate());
}

/** A budget of 0 or less, or one that is not a number, means no budget. */
export function parseBudget(raw: string | undefined): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function paceDecision(rec: PacingRecord | null, now: number, minGapMs: number, budget: number): PaceDecision {
  const today = dayOf(now);
  const count = rec && rec.day === today ? rec.count : 0;
  if (budget > 0 && count >= budget) {
    return { action: "stop", reason: "The daily budget of " + budget + " prompts is used up. It resets at midnight; raise it in Settings > Permissions to keep going today." };
  }
  const since = rec ? now - rec.lastSentAt : Infinity;
  // A clock that went backwards owes no wait.
  const waitMs = minGapMs > 0 && since >= 0 && since < minGapMs ? minGapMs - since : 0;
  return { action: "send", waitMs: waitMs };
}

export function recordSend(rec: PacingRecord | null, now: number): PacingRecord {
  const today = dayOf(now);
  const count = rec && rec.day === today ? rec.count : 0;
  return { day: today, count: count + 1, lastSentAt: now };
}

/** Thrown when the daily budget is used up. */
export class BudgetSpent extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetSpent";
  }
}

export class Pacer {
  constructor(
    private file: string,
    private rules: PacingRules,
    private budget: number,
    private sleep: (ms: number) => Promise<void>,
    private now: () => number = Date.now,
  ) {}

  /** The storage directory's pacing file for this provider. */
  static fileFor(storageRoot: string, providerId: string): string {
    return path.join(storageRoot, "pacing-" + providerId.replace(/[^A-Za-z0-9_-]/g, "_") + ".json");
  }

  private read(): PacingRecord | null {
    try {
      const r = JSON.parse(fs.readFileSync(this.file, "utf-8"));
      if (r && typeof r.day === "string" && Number.isFinite(r.count) && Number.isFinite(r.lastSentAt)) return r;
    } catch { /* missing or unreadable: nothing sent yet */ }
    return null;
  }

  /** Wait out the gap, or throw BudgetSpent; then count this prompt. */
  async beforeSend(onWait?: (ms: number) => void): Promise<void> {
    const d = paceDecision(this.read(), this.now(), Math.max(0, this.rules.minGapMs || 0), this.budget);
    if (d.action === "stop") throw new BudgetSpent(d.reason);
    if (d.waitMs > 0) {
      if (onWait) onWait(d.waitMs);
      await this.sleep(d.waitMs);
    }
    try {
      fs.writeFileSync(this.file, JSON.stringify(recordSend(this.read(), this.now())));
    } catch { /* a count that cannot be saved must not stop the prompt */ }
  }
}
