/**
 * ForwardPipeline - Forward rendering pipeline implementation
 * Renders scene with shadow pass → depth prepass → sky → opaque → post-process → overlay
 */

import type { PipelineConfig, RenderContext, RenderObject } from './types';
import { RenderPipeline } from './RenderPipeline';
import { RenderPass, PassPriority } from './RenderPass';
import type { 
  ShadowRenderer, 
  DepthPrePassRenderer, 
  SkyRenderer, 
  GridRenderer, 
  OriginMarkerRenderer 
} from '../index';
import { ContactShadowRenderer } from '../ContactShadowRenderer';
import { TerrainRenderer, TerrainShadowRenderer } from '../TerrainRenderer';
import type { TerrainObject } from '../../sceneObjects';
import type { DirectionalLightParams } from '../../sceneObjects/lights';
import type { Vec3 } from '../../types';

/**
 * Forward rendering pipeline configuration
 */
export interface ForwardPipelineConfig extends PipelineConfig {
  // Existing renderers can be passed in (for gradual migration)
  shadowRenderer?: ShadowRenderer;
  depthPrePassRenderer?: DepthPrePassRenderer;
  skyRenderer?: SkyRenderer;
  gridRenderer?: GridRenderer;
  originMarkerRenderer?: OriginMarkerRenderer;
}

/**
 * Shadow Pass - Renders shadow map from light's perspective
 */
class ShadowPass extends RenderPass {
  private shadowRenderer: ShadowRenderer;
  private terrainShadowRenderer: TerrainShadowRenderer;
  
  constructor(gl: WebGL2RenderingContext, shadowRenderer: ShadowRenderer) {
    super(gl, 'shadow', PassPriority.SHADOW);
    this.shadowRenderer = shadowRenderer;
    this.terrainShadowRenderer = new TerrainShadowRenderer(gl);
  }
  
  execute(context: RenderContext, objects: RenderObject[]): void {
    // When shadows disabled, clear textures so OpaquePass doesn't use stale data
    if (!context.settings.shadowEnabled || objects.length === 0) {
      context.textures.shadowMap = null;
      context.textures.lightSpaceMatrix = null;
      return;
    }
    if (context.lightParams.type !== 'directional') {
      context.textures.shadowMap = null;
      context.textures.lightSpaceMatrix = null;
      return;
    }
    
    const dirLight = context.lightParams as DirectionalLightParams;
    const sunDir: Vec3 = [...dirLight.direction] as Vec3;
    const shadowCoverage = 5;
    
    this.shadowRenderer.beginShadowPass(sunDir, shadowCoverage);
    
    for (const obj of objects) {
      // Render terrain shadows
      if (obj.terrain) {
        const lightSpaceMatrix = this.shadowRenderer.getLightSpaceMatrix();
        if (lightSpaceMatrix) {
          this.terrainShadowRenderer.render(obj.terrain, lightSpaceMatrix, obj.modelMatrix);
        }
        continue;
      }
      
      if (obj.gpuMeshes && obj.gpuMeshes.length > 0) {
        this.shadowRenderer.renderObject(
          obj.gpuMeshes,
          obj.modelMatrix,
          context.windParams,
          obj.windSettings
        );
      }
    }
    
    this.shadowRenderer.endShadowPass(context.width, context.height);
    
    // Update shared textures
    context.textures.shadowMap = this.shadowRenderer.getTexture();
    context.textures.lightSpaceMatrix = this.shadowRenderer.getLightSpaceMatrix();
  }
  
  setResolution(resolution: number): void {
    this.shadowRenderer.setResolution(resolution);
  }
  
  getTexture(): WebGLTexture | null {
    return this.shadowRenderer.getTexture();
  }
  
  destroy(): void {
    this.shadowRenderer.destroy();
    this.terrainShadowRenderer.destroy();
  }
}

/**
 * Depth Pre-Pass - Renders depth for terrain blend and contact shadows
 */
class DepthPrePass extends RenderPass {
  private depthRenderer: DepthPrePassRenderer;
  
  constructor(gl: WebGL2RenderingContext, depthRenderer: DepthPrePassRenderer) {
    super(gl, 'depth-prepass', PassPriority.DEPTH_PREPASS);
    this.depthRenderer = depthRenderer;
  }
  
