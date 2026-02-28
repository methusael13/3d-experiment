/**
 * ReflectionProbeCaptureRenderer — Renders 6 cubemap faces from a probe position.
 *
 * Captures nearby geometry (opaques + ground) with full PBR rendering
 * (diffuse + shadows + ambient) into a low-res cubemap texture. The cubemap
 * is stored on the entity's ReflectionProbeComponent for shader sampling.
 *
 * Clear color = transparent black rgba(0,0,0,0) — no sky, no IBL in probe.
 * At render time, if probeColor.a < 0.01 the shader falls through to global
 * IBL specular, so sky/time-of-day changes don't require re-baking.
 *
 * Cubemap face order follows WebGPU/OpenGL convention:
 *   0: +X, 1: -X, 2: +Y, 3: -Y, 4: +Z, 5: -Z
 */

import { mat4, vec3 } from 'gl-matrix';
import type { GPUContext } from '../GPUContext';
import type { ReflectionProbeComponent, ProbeResolution } from '../../ecs/components/ReflectionProbeComponent';
import type { Entity } from '../../ecs/Entity';
import type { SystemContext } from '../../ecs/types';
import type { ObjectRenderParams } from './ObjectRendererGPU';
import { VariantRenderer } from '../pipeline/VariantRenderer';
import { MeshRenderSystem } from '../../ecs/systems/MeshRenderSystem';
import { GridGroundRenderParams, GridRendererGPU, GridRenderOptions } from './GridRendererGPU';
import { CubemapMipGenerator } from './CubemapMipGenerator';

// ==================== Cubemap Face Definitions ====================

/** Direction and up vector for each cubemap face */
/**
 * Cubemap face directions and up vectors.
 * WebGPU framebuffers are Y-down (row 0 = top), so up vectors are negated
 * compared to the OpenGL convention to produce correctly oriented faces
 * that match textureSampleLevel(cube, sampler, R) expectations.
 */
const CUBEMAP_FACES: { target: vec3; up: vec3 }[] = [
  { target: vec3.fromValues(1, 0, 0), up: vec3.fromValues(0, 1, 0) },    // +X
  { target: vec3.fromValues(-1, 0, 0), up: vec3.fromValues(0, 1, 0) },   // -X
  { target: vec3.fromValues(0, 1, 0), up: vec3.fromValues(0, 0, -1) },   // +Y
  { target: vec3.fromValues(0, -1, 0), up: vec3.fromValues(0, 0, 1) },   // -Y
  { target: vec3.fromValues(0, 0, 1), up: vec3.fromValues(0, 1, 0) },    // +Z
  { target: vec3.fromValues(0, 0, -1), up: vec3.fromValues(0, 1, 0) },   // -Z
];

type PerPassRenderParams = Required<Pick<
  ObjectRenderParams,
  'viewProjectionMatrix' | 'cameraPosition' | 'lightDirection' | 'lightColor' | 'ambientIntensity'
>> & {
  face: number;
};

// ==================== ReflectionProbeCaptureRenderer ====================

export class ReflectionProbeCaptureRenderer {
  private ctx: GPUContext;

  /** Reusable depth texture per resolution (lazily created) */
  private depthTextures: Map<ProbeResolution, GPUTexture> = new Map();

  /** Reusable dummy normals texture per resolution (2nd MRT target, discarded) */
  private normalsTextures: Map<ProbeResolution, GPUTexture> = new Map();

  /** Own VariantRenderer for probe capture (same approach as OpaquePass) */
  private variantRenderer: VariantRenderer | null = null;

  private gridRenderer: GridRendererGPU;

  /** Generates mip levels for the cubemap after bake */
  private mipGenerator: CubemapMipGenerator;

  /** MeshRenderSystem reference — set externally by Viewport alongside captureRenderer */
  meshRenderSystem: MeshRenderSystem | null = null;

  /**
   * Current scene light parameters — set externally each frame by the Viewport
   * so probe bakes use the real scene lighting instead of hardcoded defaults.
   */
  sceneLightParams: {
    lightDirection: [number, number, number];
    lightColor: [number, number, number];
    ambientIntensity: number;
  } = {
    lightDirection: [0.3, 0.8, 0.5],
    lightColor: [1.0, 1.0, 0.95],
    ambientIntensity: 0.4,
  };

  constructor(ctx: GPUContext) {
    this.ctx = ctx;
    this.gridRenderer = new GridRendererGPU(ctx);
    this.mipGenerator = new CubemapMipGenerator(ctx.device);
  }

  private ensureVariantRenderer(): VariantRenderer {
    if (!this.variantRenderer) {
      this.variantRenderer = new VariantRenderer(this.ctx.variantMeshPool);
    }
    return this.variantRenderer;
  }

