/**
 * Shared types for the patchwright stack.
 *
 * Patchwright layers human-like behavior on top of Playwright to make
 * automated browser sessions harder to detect. Each module contributes
 * capabilities that are activated independently or together.
 */

import { DEFAULT_DELAY_CONFIG } from "./human-delays.js";
import { DEFAULT_MOUSE_PATH_CONFIG } from "./mouse-paths.js";
import { DEFAULT_TYPING_CONFIG } from "./typing-rhythm.js";
import { DEFAULT_SCREEN_CLICK_CONFIG } from "./screen-clicks.js";
import { DEFAULT_FINGERPRINT } from "./browser-fingerprint.js";
import { DEFAULT_NETWORK_CONFIG } from "./network-routing.js";

/**
 * Distribution parameters for human-like random delays.
 * Bell-curve (Gaussian) distribution produces natural-looking timing.
 */
export interface DelayConfig {
  /** Mean delay in milliseconds before an action. */
  meanMs: number;
  /** Standard deviation as a fraction of mean (0.2 = 20% variance). */
  stdDevFactor: number;
  /** Minimum delay floor (ms). */
  minMs: number;
  /** Maximum delay ceiling (ms). */
  maxMs: number;
  /** Whether to apply jitter on top of the base delay. */
  jitter: boolean;
  /** Jitter magnitude as a fraction. */
  jitterFactor: number;
}

/**
 * Mouse path configuration for curved movement.
 * Quadratic Bezier curve control point offset produces human-like arcs.
 */
export interface MousePathConfig {
  /** Number of steps in the path interpolation. */
  steps: number;
  /** Maximum control point offset as a fraction of total distance. */
  controlPointFactor: number;
  /** How much the control point varies (0-1, higher = more curvature). */
  curvature: number;
  /** Speed profile: "linear", "ease-in", "ease-out", or "ease-in-out". */
  speedProfile: "linear" | "ease-in" | "ease-out" | "ease-in-out";
  /** Duration of the mouse movement in ms. */
  durationMs: number;
}

/**
 * Typing rhythm configuration for human-like keystroke timing.
 * Varied inter-press delays mimic human typing patterns.
 */
export interface TypingRhythmConfig {
  /** Base inter-press delay in ms. */
  baseDelayMs: number;
  /** Standard deviation of inter-press delay. */
  delayStdDevMs: number;
  /** Pause length after punctuation (fraction of baseDelayMs). */
  punctuationPauseFactor: number;
  /** Characters that trigger a longer pause. */
  pauseChars: string;
  /** Average pause after a pause-triggering character (ms). */
  pauseCharDelayMs: number;
  /** Probability (0-1) of a longer "thinking" pause mid-typing. */
  thinkingPauseProbability: number;
  /** Thinking pause duration range (ms). */
  thinkingPauseRange: [number, number];
  /** Probability (0-1) of a backspace correction (human habit). */
  backspaceProbability: number;
}

/**
 * Screen coordinate configuration for clicking.
 * Clicks at screen coordinates bypass element-based detection.
 */
export interface ScreenClickConfig {
  /** Use screen coordinates instead of viewport-relative coordinates. */
  useScreenCoordinates: boolean;
  /** Pixel offset variance (human clicks are not pixel-perfect). */
  pixelJitter: number;
  /** Whether to click at a specific point or within a bounding rect. */
  clickMode: "point" | "bounding-box";
  /** For bounding-box mode: offset from top-left corner. */
  boundingBoxOffset: { x: number; y: number };
  /** Click pressure simulation: hold time variance (ms). */
  holdTimeMs: number;
}

/**
 * Browser fingerprint configuration.
 * Fakes UA, WebGL, screen size, and hardware IDs.
 */
export interface BrowserFingerprintConfig {
  /** Faked user agent string. */
  userAgent: string;
  /** Platform string. */
  platform: string;
  /** Faked viewport dimensions. */
  viewport: { width: number; height: number };
  /** Screen resolution. */
  screen: { width: number; height: number; availWidth: number; availHeight: number };
  /** Hardware concurrency (CPU cores). */
  hardwareConcurrency: number;
  /** Device memory (GB). */
  deviceMemory: number;
  /** WebGL renderer string. */
  webglRenderer: string;
  /** WebGL vendor string. */
  webglVendor: string;
  /** Language settings. */
  language: string;
  /** Languages list. */
  languages: string[];
  /** Timezone. */
  timezone: string;
  /** Hardware ID for fingerprinting. */
  hardwareId: string;
  /** Canvas fingerprint seed for consistent rendering. */
  canvasSeed: number;
}

/**
 * Network routing configuration.
 * Residential IP routing and TLS fingerprint matching.
 */
export interface NetworkRoutingConfig {
  /** Enable residential IP routing. */
  residentialRouting: boolean;
  /** Pool of residential IPs to rotate through. */
  ipPool?: string[];
  /** Current residential IP address. */
  currentIp?: string;
  /** Match TLS fingerprint to a real browser. */
  tlsFingerprintMatch: boolean;
  /** JA3 fingerprint string. */
  ja3Fingerprint: string;
  /** QUIC support flag. */
  quicEnabled: boolean;
  /** HTTP/2 support flag. */
  http2Enabled: boolean;
  /** TLS signature algorithms. */
  signatureAlgorithms: string[];
  /** TLS supported groups. */
  supportedGroups: string[];
}

/**
 * Complete patchwright configuration combining all modules.
 */
export interface PatchwrightConfig {
  /** Enable all patchwright features (shortcut). */
  enabled: boolean;
  /** Delay configuration. */
  delays?: Partial<DelayConfig>;
  /** Mouse path configuration. */
  mousePaths?: Partial<MousePathConfig>;
  /** Typing rhythm configuration. */
  typingRhythm?: Partial<TypingRhythmConfig>;
  /** Screen click configuration. */
  screenClicks?: Partial<ScreenClickConfig>;
  /** Browser fingerprint configuration. */
  fingerprint?: Partial<BrowserFingerprintConfig>;
  /** Network routing configuration. */
  network?: Partial<NetworkRoutingConfig>;
  /** Enable anti-detection (navigator.webdriver + cdc_ hiding). */
  antiDetection: boolean;
}

/**
 * Default patchwright configuration combining all modules.
 * Exported from types.ts so it can be imported by any module.
 */
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
