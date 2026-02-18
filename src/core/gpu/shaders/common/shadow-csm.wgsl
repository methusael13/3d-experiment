/**
 * Cascaded Shadow Maps (CSM) Sampling Functions
 * 
 * This file provides CSM shadow sampling with:
 * - Cascade selection based on view-space depth
 * - Smooth cascade blending for seamless transitions
 * - PCF soft shadows support
 * - Fallback to single shadow map when CSM disabled
 */

// ============================================================================
// CSM Uniforms Structure (must match ShadowRendererGPU.ts)
// ============================================================================

struct CSMUniforms {
  // 4 light space matrices (256 bytes)
  lightSpaceMatrix0: mat4x4f,
  lightSpaceMatrix1: mat4x4f,
  lightSpaceMatrix2: mat4x4f,
  lightSpaceMatrix3: mat4x4f,
  // Cascade split distances in view space (16 bytes)
  cascadeSplits: vec4f,
  // Config: cascadeCount, csmEnabled, blendFraction, _pad (16 bytes)
  config: vec4f,
  // Camera forward direction for view-space depth calculation (16 bytes)
  // xyz = normalized camera forward, w = 0
  cameraForward: vec4f,
}

// ============================================================================
// Constants
// ============================================================================

const MAX_CASCADES: u32 = 4u;
const PCF_SAMPLES: i32 = 3; // 3x3 kernel

// ============================================================================
// Helper Functions
// ============================================================================

// Get cascade count from config
fn getCSMCascadeCount(csm: CSMUniforms) -> u32 {
  return u32(csm.config.x);
}

// Check if CSM is enabled
fn isCSMEnabled(csm: CSMUniforms) -> bool {
  return csm.config.y > 0.5;
}

// Get cascade blend fraction
fn getCSMBlendFraction(csm: CSMUniforms) -> f32 {
  return csm.config.z;
}

// Get light space matrix for cascade index
fn getCSMLightSpaceMatrix(csm: CSMUniforms, cascadeIdx: u32) -> mat4x4f {
  switch (cascadeIdx) {
    case 0u: { return csm.lightSpaceMatrix0; }
    case 1u: { return csm.lightSpaceMatrix1; }
    case 2u: { return csm.lightSpaceMatrix2; }
    case 3u: { return csm.lightSpaceMatrix3; }
    default: { return csm.lightSpaceMatrix0; }
  }
}

// Get cascade split distance
fn getCSMCascadeSplit(csm: CSMUniforms, cascadeIdx: u32) -> f32 {
  switch (cascadeIdx) {
    case 0u: { return csm.cascadeSplits.x; }
    case 1u: { return csm.cascadeSplits.y; }
    case 2u: { return csm.cascadeSplits.z; }
    case 3u: { return csm.cascadeSplits.w; }
    default: { return csm.cascadeSplits.w; }
  }
}

// ============================================================================
// Cascade Selection
// ============================================================================

// Find which cascade a fragment belongs to based on view-space depth
fn selectCascade(csm: CSMUniforms, viewDepth: f32) -> u32 {
  let cascadeCount = getCSMCascadeCount(csm);
  
  // Linear search through splits (early exit on first match)
  for (var i = 0u; i < cascadeCount; i++) {
    if (viewDepth < getCSMCascadeSplit(csm, i)) {
      return i;
    }
  }
  
  // Beyond all cascades - use last one
  return cascadeCount - 1u;
}

// ============================================================================
// Shadow Sampling (Single Cascade)
// ============================================================================

// Sample shadow from a specific cascade with PCF
fn sampleCascadeShadow(
  shadowMapArray: texture_depth_2d_array,
  shadowSampler: sampler_comparison,
  worldPos: vec3f,
  lightSpaceMatrix: mat4x4f,
  cascadeIdx: u32,
  bias: f32,
  texelSize: f32
) -> f32 {
  // Transform to light space
  let lightSpacePos = lightSpaceMatrix * vec4f(worldPos, 1.0);
  var shadowCoord = lightSpacePos.xyz / lightSpacePos.w;
  
  // Convert from [-1, 1] to [0, 1] UV space
  shadowCoord.x = shadowCoord.x * 0.5 + 0.5;
  shadowCoord.y = shadowCoord.y * -0.5 + 0.5; // Flip Y for texture coords
  
  // Check if in valid range
  if (shadowCoord.x < 0.0 || shadowCoord.x > 1.0 ||
      shadowCoord.y < 0.0 || shadowCoord.y > 1.0 ||
      shadowCoord.z < 0.0 || shadowCoord.z > 1.0) {
    return 1.0; // Outside shadow map - fully lit
  }
  
  // Apply bias
  let biasedDepth = shadowCoord.z - bias;
  
  // PCF sampling (3x3 kernel)
  var shadow = 0.0;
  let halfKernel = f32(PCF_SAMPLES) / 2.0;
  
  for (var y = 0; y < PCF_SAMPLES; y++) {
    for (var x = 0; x < PCF_SAMPLES; x++) {
      let offset = vec2f(
        (f32(x) - halfKernel + 0.5) * texelSize,
        (f32(y) - halfKernel + 0.5) * texelSize
      );
      
      shadow += textureSampleCompareLevel(
        shadowMapArray,
        shadowSampler,
        shadowCoord.xy + offset,
        i32(cascadeIdx),
        biasedDepth
      );
    }
  }
  
  return shadow / f32(PCF_SAMPLES * PCF_SAMPLES);
}

