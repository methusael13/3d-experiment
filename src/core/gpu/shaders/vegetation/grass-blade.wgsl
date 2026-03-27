/**
 * Procedural Grass Blade Shader (v2)
 * 
 * Renders each vegetation instance as a procedural grass blade using
 * a quadratic Bézier curve (P0, P1, P2) with non-linear width tapering,
 * central vein fold, PBR specular highlights, enhanced subsurface scattering,
 * and distance-based height fade.
 * 
 * Per instance data (from spawn buffer):
 *   positionAndScale: vec4f  (xyz = world position = P0, w = blade height)
 *   rotationAndType:  vec4f  (x = Y rotation → blade direction, y = variant, z = renderFlag, w = reserved)
 * 
 * Blade construction:
 *   P0 = bladePosition (ground)
 *   P1 = P0 + vec3(0, bladeHeight, 0) 
 *   P2 = P1 + bladeDirection * bladeHeight * 0.3
 *   Width tapers non-linearly from base to single-vertex pyramid tip.
 * 
 * Features:
 *   - Non-linear taper (pow curve) for sharp pyramid-tip blades
 *   - Central vein fold via normal perturbation (no extra verts)
 *   - PBR specular with anisotropic gloss along blade tangent
 *   - Enhanced wrap-around SSS with thickness-based translucency
 *   - Distance-based height fade (blades shrink at view edges)
 *   - LOD segment reduction (fewer segments for distant blades)
 *   - Distance-based shader simplification (skip shadows for far blades)
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
  bladeMinBendRad: f32,  // Minimum bend angle in radians (0=upright possible, π/2=all flat)
  // Analytical lighting (from DirectionalLight)
  sunDirection: vec3f,
  sunIntensityFactor: f32,
  sunColor: vec3f,
  _pad1: f32,
  skyColor: vec3f,
  _pad2: f32,
  groundColor: vec3f,
  _pad3: f32,
  // Grass blade shape params (new — packed into extended uniforms)
  bladeWidthFactor: f32,   // Width relative to height (default 0.025)
  bladeTaperPower: f32,    // Non-linear taper exponent (default 1.8)
  veinFoldStrength: f32,   // Central vein fold normal perturbation (0-1, default 0.4)
  sssStrength: f32,        // Subsurface scattering strength (0-1, default 0.65)
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

// Group 1: Environment shadow (CSM) + multi-light + spot shadow
@group(1) @binding(1) var shadowSampler: sampler_comparison;
@group(1) @binding(7) var shadowMapArray: texture_depth_2d_array;
@group(1) @binding(8) var<uniform> csm: CSMUniforms;

// Group 2: Vegetation shadow map (dedicated grass blade shadow)
struct VegShadowUniforms {
  lightSpaceMatrix: mat4x4f,
  shadowCenter: vec2f,
  shadowRadius: f32,
  enabled: f32,
  texelSize: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}
@group(2) @binding(0) var vegShadowMap: texture_depth_2d;
@group(2) @binding(1) var vegShadowSampler: sampler_comparison;
@group(2) @binding(2) var<uniform> vegShadow: VegShadowUniforms;

// Multi-light buffers (bindings 10-12)
@group(1) @binding(10) var<uniform> env_lightCounts: GrassLightCounts;
@group(1) @binding(11) var<storage, read> env_pointLights: array<GrassPointLightData>;
@group(1) @binding(12) var<storage, read> env_spotLights: array<GrassSpotLightData>;

// Spot shadow atlas (bindings 13-14)
@group(1) @binding(13) var env_spotShadowAtlas: texture_depth_2d_array;
@group(1) @binding(14) var env_spotShadowSampler: sampler_comparison;

// Cloud shadow map (bindings 5, 17-18) — filtering sampler reused from IBL cube sampler slot
@group(1) @binding(5) var env_cubeSampler: sampler;
@group(1) @binding(17) var env_cloudShadowMap: texture_2d<f32>;
@group(1) @binding(18) var<uniform> env_cloudShadowUniforms: CloudShadowSceneUniforms;

struct CloudShadowSceneUniforms {
  shadowCenter: vec2f,
  shadowRadius: f32,
  averageCoverage: f32,
}

// ==================== Vegetation Shadow Sampling ====================

fn sampleVegetationShadow(worldPos: vec3f) -> f32 {
  if (vegShadow.enabled < 0.5) { return 1.0; }
  
  let lsp = vegShadow.lightSpaceMatrix * vec4f(worldPos, 1.0);
  var sc = lsp.xyz / lsp.w;
  sc.x = sc.x * 0.5 + 0.5;
  sc.y = sc.y * -0.5 + 0.5;
  
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z < 0.0 || sc.z > 1.0) {
    return 1.0;
  }
  
  let bias = 0.003;
  let ts = vegShadow.texelSize;
  
  var shadow = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let offset = vec2f(f32(x) * ts, f32(y) * ts);
      shadow += textureSampleCompareLevel(vegShadowMap, vegShadowSampler, sc.xy + offset, sc.z - bias);
    }
  }
  return shadow / 9.0;
}

fn sampleCloudShadowGrass(worldPos: vec3f) -> f32 {
  let offset = vec2f(worldPos.x, worldPos.z) - env_cloudShadowUniforms.shadowCenter;
  let uv = offset / (env_cloudShadowUniforms.shadowRadius * 2.0) + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 1.0; }
  return textureSampleLevel(env_cloudShadowMap, env_cubeSampler, uv, 0.0).r;
}

// ==================== Multi-Light Data Structures ====================

struct GrassPointLightData {
  position: vec3f,
  range: f32,
  color: vec3f,
  intensity: f32,
};

struct GrassSpotLightData {
  position: vec3f,
  range: f32,
  direction: vec3f,
  intensity: f32,
  color: vec3f,
  innerCos: f32,
  outerCos: f32,
  shadowAtlasIndex: i32,
  cookieAtlasIndex: i32,
  cookieIntensity: f32,
  lightSpaceMatrix: mat4x4f,
};

struct GrassLightCounts {
  numPoint: u32,
  numSpot: u32,
  _pad0: u32,
  _pad1: u32,
};

// ==================== Multi-Light Helper Functions ====================

fn grassAttenuateDistance(distance: f32, range: f32) -> f32 {
  if (range <= 0.0) { return 0.0; }
  let ratio = distance / range;
  if (ratio >= 1.0) { return 0.0; }
  let window = pow(saturate(1.0 - ratio * ratio), 2.0);
  let invDist2 = 1.0 / (distance * distance + 0.01);
  return window * invDist2;
}

fn grassAttenuateSpotCone(cosAngle: f32, innerCos: f32, outerCos: f32) -> f32 {
  return saturate((cosAngle - outerCos) / max(innerCos - outerCos, 0.001));
}

fn sampleGrassSpotShadow(worldPos: vec3f, lightSpaceMatrix: mat4x4f, atlasIndex: i32) -> f32 {
  if (atlasIndex < 0) { return 1.0; }
  let lsp = lightSpaceMatrix * vec4f(worldPos, 1.0);
  let pc = lsp.xyz / lsp.w;
  let suv = pc.xy * 0.5 + 0.5;
  if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 || pc.z > 1.0) { return 1.0; }
  let uv = vec2f(suv.x, 1.0 - suv.y);
  return textureSampleCompareLevel(env_spotShadowAtlas, env_spotShadowSampler, uv, atlasIndex, pc.z - 0.002);
}

fn computeGrassMultiLight(worldPos: vec3f, normal: vec3f) -> vec3f {
  var totalLight = vec3f(0.0);

  let numPoint = min(env_lightCounts.numPoint, 64u);
  for (var i = 0u; i < numPoint; i++) {
    let light = env_pointLights[i];
    let toLight = light.position - worldPos;
    let dist = length(toLight);
    let L = toLight / max(dist, 0.001);
    let NdotL = max(dot(normal, L), 0.0);
    let atten = grassAttenuateDistance(dist, light.range);
    totalLight += light.color * light.intensity * NdotL * atten;
  }

  let numSpot = min(env_lightCounts.numSpot, 32u);
  for (var i = 0u; i < numSpot; i++) {
    let light = env_spotLights[i];
    let toLight = light.position - worldPos;
    let dist = length(toLight);
    let L = toLight / max(dist, 0.001);
    let NdotL = max(dot(normal, L), 0.0);
    let atten = grassAttenuateDistance(dist, light.range);
    let cosAngle = dot(-L, normalize(light.direction));
    let spotFalloff = grassAttenuateSpotCone(cosAngle, light.innerCos, light.outerCos);
    let shadow = sampleGrassSpotShadow(worldPos, light.lightSpaceMatrix, light.shadowAtlasIndex);
    totalLight += light.color * light.intensity * NdotL * atten * spotFalloff * shadow;
  }

  return totalLight;
}

// ==================== Constants ====================

const GRASS_LEANING: f32 = 0.3;
const N_SEGMENTS: u32 = 5u;        // Number of segments along the blade (high LOD)
// Vertex count: (N_SEGMENTS-1) quads × 6 + 3 tip = 27 with N_SEGMENTS=5
const TRIANGLES_PER_BLADE: u32 = 27u;

const PI: f32 = 3.14159265;

// ==================== Vertex Output ====================

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
  @location(1) normal: vec3f,
  @location(2) worldPos: vec3f,
  @location(3) bladeT: f32,         // 0 at base, 1 at tip
  @location(4) bladeSide: f32,      // -1 = left, 0 = center, +1 = right (for vein)
  @location(5) bladeTangent: vec3f, // Tangent along Bézier for anisotropic specular
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

// ==================== Non-Linear Width Taper ====================

/**
 * Compute blade half-width at parameter t using power-curve taper.
 * t=0 → full width, t=1 → 0 (pyramid tip).
 * The taperPower controls how quickly width narrows:
 *   1.0 = linear (old behavior), 1.8 = moderate taper, 3.0 = very sharp tip
 */
