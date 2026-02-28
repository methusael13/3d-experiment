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
 */

import type { mat4 } from 'gl-matrix';
import type { GPUContext } from '../GPUContext';
import { VariantPipelineManager } from './VariantPipelineManager';
import type { VariantPipelineEntry, DepthOnlyPipelineEntry } from './VariantPipelineManager';
import type { ObjectRendererGPU, ObjectRenderParams, MeshRenderData } from '../renderers/ObjectRendererGPU';
import type { MeshRenderSystem, ShaderVariantGroup } from '../../ecs/systems/MeshRenderSystem';
import type { SceneEnvironment } from '../renderers/shared/SceneEnvironment';
import { MeshComponent } from '../../ecs/components/MeshComponent';
import { PrimitiveGeometryComponent } from '../../ecs/components/PrimitiveGeometryComponent';
import { ShadowComponent } from '../../ecs/components/ShadowComponent';
import { ReflectionProbeComponent } from '../../ecs/components/ReflectionProbeComponent';
import type { Entity } from '../../ecs/Entity';

export class VariantRenderer {
  private variantManager: VariantPipelineManager | null = null;
  private objectRenderer: ObjectRendererGPU;

  constructor(objectRenderer: ObjectRendererGPU) {
    this.objectRenderer = objectRenderer;
  }

  private ensureVariantManager(ctx: GPUContext): VariantPipelineManager {
    if (!this.variantManager) {
      this.variantManager = new VariantPipelineManager(
        ctx,
        this.objectRenderer.getGlobalBindGroupLayout(),
        this.objectRenderer.getModelBindGroupLayout(),
        this.objectRenderer.getTextureBindGroupLayout(),
      );
    }
    return this.variantManager;
  }

  // ===================== Color Rendering =====================

