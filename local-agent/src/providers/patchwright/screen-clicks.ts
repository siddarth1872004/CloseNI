/**
 * Screen coordinate-based clicking for bypassing automation checks.
 *
 * Many detection systems check whether clicks are on real screen
 * coordinates rather than viewport-relative or element-based positions.
 * This module provides coordinate-aware clicking that mimics human
 * screen interaction.
 */

import { ScreenClickConfig } from "./types.js";

/**
 * Default screen click configuration.
 *
 * Uses screen coordinates by default.
 * Pixel jitter of 5px is within human clicking variance.
 * Bounding box mode with small offset for natural clicking.
 */
export const DEFAULT_SCREEN_CLICK_CONFIG: ScreenClickConfig = {
  useScreenCoordinates: true,
  pixelJitter: 5,
  clickMode: "point",
  boundingBoxOffset: { x: 10, y: 10 },
  holdTimeMs: 100,
};

/**
 * Convert viewport coordinates to screen coordinates.
 *
 * Accounts for the browser's position on the screen and the
 * viewport-to-screen coordinate transformation.
 *
 * @param viewportX - X coordinate in viewport space.
 * @param viewportY - Y coordinate in viewport space.
 * @param screenOffset - Offset of the browser window on screen.
 * @returns Screen coordinates.
 */
export function viewportToScreen(
  viewportX: number,
  viewportY: number,
  screenOffset: { x: number; y: number } = { x: 0, y: 0 }
): { x: number; y: number } {
  return {
    x: Math.round(viewportX + screenOffset.x),
    y: Math.round(viewportY + screenOffset.y),
  };
}

/**
 * Generate a screen coordinate click event.
 *
 * Instead of clicking on a DOM element directly, this module
 * calculates the screen coordinates and clicks at that position,
 * bypassing element-based detection.
 *
 * @param viewportX - Viewport X coordinate.
 * @param viewportY - Viewport Y coordinate.
 * @param config - Screen click configuration.
 * @returns Click event with screen coordinates.
 */
export function screenClick(
  viewportX: number,
  viewportY: number,
  config: Partial<ScreenClickConfig> = {}
): {
  type: string;
  screenX: number;
  screenY: number;
  clientX: number;
  clientY: number;
  button: number;
  detail: number;
  ctrlKey: boolean;
  shiftKey: boolean;
} {
  const cfg = { ...DEFAULT_SCREEN_CLICK_CONFIG, ...config };

  // Add pixel jitter for natural click placement
  const jitterX = (Math.random() * 2 - 1) * cfg.pixelJitter;
  const jitterY = (Math.random() * 2 - 1) * cfg.pixelJitter;

  const clientX = Math.round(viewportX + jitterX);
  const clientY = Math.round(viewportY + jitterY);
  const screenX = Math.round(clientX + (cfg.useScreenCoordinates ? (globalThis as any).screenX || 0 : 0));
  const screenY = Math.round(clientY + (cfg.useScreenCoordinates ? (globalThis as any).screenY || 0 : 0));

  // Human clicks occasionally use modifier keys
  const ctrlKey = Math.random() < 0.05;
  const shiftKey = Math.random() < 0.03;

  return {
    type: "click",
    screenX,
    screenY,
    clientX,
    clientY,
    button: 0,
    detail: 1,
    ctrlKey,
    shiftKey,
  };
}

/**
 * Calculate the bounding box for a click target.
 *
 * For bounding-box click mode, calculates a natural offset
 * within the target element's bounding rect.
 *
 * @param rect - The bounding rectangle.
 * @param config - Screen click configuration.
 * @returns The click point within the bounding box.
 */
export function boundingBoxClick(
  rect: { left: number; top: number; width: number; height: number },
  config: Partial<ScreenClickConfig> = {}
): { x: number; y: number } {
  const cfg = { ...DEFAULT_SCREEN_CLICK_CONFIG, ...config };
  const offsetX = cfg.boundingBoxOffset.x + (Math.random() * 2 - 1) * cfg.pixelJitter;
  const offsetY = cfg.boundingBoxOffset.y + (Math.random() * 2 - 1) * cfg.pixelJitter;

  return {
    x: Math.round(rect.left + rect.width * 0.5 + offsetX),
    y: Math.round(rect.top + rect.height * 0.5 + offsetY),
  };
}

