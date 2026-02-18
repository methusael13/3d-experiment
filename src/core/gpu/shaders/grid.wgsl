// Grid Shader - UE5-style solid ground plane with procedural grid lines
//
// Renders a solid dark grey ground plane on the XZ plane with:
// - 1-unit major grid lines
// - 0.1-unit subgrid lines (10 subdivisions per unit)
// - Anti-aliased lines via fwidth() screen-space derivatives
// - Distance-based line fading to prevent aliasing/moiré
// - Full SceneEnvironment support (IBL ambient + CSM/single shadow)
// - Environment-lit ground color from IBL diffuse cubemap

// ============================================================================
// Uniforms (Group 0)
// ============================================================================

struct GridUniforms {
  viewProjection: mat4x4f,
  lightSpaceMatrix: mat4x4f,
  cameraPosition: vec3f,
  _pad0: f32,
  lightDirection: vec3f,
  _pad1: f32,
  lightColor: vec3f,
  ambientIntensity: f32,
  // Grid config: x=gridExtent, y=majorSpacing, z=minorSpacing, w=shadowResolution (0=disabled)
  gridConfig: vec4f,
}

@group(0) @binding(0) var<uniform> uniforms: GridUniforms;

// ============================================================================
// SceneEnvironment Bind Group (Group 3) - same as environment.wgsl
// ============================================================================

// Binding 0: Shadow depth texture (single map)
@group(3) @binding(0) var env_shadowMap: texture_depth_2d;
// Binding 1: Shadow comparison sampler
@group(3) @binding(1) var env_shadowSampler: sampler_comparison;
// Binding 2: IBL diffuse irradiance cubemap
@group(3) @binding(2) var env_iblDiffuse: texture_cube<f32>;
// Binding 3: IBL specular prefiltered cubemap
@group(3) @binding(3) var env_iblSpecular: texture_cube<f32>;
// Binding 4: BRDF integration LUT
@group(3) @binding(4) var env_brdfLut: texture_2d<f32>;
// Binding 5: Cubemap sampler
@group(3) @binding(5) var env_cubeSampler: sampler;
// Binding 6: LUT sampler
@group(3) @binding(6) var env_lutSampler: sampler;
// Binding 7: CSM shadow map array (4 cascades)
@group(3) @binding(7) var env_csmShadowArray: texture_depth_2d_array;
// Binding 8: CSM uniforms buffer
@group(3) @binding(8) var<uniform> env_csmUniforms: CSMUniforms;

// ============================================================================
// CSM Uniforms Structure (must match ShadowRendererGPU.ts / shadow-csm.wgsl)
// ============================================================================

struct CSMUniforms {
  lightSpaceMatrix0: mat4x4f,
  lightSpaceMatrix1: mat4x4f,
  lightSpaceMatrix2: mat4x4f,
  lightSpaceMatrix3: mat4x4f,
  cascadeSplits: vec4f,
  // config: x=cascadeCount, y=csmEnabled, z=blendFraction, w=_pad
  config: vec4f,
  // Camera forward direction for view-space depth: xyz = forward, w = 0
  cameraForward: vec4f,
}

// ============================================================================
// Debug Visualization Mode
// ============================================================================
// Change this constant to switch debug output:
//   0 = normal rendering (default)
//   1 = cascade index coloring (R=0, G=1, B=2, Y=3)
//   2 = shadow UV from selected cascade (R=U, G=V, B=0)
//   3 = view depth (grayscale, normalized by last cascade split)
//   4 = raw shadow value (grayscale)
//   5 = projected depth (projCoords.z from selected cascade, grayscale)
//   6 = cascade splits as bands (shows split boundaries on grid)
const GRID_DEBUG_MODE: i32 = 0;

// ============================================================================
// Constants
// ============================================================================

