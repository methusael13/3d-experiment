// Sky Shader - Rayleigh/Mie Atmospheric Scattering
//
// Physically-based atmospheric scattering for procedural sky rendering.
// Based on Nishita model with Rayleigh (molecules) and Mie (aerosols) scattering.
//
// References:
// - "Display of The Earth Taking into Account Atmospheric Scattering" (Nishita 1993)
// - Scratchapixel: Simulating the Colors of the Sky

// ============================================================================
// Constants
// ============================================================================

const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 6.28318530718;

// Planet and atmosphere radii (in meters)
const EARTH_RADIUS: f32 = 6360000.0;      // 6360 km
const ATMOSPHERE_RADIUS: f32 = 6420000.0; // 6420 km (60km atmosphere)

// Rayleigh scattering coefficients at sea level (per meter)
const BETA_R: vec3f = vec3f(3.8e-6, 13.5e-6, 33.1e-6);

// Mie scattering coefficient at sea level (per meter)
const BETA_M: vec3f = vec3f(21e-6, 21e-6, 21e-6);

// Scale heights
const H_R: f32 = 7994.0;  // Rayleigh scale height: ~8km
const H_M: f32 = 1200.0;  // Mie scale height: ~1.2km

// Mie anisotropy factor (forward scattering)
const G: f32 = 0.76;

// Number of samples for ray marching
const NUM_VIEW_SAMPLES: i32 = 16;
const NUM_SUN_SAMPLES: i32 = 8;

// ============================================================================
// Uniforms
// ============================================================================

struct SkyUniforms {
  invViewProjection: mat4x4f,
  sunDirection: vec3f,
  sunIntensity: f32,
  time: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

@group(0) @binding(0) var<uniform> uniforms: SkyUniforms;

// For HDR mode
@group(0) @binding(1) var hdrTexture: texture_2d<f32>;
@group(0) @binding(2) var hdrSampler: sampler;

// ============================================================================
// Vertex Input/Output
// ============================================================================

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) rayDir: vec3f,
  @location(1) uv: vec2f,
}

// ============================================================================
// Vertex Shader (Fullscreen Quad)
// ============================================================================

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // Fullscreen quad vertices
  var positions = array<vec2f, 4>(
    vec2f(-1.0, -1.0),
    vec2f( 1.0, -1.0),
    vec2f(-1.0,  1.0),
    vec2f( 1.0,  1.0)
  );
  
  let pos = positions[vertexIndex];
  
  var output: VertexOutput;
  output.uv = pos * 0.5 + 0.5;
  
  // Reconstruct ray direction from clip space
  let nearPoint = uniforms.invViewProjection * vec4f(pos, -1.0, 1.0);
  let farPoint = uniforms.invViewProjection * vec4f(pos, 1.0, 1.0);
  let nearW = nearPoint / nearPoint.w;
  let farW = farPoint / farPoint.w;
  output.rayDir = normalize(farW.xyz - nearW.xyz);
  
  output.position = vec4f(pos, 0.9999, 1.0);
  return output;
}

// ============================================================================
// Helper Functions
// ============================================================================

// Ray-sphere intersection
fn raySphereIntersect(origin: vec3f, dir: vec3f, radius: f32) -> vec2f {
  let a = dot(dir, dir);
  let b = 2.0 * dot(dir, origin);
  let c = dot(origin, origin) - radius * radius;
  let discriminant = b * b - 4.0 * a * c;
  
  if (discriminant < 0.0) {
    return vec2f(-1.0, -1.0);
  }
  
  let sqrtD = sqrt(discriminant);
  let t0 = (-b - sqrtD) / (2.0 * a);
  let t1 = (-b + sqrtD) / (2.0 * a);
  
  return vec2f(t0, t1);
}

// Rayleigh phase function
fn phaseRayleigh(cosTheta: f32) -> f32 {
  return 3.0 / (16.0 * PI) * (1.0 + cosTheta * cosTheta);
}

// Mie phase function (Henyey-Greenstein)
fn phaseMie(cosTheta: f32) -> f32 {
  let g2 = G * G;
  let num = (1.0 - g2) * (1.0 + cosTheta * cosTheta);
  let denom = (2.0 + g2) * pow(1.0 + g2 - 2.0 * G * cosTheta, 1.5);
  return 3.0 / (8.0 * PI) * num / denom;
}

