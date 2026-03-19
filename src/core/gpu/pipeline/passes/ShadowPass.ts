/**
 * ShadowPass — Renders directional CSM/single shadow maps and spot light shadow atlas.
 *
 * Handles:
 * - Single directional shadow map (non-CSM mode)
 * - Cascaded Shadow Maps (CSM) with 2–4 cascades
 * - Per-spot-light shadow atlas layers (perspective depth)
 * - Directional shadow matrix restoration after spot shadow rendering
 */

import { mat4 } from 'gl-matrix';
import { BaseRenderPass, PassPriority, type PassCategory } from '../RenderPass';
import type { RenderContext } from '../RenderContext';
import type { ObjectRendererGPU } from '../../renderers/ObjectRendererGPU';
import type { ShadowRendererGPU } from '../../renderers/ShadowRendererGPU';
import { LightComponent } from '../../../ecs/components/LightComponent';
import { TransformComponent } from '../../../ecs/components/TransformComponent';
import { TerrainComponent } from '../../../ecs/components/TerrainComponent';
import type { VariantMeshPool } from '../VariantMeshPool';
import { VariantRenderer } from '../VariantRenderer';
import type { MeshRenderSystem } from '../../../ecs/systems/MeshRenderSystem';
import type { Vec3 } from '../../../types';
import { Logger } from '@/core/utils/logger';
import { SPOT_SHADOW_SLOT_BASE } from '../../renderers/shared/constants';

// ============================================================================
// Types
// ============================================================================

export interface ShadowPassDependencies {
  shadowRenderer: ShadowRendererGPU;
  objectRenderer: ObjectRendererGPU;
  meshPool: VariantMeshPool;
}

// ============================================================================
// ShadowPass
// ============================================================================

/**
 * ShadowPass - Renders shadow map from light's perspective
 * Category: scene (shadow maps are used by scene passes)
 *
 * Supports both single shadow map and Cascaded Shadow Maps (CSM).
 * Uses actual mesh geometry via ShadowCaster interface. Scene objects that
 * implement ShadowCaster (terrain, etc.) render their own depth. Batched
 * objects (primitives) are handled separately via ObjectRendererGPU.
 */
export class ShadowPass extends BaseRenderPass {
  readonly name = 'shadow';
  readonly priority = PassPriority.SHADOW;
  readonly category: PassCategory = 'scene';

  private shadowRenderer: ShadowRendererGPU;
  private objectRenderer: ObjectRendererGPU;
  private meshPool: VariantMeshPool;

  /** Variant renderer for skinned shadow rendering (skeletal animation depth-only) */
  private variantRenderer: VariantRenderer | null = null;

  private _logger: Logger = Logger.createLogger('ShadowPass', 2000);
  /** Track whether we've wired the shadow renderer to the terrain component */
  private _terrainShadowWired = false;

  constructor(deps: ShadowPassDependencies) {
    super();
    this.shadowRenderer = deps.shadowRenderer;
    this.objectRenderer = deps.objectRenderer;
    this.meshPool = deps.meshPool;
  }

  private ensureVariantRenderer(): VariantRenderer {
    if (!this.variantRenderer) {
      this.variantRenderer = new VariantRenderer(this.meshPool);
    }
    return this.variantRenderer;
  }

  execute(ctx: RenderContext): void {
    const { shadowEnabled } = ctx.options;

    if (!shadowEnabled) return;

    // Lazily wire the shared shadow renderer into the terrain component
    // (only needs to happen once, after both exist)
    if (!this._terrainShadowWired && ctx.world) {
      const terrainEntity = ctx.world.queryFirst('terrain');
      if (terrainEntity) {
        const tc = terrainEntity.getComponent<TerrainComponent>('terrain');
        if (tc) {
          tc.setShadowRenderer(this.shadowRenderer);
          this._terrainShadowWired = true;
        }
      }
    }

    // Read light direction from ECS (via cached helper)
    const dirLight = ctx.getDirectionalLight();

    // Update shadow renderer params and compute light space matrix (single + CSM)
    // Use SCENE camera (not debug/view camera) so CSM frustum splits match what the scene sees
    this.shadowRenderer.updateLightMatrix({
      lightDirection: dirLight.direction as [number, number, number],
      cameraPosition: ctx.sceneCameraPosition,
      cameraForward: ctx.sceneCameraForward,
      cameraViewMatrix: ctx.sceneCameraViewMatrix,
      cameraProjectionMatrix: ctx.sceneCameraProjectionMatrix,
      cameraNearPlane: ctx.near,
      cameraFarPlane: ctx.far,
    });

    const shadowConfig = this.shadowRenderer.getConfig();
    const lightPos = this.shadowRenderer.getDirectionalLightPos();

    let drawCalls = 0;
    // Check if CSM is enabled
    if (shadowConfig.csmEnabled) {
      drawCalls = this.executeCSM(ctx, shadowConfig, lightPos);
    } else {
      drawCalls = this.executeSingleMap(ctx, shadowConfig, lightPos);
    }

    // Render spot light shadow atlas layers (after directional shadows)
    if (ctx.world) {
      drawCalls += this.executeSpotShadows(ctx);
    }

    ctx.addDrawCalls(drawCalls);
  }