  /**
   * Bake a reflection probe cubemap for the given entity.
   *
   * This renders 6 faces of the scene from the capture position, excluding
   * the entity itself (to avoid self-reflection artifacts). The result is
   * stored on the probe component.
   *
   * Uses the existing VariantRenderer infrastructure via the pipeline's
   * opaque pass to render ground + opaques with full PBR.
   */
  bakeProbe(
    entity: Entity,
    probe: ReflectionProbeComponent,
    capturePosition: [number, number, number],
    ctx: SystemContext,
  ): void {
    const resolution = probe.resolution;
    const device = this.ctx.device;

    // Create or reuse cubemap texture
    this.ensureCubemapTexture(probe, resolution);

    // Get or create depth texture for this resolution
    const depthTexture = this.getDepthTexture(resolution);

    // 90° FOV perspective projection for cubemap face (WebGPU reversed-Z)
    const projMatrix = mat4.create();
    mat4.perspectiveZO(projMatrix, Math.PI / 2, 1.0, 100.0, 0.1); // reversed-Z: far=0.1, near=100 swapped

    const eye = vec3.fromValues(capturePosition[0], capturePosition[1], capturePosition[2]);
    const lookTarget = vec3.create();
    const viewMatrix = mat4.create();
    const viewProj = mat4.create();

    // Temporarily clear the probe from SceneEnvironment to avoid
    // usage conflict (RenderAttachment + TextureBinding in same submission)
    // Probe cubemap is now per-entity in Group 2, no need to clear from SceneEnvironment

    for (let face = 0; face < 6; face++) {
      const faceDir = CUBEMAP_FACES[face];
      // Render each face
      const encoder = device.createCommandEncoder({ label: `probe-bake-${entity.id}-${face}` });

      // Build view matrix for this face
      vec3.add(lookTarget, eye, faceDir.target);
      mat4.lookAt(viewMatrix, eye, lookTarget, faceDir.up);
      // Flip X axis to convert from RH lookAt to LH cubemap convention
      // This corrects the horizontal mirror that cubemap sampling expects
      viewMatrix[0] = -viewMatrix[0];
      viewMatrix[4] = -viewMatrix[4];
      viewMatrix[8] = -viewMatrix[8];
      viewMatrix[12] = -viewMatrix[12];
      mat4.multiply(viewProj, projMatrix, viewMatrix);

      // Create a view for this specific cubemap face layer
      const faceView = probe.cubemapTexture!.createView({
        label: `probe-face-${face}`,
        dimension: '2d',
        baseArrayLayer: face,
        arrayLayerCount: 1,
        baseMipLevel: 0,
        mipLevelCount: 1,
      });

      const depthView = depthTexture.createView();
      const normalsView = this.getNormalsTexture(resolution).createView();

      const renderParams: PerPassRenderParams = {
        viewProjectionMatrix: viewProj,
        cameraPosition: capturePosition,
        lightDirection: this.sceneLightParams.lightDirection,
        lightColor: this.sceneLightParams.lightColor,
        ambientIntensity: this.sceneLightParams.ambientIntensity,
        face
      };

      this.renderGroundPass(encoder, faceView, depthView, renderParams, ctx);
      // Begin render pass for this face
      // 2 color targets required to match ObjectRendererGPU's MRT pipeline:
      //   target 0: HDR scene color (the actual cubemap face)
      //   target 1: normals G-buffer (dummy, discarded after render)
      this.renderOpaquePass(entity, encoder, faceView, normalsView, depthView, renderParams, ctx);

      this.ctx.queue.submit([encoder.finish()]);
    }

    // Generate mip levels for roughness-based blurred reflections
    this.mipGenerator.generateMips(probe.cubemapTexture!, this.ctx.queue);

    // Recreate the cube view to include all mip levels
    const mipCount = probe.cubemapTexture!.mipLevelCount;
    probe.cubemapView = probe.cubemapTexture!.createView({
      label: 'reflection-probe-cubemap-view',
      dimension: 'cube',
      arrayLayerCount: 6,
      baseMipLevel: 0,
      mipLevelCount: mipCount,
    });

    // Mark as baked
    probe.bakeState = 'baked';

    console.log(
      `[ReflectionProbe] Baked ${resolution}×${resolution} cubemap (${mipCount} mips) for entity ${entity.id}` +
      ` at (${capturePosition[0].toFixed(1)}, ${capturePosition[1].toFixed(1)}, ${capturePosition[2].toFixed(1)})`,
    );
  }

