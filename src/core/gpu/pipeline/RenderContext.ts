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
import type { Scene } from '../../Scene';
import type { SceneEnvironment } from '../renderers/shared';

/**
 * Context passed to each render pass
 */
export interface RenderContext {
  // Core references
  readonly encoder: GPUCommandEncoder;
  readonly ctx: GPUContext;
  readonly scene: Scene | null;
  
  // Camera state for VIEWING (what appears on screen - may be debug camera)
  readonly camera: GPUCamera;
  readonly viewMatrix: Float32Array;
  readonly projectionMatrix: Float32Array;
  readonly viewProjectionMatrix: Float32Array;
  readonly inverseProjectionMatrix: Float32Array;
  readonly inverseViewMatrix: Float32Array;
  readonly cameraPosition: [number, number, number];
  readonly cameraForward: [number, number, number];
  
  // Scene camera state (the "real" camera for shadows, culling, shader uniforms)
  // When not in debug camera mode, these are identical to the view camera fields above.
  readonly sceneCamera: GPUCamera;
  readonly sceneCameraPosition: [number, number, number];
  readonly sceneCameraForward: [number, number, number];
  readonly sceneCameraViewMatrix: Float32Array;
  readonly sceneCameraProjectionMatrix: Float32Array;
  readonly sceneCameraViewProjectionMatrix: Float32Array;
  
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
  readonly sceneColorTextureCopy?: UnifiedGPUTexture;
  
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
  
  // Unified environment (shadow + IBL)
  readonly sceneEnvironment?: SceneEnvironment;
  
  // Helper methods
  getColorAttachment(loadOp: 'clear' | 'load'): GPURenderPassColorAttachment;
  getBackbufferColorAttachment(loadOp: 'clear' | 'load'): GPURenderPassColorAttachment;
  getDepthAttachment(loadOp: 'clear' | 'load'): GPURenderPassDepthStencilAttachment;
  copyDepthForReading(): void;
  copySceneColorForReading(): void;
}

/**
 * Builder options for RenderContextImpl
 */
export interface RenderContextOptions {
  ctx: GPUContext;
  encoder: GPUCommandEncoder;
  camera: GPUCamera;
  /** Scene camera for shadows/culling. If omitted, same as camera. */
  sceneCamera?: GPUCamera;
  scene: Scene | null;
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
  sceneColorTextureCopy?: UnifiedGPUTexture;
  msaaHdrColorTexture?: UnifiedGPUTexture;
  msaaColorTexture?: UnifiedGPUTexture;
  
  // Flags
  useHDR: boolean;
  
  // Unified environment (shadow + IBL)
  sceneEnvironment?: SceneEnvironment;
}

/**
 * Implementation of RenderContext
 */
export class RenderContextImpl implements RenderContext {
  readonly encoder: GPUCommandEncoder;
  readonly ctx: GPUContext;
  readonly scene: Scene | null;
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
  readonly sceneColorTextureCopy?: UnifiedGPUTexture;
  readonly msaaHdrColorTexture?: UnifiedGPUTexture;
  readonly msaaColorTexture?: UnifiedGPUTexture;
  
  // Scene camera (for shadows, culling, shader uniforms)
  readonly sceneCamera: GPUCamera;
  readonly sceneCameraPosition: [number, number, number];
  readonly sceneCameraForward: [number, number, number];
  readonly sceneCameraViewMatrix: Float32Array;
  readonly sceneCameraProjectionMatrix: Float32Array;
  readonly sceneCameraViewProjectionMatrix: Float32Array;
  
  // Unified environment (shadow + IBL)
  readonly sceneEnvironment?: SceneEnvironment;
  
  private depthCopied = false;
  private sceneColorCopied = false;
  
