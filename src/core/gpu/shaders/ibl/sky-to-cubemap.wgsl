/**
 * Sky to Cubemap Shader
 * 
 * Renders a single cubemap face from the procedural Nishita sky.
 * Uses the same atmospheric scattering algorithm as sky.wgsl but
 * renders to a cubemap face with proper 90° FOV projection.
 */

// ============================================================================
// Constants (from sky.wgsl)
// ============================================================================

const PI: f32 = 3.14159265359;
const EARTH_RADIUS: f32 = 6360000.0;
const ATMOSPHERE_RADIUS: f32 = 6420000.0;
const BETA_R: vec3f = vec3f(3.8e-6, 13.5e-6, 33.1e-6);
const BETA_M: vec3f = vec3f(21e-6, 21e-6, 21e-6);
const H_R: f32 = 7994.0;
const H_M: f32 = 1200.0;
const G: f32 = 0.76;
const NUM_VIEW_SAMPLES: i32 = 16;
const NUM_SUN_SAMPLES: i32 = 8;

// ============================================================================
// Uniforms
// ============================================================================

struct CubemapUniforms {
  viewMatrix: mat4x4f,     // View matrix for this cubemap face
  sunDirection: vec3f,
  sunIntensity: f32,
  faceIndex: u32,          // 0-5: +X, -X, +Y, -Y, +Z, -Z
  _pad: vec3u,
}

@group(0) @binding(0) var<uniform> uniforms: CubemapUniforms;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba16float, write>;

// ============================================================================
// Helper Functions (from sky.wgsl)
// ============================================================================

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

fn phaseRayleigh(cosTheta: f32) -> f32 {
  return 3.0 / (16.0 * PI) * (1.0 + cosTheta * cosTheta);
}

fn phaseMie(cosTheta: f32) -> f32 {
  let g2 = G * G;
  let num = (1.0 - g2) * (1.0 + cosTheta * cosTheta);
  let denom = (2.0 + g2) * pow(1.0 + g2 - 2.0 * G * cosTheta, 1.5);
  return 3.0 / (8.0 * PI) * num / denom;
}

fn computeGroundColor(rayDir: vec3f, sunDir: vec3f, sunIntensity: f32) -> vec3f {
  let baseGround = vec3f(0.35, 0.32, 0.28);
  let sunDot = max(0.0, dot(rayDir, sunDir));
  let horizonFactor = 1.0 - abs(rayDir.y);
  let sunsetTint = vec3f(0.8, 0.5, 0.3) * pow(sunDot, 4.0) * 0.5;
  let skyTint = vec3f(0.4, 0.45, 0.5) * (1.0 - sunDot * 0.5);
  var groundColor = baseGround + sunsetTint * horizonFactor + skyTint * 0.2;
  let aoFactor = 1.0 - pow(max(0.0, -rayDir.y), 2.0) * 0.3;
  groundColor *= aoFactor;
  return groundColor * sunIntensity * 0.015;
}

// ============================================================================
// Atmospheric Scattering (from sky.wgsl)
// ============================================================================

fn computeAtmosphericScattering(rayDir: vec3f, sunDir: vec3f, sunIntensity: f32) -> vec4f {
  let cameraAltitude = 1.0;
  let cameraPos = vec3f(0.0, EARTH_RADIUS + cameraAltitude, 0.0);
  
  let horizonThreshold = -0.01;
  let hitGround = rayDir.y < horizonThreshold;
  
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
    let gc = computeGroundColor(rayDir, sunDir, sunIntensity);
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
  
  let skyColor = (sumR * BETA_R * phaseR + sumM * BETA_M * phaseM) * sunIntensity;
  return vec4f(skyColor, select(0.0, 1.0, hitGround));
}

// ============================================================================
// Compute Shader - Render Sky to Cubemap Face
// ============================================================================

@compute @workgroup_size(8, 8, 1)
fn cs_main(@builtin(global_invocation_id) globalId: vec3u) {
  let texSize = textureDimensions(outputTexture);
  
  if (globalId.x >= texSize.x || globalId.y >= texSize.y) {
    return;
  }
  
  // Convert pixel coordinates to UV in [-1, 1] range
  let u = (f32(globalId.x) + 0.5) / f32(texSize.x) * 2.0 - 1.0;
  let v = (f32(globalId.y) + 0.5) / f32(texSize.y) * 2.0 - 1.0;
  
  // Get ray direction for this cubemap face
  // The view matrix transforms from face-local to world space
  var localDir: vec3f;
  switch (uniforms.faceIndex) {
    case 0u: { localDir = vec3f( 1.0, -v,   -u); }  // +X
    case 1u: { localDir = vec3f(-1.0, -v,    u); }  // -X
    case 2u: { localDir = vec3f(   u,  1.0,  v); }  // +Y
    case 3u: { localDir = vec3f(   u, -1.0, -v); }  // -Y
    case 4u: { localDir = vec3f(   u, -v,  1.0); }  // +Z
    default: { localDir = vec3f(  -u, -v, -1.0); }  // -Z
  }
  
  let rayDir = normalize(localDir);
  let sunDir = normalize(uniforms.sunDirection);
  
  // Compute atmospheric scattering
  let scatterResult = computeAtmosphericScattering(rayDir, sunDir, uniforms.sunIntensity);
  var color = scatterResult.xyz;
  let hitGround = scatterResult.w > 0.5;
  
  if (hitGround) {
    let groundColor = computeGroundColor(rayDir, sunDir, uniforms.sunIntensity);
    color = color + groundColor;
  } else {
    // Add sun disk (dimmed for IBL to avoid super bright spots)
    let sunDot = dot(rayDir, sunDir);
    let sunDisk = smoothstep(0.9998, 0.99995, sunDot);
    let sunGlow = pow(max(0.0, sunDot), 256.0) * 2.0;
    color += vec3f(1.0, 0.95, 0.9) * (sunDisk + sunGlow) * uniforms.sunIntensity * 0.02;
  }
  
  textureStore(outputTexture, vec2i(globalId.xy), vec4f(color, 1.0));
}
