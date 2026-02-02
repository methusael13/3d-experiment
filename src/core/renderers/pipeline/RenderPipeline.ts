/**
 * RenderPipeline - Base class for rendering pipelines
 * Orchestrates render passes and manages shared resources
 */

import { mat4 } from 'gl-matrix';
import type { Vec3 } from '../../types';
import type { SceneLightingParams } from '../../sceneObjects/lights';
import type { WindParams } from '../../sceneObjects/types';
import type { 
  RenderContext, 
  RenderObject, 
  PipelineConfig, 
  PipelineCamera,
  ContactShadowSettings 
} from './types';
import type { IRenderPass } from './RenderPass';

/**
 * Default contact shadow settings
 */
const DEFAULT_CONTACT_SHADOW_SETTINGS: ContactShadowSettings = {
  enabled: true,
  maxDistance: 0.5,
  thickness: 0.05,
  steps: 16,
  intensity: 0.6,
};

/**
 * Abstract base class for render pipelines
 * Manages passes, context, and shared GPU resources
 */
export abstract class RenderPipeline {
  protected readonly gl: WebGL2RenderingContext;
  protected passes: IRenderPass[] = [];
  
  // Dimensions
  protected width: number;
  protected height: number;
  
  // Current frame context (rebuilt each frame)
  protected context: RenderContext;
  
  // Ping-pong FBOs for post-processing
  protected sceneFBOs: (WebGLFramebuffer | null)[] = [null, null];
  protected sceneColorTextures: (WebGLTexture | null)[] = [null, null];
  protected sceneDepthRB: WebGLRenderbuffer | null = null;
  protected pingPongIndex = 0;
  
  constructor(gl: WebGL2RenderingContext, config: PipelineConfig) {
    this.gl = gl;
    this.width = config.width;
    this.height = config.height;
    
    // Initialize context with default values
    this.context = this.createDefaultContext();
    
    // Initialize FBOs
    this.initFramebuffers();
  }
  
  /**
   * Create default render context
   */
  protected createDefaultContext(): RenderContext {
    return {
      gl: this.gl,
      vpMatrix: mat4.create(),
      viewMatrix: mat4.create(),
      projMatrix: mat4.create(),
      cameraPos: [0, 0, 5],
      nearPlane: 0.1,
      farPlane: 100,
      width: this.width,
      height: this.height,
      lightParams: {
        type: 'directional',
        direction: [0.5, 0.707, 0.5],
        effectiveColor: [1, 1, 1],
        ambient: 0.3,
        castsShadow: true,
        shadowEnabled: true,
      } as any,
      windParams: {
        enabled: false,
        time: 0,
        strength: 0,
        direction: [1, 0],
        turbulence: 0.5,
      },
      textures: {
        depth: null,
        terrainDepth: null,
        shadowMap: null,
        lightSpaceMatrix: null,
        contactShadow: null,
        hdr: null,
        sceneColor: null,
      },
      settings: {
        shadowEnabled: true,
        shadowResolution: 2048,
        contactShadowEnabled: true,
        contactShadowSettings: { ...DEFAULT_CONTACT_SHADOW_SETTINGS },
        wireframeMode: false,
        showGrid: true,
        showAxes: true,
        fpsMode: false
      },
      deltaTime: 0,
      time: 0,
    };
  }
  