// Base checker colors (two shades for each level)
const GROUND_COLOR_A = vec3f(0.33, 0.33, 0.34);   // Lighter checker tile
const GROUND_COLOR_B = vec3f(0.28, 0.28, 0.29);   // Darker checker tile
const SUB_CHECK_LIFT = 0.025;                       // Brightness delta for sub-unit checkers
const MAJOR_LINE_COLOR = vec3f(0.20, 0.20, 0.21);
const MINOR_LINE_COLOR = vec3f(0.25, 0.25, 0.26);
const ORIGIN_LINE_COLOR_X = vec3f(0.55, 0.2, 0.2);
const ORIGIN_LINE_COLOR_Z = vec3f(0.2, 0.2, 0.55);

const SHADOW_BIAS: f32 = 0.003;
const CSM_PCF_SAMPLES: i32 = 3;

// ============================================================================
// Vertex Shader - Ground Plane
// ============================================================================

struct GroundVertexInput {
  @location(0) position: vec3f,
}

struct GroundVertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) worldPos: vec3f,
}

@vertex
fn vs_ground(input: GroundVertexInput) -> GroundVertexOutput {
  var output: GroundVertexOutput;
  output.worldPos = input.position;
  output.clipPosition = uniforms.viewProjection * vec4f(input.position, 1.0);
  return output;
}

// ============================================================================
// Shadow Sampling
// ============================================================================

// Sample shadow from single shadow map (fallback)
fn sampleSingleShadow(worldPos: vec3f) -> f32 {
  let lightSpacePos = uniforms.lightSpaceMatrix * vec4f(worldPos, 1.0);
  var shadowCoord = lightSpacePos.xyz / lightSpacePos.w;

  // Remap XY from NDC [-1,1] to UV [0,1] (Z already in [0,1] from WebGPU ortho matrix)
  shadowCoord.x = shadowCoord.x * 0.5 + 0.5;
  shadowCoord.y = shadowCoord.y * -0.5 + 0.5;

  if (shadowCoord.x < 0.0 || shadowCoord.x > 1.0 ||
      shadowCoord.y < 0.0 || shadowCoord.y > 1.0 ||
      shadowCoord.z < 0.0 || shadowCoord.z > 1.0) {
    return 1.0;
  }

  let biasedDepth = shadowCoord.z - SHADOW_BIAS;
  // Use actual shadow resolution from uniform (gridConfig.w) for correct PCF texel size
  let shadowRes = max(uniforms.gridConfig.w, 512.0);
  let texelSize = 1.0 / shadowRes;

  var shadow = 0.0;
  let halfKernel = f32(CSM_PCF_SAMPLES) / 2.0;

  for (var y = 0; y < CSM_PCF_SAMPLES; y++) {
    for (var x = 0; x < CSM_PCF_SAMPLES; x++) {
      let offset = vec2f(
        (f32(x) - halfKernel + 0.5) * texelSize,
        (f32(y) - halfKernel + 0.5) * texelSize
      );
      shadow += textureSampleCompareLevel(
        env_shadowMap,
        env_shadowSampler,
        shadowCoord.xy + offset,
        biasedDepth
      );
    }
  }

  return shadow / f32(CSM_PCF_SAMPLES * CSM_PCF_SAMPLES);
}

// ============ CSM Functions ============
// Aligned with object.wgsl's proven CSM sampling approach, using grid's env_ bindings.

fn getGridCSMLightSpaceMatrix(cascadeIdx: i32) -> mat4x4f {
  switch (cascadeIdx) {
    case 0: { return env_csmUniforms.lightSpaceMatrix0; }
    case 1: { return env_csmUniforms.lightSpaceMatrix1; }
    case 2: { return env_csmUniforms.lightSpaceMatrix2; }
    case 3: { return env_csmUniforms.lightSpaceMatrix3; }
    default: { return env_csmUniforms.lightSpaceMatrix0; }
  }
}

