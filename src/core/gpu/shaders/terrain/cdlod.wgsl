// CDLOD Terrain Rendering Shader
// Continuous Distance-Dependent Level of Detail terrain shader with morphing
// Designed to work with CDLODRendererGPU

// ============================================================================
// Uniform Structures
// ============================================================================

// Main uniforms (group 0, binding 0)
struct Uniforms {
  viewProjectionMatrix: mat4x4f,  // 0-15
  modelMatrix: mat4x4f,           // 16-31
  cameraPosition: vec3f,          // 32-34
  _pad0: f32,                     // 35
  terrainSize: f32,               // 36
  heightScale: f32,               // 37
  gridSize: f32,                  // 38
  debugMode: f32,                 // 39
  skirtDepth: f32,                // 40 - how far skirts extend downward
  // Procedural detail parameters
  detailFrequency: f32,           // 41 - base frequency in cycles/meter
  detailAmplitude: f32,           // 42 - max displacement in meters
  detailOctaves: f32,             // 43 - number of FBM octaves
  detailFadeStart: f32,           // 44 - distance where detail starts fading
  detailFadeEnd: f32,             // 45 - distance where detail is fully faded
  detailSlopeInfluence: f32,      // 46 - how much slope affects detail (0-1)
  _pad1: f32,                     // 47
}

// Material uniforms (group 0, binding 1)
struct Material {
  grassColor: vec4f,              // 0-3
  rockColor: vec4f,               // 4-7
  snowColor: vec4f,               // 8-11
  dirtColor: vec4f,               // 12-15
  snowLine: f32,                  // 16
  rockLine: f32,                  // 17
  maxGrassSlope: f32,             // 18
  _pad1: f32,                     // 19
  lightDir: vec3f,                // 20-22
  _pad2: f32,                     // 23
  lightColor: vec3f,              // 24-26
  _pad3: f32,                     // 27
  ambientIntensity: f32,          // 28
  isSelected: f32,                // 29
  shadowEnabled: f32,             // 30 - Enable/disable shadows
  shadowSoftness: f32,            // 31 - 0 = hard, 1 = soft PCF
  shadowRadius: f32,              // 32 - Shadow coverage radius
  shadowFadeStart: f32,           // 33 - Distance where shadow starts fading
  _pad4: f32,                     // 34
  _pad5: f32,                     // 35
  lightSpaceMatrix: mat4x4f,      // 36-51 - Shadow projection matrix
}

// ============================================================================
// Bindings
// ============================================================================

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<uniform> material: Material;
@group(0) @binding(2) var heightmap: texture_2d<f32>;
@group(0) @binding(3) var normalmap: texture_2d<f32>;
@group(0) @binding(4) var texSampler: sampler;
@group(0) @binding(5) var shadowMap: texture_depth_2d;
@group(0) @binding(6) var shadowSampler: sampler_comparison;

// ============================================================================
// Vertex Structures
// ============================================================================

struct VertexInput {
  // Per-vertex attributes
  @location(0) gridPosition: vec2f,  // Grid position (-0.5 to 0.5)
  @location(1) uv: vec2f,            // UV coordinates (0 to 1)
  @location(6) isSkirt: f32,         // 1.0 for skirt vertices, 0.0 otherwise
  
  // Per-instance attributes
  @location(2) nodeOffset: vec2f,    // Node center XZ in world space
  @location(3) nodeScale: f32,       // World units per grid vertex
  @location(4) nodeMorph: f32,       // Morph factor (0-1)
  @location(5) nodeLOD: f32,         // LOD level
}

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) texCoord: vec2f,
  @location(2) localUV: vec2f,
  @location(3) normal: vec3f,
  @location(4) slope: f32,
  @location(5) lodLevel: f32,
  @location(6) morphFactor: f32,
  @location(7) lightSpacePos: vec4f,  // Position in light/shadow space
}

// ============================================================================
// Noise Functions for Procedural Detail
// ============================================================================

