/**
 * Procedural Grass Blade Shader
 * 
 * Renders each vegetation instance as a procedural grass blade using
 * a quadratic Bézier curve (P0, P1, P2) with width tapering.
 * 
 * Per instance data (from spawn buffer):
 *   positionAndScale: vec4f  (xyz = world position = P0, w = blade height)
 *   rotationAndType:  vec4f  (x = Y rotation → blade direction, y = variant, z = renderFlag, w = reserved)
 * 
 * Blade construction:
 *   P0 = bladePosition (ground)
 *   P1 = P0 + vec3(0, bladeHeight, 0) 
 *   P2 = P1 + bladeDirection * bladeHeight * 0.3
 *   Width tapers from w0 at base to 0 at tip.
 */

// ==================== Uniforms ====================

struct Uniforms {
  viewProjection: mat4x4f,
  cameraPosition: vec3f,
  time: f32,
  maxFadeDistance: f32,
  fadeStartRatio: f32,
  lodLevel: f32,
  maxLodLevels: f32,
  fallbackColor: vec3f,
  _pad0: f32,
  // Analytical lighting (from DirectionalLight)
  sunDirection: vec3f,
  sunIntensityFactor: f32,
  sunColor: vec3f,
  _pad1: f32,
  skyColor: vec3f,
  _pad2: f32,
  groundColor: vec3f,
  _pad3: f32,
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

// ==================== CSM Shadow Structs ====================

struct CSMUniforms {
  lightSpaceMatrix0: mat4x4f,
  lightSpaceMatrix1: mat4x4f,
  lightSpaceMatrix2: mat4x4f,
  lightSpaceMatrix3: mat4x4f,
  cascadeSplits: vec4f,
  config: vec4f,       // x=cascadeCount, y=csmEnabled, z=blendFraction, w=pad
  cameraForward: vec4f, // xyz = normalized camera forward, w = 0
}

// ==================== Bindings ====================

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<uniform> wind: WindParams;
@group(0) @binding(2) var<storage, read> instances: array<PlantInstance>;

// Group 1: Environment shadow (CSM)
@group(1) @binding(1) var shadowSampler: sampler_comparison;
@group(1) @binding(7) var shadowMapArray: texture_depth_2d_array;
@group(1) @binding(8) var<uniform> csm: CSMUniforms;

// ==================== Constants ====================

const GRASS_LEANING: f32 = 0.3;
const N_SEGMENTS: u32 = 5u;        // Number of segments along the blade
const VERTS_PER_BLADE: u32 = 15u;  // (N_SEGMENTS * 2) + 1 tip vertices → triangle list
// Actually: N_SEGMENTS quads (2 tris each) + 1 tip tri = N_SEGMENTS*6 + 3
// Let's use: (N_SEGMENTS-1) quads + 1 tip = (N_SEGMENTS-1)*6 + 3 vertices
// With N_SEGMENTS=5 control points (t=0..1): 4 quads + 1 tip = 24 + 3 = 27 vertices
const TRIANGLES_PER_BLADE: u32 = 27u;

const PI: f32 = 3.14159265;

// ==================== Vertex Output ====================

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
  @location(1) normal: vec3f,
  @location(2) worldPos: vec3f,
  @location(3) bladeT: f32,  // 0 at base, 1 at tip — for self-shadow & gradient
}

// ==================== Hash ====================

fn hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// ==================== Wind ====================

fn computeWindDisplacement(worldXZ: vec2f, time: f32) -> vec3f {
  let windDir = normalize(wind.direction + vec2f(0.001, 0.001));
  
  // Base sway
  let phase = dot(worldXZ, windDir) * wind.frequency + time * 2.0;
  let sway = sin(phase) * wind.strength;
  
  // Gust variation
  let gustPhase = dot(worldXZ * wind.gustFrequency, vec2f(0.7, 0.3)) + time * 1.3;
  let gust = sin(gustPhase) * cos(gustPhase * 0.7) * wind.gustStrength;
  
  let totalStrength = sway + gust;
  return vec3f(windDir.x * totalStrength, 0.0, windDir.y * totalStrength);
}

// ==================== Persistent Length (Jahrmann & Wimmer) ====================