  execute(context: RenderContext, objects: RenderObject[]): void {
    if (objects.length === 0) return;
    
    // Check if we need depth prepass
    const hasTerrainBlend = objects.some(o => o.terrainBlendSettings?.enabled);
    const needsDepth = hasTerrainBlend || context.settings.contactShadowEnabled;
    
    if (!needsDepth) return;
    
    this.depthRenderer.beginPass(context.vpMatrix);
    
    for (const obj of objects) {
      if (obj.gpuMeshes && obj.gpuMeshes.length > 0) {
        const isTerrainTarget = obj.terrainBlendSettings?.enabled || false;
        
        this.depthRenderer.renderObject(
          obj.gpuMeshes,
          context.vpMatrix,
          obj.modelMatrix,
          context.windParams,
          obj.windSettings,
          isTerrainTarget
        );
      }
    }
    
    this.depthRenderer.endPass(context.width, context.height);
    
    // Update shared textures
    context.textures.depth = this.depthRenderer.getDepthTexture();
    // terrainDepth is same as depth for now (DepthPrePassRenderer only has one depth texture)
    context.textures.terrainDepth = this.depthRenderer.getDepthTexture();
  }
  
  resize(width: number, height: number): void {
    this.depthRenderer.resize(width, height);
  }
  
  getDepthTexture(): WebGLTexture | null {
    return this.depthRenderer.getDepthTexture();
  }
  
  destroy(): void {
    this.depthRenderer.destroy();
  }
}

/**
 * Sky Pass - Renders sky/environment background
 * Uses Rayleigh/Mie atmospheric scattering for directional light mode
 */
class SkyPass extends RenderPass {
  private skyRenderer: SkyRenderer;
  
  constructor(gl: WebGL2RenderingContext, skyRenderer: SkyRenderer) {
    super(gl, 'sky', PassPriority.SKY);
    this.skyRenderer = skyRenderer;
  }
  
  execute(context: RenderContext, _objects: RenderObject[]): void {
    const isHDR = context.lightParams.type === 'hdr';
    
    if (isHDR && context.textures.hdr) {
      const exposure = (context.lightParams as any).hdrExposure || (context.lightParams as any).exposure || 1.0;
      this.skyRenderer.renderHDRSky(context.vpMatrix, context.textures.hdr, exposure);
    } else if (context.lightParams.type === 'directional') {
      // Get sun direction from directional light params
      const dirLight = context.lightParams as DirectionalLightParams;
      const sunDirection: Vec3 = [...dirLight.direction] as Vec3;
      const sunIntensity = 20.0; // Can be made configurable
      
      this.skyRenderer.renderSunSky(context.vpMatrix, sunDirection, sunIntensity);
    }
  }
  
  destroy(): void {
    this.skyRenderer.destroy();
  }
}

/**
 * Opaque Pass - Renders opaque objects with full lighting
 */
class OpaquePass extends RenderPass {
  private terrainRenderer: TerrainRenderer;
  
  constructor(gl: WebGL2RenderingContext) {
    super(gl, 'opaque', PassPriority.OPAQUE);
    this.terrainRenderer = new TerrainRenderer(gl);
  }
  
