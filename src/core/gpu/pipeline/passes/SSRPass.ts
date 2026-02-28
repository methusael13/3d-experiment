/**
 * SSRPass - Screen Space Reflections render pass
 * 
 * Runs between Opaque (300) and Transparent (400) at priority 350.
 * Reads opaque scene color + depth, produces an SSR texture (rgba16float).
 * 
 * The SSR texture is stored on this pass and can be accessed by downstream passes
 * (TransparentPass reads it for water reflections).
 * 
 * Reconstructs normals from depth derivatives (no normals G-buffer needed).
 */

import { mat4 } from 'gl-matrix';
import { BaseRenderPass, type PassCategory } from '../RenderPass';
import type { RenderContext } from '../RenderContext';
import { GPUContext } from '../../GPUContext';
import { UnifiedGPUTexture } from '../../GPUTexture';
import type { SSRConfig } from '../SSRConfig';
import { createSSRConfig, applySSRQualityPreset, type SSRQualityLevel } from '../SSRConfig';
import ssrShaderSource from '../../shaders/ssr.wgsl?raw';

/**
 * SSR pass priority: between OPAQUE (300) and TRANSPARENT (400)
 */
const SSR_PRIORITY = 350;

/**
 * Uniform buffer size: 4 mat4 (256 bytes) + 3 vec4 (48 bytes) = 304 bytes
 * Aligned to 16-byte boundary = 304 bytes
 */
const UNIFORM_BUFFER_SIZE = 304;

export class SSRPass extends BaseRenderPass {
  readonly name = 'ssr';
  readonly priority = SSR_PRIORITY;
  readonly category: PassCategory = 'scene';

  private ctx: GPUContext;
  private config: SSRConfig;

  // GPU resources
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  // Double-buffered SSR textures: current frame writes to one, previous frame's result in the other
  private ssrTextures: [UnifiedGPUTexture | null, UnifiedGPUTexture | null] = [null, null];
  private currentBufferIndex = 0; // Toggles 0/1 each frame
  private width: number;
  private height: number;
  
  /**
   * Consumer check callback — returns true if any entity in the scene consumes SSR.
   * When no consumers exist, the pass skips entirely (zero GPU cost).
   * Set by GPUForwardPipeline via setConsumerCheck().
   */
  private consumerCheck: (() => boolean) | null = null;

  constructor(ctx: GPUContext, width: number, height: number, config?: Partial<SSRConfig>) {
    super();
    this.ctx = ctx;
    this.width = width;
    this.height = height;
    this.config = { ...createSSRConfig('medium', true), ...config };

    this.initGPUResources();
  }

  // ========== Public API ==========

  /**
   * Get the current frame's SSR result texture (rgba16float: RGB = reflected color, A = confidence)
   * Returns null if SSR is disabled or not yet initialized
   */
  getSSRTexture(): UnifiedGPUTexture | null {
    if (!this.enabled || !this.config.enabled) return null;
    return this.ssrTextures[this.currentBufferIndex];
  }

  /**
   * Get the previous frame's SSR texture for opaque metallic objects (1-frame lag)
   * Returns null if SSR is disabled or not yet initialized
   */
  getPreviousSSRTexture(): UnifiedGPUTexture | null {
    if (!this.enabled || !this.config.enabled) return null;
    const prevIndex = 1 - this.currentBufferIndex;
    return this.ssrTextures[prevIndex];
  }

  /**
   * Get current SSR config
   */
  getConfig(): SSRConfig {
    return { ...this.config };
  }

  /**
   * Update SSR config
   */
  setConfig(config: Partial<SSRConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Set quality preset
   */
  setQuality(quality: SSRQualityLevel): void {
    this.config = applySSRQualityPreset(this.config, quality);
  }

  /**
   * Set enabled state (both pass-level and config-level)
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.config.enabled = enabled;
  }

  /**
   * Set consumer check callback. Called each frame to determine if SSR should run.
   * If no consumers exist (no ocean, no SSR-enabled entities), the pass is skipped entirely.
   */
  setConsumerCheck(check: () => boolean): void {
    this.consumerCheck = check;
  }

  /**
   * Resize SSR textures
   */
  resize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;

    // Recreate double-buffered SSR textures
    this.ssrTextures[0]?.destroy();
    this.ssrTextures[1]?.destroy();
    this.ssrTextures[0] = this.createSSRTexture('ssr-texture-0');
    this.ssrTextures[1] = this.createSSRTexture('ssr-texture-1');
  }

  // ========== Render Pass Implementation ==========

