/**
 * Vegetation Mesh Instance Shader
 * 
 * Renders 3D vegetation meshes using instanced rendering.
 * Reads instance data from a shared storage buffer (same as billboard renderer).
 * Only renders instances with renderFlag = 1 (mesh mode).
 * 
 * Features:
 * - Per-instance Y-axis rotation and scale
 * - Per-submesh wind multiplier
 * - Alpha cutout for leaves/petals
 * - CSM shadow receiving
 * - Hemisphere ambient + sun-color-tinted directional lighting (matches grass-blade shader)
 */

// ==================== Debug Mode ====================
const DEBUG_RENDER_MODE_COLOR: bool = false;
const DEBUG_MESH_COLOR: vec3f = vec3f(1.0, 0.0, 0.8); // Magenta

// ==================== Shared Instance Struct ====================

struct PlantInstance {
  positionAndScale: vec4f,  // xyz = world pos, w = scale
  rotationAndType: vec4f,   // x = Y rotation, y = variant, z = renderFlag (1=mesh), w = reserved
}

// ==================== Uniforms ====================
// All per-draw data in a single dynamic uniform buffer (no separate wind buffer)

struct MeshUniforms {
  viewProjection: mat4x4f,          // 64 bytes (offset 0)
  cameraPosition: vec3f,            // 12 bytes (offset 64)
  time: f32,                        // 4 bytes  (offset 76)
  windMultiplier: f32,              // 4 bytes  (offset 80) — per-submesh
  maxDistance: f32,                  // 4 bytes  (offset 84)
  windStrength: f32,                // 4 bytes  (offset 88) — already scaled by windInfluence
  windFrequency: f32,               // 4 bytes  (offset 92)
  windDirection: vec2f,             // 8 bytes  (offset 96)
  gustStrength: f32,                // 4 bytes  (offset 104)
  gustFrequency: f32,               // 4 bytes  (offset 108)
  // Lighting (matches grass-blade shader)
  sunDirection: vec3f,              // 12 bytes (offset 112)
  sunIntensityFactor: f32,          // 4 bytes  (offset 124)
  sunColor: vec3f,                  // 12 bytes (offset 128)
  _pad1: f32,                       // 4 bytes  (offset 140)
  skyColor: vec3f,                  // 12 bytes (offset 144)
  _pad2: f32,                       // 4 bytes  (offset 156)
  groundColor: vec3f,               // 12 bytes (offset 160)
  _pad3: f32,                       // 4 bytes  (offset 172)
}
// Total: 176 bytes

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

// Group 0: Per-draw data (uniforms include wind + light)
@group(0) @binding(0) var<uniform> uniforms: MeshUniforms;
@group(0) @binding(1) var<storage, read> instances: array<PlantInstance>;
@group(0) @binding(2) var baseColorTexture: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;

// Group 1: Environment shadow (CSM)
@group(1) @binding(1) var shadowSampler: sampler_comparison;
@group(1) @binding(7) var shadowMapArray: texture_depth_2d_array;
@group(1) @binding(8) var<uniform> csm: CSMUniforms;

// ==================== Vertex IO ====================

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) worldPos: vec3f,
  @location(2) worldNormal: vec3f,
}

// ==================== Wind ====================

fn fbm2D(p: vec2f) -> f32 {
  var value = 0.0;
  var amp = 0.5;
  var pos = p;
  value += amp * (sin(pos.x) * cos(pos.y * 1.3) * 0.5 + 0.5);
  pos *= 2.1;
  amp *= 0.5;
  value += amp * (sin(pos.x * 0.8) * cos(pos.y * 1.1) * 0.5 + 0.5);
  return value;
}

