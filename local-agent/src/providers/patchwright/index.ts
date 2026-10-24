/**
 * Patchwright - Human-like browser automation layer for Playwright.
 *
 * Re-exports all modules for easy consumption:
 * - Types and configuration
 * - Human-like delays (Gaussian distribution)
 * - Curved mouse paths (Bezier interpolation)
 * - Typing rhythm (varied keystroke timing)
 * - Screen coordinate clicks
 * - Automation masking (navigator.webdriver + cdc_)
 * - Browser fingerprinting (UA, WebGL, screen)
 * - Network routing (residential IP + JA3)
 */

export * from "./types.js";
export * from "./human-delays.js";
export * from "./mouse-paths.js";
export * from "./typing-rhythm.js";
export * from "./screen-clicks.js";
export * from "./automation-mask.js";
export * from "./browser-fingerprint.js";
export * from "./network-routing.js";

// Default configuration combining all modules
import { PatchwrightConfig } from "./types.js";
import { DEFAULT_DELAY_CONFIG } from "./human-delays.js";
import { DEFAULT_MOUSE_PATH_CONFIG } from "./mouse-paths.js";
import { DEFAULT_TYPING_CONFIG } from "./typing-rhythm.js";
import { DEFAULT_SCREEN_CLICK_CONFIG } from "./screen-clicks.js";
import { DEFAULT_FINGERPRINT } from "./browser-fingerprint.js";
import { DEFAULT_NETWORK_CONFIG } from "./network-routing.js";

export const DEFAULT_PATCHWRIGHT_CONFIG: PatchwrightConfig = {
  enabled: true,
  delays: DEFAULT_DELAY_CONFIG,
  mousePaths: DEFAULT_MOUSE_PATH_CONFIG,
  typingRhythm: DEFAULT_TYPING_CONFIG,
  screenClicks: DEFAULT_SCREEN_CLICK_CONFIG,
  fingerprint: DEFAULT_FINGERPRINT,
  network: DEFAULT_NETWORK_CONFIG,
  antiDetection: true,
};
