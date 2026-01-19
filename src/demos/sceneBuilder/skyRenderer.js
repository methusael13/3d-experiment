/**
 * Sky/Environment Renderer
 * Renders procedural sky gradient (sun mode) or HDR equirectangular background
 */

import { mat4 } from 'gl-matrix';

/**
 * Create sky renderer
 * @param {WebGL2RenderingContext} gl 
 */
export function createSkyRenderer(gl) {
  // Fullscreen quad vertices
  const quadVertices = new Float32Array([
    -1, -1,
     1, -1,
    -1,  1,
     1,  1,
  ]);
  
  const quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);
  
  // ==================== Sun Mode (Procedural Gradient) ====================
  
  const sunVsSource = `#version 300 es
    precision highp float;
    in vec2 aPosition;
    out vec2 vUV;
    void main() {
      vUV = aPosition * 0.5 + 0.5;
      gl_Position = vec4(aPosition, 0.9999, 1.0);
    }
  `;
  
  const sunFsSource = `#version 300 es
    precision mediump float;
    
    uniform float uSunElevation; // -90 to 90 degrees
    
    in vec2 vUV;
    out vec4 fragColor;
    
    void main() {
      float elevation = uSunElevation;
      
      // Sky colors
      vec3 zenithDay = vec3(0.2, 0.5, 0.9);
      vec3 horizonDay = vec3(0.6, 0.75, 0.9);
      vec3 sunsetHorizon = vec3(1.0, 0.5, 0.2);
      vec3 nightZenith = vec3(0.02, 0.02, 0.08);
      vec3 nightHorizon = vec3(0.05, 0.05, 0.1);
      
      // Time of day factor (0 = midnight, 1 = noon)
      float dayFactor = clamp((elevation + 10.0) / 100.0, 0.0, 1.0);
      float sunsetFactor = 1.0 - abs(elevation) / 15.0;
      sunsetFactor = clamp(sunsetFactor, 0.0, 1.0);
      
      // Vertical gradient based on screen Y
      float y = vUV.y;
      
      // Day sky
      vec3 dayColor = mix(horizonDay, zenithDay, y);
      
      // Sunset tint
      vec3 sunsetColor = mix(sunsetHorizon, zenithDay, y * y);
      dayColor = mix(dayColor, sunsetColor, sunsetFactor * 0.6);
      
      // Night sky
      vec3 nightColor = mix(nightHorizon, nightZenith, y);
      
      // Blend day and night
      vec3 skyColor = mix(nightColor, dayColor, dayFactor);
      
      fragColor = vec4(skyColor, 1.0);
    }
  `;
  
  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Sky shader error:', gl.getShaderInfoLog(shader));
      return null;
    }
    return shader;
  }
  
  const sunVs = compileShader(gl.VERTEX_SHADER, sunVsSource);
  const sunFs = compileShader(gl.FRAGMENT_SHADER, sunFsSource);
  
  const sunProgram = gl.createProgram();
  gl.attachShader(sunProgram, sunVs);
  gl.attachShader(sunProgram, sunFs);
  gl.linkProgram(sunProgram);
  
  const sunLocations = {
    aPosition: gl.getAttribLocation(sunProgram, 'aPosition'),
    uSunElevation: gl.getUniformLocation(sunProgram, 'uSunElevation'),
  };
  
  // ==================== HDR Mode (Equirectangular) ====================
  
  const hdrVsSource = `#version 300 es
    precision highp float;
    
    in vec2 aPosition;
    
    uniform mat4 uInvViewProjection;
    
    out vec3 vRayDir;
    
    void main() {
      // Reconstruct ray direction from clip space position
      vec4 nearPoint = uInvViewProjection * vec4(aPosition, -1.0, 1.0);
      vec4 farPoint = uInvViewProjection * vec4(aPosition, 1.0, 1.0);
      nearPoint /= nearPoint.w;
      farPoint /= farPoint.w;
      vRayDir = normalize(farPoint.xyz - nearPoint.xyz);
      
      gl_Position = vec4(aPosition, 0.9999, 1.0);
    }
  `;
  
  const hdrFsSource = `#version 300 es
    precision mediump float;
    
    uniform sampler2D uHdrTexture;
    uniform float uExposure;
    
    in vec3 vRayDir;
    out vec4 fragColor;
    
    const float PI = 3.14159265359;
    
    vec2 dirToEquirect(vec3 dir) {
      float phi = atan(dir.z, dir.x);
      float theta = asin(clamp(dir.y, -1.0, 1.0));
      return vec2(phi / (2.0 * PI) + 0.5, theta / PI + 0.5);
    }
    
    // Simple tone mapping (Reinhard)
    vec3 tonemap(vec3 hdr) {
      return hdr / (hdr + vec3(1.0));
    }
    
    void main() {
      vec3 dir = normalize(vRayDir);
      vec2 uv = dirToEquirect(dir);
      
      vec3 hdrColor = texture(uHdrTexture, uv).rgb * uExposure;
      vec3 ldr = tonemap(hdrColor);
      
      // Gamma correction
      ldr = pow(ldr, vec3(1.0 / 2.2));
      
      fragColor = vec4(ldr, 1.0);
    }
  `;
  
  const hdrVs = compileShader(gl.VERTEX_SHADER, hdrVsSource);
  const hdrFs = compileShader(gl.FRAGMENT_SHADER, hdrFsSource);
  
  const hdrProgram = gl.createProgram();
  gl.attachShader(hdrProgram, hdrVs);
  gl.attachShader(hdrProgram, hdrFs);
  gl.linkProgram(hdrProgram);
  
  const hdrLocations = {
    aPosition: gl.getAttribLocation(hdrProgram, 'aPosition'),
    uInvViewProjection: gl.getUniformLocation(hdrProgram, 'uInvViewProjection'),
    uHdrTexture: gl.getUniformLocation(hdrProgram, 'uHdrTexture'),
    uExposure: gl.getUniformLocation(hdrProgram, 'uExposure'),
  };
  
  const invVpMatrix = mat4.create();
  
  return {
    /**
     * Render procedural sky gradient
     * @param {number} sunElevation - Sun elevation in degrees (-90 to 90)
     */
    renderSunSky(sunElevation) {
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(sunProgram);
      
      // Disable any leftover vertex attributes from other renderers
      for (let i = 1; i < 8; i++) {
        gl.disableVertexAttribArray(i);
      }
      
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.enableVertexAttribArray(sunLocations.aPosition);
      gl.vertexAttribPointer(sunLocations.aPosition, 2, gl.FLOAT, false, 0, 0);
      
      gl.uniform1f(sunLocations.uSunElevation, sunElevation);
      
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      
      gl.disableVertexAttribArray(sunLocations.aPosition);
      gl.enable(gl.DEPTH_TEST);
    },
    
    /**
     * Render HDR equirectangular background
     * @param {Float32Array} vpMatrix - View-projection matrix
     * @param {WebGLTexture} hdrTexture - HDR texture
     * @param {number} exposure - Exposure multiplier (default 1.0)
     */
    renderHDRSky(vpMatrix, hdrTexture, exposure = 1.0) {
      if (!hdrTexture) return;
      
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(hdrProgram);
      
      // Disable any leftover vertex attributes from other renderers
      for (let i = 1; i < 8; i++) {
        gl.disableVertexAttribArray(i);
      }
      
      // Compute inverse view-projection
      mat4.invert(invVpMatrix, vpMatrix);
      
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.enableVertexAttribArray(hdrLocations.aPosition);
      gl.vertexAttribPointer(hdrLocations.aPosition, 2, gl.FLOAT, false, 0, 0);
      
      gl.uniformMatrix4fv(hdrLocations.uInvViewProjection, false, invVpMatrix);
      gl.uniform1f(hdrLocations.uExposure, exposure);
      
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, hdrTexture);
      gl.uniform1i(hdrLocations.uHdrTexture, 0);
      
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      
      gl.disableVertexAttribArray(hdrLocations.aPosition);
      gl.enable(gl.DEPTH_TEST);
    },
    
    destroy() {
      gl.deleteProgram(sunProgram);
      gl.deleteProgram(hdrProgram);
      gl.deleteShader(sunVs);
      gl.deleteShader(sunFs);
      gl.deleteShader(hdrVs);
      gl.deleteShader(hdrFs);
      gl.deleteBuffer(quadBuffer);
    },
  };
}
