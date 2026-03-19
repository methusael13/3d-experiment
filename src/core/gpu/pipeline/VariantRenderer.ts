/**
 * VariantRenderer — shared rendering logic for composed shader variant draw calls.
 *
 * Used by both OpaquePass (color rendering) and ShadowPass (depth-only rendering).
 * Owns the VariantPipelineManager and provides two render modes:
 * - renderColor: full fragment pipeline (PBR + lighting + debug)
 * - renderDepthOnly: vertex-only pipeline (shadows, depth pre-pass)
 *
 * Both modes iterate MeshRenderSystem variant groups and respect ECS components
 * (ShadowComponent for caster filtering, MeshComponent/PrimitiveGeometryComponent
 * for GPU mesh IDs).
 *
 * Since Phase 3 of the VariantMeshPool migration, this class reads mesh data
 * from VariantMeshPool instead of ObjectRendererGPU. All bind groups (including
 * Group 2 textures) are built dynamically from composed shader metadata via
 * meshPool.buildTextureBindGroup() — no special cases for probe, SSR, etc.
 */

import type { mat4 } from 'gl-matrix';
import type { GPUContext } from '../GPUContext';
import { VariantPipelineManager } from './VariantPipelineManager';
import type { VariantPipelineEntry, DepthOnlyPipelineEntry } from './VariantPipelineManager';
import type { VariantMeshPool } from './VariantMeshPool';
import type { ObjectRenderParams } from '../renderers/ObjectRendererGPU';
import type { MeshRenderSystem, ShaderVariantGroup } from '../../ecs/systems/MeshRenderSystem';
import type { SceneEnvironment } from '../renderers/shared/SceneEnvironment';
import { MeshComponent } from '../../ecs/components/MeshComponent';
import { PrimitiveGeometryComponent } from '../../ecs/components/PrimitiveGeometryComponent';
import { ShadowComponent } from '../../ecs/components/ShadowComponent';
import { TransformComponent } from '../../ecs/components/TransformComponent';
import { VegetationInstanceComponent } from '../../ecs/components/VegetationInstanceComponent';
import type { Entity } from '../../ecs/Entity';

export class VariantRenderer {
  private variantManager: VariantPipelineManager | null = null;
  private meshPool: VariantMeshPool;

  constructor(meshPool: VariantMeshPool) {
    this.meshPool = meshPool;
  }

  private ensureVariantManager(ctx: GPUContext): VariantPipelineManager {
    if (!this.variantManager) {
      this.variantManager = new VariantPipelineManager(
        ctx,
        this.meshPool.getGlobalBindGroupLayout(),
        this.meshPool.getModelBindGroupLayout(),
        this.meshPool,
      );
    }
    return this.variantManager;
  }

  // ===================== Color Rendering =====================

