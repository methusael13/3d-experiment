/**
 * ContactShadowRenderer - Screen-space contact shadows
 * Ray marches from each pixel toward the light in screen space to detect occlusion
 */

import { mat4, vec3 } from 'gl-matrix';

export interface ContactShadowSettings {
  enabled: boolean;
  maxDistance: number;   // Maximum ray distance in world units
  thickness: number;     // Shadow thickness/softness
  steps: number;         // Ray march steps (8, 16, 32)
  intensity: number;     // Shadow darkness (0-1)
}

const DEFAULT_SETTINGS: ContactShadowSettings = {
  enabled: true,
  maxDistance: 0.5,
  thickness: 0.05,
  steps: 16,
  intensity: 0.6,
};

/**
 * ContactShadowRenderer - Screen-space contact shadow post-process
 */
export class ContactShadowRenderer {
  private readonly gl: WebGL2RenderingContext;
  
  // Settings
  private settings: ContactShadowSettings;
  
  // Framebuffers and textures
  private framebuffer: WebGLFramebuffer | null = null;
  private contactShadowTexture: WebGLTexture | null = null;
  private width = 0;
  private height = 0;
  
  // Shaders
  private program: WebGLProgram;
  private vs: WebGLShader;
  private fs: WebGLShader;
  
  // Composite shader (blend contact shadows with scene)
  private compositeProgram: WebGLProgram;
  private compositeVs: WebGLShader;
  private compositeFs: WebGLShader;
  
  // Uniform locations
  private locations: {
    aPosition: number;
    uDepthTexture: WebGLUniformLocation | null;
    uColorTexture: WebGLUniformLocation | null;
    uLightDir: WebGLUniformLocation | null;
    uViewMatrix: WebGLUniformLocation | null;
    uProjMatrix: WebGLUniformLocation | null;
    uInvProjMatrix: WebGLUniformLocation | null;
    uScreenSize: WebGLUniformLocation | null;
    uNearPlane: WebGLUniformLocation | null;
    uFarPlane: WebGLUniformLocation | null;
    uMaxDistance: WebGLUniformLocation | null;
    uThickness: WebGLUniformLocation | null;
    uSteps: WebGLUniformLocation | null;
    uIntensity: WebGLUniformLocation | null;
  };
  
  private compositeLocations: {
    aPosition: number;
    uColorTexture: WebGLUniformLocation | null;
    uContactShadowTexture: WebGLUniformLocation | null;
  };
  
  // Quad buffer
  private quadBuffer: WebGLBuffer;
  
  // Matrices
  private viewMatrix = mat4.create();
  private projMatrix = mat4.create();
  private invProjMatrix = mat4.create();
  
