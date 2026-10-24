/**
 * Anti-detection masking for navigator.webdriver and cdc_ traces.
 *
 * Playwright's automation leaves telltale signs:
 * - navigator.webdriver = true
 * - cdc_ prefixed properties on the window object
 * - chrome.runtime message handlers for CDP communication
 *
 * This module patches these to make the browser indistinguishable
 * from a real Chromium instance.
 */

import { PatchwrightConfig } from "./types.js";

/**
 * The JavaScript to patch navigator.webdriver and cdc_ traces.
 *
 * This is injected directly into the page context via addInitScript
 * or evaluate, and runs before any detection scripts can read the values.
 */
export const PATCH_WEBDRIVER_SCRIPT = `
(function() {
  // Patch navigator.webdriver
  Object.defineProperty(navigator, 'webdriver', {
    get: function() {
      return false;
    },
    configurable: true,
  });

  // Remove cdc_ prefixed properties from window
  const cdcKeys = Object.getOwnPropertyNames(window).filter(
    key => key.startsWith('cdc_')
  );
  for (const key of cdcKeys) {
    delete (window as any)[key];
  }

  // Patch the WebDriver detection that checks for cdc_ properties
  // on the window object
  if (window.navigator.webdriver === true) {
    (window.navigator as any).__proto__ = Object.getPrototypeOf(window.navigator);
  }

  // Remove the CDP runtime message handler
  // (Playwright injects a chrome.runtime listener)
  if (window.chrome) {
    const originalSendMessage = (window as any).chrome?.runtime?.sendMessage;
    if (originalSendMessage) {
      // Keep it but neutralize the CDP-specific behavior
      (window as any).chrome.runtime.sendMessage = function(...args: any[]) {
        if (args[0] && typeof args[0] === 'object' && args[0].method) {
          // CDP protocol message - pass through without detection
          return originalSendMessage.apply(window.chrome.runtime, args);
        }
        return originalSendMessage.apply(window.chrome.runtime, args);
      };
    }
  }

  // Patch the Plugin array to avoid detection
  // (Playwright sometimes shows extra plugins)
  const originalPlugins = navigator.plugins;
  if (originalPlugins && originalPlugins.length > 0) {
    // Remove any cdc_ related plugins
    const filtered = Array.from(originalPlugins).filter((plugin: any) => {
      return !plugin.name?.includes('cdc_');
    });
    if (filtered.length > 0) {
      Object.defineProperty(navigator, 'plugins', {
        get: function() {
          return new PluginArray(filtered);
        },
        configurable: true,
      });
    }
  }

  // Patch window.chrome.app for sites that check it
  if (!window.chrome?.app) {
    Object.defineProperty(window, 'chrome', {
      get: function() {
        const chromeObj = {
          runtime: (window as any).chrome?.runtime || {},
          app: {},
        };
        return chromeObj;
      },
      configurable: true,
    });
  }

  return true;
})();
`;

/**
 * A lightweight PluginArray for patching navigator.plugins.
 */
class PluginArray {
  private plugins: Array<{ name: string; description?: string }>;

  constructor(plugins: Array<{ name: string; description?: string }> = []) {
    this.plugins = plugins.length > 0 ? plugins : [
      { name: "Chrome PDF Plugin", description: "Portable Document Format" },
      { name: "Chrome PDF Browser Plugin", description: "" },
    ];
  }

  get length(): number {
    return this.plugins.length;
  }

  item(index: number): { name: string; description?: string } | null {
    return this.plugins[index] || null;
  }

  [Symbol.iterator]() {
    return this.plugins[Symbol.iterator]();
  }
}

/**
 * Patch the page to hide automation traces.
 *
 * This runs in the page context and modifies the DOM and window
 * properties that automated tools check to detect browser automation.
 *
 * @param page - The Playwright page to patch.
 * @returns true if the patch was applied successfully.
 */
export async function patchWebDriver(page: any): Promise<boolean> {
  try {
    await page.addInitScript(PATCH_WEBDRIVER_SCRIPT);
    return true;
  } catch (err) {
    console.log("Patchwright: Failed to patch navigator.webdriver:", err);
    return false;
  }
}

/**
 * Generate the initial script for browser launch.
 *
 * This script should be added as an init script when the browser
 * context is created, so it runs before any page navigation.
 */
export function getInitScript(): string {
  return `
    // Set before page load
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
      configurable: true,
    });

    // Remove any cdc_ properties that Playwright sets
    (function removeCdc() {
      const props = Object.getOwnPropertyNames(window);
      for (const prop of props) {
        if (prop.startsWith('cdc_')) {
          delete (window as any)[prop];
        }
      }
    })();

    // Ensure chrome.runtime exists but is not CDP-tracked
    if (window.chrome && window.chrome.runtime) {
      // Keep it but clear CDP markers
      const runtime = window.chrome.runtime;
      if (runtime.connect) {
        // Wrap connect to avoid detection
        const originalConnect = runtime.connect;
        runtime.connect = function(...args: any[]) {
          return originalConnect.apply(runtime, args);
        };
      }
    }
  `;
}

/**
 * Full automation detection bypass.
 *
 * Applies all patches to the page and the browser context.
 * This is the most comprehensive approach, patching:
 * 1. navigator.webdriver
 * 2. cdc_ properties
 * 3. chrome.runtime CDP handlers
 * 4. navigator.plugins
 * 5. chrome.app
 *
 * @param page - The Playwright page.
 * @param context - The browser context (for context-level patches).
 * @returns A promise that resolves when all patches are applied.
 */
export async function fullAutomationBypass(
  page: any,
  context?: any
): Promise<void> {
  // Patch the page
  await patchWebDriver(page);

  // Patch the context if provided
  if (context) {
    // Add the init script to all future pages in this context
    await context.addInitScript(getInitScript());
  }
}

/**
 * Verify that the patch was applied correctly.
 *
 * Checks the page to ensure navigator.webdriver is false and
 * cdc_ properties are removed.
 *
 * @param page - The Playwright page to check.
 * @returns Object with the patch verification results.
 */
export async function verifyPatch(page: any): Promise<{
  webdriverPatched: boolean;
  cdcRemoved: boolean;
  chromeRuntimeIntact: boolean;
}> {
  const results = await page.evaluate(() => {
    const webdriverPatched = (globalThis as any).navigator.webdriver === false;
    const cdcRemoved = !Object.getOwnPropertyNames(globalThis).some((k) =>
      k.startsWith("cdc_")
    );
    const chromeRuntimeIntact = typeof (globalThis as any).chrome?.runtime !== "undefined";

    return {
      webdriverPatched,
      cdcRemoved,
      chromeRuntimeIntact,
    };
  });

  return results;
}

/**
 * Apply the patch to a Playwright page.
 *
 * This is a convenience function that patches the page in place.
 * Use fullAutomationBypass for context-level patching.
 *
 * @param page - The Playwright page to patch.
 * @returns The verification results.
 */
export async function applyPatch(page: any): Promise<{
  webdriverPatched: boolean;
  cdcRemoved: boolean;
  chromeRuntimeIntact: boolean;
}> {
  await patchWebDriver(page);
  return verifyPatch(page);
}