  /**
   * Render all variant groups with full color (fragment) pipelines.
   * Used by OpaquePass for the main scene rendering.
   * 
   * @param excludeEntitySet - Optional set of entity IDs to skip (for probe self-exclusion)
   * @param visibleEntitySet - Optional set of entity IDs that passed frustum culling.
   *                           When provided, entities NOT in this set are skipped.
   *                           When null/undefined, all entities are rendered (no frustum culling).
   */
  renderColor(
    pass: GPURenderPassEncoder,
    ctx: GPUContext,
    meshRenderSystem: MeshRenderSystem,
    sceneEnvironment: SceneEnvironment,
    renderParams: ObjectRenderParams,
    excludeEntitySet?: Set<string>,
    visibleEntitySet?: Set<string> | null,
  ): number {
    const variantManager = this.ensureVariantManager(ctx);
    this.meshPool.writeGlobalUniforms(renderParams);

    const variantGroups = meshRenderSystem.getVariantGroups();
    let drawCalls = 0;

    for (const group of variantGroups) {
      const featureIds = group.featureIds;

      let pipelineBack: VariantPipelineEntry | null = null;
      let pipelineNone: VariantPipelineEntry | null = null;
      let envBindGroupBack: GPUBindGroup | null = null;
      let envBindGroupNone: GPUBindGroup | null = null;
      let currentPipeline: GPURenderPipeline | null = null;

      // Check if this variant group contains vegetation-instancing entities.
      // Vegetation entities bypass CPU frustum culling because:
      // 1. Their transform is identity (0,0,0) — not their real world position
      // 2. The VegetationCullingPipeline already does GPU frustum + distance culling
      // 3. The drawIndexedIndirect instance count will be 0 for fully-culled groups
      const isVegetationGroup = featureIds.includes('vegetation-instancing');

      for (const entity of group.entities) {
        if (excludeEntitySet?.has(entity.id)) {
          continue;
        }
        // Frustum culling: skip entities not in the visible set
        // (vegetation entities bypass this — GPU culling handles them)
        if (visibleEntitySet && !isVegetationGroup && !visibleEntitySet.has(entity.id)) {
          continue;
        }

        const meshIds = this.collectMeshIds(entity);
        if (meshIds.length === 0) continue;

        for (const meshId of meshIds) {
          const drawParams = this.meshPool.getDrawParams(meshId);
          const modelBG = this.meshPool.getModelBindGroup(meshId);
          if (!drawParams || !modelBG) continue;

          const doubleSided = this.meshPool.isDoubleSided(meshId);
          const cullMode: GPUCullMode = doubleSided ? 'none' : 'back';
          let entry: VariantPipelineEntry;
          let envBindGroup: GPUBindGroup;

          if (cullMode === 'none') {
            if (!pipelineNone) {
              pipelineNone = variantManager.getOrCreate(featureIds, 'none', sceneEnvironment);
            }
            if (!envBindGroupNone) {
              envBindGroupNone = pipelineNone.hasEnvironmentBindings
                ? sceneEnvironment.getBindGroupForMask(pipelineNone.environmentMask)
                : this.meshPool.getEmptyBindGroup().bindGroup;
            }
            entry = pipelineNone;
            envBindGroup = envBindGroupNone;
          } else {
            if (!pipelineBack) {
              pipelineBack = variantManager.getOrCreate(featureIds, 'back', sceneEnvironment);
            }
            if (!envBindGroupBack) {
              envBindGroupBack = pipelineBack.hasEnvironmentBindings
                ? sceneEnvironment.getBindGroupForMask(pipelineBack.environmentMask)
                : this.meshPool.getEmptyBindGroup().bindGroup;
            }
            entry = pipelineBack;
            envBindGroup = envBindGroupBack;
          }

          if (currentPipeline !== entry.pipeline) {
            pass.setPipeline(entry.pipeline);
            pass.setBindGroup(0, this.meshPool.getGlobalBindGroup());
            currentPipeline = entry.pipeline;
          }

          pass.setBindGroup(3, envBindGroup);
          pass.setBindGroup(1, modelBG);

          // Build Group 2 bind group dynamically from composed shader metadata.
          // All texture resources (PBR, probe, SSR) are looked up by canonical name —
          // no special cases needed.
          if (entry.hasTextureBindings) {
            const texBG = this.meshPool.buildTextureBindGroup(
              meshId, entry.composed, entry.textureBindGroupLayout,
            );
            pass.setBindGroup(2, texBG);
          } else {
            pass.setBindGroup(2, this.meshPool.getEmptyBindGroup().bindGroup);
          }

          pass.setVertexBuffer(0, drawParams.vertexBuffer);

          // Vegetation instancing: use drawIndexedIndirect with GPU-driven instance count
          const vegComp = entity.getComponent<VegetationInstanceComponent>('vegetation-instance');
          if (vegComp?.active && vegComp.drawArgsBuffer && drawParams.indexBuffer) {
            pass.setIndexBuffer(drawParams.indexBuffer, drawParams.indexFormat);
            pass.drawIndexedIndirect(vegComp.drawArgsBuffer, vegComp.drawArgsOffset);
          } else if (drawParams.indexBuffer) {
            pass.setIndexBuffer(drawParams.indexBuffer, drawParams.indexFormat);
            pass.drawIndexed(drawParams.indexCount, 1, 0, 0, 0);
          } else {
            pass.draw(drawParams.vertexCount, 1, 0, 0);
          }
          drawCalls++;
        }
      }
    }

    return drawCalls;
  }