  /**
   * Render all variant groups with full color (fragment) pipelines.
   * Used by OpaquePass for the main scene rendering.
   */
  /**
   * Render all variant groups with full color (fragment) pipelines.
   * Used by OpaquePass for the main scene rendering.
   * 
   * @param excludeEntitySet - Optional set of entity IDs to skip (for probe self-exclusion)
   */
  renderColor(
    pass: GPURenderPassEncoder,
    ctx: GPUContext,
    meshRenderSystem: MeshRenderSystem,
    sceneEnvironment: SceneEnvironment,
    renderParams: ObjectRenderParams,
    excludeEntitySet?: Set<string>,
  ): number {
    const variantManager = this.ensureVariantManager(ctx);
    this.objectRenderer.writeGlobalUniforms(renderParams);

    const variantGroups = meshRenderSystem.getVariantGroups();
    let drawCalls = 0;

    for (const group of variantGroups) {
      const featureIds = this.ensureTexturedFeature(group.featureIds);

      let pipelineBack: VariantPipelineEntry | null = null;
      let pipelineNone: VariantPipelineEntry | null = null;
      let envBindGroupBack: GPUBindGroup | null = null;
      let envBindGroupNone: GPUBindGroup | null = null;
      let currentPipeline: GPURenderPipeline | null = null;

      // Check if this variant group uses reflection probes (per-entity cubemap)
      const hasReflectionProbe = featureIds.includes('reflection-probe');

      for (const entity of group.entities) {
        if (excludeEntitySet?.has(entity.id)) {
          continue;
        }

        const meshIds = this.collectMeshIds(entity);
        if (meshIds.length === 0) continue;

        // Per-entity probe swap: if this group uses reflection probes,
        // update SceneEnvironment with this entity's specific cubemap
        // so the environment bind group includes the correct probe.
        let entityEnvDirty = false;
        if (hasReflectionProbe) {
          const probe = entity.getComponent<ReflectionProbeComponent>('reflection-probe');
          if (probe?.isBaked && probe.cubemapView && probe.cubemapSampler) {
            sceneEnvironment.setReflectionProbe(probe.cubemapView, probe.cubemapSampler);
            entityEnvDirty = true;
            // Invalidate cached env bind groups so they're rebuilt with this entity's probe
            envBindGroupBack = null;
            envBindGroupNone = null;
          }
        }

        for (const meshId of meshIds) {
          const meshData = this.objectRenderer.getMeshRenderData(meshId);
          if (!meshData) continue;

          const cullMode: GPUCullMode = meshData.doubleSided ? 'none' : 'back';
          let entry: VariantPipelineEntry;
          let envBindGroup: GPUBindGroup;

          if (cullMode === 'none') {
            if (!pipelineNone) {
              pipelineNone = variantManager.getOrCreate(featureIds, 'none', sceneEnvironment);
            }
            if (!envBindGroupNone) {
              envBindGroupNone = pipelineNone.hasEnvironmentBindings
                ? sceneEnvironment.getBindGroupForMask(pipelineNone.environmentMask)
                : this.objectRenderer.getEmptyBindGroup().bindGroup;
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
                : this.objectRenderer.getEmptyBindGroup().bindGroup;
            }
            entry = pipelineBack;
            envBindGroup = envBindGroupBack;
          }

          if (currentPipeline !== entry.pipeline) {
            pass.setPipeline(entry.pipeline);
            pass.setBindGroup(0, this.objectRenderer.getGlobalBindGroup());
            currentPipeline = entry.pipeline;
          }

          // Always set Group 3 when env is dirty (per-entity probe swap)
          // or when pipeline just changed
          pass.setBindGroup(3, envBindGroup);

          pass.setBindGroup(1, meshData.modelBindGroup);

          if (entry.hasTextureBindings) {
            if (meshData.hasTextures && meshData.textureBindGroup) {
              pass.setBindGroup(2, meshData.textureBindGroup);
            } else {
              pass.setBindGroup(2, meshData.placeholderTextureBindGroup);
            }
          } else {
            pass.setBindGroup(2, this.objectRenderer.getEmptyBindGroup().bindGroup);
          }

          pass.setVertexBuffer(0, meshData.vertexBuffer);
          if (meshData.indexBuffer) {
            pass.setIndexBuffer(meshData.indexBuffer, meshData.indexFormat);
            pass.drawIndexed(meshData.indexCount, 1, 0, 0, 0);
          } else {
            pass.draw(meshData.vertexCount, 1, 0, 0);
          }
          drawCalls++;
        }
      }
    }

    return drawCalls;
  }

  // ===================== Depth-Only Rendering =====================

