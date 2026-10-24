/**
 * Curved mouse path interpolation for human-like mouse movement.
 *
 * Straight-line mouse movements are a telltale sign of automation.
 * Humans move their mouse along curved paths with natural acceleration.
 * This module generates Bezier-curved mouse paths and provides
 * coordinate interpolation for smooth mouse movement.
 *
 * Implementation uses quadratic Bezier curves with a control point
 * that creates arcs in human-looking directions.
 */

import { MousePathConfig } from "./types.js";

/** A point along the mouse path. */
export interface MousePoint {
  x: number;
  y: number;
  timestamp: number;
}

/** A mouse movement event for injection. */
export interface MouseEvent {
  type: "mousemove" | "mousedown" | "mouseup" | "click";
  x: number;
  y: number;
  timestamp: number;
  button?: number;
  detail?: number;
}

/**
 * Default mouse path configuration producing human-like movement.
 *
 * 10 steps gives smooth enough interpolation without excessive data.
 * Control point factor of 0.3 creates moderate curvature.
 * Curvature of 0.5 produces a good balance of arc and straightness.
 */
export const DEFAULT_MOUSE_PATH_CONFIG: MousePathConfig = {
  steps: 10,
  controlPointFactor: 0.3,
  curvature: 0.5,
  speedProfile: "ease-in-out",
  durationMs: 300,
};

/**
 * Quadratic Bezier curve evaluation.
 *
 * P(t) = (1-t)^2 * P0 + 2*(1-t)*t * P1 + t^2 * P2
 * where P0 is start, P1 is control point, P2 is end.
 *
 * @param t - Parameter from 0 to 1.
 * @param p0 - Start point.
 * @param p1 - Control point.
 * @param p2 - End point.
 * @returns Interpolated point.
 */
function bezierQuadratic(t: number, p0: { x: number; y: number }, p1: { x: number; y: number }, p2: { x: number; y: number }): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

/**
 * Easing function for speed profiles.
 *
 * Maps the parameter t (0-1) to an eased value that controls
 * the speed curve of the mouse movement.
 */
function easeFunction(profile: MousePathConfig["speedProfile"]): (t: number) => number {
  switch (profile) {
    case "linear":
      return (t: number) => t;
    case "ease-in":
      return (t: number) => t * t;
    case "ease-out":
      return (t: number) => t * (2 - t);
    case "ease-in-out":
      return (t: number) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    default:
      return (t: number) => t;
  }
}

/**
 * Generate a curved mouse path between two points.
 *
 * The control point is offset from the midpoint of the line between
 * start and end, with randomness in both direction and distance
 * to produce human-like curves.
 *
 * @param start - Start coordinates.
 * @param end - End coordinates.
 * @param config - Mouse path configuration.
 * @returns Array of MousePoint objects representing the path.
 */
export function generateCurvedPath(
  start: { x: number; y: number },
  end: { x: number; y: number },
  config: Partial<MousePathConfig> = {}
): MousePoint[] {
  const cfg = { ...DEFAULT_MOUSE_PATH_CONFIG, ...config };
  const steps = cfg.steps;

  // Calculate midpoint
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;

  // Calculate distance for control point offset
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Offset control point perpendicular to the line
  const offset = distance * cfg.controlPointFactor * cfg.curvature;
  // Add randomness in both directions
  const direction = Math.random() > 0.5 ? 1 : -1;
  const controlX = midX + (dy / (distance || 1)) * offset * direction;
  const controlY = midY - (dx / (distance || 1)) * offset * direction;

  // Add slight random perturbation to control point
  const cpPerturbation = offset * 0.2;
  const controlPoint = {
    x: controlX + (Math.random() * 2 - 1) * cpPerturbation,
    y: controlY + (Math.random() * 2 - 1) * cpPerturbation,
  };

  // Generate path points
  const path: MousePoint[] = [];
  const baseTime = Date.now();
  const duration = cfg.durationMs;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const easedT = easeFunction(cfg.speedProfile)(t);
    const point = bezierQuadratic(easedT, start, controlPoint, end);

    path.push({
      x: Math.round(point.x),
      y: Math.round(point.y),
      timestamp: baseTime + Math.round(t * duration),
    });
  }

  return path;
}

