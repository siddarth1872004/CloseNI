/**
 * Human-like typing rhythm with varied keystroke timing.
 *
 * Humans don't type at a constant rate. Their keystrokes have:
 * - Varied inter-press delays (not uniform)
 * - Longer pauses after punctuation
 * - Occasional backspace corrections
 * - Brief "thinking" pauses mid-typing
 *
 * This module produces typing patterns that mimic human rhythm.
 */

import { TypingRhythmConfig } from "./types.js";
import { generateDelay } from "./human-delays.js";

/**
 * Default typing rhythm configuration.
 *
 * Base delay of 80ms with 25ms standard deviation.
 * Punctuation gets ~3x the normal pause.
 * ~10% chance of backspace correction.
 * ~5% chance of thinking pause mid-typing.
 */
export const DEFAULT_TYPING_CONFIG: TypingRhythmConfig = {
  baseDelayMs: 80,
  delayStdDevMs: 25,
  punctuationPauseFactor: 3,
  pauseChars: "!.?,;:",
  pauseCharDelayMs: 240,
  thinkingPauseProbability: 0.05,
  thinkingPauseRange: [500, 1500],
  backspaceProbability: 0.1,
};

/**
 * Generate a single keystroke delay.
 *
 * Uses a Gaussian distribution centered on the base delay,
 * with adjustments for punctuation and thinking pauses.
 *
 * @param char - The character being typed.
 * @param isThinking - Whether the typist is in a thinking state.
 * @param config - Typing rhythm configuration.
 * @returns The delay in milliseconds.
 */
export function keystrokeDelay(
  char: string,
  isThinking: boolean,
  config: Partial<TypingRhythmConfig> = {}
): number {
  const cfg = { ...DEFAULT_TYPING_CONFIG, ...config };

  if (isThinking) {
    const [min, max] = cfg.thinkingPauseRange;
    return generateDelay({
      meanMs: (min + max) / 2,
      stdDevFactor: 0.2,
      minMs: min,
      maxMs: max,
      jitter: true,
      jitterFactor: 0.1,
    });
  }

  // Base delay with Gaussian variance
  let delay = generateDelay({
    meanMs: cfg.baseDelayMs,
    stdDevFactor: cfg.delayStdDevMs / cfg.baseDelayMs,
    minMs: 20,
    maxMs: 300,
    jitter: true,
    jitterFactor: 0.05,
  });

  // Punctuation gets an additional pause
  if (cfg.pauseChars.includes(char)) {
    delay += cfg.pauseCharDelayMs;
  }

  return delay;
}

/**
 * Generate a typing sequence for a given text.
 *
 * Produces an array of keystroke events with human-like timing,
 * including punctuation pauses and occasional corrections.
 *
 * @param text - The text to type.
 * @param config - Typing rhythm configuration.
 * @returns Array of keystroke events with timing.
 */
export function generateTypingSequence(
  text: string,
  config: Partial<TypingRhythmConfig> = {}
): Array<{
  char: string;
  delay: number;
  timestamp: number;
  type: "keystroke" | "backspace" | "pause";
}> {
  const events: Array<{
    char: string;
    delay: number;
    timestamp: number;
    type: "keystroke" | "backspace" | "pause";
  }> = [];

  let timestamp = Date.now();
  let isThinking = false;
  const cfg = { ...DEFAULT_TYPING_CONFIG, ...config };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    // Decide if we're in a thinking state
    if (Math.random() < cfg.thinkingPauseProbability && !isThinking) {
      isThinking = true;
    }

    const delay = keystrokeDelay(char, isThinking, cfg);

    events.push({
      char,
      delay,
      timestamp,
      type: "keystroke",
    });

    timestamp += delay;

    // Occasional backspace correction
    if (
      Math.random() < cfg.backspaceProbability &&
      i < text.length - 1
    ) {
      events.push({
        char: "",
        delay: 50,
        timestamp,
        type: "backspace",
      });
      timestamp += 50;

      events.push({
        char: text[i + 1],
        delay: keystrokeDelay(text[i + 1], isThinking, cfg),
        timestamp,
        type: "keystroke",
      });
      timestamp += keystrokeDelay(text[i + 1], isThinking, cfg);
      i++; // Skip the next character since we already typed it
    }
  }

  return events;
}