// Ground color computation
fn computeGroundColor(rayDir: vec3f, sunDir: vec3f) -> vec3f {
  let baseGround = vec3f(0.35, 0.32, 0.28);
  let sunDot = max(0.0, dot(rayDir, sunDir));
  let horizonFactor = 1.0 - abs(rayDir.y);
  let sunsetTint = vec3f(0.8, 0.5, 0.3) * pow(sunDot, 4.0) * 0.5;
  let skyTint = vec3f(0.4, 0.45, 0.5) * (1.0 - sunDot * 0.5);
  var groundColor = baseGround + sunsetTint * horizonFactor + skyTint * 0.2;
  let aoFactor = 1.0 - pow(max(0.0, -rayDir.y), 2.0) * 0.3;
  groundColor *= aoFactor;
  return groundColor * uniforms.sunIntensity * 0.015;
}

// ============================================================================
// Main Atmospheric Scattering
// ============================================================================

fn computeAtmosphericScattering(rayDir: vec3f, sunDir: vec3f) -> vec4f {
  // Camera position: 1 meter above Earth surface
  let cameraAltitude = 1.0;
  let cameraPos = vec3f(0.0, EARTH_RADIUS + cameraAltitude, 0.0);
  
  // Flat horizon detection
  let horizonThreshold = -0.01;
  let hitGround = rayDir.y < horizonThreshold;
  
  // Find where ray exits atmosphere
  let atmosphereHit = raySphereIntersect(cameraPos, rayDir, ATMOSPHERE_RADIUS);
  
  if (atmosphereHit.x < 0.0 && atmosphereHit.y < 0.0) {
    return vec4f(0.0, 0.0, 0.0, select(0.0, 1.0, hitGround));
  }
  
  var tMin = max(0.0, atmosphereHit.x);
  var tMax = atmosphereHit.y;
  
  if (hitGround) {
    let groundDist = cameraAltitude / max(0.001, -rayDir.y);
    tMax = min(tMax, groundDist + 50000.0);
  }
  
  if (tMax <= tMin) {
    let gc = computeGroundColor(rayDir, sunDir);
    return vec4f(gc, 1.0);
  }
  
  let segmentLength = (tMax - tMin) / f32(NUM_VIEW_SAMPLES);
  var tCurrent = tMin;
  
  var sumR = vec3f(0.0);
  var sumM = vec3f(0.0);
  var opticalDepthR = 0.0;
  var opticalDepthM = 0.0;
  
  let mu = dot(rayDir, sunDir);
  let phaseR = phaseRayleigh(mu);
  let phaseM = phaseMie(mu);
  
  // March along view ray
  for (var i = 0; i < NUM_VIEW_SAMPLES; i++) {
    let samplePos = cameraPos + rayDir * (tCurrent + segmentLength * 0.5);
    let height = length(samplePos) - EARTH_RADIUS;
    
    let hr = exp(-height / H_R) * segmentLength;
    let hm = exp(-height / H_M) * segmentLength;
    
    opticalDepthR += hr;
    opticalDepthM += hm;
    
    let sunAtmosphereHit = raySphereIntersect(samplePos, sunDir, ATMOSPHERE_RADIUS);
    let sunRayLength = sunAtmosphereHit.y;
    let sunSegmentLength = sunRayLength / f32(NUM_SUN_SAMPLES);
    
    var opticalDepthLightR = 0.0;
    var opticalDepthLightM = 0.0;
    var inShadow = false;
    
    for (var j = 0; j < NUM_SUN_SAMPLES; j++) {
      let sunSamplePos = samplePos + sunDir * (f32(j) + 0.5) * sunSegmentLength;
      let sunHeight = length(sunSamplePos) - EARTH_RADIUS;
      
      if (sunHeight < 0.0) {
        inShadow = true;
        break;
      }
      
      opticalDepthLightR += exp(-sunHeight / H_R) * sunSegmentLength;
      opticalDepthLightM += exp(-sunHeight / H_M) * sunSegmentLength;
    }
    
    if (!inShadow) {
      let tau = BETA_R * (opticalDepthR + opticalDepthLightR) + 
                BETA_M * 1.1 * (opticalDepthM + opticalDepthLightM);
      let attenuation = exp(-tau);
      
      sumR += attenuation * hr;
      sumM += attenuation * hm;
    }
    
    tCurrent += segmentLength;
  }
  
  let skyColor = (sumR * BETA_R * phaseR + sumM * BETA_M * phaseM) * uniforms.sunIntensity;
  return vec4f(skyColor, select(0.0, 1.0, hitGround));
}