/**
 * Generate a natural-looking mouse movement with acceleration.
 *
 * Humans don't move their mouse at constant speed - they accelerate
 * and decelerate. This function produces a path that mimics that pattern.
 *
 * @param startX - Starting X coordinate.
 * @param startY - Starting Y coordinate.
 * @param distanceX - Distance to travel on X axis.
 * @param distanceY - Distance to travel on Y axis.
 * @param config - Mouse path configuration.
 * @returns Array of MousePoint objects.
 */
export function naturalMouseMovement(
  startX: number,
  startY: number,
  distanceX: number,
  distanceY: number,
  config: Partial<MousePathConfig> = {}
): MousePoint[] {
  // Add some randomness to the endpoint
  const jitterX = (Math.random() * 2 - 1) * 10;
  const jitterY = (Math.random() * 2 - 1) * 10;
  const endX = startX + distanceX + jitterX;
  const endY = startY + distanceY + jitterY;

  return generateCurvedPath(
    { x: startX, y: startY },
    { x: endX, y: endY },
    config
  );
}

/**
 * Simulate a human click with a curved approach path.
 *
 * The mouse approaches the target along a curved path, pauses briefly
 * (human "aiming" behavior), then clicks.
 *
 * @param targetX - Target X coordinate.
 * @param targetY - Target Y coordinate.
 * @param config - Mouse path configuration.
 * @returns Array of MouseEvent objects representing the full click.
 */
export function simulateClick(
  targetX: number,
  targetY: number,
  config: Partial<MousePathConfig> = {}
): MouseEvent[] {
  // Start from a random nearby position
  const startX = targetX + (Math.random() * 2 - 1) * 200;
  const startY = targetY + (Math.random() * 2 - 1) * 200;

  const path = generateCurvedPath(
    { x: startX, y: startY },
    { x: targetX, y: targetY },
    config
  );

  // Build event sequence
  const events: MouseEvent[] = [];
  const baseTime = Date.now();

  // Mouse move events along path
  for (let i = 0; i < path.length; i++) {
    events.push({
      type: "mousemove",
      x: path[i].x,
      y: path[i].y,
      timestamp: path[i].timestamp,
    });
  }

  // Brief pause before click (human "aiming")
  const clickTime = path[path.length - 1].timestamp + 100;

  events.push({
    type: "mousedown",
    x: targetX,
    y: targetY,
    timestamp: clickTime,
    button: 0,
  });

  events.push({
    type: "mouseup",
    x: targetX,
    y: targetY,
    timestamp: clickTime + 80,
    button: 0,
  });

  events.push({
    type: "click",
    x: targetX,
    y: targetY,
    timestamp: clickTime + 100,
    detail: 1,
  });

  return events;
}

/**
 * Generate a series of mouse movements mimicking human browsing.
 *
 * Simulates the natural back-and-forth movement of a human mouse,
 * including small corrections and occasional larger repositioning.
 *
 * @param count - Number of movements to generate.
 * @param config - Mouse path configuration.
 * @returns Array of MouseEvent arrays, one per movement.
 */
export function browseMouseMovements(
  count: number,
  config: Partial<MousePathConfig> = {}
): MouseEvent[][] {
  const movements: MouseEvent[][] = [];
  let currentX = 400;
  let currentY = 300;

  for (let i = 0; i < count; i++) {
    // Each movement covers a small random distance
    const dx = (Math.random() * 2 - 1) * 150;
    const dy = (Math.random() * 2 - 1) * 100;

    const movement = naturalMouseMovement(
      currentX,
      currentY,
      dx,
      dy,
      config
    ) as MouseEvent[];

    movements.push(movement);
    currentX += dx;
    currentY += dy;
  }

  return movements;
}
