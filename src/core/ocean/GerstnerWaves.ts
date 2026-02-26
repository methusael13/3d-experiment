/**
 * CPU-side Gerstner wave evaluation — TypeScript port of the 4-wave Gerstner
 * displacement from water.wgsl vertex shader.
 *
 * Used by WetnessSystem to compute accurate water surface height at a given
 * world XZ position, so objects partially submerged in water get a correct
 * wet line that follows the wave animation.
 *
 * The wave parameters (directions, steepnesses, wavelength ratios) are
 * hardcoded to match water.wgsl exactly.
 */

const PI = Math.PI;

/**
 * Evaluate a single Gerstner wave displacement (Y component only, for height queries).
 */
function gerstnerWaveY(
  posX: number,
  posZ: number,
  dirX: number,
  dirZ: number,
  steepness: number,
  wavelength: number,
  time: number,
): number {
  const k = (2.0 * PI) / wavelength;
  const c = Math.sqrt(9.8 / k); // Phase velocity from dispersion relation
  const dLen = Math.sqrt(dirX * dirX + dirZ * dirZ);
  const dx = dirX / dLen;
  const dz = dirZ / dLen;
  const f = k * (dx * posX + dz * posZ - c * time);
  const a = steepness / k; // Amplitude
  return a * Math.sin(f);
}

/**
 * Result of Gerstner wave evaluation at a world XZ position.
 */
export interface GerstnerHeightResult {
  /** Water surface Y displacement (add to base water level) */
  heightOffset: number;
}

/**
 * Evaluate the combined 4-wave Gerstner displacement at a world XZ position.
 *
 * Parameters match the water shader's `getGerstnerWaves()`:
 * - worldX, worldZ: world-space XZ coordinates
 * - time: animation time in seconds
 * - waveScale: wave steepness multiplier (from WaterConfig.waveScale)
 * - baseWavelength: base wavelength (from WaterConfig.wavelength)
 *
 * Returns the Y offset to add to the base water level.
 */
export function evaluateGerstnerHeight(
  worldX: number,
  worldZ: number,
  time: number,
  waveScale: number,
  baseWavelength: number,
): GerstnerHeightResult {
  // Derived wavelengths from base (must match water.wgsl)
  const wavelength1 = baseWavelength;
  const wavelength2 = baseWavelength * 0.6;
  const wavelength3 = baseWavelength * 0.35;
  const wavelength4 = baseWavelength * 0.2;

  let heightOffset = 0;

  // Wave 1: Primary swell (direction: 1.0, 0.3; steepness: 0.25)
  heightOffset += gerstnerWaveY(
    worldX, worldZ,
    1.0, 0.3,
    0.25 * waveScale,
    wavelength1,
    time,
  );

  // Wave 2: Secondary cross swell (direction: -0.6, 0.8; steepness: 0.18)
  heightOffset += gerstnerWaveY(
    worldX, worldZ,
    -0.6, 0.8,
    0.18 * waveScale,
    wavelength2,
    time * 1.1,
  );

  // Wave 3: Medium waves (direction: 0.4, -0.9; steepness: 0.12)
  heightOffset += gerstnerWaveY(
    worldX, worldZ,
    0.4, -0.9,
    0.12 * waveScale,
    wavelength3,
    time * 0.9,
  );

  // Wave 4: Small detail waves (direction: -0.8, -0.4; steepness: 0.08)
  heightOffset += gerstnerWaveY(
    worldX, worldZ,
    -0.8, -0.4,
    0.08 * waveScale,
    wavelength4,
    time * 1.3,
  );

  return { heightOffset };
}