  // ===================== Depth-Only Rendering =====================

  /**
   * Render vegetation-instancing variant groups with depth-only pipelines (no fragment stage).
   * Used by ShadowPass for shadow map rendering of vegetation instances.
   *
   * Uses a pre-written per-cascade shadow bind group at Group 0 instead of
   * overwriting the shared global uniform buffer. This avoids the WebGPU
   * queue.writeBuffer batching issue where later writes would clobber earlier
   * ones (all writeBuffer calls resolve before any render pass executes).
   *
   * Only processes variant groups containing the 'vegetation-instancing' feature.
   * Non-vegetation, non-skinned meshes are handled by ObjectRendererGPU.renderShadowPass().
   *
   * @param cascadeIdx Cascade index (used to select the pre-written shadow bind group)
   */
  renderDepthOnly(
    passEncoder: GPURenderPassEncoder,
    ctx: GPUContext,
    meshRenderSystem: MeshRenderSystem,
    cascadeIdx: number,
    cameraPosition: [number, number, number],
  ): number {
    const variantManager = this.ensureVariantManager(ctx);
    const variantGroups = meshRenderSystem.getVariantGroups();

    // Use the pre-written per-cascade shadow bind group at Group 0.
    // This was populated by meshPool.prepareShadowCascades() before the CSM loop.
    const shadowBindGroup = this.meshPool.getShadowGlobalBindGroup(cascadeIdx);

    const emptyBG = this.meshPool.getEmptyBindGroup().bindGroup;
    let drawCalls = 0;

    for (const group of variantGroups) {
      // Skip skinned groups — they're handled by renderSkinnedDepthOnly() which
      // needs the separate skin vertex buffer binding at slot 1.
      if (group.featureIds.includes('skinning')) continue;

      // Strip fragment-only features for depth-only rendering (no Group 3 env bindings)
      const featureIds = this.buildDepthOnlyFeatures(group.featureIds);
      const depthEntry = variantManager.getOrCreateDepthOnly(featureIds, 'depth32float', 'less');

      passEncoder.setPipeline(depthEntry.pipeline);
      passEncoder.setBindGroup(0, shadowBindGroup);
      passEncoder.setBindGroup(3, emptyBG);

      for (const entity of group.entities) {
        // Respect ECS ShadowComponent caster flag
        const shadow = entity.getComponent<ShadowComponent>('shadow');
        if (shadow && !shadow.castsShadow) continue;

        const meshIds = this.collectMeshIds(entity);
        for (const meshId of meshIds) {
          const drawParams = this.meshPool.getDrawParams(meshId);
          const modelBG = this.meshPool.getModelBindGroup(meshId);
          if (!drawParams || !modelBG) continue;

          passEncoder.setBindGroup(1, modelBG);

          // For depth-only, build texture bind group with placeholders
          // (the WGSL declares Group 2 bindings even though fragment is absent)
          if (depthEntry.composed.bindingLayout.size > 0) {
            const texBG = this.meshPool.buildTextureBindGroup(
              meshId, depthEntry.composed, this.getDepthTextureLayout(ctx, variantManager, featureIds),
            );
            passEncoder.setBindGroup(2, texBG);
          } else {
            passEncoder.setBindGroup(2, emptyBG);
          }

          passEncoder.setVertexBuffer(0, drawParams.vertexBuffer);

          // Vegetation instancing: use drawIndexedIndirect for shadow depth.
          // Prefer shadow-specific buffers (culled with shadowCastDistance) when available;
          // otherwise fall back to the color draw args (culled with maxDistance).
          const vegComp = entity.getComponent<VegetationInstanceComponent>('vegetation-instance');
          if (vegComp?.active && vegComp.drawArgsBuffer && drawParams.indexBuffer) {
            // Use shadow-specific draw args if a separate shadow cull pass produced them
            const shadowArgs = vegComp.shadowDrawArgsBuffer ?? vegComp.drawArgsBuffer;
            const shadowOffset = vegComp.shadowDrawArgsBuffer ? vegComp.shadowDrawArgsOffset : vegComp.drawArgsOffset;
            passEncoder.setIndexBuffer(drawParams.indexBuffer, drawParams.indexFormat);
            passEncoder.drawIndexedIndirect(shadowArgs, shadowOffset);
          } else if (drawParams.indexBuffer) {
            passEncoder.setIndexBuffer(drawParams.indexBuffer, drawParams.indexFormat);
            passEncoder.drawIndexed(drawParams.indexCount, 1, 0, 0, 0);
          } else {
            passEncoder.draw(drawParams.vertexCount, 1, 0, 0);
          }
          drawCalls++;
        }
      }
    }

    return drawCalls;
  }