// Hash function for noise generation (deterministic pseudo-random)
fn hash2(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// 2D gradient noise (value noise with smooth interpolation)
fn gradientNoise2D(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  
  // Quintic Hermite interpolation for C2 continuity (smoother than smoothstep)
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  
  // Sample corners
  let a = hash2(i);
  let b = hash2(i + vec2f(1.0, 0.0));
  let c = hash2(i + vec2f(0.0, 1.0));
  let d = hash2(i + vec2f(1.0, 1.0));
  
  // Bilinear interpolation with smooth u
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0; // Range [-1, 1]
}

// Fractional Brownian Motion (FBM) - multi-octave noise
fn fbm(p: vec2f, octaves: i32) -> f32 {
  var value = 0.0;
  var amplitude = 0.5;
  var frequency = 1.0;
  var totalAmplitude = 0.0;
  var pos = p;
  
  for (var i = 0; i < octaves; i++) {
    value += amplitude * gradientNoise2D(pos * frequency);
    totalAmplitude += amplitude;
    amplitude *= 0.5;  // Persistence
    frequency *= 2.0;  // Lacunarity
    // Rotate slightly each octave to reduce axis-aligned artifacts
    pos = vec2f(pos.x * 0.866 - pos.y * 0.5, pos.x * 0.5 + pos.y * 0.866);
  }
  
  return value / totalAmplitude;  // Normalize to [-1, 1]
}

// Calculate procedural detail height displacement
fn getProceduralDetail(worldXZ: vec2f, distanceToCamera: f32, slope: f32) -> f32 {
  // Early out if detail is disabled
  if (uniforms.detailAmplitude <= 0.0) {
    return 0.0;
  }
  
  // Calculate distance-based fade
  let fadeRange = uniforms.detailFadeEnd - uniforms.detailFadeStart;
  let fadeFactor = 1.0 - clamp((distanceToCamera - uniforms.detailFadeStart) / max(fadeRange, 0.001), 0.0, 1.0);
  
  // Early out if fully faded
  if (fadeFactor <= 0.0) {
    return 0.0;
  }
  
  // Calculate slope-based modulation (more detail on steep slopes = rocky areas)
  // slope is 0 for flat, 1 for vertical
  let slopeModulation = mix(1.0, slope * 2.0 + 0.3, uniforms.detailSlopeInfluence);
  let clampedSlopeModulation = clamp(slopeModulation, 0.2, 1.5);
  
  // Sample FBM noise at world position
  let noiseCoord = worldXZ * uniforms.detailFrequency;
  let noiseValue = fbm(noiseCoord, i32(uniforms.detailOctaves));
  
  // Apply amplitude, fade, and slope modulation
  return noiseValue * uniforms.detailAmplitude * fadeFactor * clampedSlopeModulation;
}

// ============================================================================
// Helper Functions
// ============================================================================

// Convert world XZ position to heightmap UV coordinates
fn worldToUV(worldXZ: vec2f) -> vec2f {
  // Terrain is centered at origin, so offset by half terrain size
  let terrainOrigin = vec2f(-uniforms.terrainSize * 0.5);
  return (worldXZ - terrainOrigin) / uniforms.terrainSize;
}

// Sample height from heightmap texture using textureLoad (r32float is unfilterable)
fn sampleHeightAt(texCoord: vec2i, mipLevel: i32) -> f32 {
  // Clamp to texture dimensions
  let dims = textureDimensions(heightmap, mipLevel);
  let clampedCoord = clamp(texCoord, vec2i(0), vec2i(i32(dims.x) - 1, i32(dims.y) - 1));
  return textureLoad(heightmap, clampedCoord, mipLevel).r;
}

// Sample height with manual bilinear interpolation (since r32float is unfilterable)
fn sampleHeightSmooth(worldXZ: vec2f, lodLevel: f32) -> f32 {
  let uv = worldToUV(worldXZ);
  let clampedUV = clamp(uv, vec2f(0.0), vec2f(1.0));
  
  // Get mip level as integer (floor for the current mip)
  let mipLevel = i32(lodLevel);
  let dims = textureDimensions(heightmap, mipLevel);
  
  // Convert UV to texel coordinates (floating point)
  let texelF = clampedUV * vec2f(f32(dims.x) - 1.0, f32(dims.y) - 1.0);
  
  // Get integer texel coordinates for the 4 corners
  let texel00 = vec2i(i32(floor(texelF.x)), i32(floor(texelF.y)));
  let texel10 = texel00 + vec2i(1, 0);
  let texel01 = texel00 + vec2i(0, 1);
  let texel11 = texel00 + vec2i(1, 1);
  
  // Sample the 4 corners
  let h00 = sampleHeightAt(texel00, mipLevel);
  let h10 = sampleHeightAt(texel10, mipLevel);
  let h01 = sampleHeightAt(texel01, mipLevel);
  let h11 = sampleHeightAt(texel11, mipLevel);
  
  // Bilinear interpolation weights
  let frac = fract(texelF);
  
  // Interpolate along X, then along Y
  let h0 = mix(h00, h10, frac.x);
  let h1 = mix(h01, h11, frac.x);
  return mix(h0, h1, frac.y);
}

// Sample normal from normal map texture at specified LOD level
fn sampleNormalWorld(worldXZ: vec2f, lodLevel: f32) -> vec3f {
  let uv = worldToUV(worldXZ);
  let clampedUV = clamp(uv, vec2f(0.0), vec2f(1.0));
  // Normal map is stored as rgba8snorm which is already in [-1,1] range
  // No conversion needed
  let normalSample = textureSampleLevel(normalmap, texSampler, clampedUV, lodLevel).rgb;
  // Ensure Y is up-facing (some normal maps store Y inverted)
  return normalize(vec3f(normalSample.x, normalSample.y, normalSample.z));
}

// Calculate terrain normal from height samples (fallback if normal map not available)
fn calculateNormalFromHeight(worldXZ: vec2f, sampleDist: f32, mipLevel: f32) -> vec3f {
  // Use sampleHeightSmooth for height lookups
  let hL = sampleHeightSmooth(worldXZ + vec2f(-sampleDist, 0.0), mipLevel);
  let hR = sampleHeightSmooth(worldXZ + vec2f(sampleDist, 0.0), mipLevel);
  let hD = sampleHeightSmooth(worldXZ + vec2f(0.0, -sampleDist), mipLevel);
  let hU = sampleHeightSmooth(worldXZ + vec2f(0.0, sampleDist), mipLevel);
  
  let dx = (hR - hL) / (2.0 * sampleDist);
  let dz = (hU - hD) / (2.0 * sampleDist);
  
  return normalize(vec3f(-dx, 1.0, -dz));
}

// ============================================================================
// Vertex Shader
// ============================================================================

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  
  // Calculate world XZ position from grid position and instance data
  var worldXZ = input.gridPosition * input.nodeScale * (uniforms.gridSize - 1.0) + input.nodeOffset;
  
  // ===== CDLOD Morphing =====
  // Vertices at "odd" positions in the parent grid need to morph
  // to the midpoint between their "even" neighbors when transitioning.
  
  let parentScale = input.nodeScale * 2.0;
  
  // Determine if this vertex is at an odd position in parent grid
  let parentGridPos = worldXZ / parentScale;
  let fracPart = fract(parentGridPos + 0.5);
  
  // Odd positions are those at 0.5 in fractional space
  let oddX = 1.0 - abs(fracPart.x * 2.0 - 1.0);
  let oddZ = 1.0 - abs(fracPart.y * 2.0 - 1.0);
  
  // Apply morph factor to odd vertices
  let morphX = oddX * input.nodeMorph;
  let morphZ = oddZ * input.nodeMorph;
  
  // Snap to parent grid positions for morphing
  let snappedXZ = floor(worldXZ / parentScale + 0.5) * parentScale;
  
  // Morph world position
  let morphedXZ = vec2f(
    mix(worldXZ.x, snappedXZ.x, morphX),
    mix(worldXZ.y, snappedXZ.y, morphZ)
  );
  
  // Sample height from heightmap texture at the appropriate LOD mipmap level
  // Heightmap stores NORMALIZED values in range [-0.5, 0.5]
  let normalizedHeight = sampleHeightSmooth(morphedXZ, input.nodeLOD);
  
  // Apply heightScale to convert normalized height to world units
  // [-0.5, 0.5] * heightScale → [-heightScale/2, +heightScale/2]
  var height = normalizedHeight * uniforms.heightScale;
  
  // Sample normal from normal map texture at the appropriate LOD mipmap level
  let normal = sampleNormalWorld(morphedXZ, input.nodeLOD);
  
  // Calculate slope from normal (0 = flat, 1 = vertical)
  let slope = 1.0 - normal.y;
  
  // Calculate distance from camera to this vertex (for detail fading)
  let cameraXZ = uniforms.cameraPosition.xz;
  let distanceToCamera = length(morphedXZ - cameraXZ);
  
  // Add procedural detail for close-up viewing (fills in missing heightmap resolution)
  let proceduralDetail = getProceduralDetail(morphedXZ, distanceToCamera, slope);
  height = height + proceduralDetail;
  
  // Final world position
  var finalHeight: f32;
  
  // Debug mode: flat plane (no height displacement) to visualize heightmap
  if (uniforms.debugMode > 0.5) {
    finalHeight = 0.0;
  } else {
    finalHeight = height;  // Already scaled to world units (with procedural detail)
    
    // For skirt vertices, offset Y downward to create vertical strips
    // that hide gaps between LOD patches
    if (input.isSkirt > 0.5) {
      // Skirt depth scales with the node scale for consistent coverage
      let skirtOffset = input.nodeScale * (uniforms.gridSize - 1.0) * 0.15;
      finalHeight = height - skirtOffset;
    }
  }
  
  let worldPos = vec3f(morphedXZ.x, finalHeight, morphedXZ.y);
  
  // Transform to clip space
  let mvp = uniforms.viewProjectionMatrix * uniforms.modelMatrix;
  output.clipPosition = mvp * vec4f(worldPos, 1.0);
  
  // Transform world position
  let worldPos4 = uniforms.modelMatrix * vec4f(worldPos, 1.0);
  output.worldPosition = worldPos4.xyz;
  
  // Transform to light space for shadow mapping
  output.lightSpacePos = material.lightSpaceMatrix * worldPos4;
  
  // Calculate texture coordinate
  let terrainOrigin = vec2f(-uniforms.terrainSize * 0.5);
  output.texCoord = (morphedXZ - terrainOrigin) / uniforms.terrainSize;
  output.localUV = input.uv;
  
  // Normal in world space
  output.normal = normalize((uniforms.modelMatrix * vec4f(normal, 0.0)).xyz);
  
  // Calculate slope
  output.slope = 1.0 - normal.y;
  
  // Pass through LOD data
  output.lodLevel = input.nodeLOD;
  output.morphFactor = input.nodeMorph;
  
  return output;
}

