import { System } from '../System';
import type { Entity } from '../Entity';
import type { ComponentType, SystemContext } from '../types';
import { TransformComponent } from '../components/TransformComponent';
import { MeshComponent } from '../components/MeshComponent';
import { PrimitiveGeometryComponent } from '../components/PrimitiveGeometryComponent';
import { MaterialComponent } from '../components/MaterialComponent';
import { WindComponent } from '../components/WindComponent';
import { WetnessComponent } from '../components/WetnessComponent';
import { ShadowComponent } from '../components/ShadowComponent';
import { VisibilityComponent } from '../components/VisibilityComponent';

/**
 * Byte offset for feature uniforms in the MaterialUniforms buffer.
 * Base MaterialUniforms = 80 bytes (20 floats).
 * EXTRA_UNIFORM_FIELDS start at byte 80.
 *
 * Layout: wind fields (6 × f32 = 24 bytes) then wetness (vec4f = 16 bytes).
 * When wind is not present, wetness starts at byte 80.
 */
const FEATURE_UNIFORM_BASE = 80; // After base MaterialUniforms
const WIND_UNIFORM_SIZE = 24;    // 6 × f32

/**
 * Grouped entities sharing the same shader variant pipeline.
 */
export interface ShaderVariantGroup {
  /** Sorted feature key (e.g., "ibl+shadow+textured+wind") */
  featureKey: string;

  /** Feature IDs for this group */
  featureIds: string[];

  /** Entities in this group */
  entities: Entity[];
}

/**
 * MeshRenderSystem — determines shader feature sets per entity and groups
 * entities by shader variant for efficient batched rendering.
 *
 * Priority 100: runs after all logic systems (transform, bounds, wind),
 * producing variant groups consumed by render passes.
 *
 * This system does NOT issue draw calls — it prepares data structures
 * that render passes consume. The actual rendering is still done by
 * ObjectRendererGPU and the existing pass infrastructure.
 *
 * Per-frame output: `variantGroups` array, accessible via getVariantGroups().
 */
export class MeshRenderSystem extends System {
  readonly name = 'mesh-render';
  // Query all entities with transforms — handles both mesh and primitive-geometry GPU uploads
  readonly requiredComponents: readonly ComponentType[] = ['transform'];
  priority = 100;

  /** Per-frame variant groups — consumed by render passes */
  private _variantGroups: ShaderVariantGroup[] = [];

  /**
   * Whether IBL is active in the current scene environment.
   * Set externally by the pipeline before world.update().
   */
  iblActive: boolean = false;

  /**
   * Whether shadows are active in the current scene environment.
   * Set externally by the pipeline before world.update().
   */
  shadowsActive: boolean = true;

  update(entities: Entity[], _deltaTime: number, _context: SystemContext): void {
    const groupMap = new Map<string, ShaderVariantGroup>();

    for (const entity of entities) {
      // Upload GPU transforms for entities whose transform was updated this frame
      const transform = entity.getComponent<TransformComponent>('transform');
      if (transform?._updatedThisFrame) {
        const meshComp = entity.getComponent<MeshComponent>('mesh');
        if (meshComp?.isGPUInitialized) {
          meshComp.updateGPUTransform(transform.modelMatrix);
        }
        
        const primComp = entity.getComponent<PrimitiveGeometryComponent>('primitive-geometry');
        if (primComp?.isGPUInitialized && primComp.gpuContext) {
          const meshId = primComp.gpuMeshId;
          if (meshId >= 0) {
            primComp.gpuContext.objectRenderer.setTransform(meshId, transform.modelMatrix);
          }
        }
        
        transform._updatedThisFrame = false;
      }
      // Skip invisible entities
      const visibility = entity.getComponent<VisibilityComponent>('visibility');
      if (visibility && !visibility.visible) continue;

      // Determine feature set from entity's components + environment state
      const featureIds = this.determineFeatures(entity);

      // Build key
      const featureKey = [...featureIds].sort().join('+');

      // Group by key
      let group = groupMap.get(featureKey);
      if (!group) {
        group = { featureKey, featureIds, entities: [] };
        groupMap.set(featureKey, group);
      }
      group.entities.push(entity);
    }

    this._variantGroups = Array.from(groupMap.values());

    // Upload feature uniforms to GPU for entities that need them
    this.uploadFeatureUniforms(entities, _context);
  }

