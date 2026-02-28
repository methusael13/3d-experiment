import { System } from '../System';
import type { Entity } from '../Entity';
import type { ComponentType, SystemContext } from '../types';
import { TransformComponent } from '../components/TransformComponent';
import { MeshComponent } from '../components/MeshComponent';
import { PrimitiveGeometryComponent } from '../components/PrimitiveGeometryComponent';
import { MaterialComponent } from '../components/MaterialComponent';
import { WindComponent, WindDebugMode } from '../components/WindComponent';
import { WetnessComponent } from '../components/WetnessComponent';
import { ShadowComponent } from '../components/ShadowComponent';
import { VisibilityComponent } from '../components/VisibilityComponent';
import { WindSystem } from './WindSystem';
import { SSRComponent } from '../components';
import { ReflectionProbeComponent } from '../components/ReflectionProbeComponent';
import { GPUContext } from '@/core/gpu';

/**
 * Byte offset for feature uniforms in the MaterialUniforms buffer.
 * Base MaterialUniforms = 80 bytes (20 floats).
 * EXTRA_UNIFORM_FIELDS start at byte 80.
 *
 * Layout: wind fields (8 × f32 = 32 bytes) then wetness (vec4f = 16 bytes).
 * Wind: displacementX, displacementZ, anchorHeight, stiffness, time, turbulence, debugMode, debugMaterialType
 * When wind is not present, wetness starts at byte 96.
 */
const FEATURE_UNIFORM_BASE = 96; // After base MaterialUniforms (6 × vec4f = 96 bytes)
const WIND_UNIFORM_SIZE = 32;    // 8 × f32 (6 base + 2 debug)

/** Byte offset of wind debug fields within the wind uniform block */
const WIND_DEBUG_OFFSET = FEATURE_UNIFORM_BASE + 24; // After the 6 base wind f32s

