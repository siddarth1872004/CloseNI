/**
 * The decisions behind control-setting, with no browser in sight.
 *
 * Reading state before clicking is the whole point: blind toggling turns a
 * wanted setting off. These functions decide whether a click is needed, so
 * that logic can be tested without driving a page.
 */
import { DesiredControls } from "./types.js";

export function normalizeLabel(s: string | null | undefined): string {
  return (s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * A control whose state is an attribute flag: aria-pressed (DeepSeek toggles),
 * aria-checked (DeepSeek modes), data-selected (GLM menu options).
 *
 * "unreadable" is a real answer, not a failure to handle. A provider that
 * stopped emitting the attribute must not be clicked on a guess.
 */
export function flagAction(current: string | null | undefined, want: boolean): "click" | "already-set" | "unreadable" {
  if (current !== "true" && current !== "false") return "unreadable";
  return (current === "true") === want ? "already-set" : "click";
}

/**
 * A control whose state is its trigger's visible text (Qwen). The trigger may
 * carry icon text or a second line, so each line is compared whole: matching a
 * substring would let "Qwen3.7" satisfy a request for "Qwen3.7-Max".
 */
export function labelAction(currentText: string | null | undefined, wantLabel: string): "open" | "already-set" | "unreadable" {
  const want = normalizeLabel(wantLabel);
  if (!want) return "unreadable";
  const lines = String(currentText || "").split("\n").map(normalizeLabel).filter(Boolean);
  if (!lines.length) return "unreadable";
  return lines.includes(want) ? "already-set" : "open";
}

/**
 * Is this option in an open menu the one asked for? Same whole-line rule,
 * for the same reason: Qwen renders each model as a card with a description
 * underneath, and Qwen3.7-Max's description mentions Qwen3.7.
 */
export function optionMatches(optionText: string | null | undefined, wantLabel: string): boolean {
  return labelAction(optionText, wantLabel) === "already-set";
}

/** Substitute a value into a selector template such as `[data-model-type="{value}"]`. */
export function fillSelector(template: string, value: string): string {
  return template.split("{value}").join(value);
}

/**
 * Desired settings arrive as JSON on an environment variable. Malformed input
 * means no controls, never a crash: a bad setting must not stop a build.
 */
export function parseDesiredControls(raw: string | undefined | null): DesiredControls {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: DesiredControls = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string" || typeof v === "boolean") out[k] = v;
  }
  return out;
}