  execute(ctx: RenderContext): void {
    if (!this.config.enabled || !this.pipeline || !this.uniformBuffer) {
      return;
    }

    // Skip if no consumers exist in the scene (no ocean, no SSR-enabled opaque objects)
    // This saves the entire fullscreen ray march when SSR results wouldn't be used
    if (this.consumerCheck && !this.consumerCheck()) {
      return;
    }

    // Swap buffer index at the start of each frame's SSR pass.
    // After swap: currentBufferIndex points to the buffer we'll WRITE to.
    // The other buffer (1 - currentBufferIndex) holds the previous frame's result.
    this.currentBufferIndex = 1 - this.currentBufferIndex;
    const ssrTarget = this.ssrTextures[this.currentBufferIndex];
    if (!ssrTarget) {
      return;
    }

    // Need scene color, depth, and normals
    if (!ctx.sceneColorTexture || !ctx.depthTexture) {
      return;
    }

    // Copy depth and scene color for reading (SSR reads opaque result)
    ctx.copyDepthForReading();
    ctx.copySceneColorForReading();

    if (!ctx.sceneColorTextureCopy) {
      return;
    }

    // Use normals G-buffer if available, otherwise SSR will fail gracefully
    // (the shader reads from normalsTexture which may be cleared to 0)
    const normalsView = ctx.normalsTexture?.view;
    if (!normalsView) {
      return; // Can't do SSR without normals
    }

    // Update uniform buffer
    this.updateUniforms(ctx);

    // Create bind group (recreated each frame since textures may change on resize)
    const bindGroup = this.ctx.device.createBindGroup({
      label: 'ssr-bind-group',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: ctx.depthTextureCopy.view },
        { binding: 2, resource: ctx.sceneColorTextureCopy.view },
        { binding: 3, resource: normalsView },
      ],
    });

    // Render SSR fullscreen pass to current buffer
    const pass = ctx.encoder.beginRenderPass({
      label: 'ssr-pass',
      colorAttachments: [{
        view: ssrTarget.view,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3, 1, 0, 0); // Fullscreen triangle
    pass.end();

    // NOTE: Do NOT swap here. currentBufferIndex points to the just-written buffer.
    // TransparentPass (water) reads getSSRTexture() which returns ssrTextures[currentBufferIndex].
    // Swap happens at the BEGINNING of the next frame's execute() so:
    //   - getSSRTexture() returns current frame's result (for water, same frame)
    //   - getPreviousSSRTexture() returns previous frame's result (for opaque objects)

    ctx.addDrawCalls(1);
  }

  destroy(): void {
    this.ssrTextures[0]?.destroy();
    this.ssrTextures[1]?.destroy();
    this.uniformBuffer?.destroy();
    this.ssrTextures = [null, null];
    this.uniformBuffer = null;
    this.pipeline = null;
  }

  // ========== Private Methods ==========

  private initGPUResources(): void {
    this.createPipeline();
    this.createUniformBuffer();
    this.ssrTextures[0] = this.createSSRTexture('ssr-texture-0');
    this.ssrTextures[1] = this.createSSRTexture('ssr-texture-1');
  }

  private createSSRTexture(label: string = 'ssr-texture'): UnifiedGPUTexture {
    return UnifiedGPUTexture.create2D(this.ctx, {
      label,
      width: this.width,
      height: this.height,
      format: 'rgba16float',
      renderTarget: true,
      sampled: true,
    });
  }

  private createPipeline(): void {
    const shaderModule = this.ctx.device.createShaderModule({
      label: 'ssr-shader',
      code: ssrShaderSource,
    });

    this.pipeline = this.ctx.device.createRenderPipeline({
      label: 'ssr-pipeline',
      layout: 'auto',
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: 'rgba16float' }],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none',
      },
    });
  }

  private createUniformBuffer(): void {
    this.uniformBuffer = this.ctx.device.createBuffer({
      label: 'ssr-uniforms',
      size: UNIFORM_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  private updateUniforms(ctx: RenderContext): void {
    if (!this.uniformBuffer) return;

    // Pack uniform data: 4 mat4 (64 floats) + 3 vec4 (12 floats) = 76 floats = 304 bytes
    const data = new Float32Array(76);

    // projectionMatrix (indices 0-15)
    data.set(ctx.projectionMatrix, 0);

    // inverseProjectionMatrix (indices 16-31)
    data.set(ctx.inverseProjectionMatrix, 16);

    // viewMatrix (indices 32-47)
    data.set(ctx.viewMatrix, 32);

    // inverseViewMatrix (indices 48-63)
    data.set(ctx.inverseViewMatrix, 48);

    // params1: maxSteps, refinementSteps, maxDistance, stepSize (indices 64-67)
    data[64] = this.config.maxSteps;
    data[65] = this.config.refinementSteps;
    data[66] = this.config.maxDistance;
    data[67] = this.config.stepSize;

    // params2: thickness, edgeFade, jitter, time (indices 68-71)
    data[68] = this.config.thickness;
    data[69] = this.config.edgeFade;
    data[70] = this.config.jitter ? 1.0 : 0.0;
    data[71] = ctx.time;

    // params3: width, height, near, far (indices 72-75)
    data[72] = ctx.width;
    data[73] = ctx.height;
    data[74] = ctx.near;
    data[75] = ctx.far;

    this.ctx.queue.writeBuffer(this.uniformBuffer, 0, data);
  }
}