// ============================================================================
// Fragment Shader
// ============================================================================

// ============================================================================
// Shadow Sampling Functions
// ============================================================================

// Sample shadow map with comparison (hard shadows)
// Note: WGSL requires uniform control flow - we must always sample.
// Bounds checking is done via clamp and blend instead of early return.
fn sampleShadowHard(lightSpacePos: vec4f) -> f32 {
  // Perspective divide to get NDC coordinates
  let projCoords = lightSpacePos.xyz / lightSpacePos.w;
  
  // Transform from NDC [-1,1] to texture UV [0,1]
  // WebGPU: NDC has Y pointing up, but texture UV has Y pointing down (origin top-left)
  // So we need to flip Y: shadowUV.y = 1 - (ndc.y * 0.5 + 0.5) = 0.5 - ndc.y * 0.5
  let shadowUV = vec2f(projCoords.x * 0.5 + 0.5, 0.5 - projCoords.y * 0.5);
  
  // Clamp UV to valid range (must always sample at valid coords)
  let clampedUV = clamp(shadowUV, vec2f(0.001), vec2f(0.999));
  
  // Apply receiver-side bias to prevent self-shadowing artifacts
  // This accounts for:
  // 1. Procedural detail in main terrain that shadow map doesn't have
  // 2. LOD differences between shadow map (LOD 0) and visible terrain
  // 3. Floating point precision at steep angles (high sun elevation)
  let shadowBias = 0.0005;
  let clampedDepth = clamp(projCoords.z - shadowBias, 0.0, 1.0);
  
  // Always sample shadow map (uniform control flow)
  let shadowValue = textureSampleCompare(shadowMap, shadowSampler, clampedUV, clampedDepth);
  
  // Check if outside shadow map bounds AFTER sampling
  // If outside bounds, return 1.0 (no shadow)
  let inBoundsX = step(0.0, shadowUV.x) * step(shadowUV.x, 1.0);
  let inBoundsY = step(0.0, shadowUV.y) * step(shadowUV.y, 1.0);
  let inBoundsZ = step(0.0, projCoords.z) * step(projCoords.z, 1.0);
  let inBounds = inBoundsX * inBoundsY * inBoundsZ;
  
  // Return shadow value if in bounds, 1.0 (no shadow) if out of bounds
  return mix(1.0, shadowValue, inBounds);
}