fn selectCascade(viewDepth: f32) -> i32 {
  let cascadeCount = i32(env_csmUniforms.config.x);
  if (viewDepth < env_csmUniforms.cascadeSplits.x) { return 0; }
  if (viewDepth < env_csmUniforms.cascadeSplits.y && cascadeCount > 1) { return 1; }
  if (viewDepth < env_csmUniforms.cascadeSplits.z && cascadeCount > 2) { return 2; }
  if (cascadeCount > 3) { return 3; }
  return cascadeCount - 1;
}

fn sampleCascadeShadow(worldPos: vec4f, cascade: i32, normal: vec3f, lightDir: vec3f) -> f32 {
  let lightSpaceMatrix = getGridCSMLightSpaceMatrix(cascade);
  let lightSpacePos = lightSpaceMatrix * worldPos;
  var shadowCoord = lightSpacePos.xyz / lightSpacePos.w;

  // Remap XY from NDC [-1,1] to UV [0,1] (Z already in [0,1] from WebGPU ortho matrix)
  shadowCoord.x = shadowCoord.x * 0.5 + 0.5;
  shadowCoord.y = shadowCoord.y * -0.5 + 0.5;

  if (shadowCoord.x < 0.0 || shadowCoord.x > 1.0 ||
      shadowCoord.y < 0.0 || shadowCoord.y > 1.0 ||
      shadowCoord.z < 0.0 || shadowCoord.z > 1.0) {
    return 1.0;
  }

  let biasedDepth = shadowCoord.z - SHADOW_BIAS;
  // Use CSM shadow array dimensions for correct PCF texel size
  let cascadeSize = textureDimensions(env_csmShadowArray);
  let texelSize = 1.0 / f32(max(cascadeSize.x, 512u));

  var shadow = 0.0;
  let halfKernel = f32(CSM_PCF_SAMPLES) / 2.0;

  for (var y = 0; y < CSM_PCF_SAMPLES; y++) {
    for (var x = 0; x < CSM_PCF_SAMPLES; x++) {
      let offset = vec2f(
        (f32(x) - halfKernel + 0.5) * texelSize,
        (f32(y) - halfKernel + 0.5) * texelSize
      );
      shadow += textureSampleCompareLevel(
        env_csmShadowArray,
        env_shadowSampler,
        shadowCoord.xy + offset,
        cascade,
        biasedDepth
      );
    }
  }

  return shadow / f32(CSM_PCF_SAMPLES * CSM_PCF_SAMPLES);
}

fn sampleCSMShadow(worldPos: vec4f, viewDepth: f32, normal: vec3f, lightDir: vec3f) -> f32 {
  let cascade = selectCascade(viewDepth);
  let cascadeCount = i32(env_csmUniforms.config.x);
  
  var cascadeSplit = env_csmUniforms.cascadeSplits.x;
  if (cascade == 1) { cascadeSplit = env_csmUniforms.cascadeSplits.y; }
  else if (cascade == 2) { cascadeSplit = env_csmUniforms.cascadeSplits.z; }
  else if (cascade == 3) { cascadeSplit = env_csmUniforms.cascadeSplits.w; }
  
  let shadow0 = sampleCascadeShadow(worldPos, cascade, normal, lightDir);
  
  let blendRegion = cascadeSplit * env_csmUniforms.config.z;
  let blendStart = cascadeSplit - blendRegion;
  
  if (viewDepth > blendStart && cascade < cascadeCount - 1) {
    let shadow1 = sampleCascadeShadow(worldPos, cascade + 1, normal, lightDir);
    let blendFactor = smoothstep(blendStart, cascadeSplit, viewDepth);
    return mix(shadow0, shadow1, blendFactor);
  }
  
  return shadow0;
}