fn applyMeshWind(worldPos: vec3f, vertexHeight: f32, windMult: f32) -> vec3f {
  if (windMult < 0.001 || uniforms.windStrength < 0.001) { return worldPos; }
  
  let phase = dot(worldPos.xz, uniforms.windDirection) * 0.1 + uniforms.time * uniforms.windFrequency;
  let baseWind = sin(phase) * uniforms.windStrength;
  
  let gustUV = worldPos.xz * uniforms.gustFrequency + uniforms.time * 0.3;
  let gustNoise = fbm2D(gustUV) * 2.0 - 1.0;
  let localGust = gustNoise * uniforms.gustStrength;
  
  let displacement = (baseWind + localGust) * vertexHeight * vertexHeight * windMult;
  
  return worldPos + vec3f(uniforms.windDirection.x, 0.0, uniforms.windDirection.y) * displacement;
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

fn sampleCSMShadowVeg(worldPos: vec3f, viewDepth: f32) -> f32 {
  let csmEnabled = csm.config.y > 0.5;
  if (!csmEnabled) { return 1.0; }
  
  let cascadeCount = u32(csm.config.x);
  let blendFraction = csm.config.z;
  let bias = 0.003;
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

// ==================== Vertex Shader ====================

@vertex
fn vertexMain(
  @builtin(instance_index) instanceIndex: u32,
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
) -> VertexOutput {
  let instance = instances[instanceIndex];
  var output: VertexOutput;
  
  if (instance.rotationAndType.z < 0.5) {
    output.position = vec4f(0.0, 0.0, 0.0, 0.0);
    return output;
  }
  
  let worldPosBase = instance.positionAndScale.xyz;
  
  let distToCamera = distance(worldPosBase, uniforms.cameraPosition);
  if (distToCamera > uniforms.maxDistance) {
    output.position = vec4f(0.0, 0.0, 0.0, 0.0);
    return output;
  }
  let scale = instance.positionAndScale.w;
  let rotation = instance.rotationAndType.x;
  
  let cosR = cos(rotation);
  let sinR = sin(rotation);
  let rotatedPos = vec3f(
    position.x * cosR - position.z * sinR,
    position.y,
    position.x * sinR + position.z * cosR
  );
  let rotatedNormal = vec3f(
    normal.x * cosR - normal.z * sinR,
    normal.y,
    normal.x * sinR + normal.z * cosR
  );
  
  var worldPos = worldPosBase + rotatedPos * scale + vec3f(0.0, scale * 0.5, 0.0);
  
  let vertexHeight = saturate(position.y * 2.0);
  worldPos = applyMeshWind(worldPos, vertexHeight, uniforms.windMultiplier);
  
  output.position = uniforms.viewProjection * vec4f(worldPos, 1.0);
  output.uv = uv;
  output.worldPos = worldPos;
  output.worldNormal = normalize(rotatedNormal);
  
  return output;
}

// ==================== Fragment Shader ====================

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let baseColor = textureSample(baseColorTexture, texSampler, input.uv);
  
  if (baseColor.a < 0.5) {
    discard;
  }
  
  let lightDir = normalize(uniforms.sunDirection);
  let normal = normalize(input.worldNormal);
  let NdotL = max(dot(normal, lightDir), 0.0);
  
  // Hemisphere ambient (matches grass-blade shader)
  let hemisphereBlend = normal.y * 0.5 + 0.5;
  let ambientColor = mix(uniforms.groundColor, uniforms.skyColor, hemisphereBlend);
  
  // CSM shadow receiving (skip for distant fragments)
  let cameraForward = csm.cameraForward.xyz;
  let viewDepth = abs(dot(input.worldPos - uniforms.cameraPosition, cameraForward));
  var shadowFactor = 1.0;
  if (viewDepth < uniforms.maxDistance) {
    shadowFactor = sampleCSMShadowVeg(input.worldPos, viewDepth);
  }
  
  // Direct sun light with shadow + sun color tint (matches grass-blade shader)
  let diffuseColor = uniforms.sunColor * NdotL * shadowFactor;
  
  // Combine ambient + shadowed direct
  let lighting = ambientColor + diffuseColor;
  
  var finalColor: vec3f;
  if (DEBUG_RENDER_MODE_COLOR) {
    finalColor = DEBUG_MESH_COLOR * (ambientColor.r + diffuseColor.r);
  } else {
    finalColor = baseColor.rgb * lighting;
  }
  
  return vec4f(finalColor, baseColor.a);
}