  execute(context: RenderContext, objects: RenderObject[]): void {
    // Build complete light params with shared textures
    // Use 'as any' to handle the lightSpaceMatrix null vs undefined difference
    const completeLightParams = {
      ...context.lightParams,
      lightSpaceMatrix: context.textures.lightSpaceMatrix ?? undefined,
      shadowMap: context.textures.shadowMap ?? undefined,
      hdrTexture: context.textures.hdr ?? undefined,
      cameraPos: context.cameraPos,
    } as any;
    
    for (const obj of objects) {
      // Handle terrain objects specially
      if (obj.terrain) {
        const terrain = obj.terrain;
        
        // Choose between clipmap (camera-centered LOD) or static mesh rendering
        if (terrain.clipmapEnabled) {
          // Use clipmap rendering with camera-centered LOD rings
          this.terrainRenderer.renderClipmap(
            terrain,
            context.vpMatrix,
            obj.modelMatrix,
            context.cameraPos,
            obj.isSelected,
            completeLightParams
          );
        } else {
          // Use pre-baked static mesh
          this.terrainRenderer.render(
            terrain,
            context.vpMatrix,
            obj.modelMatrix,
            obj.isSelected,
            context.settings.wireframeMode,
            completeLightParams
          );
        }
        continue;
      }
      
      if (!obj.renderer) continue;
      
      // Build terrain blend params if needed
      let terrainBlendParams = null;
      if (obj.terrainBlendSettings?.enabled && context.textures.depth) {
        terrainBlendParams = {
          enabled: true,
          blendDistance: obj.terrainBlendSettings.blendDistance,
          depthTexture: context.textures.depth,
          screenSize: [context.width, context.height] as [number, number],
          nearPlane: context.nearPlane,
          farPlane: context.farPlane,
        };
      }
      
      obj.renderer.render(
        context.vpMatrix,
        obj.modelMatrix,
        obj.isSelected,
        context.settings.wireframeMode,
        completeLightParams,
        context.windParams,
        obj.windSettings,
        terrainBlendParams
      );
      
      // Render normals if enabled
      if (obj.showNormals && 'renderNormals' in obj.renderer) {
        (obj.renderer as any).renderNormals(context.vpMatrix, obj.modelMatrix);
      }
    }
  }
  
  destroy(): void {
    this.terrainRenderer.destroy();
  }
}

/**
 * Contact Shadow Pass - Screen-space contact shadows
 */
class ContactShadowPass extends RenderPass {
  private contactShadowRenderer: ContactShadowRenderer;
  
  constructor(gl: WebGL2RenderingContext, width: number, height: number) {
    super(gl, 'contact-shadow', PassPriority.POST_PROCESS);
    this.contactShadowRenderer = new ContactShadowRenderer(gl);
    this.contactShadowRenderer.resize(width, height);
  }
  
  execute(context: RenderContext, objects: RenderObject[]): void {
    if (!context.settings.contactShadowEnabled) return;
    if (objects.length === 0) return;
    if (context.lightParams.type !== 'directional') return;
    if (!context.textures.depth) return;
    
    const dirLight = context.lightParams as DirectionalLightParams;
    const sunDir: Vec3 = [...dirLight.direction] as Vec3;
    
    // Update settings
    this.contactShadowRenderer.setSettings(context.settings.contactShadowSettings);
    
    // Render contact shadows
    this.contactShadowRenderer.renderContactShadows(
      context.textures.depth,
      sunDir,
      context.viewMatrix,
      context.projMatrix,
      context.nearPlane,
      context.farPlane
    );
    
    // Update shared texture
    context.textures.contactShadow = this.contactShadowRenderer.getContactShadowTexture();
  }
  
  /**
   * Composite contact shadows with scene
   */
  composite(sceneColorTexture: WebGLTexture, targetFBO: WebGLFramebuffer | null): void {
    this.contactShadowRenderer.composite(sceneColorTexture, targetFBO);
  }
  
  resize(width: number, height: number): void {
    this.contactShadowRenderer.resize(width, height);
  }
  
  destroy(): void {
    this.contactShadowRenderer.destroy();
  }
}

/**
 * Overlay Pass - Grid, axes, origin marker
 */
class OverlayPass extends RenderPass {
  private gridRenderer: GridRenderer | null;
  private originMarkerRenderer: OriginMarkerRenderer | null;
  private originPosition: Vec3 = [0, 0, 0];
  
  constructor(
    gl: WebGL2RenderingContext,
    gridRenderer: GridRenderer | null,
    originMarkerRenderer: OriginMarkerRenderer | null
  ) {
    super(gl, 'overlay', PassPriority.OVERLAY);
    this.gridRenderer = gridRenderer;
    this.originMarkerRenderer = originMarkerRenderer;
  }
  
  setOriginPosition(pos: Vec3): void {
    this.originPosition = pos;
  }
  
  execute(context: RenderContext, _objects: RenderObject[]): void {
    // Grid and axes
    if ((context.settings.showGrid || context.settings.showAxes) && this.gridRenderer) {
      this.gridRenderer.render(context.vpMatrix, {
        showGrid: context.settings.showGrid,
        showAxes: context.settings.showAxes,
      });
    }
    
    // Origin marker
    if (context.settings.showAxes && this.originMarkerRenderer) {
      this.originMarkerRenderer.render(context.vpMatrix, this.originPosition);
    }
  }
  