  constructor(gl: WebGL2RenderingContext, settings: Partial<ContactShadowSettings> = {}) {
    this.gl = gl;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    
    // Compile shaders
    const { program, vs, fs } = this.createContactShadowShader();
    this.program = program;
    this.vs = vs;
    this.fs = fs;
    this.locations = this.getLocations();
    
    const { program: compProg, vs: compVs, fs: compFs } = this.createCompositeShader();
    this.compositeProgram = compProg;
    this.compositeVs = compVs;
    this.compositeFs = compFs;
    this.compositeLocations = this.getCompositeLocations();
    
    // Create fullscreen quad
    this.quadBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1,  -1, 1,
       1, -1,  1,  1,  -1, 1,
    ]), gl.STATIC_DRAW);
  }
  
  // ============ Shader Sources ============
  
  private getContactShadowVsSource(): string {
    return `#version 300 es
    precision highp float;
    
    in vec2 aPosition;
    out vec2 vUV;
    
    void main() {
      gl_Position = vec4(aPosition, 0.0, 1.0);
      vUV = aPosition * 0.5 + 0.5;
    }`;
  }
  
  private getContactShadowFsSource(): string {
    return `#version 300 es
    precision highp float;
    
    uniform sampler2D uDepthTexture;
    uniform vec3 uLightDir;
    uniform mat4 uViewMatrix;
    uniform mat4 uProjMatrix;
    uniform mat4 uInvProjMatrix;
    uniform vec2 uScreenSize;
    uniform float uNearPlane;
    uniform float uFarPlane;
    uniform float uMaxDistance;
    uniform float uThickness;
    uniform int uSteps;
    uniform float uIntensity;
    
    in vec2 vUV;
    out vec4 fragColor;
    
    // Hash function for jitter (pseudo-random based on UV)
    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }
    
    // Linearize depth from depth buffer
    float linearizeDepth(float depth) {
      float z = depth * 2.0 - 1.0;
      return (2.0 * uNearPlane * uFarPlane) / (uFarPlane + uNearPlane - z * (uFarPlane - uNearPlane));
    }
    
    // Reconstruct view-space position from depth
    vec3 viewPosFromDepth(vec2 uv, float depth) {
      vec4 clipPos = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      vec4 viewPos = uInvProjMatrix * clipPos;
      return viewPos.xyz / viewPos.w;
    }
    
    // Reconstruct view-space normal from depth buffer using finite differences
    vec3 reconstructNormal(vec2 uv) {
      vec2 texelSize = 1.0 / uScreenSize;
      
      // Sample depths at neighboring pixels
      float depthC = texture(uDepthTexture, uv).r;
      float depthR = texture(uDepthTexture, uv + vec2(texelSize.x, 0.0)).r;
      float depthU = texture(uDepthTexture, uv + vec2(0.0, texelSize.y)).r;
      
      // Reconstruct positions
      vec3 posC = viewPosFromDepth(uv, depthC);
      vec3 posR = viewPosFromDepth(uv + vec2(texelSize.x, 0.0), depthR);
      vec3 posU = viewPosFromDepth(uv + vec2(0.0, texelSize.y), depthU);
      
      // Compute normal from cross product of tangent vectors
      vec3 tangentX = posR - posC;
      vec3 tangentY = posU - posC;
      
      // In view space, normal points toward camera (positive Z when facing camera)
      // Cross product order: tangentX × tangentY gives outward normal
      vec3 normal = normalize(cross(tangentX, tangentY));
      
      return normal;
    }
    
    // Project view-space position to screen UV
    vec2 projectToScreen(vec3 viewPos) {
      vec4 clipPos = uProjMatrix * vec4(viewPos, 1.0);
      vec3 ndc = clipPos.xyz / clipPos.w;
      return ndc.xy * 0.5 + 0.5;
    }
    
    void main() {
      float depth = texture(uDepthTexture, vUV).r;
      
      // Skip background (far plane)
      if (depth >= 1.0) {
        fragColor = vec4(1.0);
        return;
      }
      
      // Reconstruct view-space position
      vec3 viewPos = viewPosFromDepth(vUV, depth);
      
      // Transform light direction to view space (points TOWARD the light)
      vec3 lightDirView = normalize((uViewMatrix * vec4(uLightDir, 0.0)).xyz);
      
      // Reconstruct surface normal from depth buffer
      vec3 normal = reconstructNormal(vUV);
      
      // Calculate N·L to detect back-facing surfaces
      float NdotL = dot(normal, lightDirView);
      
      // Skip or reduce shadow on surfaces facing away from light (back faces)
      // Use a soft threshold to avoid hard cutoff
      if (NdotL < 0.05) {
        fragColor = vec4(1.0); // No contact shadow on back-facing surfaces
        return;
      }
      
      // Attenuate shadow intensity based on surface angle to light
      // Grazing angles get less shadow to reduce artifacts
      float angleAttenuation = smoothstep(0.05, 0.3, NdotL);
      
      // Ray march AWAY from the light (in shadow direction) to find occluders
      float stepSize = uMaxDistance / float(uSteps);
      float shadow = 0.0;
      
      // Add jitter to break up banding artifacts
      float jitter = hash(vUV * uScreenSize);
      
      for (int i = 3; i <= 32; i++) {
        if (i > uSteps) break;
        
        // Step position OPPOSITE to light direction (toward shadow)
        float t = (float(i) + jitter) * stepSize;
        float bias = 0.01;
        vec3 rayPos = viewPos + lightDirView * (t + bias);
        
        // Project to screen
        vec2 rayUV = projectToScreen(rayPos);
        
        // Check if still on screen
        if (rayUV.x < 0.0 || rayUV.x > 1.0 || rayUV.y < 0.0 || rayUV.y > 1.0) {
          break;
        }
        
        // Sample depth at ray position
        float sampleDepth = texture(uDepthTexture, rayUV).r;
        float sampleLinear = linearizeDepth(sampleDepth);
        float rayLinear = -rayPos.z; // View space Z is negative forward
        
        // Check if ray is BEHIND visible geometry (ray went past the surface toward camera)
        // rayLinear > sampleLinear means: ray point is closer to camera than the surface
        // This indicates the ray has passed through/behind geometry → occluded from light
        float depthDiff = rayLinear - sampleLinear;
        
        // If ray passed behind surface (positive depthDiff) but not too far (within thickness)
        if (depthDiff > 0.0 && depthDiff < uThickness) {
          // Found occlusion - fade based on distance from starting point
          float fadeFactor = 1.0 - float(i) / float(uSteps);
          shadow = max(shadow, fadeFactor * uIntensity * angleAttenuation);
          break;
        }
      }
      
      // Output shadow factor (1 = no shadow, 0 = full shadow)
      fragColor = vec4(vec3(1.0 - shadow), 1.0);
    }`;
  }
  
  private getCompositeVsSource(): string {
    return `#version 300 es
    precision highp float;
    
    in vec2 aPosition;
    out vec2 vUV;
    
    void main() {
      gl_Position = vec4(aPosition, 0.0, 1.0);
      vUV = aPosition * 0.5 + 0.5;
    }`;
  }
  
  private getCompositeFsSource(): string {
    return `#version 300 es
    precision highp float;
    
    uniform sampler2D uColorTexture;
    uniform sampler2D uContactShadowTexture;
    
    in vec2 vUV;
    out vec4 fragColor;
    
    void main() {
      vec4 color = texture(uColorTexture, vUV);
      float shadow = texture(uContactShadowTexture, vUV).r;
      
      // Multiply color by shadow factor
      fragColor = vec4(color.rgb * shadow, color.a);
    }`;
  }
  
  // ============ Shader Compilation ============
  
  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Contact shadow shader error:', gl.getShaderInfoLog(shader));
    }
    return shader;
  }
  
  private createProgram(vs: WebGLShader, fs: WebGLShader): WebGLProgram {
    const gl = this.gl;
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Contact shadow program link error:', gl.getProgramInfoLog(program));
    }
    return program;
  }
  
  private createContactShadowShader() {
    const vs = this.compileShader(this.gl.VERTEX_SHADER, this.getContactShadowVsSource());
    const fs = this.compileShader(this.gl.FRAGMENT_SHADER, this.getContactShadowFsSource());
    const program = this.createProgram(vs, fs);
    return { program, vs, fs };
  }
  
  private createCompositeShader() {
    const vs = this.compileShader(this.gl.VERTEX_SHADER, this.getCompositeVsSource());
    const fs = this.compileShader(this.gl.FRAGMENT_SHADER, this.getCompositeFsSource());
    const program = this.createProgram(vs, fs);
    return { program, vs, fs };
  }
  
  // ============ Uniform Locations ============
  
  private getLocations() {
    const gl = this.gl;
    const p = this.program;
    return {
      aPosition: gl.getAttribLocation(p, 'aPosition'),
      uDepthTexture: gl.getUniformLocation(p, 'uDepthTexture'),
      uColorTexture: gl.getUniformLocation(p, 'uColorTexture'),
      uLightDir: gl.getUniformLocation(p, 'uLightDir'),
      uViewMatrix: gl.getUniformLocation(p, 'uViewMatrix'),
      uProjMatrix: gl.getUniformLocation(p, 'uProjMatrix'),
      uInvProjMatrix: gl.getUniformLocation(p, 'uInvProjMatrix'),
      uScreenSize: gl.getUniformLocation(p, 'uScreenSize'),
      uNearPlane: gl.getUniformLocation(p, 'uNearPlane'),
      uFarPlane: gl.getUniformLocation(p, 'uFarPlane'),
      uMaxDistance: gl.getUniformLocation(p, 'uMaxDistance'),
      uThickness: gl.getUniformLocation(p, 'uThickness'),
      uSteps: gl.getUniformLocation(p, 'uSteps'),
      uIntensity: gl.getUniformLocation(p, 'uIntensity'),
    };
  }
  
  private getCompositeLocations() {
    const gl = this.gl;
    const p = this.compositeProgram;
    return {
      aPosition: gl.getAttribLocation(p, 'aPosition'),
      uColorTexture: gl.getUniformLocation(p, 'uColorTexture'),
      uContactShadowTexture: gl.getUniformLocation(p, 'uContactShadowTexture'),
    };
  }
  
  // ============ Framebuffer Management ============
  
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    
    const gl = this.gl;
    this.width = width;
    this.height = height;
    
    // Clean up existing
    if (this.contactShadowTexture) gl.deleteTexture(this.contactShadowTexture);
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
    
    // Create contact shadow texture
    this.contactShadowTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.contactShadowTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    
    // Create framebuffer
    this.framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.contactShadowTexture, 0);
    
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      console.error('Contact shadow framebuffer incomplete:', status);
    }
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  
  // ============ Settings ============
  
  setSettings(settings: Partial<ContactShadowSettings>): void {
    this.settings = { ...this.settings, ...settings };
  }
  
  getSettings(): ContactShadowSettings {
    return { ...this.settings };
  }
  
  isEnabled(): boolean {
    return this.settings.enabled;
  }
  
  // ============ Rendering ============
  
  /**
   * Render contact shadows
   * @param depthTexture - Scene depth texture
   * @param lightDir - Light direction (world space, toward light)
   * @param viewMatrix - Camera view matrix
   * @param projMatrix - Camera projection matrix
   * @param nearPlane - Camera near plane
   * @param farPlane - Camera far plane
   */
  renderContactShadows(
    depthTexture: WebGLTexture,
    lightDir: vec3 | number[],
    viewMatrix: mat4,
    projMatrix: mat4,
    nearPlane: number,
    farPlane: number
  ): void {
    if (!this.settings.enabled || !this.framebuffer) return;
    
    const gl = this.gl;
    
    // Store matrices
    mat4.copy(this.viewMatrix, viewMatrix);
    mat4.copy(this.projMatrix, projMatrix);
    mat4.invert(this.invProjMatrix, projMatrix);
    
    // Bind framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    
    gl.useProgram(this.program);
    
    // Set uniforms
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, depthTexture);
    gl.uniform1i(this.locations.uDepthTexture, 0);
    
    gl.uniform3fv(this.locations.uLightDir, lightDir as Float32Array);
    gl.uniformMatrix4fv(this.locations.uViewMatrix, false, this.viewMatrix);
    gl.uniformMatrix4fv(this.locations.uProjMatrix, false, this.projMatrix);
    gl.uniformMatrix4fv(this.locations.uInvProjMatrix, false, this.invProjMatrix);
    gl.uniform2f(this.locations.uScreenSize, this.width, this.height);
    gl.uniform1f(this.locations.uNearPlane, nearPlane);
    gl.uniform1f(this.locations.uFarPlane, farPlane);
    gl.uniform1f(this.locations.uMaxDistance, this.settings.maxDistance);
    gl.uniform1f(this.locations.uThickness, this.settings.thickness);
    gl.uniform1i(this.locations.uSteps, this.settings.steps);
    gl.uniform1f(this.locations.uIntensity, this.settings.intensity);
    
    // Draw fullscreen quad
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(this.locations.aPosition);
    gl.vertexAttribPointer(this.locations.aPosition, 2, gl.FLOAT, false, 0, 0);
    
    gl.disable(gl.DEPTH_TEST);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.enable(gl.DEPTH_TEST);
    
    gl.disableVertexAttribArray(this.locations.aPosition);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  
  /**
   * Composite contact shadows with scene color
   * @param colorTexture - Scene color texture
   * @param targetFramebuffer - Target framebuffer (null for screen)
   */
  composite(colorTexture: WebGLTexture, targetFramebuffer: WebGLFramebuffer | null = null): void {
    if (!this.settings.enabled || !this.contactShadowTexture) return;
    
    const gl = this.gl;
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFramebuffer);
    gl.viewport(0, 0, this.width, this.height);
    
    gl.useProgram(this.compositeProgram);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, colorTexture);
    gl.uniform1i(this.compositeLocations.uColorTexture, 0);
    
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.contactShadowTexture);
    gl.uniform1i(this.compositeLocations.uContactShadowTexture, 1);
    
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(this.compositeLocations.aPosition);
    gl.vertexAttribPointer(this.compositeLocations.aPosition, 2, gl.FLOAT, false, 0, 0);
    
    gl.disable(gl.DEPTH_TEST);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.enable(gl.DEPTH_TEST);
    
    gl.disableVertexAttribArray(this.compositeLocations.aPosition);
  }
  
  /**
   * Get contact shadow texture for manual blending
   */
  getContactShadowTexture(): WebGLTexture | null {
    return this.contactShadowTexture;
  }
  
  destroy(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteProgram(this.compositeProgram);
    gl.deleteShader(this.vs);
    gl.deleteShader(this.fs);
    gl.deleteShader(this.compositeVs);
    gl.deleteShader(this.compositeFs);
    gl.deleteBuffer(this.quadBuffer);
    if (this.contactShadowTexture) gl.deleteTexture(this.contactShadowTexture);
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
  }
}