  // ========================================================================
  // Spot Light Shadows
  // ========================================================================

  /**
   * Render spot light shadow depth into atlas layers.
   * Iterates spot light entities with allocated shadow atlas slots and renders
   * scene depth from each spot light's perspective into its atlas layer.
   *
   * Uses the same rendering paths as CSM cascades:
   * - TerrainComponent.renderDepthOnly() for terrain geometry
   * - ObjectRendererGPU.renderShadowPass() for batched object meshes
   */
  private executeSpotShadows(ctx: RenderContext): number {
    if (!ctx.world) return 0;

    const spotEntities = ctx.world.queryAny('light').filter(e => {
      const lc = e.getComponent<LightComponent>('light');
      return lc && lc.lightType === 'spot' && lc.enabled && lc.castsShadow && lc.shadowAtlasIndex >= 0;
    });

    if (spotEntities.length === 0) return 0;

    let drawCalls = 0;
    // Pre-write spot light matrices into dedicated slots (5+) using writeShadowMatricesAt.
    // This writes ONLY to the spot light region of the buffer, leaving the directional
    // shadow slots (0-4) completely untouched. This is critical because in WebGPU all
    // writeBuffer calls resolve before any render pass executes — if we overwrote slots
    // 0-4 with identity padding, the CSM cascade passes would read identity instead of
    // the correct directional light matrices.
    const spotMatrices: { matrix: mat4; slotIndex: number }[] = [];
    const spotOnlyMatrices: (mat4 | Float32Array)[] = [];

    for (let i = 0; i < spotEntities.length; i++) {
      const light = spotEntities[i].getComponent<LightComponent>('light')!;
      const lightMatrix = this.shadowRenderer.getSpotShadowMatrix(light.shadowAtlasIndex);
      const slotIndex = SPOT_SHADOW_SLOT_BASE + i;
      spotOnlyMatrices.push(lightMatrix);
      spotMatrices.push({ matrix: lightMatrix, slotIndex });
    }

    // Write only spot slots starting at SPOT_SHADOW_SLOT_BASE (leaves directional slots intact)
    this.shadowRenderer.writeShadowMatricesAt(SPOT_SHADOW_SLOT_BASE, spotOnlyMatrices);

    // Get terrain component for depth rendering (queried once for all spot lights)
    let terrainComponent: TerrainComponent | null = null;
    const terrainEntity = ctx.world.queryFirst('terrain');
    if (terrainEntity) {
      terrainComponent = terrainEntity.getComponent<TerrainComponent>('terrain') ?? null;
    }

    // Collect skinned mesh IDs to exclude from the legacy shadow path
    const meshRenderSystem = ctx.meshRenderSystem;
    let skinnedMeshIds: Set<number> | undefined;
    if (meshRenderSystem) {
      const vr = this.ensureVariantRenderer();
      skinnedMeshIds = vr.getSkinnedMeshIds(meshRenderSystem);
      if (skinnedMeshIds.size === 0) skinnedMeshIds = undefined;
    }

    for (let i = 0; i < spotEntities.length; i++) {
      const entity = spotEntities[i];
      const light = entity.getComponent<LightComponent>('light')!;
      const layerView = this.shadowRenderer.getSpotShadowAtlasLayerView(light.shadowAtlasIndex);
      if (!layerView) continue;

      const { matrix: lightMatrix, slotIndex } = spotMatrices[i];

      // Get spot light position for legacy shadow pass
      const transform = entity.getComponent<TransformComponent>('transform');
      const lightPos: Vec3 = transform ? transform.position as Vec3 : [0, 0, 0];

      // Begin render pass into this atlas layer
      const passEncoder = ctx.encoder.beginRenderPass({
        label: `spot-shadow-pass-layer-${light.shadowAtlasIndex}`,
        colorAttachments: [],
        depthStencilAttachment: {
          view: layerView,
          depthClearValue: 1.0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });

      // Use spot shadow atlas resolution (independent of directional shadow resolution)
      const spotResolution = this.shadowRenderer.getSpotShadowAtlasResolution();
      passEncoder.setViewport(0, 0, spotResolution, spotResolution, 0, 1);

      // Render terrain shadow depth from spot light perspective
      if (terrainComponent) {
        drawCalls += terrainComponent.renderDepthOnly(passEncoder, slotIndex, lightMatrix, lightPos);
      }

      // Render batched object shadows using the pre-written dedicated slot
      // (excludes skinned meshes — they need the variant pipeline with bone matrices)
      drawCalls += this.objectRenderer.renderShadowPass(passEncoder, slotIndex, lightPos, undefined, skinnedMeshIds);

      // Render skinned entities via composed depth-only pipeline with bone transforms
      if (skinnedMeshIds && meshRenderSystem) {
        drawCalls += this.ensureVariantRenderer().renderSkinnedDepthOnly(
          passEncoder, ctx.ctx, meshRenderSystem, lightMatrix,
        );
      }

      passEncoder.end();
    }

    return drawCalls;
  }

  // ========================================================================
  // Single Directional Shadow Map
  // ========================================================================

  /** Render single shadow map (non-CSM mode) */
  private executeSingleMap(
    ctx: RenderContext,
    shadowConfig: ReturnType<ShadowRendererGPU['getConfig']>,
    lightPos: ArrayLike<number>,
    slotIndex: number = 0
  ): number {
    const lightPosArray = [lightPos[0], lightPos[1], lightPos[2]] as [number, number, number];
    const shadowMap = this.shadowRenderer.getShadowMap();
    const lightSpaceMatrix = this.shadowRenderer.getLightSpaceMatrix();

    if (!shadowMap) return 0;

    // Pre-write single matrix when called standalone (not from executeCSM)
    if (slotIndex === 0) {
      this.shadowRenderer.writeShadowMatrices([lightSpaceMatrix]);
    }

    // Collect skinned mesh IDs to exclude from the legacy shadow path
    // (skinned entities are rendered via the variant pipeline with bone transforms)
    const meshRenderSystem = ctx.meshRenderSystem;
    let skinnedMeshIds: Set<number> | undefined;
    if (meshRenderSystem) {
      const vr = this.ensureVariantRenderer();
      skinnedMeshIds = vr.getSkinnedMeshIds(meshRenderSystem);
      if (skinnedMeshIds.size === 0) skinnedMeshIds = undefined;
    }

    // Begin shadow render pass
    const passEncoder = ctx.encoder.beginRenderPass({
      label: 'single-shadow-pass',
      colorAttachments: [],
      depthStencilAttachment: {
        view: shadowMap.view,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    passEncoder.setViewport(0, 0, shadowConfig.resolution, shadowConfig.resolution, 0, 1);

    let drawCalls = 0;
    // Render terrain shadow depth via ECS TerrainComponent
    if (ctx.world) {
      const terrainEntity = ctx.world.queryFirst('terrain');
      if (terrainEntity) {
        const tc = terrainEntity.getComponent<TerrainComponent>('terrain');
        if (tc) {
          drawCalls += tc.renderDepthOnly(passEncoder, slotIndex, lightSpaceMatrix, lightPosArray);
        }
      }
    }

    // Render batched object shadows via legacy dynamic buffer path
    // (excludes skinned meshes — they need the variant pipeline with bone matrices)
    drawCalls += this.objectRenderer.renderShadowPass(passEncoder, slotIndex, lightPosArray, undefined, skinnedMeshIds);

    // Render skinned entities via composed depth-only pipeline with bone transforms
    if (skinnedMeshIds && meshRenderSystem) {
      drawCalls += this.ensureVariantRenderer().renderSkinnedDepthOnly(
        passEncoder, ctx.ctx, meshRenderSystem, lightSpaceMatrix,
      );
    }

    // Render vegetation-instancing entities via composed depth-only pipeline.
    // Uses shadow-specific draw args (culled with shadowCastDistance) when available,
    // falling back to color draw args (culled with maxDistance) otherwise.
    if (meshRenderSystem) {
      drawCalls += this.ensureVariantRenderer().renderDepthOnly(
        passEncoder, ctx.ctx, meshRenderSystem,
        lightSpaceMatrix, lightSpaceMatrix, lightPosArray,
      );
    }

    passEncoder.end();
    return drawCalls;
  }

  // ========================================================================
  // Cascaded Shadow Maps (CSM)
  // ========================================================================

  /** Render multiple cascade shadow maps (CSM mode) */
  private executeCSM(
    ctx: RenderContext,
    shadowConfig: ReturnType<ShadowRendererGPU['getConfig']>,
    lightPos: ArrayLike<number>
  ): number {
    const lightPosArray = [lightPos[0], lightPos[1], lightPos[2]] as [number, number, number];

    // Pre-write ALL shadow matrices (cascades) in one call
    // Slot layout: [cascade0, cascade1, cascade2, cascade3]
    const matrices: (Float32Array | ReturnType<ShadowRendererGPU['getCascadeLightSpaceMatrix']>)[] = [];
    const casterMatrices: { lightSpaceMatrix: mat4; lightPosition: [number, number, number] }[] = [];
    for (let i = 0; i < shadowConfig.cascadeCount; i++) {
      const m = this.shadowRenderer.getCascadeLightSpaceMatrix(i);
      matrices.push(m);
      casterMatrices.push({ lightSpaceMatrix: m as mat4, lightPosition: lightPosArray });
    }
    this.shadowRenderer.writeShadowMatrices(matrices);

    // Pre-write terrain shadow uniforms via ECS TerrainComponent
    let terrainComponent: TerrainComponent | null = null;
    if (ctx.world) {
      const terrainEntity = ctx.world.queryFirst('terrain');
      if (terrainEntity) {
        terrainComponent = terrainEntity.getComponent<TerrainComponent>('terrain') ?? null;
        terrainComponent?.prepareShadowPasses(casterMatrices);
      }
    }

    // Collect skinned mesh IDs to exclude from the legacy shadow path
    const meshRenderSystem = ctx.meshRenderSystem;
    let skinnedMeshIds: Set<number> | undefined;
    if (meshRenderSystem) {
      const vr = this.ensureVariantRenderer();
      skinnedMeshIds = vr.getSkinnedMeshIds(meshRenderSystem);
      if (skinnedMeshIds.size === 0) skinnedMeshIds = undefined;
    }

    let drawCalls = 0;
    // Render each cascade using its pre-written slot
    for (let cascadeIdx = 0; cascadeIdx < shadowConfig.cascadeCount; cascadeIdx++) {
      const cascadeView = this.shadowRenderer.getCascadeView(cascadeIdx);
      const cascadeLightMatrix = this.shadowRenderer.getCascadeLightSpaceMatrix(cascadeIdx);

      if (!cascadeView) continue;

      // Begin cascade shadow render pass
      const passEncoder = ctx.encoder.beginRenderPass({
        label: `csm-shadow-pass-cascade-${cascadeIdx}`,
        colorAttachments: [],
        depthStencilAttachment: {
          view: cascadeView,
          depthClearValue: 1.0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });

      passEncoder.setViewport(0, 0, shadowConfig.resolution, shadowConfig.resolution, 0, 1);

      // Render terrain shadow depth for this cascade via ECS TerrainComponent
      if (terrainComponent) {
        drawCalls += terrainComponent.renderDepthOnly(passEncoder, cascadeIdx, cascadeLightMatrix, lightPosArray);
      }

      // Render batched object shadows via legacy dynamic buffer path
      // (excludes skinned meshes — they need the variant pipeline with bone matrices)
      drawCalls += this.objectRenderer.renderShadowPass(passEncoder, cascadeIdx, lightPosArray, undefined, skinnedMeshIds);

      // Render skinned entities via composed depth-only pipeline with bone transforms
      if (skinnedMeshIds && meshRenderSystem) {
        drawCalls += this.ensureVariantRenderer().renderSkinnedDepthOnly(
          passEncoder, ctx.ctx, meshRenderSystem, cascadeLightMatrix,
        );
      }

      // Render vegetation-instancing entities via composed depth-only pipeline.
      // Uses shadow-specific draw args (culled with shadowCastDistance) when available,
      // falling back to color draw args (culled with maxDistance) otherwise.
      if (meshRenderSystem) {
        drawCalls += this.ensureVariantRenderer().renderDepthOnly(
          passEncoder, ctx.ctx, meshRenderSystem,
          cascadeLightMatrix, cascadeLightMatrix, lightPosArray,
        );
      }

      passEncoder.end();
    }

    return drawCalls;
  }
}
