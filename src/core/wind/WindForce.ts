/**
 * Core wind force calculation and spring physics — pure functions.
 *
 * Used by both the global WindManager and per-entity WindSourceComponent
 * so that the physics model is shared and consistent.
 */

import type { Vec2 } from '../types';
import type { WindForceParams, SpringParams, SpringState, WindSourceShape } from './types';

// ─── Force Calculation ───────────────────────────────────────────────

/**
 * Calculate the wind force vector from a set of wind parameters and a time value.
 * Returns a Vec2 [fx, fz] representing the force in the XZ plane.
 */
export function calculateWindForce(params: WindForceParams, time: number): Vec2 {
  const { direction, strength, turbulence, gustIntensity, gustVector } = params;

  // Time-varying turbulence noise (multi-frequency sinusoids)
  const turbX = Math.sin(time * 1.3) * 0.3 + Math.sin(time * 2.7) * 0.2;
  const turbZ = Math.cos(time * 1.7) * 0.3 + Math.cos(time * 2.3) * 0.2;

  // Effective strength includes current gust
  const effectiveStrength = strength + gustIntensity;

  const force: Vec2 = [
    (direction[0] + turbX * turbulence + gustVector[0]) * effectiveStrength,
    (direction[1] + turbZ * turbulence + gustVector[1]) * effectiveStrength,
  ];

  return force;
}

// ─── Spring Physics ──────────────────────────────────────────────────

/**
 * Advance the spring-damper simulation for one receiver.
 *
 * @param state   Mutable displacement/velocity (modified in-place)
 * @param force   Net wind force [fx, fz] acting on this receiver
 * @param spring  Spring physics parameters
 * @param influence  Receiver influence multiplier (from WindComponent)
 * @param stiffness  Receiver stiffness factor (0–1, from WindComponent)
 * @param deltaTime  Frame delta in seconds
 */
export function updateSpringPhysics(
  state: SpringState,
  force: Vec2,
  spring: SpringParams,
  influence: number,
  stiffness: number,
  deltaTime: number,
): void {
  const stiffnessFactor = 1.0 - stiffness;
  const effectiveInfluence = influence * stiffnessFactor;

  const springK = spring.springStiffness * (1.0 + stiffness);
  const dampingFactor = spring.damping * (0.95 + stiffness * 0.05);

  for (let i = 0; i < 2; i++) {
    const fWind = force[i] * effectiveInfluence;
    const fSpring = -springK * state.displacement[i];
    const fTotal = fWind + fSpring;
    const acceleration = fTotal / spring.mass;

    state.velocity[i] += acceleration * deltaTime;
    state.velocity[i] *= dampingFactor;
    state.displacement[i] += state.velocity[i] * deltaTime;
  }

  // Clamp maximum displacement
  const maxDisp = 1.5 * effectiveInfluence;
  const dispMag = Math.sqrt(state.displacement[0] ** 2 + state.displacement[1] ** 2);
  if (dispMag > maxDisp && maxDisp > 0) {
    const scale = maxDisp / dispMag;
    state.displacement[0] *= scale;
    state.displacement[1] *= scale;
  }
}

/**
 * Smoothly decay displacement/velocity toward rest (used when wind is disabled).
 */
export function decaySpringToRest(state: SpringState): void {
  state.displacement[0] *= 0.9;
  state.displacement[1] *= 0.9;
  state.velocity[0] *= 0.8;
  state.velocity[1] *= 0.8;
}

// ─── Local Source Spatial Attenuation ────────────────────────────────

/**
 * Compute the attenuation factor [0–1] for a local wind source
 * given the distance from source to receiver and source parameters.
 *
 * @param distance      Distance from source to receiver position
 * @param innerRadius   Distance within which attenuation is 1.0 (full strength)
 * @param outerRadius   Distance beyond which attenuation is 0.0 (no effect)
 * @param falloffExp    Falloff exponent (1 = linear, 2 = quadratic, etc.)
 * @returns             Attenuation in [0, 1]
 */
export function computeDistanceAttenuation(
  distance: number,
  innerRadius: number,
  outerRadius: number,
  falloffExp: number,
): number {
  if (distance <= innerRadius) return 1.0;
  if (distance >= outerRadius) return 0.0;
  const t = (distance - innerRadius) / (outerRadius - innerRadius);
  return Math.max(0, 1.0 - Math.pow(t, falloffExp));
}

/**
 * Compute the wind force direction and attenuation for a local wind source
 * at a given receiver position.
 *
 * @param shape         Source shape type
 * @param sourcePos     Source world position [x, y, z]
 * @param receiverPos   Receiver world position [x, y, z]
 * @param sourceDir     Source direction [x, z] (normalized, for directional/cone)
 * @param coneAngleDeg  Cone half-angle in degrees (for cone shape)
 * @param innerRadius   Inner radius (full strength zone)
 * @param outerRadius   Outer radius (max reach)
 * @param falloffExp    Falloff exponent
 * @returns {{ direction: Vec2, attenuation: number }} or null if out of range
 */
export function computeLocalWindContribution(
  shape: WindSourceShape,
  sourcePos: [number, number, number],
  receiverPos: [number, number, number],
  sourceDir: Vec2,
  coneAngleDeg: number,
  innerRadius: number,
  outerRadius: number,
  falloffExp: number,
): { direction: Vec2; attenuation: number } | null {
  // Delta in XZ plane
  const dx = receiverPos[0] - sourcePos[0];
  const dz = receiverPos[2] - sourcePos[2];
  const distance = Math.sqrt(dx * dx + dz * dz);

  if (distance >= outerRadius) return null;

  const distAtten = computeDistanceAttenuation(distance, innerRadius, outerRadius, falloffExp);
  if (distAtten <= 0) return null;

  let direction: Vec2;
  let finalAtten = distAtten;

  switch (shape) {
    case 'sphere': {
      // Radial: wind pushes outward from source center
      if (distance < 0.001) {
        direction = [0, 0];
      } else {
        direction = [dx / distance, dz / distance];
      }
      break;
    }

    case 'directional': {
      // Uniform direction within radius
      direction = [sourceDir[0], sourceDir[1]];
      break;
    }

    case 'cone': {
      // Directed cone — attenuate by angle from source direction
      direction = [sourceDir[0], sourceDir[1]];
      if (distance > 0.001) {
        const toReceiver: Vec2 = [dx / distance, dz / distance];
        // Dot product = cos(angle between source dir and receiver dir)
        const dot = sourceDir[0] * toReceiver[0] + sourceDir[1] * toReceiver[1];
        const coneAngleRad = (coneAngleDeg * Math.PI) / 180;
        const cosCone = Math.cos(coneAngleRad);
        if (dot < cosCone) {
          return null; // Outside cone
        }
        // Smooth angular falloff within the cone
        const angularT = 1.0 - (1.0 - dot) / (1.0 - cosCone + 0.001);
        finalAtten *= Math.max(0, angularT);
      }
      break;
    }

    default:
      direction = [sourceDir[0], sourceDir[1]];
  }

  return { direction, attenuation: finalAtten };
}
