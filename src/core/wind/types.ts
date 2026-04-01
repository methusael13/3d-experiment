/**
 * Core wind types — shared between global WindManager and local WindSourceComponent.
 */

import type { Vec2 } from '../types';

/**
 * Parameters describing a wind force (used by both global and local sources).
 */
export interface WindForceParams {
  /** Wind direction as normalized [x, z] vector */
  direction: Vec2;
  /** Wind strength magnitude (0+) */
  strength: number;
  /** Turbulence amount (0–1) — time-varying noise on direction */
  turbulence: number;
  /** Current gust intensity (0+) — added to strength */
  gustIntensity: number;
  /** Random gust direction offset [x, z] */
  gustVector: Vec2;
}

/**
 * Parameters for the spring-damper physics model that converts
 * a wind force into smooth displacement on a receiver entity.
 */
export interface SpringParams {
  /** Spring constant — higher = faster return to rest */
  springStiffness: number;
  /** Velocity damping factor (0–1, lower = more damping) */
  damping: number;
  /** Effective mass of the simulated object */
  mass: number;
}

/**
 * Mutable state for a single spring simulation instance.
 * Each wind receiver entity has its own displacement/velocity.
 */
export interface SpringState {
  displacement: Vec2;
  velocity: Vec2;
}

/**
 * Shape of a local wind source volume.
 * - `sphere`: omni-directional, radiates outward from center
 * - `directional`: infinite plane push in a direction (like global wind but local)
 * - `cone`: directed cone from a point (e.g., helicopter downwash, jet exhaust)
 */
export type WindSourceShape = 'sphere' | 'directional' | 'cone';
