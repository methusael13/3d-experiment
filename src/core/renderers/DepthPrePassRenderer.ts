/**
 * DepthPrePassRenderer - Renders scene depth to a texture for terrain/rock intersection blending
 */

import { mat4 } from 'gl-matrix';
import { simplexNoise, windUniforms, windDisplacement } from '../../demos/sceneBuilder/shaderChunks.js';
import type { IDepthPrePassRenderer, GPUMesh, WindParams, ObjectWindSettings } from '../sceneObjects/types';

/**
 * Shader uniform locations
 */
interface ShaderLocations {
  aPosition: number;
  uModelViewProjection: WebGLUniformLocation | null;
  uModel: WebGLUniformLocation | null;
  uWindEnabled: WebGLUniformLocation | null;
  uWindTime: WebGLUniformLocation | null;
  uWindStrength: WebGLUniformLocation | null;
  uWindDirection: WebGLUniformLocation | null;
  uWindTurbulence: WebGLUniformLocation | null;
  uWindType: WebGLUniformLocation | null;
  uWindInfluence: WebGLUniformLocation | null;
  uWindStiffness: WebGLUniformLocation | null;
  uWindAnchorHeight: WebGLUniformLocation | null;
  uWindPhysicsDisplacement: WebGLUniformLocation | null;
}

/**
 * DepthPrePassRenderer - OOP class for depth pre-pass rendering
 */
export class DepthPrePassRenderer implements IDepthPrePassRenderer {
  private readonly gl: WebGL2RenderingContext;
  
  // Dimensions
  private currentWidth: number;
  private currentHeight: number;
  
  // Float texture support
  private readonly useFloatTexture: boolean;
  
  // Shader
  private program: WebGLProgram;
  private vs: WebGLShader;
  private fs: WebGLShader;
  private locations: ShaderLocations;
  
  // Framebuffer resources
  private framebuffer: WebGLFramebuffer | null = null;
  private colorTexture: WebGLTexture | null = null;
  private depthRenderbuffer: WebGLRenderbuffer | null = null;
  
  // Reusable MVP matrix
  private readonly mvpMatrix = mat4.create();

  constructor(gl: WebGL2RenderingContext, width: number, height: number) {
    this.gl = gl;
    this.currentWidth = width;
    this.currentHeight = height;
    
    // Try to enable float texture rendering
    const floatExt = gl.getExtension('EXT_color_buffer_float');
    this.useFloatTexture = !!floatExt;
    
    // Compile shader
    const { program, vs, fs } = this.createShader();
    this.program = program;
    this.vs = vs;
    this.fs = fs;
    this.locations = this.getLocations();
    
    // Initialize framebuffer
    this.createFramebuffer(width, height);
  }
  
  // ============ Shader Sources ============
  
  private getVsSource(): string {
    return `#version 300 es
    precision highp float;
    
    in vec3 aPosition;
    
    uniform mat4 uModelViewProjection;
    uniform mat4 uModel;
    
    // Include shared shader chunks for wind
    ${simplexNoise}
    ${windUniforms}
    ${windDisplacement}
    
    out float vDepth;
    
    void main() {
      vec4 worldPos = uModel * vec4(aPosition, 1.0);
      
      // Calculate height factor for wind
      float heightAboveAnchor = max(0.0, worldPos.y - uWindAnchorHeight);
      float heightFactor = clamp(heightAboveAnchor * 0.5, 0.0, 1.0);
      heightFactor = heightFactor * heightFactor;
      
      // Apply wind displacement
      vec3 windOffset = calcWindDisplacement(worldPos.xyz, heightFactor);
      worldPos.xyz += windOffset;
      
      // Transform to clip space
      mat4 invModel = inverse(uModel);
      vec4 displacedLocal = invModel * worldPos;
      gl_Position = uModelViewProjection * vec4(aPosition, 1.0);
      
      // Apply wind offset in clip space
      vec4 worldOffset = vec4(windOffset, 0.0);
      mat4 vp = uModelViewProjection * inverse(uModel);
      gl_Position += vp * worldOffset;
      
      // Pass linear depth (will be stored as gl_FragCoord.z)
      vDepth = gl_Position.z / gl_Position.w;
    }`;
  }
  
