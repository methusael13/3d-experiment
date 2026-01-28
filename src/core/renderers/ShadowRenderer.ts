/**
 * ShadowRenderer - Creates depth framebuffer and renders shadow map from sun perspective
 */

import { mat4, vec3 } from 'gl-matrix';
import { simplexNoise, windUniforms, windDisplacement } from '../../demos/sceneBuilder/shaderChunks.js';
import type { IShadowRenderer, GPUMesh, WindParams, ObjectWindSettings } from '../sceneObjects/types';

/**
 * Shader uniform locations
 */
interface ShaderLocations {
  aPosition: number;
  uLightSpaceMatrix: WebGLUniformLocation | null;
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

interface DebugLocations {
  aPosition: number;
  uViewport: WebGLUniformLocation | null;
  uScreenSize: WebGLUniformLocation | null;
  uDepthTexture: WebGLUniformLocation | null;
}

/**
 * ShadowRenderer - OOP class for shadow map generation
 */
export class ShadowRenderer implements IShadowRenderer {
  private readonly gl: WebGL2RenderingContext;
  
  // Resolution
  private resolution: number;
  
  // Main depth shader
  private program: WebGLProgram;
  private vs: WebGLShader;
  private fs: WebGLShader;
  private locations: ShaderLocations;
  
  // Debug thumbnail shader
  private debugProgram: WebGLProgram;
  private debugVs: WebGLShader;
  private debugFs: WebGLShader;
  private debugLocations: DebugLocations;
  
  // Framebuffer resources
  private framebuffer: WebGLFramebuffer | null = null;
  private colorTexture: WebGLTexture | null = null;
  private depthRenderbuffer: WebGLRenderbuffer | null = null;
  private depthTexture: WebGLTexture | null = null;
  
  // Debug quad buffer
  private quadBuffer: WebGLBuffer;
  
  // Light space matrices
  private readonly lightViewMatrix = mat4.create();
  private readonly lightProjMatrix = mat4.create();
  private readonly lightSpaceMatrix = mat4.create();
  
  // Debug flag
  private debugLogged = false;

