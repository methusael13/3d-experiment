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
// Noise Functions for Procedural Detail (with Analytical Derivatives)
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

// 2D gradient noise WITH derivatives - returns vec3(value, dvalue/dx, dvalue/dy)
fn gradientNoise2DWithDerivatives(p: vec2f) -> vec3f {
  let i = floor(p);
  let f = fract(p);
  
  // Quintic Hermite interpolation: u = 6t^5 - 15t^4 + 10t^3
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  // Derivative of quintic: du/dt = 30t^4 - 60t^3 + 30t^2 = 30t^2(t-1)^2
  let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  
  // Sample corners (mapped from [0,1] to [-1,1])
  let a = hash2(i) * 2.0 - 1.0;
  let b = hash2(i + vec2f(1.0, 0.0)) * 2.0 - 1.0;
  let c = hash2(i + vec2f(0.0, 1.0)) * 2.0 - 1.0;
  let d = hash2(i + vec2f(1.0, 1.0)) * 2.0 - 1.0;
  
  // Bilinear interpolation coefficients
  // value = a + (b-a)*ux + (c-a)*uy + (a-b-c+d)*ux*uy
  let k0 = a;
  let k1 = b - a;
  let k2 = c - a;
  let k3 = a - b - c + d;
  
  // Value
  let value = k0 + k1 * u.x + k2 * u.y + k3 * u.x * u.y;
  
  // Derivatives using chain rule
  // dv/dx = k1 * du.x + k3 * du.x * u.y
  // dv/dy = k2 * du.y + k3 * u.x * du.y
  let dvdx = du.x * (k1 + k3 * u.y);
  let dvdy = du.y * (k2 + k3 * u.x);
  
  return vec3f(value, dvdx, dvdy);
}

// Fractional Brownian Motion (FBM) - multi-octave noise (value only, for vertex shader)
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

// FBM with analytical derivatives - returns vec3(value, dv/dx, dv/dy)
// Used in fragment shader to compute detail normals
fn fbmWithDerivatives(p: vec2f, octaves: i32) -> vec3f {
  var value = 0.0;
  var deriv = vec2f(0.0);
  var amplitude = 0.5;
  var frequency = 1.0;
  var totalAmplitude = 0.0;
  var pos = p;
  
  // Rotation matrix for octave variation (30 degrees)
  let cos30 = 0.866;
  let sin30 = 0.5;
  
  // Track cumulative rotation for derivative transformation
  var rotCos = 1.0;
  var rotSin = 0.0;
  
  for (var i = 0; i < octaves; i++) {
    let scaledPos = pos * frequency;
    let noiseResult = gradientNoise2DWithDerivatives(scaledPos);
    
    value += amplitude * noiseResult.x;
    
    // Transform derivatives back through rotation and frequency scaling
    // The derivative in rotated space needs to be rotated back
    let localDeriv = vec2f(noiseResult.y, noiseResult.z) * frequency;
    // Rotate derivative back to original coordinate system
    let rotatedDeriv = vec2f(
      localDeriv.x * rotCos + localDeriv.y * rotSin,
      -localDeriv.x * rotSin + localDeriv.y * rotCos
    );
    deriv += amplitude * rotatedDeriv;
    
    totalAmplitude += amplitude;
    amplitude *= 0.5;  // Persistence
    frequency *= 2.0;  // Lacunarity
    
    // Rotate position for next octave
    pos = vec2f(pos.x * cos30 - pos.y * sin30, pos.x * sin30 + pos.y * cos30);
    
    // Update cumulative rotation
    let newRotCos = rotCos * cos30 - rotSin * sin30;
    let newRotSin = rotCos * sin30 + rotSin * cos30;
    rotCos = newRotCos;
    rotSin = newRotSin;
  }
  
  // Normalize
  return vec3f(value, deriv.x, deriv.y) / totalAmplitude;
}