// Sample shadow map with PCF (soft shadows)
fn sampleShadowPCF(lightSpacePos: vec4f, kernelSize: i32) -> f32 {
  // Perspective divide to get NDC coordinates
  let projCoords = lightSpacePos.xyz / lightSpacePos.w;
  
  // Transform from NDC [-1,1] to texture UV [0,1]
  let shadowUV = projCoords.xy * 0.5 + 0.5;
  
  // Check if outside shadow map bounds
  if (shadowUV.x < 0.0 || shadowUV.x > 1.0 || 
      shadowUV.y < 0.0 || shadowUV.y > 1.0 ||
      projCoords.z < 0.0 || projCoords.z > 1.0) {
    return 1.0;
  }
  
  let currentDepth = projCoords.z;
  let shadowMapSize = textureDimensions(shadowMap);
  let texelSize = vec2f(1.0 / f32(shadowMapSize.x), 1.0 / f32(shadowMapSize.y));
  
  // PCF kernel sampling
  var shadow = 0.0;
  let halfKernel = kernelSize / 2;
  var samples = 0.0;
  
  for (var x = -halfKernel; x <= halfKernel; x++) {
    for (var y = -halfKernel; y <= halfKernel; y++) {
      let offset = vec2f(f32(x), f32(y)) * texelSize;
      shadow += textureSampleCompare(shadowMap, shadowSampler, shadowUV + offset, currentDepth);
      samples += 1.0;
    }
  }
  
  return shadow / samples;
}

