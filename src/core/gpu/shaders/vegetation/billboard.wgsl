/**
 * Vegetation Billboard Shader
 * 
 * Renders camera-facing quads for vegetation instances.
 * Reads instance data from a storage buffer (shared with mesh renderer).
 * Only renders instances with renderFlag = 0 (billboard mode).
 * 
 * Features:
 * - Y-axis aligned billboarding (always upright)
 * - Wind animation (base oscillation + local gusts)
 * - Alpha cutout for vegetation edges
 * - Distance-based fade out
 * - Optional texture atlas support
 * - Normal map support (tangent-space → world-space)
 * - Translucency / subsurface scattering
 * - CSM shadow receiving
 * - Vegetation shadow map receiving (grass-on-grass)
 * - Cloud shadow receiving
 * - Multi-light support (point + spot with shadows)
 * - Hemisphere ambient lighting
 */

// ==================== Debug Mode ====================
// Set to true to visualize billboard instances as solid cyan
// (mesh instances will be magenta in vegetation-mesh.wgsl)
const DEBUG_RENDER_MODE_COLOR: bool = false;
const DEBUG_BILLBOARD_COLOR: vec3f = vec3f(0.0, 0.8, 1.0); // Cyan

// Set to true to visualize CDLOD LOD level per tile
// Each LOD level gets a distinct color: highest LOD (leaf) = green, lowest (root) = red
const DEBUG_LOD_LEVEL_COLOR: bool = false;

// ==================== Shared Instance Struct ====================

struct PlantInstance {
  positionAndScale: vec4f,  // xyz = world pos, w = scale
  rotationAndType: vec4f,   // x = Y rotation, y = variant, z = renderFlag (0=billboard), w = reserved
}

// ==================== Uniforms ====================

struct Uniforms {
  viewProjection: mat4x4f,
  cameraPosition: vec3f,
  time: f32,
  maxFadeDistance: f32,
  fadeStartRatio: f32,      // e.g. 0.75 = start fading at 75% of max distance
  lodLevel: f32,            // CDLOD LOD level (0=root/coarsest, N=leaf/finest) for debug vis
  maxLodLevels: f32,        // Total LOD levels in quadtree (e.g., 10)
  fallbackColor: vec3f,     // Plant type color when no texture assigned
  useTexture: f32,          // 1.0 = real texture provided, 0.0 = use fallback color
  atlasRegion: vec4f,       // xy = UV offset (0-1), zw = UV size (0-1). If zw = 0, no atlas remapping.
  // Analytical lighting (from DirectionalLight)
  sunDirection: vec3f,
  sunIntensityFactor: f32,
  sunColor: vec3f,
  useNormalMap: f32,        // 1.0 = normal map provided, 0.0 = use geometric normal
  skyColor: vec3f,
  useTranslucencyMap: f32,  // 1.0 = translucency map provided, 0.0 = no translucency
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

// ==================== Bindings ====================

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<uniform> wind: WindParams;
@group(0) @binding(2) var<storage, read> instances: array<PlantInstance>;
@group(0) @binding(3) var plantTexture: texture_2d<f32>;
@group(0) @binding(4) var plantSampler: sampler;
@group(0) @binding(5) var normalMap: texture_2d<f32>;
@group(0) @binding(6) var translucencyMap: texture_2d<f32>;

// ==================== Group 1: Environment shadow (CSM) + multi-light + spot shadow + cloud shadow ====================

struct CSMUniforms {
  lightSpaceMatrix0: mat4x4f,
  lightSpaceMatrix1: mat4x4f,
  lightSpaceMatrix2: mat4x4f,
  lightSpaceMatrix3: mat4x4f,
  cascadeSplits: vec4f,
  config: vec4f,       // x=cascadeCount, y=csmEnabled, z=blendFraction, w=pad
  cameraForward: vec4f, // xyz = normalized camera forward, w = 0
}

@group(1) @binding(1) var shadowSampler: sampler_comparison;
@group(1) @binding(7) var shadowMapArray: texture_depth_2d_array;
@group(1) @binding(8) var<uniform> csm: CSMUniforms;

// Multi-light buffers (bindings 10-12)
@group(1) @binding(10) var<uniform> env_lightCounts: BillboardLightCounts;
@group(1) @binding(11) var<storage, read> env_pointLights: array<BillboardPointLightData>;
@group(1) @binding(12) var<storage, read> env_spotLights: array<BillboardSpotLightData>;

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

// ==================== Group 2: Vegetation shadow map ====================

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

fn sampleCloudShadowBillboard(worldPos: vec3f) -> f32 {
  let offset = vec2f(worldPos.x, worldPos.z) - env_cloudShadowUniforms.shadowCenter;
  let uv = offset / (env_cloudShadowUniforms.shadowRadius * 2.0) + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 1.0; }
  return textureSampleLevel(env_cloudShadowMap, env_cubeSampler, uv, 0.0).r;
}

