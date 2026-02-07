/**
 * OceanSceneObject - A scene object proxy for WebGPU ocean/water
 * 
 * This is a lightweight scene object that represents the ocean
 * for selection purposes. It doesn't hold rendering data - just provides:
 * - AABB for raycasting/selection (thin horizontal plane at water level)
 * - Entry in the scene object list
 * - Connection point for water configuration panels
 * 
 * Ocean is always centered at origin and cannot be transformed.
 * Follows the same pattern as GPUTerrainSceneObject.
 */

import { vec3 } from 'gl-matrix';
import { SceneObject } from './SceneObject';
import type { AABB } from './types';
import type { OceanManager } from '../ocean/OceanManager';

/**
 * OceanSceneObject - Scene object proxy for GPU ocean/water
 */
export class OceanSceneObject extends SceneObject {
  readonly objectType = 'ocean';
  
  /** Reference to the OceanManager for config access */
  private _oceanManager: OceanManager | null = null;
  
  /** Cached terrain parameters for AABB calculation */
  private _terrainSize: number = 1000;
  private _heightScale: number = 50;
  
  constructor() {
    super('Ocean');
    
    // Lock position at origin
    vec3.set(this.position, 0, 0, 0);
    vec3.set(this.scale, 1, 1, 1);
  }
  
  /**
   * Set the OceanManager reference
   */
  setOceanManager(manager: OceanManager | null): void {
    this._oceanManager = manager;
  }
  
  /**
   * Get the OceanManager reference
   */
  getOceanManager(): OceanManager | null {
    return this._oceanManager;
  }
  
  /**
   * Update terrain parameters used for AABB calculation
   * Called when terrain config changes
   */
  setTerrainParams(terrainSize: number, heightScale: number): void {
    this._terrainSize = terrainSize;
    this._heightScale = heightScale;
  }
  
  /**
   * Get the ocean AABB for raycasting
   * Returns a thin horizontal box at water level based on grid config
   */
  getBoundingBox(): AABB {
    if (!this._oceanManager) {
      // Default AABB if no manager
      const halfSize = this._terrainSize / 2;
      return {
        min: vec3.fromValues(-halfSize, 0, -halfSize),
        max: vec3.fromValues(halfSize, 1, halfSize),
      };
    }
    
    // OceanManager.getBoundingBox() now uses grid config internally
    const bounds = this._oceanManager.getBoundingBox(this._heightScale);
    return {
      min: bounds.min,
      max: bounds.max,
    };
  }
  
  /**
   * Get water level (normalized)
   */
  getWaterLevel(): number {
    if (!this._oceanManager) return 0.2;
    return this._oceanManager.getWaterLevel();
  }
  
  /**
   * Get water level in world units
   */
  getWaterLevelWorld(): number {
    if (!this._oceanManager) return this._heightScale * 0.2;
    return this._oceanManager.getWaterLevelWorld(this._heightScale);
  }
  
  // ==================== Transform Overrides (ocean is fixed) ====================
  
  /**
   * Position is always at origin - ignore set attempts
   */
  setPosition(pos: vec3 | [number, number, number]): void {
    // Ignore - ocean is fixed at origin
  }
  
  /**
   * Rotation is identity - ignore set attempts
   */
  setRotation(rot: vec3 | [number, number, number]): void {
    // Ignore - ocean cannot be rotated
  }
  
  /**
   * Scale is always 1,1,1 - ignore set attempts
   */
  setScale(scl: vec3 | [number, number, number]): void {
    // Ignore - ocean cannot be scaled (use terrain size instead)
  }
  
  /**
   * Translate is ignored
   */
  translate(delta: vec3 | [number, number, number]): void {
    // Ignore - ocean cannot be moved
  }
  
  // ==================== Lifecycle ====================
  
  destroy(): void {
    // OceanManager handles its own cleanup
    // Just clear the reference
    this._oceanManager = null;
  }
}

/**
 * Type guard to check if an object is an OceanSceneObject
 */
export function isOceanObject(obj: unknown): obj is OceanSceneObject {
  return obj instanceof OceanSceneObject;
}