// Calculate shadow factor with distance-based fade
// Note: WGSL requires uniform control flow for textureSampleCompare.
// We must always sample the shadow map (no early returns before sampling)
// and use the fade/enable factors to blend the result.
fn calculateShadow(lightSpacePos: vec4f, worldPos: vec3f) -> f32 {
  // Calculate distance from camera for fade
  let cameraXZ = uniforms.cameraPosition.xz;
  let fragXZ = worldPos.xz;
  let distanceFromCamera = length(fragXZ - cameraXZ);
  
  // Fade shadow at the edge of shadow radius
  let fadeStart = material.shadowRadius * 0.8;
  let fadeEnd = material.shadowRadius;
  let fadeFactor = 1.0 - smoothstep(fadeStart, fadeEnd, distanceFromCamera);
  
  // Always sample shadow map (uniform control flow required for textureSampleCompare)
  // Use hard shadows for simplicity - PCF would require uniform kernel size
  let shadowValue = sampleShadowHard(lightSpacePos);
  
  // Apply fade and enable flag AFTER sampling
  // If shadows disabled or fully faded, result is 1.0 (no shadow)
  let enabledFactor = step(0.5, material.shadowEnabled);  // 0 if disabled, 1 if enabled
  let finalFadeFactor = fadeFactor * enabledFactor;
  
  return mix(1.0, shadowValue, finalFadeFactor);
}