  // ===================== Wind Mesh ID Collection =====================

  /**
   * Collect all GPU mesh IDs that belong to wind-affected entities.
   * Used by ShadowPass to exclude these from the legacy shadow path
   * (they're rendered via composed depth-only instead).
   */
  getWindMeshIds(meshRenderSystem: MeshRenderSystem): Set<number> {
    const ids = new Set<number>();
    for (const group of meshRenderSystem.getVariantGroups()) {
      if (!group.featureIds.includes('wind')) continue;
      for (const entity of group.entities) {
        for (const meshId of this.collectMeshIds(entity)) {
          ids.add(meshId);
        }
      }
    }
    return ids;
  }

  // ===================== Skinned Mesh ID Collection =====================

  /**
   * Collect all GPU mesh IDs that belong to skinned (skeletal animation) entities.
   * Used by ShadowPass to exclude these from the legacy shadow path
   * (they're rendered via composed depth-only with bone matrices instead).
   */
  getSkinnedMeshIds(meshRenderSystem: MeshRenderSystem): Set<number> {
    const ids = new Set<number>();
    for (const group of meshRenderSystem.getVariantGroups()) {
      if (!group.featureIds.includes('skinning')) continue;
      for (const entity of group.entities) {
        for (const meshId of this.collectMeshIds(entity)) {
          ids.add(meshId);
        }
      }
    }
    return ids;
  }

  // ===================== Wind-Only Depth Rendering =====================

  /**
   * Render only wind-affected entities with depth-only pipelines.
   * Used alongside the legacy shadow pass: the legacy path renders all entities
   * without wind displacement, then this overlays wind entities with correct
   * displaced vertex positions.
   *
   * Writes the light VP matrix to the global uniform buffer for the duration,
   * then restores it.
   */
  renderWindDepthOnly(
    passEncoder: GPURenderPassEncoder,
    ctx: GPUContext,
    meshRenderSystem: MeshRenderSystem,
    lightSpaceMatrix: mat4 | Float32Array,
  ): number {
    const variantManager = this.ensureVariantManager(ctx);
    const variantGroups = meshRenderSystem.getVariantGroups();

    // Only process groups that include wind feature
    const windGroups = variantGroups.filter(g => g.featureIds.includes('wind'));
    if (windGroups.length === 0) return 0;

    // Write light VP matrix so composed vs_main transforms into light clip space
    this.meshPool.writeGlobalUniforms({
      viewProjectionMatrix: lightSpaceMatrix,
      cameraPosition: [0, 0, 0],
    });

    const emptyBG = this.meshPool.getEmptyBindGroup().bindGroup;
    let drawCalls = 0;

    for (const group of windGroups) {
      const featureIds = this.buildDepthOnlyFeatures(group.featureIds);
      const depthEntry = variantManager.getOrCreateDepthOnly(featureIds, 'depth32float', 'less');

      passEncoder.setPipeline(depthEntry.pipeline);
      passEncoder.setBindGroup(0, this.meshPool.getGlobalBindGroup());
      passEncoder.setBindGroup(3, emptyBG);

      for (const entity of group.entities) {
        const shadow = entity.getComponent<ShadowComponent>('shadow');
        if (shadow && !shadow.castsShadow) continue;

        const meshIds = this.collectMeshIds(entity);
        for (const meshId of meshIds) {
          const drawParams = this.meshPool.getDrawParams(meshId);
          const modelBG = this.meshPool.getModelBindGroup(meshId);
          if (!drawParams || !modelBG) continue;

          passEncoder.setBindGroup(1, modelBG);

          // Build texture bind group for depth (with placeholders)
          if (depthEntry.composed.bindingLayout.size > 0) {
            const texBG = this.meshPool.buildTextureBindGroup(
              meshId, depthEntry.composed, this.getDepthTextureLayout(ctx, variantManager, featureIds),
            );
            passEncoder.setBindGroup(2, texBG);
          } else {
            passEncoder.setBindGroup(2, emptyBG);
          }

          passEncoder.setVertexBuffer(0, drawParams.vertexBuffer);

          if (drawParams.indexBuffer) {
            passEncoder.setIndexBuffer(drawParams.indexBuffer, drawParams.indexFormat);
            passEncoder.drawIndexed(drawParams.indexCount, 1, 0, 0, 0);
          } else {
            passEncoder.draw(drawParams.vertexCount, 1, 0, 0);
          }
          drawCalls++;
        }
      }
    }

    return drawCalls;
  }