// Unified shadow sampling: CSM with cascade blending, or single map fallback
fn sampleShadow(worldPos: vec3f) -> f32 {
  // gridConfig.w = shadow resolution (0 = disabled, >0 = resolution like 2048, 4096)
  if (uniforms.gridConfig.w < 1.0) {
    return 1.0; // Shadows disabled
  }

  let csmEnabled = env_csmUniforms.config.y > 0.5;

  if (csmEnabled) {
    let normal = vec3f(0.0, 1.0, 0.0);
    let lightDir = normalize(uniforms.lightDirection);
    // Use view-space Z depth (projection onto camera forward axis) for correct
    // planar cascade boundaries, matching how splits are computed from perspective near/far.
    let cameraFwd = normalize(env_csmUniforms.cameraForward.xyz);
    let viewDepth = abs(dot(worldPos - uniforms.cameraPosition, cameraFwd));
    return sampleCSMShadow(vec4f(worldPos, 1.0), viewDepth, normal, lightDir);
  }

  // Fallback: single shadow map
  return sampleSingleShadow(worldPos);
}

// ============================================================================
// IBL Sampling
// ============================================================================

// Sample diffuse irradiance from IBL cubemap for ambient lighting
fn sampleIBLDiffuse(worldNormal: vec3f) -> vec3f {
  return textureSample(env_iblDiffuse, env_cubeSampler, worldNormal).rgb;
}

// ============================================================================
// Procedural Grid + Checkerboard
// ============================================================================

// Compute anti-aliased grid line intensity for a given spacing
fn gridLine(worldXZ: vec2f, spacing: f32, lineWidth: f32) -> f32 {
  let coord = worldXZ / spacing;
  let dCoord = fwidth(coord);
  let grid = abs(fract(coord - 0.5) - 0.5);
  let lineAA = 1.0 - smoothstep(vec2f(0.0), dCoord * 1.5, grid);
  return max(lineAA.x, lineAA.y);
}

// Compute grid line for origin axes (X=0 and Z=0 lines)
fn originLine(worldXZ: vec2f, lineWidth: f32) -> vec2f {
  let dCoord = fwidth(worldXZ);
  let distFromOrigin = abs(worldXZ);
  let xAxisLine = 1.0 - smoothstep(0.0, dCoord.y * 1.5, distFromOrigin.y - lineWidth);
  let zAxisLine = 1.0 - smoothstep(0.0, dCoord.x * 1.5, distFromOrigin.x - lineWidth);
  return vec2f(xAxisLine, zAxisLine);
}

// Anti-aliased checkerboard for a given cell spacing
// Returns 0 or 1, smoothly anti-aliased at cell boundaries
fn checkerboard(worldXZ: vec2f, spacing: f32) -> f32 {
  let coord = worldXZ / spacing;
  // Compute analytical anti-aliased checker via smoothstep on fractional part
  let dCoord = fwidth(coord);
  // Use a triangle wave: fract(coord) remapped to [-1,1], then sign
  let i = floor(coord);
  // Integer parity: (ix + iz) mod 2
  let parity = ((i32(i.x) + i32(i.y)) & 1);
  // Smooth the checker near cell edges for anti-aliasing
  let f = fract(coord);
  let blendX = smoothstep(0.0, dCoord.x * 1.5, f.x) * smoothstep(0.0, dCoord.x * 1.5, 1.0 - f.x);
  let blendY = smoothstep(0.0, dCoord.y * 1.5, f.y) * smoothstep(0.0, dCoord.y * 1.5, 1.0 - f.y);
  let blend = blendX * blendY;
  // When blend is high (interior of cell), use discrete parity; near edges, blend to 0.5
  return mix(0.5, f32(parity), blend);
}

// ============================================================================
// Fragment Shader - Ground Plane
// ============================================================================