// Calculate procedural detail height displacement (for vertex shader)
// Uses slope-dependent noise: rolling clumps on flat, vertical striations on steep
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
  
  // ===== Slope-Based Noise Selection =====
  // Flat areas: low-frequency rolling noise (grass/dirt clumps)
  // Steep areas: high-frequency noise (rocky details)
  
  // Blend factor: 0 = flat (use rolling), 1 = steep (use rocky)
  let slopeBlendLow = 0.25;  // Below this = fully flat noise
  let slopeBlendHigh = 0.55; // Above this = fully steep noise
  let slopeBlend = smoothstep(slopeBlendLow, slopeBlendHigh, slope);
  // Apply detailSlopeInfluence to control how much slope affects noise type
  let blendFactor = slopeBlend * uniforms.detailSlopeInfluence;
  
  // Flat noise: lower frequency, fewer octaves, smoother "rolling" character
  let flatFreq = uniforms.detailFrequency * 0.4;
  let flatCoord = worldXZ * flatFreq;
  let flatNoise = fbm(flatCoord, 2);  // Only 2 octaves for smooth rolling
  
  // Steep noise: higher frequency, more octaves, sharper details
  let steepFreq = uniforms.detailFrequency * 1.8;
  let steepCoord = worldXZ * steepFreq;
  let steepNoise = fbm(steepCoord, max(i32(uniforms.detailOctaves), 4));  // At least 4 octaves for rocky detail
  
  // Blend between flat and steep noise based on slope
  let noiseValue = mix(flatNoise, steepNoise, blendFactor);
  
  // Amplitude modulation: steep areas get slightly more amplitude
  let amplitudeModulation = mix(0.8, 1.2, blendFactor);
  
  // Apply amplitude, fade, and modulation
  return noiseValue * uniforms.detailAmplitude * fadeFactor * amplitudeModulation;
}

