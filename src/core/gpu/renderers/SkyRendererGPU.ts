/**
 * SkyRendererGPU - WebGPU port of SkyRenderer
 * 
 * Renders procedural sky gradient (Rayleigh/Mie scattering) or HDR equirectangular background.
 */

import { mat4 } from 'gl-matrix';
import { GPUContext } from '../GPUContext';
import { UnifiedGPUBuffer } from '../GPUBuffer';
import { UnifiedGPUTexture, SamplerFactory } from '../GPUTexture';
import { RenderPipelineWrapper } from '../GPURenderPipeline';
import { BindGroupLayoutBuilder, BindGroupBuilder } from '../GPUBindGroup';

// Import shader
import skyShader from '../shaders/sky.wgsl?raw';

/**
 * Sky renderer for sun mode (procedural gradient) and HDR mode (equirectangular)
 */
export class SkyRendererGPU {
  private ctx: GPUContext;
  
  // Sun mode resources
  private sunPipeline: RenderPipelineWrapper;
  private sunBindGroupLayout: GPUBindGroupLayout;
  private sunBindGroup: GPUBindGroup;
  
  // HDR mode resources
  private hdrPipeline: RenderPipelineWrapper;
  private hdrBindGroupLayout: GPUBindGroupLayout;
  private hdrBindGroup: GPUBindGroup | null = null;
  private hdrTexture: UnifiedGPUTexture | null = null;
  private hdrSampler: GPUSampler;
  private dummyTexture: UnifiedGPUTexture;
  
  // Shared uniform buffer
  // Layout: mat4x4f (64) + vec3f (12) + f32 (4) = 80 bytes, aligned to 16 = 80
  private uniformBuffer: UnifiedGPUBuffer;
  
  // Cached inverse VP matrix
  private invVpMatrix = mat4.create();
  
  constructor(ctx: GPUContext) {
    this.ctx = ctx;
    
    // Create uniform buffer (80 bytes, aligned)
    this.uniformBuffer = UnifiedGPUBuffer.createUniform(ctx, {
      label: 'sky-uniforms',
      size: 80,
    });
    
    // Create samplers
    this.hdrSampler = SamplerFactory.linear(ctx, 'sky-hdr-sampler');
    
    // Create dummy texture for initial HDR bind group
    this.dummyTexture = UnifiedGPUTexture.create2D(ctx, {
      label: 'sky-dummy-texture',
      width: 1,
      height: 1,
      format: 'rgba8unorm',
    });
    
    // Create sun mode bind group layout (uniform only)
    this.sunBindGroupLayout = new BindGroupLayoutBuilder('sky-sun-layout')
      .uniformBuffer(0, 'all')
      .build(ctx);
    
    // Create sun mode pipeline (rgba16float for HDR rendering)
    this.sunPipeline = RenderPipelineWrapper.create(ctx, {
      label: 'sky-sun-pipeline',
      vertexShader: skyShader,
      fragmentShader: skyShader,
      vertexEntryPoint: 'vs_main',
      fragmentEntryPoint: 'fs_sun',
      vertexBuffers: [], // No vertex buffers - quad in shader
      bindGroupLayouts: [this.sunBindGroupLayout],
      topology: 'triangle-strip',
      cullMode: 'none',
      depthFormat: undefined, // No depth test for sky
      depthWriteEnabled: false,
      colorFormats: ['rgba16float'], // HDR intermediate format
    });
    
    // Create sun bind group
    this.sunBindGroup = new BindGroupBuilder('sky-sun-bindgroup')
      .buffer(0, this.uniformBuffer)
      .build(ctx, this.sunBindGroupLayout);
    
    // Create HDR mode bind group layout (uniform + texture + sampler)
    this.hdrBindGroupLayout = new BindGroupLayoutBuilder('sky-hdr-layout')
      .uniformBuffer(0, 'all')
      .texture(1, 'fragment', 'float', '2d')
      .sampler(2, 'fragment')
      .build(ctx);
    
    // Create HDR pipeline (rgba16float for HDR rendering)
    this.hdrPipeline = RenderPipelineWrapper.create(ctx, {
      label: 'sky-hdr-pipeline',
      vertexShader: skyShader,
      fragmentShader: skyShader,
      vertexEntryPoint: 'vs_main',
      fragmentEntryPoint: 'fs_hdr',
      vertexBuffers: [],
      bindGroupLayouts: [this.hdrBindGroupLayout],
      topology: 'triangle-strip',
      cullMode: 'none',
      depthFormat: undefined,
      depthWriteEnabled: false,
      colorFormats: ['rgba16float'], // HDR intermediate format
    });
    
    // Create initial HDR bind group with dummy texture
    this.updateHDRBindGroup(this.dummyTexture);
  }
  