// ============================================================================
// Star Field (Static Procedural)
// ============================================================================

// 3D hash for star cell randomization
fn hash3(p: vec3f) -> f32 {
  var p3 = fract(p * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Stellar spectral class color from a hash value [0, 1]
// Models the Morgan-Keenan classification: M → K → G → F → A → B/O
// Cool stars (M/K/G, red-yellow) ≈ 76%, hot stars (F/A/B/O, white-blue) ≈ 24%
fn starSpectralColor(tempHash: f32) -> vec3f {
  if (tempHash < 0.38) {
    // M class: deep orange-red (coolest, most common)
    let t = tempHash / 0.38;
    return mix(vec3f(1.0, 0.5, 0.2), vec3f(1.0, 0.65, 0.35), t);
  } else if (tempHash < 0.58) {
    // K class: orange-yellow
    let t = (tempHash - 0.38) / 0.20;
    return mix(vec3f(1.0, 0.72, 0.42), vec3f(1.0, 0.85, 0.55), t);
  } else if (tempHash < 0.76) {
    // G class: yellow-white (sun-like)
    let t = (tempHash - 0.58) / 0.18;
    return mix(vec3f(1.0, 0.92, 0.7), vec3f(1.0, 0.97, 0.85), t);
  } else if (tempHash < 0.88) {
    // F class: white
    let t = (tempHash - 0.76) / 0.12;
    return mix(vec3f(1.0, 0.98, 0.92), vec3f(1.0, 1.0, 1.0), t);
  } else if (tempHash < 0.95) {
    // A class: white-blue
    let t = (tempHash - 0.88) / 0.07;
    return mix(vec3f(0.95, 0.97, 1.0), vec3f(0.85, 0.92, 1.0), t);
  } else {
    // B/O class: blue-white (hottest, rarest)
    let t = (tempHash - 0.95) / 0.05;
    return mix(vec3f(0.75, 0.85, 1.0), vec3f(0.6, 0.75, 1.0), t);
  }
}

// Generate a static star field from ray direction
// Returns star color (additive) scaled by nightFactor
fn starField(rayDir: vec3f, nightFactor: f32, time: f32) -> vec3f {
  if (nightFactor < 0.01 || rayDir.y < 0.0) {
    return vec3f(0.0);
  }
  
  // Project ray direction onto a high-resolution grid on the sky dome
  // Use spherical coordinates to avoid pole distortion issues
  let gridScale = 300.0;  // Number of cells across the sky (higher = more stars)
  let cellPos = rayDir * gridScale;
  let cell = floor(cellPos);
  let cellFrac = fract(cellPos);
  
  var starLight = vec3f(0.0);
  
  // Check this cell and neighbors (needed because star center may be in adjacent cell)
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      for (var dz = -1; dz <= 1; dz++) {
        let neighborCell = cell + vec3f(f32(dx), f32(dy), f32(dz));
        
        // Random star probability: only ~2% of cells have a star
        let starProb = hash3(neighborCell);
        if (starProb > 0.98) {
          // Random position within the cell (0.2-0.8 to keep away from edges)
          let starPos = vec3f(
            hash3(neighborCell + vec3f(1.0, 0.0, 0.0)),
            hash3(neighborCell + vec3f(0.0, 1.0, 0.0)),
            hash3(neighborCell + vec3f(0.0, 0.0, 1.0))
          ) * 0.6 + 0.2;
          
          // Distance from fragment to star center (in cell space)
          let starWorldPos = neighborCell + starPos;
          let dist = length(cellPos - starWorldPos);
          
          // Continuous apparent magnitude distribution (power-law)
          // Cubic bias produces many dim stars and few bright ones,
          // mimicking real stellar magnitude frequency
          let magnitude = pow(hash3(neighborCell * 2.17), 3.0);
          let starRadius = 0.2 + magnitude * 0.6;      // range [0.2, 0.8]
          let starBrightness = 0.15 + magnitude * 0.85; // range [0.15, 1.0]
          
          // Sharp falloff for point-like stars
          let glow = max(0.0, 1.0 - dist / starRadius);
          
          // Twinkle: per-star sinusoidal oscillation at random phase and speed
          let twinklePhase = hash3(neighborCell * 13.37) * 6.2832; // random phase [0, 2π]
          let twinkleSpeed = 0.5 + hash3(neighborCell * 5.71) * 1.5; // speed [0.5, 2.0]
          let twinkle = 0.7 + 0.3 * sin(twinklePhase + time * twinkleSpeed); // range [0.4, 1.0]
          
          let pointLight = pow(glow, 8.0) * starBrightness * twinkle;
          
          // Color from stellar spectral classification
          let starColor = starSpectralColor(hash3(neighborCell * 3.91));
          
          starLight += starColor * pointLight;
        }
      }
    }
  }
  
  // Fade stars near horizon (atmospheric extinction)
  let horizonFade = smoothstep(0.0, 0.15, rayDir.y);
  
  return starLight * nightFactor * horizonFade * 0.8;
}