  constructor(gl: WebGL2RenderingContext, initialResolution = 2048) {
    this.gl = gl;
    this.resolution = initialResolution;
    
    // Compile main depth shader
    const { program, vs, fs } = this.createDepthShader();
    this.program = program;
    this.vs = vs;
    this.fs = fs;
    this.locations = this.getLocations();
    
    // Compile debug shader
    const { program: debugProg, vs: debugV, fs: debugF } = this.createDebugShader();
    this.debugProgram = debugProg;
    this.debugVs = debugV;
    this.debugFs = debugF;
    this.debugLocations = this.getDebugLocations();
    
    // Create quad buffer for debug rendering
    this.quadBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 0,  1, 0,  0, 1,
      1, 0,  1, 1,  0, 1,
    ]), gl.STATIC_DRAW);
    
    // Initialize framebuffer
    this.createFramebuffer(this.resolution);
  }
  
  // ============ Shader Sources ============
  
  private getDepthVsSource(): string {
    return `#version 300 es
    precision highp float;
    
    in vec3 aPosition;
    
    uniform mat4 uLightSpaceMatrix;
    uniform mat4 uModel;
    
    // Include shared shader chunks
    ${simplexNoise}
    ${windUniforms}
    ${windDisplacement}
    
    void main() {
      vec4 worldPos = uModel * vec4(aPosition, 1.0);
      
      // Calculate height factor for wind
      float heightAboveAnchor = max(0.0, worldPos.y - uWindAnchorHeight);
      float heightFactor = clamp(heightAboveAnchor * 0.5, 0.0, 1.0);
      heightFactor = heightFactor * heightFactor;
      
      // Apply wind displacement
      vec3 windOffset = calcWindDisplacement(worldPos.xyz, heightFactor);
      worldPos.xyz += windOffset;
      
      gl_Position = uLightSpaceMatrix * worldPos;
    }`;
  }
  
  private getDepthFsSource(): string {
    return `#version 300 es
    precision highp float;
    
    out vec4 fragColor;
    
    // Pack float depth into RGBA8 (24-bit precision)
    vec4 packDepth(float depth) {
      const vec4 bitShift = vec4(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0, 1.0);
      const vec4 bitMask = vec4(0.0, 1.0 / 256.0, 1.0 / 256.0, 1.0 / 256.0);
      vec4 res = fract(depth * bitShift);
      res -= res.xxyz * bitMask;
      return res;
    }
    
    void main() {
      // Pack depth into RGBA channels
      fragColor = packDepth(gl_FragCoord.z);
    }`;
  }
  
  private getDebugVsSource(): string {
    return `#version 300 es
    precision highp float;
    
    in vec2 aPosition;
    out vec2 vUV;
    
    uniform vec4 uViewport; // x, y, width, height in pixels
    uniform vec2 uScreenSize;
    
    void main() {
      // Convert from [0,1] quad to screen position
      vec2 pixelPos = uViewport.xy + aPosition * uViewport.zw;
      // Convert to NDC [-1, 1]
      vec2 ndc = (pixelPos / uScreenSize) * 2.0 - 1.0;
      gl_Position = vec4(ndc, 0.0, 1.0);
      vUV = aPosition;
    }`;
  }
  
  private getDebugFsSource(): string {
    return `#version 300 es
    precision highp float;
    
    in vec2 vUV;
    uniform sampler2D uDepthTexture;
    out vec4 fragColor;
    
    // Unpack depth from RGBA8
    float unpackDepth(vec4 rgba) {
      const vec4 bitShift = vec4(1.0 / (256.0 * 256.0 * 256.0), 1.0 / (256.0 * 256.0), 1.0 / 256.0, 1.0);
      return dot(rgba, bitShift);
    }
    
    void main() {
      vec4 packed = texture(uDepthTexture, vUV);
      float depth = unpackDepth(packed);
      fragColor = vec4(vec3(depth), 1.0);
    }`;
  }
  
  // ============ Shader Compilation ============
  
  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shadow shader error:', gl.getShaderInfoLog(shader));
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
      console.error('Shadow program link error:', gl.getProgramInfoLog(program));
    }
    return program;
  }
  
  private createDepthShader() {
    const vs = this.compileShader(this.gl.VERTEX_SHADER, this.getDepthVsSource());
    const fs = this.compileShader(this.gl.FRAGMENT_SHADER, this.getDepthFsSource());
    const program = this.createProgramFromShaders(vs, fs);
    return { program, vs, fs };
  }
  
  private createDebugShader() {
    const vs = this.compileShader(this.gl.VERTEX_SHADER, this.getDebugVsSource());
    const fs = this.compileShader(this.gl.FRAGMENT_SHADER, this.getDebugFsSource());
    const program = this.createProgramFromShaders(vs, fs);
    return { program, vs, fs };
  }
  
  // ============ Uniform Locations ============
  
  private getLocations(): ShaderLocations {
    const gl = this.gl;
    const p = this.program;
    return {
      aPosition: gl.getAttribLocation(p, 'aPosition'),
      uLightSpaceMatrix: gl.getUniformLocation(p, 'uLightSpaceMatrix'),
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
  
  private getDebugLocations(): DebugLocations {
    const gl = this.gl;
    const p = this.debugProgram;
    return {
      aPosition: gl.getAttribLocation(p, 'aPosition'),
      uViewport: gl.getUniformLocation(p, 'uViewport'),
      uScreenSize: gl.getUniformLocation(p, 'uScreenSize'),
      uDepthTexture: gl.getUniformLocation(p, 'uDepthTexture'),
    };
  }
  
  // ============ Framebuffer Management ============
  
  private createFramebuffer(size: number): void {
    const gl = this.gl;
    
    // Clean up existing
    if (this.colorTexture) gl.deleteTexture(this.colorTexture);
    if (this.depthRenderbuffer) gl.deleteRenderbuffer(this.depthRenderbuffer);
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
    
    this.resolution = size;
    
    // Create color texture to store depth values (RGBA8 for compatibility)
    this.colorTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.colorTexture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA8,
      this.resolution, this.resolution, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null
    );
    
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    
    // Create depth renderbuffer for depth testing during shadow pass
    this.depthRenderbuffer = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRenderbuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, this.resolution, this.resolution);
    
    // Create framebuffer
    this.framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.colorTexture, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthRenderbuffer);
    
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      console.error('Shadow framebuffer incomplete:', status);
    }
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    
    // Store color texture as the shadow map
    this.depthTexture = this.colorTexture;
  }
  
  // ============ Light Matrix Calculation ============
  
  private calculateLightMatrix(sunDir: vec3 | number[], sceneSize: number, cameraPos?: vec3 | number[]): mat4 {
    // Center shadow frustum around camera position (or origin if not provided)
    const center: vec3 = cameraPos 
      ? [cameraPos[0] as number, 0, cameraPos[2] as number]  // Use camera XZ, but keep Y at ground level
      : [0, 0, 0];
    
    // Light position: far away in the direction of the sun, offset from center
    const lightDistance = sceneSize * 2;
    const lightPos: vec3 = [
      center[0] + (sunDir[0] as number) * lightDistance,
      center[1] + (sunDir[1] as number) * lightDistance,
      center[2] + (sunDir[2] as number) * lightDistance,
    ];
    
    // Light looks at the center point (camera position projected to ground)
    const target: vec3 = [...center];
    
    // Up vector (handle case when sun is directly above/below)
    let up: vec3 = [0, 1, 0];
    if (Math.abs(sunDir[1] as number) > 0.99) {
      up = [0, 0, 1];
    }
    
    // View matrix
    mat4.lookAt(this.lightViewMatrix, lightPos, target, up);
    
    // Orthographic projection covering scene
    const halfSize = sceneSize;
    const near = 1;
    const far = lightDistance * 2 + sceneSize * 2;
    
    mat4.ortho(this.lightProjMatrix, -halfSize, halfSize, -halfSize, halfSize, near, far);
    
    // Combined light space matrix
    mat4.multiply(this.lightSpaceMatrix, this.lightProjMatrix, this.lightViewMatrix);
    
    return this.lightSpaceMatrix;
  }
  
  // ============ Public API (IShadowRenderer) ============
  
  getTexture(): WebGLTexture | null {
    return this.depthTexture;
  }
  
  getLightSpaceMatrix(): mat4 {
    return this.lightSpaceMatrix;
  }
  
  getResolution(): number {
    return this.resolution;
  }
  
  setResolution(newResolution: number): void {
    if (newResolution !== this.resolution) {
      this.createFramebuffer(newResolution);
    }
  }
  
  beginShadowPass(sunDir: vec3 | number[], sceneSize = 20, cameraPos?: vec3 | number[]): void {
    const gl = this.gl;
    
    this.calculateLightMatrix(sunDir, sceneSize, cameraPos);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.resolution, this.resolution);
    
    // Ensure depth testing is enabled and clear to far (1.0)
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.clearColor(1.0, 1.0, 1.0, 1.0); // Clear to 1.0 (far)
    gl.clearDepth(1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    
    // Disable culling during shadow pass to catch all geometry
    gl.disable(gl.CULL_FACE);
    
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.locations.uLightSpaceMatrix, false, this.lightSpaceMatrix);
  }
  
  renderObject(
    gpuMeshes: GPUMesh[],
    modelMatrix: mat4 | Float32Array,
    windParams: WindParams | null = null,
    objectWindSettings: ObjectWindSettings | null = null
  ): void {
    const gl = this.gl;
    const loc = this.locations;
    
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
    
    if (!this.debugLogged) {
      console.log('Shadow pass rendering', gpuMeshes.length, 'meshes');
      console.log('Light space matrix:', Array.from(this.lightSpaceMatrix));
      console.log('Model matrix:', Array.from(modelMatrix as Float32Array));
      this.debugLogged = true;
    }
    
    for (const mesh of gpuMeshes) {
      // Determine wind type for this mesh based on material index
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
  
  endShadowPass(canvasWidth: number, canvasHeight: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    // Re-enable culling
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
  }
  
  renderDebugThumbnail(x: number, y: number, size: number, screenWidth: number, screenHeight: number): void {
    if (!this.depthTexture) return;
    
    const gl = this.gl;
    gl.useProgram(this.debugProgram);
    
    // Disable depth test for overlay
    gl.disable(gl.DEPTH_TEST);
    
    // Set uniforms
    gl.uniform4f(this.debugLocations.uViewport, x, y, size, size);
    gl.uniform2f(this.debugLocations.uScreenSize, screenWidth, screenHeight);
    
    // Bind shadow map texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTexture);
    gl.uniform1i(this.debugLocations.uDepthTexture, 0);
    
    // Draw quad
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(this.debugLocations.aPosition);
    gl.vertexAttribPointer(this.debugLocations.aPosition, 2, gl.FLOAT, false, 0, 0);
    
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    
    gl.disableVertexAttribArray(this.debugLocations.aPosition);
    
    // Re-enable depth test
    gl.enable(gl.DEPTH_TEST);
  }
  
  destroy(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteProgram(this.debugProgram);
    gl.deleteShader(this.vs);
    gl.deleteShader(this.fs);
    gl.deleteShader(this.debugVs);
    gl.deleteShader(this.debugFs);
    gl.deleteBuffer(this.quadBuffer);
    if (this.colorTexture) gl.deleteTexture(this.colorTexture);
    if (this.depthRenderbuffer) gl.deleteRenderbuffer(this.depthRenderbuffer);
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
  }
}

/**
 * Factory function for backward compatibility
 * @deprecated Use `new ShadowRenderer(gl, resolution)` instead
 */
export function createShadowRenderer(gl: WebGL2RenderingContext, initialResolution = 2048): ShadowRenderer {
  return new ShadowRenderer(gl, initialResolution);
}
