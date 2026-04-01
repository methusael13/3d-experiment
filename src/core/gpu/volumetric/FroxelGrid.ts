/**
 * FroxelGrid — 3D texture management for froxel volumetric fog
 *
 * Manages the frustum-aligned voxel (froxel) grid: 160×90×64 with
 * exponential depth slicing. Creates and manages the 3D textures used
 * across all froxel compute passes.
 *
 * Textures:
 *  - densityGrid: rgba16float — fog density injection (A = extinction)
 *  - scatterGrid: rgba16float — per-froxel scattering + extinction
 *  - integratedGrid: rgba16float — front-to-back integrated result
 *  - historyGrid: rgba16float — previous frame for temporal reprojection
 */

import type { GPUContext } from '../GPUContext';
import { FROXEL_WIDTH, FROXEL_HEIGHT, FROXEL_DEPTH } from './types';

export class FroxelGrid {
  private ctx: GPUContext;

  // 3D textures
  private _densityTexture: GPUTexture | null = null;
  private _scatterTexture: GPUTexture | null = null;
  private _integratedTexture: GPUTexture | null = null;
  private _historyTexture: GPUTexture | null = null;

  // Views for storage writes
  private _densityStorageView: GPUTextureView | null = null;
  private _scatterStorageView: GPUTextureView | null = null;
  private _integratedStorageView: GPUTextureView | null = null;
  private _historyStorageView: GPUTextureView | null = null;

  // Views for texture reads (sampling)
  private _densityReadView: GPUTextureView | null = null;
  private _scatterReadView: GPUTextureView | null = null;
  private _integratedReadView: GPUTextureView | null = null;
  private _historyReadView: GPUTextureView | null = null;

  // Samplers
  private _linearSampler: GPUSampler | null = null;

  constructor(ctx: GPUContext) {
    this.ctx = ctx;
  }

  // ========== Initialization ==========

  init(): void {
    this.createTextures();
    this.createSampler();
  }

  private createTextures(): void {
    const size = { width: FROXEL_WIDTH, height: FROXEL_HEIGHT, depthOrArrayLayers: FROXEL_DEPTH };
    const format: GPUTextureFormat = 'rgba16float';
    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;

    // Density grid (written by density injection, read by scattering pass)
    this._densityTexture = this.ctx.device.createTexture({
      label: 'froxel-density-3d',
      size, format, dimension: '3d', usage,
    });
    this._densityStorageView = this._densityTexture.createView({ label: 'froxel-density-storage', dimension: '3d' });
    this._densityReadView = this._densityTexture.createView({ label: 'froxel-density-read', dimension: '3d' });

    // Scatter grid (written by scattering pass, read by integrate + temporal)
    this._scatterTexture = this.ctx.device.createTexture({
      label: 'froxel-scatter-3d',
      size, format, dimension: '3d', usage,
    });
    this._scatterStorageView = this._scatterTexture.createView({ label: 'froxel-scatter-storage', dimension: '3d' });
    this._scatterReadView = this._scatterTexture.createView({ label: 'froxel-scatter-read', dimension: '3d' });

    // Integrated grid (written by integrate pass, read by apply post-process)
    this._integratedTexture = this.ctx.device.createTexture({
      label: 'froxel-integrated-3d',
      size, format, dimension: '3d', usage,
    });
    this._integratedStorageView = this._integratedTexture.createView({ label: 'froxel-integrated-storage', dimension: '3d' });
    this._integratedReadView = this._integratedTexture.createView({ label: 'froxel-integrated-read', dimension: '3d' });

    // History grid (for temporal reprojection — ping-pong with scatter)
    this._historyTexture = this.ctx.device.createTexture({
      label: 'froxel-history-3d',
      size, format, dimension: '3d', usage,
    });
    this._historyStorageView = this._historyTexture.createView({ label: 'froxel-history-storage', dimension: '3d' });
    this._historyReadView = this._historyTexture.createView({ label: 'froxel-history-read', dimension: '3d' });
  }

  private createSampler(): void {
    this._linearSampler = this.ctx.device.createSampler({
      label: 'froxel-linear-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });
  }

  // ========== Accessors ==========

  // Density
  get densityStorageView(): GPUTextureView { return this._densityStorageView!; }
  get densityReadView(): GPUTextureView { return this._densityReadView!; }

  // Scatter
  get scatterStorageView(): GPUTextureView { return this._scatterStorageView!; }
  get scatterReadView(): GPUTextureView { return this._scatterReadView!; }

  // Integrated (final result — sampled by post-process apply)
  get integratedStorageView(): GPUTextureView { return this._integratedStorageView!; }
  get integratedReadView(): GPUTextureView { return this._integratedReadView!; }

  // History (temporal reprojection)
  get historyStorageView(): GPUTextureView { return this._historyStorageView!; }
  get historyReadView(): GPUTextureView { return this._historyReadView!; }

  // Linear sampler for 3D texture reads
  get linearSampler(): GPUSampler { return this._linearSampler!; }

  // ========== Swap History ==========

  /**
   * After temporal reprojection writes to scatter grid, swap scatter ↔ history
   * so the current frame's result becomes next frame's history.
   */
  swapHistory(): void {
    // Swap texture references
    const tmpTex = this._historyTexture;
    const tmpSV = this._historyStorageView;
    const tmpRV = this._historyReadView;

    this._historyTexture = this._scatterTexture;
    this._historyStorageView = this._scatterStorageView;
    this._historyReadView = this._scatterReadView;

    this._scatterTexture = tmpTex;
    this._scatterStorageView = tmpSV;
    this._scatterReadView = tmpRV;
  }

  // ========== Destroy ==========

  destroy(): void {
    this._densityTexture?.destroy();
    this._scatterTexture?.destroy();
    this._integratedTexture?.destroy();
    this._historyTexture?.destroy();
  }
}