  // ===================== Skinned-Only Depth Rendering =====================

  /**
   * Render only skinned (skeletal animation) entities with depth-only pipelines.
   * Used alongside the legacy shadow pass: the legacy path renders all non-skinned
   * entities, then this renders skinned entities with correct bone-transformed
   * vertex positions into the same shadow map.
   *
   * Key differences from wind depth rendering:
   * - Binds the skin vertex buffer at slot 1 (joint indices + weights)
   * - Group 2 bind group includes the boneMatrices storage buffer (not just placeholders)
   * - Uses the skinning-aware depth-only pipeline (2 vertex buffer descriptors)
   *
   * Uses a pre-written per-cascade shadow bind group at Group 0 instead of
   * overwriting the shared global uniform buffer (same fix as renderDepthOnly).
   *
   * @param cascadeIdx Cascade index (used to select the pre-written shadow bind group)
   */
  renderSkinnedDepthOnly(
    passEncoder: GPURenderPassEncoder,
    ctx: GPUContext,
    meshRenderSystem: MeshRenderSystem,
    cascadeIdx: number,
  ): number {
    const variantManager = this.ensureVariantManager(ctx);
    const variantGroups = meshRenderSystem.getVariantGroups();

    // Only process groups that include skinning feature
    const skinnedGroups = variantGroups.filter(g => g.featureIds.includes('skinning'));
    if (skinnedGroups.length === 0) return 0;

    // Use the pre-written per-cascade shadow bind group at Group 0.
    const shadowBindGroup = this.meshPool.getShadowGlobalBindGroup(cascadeIdx);

    const emptyBG = this.meshPool.getEmptyBindGroup().bindGroup;
    let drawCalls = 0;

    for (const group of skinnedGroups) {
      // Strip fragment-only features, keep 'skinning' (vertex-affecting)
      const featureIds = this.buildDepthOnlyFeatures(group.featureIds);
      const depthEntry = variantManager.getOrCreateDepthOnly(featureIds, 'depth32float', 'less');

      passEncoder.setPipeline(depthEntry.pipeline);
      passEncoder.setBindGroup(0, shadowBindGroup);
      passEncoder.setBindGroup(3, emptyBG);

      for (const entity of group.entities) {
        const shadow = entity.getComponent<ShadowComponent>('shadow');
        if (shadow && !shadow.castsShadow) continue;

        const meshIds = this.collectMeshIds(entity);
        for (const meshId of meshIds) {
          const drawParams = this.meshPool.getDrawParams(meshId);
          const modelBG = this.meshPool.getModelBindGroup(meshId);
          if (!drawParams || !modelBG) continue;

          passEncoder.setBindGroup(1, modelBG);

          // Build Group 2 bind group — includes boneMatrices storage buffer
          // (VariantMeshPool.buildTextureBindGroup looks up 'boneMatrices' by name
          // and binds the storage buffer alongside any PBR texture placeholders)
          if (depthEntry.composed.bindingLayout.size > 0) {
            const texBG = this.meshPool.buildTextureBindGroup(
              meshId, depthEntry.composed, this.getDepthTextureLayout(ctx, variantManager, featureIds),
            );
            passEncoder.setBindGroup(2, texBG);
          } else {
            passEncoder.setBindGroup(2, emptyBG);
          }

          // Bind vertex buffer slot 0: standard interleaved (position + normal + uv)
          passEncoder.setVertexBuffer(0, drawParams.vertexBuffer);

          // Bind vertex buffer slot 1: skinning data (joint indices + weights)
          // The depth-only pipeline for skinned variants has 2 buffer descriptors,
          // so slot 1 must be bound for the draw call to work.
          const skinBuffer = this.meshPool.getSkinBuffer(meshId);
          if (skinBuffer) {
            passEncoder.setVertexBuffer(1, skinBuffer);
          }

          if (drawParams.indexBuffer) {
            passEncoder.setIndexBuffer(drawParams.indexBuffer, drawParams.indexFormat);
            passEncoder.drawIndexed(drawParams.indexCount, 1, 0, 0, 0);
          } else {
            passEncoder.draw(drawParams.vertexCount, 1, 0, 0);
          }
          drawCalls++;
        }
      }
    }

    return drawCalls;
  }