  private renderOpaquePass(
    entity: Entity,
    encoder: GPUCommandEncoder,
    colorAttachment: GPUTextureView,
    normalAttachment: GPUTextureView,
    depthAttachment: GPUTextureView,
    params: PerPassRenderParams,
    ctx: SystemContext
  ) {
    const pass = encoder.beginRenderPass({
      label: `probe-face-pass-${params.face}`,
      colorAttachments: [
        {
          view: colorAttachment,
          // Load from previous pass - ground
          loadOp: 'load',
          storeOp: 'store',
          // Transparent black — no geometry = fall through to IBL
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
        {
          view: normalAttachment,
          loadOp: 'clear',
          storeOp: 'discard', // Not needed, just satisfies MRT layout
          clearValue: { r: 0.5, g: 0.5, b: 1.0, a: 0 },
        },
      ],
      depthStencilAttachment: {
        view: depthAttachment,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
        depthClearValue: 0.0, // Reversed-Z: 0.0 = far
      },
    });

    // Render all opaques using the same VariantRenderer.renderColor() path as the opaque pass
    const renderParams: ObjectRenderParams = {
      ...params,
      shadowEnabled: true,
      csmEnabled: ctx.sceneEnvironment.hasCSM(),
    };

    // Use VariantRenderer.renderColor() — same path as the opaque pass
    // Exclude the entity being baked to avoid self-reflection artifacts
    if (this.meshRenderSystem) {
      const vr = this.ensureVariantRenderer();
      vr.renderColor(
        pass,
        this.ctx,
        this.meshRenderSystem,
        ctx.sceneEnvironment,
        renderParams,
        new Set([entity.id]), // excludeEntitySet — skip self
      );
    }

    pass.end();
  }

  private renderGroundPass(
    encoder: GPUCommandEncoder,
    colorAttachment: GPUTextureView,
    depthAttachment: GPUTextureView,
    params: PerPassRenderParams,
    ctx: SystemContext
  ) {
    const pass = encoder.beginRenderPass({
      label: `probe-ground-pass-${params.face}`,
      colorAttachments: [
        {
          view: colorAttachment,
          loadOp: 'clear',
          storeOp: 'store',
          // Transparent black — no geometry = fall through to IBL
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        }
      ],
      depthStencilAttachment: {
        view: depthAttachment,
        // First pass to use depth, always clear
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0.0, // Reversed-Z: 0.0 = far
      },
    });

    const renderParams: GridGroundRenderParams = {
      ...params,
      shadowEnabled: true,
    };
    this.gridRenderer.renderGround(pass, renderParams, ctx.sceneEnvironment);

    pass.end();
  }

  /**
   * Ensure the probe has a cubemap texture of the correct resolution.
   * Reuses existing texture if resolution matches.
   */
  private ensureCubemapTexture(probe: ReflectionProbeComponent, resolution: ProbeResolution): void {
    const device = this.ctx.device;

    // Check if existing texture matches resolution
    if (probe.cubemapTexture) {
      if (probe.cubemapTexture.width === resolution && probe.cubemapTexture.height === resolution) {
        return; // Reuse existing
      }
      // Resolution changed — destroy and recreate
      probe.cubemapTexture.destroy();
      probe.cubemapTexture = null;
      probe.cubemapView = null;
    }

    // Calculate mip level count for roughness-based blurred reflections
    const mipCount = CubemapMipGenerator.mipLevelCount(resolution);

    // Create cubemap texture (6 layers, rgba16float for HDR, multi-mip)
    probe.cubemapTexture = device.createTexture({
      label: `reflection-probe-cubemap`,
      size: { width: resolution, height: resolution, depthOrArrayLayers: 6 },
      format: 'rgba16float',
      mipLevelCount: mipCount,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING,
      dimension: '2d',
    });

    // Create cube view for shader sampling (all mip levels)
    probe.cubemapView = probe.cubemapTexture.createView({
      label: 'reflection-probe-cubemap-view',
      dimension: 'cube',
      arrayLayerCount: 6,
      baseMipLevel: 0,
      mipLevelCount: mipCount,
    });

    // Create sampler (once, reused)
    if (!probe.cubemapSampler) {
      probe.cubemapSampler = device.createSampler({
        label: 'reflection-probe-sampler',
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        addressModeW: 'clamp-to-edge',
      });
    }
  }

  /**
   * Get or create a dummy normals texture for the given resolution.
   * Satisfies the 2nd MRT target required by ObjectRendererGPU pipelines.
   */
  private getNormalsTexture(resolution: ProbeResolution): GPUTexture {
    let tex = this.normalsTextures.get(resolution);
    if (!tex) {
      tex = this.ctx.device.createTexture({
        label: `probe-normals-dummy-${resolution}`,
        size: { width: resolution, height: resolution },
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.normalsTextures.set(resolution, tex);
    }
    return tex;
  }

  /**
   * Get or create a depth texture for the given resolution.
   * Depth textures are shared across faces (rewritten each face).
   */
  private getDepthTexture(resolution: ProbeResolution): GPUTexture {
    let tex = this.depthTextures.get(resolution);
    if (!tex) {
      tex = this.ctx.device.createTexture({
        label: `probe-depth-${resolution}`,
        size: { width: resolution, height: resolution },
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.depthTextures.set(resolution, tex);
    }
    return tex;
  }

  /**
   * Destroy all cached resources.
   */
  destroy(): void {
    for (const tex of this.depthTextures.values()) {
      tex.destroy();
    }
    this.depthTextures.clear();
    for (const tex of this.normalsTextures.values()) {
      tex.destroy();
    }
    this.normalsTextures.clear();
    this.variantRenderer?.destroy();
    this.variantRenderer = null;
    this.gridRenderer.destroy();
    this.mipGenerator.destroy();
  }
}