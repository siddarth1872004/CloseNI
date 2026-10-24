/**
 * Integration layer for patchwright with PlaywrightController.
 *
 * This module provides the glue between patchwright's enhancement
 * modules and the existing Playwright launch flow. It applies all
 * patches during browser launch and provides configuration options.
 */

import { BrowserContext, Page } from "playwright";
import { PatchwrightConfig, DEFAULT_PATCHWRIGHT_CONFIG } from "./types.js";
import { patchWebDriver, getInitScript, fullAutomationBypass, applyPatch } from "./automation-mask.js";
import { injectFingerprint, createContextOptions } from "./browser-fingerprint.js";
import { applyNetworkRouting, buildTlsConfig } from "./network-routing.js";
import { generateDelay, sleepWithDelay, readingPause, thinkingPause } from "./human-delays.js";
import { generateCurvedPath, simulateClick } from "./mouse-paths.js";
import { generateTypingSequence, typeWithRhythm } from "./typing-rhythm.js";
import { screenClick, boundingBoxClick, naturalClickPattern } from "./screen-clicks.js";

/**
 * Extended context metadata for patchwright.
 */
export interface PatchwrightContextMeta {
  /** Patchwright configuration in use. */
  config: PatchwrightConfig;
  /** Current residential IP. */
  ip?: string;
  /** TLS fingerprint in use. */
  tls?: ReturnType<typeof buildTlsConfig>;
  /** Whether patches have been applied. */
  patched: boolean;
  /** Browser fingerprint data. */
  fingerprint: ReturnType<typeof createContextOptions>;
}

/**
 * Apply all patchwright enhancements to a browser context.
 *
 * This is the main integration function. It applies all patches
 * in the correct order:
 * 1. Init scripts (added before any page loads)
 * 2. Fingerprint injection
 * 3. Network routing
 * 4. Page-level patches
 *
 * @param context - The Playwright browser context.
 * @param config - Patchwright configuration.
 * @returns Context metadata for reference.
 */
export async function applyPatchwrightToContext(
  context: BrowserContext,
  config: Partial<PatchwrightConfig> = {}
): Promise<PatchwrightContextMeta> {
  const cfg = { ...DEFAULT_PATCHWRIGHT_CONFIG, ...config };

  // 1. Add init script (runs before page load)
  await context.addInitScript(getInitScript());

  // 2. Inject browser fingerprint
  await injectFingerprint(
    await context.pages()[0] || (await context.newPage()),
    cfg.fingerprint
  );

  // 3. Apply network routing
  await applyNetworkRouting(context, cfg.network);

  // 4. Apply page-level patches
  const page = context.pages()[0] || (await context.newPage());
  await fullAutomationBypass(page, context);

  return {
    config: cfg,
    ip: cfg.network?.currentIp,
    tls: cfg.network ? buildTlsConfig(cfg.network) : undefined,
    patched: true,
    fingerprint: createContextOptions(cfg.fingerprint),
  };
}

/**
 * Patch the Playwright launch options to include patchwright settings.
 *
 * Extends the launch options from PlaywrightController with patchwright
 * configuration, ensuring all patches are applied at context creation time.
 *
 * @param baseOptions - The base Playwright launch options.
 * @param config - Patchwright configuration.
 * @returns Extended launch options.
 */
export function extendLaunchOptions(
  baseOptions: Record<string, unknown>,
  config: Partial<PatchwrightConfig> = {}
): Record<string, unknown> {
  const cfg = { ...DEFAULT_PATCHWRIGHT_CONFIG, ...config };
  const fpOptions = createContextOptions(cfg.fingerprint);

  return {
    ...baseOptions,
    ...fpOptions,
    args: [
      ...((baseOptions.args as string[]) || []),
      "--disable-blink-features=AutomationControlled",
      "--disable-features=OptimizationGuideModelFetching,OptimizationGuideFeatureFetching,OptimizationTargetPrediction,OptimizationHelpfulness",
    ],
    _patchwright: cfg,
  };
}

/**
 * Create a human-like click using patchwright.
 *
 * Generates a curved mouse path and clicks at the calculated
 * screen coordinates.
 *
 * @param page - The Playwright page.
 * @param targetX - Target X coordinate (screen or viewport).
 * @param targetY - Target Y coordinate.
 * @param config - Patchwright configuration.
 * @returns The click events generated.
 */