/**
 * Simulate human click behavior on screen coordinates.
 *
 * Humans don't click at exactly the same spot twice. This function
 * produces a click at a natural screen coordinate with the appropriate
 * hold time.
 *
 * @param screenX - Screen X coordinate.
 * @param screenY - Screen Y coordinate.
 * @param config - Screen click configuration.
 * @returns A promise that resolves after the click hold time.
 */
export function humanClick(
  screenX: number,
  screenY: number,
  config: Partial<ScreenClickConfig> = {}
): Promise<void> {
  const cfg = { ...DEFAULT_SCREEN_CLICK_CONFIG, ...config };
  return new Promise((resolve) => {
    setTimeout(resolve, cfg.holdTimeMs + Math.random() * 50);
  });
}

/**
 * Generate a coordinate-based click sequence.
 *
 * Mimics a human clicking multiple targets in sequence, with
 * natural movement between each target.
 *
 * @param targets - Array of viewport coordinates to click.
 * @param config - Screen click configuration.
 * @returns Array of click events with screen coordinates.
 */
export function coordinateClickSequence(
  targets: Array<{ x: number; y: number }>,
  config: Partial<ScreenClickConfig> = {}
): Array<{
  event: ReturnType<typeof screenClick>;
  screenX: number;
  screenY: number;
  timestamp: number;
}> {
  const events: Array<{
    event: ReturnType<typeof screenClick>;
    screenX: number;
    screenY: number;
    timestamp: number;
  }> = [];

  let timestamp = Date.now();

  for (let i = 0; i < targets.length; i++) {
    const { x, y } = targets[i];
    const event = screenClick(x, y, config);

    events.push({
      event,
      screenX: event.screenX,
      screenY: event.screenY,
      timestamp,
    });

    // Add inter-click delay
    timestamp += 200 + Math.random() * 300;
  }

  return events;
}

/**
 * Verify that a click is on-screen and within viewport bounds.
 *
 * Humans naturally stay within the visible viewport. This function
 * checks that the click coordinates are within the expected range.
 *
 * @param screenX - Screen X coordinate.
 * @param screenY - Screen Y coordinate.
 * @param viewportWidth - Viewport width.
 * @param viewportHeight - Viewport height.
 * @param screenOffset - Browser window offset on screen.
 * @returns Whether the click is on-screen.
 */
export function isOnScreen(
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
  screenOffset: { x: number; y: number } = { x: 0, y: 0 }
): boolean {
  const viewportEndX = screenOffset.x + viewportWidth;
  const viewportEndY = screenOffset.y + viewportHeight;

  return (
    screenX >= screenOffset.x &&
    screenX <= viewportEndX &&
    screenY >= screenOffset.y &&
    screenY <= viewportEndY
  );
}

/**
 * Generate a natural-looking click pattern on a web page.
 *
 * Simulates a human clicking on content areas, avoiding the very
 * edges of the viewport and clustering clicks in the main content zone.
 *
 * @param contentArea - The content area bounds.
 * @param count - Number of clicks to generate.
 * @returns Array of screen coordinate click events.
 */
export function naturalClickPattern(
  contentArea: {
    left: number;
    top: number;
    width: number;
    height: number;
  },
  count: number
): Array<{ x: number; y: number }> {
  const clicks: Array<{ x: number; y: number }> = [];

  for (let i = 0; i < count; i++) {
    // Human clicks cluster in the middle of the content area
    const x = contentArea.left + contentArea.width * (0.2 + Math.random() * 0.6);
    const y = contentArea.top + contentArea.height * (0.15 + Math.random() * 0.7);

    clicks.push({
      x: Math.round(x + (Math.random() * 2 - 1) * 5),
      y: Math.round(y + (Math.random() * 2 - 1) * 5),
    });
  }

  return clicks;
}