// Calculate procedural detail normal perturbation (for fragment shader)
// Returns the detail normal in tangent space (Y-up)
// Uses same slope-based noise blending as getProceduralDetail() for consistency
fn getProceduralDetailNormal(worldXZ: vec2f, distanceToCamera: f32, slope: f32) -> vec3f {
  // Default to flat normal if detail is disabled
  if (uniforms.detailAmplitude <= 0.0) {
    return vec3f(0.0, 1.0, 0.0);
  }
  
  // Calculate distance-based fade
  let fadeRange = uniforms.detailFadeEnd - uniforms.detailFadeStart;
  let fadeFactor = 1.0 - clamp((distanceToCamera - uniforms.detailFadeStart) / max(fadeRange, 0.001), 0.0, 1.0);
  
  // Return flat normal if fully faded
  if (fadeFactor <= 0.0) {
    return vec3f(0.0, 1.0, 0.0);
  }
  
  // ===== Slope-Based Noise Selection (matches getProceduralDetail) =====
  let slopeBlendLow = 0.25;
  let slopeBlendHigh = 0.55;
  let slopeBlend = smoothstep(slopeBlendLow, slopeBlendHigh, slope);
  let blendFactor = slopeBlend * uniforms.detailSlopeInfluence;
  
  // Flat noise: lower frequency, fewer octaves
  let flatFreq = uniforms.detailFrequency * 0.4;
  let flatCoord = worldXZ * flatFreq;
  let flatResult = fbmWithDerivatives(flatCoord, 2);
  
  // Steep noise: higher frequency, more octaves
  let steepFreq = uniforms.detailFrequency * 1.8;
  let steepCoord = worldXZ * steepFreq;
  let steepResult = fbmWithDerivatives(steepCoord, max(i32(uniforms.detailOctaves), 4));
  
  // Blend derivatives based on slope
  // Note: derivatives need to be scaled by their respective frequencies
  let flatDeriv = vec2f(flatResult.y, flatResult.z) * flatFreq;
  let steepDeriv = vec2f(steepResult.y, steepResult.z) * steepFreq;
  let blendedDeriv = mix(flatDeriv, steepDeriv, blendFactor);
  
  // Amplitude modulation (matches getProceduralDetail)
  let amplitudeModulation = mix(0.8, 1.2, blendFactor);
  
  // Scale derivatives by amplitude and fade
  let scale = uniforms.detailAmplitude * fadeFactor * amplitudeModulation;
  let dhdx = blendedDeriv.x * scale;
  let dhdz = blendedDeriv.y * scale;
  
  // Compute normal from height gradient: n = normalize(-dh/dx, 1, -dh/dz)
  return normalize(vec3f(-dhdx, 1.0, -dhdz));
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
fn sampleShadowHard(lightSpacePos: vec4f, normal: vec3f, lightDir: vec3f) -> f32 {
  // Perspective divide to get NDC coordinates
  let projCoords = lightSpacePos.xyz / lightSpacePos.w;
  
  // Transform from NDC [-1,1] to texture UV [0,1]
  // WebGPU: NDC has Y pointing up, but texture UV has Y pointing down (origin top-left)
  // So we need to flip Y: shadowUV.y = 1 - (ndc.y * 0.5 + 0.5) = 0.5 - ndc.y * 0.5
  let shadowUV = vec2f(projCoords.x * 0.5 + 0.5, 0.5 - projCoords.y * 0.5);
  
  // Clamp UV to valid range (must always sample at valid coords)
  let clampedUV = clamp(shadowUV, vec2f(0.001), vec2f(0.999));
  
  // Apply slope-dependent receiver-side bias to prevent self-shadowing artifacts
  // This accounts for:
  // 1. Procedural detail in main terrain that shadow map doesn't have
  // 2. LOD differences between shadow map (LOD 0) and visible terrain
  // 3. Floating point precision at steep angles (high sun elevation)
  // 4. Larger texel coverage on slopes (main source of artifacts)
  let NdotL = max(dot(normal, lightDir), 0.001);
  let slopeFactor = sqrt(1.0 - NdotL * NdotL) / NdotL; // tan(acos(NdotL))
  let baseBias = 0.0003;
  let slopeBias = 0.002;
  let shadowBias = baseBias + clamp(slopeFactor, 0.0, 5.0) * slopeBias;
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
fn calculateShadow(lightSpacePos: vec4f, worldPos: vec3f, normal: vec3f, lightDir: vec3f) -> f32 {
  // Calculate distance from camera for fade
  let cameraXZ = uniforms.cameraPosition.xz;
  let fragXZ = worldPos.xz;
  let distanceFromCamera = length(fragXZ - cameraXZ);
  
  // Fade shadow at the edge of shadow radius
  let fadeStart = material.shadowRadius * 0.8;
  let fadeEnd = material.shadowRadius;
  let fadeFactor = 1.0 - smoothstep(fadeStart, fadeEnd, distanceFromCamera);
  
  // Always sample shadow map (uniform control flow required for textureSampleCompare)
  // Use hard shadows with slope-based bias
  let shadowValue = sampleShadowHard(lightSpacePos, normal, lightDir);
  
  // Apply fade and enable flag AFTER sampling
  // If shadows disabled or fully faded, result is 1.0 (no shadow)
  let enabledFactor = step(0.5, material.shadowEnabled);  // 0 if disabled, 1 if enabled
  let finalFadeFactor = fadeFactor * enabledFactor;
  
  return mix(1.0, shadowValue, finalFadeFactor);
}

// ============================================================================
// Fragment Shader
// ============================================================================

// Blend two normals using Reoriented Normal Mapping (RNM)
// This properly combines the base normal with a detail normal
// baseN: the base/macro normal from heightmap
// detailN: the detail/micro normal from procedural noise
fn blendNormalsRNM(baseN: vec3f, detailN: vec3f) -> vec3f {
  // Reoriented Normal Mapping technique
  // Ref: https://blog.selfshadow.com/publications/blending-in-detail/
  let t = baseN + vec3f(0.0, 0.0, 1.0);
  let u = detailN * vec3f(-1.0, -1.0, 1.0);
  return normalize(t * dot(t, u) - u * t.z);
}

// Alternative: UDN (Unreal Developer Network) blending - simpler but less accurate
fn blendNormalsUDN(baseN: vec3f, detailN: vec3f) -> vec3f {
  return normalize(vec3f(baseN.xy + detailN.xy, baseN.z));
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  // Get base normal from vertex shader (from normal map)
  let baseNormal = normalize(input.normal);
  
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
  
  // ===== Compute Detail Normal from Procedural Noise =====
  // Get world XZ position for noise sampling
  let worldXZ = input.worldPosition.xz;
  
  // Calculate distance from camera for detail fade
  let cameraXZ = uniforms.cameraPosition.xz;
  let distanceToCamera = length(worldXZ - cameraXZ);
  
  // Get the detail normal from procedural FBM (in world space, Y-up)
  let detailNormal = getProceduralDetailNormal(worldXZ, distanceToCamera, input.slope);
  
  // Blend base normal with detail normal
  // The detail normal is already in world space (Y-up tangent space for terrain)
  // We use the simpler UDN blend since our base normal may have arbitrary orientation
  // For terrain with mostly vertical-ish normals, this works well
  let blendedNormal = blendNormalsUDN(baseNormal, detailNormal);
  
  // Use blended normal for lighting
  let normal = blendedNormal;
  
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
  
  // Calculate shadow (with slope-dependent bias for artifact-free slopes)
  let shadow = calculateShadow(input.lightSpacePos, input.worldPosition, normal, lightDir);
  
  // Apply shadow to diffuse component only (ambient is always visible)
  let diffuse = NdotL * (1.0 - ambient) * shadow;
  
  var finalColor = albedo * (ambient + diffuse) * material.lightColor.rgb;
  
  // Selection highlight
  if (material.isSelected > 0.5) {
    finalColor = mix(finalColor, vec3f(1.0, 0.6, 0.3), 0.1);
  }

  // Debug: visualize shadow UV coordinates
  let debugUV = 0.0;
  if (debugUV > 0.5) {
    let projCoords = input.lightSpacePos.xyz / input.lightSpacePos.w;
    let shadowUV = projCoords.xy * 0.5 + 0.5;
    return vec4f(shadowUV.x, shadowUV.y, projCoords.z, 1.0);
  }

  return vec4f(finalColor, 1.0);
}
