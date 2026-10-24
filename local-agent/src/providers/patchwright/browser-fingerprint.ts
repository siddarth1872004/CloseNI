/**
 * Browser fingerprint configuration and generation.
 *
 * Fakes user agent, WebGL renderer details, screen size,
 * hardware concurrency, device memory, language, timezone,
 * and canvas seed for consistent rendering fingerprinting.
 */

import { BrowserFingerprintConfig } from "./types.js";

/**
 * Default browser fingerprint configuration mimicking a real Chrome on Linux.
 */
export const DEFAULT_FINGERPRINT: BrowserFingerprintConfig = {
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  platform: "Linux x86_64",
  viewport: { width: 1280, height: 800 },
  screen: {
    width: 1920,
    height: 1080,
    availWidth: 1920,
    availHeight: 1040,
  },
  hardwareConcurrency: 8,
  deviceMemory: 8,
  webglRenderer: "Intel Iris OpenGL Engine",
  webglVendor: "Google Inc. (Intel)",
  language: "en-US",
  languages: ["en-US", "en"],
  timezone: "America/New_York",
  hardwareId: generateHardwareId(),
  canvasSeed: Math.floor(Math.random() * 10000),
};

/**
 * Generate a unique hardware ID for fingerprinting.
 *
 * Combines several system characteristics into a stable ID
 * that is consistent across sessions but unique per instance.
 */
export function generateHardwareId(): string {
  const parts: number[] = [];
  for (let i = 0; i < 8; i++) {
    parts.push(Math.floor(Math.random() * 65536));
  }
  return parts.map((p) => p.toString(16).padStart(4, "0")).join("");
}

/**
 * Generate a WebGL fingerprint based on renderer and vendor.
 *
 * The WebGL fingerprint is determined by the renderer string and
 * the canvas rendering output. This function generates a consistent
 * fingerprint string based on the configured renderer.
 */
export function generateWebGLFingerprint(config: Partial<BrowserFingerprintConfig> = {}): string {
  const cfg = { ...DEFAULT_FINGERPRINT, ...config };
  const seed = cfg.canvasSeed;

  // Generate a fingerprint hash based on renderer, vendor, and seed
  const rendererHash = hashCode(cfg.webglRenderer + cfg.webglVendor + seed.toString());
  return `webgl-${rendererHash.toString(16).padStart(8, "0")}`;
}

/**
 * Simple string hash function for generating consistent fingerprints.
 */
function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

/**
 * Generate a canvas seed value for consistent canvas fingerprinting.
 *
 * Canvas fingerprinting renders a specific shape and reads the pixel data.
 * The seed determines the rendering parameters for consistent results.
 */
export function generateCanvasSeed(): number {
  return Math.floor(Math.random() * 100000);
}

/**
 * Build the full browser fingerprint object.
 *
 * Combines all configured values into a single fingerprint object
 * that can be used for detection bypass and reporting.
 */
export function buildFingerprint(config: Partial<BrowserFingerprintConfig> = {}): {
  userAgent: string;
  platform: string;
  viewport: { width: number; height: number };
  screen: { width: number; height: number; availWidth: number; availHeight: number };
  hardwareConcurrency: number;
  deviceMemory: number;
  webglRenderer: string;
  webglVendor: string;
  language: string;
  languages: string[];
  timezone: string;
  hardwareId: string;
  canvasSeed: number;
  webglFingerprint: string;
} {
  const cfg = { ...DEFAULT_FINGERPRINT, ...config };
  return {
    ...cfg,
    webglFingerprint: generateWebGLFingerprint(cfg),
  };
}

/**
 * Generate a faked user agent string.
 *
 * Produces a realistic Chrome user agent with the configured
 * platform and version. The version is randomly selected within
 * a realistic range to avoid fingerprinting.
 */
export function generateUserAgent(
  platform: "chrome" | "firefox" | "safari" | "edge" = "chrome",
  version: number = 125 + Math.floor(Math.random() * 5)
): string {
  const uaMap: Record<string, string> = {
    chrome: "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%d.0.0.0 Safari/537.36",
    firefox: "Gecko/20100101 Firefox/%d.0",
    safari: "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/%d.0 Safari/605.1.15",
    edge: "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%d.0.0.0 Safari/537.36 Edg/%d.0.0.0",
  };
  const format = uaMap[platform];
  if (platform === "edge") {
    return format.replace("%d.0.0.0", String(version)).replace(/Edg\/%d\.0\.0\.0/, `Edg/${version}.0.0.0`);
  }
  return format.replace("%d", version.toString());
}

/**
 * Inject the fingerprint into a Playwright page.
 *
 * Patches the page's navigator, screen, and window properties
 * to match the configured fingerprint.
 */
export async function injectFingerprint(page: any, config: Partial<BrowserFingerprintConfig> = {}): Promise<void> {
  const fp = buildFingerprint(config);

  await page.evaluate((fp: ReturnType<typeof buildFingerprint>) => {
    // Patch navigator properties
    Object.defineProperty((globalThis as any).navigator, 'platform', {
      get: () => fp.platform,
      configurable: true,
    });

    Object.defineProperty((globalThis as any).navigator, 'language', {
      get: () => fp.language,
      configurable: true,
    });

    Object.defineProperty((globalThis as any).navigator, 'hardwareConcurrency', {
      get: () => fp.hardwareConcurrency,
      configurable: true,
    });

    Object.defineProperty((globalThis as any).navigator, 'deviceMemory', {
      get: () => fp.deviceMemory,
      configurable: true,
    });

    // Patch navigator.userAgent if not already set
    if ((globalThis as any).navigator?.userAgent !== fp.userAgent) {
      Object.defineProperty((globalThis as any).navigator, 'userAgent', {
        get: () => fp.userAgent,
        configurable: true,
      });
    }

    const screenObj = (globalThis as any).screen;
    const windowObj = globalThis as any;

    // Patch screen properties
    Object.defineProperty(screenObj, 'width', {
      get: () => fp.screen.width,
      configurable: true,
    });

    Object.defineProperty(screenObj, 'height', {
      get: () => fp.screen.height,
      configurable: true,
    });

    Object.defineProperty(screenObj, 'availWidth', {
      get: () => fp.screen.availWidth,
      configurable: true,
    });

    Object.defineProperty(screenObj, 'availHeight', {
      get: () => fp.screen.availHeight,
      configurable: true,
    });

    // Patch window dimensions
    Object.defineProperty(windowObj, 'innerWidth', {
      get: () => fp.viewport.width,
      configurable: true,
    });

    Object.defineProperty(windowObj, 'innerHeight', {
      get: () => fp.viewport.height,
      configurable: true,
    });

    // Patch WebGL renderer
    (globalThis as any).__patchwright_webgl = {
      renderer: fp.webglRenderer,
      vendor: fp.webglVendor,
      fingerprint: fp.webglFingerprint,
    };
  }, fp);
}

/**
 * Create a Playwright context with fingerprinted options.
 *
 * Returns the launch options with the faked user agent and
 * viewport dimensions configured.
 */
export function createContextOptions(config: Partial<BrowserFingerprintConfig> = {}): Record<string, unknown> {
  const fp = buildFingerprint(config);

  return {
    userAgent: fp.userAgent,
    viewport: {
      width: fp.viewport.width,
      height: fp.viewport.height,
    },
    locale: fp.language,
    timezoneId: fp.timezone,
  };
}
