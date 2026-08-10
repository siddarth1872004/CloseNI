/**
 * Provider id to control module. A provider with no module has no controls,
 * which is the honest answer for one whose UI nobody has observed — better
 * than machinery that looks finished and works nowhere.
 */
import { Page } from "playwright";
import { ControlApplier, ControlResult, ControlSelectors, DesiredControls } from "./types.js";
import { applyControls as deepseek } from "./deepseek.js";
import { applyControls as qwenStudio } from "./qwen-studio.js";
import { applyControls as glm } from "./glm.js";

const APPLIERS: Record<string, ControlApplier> = {
  "deepseek": deepseek,
  "qwen-studio": qwenStudio,
  "glm": glm,
};

export function hasControls(providerId: string): boolean {
  return Boolean(APPLIERS[providerId]);
}

/**
 * Apply what the user chose, if this provider knows how. An unknown provider
 * and an empty request both mean no work and no error.
 */
export async function applyProviderControls(
  page: Page,
  providerId: string,
  selectors: ControlSelectors | undefined,
  desired: DesiredControls | undefined,
): Promise<ControlResult[]> {
  const applier = APPLIERS[providerId];
  if (!applier) return [];
  if (!desired || Object.keys(desired).length === 0) return [];
  return applier(page, selectors || {}, desired);
}

export { ControlResult, ControlSelectors, DesiredControls, ControlApplier } from "./types.js";
