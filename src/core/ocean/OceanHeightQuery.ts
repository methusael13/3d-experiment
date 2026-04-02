/**
 * OceanHeightQuery - Unified water surface height query API (Phase W2)
 *
 * Uses the existing CPU-side Gerstner evaluation as a height query fallback
 * while the GPU FFT handles rendering. The visual mismatch between CPU Gerstner
 * and GPU FFT at the waterline is typically imperceptible (Option 3 from plan).
 *
 * Future: Option 1 (GPU readback of displacement map) for exact height queries
 * when readback latency is acceptable.
 */

import { evaluateGerstnerHeight } from './GerstnerWaves';

export interface OceanHeightQueryParams {
  /** Base water level in world units */
  waterLevelWorld: number;
  /** Wave scale multiplier */
  waveScale: number;
  /** Base wavelength */
  wavelength: number;
  /** Animation time */
  time: number;
}

/**
 * Query the approximate water surface height at a world XZ position.
 *
 * Currently uses the simplified 4-wave Gerstner model on CPU.
 * When FFT is active on GPU, this provides a reasonable approximation
 * for systems that need height queries (WetnessSystem, buoyancy, etc.).
 */
export function queryOceanHeight(
  worldX: number,
  worldZ: number,
  params: OceanHeightQueryParams,
): number {
  const result = evaluateGerstnerHeight(
    worldX,
    worldZ,
    params.time,
    params.waveScale,
    params.wavelength,
  );

  return params.waterLevelWorld + result.heightOffset;
}

/**
 * Query water height at multiple positions (batch version).
 * Returns an array of world-space Y values.
 */
export function queryOceanHeightBatch(
  positions: Array<{ x: number; z: number }>,
  params: OceanHeightQueryParams,
): number[] {
  return positions.map(p => queryOceanHeight(p.x, p.z, params));
}