  private getFsSource(): string {
    return `#version 300 es
    precision highp float;
    
    in float vDepth;
    out vec4 fragColor;
    
    void main() {
      // Store depth as linear value in color texture
      // Using gl_FragCoord.z for hardware depth buffer compatibility
      float depth = gl_FragCoord.z;
      fragColor = vec4(depth, depth, depth, 1.0);
    }`;
  }
  
  // ============ Shader Compilation ============
  
  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Depth pre-pass shader error:', gl.getShaderInfoLog(shader));
    }
    return shader;
  }
  
  private createProgramFromShaders(vs: WebGLShader, fs: WebGLShader): WebGLProgram {
    const gl = this.gl;
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Depth pre-pass program link error:', gl.getProgramInfoLog(program));
    }
    return program;
  }
  
  private createShader() {
    const vs = this.compileShader(this.gl.VERTEX_SHADER, this.getVsSource());
    const fs = this.compileShader(this.gl.FRAGMENT_SHADER, this.getFsSource());
    const program = this.createProgramFromShaders(vs, fs);
    return { program, vs, fs };
  }
  
  // ============ Uniform Locations ============
  
  private getLocations(): ShaderLocations {
    const gl = this.gl;
    const p = this.program;
    return {
      aPosition: gl.getAttribLocation(p, 'aPosition'),
      uModelViewProjection: gl.getUniformLocation(p, 'uModelViewProjection'),
      uModel: gl.getUniformLocation(p, 'uModel'),
      uWindEnabled: gl.getUniformLocation(p, 'uWindEnabled'),
      uWindTime: gl.getUniformLocation(p, 'uWindTime'),
      uWindStrength: gl.getUniformLocation(p, 'uWindStrength'),
      uWindDirection: gl.getUniformLocation(p, 'uWindDirection'),
      uWindTurbulence: gl.getUniformLocation(p, 'uWindTurbulence'),
      uWindType: gl.getUniformLocation(p, 'uWindType'),
      uWindInfluence: gl.getUniformLocation(p, 'uWindInfluence'),
      uWindStiffness: gl.getUniformLocation(p, 'uWindStiffness'),
      uWindAnchorHeight: gl.getUniformLocation(p, 'uWindAnchorHeight'),
      uWindPhysicsDisplacement: gl.getUniformLocation(p, 'uWindPhysicsDisplacement'),
    };
  }
  
  // ============ Framebuffer Management ============
  
  private createFramebuffer(w: number, h: number): void {
    const gl = this.gl;
    
    // Clean up existing
    if (this.depthRenderbuffer) gl.deleteRenderbuffer(this.depthRenderbuffer);
    if (this.colorTexture) gl.deleteTexture(this.colorTexture);
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
    
    this.currentWidth = w;
    this.currentHeight = h;
    
    // Create color texture to store depth values
    this.colorTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.colorTexture);
    
    if (this.useFloatTexture) {
      // High precision float texture (requires EXT_color_buffer_float)
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.R32F,
        this.currentWidth, this.currentHeight, 0,
        gl.RED, gl.FLOAT, null
      );
    } else {
      // Fallback to RGBA8 - encode depth in RGB channels
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA8,
        this.currentWidth, this.currentHeight, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, null
      );
    }
    
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    
    // Create depth renderbuffer
    this.depthRenderbuffer = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRenderbuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, this.currentWidth, this.currentHeight);
    
    // Create framebuffer
    this.framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.colorTexture, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthRenderbuffer);
    
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      console.error('Depth pre-pass framebuffer incomplete:', status);
    }
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  
  // ============ Public API (IDepthPrePassRenderer) ============
  
  getDepthTexture(): WebGLTexture | null {
    return this.colorTexture;
  }
  
  resize(w: number, h: number): void {
    if (w !== this.currentWidth || h !== this.currentHeight) {
      this.createFramebuffer(w, h);
    }
  }
  
  beginPass(vpMatrix: mat4 | Float32Array): void {
    const gl = this.gl;
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.currentWidth, this.currentHeight);
    
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.clearColor(1.0, 1.0, 1.0, 1.0); // Clear to far depth (1.0)
    gl.clearDepth(1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    
    gl.useProgram(this.program);
  }
  
  renderObject(
    gpuMeshes: GPUMesh[],
    vpMatrix: mat4 | Float32Array,
    modelMatrix: mat4 | Float32Array,
    windParams: WindParams | null = null,
    objectWindSettings: ObjectWindSettings | null = null,
    isTerrainBlendTarget = false
  ): void {
    // Objects with terrain blend enabled should NOT write to depth pre-pass
    // They will sample this depth buffer instead
    if (isTerrainBlendTarget) return;
    
    const gl = this.gl;
    const loc = this.locations;
    
    mat4.multiply(this.mvpMatrix, vpMatrix as mat4, modelMatrix as mat4);
    gl.uniformMatrix4fv(loc.uModelViewProjection, false, this.mvpMatrix);
    gl.uniformMatrix4fv(loc.uModel, false, modelMatrix);
    
    // Set wind uniforms
    const wind = windParams || { enabled: false, time: 0, strength: 0, direction: [1, 0] as [number, number], turbulence: 0.5 };
    const objWind = objectWindSettings || { enabled: false, influence: 1.0, stiffness: 0.5, anchorHeight: 0, leafMaterialIndices: new Set<number>(), branchMaterialIndices: new Set<number>() };
    
    const windActive = wind.enabled && objWind.enabled;
    gl.uniform1i(loc.uWindEnabled, windActive ? 1 : 0);
    gl.uniform1f(loc.uWindTime, wind.time || 0);
    gl.uniform1f(loc.uWindStrength, wind.strength || 0);
    gl.uniform2fv(loc.uWindDirection, wind.direction || [1, 0]);
    gl.uniform1f(loc.uWindTurbulence, wind.turbulence || 0.5);
    gl.uniform1f(loc.uWindInfluence, objWind.influence || 1.0);
    gl.uniform1f(loc.uWindStiffness, objWind.stiffness || 0.5);
    gl.uniform1f(loc.uWindAnchorHeight, objWind.anchorHeight || 0);
    gl.uniform2fv(loc.uWindPhysicsDisplacement, objWind.displacement || [0, 0]);
    
    for (const mesh of gpuMeshes) {
      // Determine wind type for this mesh
      let windType = 0;
      if (windActive) {
        if (objWind.leafMaterialIndices?.has(mesh.materialIndex)) {
          windType = 1;
        } else if (objWind.branchMaterialIndices?.has(mesh.materialIndex)) {
          windType = 2;
        }
      }
      gl.uniform1i(loc.uWindType, windType);
      
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.posBuffer);
      gl.enableVertexAttribArray(loc.aPosition);
      gl.vertexAttribPointer(loc.aPosition, 3, gl.FLOAT, false, 0, 0);
      
      if (mesh.indexBuffer) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indexBuffer);
        gl.drawElements(gl.TRIANGLES, mesh.indexCount, mesh.indexType, 0);
      } else {
        gl.drawArrays(gl.TRIANGLES, 0, mesh.vertexCount);
      }
      
      gl.disableVertexAttribArray(loc.aPosition);
    }
  }
  
  endPass(canvasWidth: number, canvasHeight: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasWidth, canvasHeight);
  }
  
  destroy(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteShader(this.vs);
    gl.deleteShader(this.fs);
    if (this.depthRenderbuffer) gl.deleteRenderbuffer(this.depthRenderbuffer);
    if (this.colorTexture) gl.deleteTexture(this.colorTexture);
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
  }
}

/**
 * Factory function for backward compatibility
 * @deprecated Use `new DepthPrePassRenderer(gl, width, height)` instead
 */
export function createDepthPrePassRenderer(gl: WebGL2RenderingContext, width: number, height: number): DepthPrePassRenderer {
  return new DepthPrePassRenderer(gl, width, height);
}