/** Map WindDebugMode string to shader float value */
const WIND_DEBUG_MODE_MAP: Record<WindDebugMode, number> = {
  'off': 0,
  'wind-type': 1,
  'height-factor': 2,
  'displacement': 3,
};

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
            primComp.gpuContext.setMeshTransform(meshId, transform.modelMatrix);
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
   * Upload per-entity feature uniform data to GPU material buffers.
   * Delegates to per-feature upload methods. Runs after variant grouping
   * but before the render pass reads the buffers.
   */
  private uploadFeatureUniforms(entities: Entity[], context: SystemContext): void {
    // Write feature uniforms to both pools via GPUContext facade.
    const ctx = context.ctx;
    for (const entity of entities) {
      this.uploadWindUniforms(entity, ctx);
      this.uploadWetnessUniforms(entity, ctx);
    }
  }

  /** Reusable buffer for all wind uniforms (8 floats: 6 base + 2 debug) */
  private _windBuf = new Float32Array(8);

  /**
   * Reference to the WindSystem for reading global wind time/turbulence.
   * Set externally by the Viewport (same pattern as iblActive/shadowsActive).
   * WindSystem runs at priority 50, before MeshRenderSystem at 100.
   */
  windSystem: WindSystem | null = null;

  /**
   * Upload all wind uniforms for a single entity.
   * Writes 8 floats at FEATURE_UNIFORM_BASE (offset 80):
   *   [displacementX, displacementZ, anchorHeight, stiffness, time, turbulence, debugMode, debugMaterialType]
   *
   * Per-submesh: debugMaterialType varies by material slot (leaf/branch/untagged).
   * All other fields are shared across submeshes.
   */
  private uploadWindUniforms(entity: Entity, objectRenderer: { writeMeshExtraUniforms(id: number, data: Float32Array, offset: number): void }): void {
    const wind = entity.getComponent<WindComponent>('wind');
    if (!wind || !wind.enabled) return;

    const debugModeValue = WIND_DEBUG_MODE_MAP[wind.debugMode] ?? 0;
    const buf = this._windBuf;

    // Read global wind params from WindSystem (runs at priority 50, before us at 100)
    const windMgr = this.windSystem?.getWindManager();
    const windTime = windMgr?.time ?? 0;
    const windTurbulence = windMgr?.turbulence ?? 0.5;

    // Base wind fields (same for all submeshes)
    buf[0] = wind.displacement[0]; // windDisplacementX
    buf[1] = wind.displacement[1]; // windDisplacementZ
    buf[2] = wind.anchorHeight;    // windAnchorHeight (0-1 normalized)
    buf[3] = wind.stiffness;       // windStiffness
    buf[4] = windTime;             // windTime
    buf[5] = windTurbulence;       // windTurbulence
    buf[6] = debugModeValue;       // windDebugMode

    const meshComp = entity.getComponent<MeshComponent>('mesh');
    if (meshComp?.isGPUInitialized) {
      const gpuMeshIds = meshComp.gpuMeshIds;
      for (let i = 0; i < gpuMeshIds.length; i++) {
        // Per-submesh: material type
        let materialType = 0;
        if (wind.leafMaterialIndices.has(i)) {
          materialType = 1;
        } else if (wind.branchMaterialIndices.has(i)) {
          materialType = 2;
        }
        buf[7] = materialType; // windDebugMaterialType
        objectRenderer.writeMeshExtraUniforms(gpuMeshIds[i], buf, FEATURE_UNIFORM_BASE);
      }
    }

    const primComp = entity.getComponent<PrimitiveGeometryComponent>('primitive-geometry');
    if (primComp?.isGPUInitialized && primComp.gpuMeshId >= 0) {
      buf[7] = 0; // primitives are untagged
      objectRenderer.writeMeshExtraUniforms(primComp.gpuMeshId, buf, FEATURE_UNIFORM_BASE);
    }
  }

  /** Reusable buffer for wetness params (vec4f = 4 floats) */
  private _wetnessBuf = new Float32Array(4);

  /**
   * Upload wetness uniforms (waterLineY, factor, debug flag) for a single entity.
   * Byte offset depends on whether wind is also active (wetness sits after wind block).
   */
  private uploadWetnessUniforms(entity: Entity, objectRenderer: GPUContext): void {
    const wetness = entity.getComponent<WetnessComponent>('wetness');
    if (!wetness || !wetness.enabled || wetness.wetnessFactor <= 0) return;

    const hasWind = entity.getComponent<WindComponent>('wind')?.enabled ?? false;
    const wetnessOffset = FEATURE_UNIFORM_BASE + (hasWind ? WIND_UNIFORM_SIZE : 0);

    const buf = this._wetnessBuf;
    buf[0] = wetness.waterLineY;
    buf[1] = wetness.wetnessFactor;
    buf[2] = wetness.debug ? 1.0 : 0.0;
    buf[3] = 0;

    const meshComp = entity.getComponent<MeshComponent>('mesh');
    if (meshComp?.isGPUInitialized) {
      for (const gpuMeshId of meshComp.gpuMeshIds) {
        objectRenderer.writeMeshExtraUniforms(gpuMeshId, buf, wetnessOffset);
      }
    }

    const primComp = entity.getComponent<PrimitiveGeometryComponent>('primitive-geometry');
    if (primComp?.isGPUInitialized && primComp.gpuMeshId >= 0) {
      objectRenderer.writeMeshExtraUniforms(primComp.gpuMeshId, buf, wetnessOffset);
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
      if (material.hasIntrinsicTextures) {
        features.push('textured');
      } else {
        const hasAnyTexture =
          material.textureFlags[0] > 0 ||
          material.textureFlags[1] > 0 ||
          material.textureFlags[2] > 0 ||
          material.textureFlags[3] > 0;
        if (hasAnyTexture) {
          features.push('textured');
        }
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

    // Reflection probe takes priority over SSR — probe cubemap + IBL fallback is sufficient
    const probeComp = entity.getComponent<ReflectionProbeComponent>('reflection-probe');
    if (probeComp?.enabled && probeComp.isBaked) {
      features.push('reflection-probe');
    } else {
      // SSR feature for opaque metallic objects — adds SSR texture sampling from environment group
      const ssrComp = entity.getComponent<SSRComponent>('ssr');
      if (ssrComp?.enabled) {
        features.push('ssr');
      }
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