export async function humanClickOnPage(
  page: Page,
  targetX: number,
  targetY: number,
  config: Partial<PatchwrightConfig> = {}
): Promise<void> {
  const cfg = { ...DEFAULT_PATCHWRIGHT_CONFIG, ...config };

  // Generate curved path
  const path = generateCurvedPath(
    { x: targetX + (Math.random() * 2 - 1) * 100, y: targetY + (Math.random() * 2 - 1) * 100 },
    { x: targetX, y: targetY },
    cfg.mousePaths
  );

  // Move mouse along path
  for (const point of path.slice(0, -1)) {
    await page.mouse.move(point.x, point.y, {
      delay: cfg.mousePaths?.durationMs ? cfg.mousePaths.durationMs / path.length : 30,
    } as { steps?: number });
  }

  // Brief pause (human "aiming")
  await sleepWithDelay({
    meanMs: 100,
    stdDevFactor: 0.2,
    minMs: 50,
    maxMs: 200,
    jitter: true,
    jitterFactor: 0.1,
  });

  // Click
  await page.mouse.click(targetX, targetY, {
    delay: cfg.screenClicks?.holdTimeMs || 100,
  });
}

/**
 * Type with human-like rhythm on the active page.
 *
 * Moves to the input element, types the text with realistic timing,
 * and applies corrections.
 *
 * @param page - The Playwright page.
 * @param text - The text to type.
 * @param config - Patchwright configuration.
 * @returns The total typing duration.
 */
export async function typeWithHumanRhythm(
  page: Page,
  text: string,
  config: Partial<PatchwrightConfig> = {}
): Promise<number> {
  const cfg = { ...DEFAULT_PATCHWRIGHT_CONFIG, ...config };

  // Generate typing sequence
  const sequence = generateTypingSequence(text, cfg.typingRhythm);

  // Calculate total duration
  let totalDuration = 0;
  for (const event of sequence) {
    totalDuration += event.delay;
  }

  // Type each character
  for (const event of sequence) {
    if (event.type === "keystroke") {
      // Find the input element
      const input = page.locator("textarea, [contenteditable='true'], [role='textbox']");
      await input.first().click({ timeout: 5000 });
      await input.first().pressSequentially(event.char, {
        delay: event.delay,
      });
    } else if (event.type === "backspace") {
      await page.keyboard.press("Backspace", { delay: 50 });
    } else if (event.type === "pause") {
      await sleepWithDelay({
        meanMs: cfg.typingRhythm?.pauseCharDelayMs || 240,
        stdDevFactor: 0.2,
        minMs: 100,
        maxMs: 400,
        jitter: true,
      });
    }
  }

  return totalDuration;
}

/**
 * Navigate with human-like delays.
 *
 * Combines delay generation with navigation for a more natural feel.
 *
 * @param page - The Playwright page.
 * @param url - The URL to navigate to.
 * @param config - Patchwright configuration.
 * @returns The navigation result.
 */
export async function navigateWithDelay(
  page: Page,
  url: string,
  config: Partial<PatchwrightConfig> = {}
): Promise<{ duration: number; url: string }> {
  const cfg = { ...DEFAULT_PATCHWRIGHT_CONFIG, ...config };

  const start = Date.now();

  // Pre-navigation delay (human "thinking" before clicking)
  await readingPause(cfg.delays);

  // Navigate
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Post-navigation delay
  await sleepWithDelay(cfg.delays);

  return {
    duration: Date.now() - start,
    url: page.url(),
  };
}

/**
 * Full patchwright setup for PlaywrightController.
 *
 * This is the entry point for integrating patchwright into the
 * existing Playwright controller launch flow. It applies all
 * patches and returns the context metadata.
 *
 * @param context - The browser context from PlaywrightController.
 * @param page - The active page.
 * @param config - Patchwright configuration.
 * @returns Context metadata.
 */
export async function setupPatchwright(
  context: BrowserContext,
  page: Page,
  config: Partial<PatchwrightConfig> = {}
): Promise<PatchwrightContextMeta> {
  // Apply patches in order
  const meta = await applyPatchwrightToContext(context, config);

  // Apply page-level patches
  await applyPatch(page);

  return meta;
}