@fragment
fn fs_ground(input: GroundVertexOutput) -> @location(0) vec4f {
  let worldXZ = input.worldPos.xz;
  let majorSpacing = uniforms.gridConfig.y; // 1.0
  let minorSpacing = uniforms.gridConfig.z; // 0.1

  // Distance from camera (XZ plane distance)
  let camDist = length(input.worldPos.xyz - uniforms.cameraPosition);

  // === Checkered Base Color ===

  // Unit-level checker (1.0 unit cells)
  let unitChecker = checkerboard(worldXZ, majorSpacing);
  var baseColor = mix(GROUND_COLOR_A, GROUND_COLOR_B, unitChecker);

  // Sub-unit checker (0.1 unit cells) - visible only up close, adds subtle variation
  let subFade = 1.0 - smoothstep(5.0, 20.0, camDist);
  let subChecker = checkerboard(worldXZ, minorSpacing);
  let subOffset = mix(-SUB_CHECK_LIFT, SUB_CHECK_LIFT, subChecker);
  baseColor = baseColor + vec3f(subOffset) * subFade;

  // === Grid Lines ===

  // Minor grid (0.1 unit) - fade out at medium distance
  let minorFade = 1.0 - smoothstep(3.0, 12.0, camDist);
  let minorIntensity = gridLine(worldXZ, minorSpacing, 0.5) * minorFade;

  // Major grid (1.0 unit) - fade out at larger distance
  let majorFade = 1.0 - smoothstep(30.0, 150.0, camDist);
  let majorIntensity = gridLine(worldXZ, majorSpacing, 0.5) * majorFade;

  // Origin axis lines (thicker, colored)
  let originFade = 1.0 - smoothstep(50.0, 200.0, camDist);
  let originLines = originLine(worldXZ, 0.03) * originFade;

  // Compose grid color (start from checkered base)
  var gridColor = baseColor;

  // Layer minor lines (darker lines between sub-cells)
  gridColor = mix(gridColor, MINOR_LINE_COLOR, minorIntensity * 0.5);

  // Layer major lines on top (darker lines between unit cells)
  gridColor = mix(gridColor, MAJOR_LINE_COLOR, majorIntensity);

  // Layer origin axis lines on top (X axis = red along Z=0, Z axis = blue along X=0)
  gridColor = mix(gridColor, ORIGIN_LINE_COLOR_X, originLines.x);
  gridColor = mix(gridColor, ORIGIN_LINE_COLOR_Z, originLines.y);

  // === Lighting ===
  let normal = vec3f(0.0, 1.0, 0.0);
  let lightDir = normalize(uniforms.lightDirection);
  let NdotL = max(dot(normal, lightDir), 0.0);

  // Shadow
  let shadowFactor = sampleShadow(input.worldPos);

  // === Debug Visualization ===
  if (GRID_DEBUG_MODE > 0) {
    let csmEnabled = env_csmUniforms.config.y > 0.5;
    let cameraFwd = normalize(env_csmUniforms.cameraForward.xyz);
    let viewDepth = abs(dot(input.worldPos - uniforms.cameraPosition, cameraFwd));
    let cascade = selectCascade(viewDepth);
    let cascadeCount = i32(env_csmUniforms.config.x);

    // Get shadow UV for the selected cascade
    let lightSpaceMatrix = getGridCSMLightSpaceMatrix(cascade);
    let lightSpacePos = lightSpaceMatrix * vec4f(input.worldPos, 1.0);
    let projCoords = lightSpacePos.xyz / lightSpacePos.w;
    let shadowUV = vec2f(projCoords.x * 0.5 + 0.5, 0.5 - projCoords.y * 0.5);

    // Last active cascade split for normalization
    var maxSplit = env_csmUniforms.cascadeSplits.x;
    if (cascadeCount > 1) { maxSplit = env_csmUniforms.cascadeSplits.y; }
    if (cascadeCount > 2) { maxSplit = env_csmUniforms.cascadeSplits.z; }
    if (cascadeCount > 3) { maxSplit = env_csmUniforms.cascadeSplits.w; }

    var debugColor = vec3f(0.0);

    if (GRID_DEBUG_MODE == 1) {
      // Cascade index coloring
      if (cascade == 0) { debugColor = vec3f(1.0, 0.2, 0.2); }       // Red
      else if (cascade == 1) { debugColor = vec3f(0.2, 1.0, 0.2); }  // Green
      else if (cascade == 2) { debugColor = vec3f(0.2, 0.2, 1.0); }  // Blue
      else { debugColor = vec3f(1.0, 1.0, 0.2); }                    // Yellow
    } else if (GRID_DEBUG_MODE == 2) {
      // Shadow UV from selected cascade
      debugColor = vec3f(shadowUV.x, shadowUV.y, 0.0);
    } else if (GRID_DEBUG_MODE == 3) {
      // View depth (grayscale, normalized by max cascade split)
      let normalizedDepth = clamp(viewDepth / max(maxSplit, 1.0), 0.0, 1.0);
      debugColor = vec3f(normalizedDepth);
    } else if (GRID_DEBUG_MODE == 4) {
      // Raw shadow value (grayscale)
      debugColor = vec3f(shadowFactor);
    } else if (GRID_DEBUG_MODE == 5) {
      // Projected depth from selected cascade (grayscale)
      debugColor = vec3f(clamp(projCoords.z, 0.0, 1.0));
    } else if (GRID_DEBUG_MODE == 6) {
      // Cascade split boundaries - show view depth as color bands
      let normalizedDepth = viewDepth / max(maxSplit, 1.0);
      // Show split boundaries as bright lines
      let s0 = env_csmUniforms.cascadeSplits.x / max(maxSplit, 1.0);
      let s1 = env_csmUniforms.cascadeSplits.y / max(maxSplit, 1.0);
      let s2 = env_csmUniforms.cascadeSplits.z / max(maxSplit, 1.0);
      let splitWidth = 0.005;
      let onSplit = step(abs(normalizedDepth - s0), splitWidth) +
                    step(abs(normalizedDepth - s1), splitWidth) +
                    step(abs(normalizedDepth - s2), splitWidth);
      debugColor = mix(vec3f(normalizedDepth * 0.5), vec3f(1.0, 1.0, 0.0), min(onSplit, 1.0));
    }

    // Apply edge fade even in debug mode
    let gridExtent2 = uniforms.gridConfig.x;
    let edgeDist2 = max(abs(input.worldPos.x), abs(input.worldPos.z));
    let edgeFade2 = 1.0 - smoothstep(gridExtent2 * 0.7, gridExtent2, edgeDist2);
    return vec4f(debugColor, edgeFade2);
  }

  // IBL ambient: sample diffuse irradiance from environment cubemap
  let iblDiffuse = sampleIBLDiffuse(normal);
  // Use IBL diffuse as ambient contribution, scaled by ambientIntensity
  let ambient = iblDiffuse * uniforms.ambientIntensity;

  // Direct lighting (Lambert diffuse * shadow)
  let directLight = uniforms.lightColor * NdotL * shadowFactor;

  // Combine: ambient + direct
  let finalColor = gridColor * (ambient + directLight);

  // === Edge fade ===
  let gridExtent = uniforms.gridConfig.x;
  let edgeDist = max(abs(input.worldPos.x), abs(input.worldPos.z));
  let edgeFade = 1.0 - smoothstep(gridExtent * 0.7, gridExtent, edgeDist);

  return vec4f(finalColor, edgeFade);
}

// ============================================================================
// Axis Lines (Overlay) - kept separate for viewport overlay rendering
// ============================================================================

struct AxisVertexInput {
  @location(0) position: vec3f,
  @location(1) color: vec3f,
}

struct AxisVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
}

@vertex
fn vs_axis(input: AxisVertexInput) -> AxisVertexOutput {
  var output: AxisVertexOutput;
  output.position = uniforms.viewProjection * vec4f(input.position, 1.0);
  output.color = input.color;
  return output;
}

@fragment
fn fs_axis(input: AxisVertexOutput) -> @location(0) vec4f {
  return vec4f(input.color, 1.0);
}