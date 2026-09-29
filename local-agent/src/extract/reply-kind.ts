/**
 * Say what a reply was, when it was not what was asked for.
 *
 * "Could not parse plan" and "No file changes found" are true and useless: the
 * person reading them cannot tell a provider that declined from one that asked
 * a question back, or from one that answered in prose. Those need different
 * next moves - rephrase, answer the question, or retry.
 *
 * This is the content-refusal detection docs/NEXT.md left open: a refusal is an
 * ordinary successful reply whose prose declines, so nothing structural gives
 * it away, and reading prose was exactly what that note declined to do with
 * pattern matching. A schema-constrained classifier with a confidence is a
 * different tool for it. It only ever changes a message, never what runs.
 */
import { StructuredExtractor, usable } from "./extractor.js";
import { grounded } from "./plan-rescue.js";

export type ReplyKind = "plan" | "code" | "refusal" | "question" | "other";

export const REPLY_SCHEMA = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["plan", "code", "refusal", "question", "other"],
      description: "plan: a list of steps for building software. code: source files or code. refusal: the assistant declines or says it cannot help. question: the assistant asks the user something before it will continue. other: anything else.",
    },
    quote: {
      type: "string",
      description: "For a refusal, the sentence that declines. For a question, the question asked. Copied exactly.",
    },
  },
  required: ["kind"],
};

export interface ReplyReading {
  kind: ReplyKind;
  quote?: string;
  confidence: number | null;
}

/** The start and end of a reply: where a refusal or a question sits. */
export function sampleReply(text: string, head: number = 1800, tail: number = 600): string {
  if (text.length <= head + tail + 20) return text;
  return text.substring(0, head) + "\n...\n" + text.substring(text.length - tail);
}

export async function classifyReply(
  reply: string,
  extractor: StructuredExtractor,
  minConfidence: number,
): Promise<ReplyReading | null> {
  const text = typeof reply === "string" ? reply.trim() : "";
  if (!text) return null;
  const r = await extractor.extract({
    name: "reply_kind",
    description: "What kind of reply an AI assistant gave.",
    schema: REPLY_SCHEMA,
    text: sampleReply(text),
    maxNewTokens: 160,
  });
  if (!usable(r, minConfidence)) return null;
  const kind = r.value.kind as ReplyKind;
  if (["plan", "code", "refusal", "question", "other"].indexOf(kind) === -1) return null;
  const out: ReplyReading = { kind: kind, confidence: r.confidence };
  // Shown to the person as the provider's words, so it has to be them.
  if (typeof r.value.quote === "string" && grounded(r.value.quote, text)) out.quote = r.value.quote.trim().slice(0, 300);
  return out;
}

/**
 * One sentence to append to a failure, or "" when the reading adds nothing -
 * a reply that looks like the thing asked for failed for a reason this cannot
 * see, and saying "it looks like a plan" beside "could not parse plan" helps
 * nobody.
 */
export function describeReply(reading: ReplyReading | null, expected: "plan" | "code"): string {
  if (!reading) return "";
  const q = reading.quote ? ": “" + reading.quote + "”" : ".";
  if (reading.kind === "refusal") return "The provider appears to have declined the request" + q + " Rephrasing the request is more likely to help than retrying.";
  if (reading.kind === "question") return "The provider asked a question instead of answering" + q + " Answer it in chat, then try again.";
  if (reading.kind === "other") return "The reply was prose rather than " + (expected === "plan" ? "a plan" : "code") + ".";
  if (reading.kind !== expected && reading.kind === "code") return "The reply contained code rather than a plan.";
  if (reading.kind !== expected && reading.kind === "plan") return "The reply described a plan rather than writing the code.";
  return "";
}
