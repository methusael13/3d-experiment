/**
 * Grass Blade Shadow Depth Shader (v2)
 * 
 * Depth-only version of grass-blade.wgsl for rendering grass blade geometry
 * into the vegetation shadow map. Uses the same Bézier curve construction,
 * non-linear taper, height fade, and wind animation as the color shader,
 * but outputs only depth.
 * 
 * Bindings:
 *   Group 0, Binding 0: ShadowUniforms (lightSpaceMatrix, time, maxDistance, blade params)
 *   Group 0, Binding 1: WindParams
 *   Group 0, Binding 2: Instance storage buffer (PlantInstance[])
 */

// ==================== Structs ====================

struct ShadowUniforms {
  lightSpaceMatrix: mat4x4f,
  cameraPosition: vec3f,
  time: f32,
  maxFadeDistance: f32,
  fadeStartRatio: f32,
  bladeWidthFactor: f32,
  bladeTaperPower: f32,
  bladeMinBendRad: f32,
  _pad3: f32,
  _pad4: f32,
  _pad5: f32,
}

struct WindParams {
  direction: vec2f,
  strength: f32,
  frequency: f32,
  gustStrength: f32,
  gustFrequency: f32,
  _pad: vec2f,
}

struct PlantInstance {
  positionAndScale: vec4f,
  rotationAndType: vec4f,
}

// ==================== Bindings ====================

@group(0) @binding(0) var<uniform> uniforms: ShadowUniforms;
@group(0) @binding(1) var<uniform> wind: WindParams;
@group(0) @binding(2) var<storage, read> instances: array<PlantInstance>;

// ==================== Hash ====================

fn hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// ==================== Constants ====================

const GRASS_LEANING: f32 = 0.3;
const N_SEGMENTS: u32 = 5u;

// ==================== Wind ====================

fn computeWindDisplacement(worldXZ: vec2f, time: f32) -> vec3f {
  let windDir = normalize(wind.direction + vec2f(0.001, 0.001));
  let phase = dot(worldXZ, windDir) * wind.frequency + time * 2.0;
  let sway = sin(phase) * wind.strength;
  let gustPhase = dot(worldXZ * wind.gustFrequency, vec2f(0.7, 0.3)) + time * 1.3;
  let gust = sin(gustPhase) * cos(gustPhase * 0.7) * wind.gustStrength;
  let totalStrength = sway + gust;
  return vec3f(windDir.x * totalStrength, 0.0, windDir.y * totalStrength);
}

// ==================== Persistent Length ====================

fn makePersistentLength(groundPos: vec3f, v1: ptr<function, vec3f>, v2: ptr<function, vec3f>, height: f32) {
  let v01 = *v1 - groundPos;
  let v12 = *v2 - *v1;
  let lv01 = length(v01);
  let lv12 = length(v12);
  let L1 = lv01 + lv12;
  let L0 = length(*v2 - groundPos);
  let L = (2.0 * L0 + L1) / 3.0;
  if (L < 0.0001) { return; }
  let ldiff = height / L;
  let newV01 = v01 * ldiff;
  let newV12 = v12 * ldiff;
  *v1 = groundPos + newV01;
  *v2 = *v1 + newV12;
}

// ==================== Quadratic Bézier ====================

fn evalBezier(p0: vec3f, p1: vec3f, p2: vec3f, t: f32) -> vec3f {
  let omt = 1.0 - t;
  return omt * omt * p0 + 2.0 * omt * t * p1 + t * t * p2;
}

// ==================== Non-Linear Width Taper ====================

fn bladeHalfWidth(t: f32, baseWidth: f32, taperPower: f32) -> f32 {
  return baseWidth * pow(max(1.0 - t, 0.0), taperPower);
}

// ==================== Vertex Shader ====================