// ============================================================================
// CSM Shadow Sampling with Cascade Blending
// ============================================================================

// Main CSM shadow sampling function with smooth cascade transitions
fn sampleCSMShadow(
  shadowMapArray: texture_depth_2d_array,
  shadowSampler: sampler_comparison,
  csm: CSMUniforms,
  worldPos: vec3f,
  viewDepth: f32,
  bias: f32,
  texelSize: f32
) -> f32 {
  let cascadeCount = getCSMCascadeCount(csm);
  let blendFraction = getCSMBlendFraction(csm);
  
  // Select primary cascade
  let cascadeIdx = selectCascade(csm, viewDepth);
  let lightSpaceMatrix = getCSMLightSpaceMatrix(csm, cascadeIdx);
  
  // Sample shadow from primary cascade
  var shadow = sampleCascadeShadow(
    shadowMapArray,
    shadowSampler,
    worldPos,
    lightSpaceMatrix,
    cascadeIdx,
    bias,
    texelSize
  );
  
  // Blend with next cascade near cascade boundaries
  if (cascadeIdx < cascadeCount - 1u) {
    let currentSplit = getCSMCascadeSplit(csm, cascadeIdx);
    let blendZone = currentSplit * blendFraction;
    let blendStart = currentSplit - blendZone;
    
    if (viewDepth > blendStart) {
      // Sample from next cascade
      let nextLightSpaceMatrix = getCSMLightSpaceMatrix(csm, cascadeIdx + 1u);
      let nextShadow = sampleCascadeShadow(
        shadowMapArray,
        shadowSampler,
        worldPos,
        nextLightSpaceMatrix,
        cascadeIdx + 1u,
        bias,
        texelSize
      );
      
      // Smooth blend factor
      let blend = smoothstep(0.0, 1.0, (viewDepth - blendStart) / blendZone);
      shadow = mix(shadow, nextShadow, blend);
    }
  }
  
  return shadow;
}

// ============================================================================
// Single Shadow Map Sampling (fallback when CSM disabled)
// ============================================================================

fn sampleSingleShadow(
  shadowMap: texture_depth_2d,
  shadowSampler: sampler_comparison,
  worldPos: vec3f,
  lightSpaceMatrix: mat4x4f,
  bias: f32,
  texelSize: f32
) -> f32 {
  // Transform to light space
  let lightSpacePos = lightSpaceMatrix * vec4f(worldPos, 1.0);
  var shadowCoord = lightSpacePos.xyz / lightSpacePos.w;
  
  // Convert from [-1, 1] to [0, 1] UV space
  shadowCoord.x = shadowCoord.x * 0.5 + 0.5;
  shadowCoord.y = shadowCoord.y * -0.5 + 0.5;
  
  // Check if in valid range
  if (shadowCoord.x < 0.0 || shadowCoord.x > 1.0 ||
      shadowCoord.y < 0.0 || shadowCoord.y > 1.0 ||
      shadowCoord.z < 0.0 || shadowCoord.z > 1.0) {
    return 1.0;
  }
  
  // Apply bias
  let biasedDepth = shadowCoord.z - bias;
  
  // PCF sampling (3x3 kernel)
  var shadow = 0.0;
  let halfKernel = f32(PCF_SAMPLES) / 2.0;
  
  for (var y = 0; y < PCF_SAMPLES; y++) {
    for (var x = 0; x < PCF_SAMPLES; x++) {
      let offset = vec2f(
        (f32(x) - halfKernel + 0.5) * texelSize,
        (f32(y) - halfKernel + 0.5) * texelSize
      );
      
      shadow += textureSampleCompareLevel(
        shadowMap,
        shadowSampler,
        shadowCoord.xy + offset,
        biasedDepth
      );
    }
  }
  
  return shadow / f32(PCF_SAMPLES * PCF_SAMPLES);
}

// ============================================================================
// Unified Shadow Sampling (auto-selects CSM or single based on config)
// ============================================================================

// Calculate view-space depth from world position using camera forward direction.
// Projects (worldPos - cameraPos) onto the camera's forward axis to get linear
// view-space Z depth. This matches how cascade splits are computed (perspective
// near/far along the view axis), giving correct planar cascade boundaries rather
// than spherical ones from Euclidean distance.
fn calculateViewDepth(worldPos: vec3f, cameraPos: vec3f, cameraForward: vec3f) -> f32 {
  return abs(dot(worldPos - cameraPos, cameraForward));
}

// Debug function to visualize cascade boundaries
fn getCascadeDebugColor(cascadeIdx: u32) -> vec3f {
  switch (cascadeIdx) {
    case 0u: { return vec3f(1.0, 0.0, 0.0); } // Red
    case 1u: { return vec3f(0.0, 1.0, 0.0); } // Green
    case 2u: { return vec3f(0.0, 0.0, 1.0); } // Blue
    case 3u: { return vec3f(1.0, 1.0, 0.0); } // Yellow
    default: { return vec3f(1.0, 1.0, 1.0); } // White
  }
}
