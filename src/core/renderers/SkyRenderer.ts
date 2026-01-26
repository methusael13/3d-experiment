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
  
  // Sun mode shader (Rayleigh/Mie atmospheric scattering)
  private sunProgram: WebGLProgram;
  private sunLocations: {
    aPosition: number;
    uInvViewProjection: WebGLUniformLocation | null;
    uSunDirection: WebGLUniformLocation | null;
    uSunIntensity: WebGLUniformLocation | null;
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

    // Create sun mode shader (Rayleigh/Mie atmospheric scattering)
    this.sunProgram = this.createSunProgram();
    this.sunLocations = {
      aPosition: gl.getAttribLocation(this.sunProgram, 'aPosition'),
      uInvViewProjection: gl.getUniformLocation(this.sunProgram, 'uInvViewProjection'),
      uSunDirection: gl.getUniformLocation(this.sunProgram, 'uSunDirection'),
      uSunIntensity: gl.getUniformLocation(this.sunProgram, 'uSunIntensity'),
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
      uniform mat4 uInvViewProjection;
      out vec3 vRayDir;
      out vec2 vUV;
      void main() {
        vUV = aPosition * 0.5 + 0.5;
        
        // Reconstruct ray direction from clip space
        vec4 nearPoint = uInvViewProjection * vec4(aPosition, -1.0, 1.0);
        vec4 farPoint = uInvViewProjection * vec4(aPosition, 1.0, 1.0);
        nearPoint /= nearPoint.w;
        farPoint /= farPoint.w;
        vRayDir = normalize(farPoint.xyz - nearPoint.xyz);
        
        gl_Position = vec4(aPosition, 0.9999, 1.0);
      }
    `;

    // Rayleigh/Mie atmospheric scattering shader based on Nishita model
    const fsSource = `#version 300 es
      precision highp float;
      
      uniform vec3 uSunDirection;  // Normalized sun direction (towards sun)
      uniform float uSunIntensity; // Sun intensity multiplier
      
      in vec3 vRayDir;
      in vec2 vUV;
      out vec4 fragColor;
      
      // ============= Atmosphere Constants =============
      const float PI = 3.14159265359;
      
      // Planet and atmosphere radii (in meters)
      const float earthRadius = 6360000.0;      // 6360 km
      const float atmosphereRadius = 6420000.0; // 6420 km (60km atmosphere)
      
      // Rayleigh scattering coefficients at sea level (per meter)
      // These values cause blue light to scatter more than red
      const vec3 betaR = vec3(3.8e-6, 13.5e-6, 33.1e-6);
      
      // Mie scattering coefficient at sea level (per meter)
      // Aerosols scatter all wavelengths equally
      const vec3 betaM = vec3(21e-6);
      
      // Scale heights (altitude where density drops by factor of e)
      const float Hr = 7994.0;  // Rayleigh scale height: ~8km
      const float Hm = 1200.0;  // Mie scale height: ~1.2km
      
      // Mie anisotropy factor (forward scattering)
      const float g = 0.76;
      
      // Number of samples for ray marching
      const int numViewSamples = 16; // 16 originally
      const int numSunSamples = 8; // 8 originally
      
      // ============= Helper Functions =============
      
      // Ray-sphere intersection
      // Returns (t0, t1) where t0 < t1, or (-1, -1) if no intersection
      vec2 raySphereIntersect(vec3 origin, vec3 dir, float radius) {
        float a = dot(dir, dir);
        float b = 2.0 * dot(dir, origin);
        float c = dot(origin, origin) - radius * radius;
        float discriminant = b * b - 4.0 * a * c;
        
        if (discriminant < 0.0) {
          return vec2(-1.0);
        }
        
        float sqrtD = sqrt(discriminant);
        float t0 = (-b - sqrtD) / (2.0 * a);
        float t1 = (-b + sqrtD) / (2.0 * a);
        
        return vec2(t0, t1);
      }
      
      // Rayleigh phase function
      float phaseRayleigh(float cosTheta) {
        return 3.0 / (16.0 * PI) * (1.0 + cosTheta * cosTheta);
      }
      
      // Mie phase function (Henyey-Greenstein)
      float phaseMie(float cosTheta) {
        float g2 = g * g;
        float num = (1.0 - g2) * (1.0 + cosTheta * cosTheta);
        float denom = (2.0 + g2) * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
        return 3.0 / (8.0 * PI) * num / denom;
      }
      
      // ============= Ground Color Computation =============
      
      // Compute a simple atmospheric ground color (aerial perspective on ground)
      vec3 computeGroundColor(vec3 rayDir, vec3 sunDir, vec3 cameraPos) {
        // Base ground color - brownish gray like the reference
        vec3 baseGround = vec3(0.35, 0.32, 0.28);
        
        // Horizon atmospheric tint - sample atmosphere color at horizon
        // This gives the ground a nice atmospheric fade like in the reference
        float sunDot = max(0.0, dot(rayDir, sunDir));
        
        // Sunset/sunrise tint on ground
        float horizonFactor = 1.0 - abs(rayDir.y);
        vec3 sunsetTint = vec3(0.8, 0.5, 0.3) * pow(sunDot, 4.0) * 0.5;
        
        // Daytime atmospheric blue tint
        vec3 skyTint = vec3(0.4, 0.45, 0.5) * (1.0 - sunDot * 0.5);
        
        // Mix ground with atmospheric colors
        vec3 groundColor = baseGround + sunsetTint * horizonFactor + skyTint * 0.2;
        
        // Apply simple ambient occlusion toward center (looking down)
        float aoFactor = 1.0 - pow(max(0.0, -rayDir.y), 2.0) * 0.3;
        groundColor *= aoFactor;
        
        return groundColor * uSunIntensity * 0.015; // Scale to match sky brightness
      }
      
      // ============= Main Scattering Computation =============
      
      vec3 computeAtmosphericScattering(vec3 rayDir, vec3 sunDir, out bool hitGround) {
        // Camera position: 1 meter above Earth surface (like C++ reference)
        // Critical: Higher altitudes lose Mie scattering (Hm=1200m scale height)
        const float cameraAltitude = 1.0; // 1m above surface
        vec3 cameraPos = vec3(0.0, earthRadius + cameraAltitude, 0.0);
        
        // Flat horizon detection (visual simplification)
        // Use Y-direction instead of spherical Earth intersection
        // This decouples the visual horizon from the physics camera altitude
        const float horizonThreshold = -0.01; // Small buffer to avoid z-fighting at horizon
        hitGround = rayDir.y < horizonThreshold;
        
        // Find where ray exits atmosphere
        vec2 atmosphereHit = raySphereIntersect(cameraPos, rayDir, atmosphereRadius);
        
        if (atmosphereHit.x < 0.0 && atmosphereHit.y < 0.0) {
          return vec3(0.0); // No atmosphere intersection
        }
        
        // Ray start and end within atmosphere
        float tMin = max(0.0, atmosphereHit.x);
        float tMax = atmosphereHit.y;
        
        // For ground rays, limit the march distance based on how far down we're looking
        // This approximates looking at distant ground with atmospheric perspective
        if (hitGround) {
          // Calculate approximate ground distance for aerial perspective
          // Steeper down = closer ground, shallower = farther
          float groundDist = cameraAltitude / max(0.001, -rayDir.y);
          tMax = min(tMax, groundDist + 50000.0); // Clamp to reasonable distance
        }
        
        if (tMax <= tMin) {
          return computeGroundColor(rayDir, sunDir, cameraPos);
        }
        
        // Segment length for view ray marching
        float segmentLength = (tMax - tMin) / float(numViewSamples);
        float tCurrent = tMin;
        
        // Accumulated values
        vec3 sumR = vec3(0.0); // Rayleigh contribution
        vec3 sumM = vec3(0.0); // Mie contribution
        float opticalDepthR = 0.0;
        float opticalDepthM = 0.0;
        
        // Phase functions (constant for this ray)
        float mu = dot(rayDir, sunDir);
        float phaseR = phaseRayleigh(mu);
        float phaseM = phaseMie(mu);
        
        // March along view ray
        for (int i = 0; i < numViewSamples; i++) {
          // Sample position (middle of segment)
          vec3 samplePos = cameraPos + rayDir * (tCurrent + segmentLength * 0.5);
          float height = length(samplePos) - earthRadius;
          
          // Density at this height (exponential falloff)
          float hr = exp(-height / Hr) * segmentLength;
          float hm = exp(-height / Hm) * segmentLength;
          
          // Accumulate optical depth along view ray
          opticalDepthR += hr;
          opticalDepthM += hm;
          
          // Compute light contribution at this sample point
          // Cast ray towards sun and find optical depth to atmosphere edge
          vec2 sunAtmosphereHit = raySphereIntersect(samplePos, sunDir, atmosphereRadius);
          float sunRayLength = sunAtmosphereHit.y;
          float sunSegmentLength = sunRayLength / float(numSunSamples);
          
          float opticalDepthLightR = 0.0;
          float opticalDepthLightM = 0.0;
          bool inShadow = false;
          
          // March along sun ray
          for (int j = 0; j < numSunSamples; j++) {
            vec3 sunSamplePos = samplePos + sunDir * (float(j) + 0.5) * sunSegmentLength;
            float sunHeight = length(sunSamplePos) - earthRadius;
            
            // If below Earth surface, this point is in shadow
            if (sunHeight < 0.0) {
              inShadow = true;
              break;
            }
            
            opticalDepthLightR += exp(-sunHeight / Hr) * sunSegmentLength;
            opticalDepthLightM += exp(-sunHeight / Hm) * sunSegmentLength;
          }
          
          if (!inShadow) {
            // Compute transmittance (optical depth combines view + sun ray)
            // Mie extinction is ~1.1x scattering
            vec3 tau = betaR * (opticalDepthR + opticalDepthLightR) + 
                       betaM * 1.1 * (opticalDepthM + opticalDepthLightM);
            vec3 attenuation = exp(-tau);
            
            sumR += attenuation * hr;
            sumM += attenuation * hm;
          }
          
          tCurrent += segmentLength;
        }
        
        // Final color: Rayleigh + Mie contributions
        return (sumR * betaR * phaseR + sumM * betaM * phaseM) * uSunIntensity;
      }

      // Extended Reinhard tone mapping with configurable white point
      // Allows bright highlights (sun) to stay bright while preserving midtones
      vec3 tonemap(vec3 c) {
        float whitePoint = 4.0; // Values above this become near-white
        float wp2 = whitePoint * whitePoint;
        vec3 numerator = c * (1.0 + c / wp2);
        vec3 mapped = numerator / (1.0 + c);
        return mapped;
        // Gamma correction
        return pow(mapped, vec3(1.0 / 2.2));
      }
      
      // ============= Main =============
      
      void main() {
        vec3 rayDir = normalize(vRayDir);
        vec3 sunDir = normalize(uSunDirection);
        
        // Compute atmospheric scattering
        bool hitGround;
        vec3 skyColor = computeAtmosphericScattering(rayDir, sunDir, hitGround);
        
        vec3 color;
        if (hitGround) {
          // For ground, blend atmospheric scattering with ground color
          // Camera position for ground color computation
          const float cameraAltitude = 1.0;
          vec3 cameraPos = vec3(0.0, earthRadius + cameraAltitude, 0.0);
          vec3 groundColor = computeGroundColor(rayDir, sunDir, cameraPos);
          
          // Blend sky scattering (atmospheric haze) with ground
          // The sky color already contains the atmospheric contribution from ray marching
          color = skyColor + groundColor;
        } else {
          color = skyColor;
          
          // Add sun disk (only in sky, not on ground)
          float sunDot = dot(rayDir, sunDir);
          float sunDisk = smoothstep(0.9998, 0.99995, sunDot); // Very tight sun disk
          float sunGlow = pow(max(0.0, sunDot), 256.0) * 2.0;  // Soft glow around sun
          color += vec3(1.0, 0.95, 0.9) * (sunDisk + sunGlow) * uSunIntensity * 0.1;
        }
        
        // Apply ACES Filmic tone mapping + gamma
        color = tonemap(color);
        
        fragColor = vec4(color, 1.0);
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
   * Render physically-based atmospheric sky using Rayleigh/Mie scattering
   * @param vpMatrix - View-projection matrix
   * @param sunDirection - Normalized direction towards the sun [x, y, z]
   * @param sunIntensity - Sun intensity multiplier (default 20.0)
   */
  renderSunSky(vpMatrix: mat4, sunDirection: [number, number, number], sunIntensity = 20.0): void {
    const gl = this.gl;

    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.sunProgram);

    // Disable any leftover vertex attributes from other renderers
    for (let i = 1; i < 8; i++) {
      gl.disableVertexAttribArray(i);
    }

    // Compute inverse view-projection for ray reconstruction
    mat4.invert(this.invVpMatrix, vpMatrix);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(this.sunLocations.aPosition);
    gl.vertexAttribPointer(this.sunLocations.aPosition, 2, gl.FLOAT, false, 0, 0);

    gl.uniformMatrix4fv(this.sunLocations.uInvViewProjection, false, this.invVpMatrix);
    gl.uniform3fv(this.sunLocations.uSunDirection, sunDirection);
    gl.uniform1f(this.sunLocations.uSunIntensity, sunIntensity);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.disableVertexAttribArray(this.sunLocations.aPosition);
    gl.enable(gl.DEPTH_TEST);
  }
  
  /**
   * Render sky using sun elevation (convenience wrapper)
   * Converts elevation to sun direction and calls renderSunSky
   * @param vpMatrix - View-projection matrix
   * @param sunElevation - Sun elevation in degrees (-90 to 90)
   * @param sunAzimuth - Sun azimuth in degrees (0 = north, 90 = east, default 180 = south)
   * @param sunIntensity - Sun intensity multiplier (default 20.0)
   */
  renderSunSkyFromElevation(vpMatrix: mat4, sunElevation: number, sunAzimuth = 180, sunIntensity = 20.0): void {
    // Convert elevation/azimuth to direction vector
    const elevationRad = sunElevation * Math.PI / 180;
    const azimuthRad = sunAzimuth * Math.PI / 180;
    
    // Sun direction (towards the sun)
    const cosElev = Math.cos(elevationRad);
    const sunDirection: [number, number, number] = [
      -Math.sin(azimuthRad) * cosElev,  // x
      Math.sin(elevationRad),            // y (up)
      -Math.cos(azimuthRad) * cosElev,   // z
    ];
    
    this.renderSunSky(vpMatrix, sunDirection, sunIntensity);
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
