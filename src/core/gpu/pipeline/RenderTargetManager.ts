/**
 * RenderTargetManager - Manages all render target textures for the forward pipeline.
 *
 * Owns creation, resize, and destruction of:
 *  - Depth texture + depth copy (for shader sampling)
 *  - MSAA color texture (LDR)
 *  - MSAA HDR color texture
 *  - HDR scene color texture + copy (for water refraction)
 *  - Selection mask texture (r8unorm)
 *  - Normals G-buffer texture (rgba16float, for SSR)
 */

import { GPUContext } from '../GPUContext';
import { UnifiedGPUTexture } from '../GPUTexture';

export class RenderTargetManager {
  private ctx: GPUContext;
  private _width: number;
  private _height: number;
  private _sampleCount: number;

  // Render targets
  private _depthTexture: UnifiedGPUTexture;
  private _depthTextureCopy: UnifiedGPUTexture;
  private _msaaColorTexture: UnifiedGPUTexture | null = null;
  private _msaaHdrColorTexture: UnifiedGPUTexture | null = null;
  private _sceneColorTexture: UnifiedGPUTexture | null = null;
  private _sceneColorTextureCopy: UnifiedGPUTexture | null = null;
  private _selectionMaskTexture: UnifiedGPUTexture | null = null;
  private _normalsTexture: UnifiedGPUTexture | null = null;

  constructor(ctx: GPUContext, width: number, height: number, sampleCount: number) {
    this.ctx = ctx;
    this._width = width;
    this._height = height;
    this._sampleCount = sampleCount;

    // Depth
    this._depthTexture = UnifiedGPUTexture.createDepth(
      ctx, width, height, 'depth24plus', 'forward-depth'
    );
    this._depthTextureCopy = this.createDepthTextureCopy();

    // MSAA LDR
    if (sampleCount > 1) {
      this._msaaColorTexture = UnifiedGPUTexture.createRenderTarget(
        ctx, width, height, ctx.format, sampleCount, 'forward-msaa-color'
      );
    }

    // Selection mask
    this._selectionMaskTexture = this.createSelectionMaskTexture();

    // Normals G-buffer
    this._normalsTexture = this.createNormalsTexture();
  }

  // ========== Getters ==========

  get width() { return this._width; }
  get height() { return this._height; }
  get sampleCount() { return this._sampleCount; }

  get depthTexture() { return this._depthTexture; }
  get depthTextureCopy() { return this._depthTextureCopy; }
  get msaaColorTexture() { return this._msaaColorTexture; }
  get msaaHdrColorTexture() { return this._msaaHdrColorTexture; }
  get sceneColorTexture() { return this._sceneColorTexture; }
  get sceneColorTextureCopy() { return this._sceneColorTextureCopy; }
  get selectionMaskTexture() { return this._selectionMaskTexture; }
  get normalsTexture() { return this._normalsTexture; }

  // ========== HDR Initialization ==========

  /**
   * Create HDR intermediate buffers for post-processing path.
   * Called after post-processing pipeline is initialized.
   */
  initializeHDRTargets(): void {
    this._sceneColorTexture = this.createSceneColorTexture();
    this._sceneColorTextureCopy = this.createSceneColorTextureCopy();

    if (this._sampleCount > 1) {
      this._msaaHdrColorTexture = this.createMsaaHdrColorTexture();
    }
  }

  // ========== Resize ==========

  resize(width: number, height: number): void {
    if (this._width === width && this._height === height) return;

    this._width = width;
    this._height = height;

    // Depth
    this._depthTexture.destroy();
    this._depthTexture = UnifiedGPUTexture.createDepth(
      this.ctx, width, height, 'depth24plus', 'forward-depth'
    );

    this._depthTextureCopy.destroy();
    this._depthTextureCopy = this.createDepthTextureCopy();

    // MSAA LDR
    if (this._msaaColorTexture) {
      this._msaaColorTexture.destroy();
      this._msaaColorTexture = UnifiedGPUTexture.createRenderTarget(
        this.ctx, width, height, this.ctx.format, this._sampleCount, 'forward-msaa-color'
      );
    }

    // HDR scene color
    if (this._sceneColorTexture) {
      this._sceneColorTexture.destroy();
      this._sceneColorTexture = this.createSceneColorTexture();
    }

    if (this._sceneColorTextureCopy) {
      this._sceneColorTextureCopy.destroy();
      this._sceneColorTextureCopy = this.createSceneColorTextureCopy();
    }

    // MSAA HDR
    if (this._msaaHdrColorTexture) {
      this._msaaHdrColorTexture.destroy();
      this._msaaHdrColorTexture = this.createMsaaHdrColorTexture();
    }

    // Selection mask
    if (this._selectionMaskTexture) {
      this._selectionMaskTexture.destroy();
      this._selectionMaskTexture = this.createSelectionMaskTexture();
    }

    // Normals
    if (this._normalsTexture) {
      this._normalsTexture.destroy();
      this._normalsTexture = this.createNormalsTexture();
    }
  }

  // ========== Destroy ==========

  destroy(): void {
    this._depthTexture.destroy();
    this._depthTextureCopy.destroy();
    this._msaaColorTexture?.destroy();
    this._msaaHdrColorTexture?.destroy();
    this._sceneColorTexture?.destroy();
    this._sceneColorTextureCopy?.destroy();
    this._selectionMaskTexture?.destroy();
    this._normalsTexture?.destroy();
  }

  // ========== Private Texture Factories ==========

  private createDepthTextureCopy(): UnifiedGPUTexture {
    const texture = this.ctx.device.createTexture({
      label: 'forward-depth-copy',
      size: { width: this._width, height: this._height, depthOrArrayLayers: 1 },
      format: 'depth24plus',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });

    const view = texture.createView({
      label: 'forward-depth-copy-view',
      format: 'depth24plus',
      dimension: '2d',
      aspect: 'depth-only',
    });

    return {
      texture, view, format: 'depth24plus',
      width: this._width, height: this._height,
      destroy: () => texture.destroy(),
    } as UnifiedGPUTexture;
  }

  private createSceneColorTexture(): UnifiedGPUTexture {
    return UnifiedGPUTexture.create2D(this.ctx, {
      label: 'scene-color-hdr',
      width: this._width,
      height: this._height,
      format: 'rgba16float',
      renderTarget: true,
      sampled: true,
      copySrc: true,
    });
  }

  private createSceneColorTextureCopy(): UnifiedGPUTexture {
    return UnifiedGPUTexture.create2D(this.ctx, {
      label: 'scene-color-hdr-copy',
      width: this._width,
      height: this._height,
      format: 'rgba16float',
      renderTarget: false,
      sampled: true,
      copyDst: true,
    });
  }

  private createSelectionMaskTexture(): UnifiedGPUTexture {
    return UnifiedGPUTexture.create2D(this.ctx, {
      label: 'selection-mask',
      width: this._width,
      height: this._height,
      format: 'r8unorm',
      renderTarget: true,
      sampled: true,
    });
  }

  private createNormalsTexture(): UnifiedGPUTexture {
    return UnifiedGPUTexture.create2D(this.ctx, {
      label: 'normals-gbuffer',
      width: this._width,
      height: this._height,
      format: 'rgba16float',
      renderTarget: true,
      sampled: true,
    });
  }

  private createMsaaHdrColorTexture(): UnifiedGPUTexture {
    return UnifiedGPUTexture.createRenderTarget(
      this.ctx, this._width, this._height,
      'rgba16float', this._sampleCount, 'forward-msaa-hdr-color'
    );
  }
}