// ==================== Multi-Light Data Structures ====================

struct BillboardPointLightData {
  position: vec3f,
  range: f32,
  color: vec3f,
  intensity: f32,
};

struct BillboardSpotLightData {
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

struct BillboardLightCounts {
  numPoint: u32,
  numSpot: u32,
  _pad0: u32,
  _pad1: u32,
};

// ==================== Multi-Light Helper Functions ====================

fn billboardAttenuateDistance(distance: f32, range: f32) -> f32 {
  if (range <= 0.0) { return 0.0; }
  let ratio = distance / range;
  if (ratio >= 1.0) { return 0.0; }
  let window = pow(saturate(1.0 - ratio * ratio), 2.0);
  let invDist2 = 1.0 / (distance * distance + 0.01);
  return window * invDist2;
}

fn billboardAttenuateSpotCone(cosAngle: f32, innerCos: f32, outerCos: f32) -> f32 {
  return saturate((cosAngle - outerCos) / max(innerCos - outerCos, 0.001));
}

fn sampleBillboardSpotShadow(worldPos: vec3f, lightSpaceMatrix: mat4x4f, atlasIndex: i32) -> f32 {
  if (atlasIndex < 0) { return 1.0; }
  let lsp = lightSpaceMatrix * vec4f(worldPos, 1.0);
  let pc = lsp.xyz / lsp.w;
  let suv = pc.xy * 0.5 + 0.5;
  if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 || pc.z > 1.0) { return 1.0; }
  let uv = vec2f(suv.x, 1.0 - suv.y);
  return textureSampleCompareLevel(env_spotShadowAtlas, env_spotShadowSampler, uv, atlasIndex, pc.z - 0.002);
}

fn computeBillboardMultiLight(worldPos: vec3f, normal: vec3f) -> vec3f {
  var totalLight = vec3f(0.0);

  let numPoint = min(env_lightCounts.numPoint, 64u);
  for (var i = 0u; i < numPoint; i++) {
    let light = env_pointLights[i];
    let toLight = light.position - worldPos;
    let dist = length(toLight);
    let L = toLight / max(dist, 0.001);
    let NdotL = max(dot(normal, L), 0.0);
    let atten = billboardAttenuateDistance(dist, light.range);
    totalLight += light.color * light.intensity * NdotL * atten;
  }

  let numSpot = min(env_lightCounts.numSpot, 32u);
  for (var i = 0u; i < numSpot; i++) {
    let light = env_spotLights[i];
    let toLight = light.position - worldPos;
    let dist = length(toLight);
    let L = toLight / max(dist, 0.001);
    let NdotL = max(dot(normal, L), 0.0);
    let atten = billboardAttenuateDistance(dist, light.range);
    let cosAngle = dot(-L, normalize(light.direction));
    let spotFalloff = billboardAttenuateSpotCone(cosAngle, light.innerCos, light.outerCos);
    let shadow = sampleBillboardSpotShadow(worldPos, light.lightSpaceMatrix, light.shadowAtlasIndex);
    totalLight += light.color * light.intensity * NdotL * atten * spotFalloff * shadow;
  }

  return totalLight;
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

fn sampleCSMShadowBillboard(worldPos: vec3f, viewDepth: f32) -> f32 {
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

// ==================== Vertex IO ====================

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) worldPos: vec3f,
  @location(2) color: vec3f,
  @location(3) alpha: f32,
  @location(4) tangent: vec3f,
  @location(5) bitangent: vec3f,
  @location(6) geometricNormal: vec3f,
}

// ==================== Wind Functions ====================

fn fbm2D(p: vec2f) -> f32 {
  var value = 0.0;
  var amp = 0.5;
  var pos = p;
  
  value += amp * (sin(pos.x * 1.0) * cos(pos.y * 1.3) * 0.5 + 0.5);
  pos *= 2.1;
  amp *= 0.5;
  value += amp * (sin(pos.x * 0.8) * cos(pos.y * 1.1) * 0.5 + 0.5);
  
  return value;
}