// ============================================================================
// Fragment Shader
// ============================================================================

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let normal = normalize(input.normal);
  
  // Debug mode: show heightmap as grayscale on flat plane
  if (uniforms.debugMode > 0.5) {
    // Reconstruct world XZ from texCoord (texCoord goes 0-1 over terrain)
    let worldXZ = input.texCoord * uniforms.terrainSize - vec2f(uniforms.terrainSize * 0.5);
    
    // Sample heightmap at this fragment's location
    // Heightmap stores NORMALIZED values in range [-0.5, 0.5]
    let height = sampleHeightSmooth(worldXZ, input.lodLevel);
    
    // Convert normalized height [-0.5, 0.5] to display range [0, 1]
    let normalizedHeight = clamp(height + 0.5, 0.0, 1.0);
    
    // Add tile boundary visualization (red lines)
    let edgeThreshold = 0.02;
    var patchEdge = 0.0;
    if (input.localUV.x < edgeThreshold || input.localUV.x > 1.0 - edgeThreshold ||
        input.localUV.y < edgeThreshold || input.localUV.y > 1.0 - edgeThreshold) {
      patchEdge = 1.0;
    }
    
    // Show heightmap as pure grayscale
    var debugColor = vec3f(normalizedHeight);
    
    // Mix with red tile boundary
    debugColor = mix(debugColor, vec3f(1.0, 0.0, 0.0), patchEdge * 0.5);
    
    return vec4f(debugColor, 1.0);
  }
  
  // Normal terrain rendering
  // Heights are in range [-heightScale/2, +heightScale/2] (centered at Y=0)
  // Divide by heightScale to get [-0.5, +0.5], then add 0.5 to normalize to [0, 1]
  let normalizedHeight = (input.worldPosition.y / max(uniforms.heightScale, 1.0)) + 0.5;
  let slope = input.slope;
  
  // Material weight calculation
  var snowWeight = smoothstep(material.snowLine - 0.1, material.snowLine + 0.1, normalizedHeight);
  snowWeight *= (1.0 - smoothstep(0.5, 0.8, slope));
  
  var rockWeight = smoothstep(material.maxGrassSlope - 0.1, material.maxGrassSlope + 0.1, slope);
  rockWeight = max(rockWeight, smoothstep(material.rockLine - 0.1, material.rockLine + 0.1, normalizedHeight) * 0.5);
  
  let dirtWeight = 0.0;
  var grassWeight = 1.0 - max(snowWeight, rockWeight);
  
  // Normalize weights
  let totalWeight = snowWeight + rockWeight + dirtWeight + grassWeight;
  snowWeight /= totalWeight;
  rockWeight /= totalWeight;
  grassWeight /= totalWeight;
  
  // Blend albedo from material colors
  var albedo = material.grassColor.rgb * grassWeight
             + material.rockColor.rgb * rockWeight
             + material.snowColor.rgb * snowWeight
             + material.dirtColor.rgb * dirtWeight;
  
  // Simple directional lighting with shadows
  let lightDir = normalize(material.lightDir);
  let NdotL = max(dot(normal, lightDir), 0.0);
  let ambient = material.ambientIntensity;
  
  // Calculate shadow
  let shadow = calculateShadow(input.lightSpacePos, input.worldPosition);
  
  // Apply shadow to diffuse component only (ambient is always visible)
  let diffuse = NdotL * (1.0 - ambient) * shadow;
  
  var finalColor = albedo * (ambient + diffuse) * material.lightColor.rgb;
  
  // Selection highlight
  if (material.isSelected > 0.5) {
    finalColor = mix(finalColor, vec3f(1.0, 0.6, 0.3), 0.1);
  }
  
  // Simple gamma correction
  finalColor = pow(finalColor, vec3f(1.0 / 2.2));

  // Debug: visualize shadow UV coordinates
  let debugUV = 0.0;
  if (debugUV > 0.5) {
    let projCoords = input.lightSpacePos.xyz / input.lightSpacePos.w;
    let shadowUV = projCoords.xy * 0.5 + 0.5;
    return vec4f(shadowUV.x, shadowUV.y, projCoords.z, 1.0);
  }

  return vec4f(finalColor, 1.0);
}
