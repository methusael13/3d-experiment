/**
 * RenderContext - Shared state for render passes
 * 
 * Encapsulates all state needed by render passes:
 * - Command encoder
 * - Camera matrices
 * - Render options
 * - Texture attachments
 */

import { mat4, vec3 } from 'gl-matrix';
import { GPUContext } from '../GPUContext';
import { UnifiedGPUTexture } from '../GPUTexture';
import type { GPUCamera, RenderOptions } from './GPUForwardPipeline';
import { DEFAULT_RENDER_OPTIONS } from './GPUForwardPipeline';

/**
 * Context passed to each render pass
 */
export interface RenderContext {
  // Core references
  readonly encoder: GPUCommandEncoder;
  readonly ctx: GPUContext;
  
  // Camera state (read-only)
  readonly camera: GPUCamera;
  readonly viewMatrix: Float32Array;
  readonly projectionMatrix: Float32Array;
  readonly viewProjectionMatrix: Float32Array;
  readonly inverseProjectionMatrix: Float32Array;
  readonly inverseViewMatrix: Float32Array;
  readonly cameraPosition: [number, number, number];
  readonly cameraForward: [number, number, number];
  
  // Render options
  readonly options: Required<RenderOptions>;
  
  // Dimensions
  readonly width: number;
  readonly height: number;
  
  // Near/far planes
  readonly near: number;
  readonly far: number;
  
  // Animation time
  readonly time: number;
  readonly deltaTime: number;
  
  // Textures
  readonly depthTexture: UnifiedGPUTexture;
  readonly depthTextureCopy: UnifiedGPUTexture;
  
  // Output texture/view (swap chain or HDR intermediate)
  readonly outputTexture: GPUTexture;
  readonly outputView: GPUTextureView;
  
  // Flags
  readonly useHDR: boolean;
  readonly useMSAA: boolean;
  readonly sampleCount: number;
  
  // Optional HDR intermediate (when post-processing enabled)
  readonly sceneColorTexture?: UnifiedGPUTexture;
  readonly msaaHdrColorTexture?: UnifiedGPUTexture;
  readonly msaaColorTexture?: UnifiedGPUTexture;
  
  // Helper methods
  getColorAttachment(loadOp: 'clear' | 'load'): GPURenderPassColorAttachment;
  getDepthAttachment(loadOp: 'clear' | 'load'): GPURenderPassDepthStencilAttachment;
  copyDepthForReading(): void;
}

/**
 * Builder options for RenderContextImpl
 */
export interface RenderContextOptions {
  ctx: GPUContext;
  encoder: GPUCommandEncoder;
  camera: GPUCamera;
  options: RenderOptions;
  width: number;
  height: number;
  near: number;
  far: number;
  time: number;
  deltaTime: number;
  sampleCount: number;
  
  // Textures
  depthTexture: UnifiedGPUTexture;
  depthTextureCopy: UnifiedGPUTexture;
  outputTexture: GPUTexture;
  outputView: GPUTextureView;
  
  // Optional post-processing textures
  sceneColorTexture?: UnifiedGPUTexture;
  msaaHdrColorTexture?: UnifiedGPUTexture;
  msaaColorTexture?: UnifiedGPUTexture;
  
  // Flags
  useHDR: boolean;
}

/**
 * Implementation of RenderContext
 */
export class RenderContextImpl implements RenderContext {
  readonly encoder: GPUCommandEncoder;
  readonly ctx: GPUContext;
  readonly camera: GPUCamera;
  readonly options: Required<RenderOptions>;
  readonly width: number;
  readonly height: number;
  readonly near: number;
  readonly far: number;
  readonly time: number;
  readonly deltaTime: number;
  readonly sampleCount: number;
  
  readonly viewMatrix: Float32Array;
  readonly projectionMatrix: Float32Array;
  readonly viewProjectionMatrix: Float32Array;
  readonly inverseProjectionMatrix: Float32Array;
  readonly inverseViewMatrix: Float32Array;
  readonly cameraPosition: [number, number, number];
  readonly cameraForward: [number, number, number];
  
  readonly depthTexture: UnifiedGPUTexture;
  readonly depthTextureCopy: UnifiedGPUTexture;
  readonly outputTexture: GPUTexture;
  readonly outputView: GPUTextureView;
  
  readonly useHDR: boolean;
  readonly useMSAA: boolean;
  