fn applyWind(worldPos: vec3f, vertexHeight: f32) -> vec3f {
  let phase = dot(worldPos.xz, wind.direction) * 0.1 + uniforms.time * wind.frequency;
  let baseWind = sin(phase) * wind.strength;
  
  let gustUV = worldPos.xz * wind.gustFrequency + uniforms.time * 0.3;
  let gustNoise = fbm2D(gustUV) * 2.0 - 1.0;
  let localGust = gustNoise * wind.gustStrength;
  
  let displacement = (baseWind + localGust) * vertexHeight * vertexHeight;
  
  return worldPos + vec3f(wind.direction.x, 0.0, wind.direction.y) * displacement;
}

// ==================== Vertex Shader ====================

@vertex
fn vertexMain(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
  let instance = instances[instanceIndex];
  var output: VertexOutput;
  
  // Skip mesh-flagged instances (renderFlag > 0.5 means it's a 3D mesh instance)
  if (instance.rotationAndType.z > 0.5) {
    output.position = vec4f(0.0, 0.0, 0.0, 0.0);
    output.alpha = 0.0;
    return output;
  }
  
  let worldPosBase = instance.positionAndScale.xyz;
  let scale = instance.positionAndScale.w;
  let rotation = instance.rotationAndType.x;
  
  // Cross-billboard: two quads at 90° forming an X shape (12 vertices total)
  let quadPositions = array<vec2f, 6>(
    vec2f(-0.5, 0.0), vec2f(0.5, 0.0), vec2f(0.5, 1.0),
    vec2f(-0.5, 0.0), vec2f(0.5, 1.0), vec2f(-0.5, 1.0)
  );
  let quadUVs = array<vec2f, 6>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(0.0, 0.0)
  );
  
  let localVertIdx = vertexIndex % 12u;
  let quadIdx = localVertIdx / 6u;
  let vertInQuad = localVertIdx % 6u;
  
  let localPos = quadPositions[vertInQuad];
  let uv = quadUVs[vertInQuad];
  let vertexHeight = localPos.y; // 0 at base, 1 at top
  
  // Per-instance Y rotation + 90° offset for second quad
  let quadAngle = rotation + f32(quadIdx) * 1.5707963; // PI/2
  let cosR = cos(quadAngle);
  let sinR = sin(quadAngle);
  let right = vec3f(cosR, 0.0, sinR); // Tangent direction in XZ plane
  
  // Build world position
  var worldPos = worldPosBase;
  worldPos += right * localPos.x * scale;
  worldPos.y += localPos.y * scale;
  
  // Apply wind
  worldPos = applyWind(worldPos, vertexHeight);
  
  // Distance fade
  let dist = distance(worldPos, uniforms.cameraPosition);
  let fadeStart = uniforms.maxFadeDistance * uniforms.fadeStartRatio;
  let fade = 1.0 - smoothstep(fadeStart, uniforms.maxFadeDistance, dist);
  
  output.position = uniforms.viewProjection * vec4f(worldPos, 1.0);
  
  // Atlas region UV remapping
  var finalUV = uv;
  if (uniforms.atlasRegion.z > 0.0) {
    finalUV = uniforms.atlasRegion.xy + uv * uniforms.atlasRegion.zw;
  }
  output.uv = finalUV;
  output.worldPos = worldPos;
  output.color = uniforms.fallbackColor;
  output.alpha = fade;
  
  // Compute TBN basis for normal mapping
  // Tangent = right direction (along quad width)
  // Normal = perpendicular to quad face
  // Bitangent = up direction (along quad height)
  let up = vec3f(0.0, 1.0, 0.0);
  let faceNormal = normalize(cross(right, up));
  output.tangent = right;
  output.bitangent = up;
  output.geometricNormal = faceNormal;
  
  return output;
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
  // Sample texture
  let texColor = textureSample(plantTexture, plantSampler, input.uv);
  
  // Alpha cutout
  if (texColor.a < 0.5) {
    discard;
  }
  
  // Apply distance fade
  if (input.alpha < 0.01) {
    discard;
  }
  
  // ---- Normal handling ----
  var normal: vec3f;
  if (uniforms.useNormalMap > 0.5) {
    // Sample tangent-space normal from normal map
    let normalSample = textureSample(normalMap, plantSampler, input.uv).rgb;
    let tangentNormal = normalSample * 2.0 - 1.0;
    
    // Build TBN matrix and transform to world space
    let T = normalize(input.tangent);
    let B = normalize(input.bitangent);
    var N = normalize(input.geometricNormal);
    if (!isFrontFace) {
      N = -N;
    }
    
    normal = normalize(T * tangentNormal.x + B * tangentNormal.y + N * tangentNormal.z);
  } else {
    // Fallback: bias towards up direction (vegetation tends to be upward-facing)
    var geoNormal = normalize(input.geometricNormal);
    if (!isFrontFace) {
      geoNormal = -geoNormal;
    }
    let upDir = vec3f(0.0, 1.0, 0.0);
    normal = normalize(mix(upDir, geoNormal, 0.3));
  }
  
  // ---- Translucency / subsurface scattering ----
  var translucency = 0.0;
  if (uniforms.useTranslucencyMap > 0.5) {
    translucency = textureSample(translucencyMap, plantSampler, input.uv).r;
  } else {
    // Default: slight translucency for vegetation foliage (more at top)
    translucency = 0.15;
  }
  
  // ---- Base color ----
  var baseColor: vec3f;
  if (DEBUG_LOD_LEVEL_COLOR) {
    let lod = u32(uniforms.lodLevel);
    switch lod {
      case 0u:  { baseColor = vec3f(1.0, 0.0, 0.0); }
      case 1u:  { baseColor = vec3f(1.0, 0.3, 0.0); }
      case 2u:  { baseColor = vec3f(1.0, 0.6, 0.0); }
      case 3u:  { baseColor = vec3f(1.0, 0.9, 0.0); }
      case 4u:  { baseColor = vec3f(0.7, 1.0, 0.0); }
      case 5u:  { baseColor = vec3f(0.3, 1.0, 0.0); }
      case 6u:  { baseColor = vec3f(0.0, 1.0, 0.3); }
      case 7u:  { baseColor = vec3f(0.0, 1.0, 0.7); }
      case 8u:  { baseColor = vec3f(0.0, 0.7, 1.0); }
      case 9u:  { baseColor = vec3f(0.0, 0.3, 1.0); }
      default:  { baseColor = vec3f(0.5, 0.0, 1.0); }
    }
  } else if (DEBUG_RENDER_MODE_COLOR) {
    baseColor = DEBUG_BILLBOARD_COLOR;
  } else if (uniforms.useTexture > 0.5) {
    baseColor = texColor.rgb;
  } else {
    baseColor = input.color;
  }
  
  // ---- CSM shadow receiving ----
  let camFwd = csm.cameraForward.xyz;
  let viewDepth = abs(dot(input.worldPos - uniforms.cameraPosition, camFwd));
  var shadowFactor = 1.0;
  if (viewDepth < uniforms.maxFadeDistance) {
    shadowFactor = sampleCSMShadowBillboard(input.worldPos, viewDepth);
  }
  
  // ---- Vegetation shadow map sampling (grass/billboard-on-grass shadows) ----
  let vegShadowFactor = sampleVegetationShadow(input.worldPos);
  
  // ---- Cloud shadow ----
  let cloudShadow = sampleCloudShadowBillboard(input.worldPos);
  let combinedShadow = shadowFactor * cloudShadow * vegShadowFactor;
  
  // ---- Analytical sky-aware lighting ----
  let lightDir = normalize(uniforms.sunDirection);
  let NdotL = max(dot(normal, lightDir), 0.0);
  
  // Hemisphere ambient
  let hemisphereBlend = normal.y * 0.5 + 0.5;
  let ambientColor = mix(uniforms.groundColor, uniforms.skyColor, hemisphereBlend);
  
  // Direct sun/moon light with shadow
  let diffuseColor = uniforms.sunColor * NdotL * combinedShadow;
  
  // Combine ambient + shadowed direct
  let lighting = ambientColor + diffuseColor;
  
  // ---- Multi-light contribution (point + spot lights with spot shadows) ----
  var multiLight = vec3f(0.0);
  if (viewDepth < uniforms.maxFadeDistance) {
    multiLight = computeBillboardMultiLight(input.worldPos, normal);
  }
  
  // ---- Subsurface scattering (translucency) ----
  // Light passing through thin vegetation (leaves, petals)
  let viewDir = normalize(uniforms.cameraPosition - input.worldPos);
  let sssForward = max(dot(-viewDir, lightDir), 0.0);
  let sssFactor = sssForward * translucency * uniforms.sunIntensityFactor * combinedShadow;
  // Tint SSS slightly with the base color for colored translucency
  let sssColor = uniforms.sunColor * sssFactor * 0.5;
  
  let finalColor = baseColor * (lighting + sssColor) + baseColor * multiLight;
  
  fragOutput.color = vec4f(finalColor, texColor.a * input.alpha);
  // Pack world-space normal from [-1,1] to [0,1] for G-buffer; billboard metallic = 0
  fragOutput.normals = vec4f(normal * 0.5 + 0.5, 0.0);
  return fragOutput;
}