fn bladeHalfWidth(t: f32, baseWidth: f32, taperPower: f32) -> f32 {
  return baseWidth * pow(max(1.0 - t, 0.0), taperPower);
}

// ==================== Main Vertex Shader ====================

@vertex
fn vertexMain(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
  let inst = instances[instanceIndex];
  
  let bladePos = inst.positionAndScale.xyz;
  let bladeHeight = inst.positionAndScale.w;
  let rotation = inst.rotationAndType.x;
  
  // Derive blade direction from rotation angle (in XZ plane)
  let bladeDir = vec3f(sin(rotation), 0.0, cos(rotation));
  
  // Perpendicular direction for width (rotate 90° in XZ)
  let perpDir = vec3f(bladeDir.z, 0.0, -bladeDir.x);
  
  // ---- Distance-based height fade (Feature 5) ----
  // Use view-space depth (clipPos.w from perspective projection) instead of Euclidean distance.
  // clipPos.w equals the eye-space Z depth, which matches how CDLOD tiles are culled
  // and ensures fade corresponds to actual screen-space depth.
  let clipPosBase = uniforms.viewProjection * vec4f(bladePos, 1.0);
  let viewDepthBlade = clipPosBase.w; // Eye-space depth from perspective projection
  let fadeStart = uniforms.maxFadeDistance * uniforms.fadeStartRatio;
  let fadeRange = max(uniforms.maxFadeDistance - fadeStart, 0.01);
  let heightFade = smoothstep(0.0, 1.0, saturate((uniforms.maxFadeDistance - viewDepthBlade) / fadeRange));
  let effectiveHeight = bladeHeight * heightFade;
  
  // Early out for fully faded blades (degenerate triangle)
  if (effectiveHeight < 0.001) {
    var output: VertexOutput;
    output.position = vec4f(0.0, 0.0, -2.0, 1.0);
    output.color = vec3f(0.0);
    output.normal = vec3f(0.0, 1.0, 0.0);
    output.worldPos = bladePos;
    output.bladeT = 0.0;
    output.bladeSide = 0.0;
    output.bladeTangent = vec3f(0.0, 1.0, 0.0);
    return output;
  }
  
  // ---- Per-instance bend variation (Fix #4) ----
  // Hash per-instance to get random lean amount and direction.
  // Some blades are upright, others droop heavily simulating weak stems.
  let bendHash1 = hash21(bladePos.xz * 29.3 + 7.7);  // lean amount: 0-1
  let bendHash2 = hash21(bladePos.xz * 47.1 + 13.3); // lean direction angle offset
  // Non-uniform distribution: most blades ~0.2-0.4 lean, few extreme droops
  // Use a power curve to bias toward moderate values with occasional extremes
  // Map random hash through min bend range: leanAmount ranges from minBend to ~π/2
  // minBendRad=0 → range [0.3, 0.9] (original), minBendRad=π/2 → all at ~1.57 (flat)
  let minBendNorm = uniforms.bladeMinBendRad / 1.5708; // Normalize 0-90° to 0-1
  let leanAmount = mix(GRASS_LEANING, 1.5, minBendNorm) + bendHash1 * bendHash1 * mix(0.6, 0.15, minBendNorm); // Narrower random range as min increases
  let leanAngleOffset = (bendHash2 - 0.5) * 1.2; // +/- 0.6 radians sideways lean
  
  // Rotate lean direction: mix bladeDir with perpDir based on lean offset
  let leanDir = normalize(bladeDir * cos(leanAngleOffset) + perpDir * sin(leanAngleOffset));
  
  // Construct Bézier control points with fade-adjusted height and per-instance lean
  var p0 = bladePos;
  var p1 = p0 + vec3f(0.0, effectiveHeight, 0.0);
  var p2 = p1 + leanDir * effectiveHeight * leanAmount;
  
  // ---- Height-based wind influence (Fix #3) ----
  // Wind displaces P1 and P2 proportionally to their height above ground.
  // P0 (base) never moves. P1 (mid-height) gets moderate displacement.
  // P2 (tip) gets full displacement. This uses quadratic (t²) weighting
  // so the base region stays firmly planted.
  let windDisp = computeWindDisplacement(bladePos.xz, uniforms.time);
  // P1 is at normalized height ~0.5 along the blade → t²=0.25 influence
  p1 += windDisp * effectiveHeight * 0.15;
  // P2 is at the tip → full wind influence
  p2 += windDisp * effectiveHeight * 0.5;
  
  // Persistent length correction
  makePersistentLength(p0, &p1, &p2, effectiveHeight);
  
  // ---- Feature 1: Non-linear taper with configurable width ----
  let widthFactor = uniforms.bladeWidthFactor;
  let taperPower = uniforms.bladeTaperPower;
  let baseWidth = effectiveHeight * widthFactor;
  
  // ---- LOD-based segment reduction (Feature 6) ----
  // Close blades: 5 segments (27 verts), mid: 3 segments (15 verts), far: 2 segments (9 verts)
  let lodLevel = u32(uniforms.lodLevel);
  var numSegments = N_SEGMENTS;
  if (lodLevel >= 7u) {
    numSegments = 2u; // Very distant: 2 segments = 1 quad + 1 tip = 9 verts
  } else if (lodLevel >= 4u) {
    numSegments = 3u; // Mid-distance: 3 segments = 2 quads + 1 tip = 15 verts
  }
  // else: full 5 segments = 4 quads + 1 tip = 27 verts
  
  // Decode vertex index into segment + side
  let numQuads = numSegments - 1u;
  let quadVertCount = numQuads * 6u;
  let totalVerts = quadVertCount + 3u;
  
  // If vertex index exceeds the LOD vertex count, emit degenerate
  if (vertexIndex >= totalVerts) {
    var output: VertexOutput;
    output.position = vec4f(0.0, 0.0, -2.0, 1.0);
    output.color = vec3f(0.0);
    output.normal = vec3f(0.0, 1.0, 0.0);
    output.worldPos = bladePos;
    output.bladeT = 0.0;
    output.bladeSide = 0.0;
    output.bladeTangent = vec3f(0.0, 1.0, 0.0);
    return output;
  }
  
  var worldPosition: vec3f;
  var t_param: f32;
  var faceNormal: vec3f;
  var side: f32 = 0.0; // -1 left, +1 right (for vein fold normal perturbation)
  
  if (vertexIndex < quadVertCount) {
    // Quad region
    let quadIndex = vertexIndex / 6u;
    let localVert = vertexIndex % 6u;
    
    // Two t values for the quad
    let t0 = f32(quadIndex) / f32(numQuads);
    let t1 = f32(quadIndex + 1u) / f32(numQuads);
    
    // Non-linear width at each t (Feature 1: power-curve taper)
    let w0 = bladeHalfWidth(t0, baseWidth, taperPower);
    let w1 = bladeHalfWidth(t1, baseWidth, taperPower);
    
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
      case 0u: { worldPosition = left0;  t_param = t0; side = -1.0; }
      case 1u: { worldPosition = right0; t_param = t0; side = 1.0; }
      case 2u: { worldPosition = left1;  t_param = t1; side = -1.0; }
      case 3u: { worldPosition = left1;  t_param = t1; side = -1.0; }
      case 4u: { worldPosition = right0; t_param = t0; side = 1.0; }
      default: { worldPosition = right1; t_param = t1; side = 1.0; }
    }
    
    // Face normal (cross product of quad edges)
    let edge1 = pos1 - pos0;
    let edge2 = perpDir;
    faceNormal = normalize(cross(edge1, edge2));
  } else {
    // Tip triangle (last 3 vertices) — single vertex at tip (Feature 1: pyramid)
    let tipLocalVert = vertexIndex - quadVertCount;
    let tPrev = f32(numQuads - 1u) / f32(numQuads);
    let tTip = 1.0;
    
    let posPrev = evalBezier(p0, p1, p2, tPrev);
    let posTip = evalBezier(p0, p1, p2, tTip);
    let wPrev = bladeHalfWidth(tPrev, baseWidth, taperPower);
    
    let leftPrev  = posPrev - perpDir * wPrev;
    let rightPrev = posPrev + perpDir * wPrev;
    
    switch tipLocalVert {
      case 0u: { worldPosition = leftPrev;  t_param = tPrev; side = -1.0; }
      case 1u: { worldPosition = rightPrev; t_param = tPrev; side = 1.0; }
      default: { worldPosition = posTip;    t_param = tTip;  side = 0.0; }
    }
    
    let edge1 = posTip - posPrev;
    let edge2 = perpDir;
    faceNormal = normalize(cross(edge1, edge2));
  }
  
  // ---- Feature 2: Central vein fold (normal perturbation) ----
  // Tilt normals outward from the blade center line to simulate a V-fold
  let veinFold = uniforms.veinFoldStrength;
  let foldedNormal = normalize(faceNormal + perpDir * side * veinFold);
  
  // Compute tangent along Bézier curve for anisotropic specular
  let tangent = normalize(evalBezierDerivative(p0, p1, p2, t_param));
  
  // Color gradient: darker green at base, lighter at tip
  let baseColor = uniforms.fallbackColor;
  let tipColor = baseColor * 1.4 + vec3f(0.1, 0.15, 0.0);
  let bladeColor = mix(baseColor, tipColor, t_param);
  
  // Per-instance color variation
  let colorVar = hash21(bladePos.xz * 13.7) * 0.2 - 0.1;
  let finalColor = bladeColor + vec3f(colorVar * 0.5, colorVar, colorVar * 0.3);
  
  var output: VertexOutput;
  output.position = uniforms.viewProjection * vec4f(worldPosition, 1.0);
  output.color = finalColor;
  output.normal = foldedNormal;
  output.worldPos = worldPosition;
  output.bladeT = t_param;
  output.bladeSide = side;
  output.bladeTangent = tangent;
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

  // ---- Analytical inter-blade shadow (light-direction-aware) ----
  let lightDir_ib = normalize(uniforms.sunDirection);
  let lightElevation = max(dot(lightDir_ib, vec3f(0.0, 1.0, 0.0)), 0.0);
  let lightGrazeFactor = 1.0 - lightElevation;
  let shadowDepth = mix(0.25, 0.85, lightGrazeFactor);
  let analyticalShadow = smoothstep(0.0, shadowDepth, input.bladeT);
  let bladeFacingLight = max(dot(normalize(input.normal.xz), -lightDir_ib.xz), 0.0);
  let facingPenalty = mix(1.0, 0.65, (1.0 - bladeFacingLight) * lightGrazeFactor);
  let interBladeShadow = mix(0.12, 1.0, analyticalShadow) * facingPenalty;

  // ---- Base color in linear space ----
  let baseColor = input.color * interBladeShadow;
  
  // ---- Perlin noise color variation ----
  let noiseVal = perlinNoise2D(0.25 * input.worldPos.xz);
  let colorVariation = 0.75 + 0.25 * noiseVal;
  let modulatedColor = baseColor * colorVariation;
  
  // ---- Feature 2: Central vein darkening ----
  // Darken color along the blade center line (midrib) based on bladeSide
  let veinProximity = 1.0 - smoothstep(0.0, 0.35, abs(input.bladeSide));
  let veinDarkening = mix(1.0, 0.82, veinProximity * uniforms.veinFoldStrength);
  let veinedColor = modulatedColor * veinDarkening;
  
  // ---- Normal handling ----
  var normal = normalize(input.normal);
  if (!isFrontFace) {
    normal = -normal;
  }
  let upDir = vec3f(0.0, 1.0, 0.0);
  normal = normalize(mix(upDir, normal, 0.25));
  
  // ---- View depth ----
  let camFwd = csm.cameraForward.xyz;
  let viewDepth = abs(dot(input.worldPos - uniforms.cameraPosition, camFwd));
  let viewDir = normalize(uniforms.cameraPosition - input.worldPos);
  let lightDir = normalize(uniforms.sunDirection);
  
  // ---- Feature 6: Distance-based shader simplification ----
  // Close blades get full PBR + all shadows; far blades get simplified lighting
  let cheapShadingDist = uniforms.maxFadeDistance * 0.5; // Half max distance
  let useExpensiveShading = viewDepth < cheapShadingDist;
  
  // ---- Shadow sampling (conditional on distance) ----
  var shadowFactor = 1.0;
  var vegShadowFactor = 1.0;
  var cloudShadow = 1.0;
  
  if (useExpensiveShading) {
    // Full shadow sampling for close blades
    if (viewDepth < uniforms.maxFadeDistance) {
      shadowFactor = sampleCSMShadowGrass(input.worldPos, viewDepth);
    }
    vegShadowFactor = sampleVegetationShadow(input.worldPos);
    cloudShadow = sampleCloudShadowGrass(input.worldPos);
  } else {
    // Simplified: only CSM cascade 0 (no PCF blending, no veg shadow, no cloud shadow)
    if (viewDepth < uniforms.maxFadeDistance) {
      let csmEnabled = csm.config.y > 0.5;
      if (csmEnabled) {
        let cascadeIdx = selectCascade(viewDepth);
        shadowFactor = sampleCascadeShadow(input.worldPos, getCSMLightSpaceMatrix(cascadeIdx), cascadeIdx, 0.002, 1.0 / 2048.0);
      }
    }
  }
  
  let combinedShadow = shadowFactor * cloudShadow * vegShadowFactor;
  
  // ---- Analytical sky-aware lighting ----
  let NdotL = max(dot(normal, lightDir), 0.0);
  
  // Hemisphere ambient
  let hemisphereBlend = normal.y * 0.5 + 0.5;
  let ambientColor = mix(uniforms.groundColor, uniforms.skyColor, hemisphereBlend);
  
  // Direct sun/moon light with shadow
  let diffuseColor = uniforms.sunColor * NdotL * combinedShadow;
  
  // ---- Feature 2: PBR Specular with anisotropic gloss ----
  var specularContrib = vec3f(0.0);
  if (useExpensiveShading) {
    let halfVec = normalize(viewDir + lightDir);
    let NdotH = max(dot(normal, halfVec), 0.0);
    let VdotH = max(dot(viewDir, halfVec), 0.0);
    
    // Grass PBR parameters
    let grassRoughness = 0.55;
    let grassSpecular = 0.3;
    
    // GGX-lite specular (simplified for grass performance)
    let alpha = grassRoughness * grassRoughness;
    let alpha2 = alpha * alpha;
    let denom = NdotH * NdotH * (alpha2 - 1.0) + 1.0;
    let D = alpha2 / (PI * denom * denom + 0.0001);
    
    // Fresnel (Schlick) for edge highlights — gives waxy gloss at grazing angles
    let F0 = 0.04; // Dielectric grass surface
    let fresnel = F0 + (1.0 - F0) * pow(1.0 - VdotH, 5.0);
    
    // Anisotropic term along blade tangent — directional metallic sheen
    let tangent = normalize(input.bladeTangent);
    let TdotH = dot(tangent, halfVec);
    let anisotropicBoost = exp(-2.0 * TdotH * TdotH / max(alpha + 0.01, 0.001));
    
    specularContrib = uniforms.sunColor * D * fresnel * anisotropicBoost * grassSpecular * combinedShadow;
  }
  
  // Combine ambient + shadowed direct
  let lighting = ambientColor + diffuseColor;
  
  // Multi-light contribution (point + spot lights with spot shadows)
  var multiLight = vec3f(0.0);
  if (useExpensiveShading) {
    multiLight = computeGrassMultiLight(input.worldPos, normal);
  }
  
  // ---- Feature 3: Enhanced Subsurface Scattering ----
  // Wrap-around translucency — light passing through the blade from behind
  let sssStrength = uniforms.sssStrength;
  var sssColor = vec3f(0.0);
  if (sssStrength > 0.001) {
    // Transmittance direction: slightly biased by normal for more natural spread
    let transmittanceDir = normalize(-lightDir + normal * 0.2);
    let VdotT = max(dot(viewDir, transmittanceDir), 0.0);
    // Sharper falloff (power 3) for focused backlight glow
    let sssBase = pow(VdotT, 3.0);
    
    // Thickness approximation: tip is thinner → more translucent
    let thickness = mix(0.15, 0.85, 1.0 - input.bladeT);
    let transmittance = (1.0 - thickness);
    
    // SSS factor combines intensity, thickness, and blade parameter
    let sssFactor = sssBase * transmittance * sssStrength;
    
    // Tint through blade color (sunlight passing through green tissue)
    sssColor = uniforms.sunColor * veinedColor * sssFactor * uniforms.sunIntensityFactor * combinedShadow;
  }
  
  let finalColor = veinedColor * (lighting + specularContrib) + veinedColor * multiLight + sssColor;
  
  fragOutput.color = vec4f(finalColor, 1.0);
  // Pack world-space normal from [-1,1] to [0,1] for G-buffer; grass metallic = 0
  fragOutput.normals = vec4f(normal * 0.5 + 0.5, 0.0);
  return fragOutput;
}
