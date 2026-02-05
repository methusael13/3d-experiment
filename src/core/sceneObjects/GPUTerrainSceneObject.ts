/**
 * GPUTerrainSceneObject - A scene object proxy for WebGPU terrain
 * 
 * This is a lightweight scene object that represents the GPU terrain
 * for selection purposes. It doesn't hold terrain data - just provides:
 * - AABB for raycasting/selection
 * - Entry in the scene object list
 * - Connection point for TerrainPanel
 * 
 * Terrain is always centered at origin and cannot be transformed.
 */

import { vec3 } from 'gl-matrix';
import { SceneObject } from './SceneObject';
import type { AABB } from './types';
import type { TerrainManager } from '../terrain/TerrainManager';

/**
 * GPUTerrainSceneObject - Scene object proxy for GPU terrain
 */
export class GPUTerrainSceneObject extends SceneObject {
  readonly objectType = 'terrain-gpu';
  
  /** Reference to the TerrainManager for config access */
  private _terrainManager: TerrainManager | null = null;
  
  constructor() {
    super('Terrain');
    
    // Lock position at origin
    vec3.set(this.position, 0, 0, 0);
    vec3.set(this.scale, 1, 1, 1);
  }
  
  /**
   * Set the TerrainManager reference
   */
  setTerrainManager(manager: TerrainManager | null): void {
    this._terrainManager = manager;
  }
  
  /**
   * Get the TerrainManager reference
   */
  getTerrainManager(): TerrainManager | null {
    return this._terrainManager;
  }
  
  /**
   * Get the terrain AABB for raycasting
   * Computed from TerrainManager config
   */
  getBoundingBox(): AABB {
    if (!this._terrainManager) {
      // Default AABB if no manager
      return {
        min: vec3.fromValues(-50, 0, -50),
        max: vec3.fromValues(50, 10, 50),
      };
    }
    
    const config = this._terrainManager.getConfig();
    const halfSize = config.worldSize / 2;
    const heightScale = config.heightScale;
    
    return {
      min: vec3.fromValues(-halfSize, 0, -halfSize),
      max: vec3.fromValues(halfSize, heightScale, halfSize),
    };
  }
  
  /**
   * Get world size from TerrainManager
   */
  getWorldSize(): number {
    if (!this._terrainManager) return 100;
    return this._terrainManager.getConfig().worldSize;
  }
  
  /**
   * Get height scale from TerrainManager
   */
  getHeightScale(): number {
    if (!this._terrainManager) return 10;
    return this._terrainManager.getConfig().heightScale;
  }
  
  // ==================== Transform Overrides (terrain is fixed) ====================
  
  /**
   * Position is always at origin - ignore set attempts
   */
  setPosition(pos: vec3 | [number, number, number]): void {
    // Ignore - terrain is fixed at origin
  }
  
  /**
   * Rotation is identity - ignore set attempts
   */
  setRotation(rot: vec3 | [number, number, number]): void {
    // Ignore - terrain cannot be rotated
  }
  
  /**
   * Scale is always 1,1,1 - ignore set attempts
   */
  setScale(scl: vec3 | [number, number, number]): void {
    // Ignore - terrain cannot be scaled (use worldSize instead)
  }
  
  /**
   * Translate is ignored
   */
  translate(delta: vec3 | [number, number, number]): void {
    // Ignore - terrain cannot be moved
  }
  
  // ==================== Lifecycle ====================
  
  destroy(): void {
    // No GPU resources held directly - TerrainManager handles its own cleanup
    this._terrainManager?.destroy();
    this._terrainManager = null;
  }
}

/**
 * Type guard to check if an object is a GPUTerrainSceneObject
 */
export function isGPUTerrainObject(obj: unknown): obj is GPUTerrainSceneObject {
  return obj instanceof GPUTerrainSceneObject;
}