  /**
   * Render all variant groups with depth-only pipelines (no fragment stage).
   * Used by ShadowPass for shadow map rendering.
   *
   * Temporarily writes the light VP matrix to the global uniform buffer,
   * then restores the original camera VP after rendering.
   */
  renderDepthOnly(
    passEncoder: GPURenderPassEncoder,
    ctx: GPUContext,
    meshRenderSystem: MeshRenderSystem,
    lightSpaceMatrix: mat4 | Float32Array,
    viewProjectionMatrix: mat4 | Float32Array,
    cameraPosition: [number, number, number],
  ): number {
    const variantManager = this.ensureVariantManager(ctx);
    const variantGroups = meshRenderSystem.getVariantGroups();

    // Write light VP matrix so composed vs_main transforms into light clip space
    this.objectRenderer.writeGlobalUniforms({
      viewProjectionMatrix: lightSpaceMatrix,
      cameraPosition: [0, 0, 0],
    });

    const emptyBG = this.objectRenderer.getEmptyBindGroup().bindGroup;
    let drawCalls = 0;

    for (const group of variantGroups) {
      // Strip fragment-only features for depth-only rendering (no Group 3 env bindings)
      const featureIds = this.buildDepthOnlyFeatures(group.featureIds);
      const depthEntry = variantManager.getOrCreateDepthOnly(featureIds, 'depth32float', 'less');

      passEncoder.setPipeline(depthEntry.pipeline);
      passEncoder.setBindGroup(0, this.objectRenderer.getGlobalBindGroup());
      passEncoder.setBindGroup(3, emptyBG);

      for (const entity of group.entities) {
        // Respect ECS ShadowComponent caster flag
        const shadow = entity.getComponent<ShadowComponent>('shadow');
        if (shadow && !shadow.castsShadow) continue;

        const meshIds = this.collectMeshIds(entity);
        for (const meshId of meshIds) {
          const meshData = this.objectRenderer.getMeshRenderData(meshId);
          if (!meshData) continue;

          passEncoder.setBindGroup(1, meshData.modelBindGroup);
          passEncoder.setBindGroup(2, meshData.placeholderTextureBindGroup);
          passEncoder.setVertexBuffer(0, meshData.vertexBuffer);

          if (meshData.indexBuffer) {
            passEncoder.setIndexBuffer(meshData.indexBuffer, meshData.indexFormat);
            passEncoder.drawIndexed(meshData.indexCount, 1, 0, 0, 0);
          } else {
            passEncoder.draw(meshData.vertexCount, 1, 0, 0);
          }
          drawCalls++;
        }
      }
    }

    // Restore original camera VP matrix
    this.objectRenderer.writeGlobalUniforms({
      viewProjectionMatrix,
      cameraPosition,
    });

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
    this.objectRenderer.writeGlobalUniforms({
      viewProjectionMatrix: lightSpaceMatrix,
      cameraPosition: [0, 0, 0],
    });

    const emptyBG = this.objectRenderer.getEmptyBindGroup().bindGroup;
    let drawCalls = 0;

    for (const group of windGroups) {
      const featureIds = this.buildDepthOnlyFeatures(group.featureIds);
      const depthEntry = variantManager.getOrCreateDepthOnly(featureIds, 'depth32float', 'less');

      passEncoder.setPipeline(depthEntry.pipeline);
      passEncoder.setBindGroup(0, this.objectRenderer.getGlobalBindGroup());
      passEncoder.setBindGroup(3, emptyBG);

      for (const entity of group.entities) {
        const shadow = entity.getComponent<ShadowComponent>('shadow');
        if (shadow && !shadow.castsShadow) continue;

        const meshIds = this.collectMeshIds(entity);
        for (const meshId of meshIds) {
          const meshData = this.objectRenderer.getMeshRenderData(meshId);
          if (!meshData) continue;

          passEncoder.setBindGroup(1, meshData.modelBindGroup);
          passEncoder.setBindGroup(2, meshData.placeholderTextureBindGroup);
          passEncoder.setVertexBuffer(0, meshData.vertexBuffer);

          if (meshData.indexBuffer) {
            passEncoder.setIndexBuffer(meshData.indexBuffer, meshData.indexFormat);
            passEncoder.drawIndexed(meshData.indexCount, 1, 0, 0, 0);
          } else {
            passEncoder.draw(meshData.vertexCount, 1, 0, 0);
          }
          drawCalls++;
        }
      }
    }

    return drawCalls;
  }

  // ===================== Utilities =====================

  /**
   * Ensure 'textured' is in feature list for bind group layout compatibility.
   */
  private ensureTexturedFeature(featureIds: string[]): string[] {
    return featureIds.includes('textured') ? featureIds : [...featureIds, 'textured'];
  }

  /** Fragment-only features that should be excluded from depth-only pipelines. */
  private static readonly FRAGMENT_ONLY_FEATURES = new Set(['shadow', 'ibl', 'wetness']);

  /**
   * Build feature list for depth-only rendering.
   * Strips fragment-only features (shadow, ibl, wetness) that would declare
   * Group 3 environment bindings incompatible with the empty depth-only layout.
   * Keeps vertex-affecting features (wind, textured) for displacement + layout compatibility.
   */
  private buildDepthOnlyFeatures(featureIds: string[]): string[] {
    const ids = featureIds.filter(id => !VariantRenderer.FRAGMENT_ONLY_FEATURES.has(id));
    return this.ensureTexturedFeature(ids);
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