  /**
   * Upload per-entity feature uniform data (wetness, wind) to GPU material buffers.
   * This runs after variant grouping but before the render pass reads the buffers.
   */
  private uploadFeatureUniforms(entities: Entity[], context: SystemContext): void {
    const objectRenderer = context.ctx.objectRenderer;
    // Reusable buffer for wetness params (vec4f = 4 floats)
    const wetnessData = new Float32Array(4);

    for (const entity of entities) {
      const wetness = entity.getComponent<WetnessComponent>('wetness');
      if (!wetness || !wetness.enabled || wetness.wetnessFactor <= 0) continue;

      // Compute byte offset: wetness comes after wind if wind is present
      const hasWind = entity.getComponent<WindComponent>('wind')?.enabled ?? false;
      const wetnessOffset = FEATURE_UNIFORM_BASE + (hasWind ? WIND_UNIFORM_SIZE : 0);

      // Pack wetnessParams: x=waterLineY, y=wetnessFactor, z=debug, w=0
      wetnessData[0] = wetness.waterLineY;
      wetnessData[1] = wetness.wetnessFactor;
      wetnessData[2] = wetness.debug ? 1.0 : 0.0;
      wetnessData[3] = 0;

      // Write to all mesh IDs owned by this entity
      const meshComp = entity.getComponent<MeshComponent>('mesh');
      if (meshComp?.isGPUInitialized) {
        for (const gpuMeshId of meshComp.gpuMeshIds) {
          objectRenderer.writeExtraUniforms(gpuMeshId, wetnessData, wetnessOffset);
        }
      }

      const primComp = entity.getComponent<PrimitiveGeometryComponent>('primitive-geometry');
      if (primComp?.isGPUInitialized && primComp.gpuMeshId >= 0) {
        objectRenderer.writeExtraUniforms(primComp.gpuMeshId, wetnessData, wetnessOffset);
      }
    }
  }

  /**
   * Determine which shader features are active for this entity.
   */
  private determineFeatures(entity: Entity): string[] {
    const features: string[] = [];

    // Shadow feature (if environment has shadows enabled)
    if (this.shadowsActive) {
      const shadow = entity.getComponent<ShadowComponent>('shadow');
      // Include shadow feature if entity receives shadows (or has no shadow component = default receive)
      if (!shadow || shadow.receivesShadow) {
        features.push('shadow');
      }
    }

    // IBL feature (if environment has IBL active)
    if (this.iblActive) {
      features.push('ibl');
    }

    // Textured feature (if entity has textures via material texture flags)
    const material = entity.getComponent<MaterialComponent>('material');
    if (material) {
      const hasAnyTexture =
        material.textureFlags[0] > 0 ||
        material.textureFlags[1] > 0 ||
        material.textureFlags[2] > 0 ||
        material.textureFlags[3] > 0;
      if (hasAnyTexture) {
        features.push('textured');
      }
    }

    // Wind feature (if entity has WindComponent)
    const wind = entity.getComponent<WindComponent>('wind');
    if (wind && wind.enabled) {
      features.push('wind');
    }

    // Wetness feature (if entity has WetnessComponent with active wetness)
    const wetness = entity.getComponent<WetnessComponent>('wetness');
    if (wetness && wetness.enabled && wetness.wetnessFactor > 0) {
      features.push('wetness');
    }

    return features;
  }

  /**
   * Get the variant groups computed this frame.
   * Consumed by render passes to issue draw calls per variant.
   */
  getVariantGroups(): readonly ShaderVariantGroup[] {
    return this._variantGroups;
  }
}