  /**
   * Initialize ping-pong framebuffers for post-processing
   */
  protected initFramebuffers(): void {
    const gl = this.gl;
    
    // Shared depth renderbuffer
    this.sceneDepthRB = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.sceneDepthRB);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, this.width, this.height);
    
    // Create two FBOs
    for (let i = 0; i < 2; i++) {
      // Color texture
      const colorTexture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, colorTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.sceneColorTextures[i] = colorTexture;
      
      // FBO
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTexture, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.sceneDepthRB);
      
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        console.error(`Pipeline FBO ${i} incomplete:`, status);
      }
      this.sceneFBOs[i] = fbo;
    }
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  
  /**
   * Get current write framebuffer
   */
  protected getWriteFBO(): WebGLFramebuffer | null {
    return this.sceneFBOs[this.pingPongIndex];
  }
  
  /**
   * Get current read color texture
   */
  protected getReadColorTexture(): WebGLTexture | null {
    return this.sceneColorTextures[this.pingPongIndex];
  }
  
  /**
   * Swap ping-pong buffers
   */
  protected swapPingPong(): void {
    this.pingPongIndex = 1 - this.pingPongIndex;
  }
  
  /**
   * Add a render pass to the pipeline
   */
  addPass(pass: IRenderPass): void {
    this.passes.push(pass);
    this.passes.sort((a, b) => a.priority - b.priority);
  }
  
  /**
   * Remove a pass by name
   */
  removePass(name: string): boolean {
    const index = this.passes.findIndex(p => p.name === name);
    if (index >= 0) {
      const pass = this.passes[index];
      pass.destroy?.();
      this.passes.splice(index, 1);
      return true;
    }
    return false;
  }
  
  /**
   * Get a pass by name
   */
  getPass<T extends IRenderPass>(name: string): T | undefined {
    return this.passes.find(p => p.name === name) as T | undefined;
  }
  
  /**
   * Enable or disable a pass
   */
  setPassEnabled(name: string, enabled: boolean): void {
    const pass = this.getPass(name);
    if (pass) {
      pass.enabled = enabled;
    }
  }
  
  /**
   * Update context for a new frame
   */
  updateContext(
    camera: PipelineCamera,
    lightParams: SceneLightingParams,
    windParams: WindParams,
    deltaTime: number
  ): void {
    const ctx = this.context;
    
    // Update camera matrices
    mat4.copy(ctx.vpMatrix, camera.getViewProjectionMatrix());
    mat4.copy(ctx.viewMatrix, camera.getViewMatrix());
    mat4.copy(ctx.projMatrix, camera.getProjectionMatrix());
    ctx.cameraPos = camera.getPosition();
    ctx.nearPlane = camera.near;
    ctx.farPlane = camera.far;
    
    // Update lighting
    ctx.lightParams = lightParams;
    
    // Update wind
    ctx.windParams = windParams;
    
    // Update frame timing
    ctx.deltaTime = deltaTime;
    ctx.time += deltaTime;
  }
  
  /**
   * Update render settings
   */
  updateSettings(settings: Partial<RenderContext['settings']>): void {
    Object.assign(this.context.settings, settings);
  }
  
  /**
   * Set shared texture (e.g., HDR environment map)
   */
  setTexture(name: keyof RenderContext['textures'], texture: WebGLTexture | mat4 | null): void {
    (this.context.textures as any)[name] = texture;
  }
  
  /**
   * Main render method - must be implemented by subclasses
   */
  abstract render(objects: RenderObject[]): void;
  
  /**
   * Resize the pipeline
   */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    
    this.width = width;
    this.height = height;
    this.context.width = width;
    this.context.height = height;
    
    // Resize FBOs
    this.destroyFramebuffers();
    this.initFramebuffers();
    
    // Notify passes
    for (const pass of this.passes) {
      pass.resize?.(width, height);
    }
  }
  
  /**
   * Cleanup framebuffers
   */
  protected destroyFramebuffers(): void {
    const gl = this.gl;
    
    for (let i = 0; i < 2; i++) {
      if (this.sceneColorTextures[i]) {
        gl.deleteTexture(this.sceneColorTextures[i]);
        this.sceneColorTextures[i] = null;
      }
      if (this.sceneFBOs[i]) {
        gl.deleteFramebuffer(this.sceneFBOs[i]);
        this.sceneFBOs[i] = null;
      }
    }
    
    if (this.sceneDepthRB) {
      gl.deleteRenderbuffer(this.sceneDepthRB);
      this.sceneDepthRB = null;
    }
  }
  
  /**
   * Cleanup all resources
   */
  destroy(): void {
    for (const pass of this.passes) {
      pass.destroy?.();
    }
    this.passes = [];
    this.destroyFramebuffers();
  }
  
  /**
   * Get current context (for passes that need direct access)
   */
  getContext(): RenderContext {
    return this.context;
  }
}
