/**
 * ProjectedGridBuilder - Computes projector matrix for screen-space projected ocean grid.
 *
 * A projected grid starts as a uniform [0,1]² screen-space grid and is unprojected
 * onto the water plane (y = waterLevel) in the vertex shader. This naturally places
 * dense vertices near the camera and sparse vertices at the horizon — optimal for
 * FFT ocean rendering where near-camera detail matters most.
 *
 * Based on Johanson 2004 "Real-time water rendering" with simplifications.
 */

import { mat4, vec3, vec4 } from 'gl-matrix';

export class ProjectedGridBuilder {
  // Reusable temporaries to avoid per-frame allocations
  private _vp = mat4.create();
  private _ivp = mat4.create();
  private _corners: vec4[] = Array.from({ length: 8 }, () => vec4.create());
  private _result = mat4.create();

  /**
   * Compute the inverse projector matrix for the projected grid vertex shader.
   *
   * The vertex shader will:
   *   1. Take a [0,1]² grid position → convert to [-1,1] NDC
   *   2. Multiply by this inverse projector → get two world-space points (near/far)
   *   3. Intersect the ray between them with y = waterLevel
   *   4. Sample FFT displacement at the intersection point
   *
   * This basic implementation uses the camera's inverse VP directly. For edge cases
   * (camera below water, looking straight up), the grid gracefully degenerates and
   * the shader clamps projection distance.
   *
   * @param viewMatrix - Camera view matrix (world → view)
   * @param projectionMatrix - Camera projection matrix (view → clip, reversed-Z)
   * @param cameraPosition - Camera world position [x, y, z]
   * @param waterLevel - Water plane Y coordinate in world space
   * @returns The inverse view-projection matrix (Float32Array, column-major)
   */
  computeProjectorInverse(
    viewMatrix: Float32Array,
    projectionMatrix: Float32Array,
    cameraPosition: Float32Array | number[],
    waterLevel: number,
  ): Float32Array {
    // Build VP = P * V
    mat4.multiply(this._vp, projectionMatrix as unknown as mat4, viewMatrix as unknown as mat4);

    // Invert VP → inverse projector
    const success = mat4.invert(this._ivp, this._vp);
    if (!success) {
      // Fallback: identity (grid stays in screen space — visually broken but won't crash)
      mat4.identity(this._ivp);
    }

    return this._ivp as Float32Array;
  }
}