/**
 * Human-like typing with realistic pauses and corrections.
 *
 * Returns a promise that resolves when the typing is complete.
 * Each keystroke is spaced by a human-like delay.
 *
 * @param text - The text to type.
 * @param config - Typing rhythm configuration.
 * @returns The total typing duration in milliseconds.
 */
export function typeWithRhythm(
  text: string,
  config: Partial<TypingRhythmConfig> = {}
): Promise<number> {
  const events = generateTypingSequence(text, config);

  let totalDuration = 0;
  for (const event of events) {
    totalDuration += event.delay;
  }

  return new Promise((resolve) => {
    setTimeout(() => resolve(totalDuration), totalDuration);
  });
}

/**
 * Simulate natural typing with variable speed.
 *
 * Humans type faster when they know what they want to say,
 * and slower when thinking. This function alternates between
 * fast and slow typing modes.
 *
 * @param text - The text to type.
 * @param config - Typing rhythm configuration.
 * @returns Array of typed text segments with their timing.
 */
export function naturalTyping(
  text: string,
  config: Partial<TypingRhythmConfig> = {}
): Array<{
  text: string;
  startMs: number;
  endMs: number;
  speed: "fast" | "normal" | "slow";
}> {
  const cfg = { ...DEFAULT_TYPING_CONFIG, ...config };
  const segments: Array<{
    text: string;
    startMs: number;
    endMs: number;
    speed: "fast" | "normal" | "slow";
  }> = [];

  let currentMs = 0;
  const words = text.split(/\s+/);

  for (const word of words) {
    // Determine speed based on word length and context
    let speed: "fast" | "normal" | "slow";
    if (word.length > 10 || word.includes(",")) {
      speed = "slow";
    } else if (word.length < 4) {
      speed = "fast";
    } else {
      speed = "normal";
    }

    const wordDelay = cfg.baseDelayMs * (speed === "fast" ? 0.6 : speed === "slow" ? 1.8 : 1.0);
    const duration = typeDelayForSpeed(speed, cfg);

    segments.push({
      text: word,
      startMs: currentMs,
      endMs: currentMs + duration,
      speed,
    });

    // Add a small gap between words
    currentMs += duration + (Math.random() * 20);
  }

  return segments;
}

/**
 * Get the delay for a given speed category.
 */
function typeDelayForSpeed(
  speed: "fast" | "normal" | "slow",
  config: Partial<TypingRhythmConfig>
): number {
  const cfg = { ...DEFAULT_TYPING_CONFIG, ...config };
  const multipliers = { fast: 0.6, normal: 1.0, slow: 1.8 };
  const base = cfg.baseDelayMs * (multipliers[speed] || 1.0);
  return generateDelay({
    meanMs: base,
    stdDevFactor: cfg.delayStdDevMs / cfg.baseDelayMs,
    minMs: 20,
    maxMs: 400,
    jitter: true,
    jitterFactor: 0.05,
  });
}

/**
 * Generate a realistic typing pause after completing a thought.
 *
 * Humans pause after finishing a sentence or paragraph.
 * This produces a pause in the reading-range duration.
 *
 * @param config - Typing rhythm configuration.
 * @returns A promise that resolves after the pause.
 */
export function thoughtPause(config?: Partial<TypingRhythmConfig>): Promise<void> {
  return new Promise((resolve) => {
    const pause = generateDelay({
      meanMs: 800,
      stdDevFactor: 0.3,
      minMs: 400,
      maxMs: 2000,
      jitter: true,
      jitterFactor: 0.15,
    });
    setTimeout(resolve, pause);
  });
}