// Extended Reinhard tone mapping
fn tonemap(c: vec3f) -> vec3f {
  let whitePoint = 4.0;
  let wp2 = whitePoint * whitePoint;
  let numerator = c * (1.0 + c / wp2);
  let mapped = numerator / (1.0 + c);
  return mapped;
}

// ============================================================================
// Fragment Shader - Sun Mode (Atmospheric Scattering)
// ============================================================================

@fragment
fn fs_sun(input: VertexOutput) -> @location(0) vec4f {
  let rayDir = normalize(input.rayDir);
  let sunDir = normalize(uniforms.sunDirection);
  
  // Compute atmospheric scattering
  let scatterResult = computeAtmosphericScattering(rayDir, sunDir);
  let skyColor = scatterResult.xyz;
  let hitGround = scatterResult.w > 0.5;
  
  var color: vec3f;
  if (hitGround) {
    let groundColor = computeGroundColor(rayDir, sunDir);
    color = skyColor + groundColor;
  } else {
    color = skyColor;
    
    // Add sun disk
    let sunDot = dot(rayDir, sunDir);
    let sunDisk = smoothstep(0.9998, 0.99995, sunDot);
    let sunGlow = pow(max(0.0, sunDot), 256.0) * 2.0;
    color += vec3f(1.0, 0.95, 0.9) * (sunDisk + sunGlow) * uniforms.sunIntensity * 0.1;
    
    // Add stars at night (fade based on sky brightness)
    let skyLuminance = dot(skyColor, vec3f(0.299, 0.587, 0.114));
    let nightFactor = 1.0 - saturate(skyLuminance * 15.0);
    color += starField(rayDir, nightFactor, uniforms.time);
  }
  
  // Tone mapping to be handled in composite pass
  // color = tonemap(color);
  
  return vec4f(color, 1.0);
}

// ============================================================================
// Fragment Shader - HDR Mode (Equirectangular)
// ============================================================================

@fragment
fn fs_hdr(input: VertexOutput) -> @location(0) vec4f {
  let dir = normalize(input.rayDir);
  
  // Convert direction to equirectangular UV
  let phi = atan2(dir.z, dir.x);
  let theta = asin(clamp(dir.y, -1.0, 1.0));
  let uv = vec2f(phi / TWO_PI + 0.5, 0.5 - theta / PI);
  
  // Sample HDR texture
  let exposure = uniforms.sunIntensity; // Reuse as exposure
  var hdrColor = textureSample(hdrTexture, hdrSampler, uv).rgb;
  hdrColor = clamp(hdrColor, vec3f(0.0), vec3f(65504.0)) * exposure;
  
  // Tone mapping
  let ldr = hdrColor / (hdrColor + vec3f(1.0));
  let finalColor = pow(ldr, vec3f(1.0 / 2.2));
  
  return vec4f(finalColor, 1.0);
}