  // ===================== Utilities =====================

  /** Fragment-only features that should be excluded from depth-only pipelines. */
  private static readonly FRAGMENT_ONLY_FEATURES = new Set(['shadow', 'ibl', 'wetness', 'reflection-probe']);

  /**
   * Build feature list for depth-only rendering.
   * Strips fragment-only features (shadow, ibl, wetness) that would declare
   * Group 3 environment bindings incompatible with the empty depth-only layout.
   * Keeps vertex-affecting features (wind, textured) for displacement + layout compatibility.
   */
  private buildDepthOnlyFeatures(featureIds: string[]): string[] {
    return featureIds.filter(id => !VariantRenderer.FRAGMENT_ONLY_FEATURES.has(id));
  }

  /**
   * Get the texture bind group layout for a depth-only pipeline variant.
   * This is needed because depth-only pipelines still declare Group 2 bindings in WGSL.
   */
  private getDepthTextureLayout(
    ctx: GPUContext,
    variantManager: VariantPipelineManager,
    featureIds: string[],
  ): GPUBindGroupLayout {
    // The depth-only pipeline was created with the existing texture layout from ObjectRendererGPU.
    // For VariantMeshPool, we get the layout from the depth entry's pipeline.
    // However, depth entries use existingTextureBindGroupLayout which is now from meshPool.
    // We can use the pipeline's bind group layout directly.
    const depthEntry = variantManager.getOrCreateDepthOnly(featureIds, 'depth32float', 'less');
    // The pipeline was created with the texture layout at group index 2
    return depthEntry.pipeline.getBindGroupLayout(2);
  }

  /**
   * Collect GPU mesh IDs from an entity via MeshComponent or PrimitiveGeometryComponent.
   */
  collectMeshIds(entity: Entity): number[] {
    const ids: number[] = [];
    const meshComp = entity.getComponent<MeshComponent>('mesh');
    if (meshComp?.isGPUInitialized) {
      for (const id of meshComp.meshIds) ids.push(id);
    }
    const primComp = entity.getComponent<PrimitiveGeometryComponent>('primitive-geometry');
    if (primComp?.isGPUInitialized && primComp.meshId !== null) {
      ids.push(primComp.meshId);
    }
    return ids;
  }

  /**
   * Invalidate cached pipelines (e.g., on shader hot-reload).
   */
  invalidate(): void {
    this.variantManager?.invalidateAll();
  }

  destroy(): void {
    this.variantManager?.destroy();
    this.variantManager = null;
  }
}