fn makePersistentLength(groundPos: vec3f, v1: ptr<function, vec3f>, v2: ptr<function, vec3f>, height: f32) {
  let v01 = *v1 - groundPos;
  let v12 = *v2 - *v1;
  let lv01 = length(v01);
  let lv12 = length(v12);
  
  let L1 = lv01 + lv12;
  let L0 = length(*v2 - groundPos);
  let L = (2.0 * L0 + L1) / 3.0; // Bézier arc length approximation
  
  // Avoid division by zero
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

fn evalBezierDerivative(p0: vec3f, p1: vec3f, p2: vec3f, t: f32) -> vec3f {
  return 2.0 * (1.0 - t) * (p1 - p0) + 2.0 * t * (p2 - p1);
}

// ==================== Main Vertex Shader ====================

@vertex
fn vertexMain(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
  let inst = instances[instanceIndex];
  
  // Skip non-grass-blade instances (renderFlag in .z: 0=billboard, 1=mesh, 3 would be grass)
  // In the culled buffer, all instances are pre-filtered, so we just render them all.
  
  let bladePos = inst.positionAndScale.xyz;
  let bladeHeight = inst.positionAndScale.w;
  let rotation = inst.rotationAndType.x;
  
  // Derive blade direction from rotation angle (in XZ plane)
  let bladeDir = vec3f(sin(rotation), 0.0, cos(rotation));
  
  // Perpendicular direction for width (rotate 90° in XZ)
  let perpDir = vec3f(bladeDir.z, 0.0, -bladeDir.x);
  
  // Construct Bézier control points
  var p0 = bladePos;
  var p1 = p0 + vec3f(0.0, bladeHeight, 0.0);
  var p2 = p1 + bladeDir * bladeHeight * GRASS_LEANING;
  
  // Wind animation — displace P2
  let windDisp = computeWindDisplacement(bladePos.xz, uniforms.time);
  p2 += windDisp * bladeHeight * 0.5;
  
  // Persistent length correction
  makePersistentLength(p0, &p1, &p2, bladeHeight);
  
  // Base width proportional to height
  let baseWidth = bladeHeight * 0.04;
  
  // Decode vertex index into segment + side
  // Layout: N_SEGMENTS-1 quads (each 6 verts) + 1 tip triangle (3 verts)
  // Total: (N_SEGMENTS-1)*6 + 3 = 27 vertices for N_SEGMENTS=5
  let numQuads = N_SEGMENTS - 1u;
  let quadVertCount = numQuads * 6u;
  
  var worldPosition: vec3f;
  var t_param: f32;
  var faceNormal: vec3f;
  
  if (vertexIndex < quadVertCount) {
    // Quad region
    let quadIndex = vertexIndex / 6u;
    let localVert = vertexIndex % 6u;
    
    // Two t values for the quad
    let t0 = f32(quadIndex) / f32(numQuads);
    let t1 = f32(quadIndex + 1u) / f32(numQuads);
    
    // Width at each t (linear taper to 0 at tip)
    let w0 = baseWidth * (1.0 - t0);
    let w1 = baseWidth * (1.0 - t1);
    
    // Bézier positions
    let pos0 = evalBezier(p0, p1, p2, t0);
    let pos1 = evalBezier(p0, p1, p2, t1);
    
    // Four corners of the quad
    let left0  = pos0 - perpDir * w0;
    let right0 = pos0 + perpDir * w0;
    let left1  = pos1 - perpDir * w1;
    let right1 = pos1 + perpDir * w1;
    
    // Two triangles: 0-1-2, 2-1-3
    // 0=left0, 1=right0, 2=left1, 3=right1
    switch localVert {
      case 0u: { worldPosition = left0;  t_param = t0; }
      case 1u: { worldPosition = right0; t_param = t0; }
      case 2u: { worldPosition = left1;  t_param = t1; }
      case 3u: { worldPosition = left1;  t_param = t1; }
      case 4u: { worldPosition = right0; t_param = t0; }
      default: { worldPosition = right1; t_param = t1; }
    }
    
    // Face normal (cross product of quad edges)
    let edge1 = pos1 - pos0;
    let edge2 = perpDir;
    faceNormal = normalize(cross(edge1, edge2));
  } else {
    // Tip triangle (last 3 vertices)
    let tipLocalVert = vertexIndex - quadVertCount;
    let tPrev = f32(numQuads - 1u) / f32(numQuads);
    let tTip = 1.0;
    
    let posPrev = evalBezier(p0, p1, p2, tPrev);
    let posTip = evalBezier(p0, p1, p2, tTip);
    let wPrev = baseWidth * (1.0 - tPrev);
    
    let leftPrev  = posPrev - perpDir * wPrev;
    let rightPrev = posPrev + perpDir * wPrev;
    
    switch tipLocalVert {
      case 0u: { worldPosition = leftPrev;  t_param = tPrev; }
      case 1u: { worldPosition = rightPrev; t_param = tPrev; }
      default: { worldPosition = posTip;    t_param = tTip; }
    }
    
    let edge1 = posTip - posPrev;
    let edge2 = perpDir;
    faceNormal = normalize(cross(edge1, edge2));
  }
  
  // Distance fade
  let dist = distance(worldPosition, uniforms.cameraPosition);
  let fadeStart = uniforms.maxFadeDistance * uniforms.fadeStartRatio;
  let fade = 1.0 - saturate((dist - fadeStart) / (uniforms.maxFadeDistance - fadeStart));
  
  // Color gradient: darker green at base, lighter at tip
  let baseColor = uniforms.fallbackColor;
  let tipColor = baseColor * 1.4 + vec3f(0.1, 0.15, 0.0);
  let bladeColor = mix(baseColor, tipColor, t_param) * fade;
  
  // Per-instance color variation
  let colorVar = hash21(bladePos.xz * 13.7) * 0.2 - 0.1;
  let finalColor = bladeColor + vec3f(colorVar * 0.5, colorVar, colorVar * 0.3);
  
  var output: VertexOutput;
  output.position = uniforms.viewProjection * vec4f(worldPosition, 1.0);
  output.color = finalColor;
  output.normal = faceNormal;
  output.worldPos = worldPosition;
  output.bladeT = t_param;
  return output;
}

// ==================== Noise for color variation ====================

fn perlinNoise2D(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  
  let a = hash21(i);
  let b = hash21(i + vec2f(1.0, 0.0));
  let c = hash21(i + vec2f(0.0, 1.0));
  let d = hash21(i + vec2f(1.0, 1.0));
  
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}

// ==================== CSM Shadow Functions ====================

const PCF_SAMPLES: i32 = 3;

fn getCSMLightSpaceMatrix(cascadeIdx: u32) -> mat4x4f {
  switch (cascadeIdx) {
    case 0u: { return csm.lightSpaceMatrix0; }
    case 1u: { return csm.lightSpaceMatrix1; }
    case 2u: { return csm.lightSpaceMatrix2; }
    case 3u: { return csm.lightSpaceMatrix3; }
    default: { return csm.lightSpaceMatrix0; }
  }
}

fn getCSMCascadeSplit(cascadeIdx: u32) -> f32 {
  switch (cascadeIdx) {
    case 0u: { return csm.cascadeSplits.x; }
    case 1u: { return csm.cascadeSplits.y; }
    case 2u: { return csm.cascadeSplits.z; }
    case 3u: { return csm.cascadeSplits.w; }
    default: { return csm.cascadeSplits.w; }
  }
}

fn selectCascade(viewDepth: f32) -> u32 {
  let cascadeCount = u32(csm.config.x);
  for (var i = 0u; i < cascadeCount; i++) {
    if (viewDepth < getCSMCascadeSplit(i)) {
      return i;
    }
  }
  return cascadeCount - 1u;
}

fn sampleCascadeShadow(
  worldPos: vec3f,
  lightSpaceMatrix: mat4x4f,
  cascadeIdx: u32,
  bias: f32,
  texelSize: f32
) -> f32 {
  let lightSpacePos = lightSpaceMatrix * vec4f(worldPos, 1.0);
  var shadowCoord = lightSpacePos.xyz / lightSpacePos.w;
  shadowCoord.x = shadowCoord.x * 0.5 + 0.5;
  shadowCoord.y = shadowCoord.y * -0.5 + 0.5;
  
  if (shadowCoord.x < 0.0 || shadowCoord.x > 1.0 ||
      shadowCoord.y < 0.0 || shadowCoord.y > 1.0 ||
      shadowCoord.z < 0.0 || shadowCoord.z > 1.0) {
    return 1.0;
  }
  
  let biasedDepth = shadowCoord.z - bias;
  
  var shadow = 0.0;
  let halfKernel = f32(PCF_SAMPLES) / 2.0;
  for (var y = 0; y < PCF_SAMPLES; y++) {
    for (var x = 0; x < PCF_SAMPLES; x++) {
      let offset = vec2f(
        (f32(x) - halfKernel + 0.5) * texelSize,
        (f32(y) - halfKernel + 0.5) * texelSize
      );
      shadow += textureSampleCompareLevel(
        shadowMapArray, shadowSampler,
        shadowCoord.xy + offset,
        i32(cascadeIdx),
        biasedDepth
      );
    }
  }
  return shadow / f32(PCF_SAMPLES * PCF_SAMPLES);
}

fn sampleCSMShadowGrass(worldPos: vec3f, viewDepth: f32) -> f32 {
  let csmEnabled = csm.config.y > 0.5;
  if (!csmEnabled) { return 1.0; }
  
  let cascadeCount = u32(csm.config.x);
  let blendFraction = csm.config.z;
  let bias = 0.002;
  let texelSize = 1.0 / 2048.0;
  
  let cascadeIdx = selectCascade(viewDepth);
  let lightSpaceMatrix = getCSMLightSpaceMatrix(cascadeIdx);
  
  var shadow = sampleCascadeShadow(worldPos, lightSpaceMatrix, cascadeIdx, bias, texelSize);
  
  if (cascadeIdx < cascadeCount - 1u) {
    let currentSplit = getCSMCascadeSplit(cascadeIdx);
    let blendZone = currentSplit * blendFraction;
    let blendStart = currentSplit - blendZone;
    if (viewDepth > blendStart) {
      let nextMatrix = getCSMLightSpaceMatrix(cascadeIdx + 1u);
      let nextShadow = sampleCascadeShadow(worldPos, nextMatrix, cascadeIdx + 1u, bias, texelSize);
      let blend = smoothstep(0.0, 1.0, (viewDepth - blendStart) / blendZone);
      shadow = mix(shadow, nextShadow, blend);
    }
  }
  
  return shadow;
}

// ==================== Fragment Output ====================

struct FragmentOutput {
  @location(0) color: vec4f,
  @location(1) normals: vec4f,  // World-space normal packed [0,1] + metallic in .w
}

// ==================== Fragment Shader ====================

@fragment
fn fragmentMain(
  input: VertexOutput,
  @builtin(front_facing) isFrontFace: bool,
) -> FragmentOutput {
  var fragOutput: FragmentOutput;
  // ---- Self-shadow (concentrated at base) ----
  let selfShadow = mix(0.2, 1.0, pow(input.bladeT, 2.0));
  
  // ---- Base color in linear space ----
  let baseColor = input.color * selfShadow;
  
  // ---- Perlin noise color variation ----
  let noiseVal = perlinNoise2D(0.25 * input.worldPos.xz);
  let colorVariation = 0.75 + 0.25 * noiseVal;
  let modulatedColor = baseColor * colorVariation;
  
  // ---- Normal handling ----
  var normal = normalize(input.normal);
  if (!isFrontFace) {
    normal = -normal;
  }
  let upDir = vec3f(0.0, 1.0, 0.0);
  normal = normalize(mix(upDir, normal, 0.25));
  
  // ---- CSM shadow receiving (skip for distant fragments — beyond fade distance) ----
  let camFwd = csm.cameraForward.xyz;
  let viewDepth = abs(dot(input.worldPos - uniforms.cameraPosition, camFwd));
  var shadowFactor = 1.0;
  if (viewDepth < uniforms.maxFadeDistance) {
    shadowFactor = sampleCSMShadowGrass(input.worldPos, viewDepth);
  }
  
  // ---- Analytical sky-aware lighting ----
  let lightDir = normalize(uniforms.sunDirection);
  let NdotL = max(dot(normal, lightDir), 0.0);
  
  // Hemisphere ambient
  let hemisphereBlend = normal.y * 0.5 + 0.5;
  let ambientColor = mix(uniforms.groundColor, uniforms.skyColor, hemisphereBlend);
  
  // Direct sun/moon light with shadow
  let diffuseColor = uniforms.sunColor * NdotL * shadowFactor;
  
  // Combine ambient + shadowed direct
  let lighting = ambientColor + diffuseColor;
  
  // Subsurface scattering (also attenuated by shadow)
  let viewDir = normalize(uniforms.cameraPosition - input.worldPos);
  let sss = max(dot(-viewDir, lightDir), 0.0) * 0.2 * input.bladeT * uniforms.sunIntensityFactor * shadowFactor;
  
  let finalColor = modulatedColor * (lighting + sss);
  
  fragOutput.color = vec4f(finalColor, 1.0);
  // Pack world-space normal from [-1,1] to [0,1] for G-buffer; grass metallic = 0
  fragOutput.normals = vec4f(normal * 0.5 + 0.5, 0.0);
  return fragOutput;
}
