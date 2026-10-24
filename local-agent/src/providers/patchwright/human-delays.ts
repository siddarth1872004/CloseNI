/**
 * Human-like delays using bell-curve (Gaussian) distribution.
 *
 * Natural human behavior is not uniformly random - actions cluster around
 * a mean with Gaussian falloff. This module provides realistic delay
 * generation using a box-Muller transform for proper Gaussian distribution.
 *
 * Key properties:
 * - Actions cluster around the configured mean
 * - Standard deviation creates natural variance (not too jittery)
 * - Floor and ceiling prevent extreme outliers
 * - Optional jitter adds micro-variance for more organic feel
 */

import { DelayConfig } from "./types.js";

/**
 * Default delay configuration producing human-like timing.
 *
 * Mean: 1500ms (1.5s between actions is natural)
 * StdDev: 30% of mean (450ms variance is natural)
 * Floor: 300ms (minimum human reaction time)
 * Ceiling: 3x mean (occasional longer pauses are normal)
 */
export const DEFAULT_DELAY_CONFIG: DelayConfig = {
  meanMs: 1500,
  stdDevFactor: 0.3,
  minMs: 300,
  maxMs: 4500,
  jitter: true,
  jitterFactor: 0.1,
};

/**
 * Box-Muller transform: generates a Gaussian random number.
 *
 * Uses two uniform random numbers to produce a normally distributed
 * value with the given mean and standard deviation.
 *
 * @returns A random number from a Gaussian distribution.
 */
function gaussianRandom(
  mean: number,
  stdDev: number
): number {
  // Box-Muller transform
  const u1 = Math.random();
  const u2 = Math.random();
  // Avoid log(0)
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z * stdDev;
}

/**
 * Generate a human-like delay based on Gaussian distribution.
 *
 * The delay is drawn from a normal distribution centered at the mean,
 * with the configured standard deviation. The result is clamped between
 * minMs and maxMs to prevent extreme values.
 *
 * @param config - Delay configuration (uses defaults if not provided).
 * @returns The delay in milliseconds.
 */
export function generateDelay(config: Partial<DelayConfig> = {}): number {
  const cfg = { ...DEFAULT_DELAY_CONFIG, ...config };
  const stdDev = cfg.meanMs * cfg.stdDevFactor;

  // Generate Gaussian random value
  let delay = gaussianRandom(cfg.meanMs, stdDev);

  // Clamp between min and max
  delay = Math.max(cfg.minMs, Math.min(cfg.maxMs, delay));

  // Apply optional jitter for micro-variance
  if (cfg.jitter && cfg.jitterFactor > 0) {
    const jitterAmount = (Math.random() * 2 - 1) * cfg.jitterFactor * cfg.meanMs;
    delay += jitterAmount;
    delay = Math.max(cfg.minMs, delay);
  }

  return Math.round(delay);
}

/**
 * Create a sleep promise with a human-like delay.
 *
 * Uses the configured Gaussian distribution to determine the sleep duration,
 * producing more natural timing than a fixed delay.
 *
 * @param config - Delay configuration.
 * @returns A promise that resolves after the generated delay.
 */
export function sleepWithDelay(config?: Partial<DelayConfig>): Promise<void> {
  const delay = generateDelay(config);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Simulate human reading pause - longer than action delay.
 *
 * Humans pause longer when reading or thinking compared to when
 * performing quick actions. This produces a longer delay in the
 * same Gaussian distribution family.
 *
 * @param config - Delay configuration (defaults adjusted for reading).
 * @returns A promise that resolves after the reading pause.
 */
export function readingPause(config?: Partial<DelayConfig>): Promise<void> {
  const cfg = {
    meanMs: (config?.meanMs || DEFAULT_DELAY_CONFIG.meanMs) * 2.5,
    stddevFactor: config?.stdDevFactor ?? DEFAULT_DELAY_CONFIG.stdDevFactor,
    minMs: (config?.minMs || DEFAULT_DELAY_CONFIG.minMs) * 1.5,
    maxMs: (config?.maxMs || DEFAULT_DELAY_CONFIG.maxMs) * 2,
    jitter: config?.jitter ?? DEFAULT_DELAY_CONFIG.jitter,
    jitterFactor: config?.jitterFactor ?? DEFAULT_DELAY_CONFIG.jitterFactor,
  };
  return sleepWithDelay(cfg);
}

/**
 * Simulate human "thinking" pause - significantly longer.
 *
 * When the model or user is contemplating, the pause extends well
 * beyond the normal reading range, producing a natural-looking gap.
 *
 * @param config - Delay configuration (defaults adjusted for thinking).
 * @returns A promise that resolves after the thinking pause.
 */
export function thinkingPause(config?: Partial<DelayConfig>): Promise<void> {
  const cfg = {
    meanMs: (config?.meanMs || DEFAULT_DELAY_CONFIG.meanMs) * 5,
    stddevFactor: config?.stdDevFactor ?? DEFAULT_DELAY_CONFIG.stdDevFactor,
    minMs: (config?.minMs || DEFAULT_DELAY_CONFIG.minMs) * 3,
    maxMs: (config?.maxMs || DEFAULT_DELAY_CONFIG.maxMs) * 2.5,
    jitter: config?.jitter ?? DEFAULT_DELAY_CONFIG.jitter,
    jitterFactor: config?.jitterFactor ?? DEFAULT_DELAY_CONFIG.jitterFactor,
  };
  return sleepWithDelay(cfg);
}

/**
 * Generate a series of human-like delays for a sequence of actions.
 *
 * Useful when performing multiple actions in succession (e.g., typing,
 * pausing, clicking). Each delay is independently sampled.
 *
 * @param count - Number of delays to generate.
 * @param config - Delay configuration.
 * @returns Array of delay durations in milliseconds.
 */
export function generateDelaySeries(count: number, config?: Partial<DelayConfig>): number[] {
  return Array.from({ length: count }, () => generateDelay(config));
}

/**
 * Natural scrolling behavior - smooth, variable-speed scrolling.
 *
 * Mimics human scroll wheels and touchpad gestures, which are not
 * uniform but have natural acceleration and deceleration.
 *
 * @param steps - Number of scroll steps to generate.
 * @param config - Delay configuration (defaults for scrolling).
 * @returns Array of scroll step delays.
 */
export function scrollSequence(steps: number, config?: Partial<DelayConfig>): number[] {
  const cfg = {
    meanMs: 100,
    stddevFactor: 0.4, // More variance for scrolling
    minMs: 20,
    maxMs: 500,
    jitter: true,
    jitterFactor: 0.2,
  };
  return generateDelaySeries(steps, { ...cfg, ...config });
}
