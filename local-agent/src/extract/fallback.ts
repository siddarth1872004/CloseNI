/**
 * The two places the agent consults an extractor, and the one rule they share:
 * extraction is a last resort that may never cost a run. Anything that goes
 * wrong in here - no bridge, a timeout, a crash - is logged once, switches
 * extraction off for the rest of the run, and returns the answer the agent
 * would have had without it.
 */
import { getExtractor, markExtractorFailed, readExtractionSettings } from "./extractor.js";
import { rescuePlan, RescueReport } from "./plan-rescue.js";
import { classifyReply, describeReply } from "./reply-kind.js";

function reason(e: any): string {
  return e && e.message ? e.message : String(e);
}

/**
 * Try to read a plan out of replies the parser rejected, newest first: the
 * re-ask's answer is the one the provider meant to be final.
 */
export async function rescueUnparsedPlan(replies: string[]): Promise<{ plan: any; report: RescueReport } | null> {
  const ex = getExtractor();
  if (!ex) return null;
  const { minConfidence } = readExtractionSettings();
  for (const reply of replies) {
    if (!reply || !reply.trim()) continue;
    try {
      const r = await rescuePlan(reply, ex, minConfidence);
      if (r) {
        console.log("Plan read from prose by " + r.report.by + ": " + r.report.steps + " step(s), " +
          r.report.read + " read by the model, run as a chain in order.");
        for (const f of r.report.fallbacks) console.log("  " + f);
        return r;
      }
    } catch (e) {
      markExtractorFailed(reason(e));
      return null;
    }
  }
  console.log("Extraction found no numbered plan in the reply.");
  return null;
}

/** A sentence saying what the reply was instead, or "". */
export async function explainUnparsed(reply: string, expected: "plan" | "code"): Promise<string> {
  const ex = getExtractor();
  if (!ex) return "";
  const { minConfidence } = readExtractionSettings();
  try {
    return describeReply(await classifyReply(reply, ex, minConfidence), expected);
  } catch (e) {
    markExtractorFailed(reason(e));
    return "";
  }
}
