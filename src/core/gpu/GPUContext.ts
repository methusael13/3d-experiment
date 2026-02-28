/**
 * GPUContext - Singleton for WebGPU device management
 * Handles adapter/device acquisition and provides the core GPU resources
 */

import { ObjectRendererGPU, type GPUMaterial, type GPUMaterialTextures, type GPUMeshData } from './renderers/ObjectRendererGPU';
import { VariantMeshPool } from './pipeline/VariantMeshPool';
import type { mat4 } from 'gl-matrix';

export interface GPUContextOptions {
  powerPreference?: GPUPowerPreference;
  requiredFeatures?: GPUFeatureName[];
  requiredLimits?: Record<string, number>;
}

/**
 * Singleton class managing WebGPU adapter, device, and queue
 */
export class GPUContext {
  private static instance: GPUContext | null = null;
  private static initPromise: Promise<GPUContext> | null = null;

  private _adapter: GPUAdapter | null = null;
  private _device: GPUDevice | null = null;
  private _canvas: HTMLCanvasElement | null = null;
  private _context: GPUCanvasContext | null = null;
  private _format: GPUTextureFormat = 'bgra8unorm';
  
  // Shared renderers (lazy initialized)
  private _objectRenderer: ObjectRendererGPU | null = null;
  private _variantMeshPool: VariantMeshPool | null = null;

  private constructor() {}

