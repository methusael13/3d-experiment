import { System } from '../System';
import type { Entity } from '../Entity';
import type { ComponentType, SystemContext } from '../types';
import { VegetationInstanceComponent } from '../components/VegetationInstanceComponent';
import type { GPUContext } from '../../gpu/GPUContext';
import { MeshComponent } from '../components/MeshComponent';

/**
 * Byte offset for vegetation instancing uniforms in the MaterialUniforms extra region.
 * Must match the layout expected by vegetationInstancingFeature's per-object resources.
 * 
 * Base MaterialUniforms = 112 bytes (28 floats = 7 × vec4f):
 *   vec4(albedo.rgb, metallic)          [0-3]
 *   vec4(roughness, normalScale, occStr, alphaCutoff) [4-7]
 *   vec4(emissive.rgb, alphaMode)       [8-11]
 *   vec4(textureFlags[0-3])             [12-15]
 *   vec4(textureFlags[4-7])             [16-19]
 *   vec4(triplanarMode, triplanarScale, hasBumpTex, hasDisplacementTex) [20-23]
 *   vec4(bumpScale, displacementScale, displacementBias, pad) [24-27]
 * 
 * Vegetation wind uniforms occupy 10 × f32 = 40 bytes starting at byte 112.
 * 
 * Layout (10 floats):
 *   [0] vegWindStrength
 *   [1] vegWindFrequency
 *   [2] vegWindDirX
 *   [3] vegWindDirZ
 *   [4] vegGustStrength
 *   [5] vegGustFrequency
 *   [6] vegTime
 *   [7] vegMaxDistance
 *   [8] vegWindMultiplier
 *   [9] _pad (alignment)
 */
const VEG_UNIFORM_BASE = 112;
const VEG_UNIFORM_FLOATS = 10;

/**
 * VegetationInstanceSystem
 * 
 * Bridges VegetationManager's per-frame GPU culling output into the ECS world.
 * Each frame, it uploads vegetation-specific uniforms (wind params, time, maxDistance)
 * to the MaterialUniforms extra region of each vegetation draw group entity.
 * 
 * Priority 95: runs after WindSystem (50) but before MeshRenderSystem (100).
 * This ensures wind params are available when MeshRenderSystem groups entities
 * and the variant renderer issues draw calls.
 * 
 * NOTE: Buffer references (culledInstanceBuffer, drawArgsBuffer) and active state
 * are set directly on VegetationInstanceComponent by the VegetationMeshVariantRenderer
 * bridge during VegetationManager.prepareFrame(). This system only handles
 * the uniform upload portion, following the same pattern as WindSystem.
 */
export class VegetationInstanceSystem extends System {
  readonly name = 'vegetation-instance';
  readonly requiredComponents: readonly ComponentType[] = ['vegetation-instance', 'transform'];
  priority = 95;

  /** Reusable buffer for vegetation uniforms (10 floats) */
  private _vegBuf = new Float32Array(VEG_UNIFORM_FLOATS);

  update(entities: Entity[], _deltaTime: number, context: SystemContext): void {
    const ctx = context.ctx;
    
    for (const entity of entities) {
      this.uploadVegetationUniforms(entity, ctx);
    }
  }

  /**
   * Upload vegetation instancing wind uniforms for a single entity.
   * Writes to the MaterialUniforms extra region so the composed shader
   * can read material.vegWindStrength, material.vegWindFrequency, etc.
   */
  private uploadVegetationUniforms(
    entity: Entity,
    ctx: GPUContext,
  ): void {
    const vegComp = entity.getComponent<VegetationInstanceComponent>('vegetation-instance');
    if (!vegComp?.active) return;

    const buf = this._vegBuf;
    buf[0] = vegComp.windStrength;
    buf[1] = vegComp.windFrequency;
    buf[2] = vegComp.windDirection[0];
    buf[3] = vegComp.windDirection[1];
    buf[4] = vegComp.gustStrength;
    buf[5] = vegComp.gustFrequency;
    buf[6] = vegComp.time;
    buf[7] = vegComp.maxDistance;
    buf[8] = vegComp.windMultiplier;
    buf[9] = 0; // padding

    // Write to all GPU mesh IDs associated with this entity
    const meshComp = entity.getComponent<MeshComponent>('mesh');
    if (meshComp?.isGPUInitialized) {
      for (const gpuMeshId of meshComp.gpuMeshIds) {
        ctx.writeMeshExtraUniforms(gpuMeshId, buf, VEG_UNIFORM_BASE);
      }
    }
  }
}