  /**
   * Update HDR bind group with new texture
   */
  private updateHDRBindGroup(texture: UnifiedGPUTexture): void {
    this.hdrBindGroup = new BindGroupBuilder('sky-hdr-bindgroup')
      .buffer(0, this.uniformBuffer)
      .texture(1, texture)
      .sampler(2, this.hdrSampler)
      .build(this.ctx, this.hdrBindGroupLayout);
  }
  
  /**
   * Update uniforms for rendering
   */
  private updateUniforms(
    vpMatrix: mat4 | Float32Array,
    sunDirection: [number, number, number] | Float32Array,
    sunIntensity: number
  ): void {
    // Compute inverse view-projection
    mat4.invert(this.invVpMatrix, vpMatrix as mat4);
    
    // Pack uniforms: mat4x4f (64) + vec3f (12) + f32 (4)
    const data = new Float32Array(20);
    data.set(this.invVpMatrix as Float32Array, 0); // invViewProjection
    data.set(sunDirection, 16); // sunDirection (vec3f at offset 64 bytes = 16 floats)
    data[19] = sunIntensity; // sunIntensity
    
    this.uniformBuffer.write(this.ctx, data);
  }
  
  /**
   * Render physically-based atmospheric sky using Rayleigh/Mie scattering
   * 
   * @param passEncoder - The render pass encoder
   * @param vpMatrix - View-projection matrix
   * @param sunDirection - Normalized direction towards the sun [x, y, z]
   * @param sunIntensity - Sun intensity multiplier (default 20.0)
   */
  renderSunSky(
    passEncoder: GPURenderPassEncoder,
    vpMatrix: mat4 | Float32Array,
    sunDirection: [number, number, number],
    sunIntensity = 20.0
  ): void {
    this.updateUniforms(vpMatrix, sunDirection, sunIntensity);
    
    passEncoder.setPipeline(this.sunPipeline.pipeline);
    passEncoder.setBindGroup(0, this.sunBindGroup);
    passEncoder.draw(4, 1, 0, 0); // 4 vertices for triangle strip
  }
  
  /**
   * Render sky using sun elevation (convenience wrapper)
   * 
   * @param passEncoder - The render pass encoder
   * @param vpMatrix - View-projection matrix
   * @param sunElevation - Sun elevation in degrees (-90 to 90)
   * @param sunAzimuth - Sun azimuth in degrees (0 = north, 90 = east, default 180 = south)
   * @param sunIntensity - Sun intensity multiplier (default 20.0)
   */
  renderSunSkyFromElevation(
    passEncoder: GPURenderPassEncoder,
    vpMatrix: mat4 | Float32Array,
    sunElevation: number,
    sunAzimuth = 180,
    sunIntensity = 20.0
  ): void {
    // Convert elevation/azimuth to direction vector
    const elevationRad = sunElevation * Math.PI / 180;
    const azimuthRad = sunAzimuth * Math.PI / 180;
    
    const cosElev = Math.cos(elevationRad);
    const sunDirection: [number, number, number] = [
      -Math.sin(azimuthRad) * cosElev,
      Math.sin(elevationRad),
      -Math.cos(azimuthRad) * cosElev,
    ];
    
    this.renderSunSky(passEncoder, vpMatrix, sunDirection, sunIntensity);
  }
  
  /**
   * Set HDR texture for HDR sky mode
   */
  setHDRTexture(texture: UnifiedGPUTexture): void {
    this.hdrTexture = texture;
    this.updateHDRBindGroup(texture);
  }
  
  /**
   * Render HDR equirectangular background
   * 
   * @param passEncoder - The render pass encoder
   * @param vpMatrix - View-projection matrix
   * @param exposure - Exposure multiplier (default 1.0)
   */
  renderHDRSky(
    passEncoder: GPURenderPassEncoder,
    vpMatrix: mat4 | Float32Array,
    exposure = 1.0
  ): void {
    if (!this.hdrTexture || !this.hdrBindGroup) {
      return;
    }
    
    // Use sunIntensity field as exposure for HDR mode
    this.updateUniforms(vpMatrix, [0, 1, 0], exposure);
    
    passEncoder.setPipeline(this.hdrPipeline.pipeline);
    passEncoder.setBindGroup(0, this.hdrBindGroup);
    passEncoder.draw(4, 1, 0, 0);
  }
  
  /**
   * Clean up GPU resources
   */
  destroy(): void {
    this.uniformBuffer.destroy();
    this.dummyTexture.destroy();
  }
}
