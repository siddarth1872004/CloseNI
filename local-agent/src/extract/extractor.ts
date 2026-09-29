/**
 * Structured extraction: an optional second reader for replies the parser
 * could not read.
 *
 * The parser (`parser/json-repair.ts`) is deterministic and stays the first,
 * and usually only, reader. An extractor is consulted only after it has failed
 * and the provider has been re-asked, so turning one on can rescue a reply but
 * cannot change how a reply that parses is read.
 *
 * The one backend is Needle (github.com/cactus-compute/needle), a small local
 * model whose decode grammar guarantees the output matches the schema it is
 * given, and which reports a calibrated confidence and a refusal as an empty
 * answer rather than a guess. Both properties are why it is trusted here at
 * all - and why it is never asked to write code: it fills small typed records
 * from text that is already there.
 *
 * Settings ride on the environment, as provider controls do:
 *   CLOSENI_EXTRACTOR              builtin (default) | needle
 *   CLOSENI_NEEDLE_PYTHON          interpreter with cactus-needle installed
 *   CLOSENI_NEEDLE_WEIGHTS         optional fine-tuned .cact file
 *   CLOSENI_NEEDLE_MIN_CONFIDENCE  0..1, below which an answer is not used
 */
import { NeedleClient } from "./needle-client.js";

export type JsonSchema = Record<string, any>;

export interface ExtractRequest {
  /** The record's name, as the model sees it - a verb-free noun reads best. */
  name: string;
  description: string;
  schema: JsonSchema;
  text: string;
  maxNewTokens?: number;
}

export interface ExtractResult {
  /** The model produced a record at all. False is its refusal. */
  found: boolean;
  value: Record<string, any>;
  /** In [0,1], or null for weights that carry no calibration head. */
  confidence: number | null;
  /** The engine withheld the record as too unsure to act on. */
  withheld: boolean;
  reasoning: string;
  /** Fields the engine itself flagged as not evidenced in the text. */
  ungrounded: string[];
}

export interface StructuredExtractor {
  readonly id: string;
  extract(req: ExtractRequest): Promise<ExtractResult>;
  close(): Promise<void>;
}

export interface ExtractionSettings {
  backend: "builtin" | "needle";
  python: string;
  weights: string;
  minConfidence: number;
}

export const DEFAULT_MIN_CONFIDENCE = 0.5;

export function readExtractionSettings(env: NodeJS.ProcessEnv = process.env): ExtractionSettings {
  const backend = String(env.CLOSENI_EXTRACTOR || "").trim().toLowerCase() === "needle" ? "needle" : "builtin";
  const raw = parseFloat(String(env.CLOSENI_NEEDLE_MIN_CONFIDENCE || ""));
  const minConfidence = isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_MIN_CONFIDENCE;
  const python = String(env.CLOSENI_NEEDLE_PYTHON || "").trim() || (process.platform === "win32" ? "python" : "python3");
  return { backend, python, weights: String(env.CLOSENI_NEEDLE_WEIGHTS || "").trim(), minConfidence };
}

/**
 * Whether an answer is good enough to use.
 *
 * A withheld record is the engine saying "do not act on this", and it is taken
 * at its word. A null confidence means the weights have no calibration head
 * (a local LoRA fine-tune); that is accepted, because refusing every answer
 * from a model the user chose to load would make the setting a no-op, and the
 * callers check grounding themselves.
 */
export function usable(r: ExtractResult | null, minConfidence: number): boolean {
  if (!r || !r.found || r.withheld) return false;
  if (r.confidence === null || r.confidence === undefined) return true;
  return r.confidence >= minConfidence;
}

let active: StructuredExtractor | null = null;
let activeFailed = false;

/**
 * The run's extractor, or null when none is configured or it cannot start.
 *
 * One per process: the bridge holds a loaded model, and starting it per call
 * would cost more than the extraction. A bridge that fails once is not retried
 * in the same run - the caller has a fallback, and a second attempt would only
 * spend the same timeout again.
 */
export function getExtractor(env: NodeJS.ProcessEnv = process.env): StructuredExtractor | null {
  if (active) return active;
  if (activeFailed) return null;
  const settings = readExtractionSettings(env);
  if (settings.backend !== "needle") return null;
  active = new NeedleClient({ python: settings.python, weights: settings.weights });
  return active;
}

export function markExtractorFailed(reason: string): void {
  if (!activeFailed) console.log("Extraction (" + (active ? active.id : "none") + ") unavailable for this run: " + reason);
  activeFailed = true;
  const a = active;
  active = null;
  if (a) a.close().catch(() => {});
}

export async function closeExtractor(): Promise<void> {
  const a = active;
  active = null;
  if (a) await a.close().catch(() => {});
}

/** For tests: forget the cached extractor, or install a fake one. */
export function setExtractorForTest(e: StructuredExtractor | null): void {
  active = e;
  activeFailed = false;
}