  /**
   * Check if WebGPU is supported in the current environment
   */
  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
  }

  /**
   * Get or initialize the singleton instance
   */
  static async getInstance(
    canvas?: HTMLCanvasElement,
    options?: GPUContextOptions
  ): Promise<GPUContext> {
    if (GPUContext.instance && GPUContext.instance._device) {
      // If canvas provided and different, reconfigure
      if (canvas && canvas !== GPUContext.instance._canvas) {
        GPUContext.instance.configureCanvas(canvas);
      }
      return GPUContext.instance;
    }

    // Prevent multiple concurrent initializations
    if (GPUContext.initPromise) {
      return GPUContext.initPromise;
    }

    GPUContext.initPromise = GPUContext.initialize(canvas, options);
    try {
      GPUContext.instance = await GPUContext.initPromise;
      return GPUContext.instance;
    } finally {
      GPUContext.initPromise = null;
    }
  }

  /**
   * Internal initialization
   */
  private static async initialize(
    canvas?: HTMLCanvasElement,
    options?: GPUContextOptions
  ): Promise<GPUContext> {
    if (!GPUContext.isSupported()) {
      throw new Error('WebGPU is not supported in this browser');
    }

    const ctx = new GPUContext();

    // Request adapter
    ctx._adapter = await navigator.gpu.requestAdapter({
      powerPreference: options?.powerPreference || 'high-performance',
    });

    if (!ctx._adapter) {
      throw new Error('Failed to acquire WebGPU adapter');
    }

    // Log adapter info
    console.log('[GPUContext] Adapter acquired');

    // Request device with features and limits
    const deviceDescriptor: GPUDeviceDescriptor = {
      requiredFeatures: options?.requiredFeatures || [],
      requiredLimits: options?.requiredLimits || {},
    };

    ctx._device = await ctx._adapter.requestDevice(deviceDescriptor);

    // Handle device loss
    ctx._device.lost.then((info) => {
      console.error('[GPUContext] Device lost:', info.message);
      GPUContext.instance = null;
      // Optionally trigger re-initialization or notify application
    });

    // Configure canvas if provided
    if (canvas) {
      ctx.configureCanvas(canvas);
    }

    console.log('[GPUContext] Initialized successfully');
    return ctx;
  }

  /**
   * Configure a canvas for WebGPU rendering
   */
  configureCanvas(canvas: HTMLCanvasElement): void {
    if (!this._device) {
      throw new Error('GPUContext not initialized');
    }

    this._canvas = canvas;
    this._context = canvas.getContext('webgpu') as GPUCanvasContext;

    if (!this._context) {
      throw new Error('Failed to get WebGPU context from canvas');
    }

    // Get preferred format
    this._format = navigator.gpu.getPreferredCanvasFormat();

    this._context.configure({
      device: this._device,
      format: this._format,
      alphaMode: 'opaque',
    });

    console.log('[GPUContext] Canvas configured, format:', this._format);
  }

  /**
   * Get the current render target texture view
   */
  getCurrentTextureView(): GPUTextureView {
    if (!this._context) {
      throw new Error('Canvas not configured');
    }
    return this._context.getCurrentTexture().createView();
  }

  // Getters
  get adapter(): GPUAdapter {
    if (!this._adapter) throw new Error('GPUContext not initialized');
    return this._adapter;
  }

  get device(): GPUDevice {
    if (!this._device) throw new Error('GPUContext not initialized');
    return this._device;
  }

  get queue(): GPUQueue {
    return this.device.queue;
  }

  get format(): GPUTextureFormat {
    return this._format;
  }
  
  /** HDR color format used by the forward pipeline's scene render targets */
  get hdrFormat(): GPUTextureFormat {
    return 'rgba16float';
  }
  
  /** Depth buffer format used by the forward pipeline */
  get depthFormat(): GPUTextureFormat {
    return 'depth24plus';
  }

  get canvas(): HTMLCanvasElement | null {
    return this._canvas;
  }

  get context(): GPUCanvasContext | null {
    return this._context;
  }

  /**
   * Get the shared object renderer (lazy initialized)
   * Used for rendering primitives and models
   */
  get objectRenderer(): ObjectRendererGPU {
    if (!this._objectRenderer) {
      this._objectRenderer = new ObjectRendererGPU(this);
    }
    return this._objectRenderer;
  }

  /**
   * Get the shared variant mesh pool (lazy initialized).
   * Used by the composed shader variant rendering path (VariantRenderer).
   * ECS components dual-register with both objectRenderer and variantMeshPool.
   */
  get variantMeshPool(): VariantMeshPool {
    if (!this._variantMeshPool) {
      this._variantMeshPool = new VariantMeshPool(this);
    }
    return this._variantMeshPool;
  }

  // ===================== Dual-Pool Facade =====================
  // These methods delegate to both ObjectRendererGPU (legacy) and VariantMeshPool
  // (composed shader path), keeping them in sync with a single call.

  /**
   * Add a mesh to both ObjectRendererGPU and VariantMeshPool.
   * Returns the shared mesh ID.
   */
  addMesh(data: GPUMeshData): number {
    const id = this.objectRenderer.addMesh(data);
    this.variantMeshPool.addMeshWithId(id, data);
    return id;
  }

  /**
   * Remove a mesh from both pools.
   */
  removeMesh(id: number): void {
    this.objectRenderer.removeMesh(id);
    this.variantMeshPool.removeMesh(id);
  }

  /**
   * Set the transform on both pools.
   */
  setMeshTransform(id: number, modelMatrix: mat4 | Float32Array): void {
    this.objectRenderer.setTransform(id, modelMatrix);
    this.variantMeshPool.setTransform(id, modelMatrix);
  }

  /**
   * Set material properties on both pools.
   */
  setMeshMaterial(id: number, material: Partial<GPUMaterial>): void {
    this.objectRenderer.setMaterial(id, material);
    this.variantMeshPool.setMaterial(id, material);
  }

  /**
   * Set textures on both pools.
   * Passes explicit undefined for missing PBR slots so ObjectRendererGPU's merge
   * replaces old references (prevents use-after-destroy when clearing textures).
   */
  setMeshTextures(id: number, textures: GPUMaterialTextures): void {
    // Ensure all 5 PBR slots are present — undefined entries clear old refs via merge
    const fullTextures: GPUMaterialTextures = {
      baseColor: textures.baseColor ?? undefined,
      normal: textures.normal ?? undefined,
      metallicRoughness: textures.metallicRoughness ?? undefined,
      occlusion: textures.occlusion ?? undefined,
      emissive: textures.emissive ?? undefined,
    };
    this.objectRenderer.setTextures(id, fullTextures);
    this.variantMeshPool.setPBRTextures(id, textures);
  }

  /**
   * Write extra uniform data to both pools' material buffers.
   */
  writeMeshExtraUniforms(id: number, data: Float32Array, byteOffset: number): void {
    this.objectRenderer.writeExtraUniforms(id, data, byteOffset);
    this.variantMeshPool.writeExtraUniforms(id, data, byteOffset);
  }

  /**
   * Get device limits
   */
  get limits(): GPUSupportedLimits {
    return this.device.limits;
  }

  /**
   * Check if a feature is supported
   */
  hasFeature(feature: GPUFeatureName): boolean {
    return this.device.features.has(feature);
  }

  /**
   * Create a shader module from WGSL code
   */
  createShaderModule(code: string, label?: string): GPUShaderModule {
    return this.device.createShaderModule({
      code,
      label,
    });
  }

  /**
   * Create a buffer with optional initial data
   */
  createBuffer(
    size: number,
    usage: GPUBufferUsageFlags,
    mappedAtCreation = false,
    label?: string
  ): GPUBuffer {
    return this.device.createBuffer({
      size,
      usage,
      mappedAtCreation,
      label,
    });
  }

  /**
   * Create a buffer and upload data immediately
   */
  createBufferWithData(
    data: ArrayBuffer | ArrayBufferView,
    usage: GPUBufferUsageFlags,
    label?: string
  ): GPUBuffer {
    const buffer = this.device.createBuffer({
      size: data.byteLength,
      usage: usage | GPUBufferUsage.COPY_DST,
      label,
    });

    if (data instanceof ArrayBuffer) {
      this.queue.writeBuffer(buffer, 0, data);
    } else {
      this.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
    }

    return buffer;
  }

  /**
   * Destroy the context and release resources
   */
  destroy(): void {
    // Destroy shared renderers
    if (this._variantMeshPool) {
      this._variantMeshPool.destroy();
      this._variantMeshPool = null;
    }
    if (this._objectRenderer) {
      this._objectRenderer.destroy();
      this._objectRenderer = null;
    }
    
    if (this._device) {
      this._device.destroy();
      this._device = null;
    }
    this._adapter = null;
    this._context = null;
    this._canvas = null;
    GPUContext.instance = null;
    console.log('[GPUContext] Destroyed');
  }
}
