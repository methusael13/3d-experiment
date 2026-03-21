/**
 * Grass Blade Shadow Depth Shader
 * 
 * Depth-only version of grass-blade.wgsl for rendering grass blade geometry
 * into the vegetation shadow map. Uses the same Bézier curve construction
 * and wind animation as the color shader, but outputs only depth.
 * 
 * Bindings:
 *   Group 0, Binding 0: ShadowUniforms (lightSpaceMatrix, time, maxDistance)
 *   Group 0, Binding 1: WindParams
 *   Group 0, Binding 2: Instance storage buffer (PlantInstance[])
 */

// ==================== Structs ====================

struct ShadowUniforms {
  lightSpaceMatrix: mat4x4f,
  cameraPosition: vec3f,
  time: f32,
  maxFadeDistance: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
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
  
  // Distance cull (skip blades beyond shadow distance)
  let diff = bladePos - uniforms.cameraPosition;
  let distSq = dot(diff, diff);
  let maxDistSq = uniforms.maxFadeDistance * uniforms.maxFadeDistance;
  if (distSq > maxDistSq) {
    // Return degenerate position (will be clipped)
    return vec4f(0.0, 0.0, -2.0, 1.0);
  }
  
  // Blade direction from rotation
  let bladeDir = vec3f(sin(rotation), 0.0, cos(rotation));
  let perpDir = vec3f(bladeDir.z, 0.0, -bladeDir.x);
  
  // Bézier control points
  var p0 = bladePos;
  var p1 = p0 + vec3f(0.0, bladeHeight, 0.0);
  var p2 = p1 + bladeDir * bladeHeight * GRASS_LEANING;
  
  // Wind (must match color shader for shadow consistency)
  let windDisp = computeWindDisplacement(bladePos.xz, uniforms.time);
  p2 += windDisp * bladeHeight * 0.5;
  
  // Persistent length correction
  makePersistentLength(p0, &p1, &p2, bladeHeight);
  
  // Base width
  let baseWidth = bladeHeight * 0.04;
  
  // Vertex decoding (identical to grass-blade.wgsl)
  let numQuads = N_SEGMENTS - 1u;
  let quadVertCount = numQuads * 6u;
  
  var worldPosition: vec3f;
  
  if (vertexIndex < quadVertCount) {
    let quadIndex = vertexIndex / 6u;
    let localVert = vertexIndex % 6u;
    
    let t0 = f32(quadIndex) / f32(numQuads);
    let t1 = f32(quadIndex + 1u) / f32(numQuads);
    
    let w0 = baseWidth * (1.0 - t0);
    let w1 = baseWidth * (1.0 - t1);
    
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
    let wPrev = baseWidth * (1.0 - tPrev);
    
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