@vertex
fn vertexMain(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> @builtin(position) vec4f {
  let inst = instances[instanceIndex];
  
  let bladePos = inst.positionAndScale.xyz;
  let bladeHeight = inst.positionAndScale.w;
  let rotation = inst.rotationAndType.x;
  
  // Distance cull using Euclidean distance (shadow map doesn't have camera forward)
  let diff = bladePos - uniforms.cameraPosition;
  let distSq = dot(diff, diff);
  let maxDistSq = uniforms.maxFadeDistance * uniforms.maxFadeDistance;
  if (distSq > maxDistSq) {
    return vec4f(0.0, 0.0, -2.0, 1.0);
  }
  
  // ---- Feature 5: Distance-based height fade (must match color shader) ----
  let dist = sqrt(distSq);
  let fadeStart = uniforms.maxFadeDistance * uniforms.fadeStartRatio;
  let fadeRange = max(uniforms.maxFadeDistance - fadeStart, 0.01);
  let heightFade = smoothstep(0.0, 1.0, saturate((uniforms.maxFadeDistance - dist) / fadeRange));
  let effectiveHeight = bladeHeight * heightFade;
  
  // Skip fully faded blades
  if (effectiveHeight < 0.001) {
    return vec4f(0.0, 0.0, -2.0, 1.0);
  }
  
  // Blade direction from rotation
  let bladeDir = vec3f(sin(rotation), 0.0, cos(rotation));
  let perpDir = vec3f(bladeDir.z, 0.0, -bladeDir.x);
  
  // ---- Per-instance bend variation (must match color shader) ----
  let bendHash1 = hash21(bladePos.xz * 29.3 + 7.7);
  let bendHash2 = hash21(bladePos.xz * 47.1 + 13.3);
  let minBendNorm = uniforms.bladeMinBendRad / 1.5708;
  let leanAmount = mix(GRASS_LEANING, 1.5, minBendNorm) + bendHash1 * bendHash1 * mix(0.6, 0.15, minBendNorm);
  let leanAngleOffset = (bendHash2 - 0.5) * 1.2;
  let leanDir = normalize(bladeDir * cos(leanAngleOffset) + perpDir * sin(leanAngleOffset));
  
  // Bézier control points (using effective height and per-instance lean)
  var p0 = bladePos;
  var p1 = p0 + vec3f(0.0, effectiveHeight, 0.0);
  var p2 = p1 + leanDir * effectiveHeight * leanAmount;
  
  // ---- Height-based wind (must match color shader) ----
  let windDisp = computeWindDisplacement(bladePos.xz, uniforms.time);
  p1 += windDisp * effectiveHeight * 0.15;
  p2 += windDisp * effectiveHeight * 0.5;
  
  // Persistent length correction
  makePersistentLength(p0, &p1, &p2, effectiveHeight);
  
  // ---- Feature 1: Non-linear taper with configurable width ----
  let widthFactor = uniforms.bladeWidthFactor;
  let taperPower = uniforms.bladeTaperPower;
  let baseWidth = effectiveHeight * widthFactor;
  
  // Shadow pass uses full segment count (simpler LOD for shadows)
  let numQuads = N_SEGMENTS - 1u;
  let quadVertCount = numQuads * 6u;
  let totalVerts = quadVertCount + 3u;
  
  // Degenerate for out-of-range vertices
  if (vertexIndex >= totalVerts) {
    return vec4f(0.0, 0.0, -2.0, 1.0);
  }
  
  var worldPosition: vec3f;
  
  if (vertexIndex < quadVertCount) {
    let quadIndex = vertexIndex / 6u;
    let localVert = vertexIndex % 6u;
    
    let t0 = f32(quadIndex) / f32(numQuads);
    let t1 = f32(quadIndex + 1u) / f32(numQuads);
    
    // Non-linear width at each t
    let w0 = bladeHalfWidth(t0, baseWidth, taperPower);
    let w1 = bladeHalfWidth(t1, baseWidth, taperPower);
    
    let pos0 = evalBezier(p0, p1, p2, t0);
    let pos1 = evalBezier(p0, p1, p2, t1);
    
    let left0  = pos0 - perpDir * w0;
    let right0 = pos0 + perpDir * w0;
    let left1  = pos1 - perpDir * w1;
    let right1 = pos1 + perpDir * w1;
    
    switch localVert {
      case 0u: { worldPosition = left0; }
      case 1u: { worldPosition = right0; }
      case 2u: { worldPosition = left1; }
      case 3u: { worldPosition = left1; }
      case 4u: { worldPosition = right0; }
      default: { worldPosition = right1; }
    }
  } else {
    let tipLocalVert = vertexIndex - quadVertCount;
    let tPrev = f32(numQuads - 1u) / f32(numQuads);
    
    let posPrev = evalBezier(p0, p1, p2, tPrev);
    let posTip = evalBezier(p0, p1, p2, 1.0);
    let wPrev = bladeHalfWidth(tPrev, baseWidth, taperPower);
    
    let leftPrev  = posPrev - perpDir * wPrev;
    let rightPrev = posPrev + perpDir * wPrev;
    
    switch tipLocalVert {
      case 0u: { worldPosition = leftPrev; }
      case 1u: { worldPosition = rightPrev; }
      default: { worldPosition = posTip; }
    }
  }
  
  return uniforms.lightSpaceMatrix * vec4f(worldPosition, 1.0);
}
