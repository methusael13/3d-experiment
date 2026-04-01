/**
 * SDF (Signed Distance Field) Types
 * 
 * Types for the Global Distance Field system used by water contact foam,
 * volumetric fog, and ambient occlusion.
 */

import { vec3 } from 'gl-matrix';

/** Configuration for the Global Distance Field system */
export interface SDFConfig {
  /** Whether the SDF system is enabled */
  enabled: boolean;
  /** Number of cascades (1-3). G1 uses 1, G2 adds multi-cascade */
  cascadeCount: 1 | 2 | 3;
  /** Resolution of each cascade 3D texture */
  baseResolution: 64 | 128 | 256;
  /** Per-cascade half-extents in world units */
  cascadeExtents: Array<{
    halfWidth: number;
    halfHeight: number;
    halfDepth: number;
  }>;
  /** Max compute time per frame in ms (for budget system in G2) */
  updateBudgetMs: number;
  /** Voxels of camera drift before cascade re-centers (G2) */
  hysteresisDistance: number;
  /** Whether terrain stamping is enabled */
  enableTerrainStamping: boolean;
  /** Whether mesh primitive stamping is enabled (G3) */
  enableMeshStamping: boolean;
  /** Whether JFA propagation is enabled (G5) */
  enableJFA: boolean;
}

/** A single SDF cascade (3D texture + metadata) */
export interface SDFCascade {
  /** The 3D r16float storage texture */
  texture: GPUTexture;
  /** Storage view for compute shader writes */
  storageView: GPUTextureView;
  /** Sample view for fragment shader reads */
  sampleView: GPUTextureView;
  /** World-space center of this cascade */
  center: vec3;
  /** Half-extents in world units (x, y, z) */
  extent: vec3;
  /** Size of one voxel in world units */
  voxelSize: number;
  /** Resolution (e.g. 128) */
  resolution: number;
  /** Whether this cascade needs rebuilding */
  dirty: boolean;
}

/** Parameters passed to the SDF terrain stamp compute shader */
export interface SDFTerrainStampParams {
  /** Terrain heightmap texture view */
  heightmapView: GPUTextureView;
  /** Terrain height scale in world units */
  heightScale: number;
  /** Terrain world size (width = depth) */
  terrainWorldSize: number;
  /** Terrain world-space origin offset (XZ) */
  terrainOrigin?: [number, number];
}

/** SDF uniform data for shader consumption */
export interface SDFShaderParams {
  /** World-space center of the cascade */
  center: vec3;
  /** Half-extents */
  extent: vec3;
  /** Voxel size */
  voxelSize: number;
  /** Resolution */
  resolution: number;
}

/** Default SDF configuration (single cascade for G1) */
export function createDefaultSDFConfig(): SDFConfig {
  return {
    enabled: true,
    cascadeCount: 1,
    baseResolution: 128,
    cascadeExtents: [
      { halfWidth: 32, halfHeight: 16, halfDepth: 32 },  // Fine: 64m × 32m × 64m
    ],
    updateBudgetMs: 2.0,
    hysteresisDistance: 8,
    enableTerrainStamping: true,
    enableMeshStamping: false,
    enableJFA: false,
  };
}
