import { Page } from "playwright";

/**
 * What happened to one control. Never an exception: a control that will not
 * move is reported and the run continues. A build should not fail because a
 * toggle was stubborn.
 */
export interface ControlResult {
  id: string;
  action: "clicked" | "already-set" | "unavailable";
  detail?: string;
}

/** Selectors come from the provider's JSON, because those rot fastest. */
export type ControlSelectors = Record<string, string>;

/** What the user asked for, keyed by control id. */
export type DesiredControls = Record<string, string | boolean>;

/**
 * One per provider. Behaviour is code because providers differ in kind, not
 * only in selector: DeepSeek's controls are inline and report their own state,
 * Qwen's are Ant Design comboboxes whose state is the trigger's visible text,
 * GLM's are Radix menus whose options carry data-value. No shared schema
 * survives all three.
 */
export type ControlApplier = (
  page: Page,
  selectors: ControlSelectors,
  desired: DesiredControls,
) => Promise<ControlResult[]>;