  destroy(): void {
    this.gridRenderer?.destroy();
    this.originMarkerRenderer?.destroy();
  }
}

/**
 * ForwardPipeline - Complete forward rendering pipeline
 */
export class ForwardPipeline extends RenderPipeline {
  // Pass references for direct access
  private shadowPass: ShadowPass | null = null;
  private depthPrePass: DepthPrePass | null = null;
  private skyPass: SkyPass | null = null;
  private opaquePass: OpaquePass;
  private contactShadowPass: ContactShadowPass;
  private overlayPass: OverlayPass;
  
  constructor(gl: WebGL2RenderingContext, config: ForwardPipelineConfig) {
    super(gl, config);
    
    // Create passes from provided renderers
    if (config.shadowRenderer) {
      this.shadowPass = new ShadowPass(gl, config.shadowRenderer);
      this.addPass(this.shadowPass);
    }
    
    if (config.depthPrePassRenderer) {
      this.depthPrePass = new DepthPrePass(gl, config.depthPrePassRenderer);
      this.addPass(this.depthPrePass);
    }
    
    if (config.skyRenderer) {
      this.skyPass = new SkyPass(gl, config.skyRenderer);
      this.addPass(this.skyPass);
    }
    
    // Always create opaque pass
    this.opaquePass = new OpaquePass(gl);
    this.addPass(this.opaquePass);
    
    // Contact shadow pass
    this.contactShadowPass = new ContactShadowPass(gl, config.width, config.height);
    this.addPass(this.contactShadowPass);
    
    // Overlay pass
    this.overlayPass = new OverlayPass(
      gl,
      config.gridRenderer || null,
      config.originMarkerRenderer || null
    );
    this.addPass(this.overlayPass);
  }
  
  /**
   * Main render method
   */
  render(objects: RenderObject[]): void {
    const gl = this.gl;
    const ctx = this.context;
    
    // Determine if we need FBO for contact shadows
    const useContactShadows = ctx.settings.contactShadowEnabled
      && ctx.lightParams.type === 'directional'
      && objects.length > 0;
    
    // Bind scene FBO if using contact shadows
    const writeFBO = this.getWriteFBO();
    if (useContactShadows && writeFBO) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, writeFBO);
    }
    
    gl.viewport(0, 0, ctx.width, ctx.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    
    // Execute passes in priority order
    for (const pass of this.passes) {
      if (!pass.enabled) continue;
      
      // Skip contact shadow composite - handled separately
      if (pass.name === 'contact-shadow') continue;
      
      pass.execute(ctx, objects);
      
      // Re-bind scene FBO after shadow/depth passes
      if ((pass.name === 'shadow' || pass.name === 'depth-prepass') && useContactShadows && writeFBO) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, writeFBO);
        gl.viewport(0, 0, ctx.width, ctx.height);
      }
    }
    
    // Unbind FBO before contact shadow pass
    if (useContactShadows) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, ctx.width, ctx.height);
      
      // Unbind textures to prevent feedback
      for (let i = 0; i < 4; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
    }
    
    // Contact shadow pass and compositing
    const readColorTexture = this.getReadColorTexture();
    if (useContactShadows && readColorTexture && ctx.textures.depth) {
      // Execute contact shadow pass
      this.contactShadowPass.execute(ctx, objects);
      
      // Composite to screen
      this.contactShadowPass.composite(readColorTexture, null);
      
      // Unbind textures
      for (let i = 0; i < 4; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
    }
  }
  
  /**
   * Set origin position for overlay pass
   */
  setOriginPosition(pos: Vec3): void {
    this.overlayPass.setOriginPosition(pos);
  }
  
  /**
   * Set shadow resolution
   */
  setShadowResolution(resolution: number): void {
    this.shadowPass?.setResolution(resolution);
    this.context.settings.shadowResolution = resolution;
  }
  
  /**
   * Get shadow debug texture
   */
  getShadowTexture(): WebGLTexture | null {
    return this.shadowPass?.getTexture() || null;
  }
  
  /**
   * Get depth texture
   */
  getDepthTexture(): WebGLTexture | null {
    return this.depthPrePass?.getDepthTexture() || null;
  }
}