  constructor(opts: RenderContextOptions) {
    this.encoder = opts.encoder;
    this.ctx = opts.ctx;
    this.scene = opts.scene;
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
    this.sceneColorTextureCopy = opts.sceneColorTextureCopy;
    this.msaaHdrColorTexture = opts.msaaHdrColorTexture;
    this.msaaColorTexture = opts.msaaColorTexture;
    
    // Unified environment (shadow + IBL)
    this.sceneEnvironment = opts.sceneEnvironment;
    
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
    
    // Camera forward from view matrix (column-major layout from gl-matrix lookAt):
    // m[2]=-f.x, m[6]=-f.y, m[10]=-f.z where f=normalize(center-eye)
    // So forward = [-m[2], -m[6], -m[10]]
    const forward: [number, number, number] = [
      -this.viewMatrix[2],
      -this.viewMatrix[6],
      -this.viewMatrix[10],
    ];
    const len = Math.sqrt(forward[0] * forward[0] + forward[1] * forward[1] + forward[2] * forward[2]);
    if (len > 0.001) {
      forward[0] /= len;
      forward[1] /= len;
      forward[2] /= len;
    }
    this.cameraForward = forward;
    
    // Scene camera (defaults to view camera if not provided)
    const sc = opts.sceneCamera ?? opts.camera;
    this.sceneCamera = sc;
    
    if (sc === opts.camera) {
      // Same camera - reuse computed values
      this.sceneCameraPosition = this.cameraPosition;
      this.sceneCameraForward = this.cameraForward;
      this.sceneCameraViewMatrix = this.viewMatrix;
      this.sceneCameraProjectionMatrix = this.projectionMatrix;
      this.sceneCameraViewProjectionMatrix = this.viewProjectionMatrix;
    } else {
      // Different camera - compute scene camera matrices
      const scViewMat = sc.getViewMatrix();
      const scProjMat = sc.getProjectionMatrix();
      
      this.sceneCameraViewMatrix = new Float32Array(scViewMat);
      this.sceneCameraProjectionMatrix = new Float32Array(scProjMat);
      
      this.sceneCameraViewProjectionMatrix = new Float32Array(16);
      mat4.multiply(
        this.sceneCameraViewProjectionMatrix as unknown as mat4,
        scProjMat as mat4,
        scViewMat as mat4
      );
      
      const scPos = sc.getPosition();
      this.sceneCameraPosition = [scPos[0], scPos[1], scPos[2]];
      
      const scFwd: [number, number, number] = [
        -this.sceneCameraViewMatrix[2],
        -this.sceneCameraViewMatrix[6],
        -this.sceneCameraViewMatrix[10],
      ];
      const scLen = Math.sqrt(scFwd[0] * scFwd[0] + scFwd[1] * scFwd[1] + scFwd[2] * scFwd[2]);
      if (scLen > 0.001) {
        scFwd[0] /= scLen;
        scFwd[1] /= scLen;
        scFwd[2] /= scLen;
      }
      this.sceneCameraForward = scFwd;
    }
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
   * Get color attachment that renders directly to swap chain backbuffer
   * Used by viewport passes (gizmos, grid, debug) that render AFTER post-processing
   * Always targets the swap chain, never the HDR intermediate buffer
   */
  getBackbufferColorAttachment(loadOp: 'clear' | 'load'): GPURenderPassColorAttachment {
    // Viewport passes always render to the final swap chain
    // No MSAA for viewport passes - they render on top of the composited result
    return {
      view: this.outputView,
      clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
      loadOp,
      storeOp: 'store',
    };
  }
  
  /**
   * Get depth attachment for render pass
   * Uses reversed-Z clear value (0.0) since near=1, far=0
   */
  getDepthAttachment(loadOp: 'clear' | 'load'): GPURenderPassDepthStencilAttachment {
    return {
      view: this.depthTexture.view,
      depthClearValue: 0.0,  // Reversed-Z: clear to far plane (0.0)
      depthLoadOp: loadOp,
      depthStoreOp: 'store',
    };
  }
  
  /**
   * Copy depth texture for shader reading
   * Only copies once per frame
   */
  copyDepthForReading(): void {
    if (this.depthCopied) {
      return;
    }
    
    this.encoder.copyTextureToTexture(
      { texture: this.depthTexture.texture },
      { texture: this.depthTextureCopy.texture },
      { width: this.width, height: this.height, depthOrArrayLayers: 1 }
    );
    
    this.depthCopied = true;
  }
  
  /**
   * Copy scene color texture for shader reading (e.g., water refraction)
   * Only copies once per frame. Requires sceneColorTexture and sceneColorTextureCopy.
   */
  copySceneColorForReading(): void {
    if (this.sceneColorCopied) {
      return;
    }
    
    if (!this.sceneColorTexture || !this.sceneColorTextureCopy) {
      return;
    }
    
    this.encoder.copyTextureToTexture(
      { texture: this.sceneColorTexture.texture },
      { texture: this.sceneColorTextureCopy.texture },
      { width: this.width, height: this.height, depthOrArrayLayers: 1 }
    );
    
    this.sceneColorCopied = true;
  }
}
