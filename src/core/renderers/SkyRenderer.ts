/**
 * SkyRenderer - Renders procedural sky gradient or HDR equirectangular background
 */

import { mat4 } from 'gl-matrix';

/**
 * Sky renderer for sun mode (procedural gradient) and HDR mode (equirectangular)
 */
export class SkyRenderer {
  private readonly gl: WebGL2RenderingContext;
  private quadBuffer: WebGLBuffer;
  
  // Sun mode shader
  private sunProgram: WebGLProgram;
  private sunLocations: {
    aPosition: number;
    uSunElevation: WebGLUniformLocation | null;
  };
  
  // HDR mode shader
  private hdrProgram: WebGLProgram;
  private hdrLocations: {
    aPosition: number;
    uInvViewProjection: WebGLUniformLocation | null;
    uHdrTexture: WebGLUniformLocation | null;
    uExposure: WebGLUniformLocation | null;
  };
  
  private invVpMatrix = mat4.create();

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    
    // Fullscreen quad vertices
    const quadVertices = new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
       1,  1,
    ]);

    this.quadBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);

    // Create sun mode shader
    this.sunProgram = this.createSunProgram();
    this.sunLocations = {
      aPosition: gl.getAttribLocation(this.sunProgram, 'aPosition'),
      uSunElevation: gl.getUniformLocation(this.sunProgram, 'uSunElevation'),
    };

    // Create HDR mode shader
    this.hdrProgram = this.createHdrProgram();
    this.hdrLocations = {
      aPosition: gl.getAttribLocation(this.hdrProgram, 'aPosition'),
      uInvViewProjection: gl.getUniformLocation(this.hdrProgram, 'uInvViewProjection'),
      uHdrTexture: gl.getUniformLocation(this.hdrProgram, 'uHdrTexture'),
      uExposure: gl.getUniformLocation(this.hdrProgram, 'uExposure'),
    };
  }

  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Sky shader error:', gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  private createSunProgram(): WebGLProgram {
    const gl = this.gl;

    const vsSource = `#version 300 es
      precision highp float;
      in vec2 aPosition;
      out vec2 vUV;
      void main() {
        vUV = aPosition * 0.5 + 0.5;
        gl_Position = vec4(aPosition, 0.9999, 1.0);
      }
    `;

    const fsSource = `#version 300 es
      precision mediump float;
      
      uniform float uSunElevation;
      
      in vec2 vUV;
      out vec4 fragColor;
      
      void main() {
        float elevation = uSunElevation;
        
        vec3 zenithDay = vec3(0.2, 0.5, 0.9);
        vec3 horizonDay = vec3(0.6, 0.75, 0.9);
        vec3 sunsetHorizon = vec3(1.0, 0.5, 0.2);
        vec3 nightZenith = vec3(0.02, 0.02, 0.08);
        vec3 nightHorizon = vec3(0.05, 0.05, 0.1);
        
        float dayFactor = clamp((elevation + 10.0) / 100.0, 0.0, 1.0);
        float sunsetFactor = 1.0 - abs(elevation) / 15.0;
        sunsetFactor = clamp(sunsetFactor, 0.0, 1.0);
        
        float y = vUV.y;
        
        vec3 dayColor = mix(horizonDay, zenithDay, y);
        vec3 sunsetColor = mix(sunsetHorizon, zenithDay, y * y);
        dayColor = mix(dayColor, sunsetColor, sunsetFactor * 0.6);
        
        vec3 nightColor = mix(nightHorizon, nightZenith, y);
        vec3 skyColor = mix(nightColor, dayColor, dayFactor);
        
        fragColor = vec4(skyColor, 1.0);
      }
    `;

    const vs = this.compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource);

    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    gl.deleteShader(vs);
    gl.deleteShader(fs);

    return program;
  }

  private createHdrProgram(): WebGLProgram {
    const gl = this.gl;

    const vsSource = `#version 300 es
      precision highp float;
      
      in vec2 aPosition;
      uniform mat4 uInvViewProjection;
      out vec3 vRayDir;
      
      void main() {
        vec4 nearPoint = uInvViewProjection * vec4(aPosition, -1.0, 1.0);
        vec4 farPoint = uInvViewProjection * vec4(aPosition, 1.0, 1.0);
        nearPoint /= nearPoint.w;
        farPoint /= farPoint.w;
        vRayDir = normalize(farPoint.xyz - nearPoint.xyz);
        
        gl_Position = vec4(aPosition, 0.9999, 1.0);
      }
    `;

    const fsSource = `#version 300 es
      precision mediump float;
      
      uniform sampler2D uHdrTexture;
      uniform float uExposure;
      
      in vec3 vRayDir;
      out vec4 fragColor;
      
      const float PI = 3.14159265359;
      const float TWO_PI = 6.28318530718;
      
      vec3 tonemap(vec3 hdr) {
        return hdr / (hdr + vec3(1.0));
      }
      
      void main() {
        vec3 dir = normalize(vRayDir);
        
        float phi = atan(dir.z, dir.x);
        float theta = asin(clamp(dir.y, -1.0, 1.0));
        vec2 uv = vec2(phi / TWO_PI + 0.5, 0.5 - theta / PI);
        
        vec2 uvDx = dFdx(uv);
        vec2 uvDy = dFdy(uv);
        
        const float wrapThreshold = 0.5;
        if (abs(uvDx.x) > wrapThreshold) {
          uvDx.x = uvDx.x - sign(uvDx.x);
        }
        if (abs(uvDy.x) > wrapThreshold) {
          uvDy.x = uvDy.x - sign(uvDy.x);
        }
        
        vec3 hdrColor = textureGrad(uHdrTexture, uv, uvDx, uvDy).rgb;
        hdrColor = clamp(hdrColor, 0.0, 65504.0) * uExposure;
        vec3 ldr = tonemap(hdrColor);
        ldr = pow(ldr, vec3(1.0 / 2.2));
        
        fragColor = vec4(ldr, 1.0);
      }
    `;

    const vs = this.compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource);

    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    gl.deleteShader(vs);
    gl.deleteShader(fs);

    return program;
  }

  /**
   * Render procedural sky gradient
   * @param sunElevation - Sun elevation in degrees (-90 to 90)
   */
  renderSunSky(sunElevation: number): void {
    const gl = this.gl;

    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.sunProgram);

    // Disable any leftover vertex attributes from other renderers
    for (let i = 1; i < 8; i++) {
      gl.disableVertexAttribArray(i);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(this.sunLocations.aPosition);
    gl.vertexAttribPointer(this.sunLocations.aPosition, 2, gl.FLOAT, false, 0, 0);

    gl.uniform1f(this.sunLocations.uSunElevation, sunElevation);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.disableVertexAttribArray(this.sunLocations.aPosition);
    gl.enable(gl.DEPTH_TEST);
  }

  /**
   * Render HDR equirectangular background
   * @param vpMatrix - View-projection matrix
   * @param hdrTexture - HDR texture
   * @param exposure - Exposure multiplier (default 1.0)
   */
  renderHDRSky(vpMatrix: mat4, hdrTexture: WebGLTexture | null, exposure = 1.0): void {
    if (!hdrTexture) return;

    const gl = this.gl;

    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.hdrProgram);

    // Disable any leftover vertex attributes from other renderers
    for (let i = 1; i < 8; i++) {
      gl.disableVertexAttribArray(i);
    }

    // Compute inverse view-projection
    mat4.invert(this.invVpMatrix, vpMatrix);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(this.hdrLocations.aPosition);
    gl.vertexAttribPointer(this.hdrLocations.aPosition, 2, gl.FLOAT, false, 0, 0);

    gl.uniformMatrix4fv(this.hdrLocations.uInvViewProjection, false, this.invVpMatrix);
    gl.uniform1f(this.hdrLocations.uExposure, exposure);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, hdrTexture);
    gl.uniform1i(this.hdrLocations.uHdrTexture, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.disableVertexAttribArray(this.hdrLocations.aPosition);
    gl.enable(gl.DEPTH_TEST);
  }

  destroy(): void {
    const gl = this.gl;
    gl.deleteProgram(this.sunProgram);
    gl.deleteProgram(this.hdrProgram);
    gl.deleteBuffer(this.quadBuffer);
  }
}

/**
 * Factory function for backward compatibility
 * @deprecated Use `new SkyRenderer(gl)` instead
 */
export function createSkyRenderer(gl: WebGL2RenderingContext): SkyRenderer {
  return new SkyRenderer(gl);
}