  readonly sceneColorTexture?: UnifiedGPUTexture;
  readonly msaaHdrColorTexture?: UnifiedGPUTexture;
  readonly msaaColorTexture?: UnifiedGPUTexture;
  
  private depthCopied = false;
  
  constructor(opts: RenderContextOptions) {
    this.encoder = opts.encoder;
    this.ctx = opts.ctx;
    this.camera = opts.camera;
    this.options = { ...DEFAULT_RENDER_OPTIONS, ...opts.options };
    this.width = opts.width;
    this.height = opts.height;
    this.near = opts.near;
    this.far = opts.far;
    this.time = opts.time;
    this.deltaTime = opts.deltaTime;
    this.sampleCount = opts.sampleCount;
    
    this.depthTexture = opts.depthTexture;
    this.depthTextureCopy = opts.depthTextureCopy;
    this.outputTexture = opts.outputTexture;
    this.outputView = opts.outputView;
    
    this.useHDR = opts.useHDR;
    this.useMSAA = opts.sampleCount > 1;
    
    this.sceneColorTexture = opts.sceneColorTexture;
    this.msaaHdrColorTexture = opts.msaaHdrColorTexture;
    this.msaaColorTexture = opts.msaaColorTexture;
    
    // Compute matrices
    const viewMat = this.camera.getViewMatrix();
    const projMat = this.camera.getProjectionMatrix();
    
    this.viewMatrix = new Float32Array(viewMat);
    this.projectionMatrix = new Float32Array(projMat);
    
    this.viewProjectionMatrix = new Float32Array(16);
    mat4.multiply(this.viewProjectionMatrix as unknown as mat4, projMat as mat4, viewMat as mat4);
    
    this.inverseProjectionMatrix = new Float32Array(16);
    mat4.invert(this.inverseProjectionMatrix as unknown as mat4, projMat as mat4);
    
    this.inverseViewMatrix = new Float32Array(16);
    mat4.invert(this.inverseViewMatrix as unknown as mat4, viewMat as mat4);
    
    // Camera position
    const pos = this.camera.getPosition();
    this.cameraPosition = [pos[0], pos[1], pos[2]];
    
    // Camera forward (from view matrix)
    const forward: [number, number, number] = [
      -this.viewMatrix[8],
      0,
      -this.viewMatrix[10],
    ];
    const len = Math.sqrt(forward[0] * forward[0] + forward[2] * forward[2]);
    if (len > 0.001) {
      forward[0] /= len;
      forward[2] /= len;
    }
    this.cameraForward = forward;
  }
  
  /**
   * Get color attachment for render pass
   * Handles MSAA and HDR intermediate buffer selection
   */
  getColorAttachment(loadOp: 'clear' | 'load'): GPURenderPassColorAttachment {
    if (this.useHDR && this.sceneColorTexture) {
      // HDR path: render to HDR intermediate
      if (this.useMSAA && this.msaaHdrColorTexture) {
        return {
          view: this.msaaHdrColorTexture.view,
          resolveTarget: this.sceneColorTexture.view,
          clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
          loadOp,
          storeOp: 'store',
        };
      }
      return {
        view: this.sceneColorTexture.view,
        clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
        loadOp,
        storeOp: 'store',
      };
    }
    
    // LDR path: render to swap chain
    if (this.useMSAA && this.msaaColorTexture) {
      return {
        view: this.msaaColorTexture.view,
        resolveTarget: this.outputView,
        clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
        loadOp,
        storeOp: 'store',
      };
    }
    
    return {
      view: this.outputView,
      clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
      loadOp,
      storeOp: 'store',
    };
  }
  
  /**
   * Get depth attachment for render pass
   */
  getDepthAttachment(loadOp: 'clear' | 'load'): GPURenderPassDepthStencilAttachment {
    return {
      view: this.depthTexture.view,
      depthClearValue: 1.0,
      depthLoadOp: loadOp,
      depthStoreOp: 'store',
    };
  }
  
  /**
   * Copy depth texture for shader reading
   * Only copies once per frame
   */
  copyDepthForReading(): void {
    if (this.depthCopied) return;
    
    this.encoder.copyTextureToTexture(
      { texture: this.depthTexture.texture },
      { texture: this.depthTextureCopy.texture },
      { width: this.width, height: this.height, depthOrArrayLayers: 1 }
    );
    
    this.depthCopied = true;
  }
}
