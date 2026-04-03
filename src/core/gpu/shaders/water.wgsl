// Water Rendering Shader v4
// High-quality water with Gerstner waves, analytical normals, atmospheric reflections
// Inline screen-space ray march for SSR using water's own wave normals

// ============================================================================
// Constants
// ============================================================================

const PI: f32 = 3.14159265359;
const WATER_COLOR_BLEND: f32 = 0.4;


// ============================================================================
// Uniform Structures
// ============================================================================

struct Uniforms {
  viewProjectionMatrix: mat4x4f,
  modelMatrix: mat4x4f,
  cameraPositionTime: vec4f,
  params: vec4f,
  gridCenter: vec4f,       // xy = gridCenterXZ, z = gridMode (0=uniform, 1=projected), w = projectedMaxDist
  gridScale: vec4f,        // xy = gridSizeXZ, zw = near/far
  lightSpaceMatrix: mat4x4f,
  shadowParams: vec4f,
  projectionMatrix: mat4x4f,
  inverseProjectionMatrix: mat4x4f,
  viewMatrix: mat4x4f,
  projectorInverse: mat4x4f,  // Inverse VP for projected grid (W6)
}

struct WaterMaterial {
  sunDirection: vec4f,
  waterColor: vec4f,
  scatterColor: vec4f,
  foamColor: vec4f,
  params1: vec4f,
  params2: vec4f,
  params3: vec4f,
  ssrParams1: vec4f,  // x = maxSteps, y = refinementSteps, z = maxDistance, w = stepSize
  ssrParams2: vec4f,  // x = thickness, y = edgeFade, z = jitter (0 or 1), w = unused
  absorptionCoeffs: vec4f,  // xyz = RGB absorption per meter, w = turbidity
  scatterTint: vec4f,       // xyz = scatter tint color, w = usePhysicalColor (0 or 1)
}

// ============================================================================
// Bindings - Group 0 (Water-specific)
// ============================================================================

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<uniform> material: WaterMaterial;
@group(0) @binding(2) var depthTexture: texture_depth_2d;
@group(0) @binding(3) var texSampler: sampler;
@group(0) @binding(4) var sceneColorTexture: texture_2d<f32>;

// ============================================================================
// Bindings - Group 2 (FFT Ocean Displacement + Normal Maps)
// ============================================================================

@group(2) @binding(0) var fftDisplacement0: texture_2d<f32>;
@group(2) @binding(1) var fftDisplacement1: texture_2d<f32>;
@group(2) @binding(2) var fftDisplacement2: texture_2d<f32>;
@group(2) @binding(3) var fftNormal0: texture_2d<f32>;
@group(2) @binding(4) var fftNormal1: texture_2d<f32>;
@group(2) @binding(5) var fftNormal2: texture_2d<f32>;
@group(2) @binding(6) var fftSampler: sampler;
@group(2) @binding(7) var<uniform> fftParams: FFTWaterParams;

struct FFTWaterParams {
  // vec4: tileSize0, tileSize1, tileSize2, cascadeCount
  tileSizes: vec4f,
  // vec4: amplitudeScale, choppiness, fftEnabled (0/1), unused
  params: vec4f,
}

// ============================================================================
// FFT Displacement Sampling
// ============================================================================

struct FFTDisplacementResult {
  displacement: vec3f,
  normal: vec3f,
}

fn sampleFFTOcean(worldXZ: vec2f) -> FFTDisplacementResult {
  var result: FFTDisplacementResult;
  result.displacement = vec3f(0.0);
  result.normal = vec3f(0.0, 1.0, 0.0);

  let cascadeCount = i32(fftParams.tileSizes.w);
  let amplitudeScale = fftParams.params.x;
  let choppiness = fftParams.params.y;

  if (cascadeCount < 1) { return result; }

  // Cascade 0 (primary ocean waves)
  // Displacement and normals are already fully scaled by the compute pipeline
  // (choppiness in ocean-animate.wgsl, amplitudeScale in ocean-finalize.wgsl)
  let uv0 = worldXZ / fftParams.tileSizes.x;
  let disp0 = textureSampleLevel(fftDisplacement0, fftSampler, uv0, 0.0).xyz;
  let n0 = textureSampleLevel(fftNormal0, fftSampler, uv0, 0.0).xyz * 2.0 - 1.0;
  result.displacement += disp0;
  var blendedNormal = n0;

  if (cascadeCount >= 2) {
    // Cascade 1 (medium detail)
    let uv1 = worldXZ / fftParams.tileSizes.y;
    let disp1 = textureSampleLevel(fftDisplacement1, fftSampler, uv1, 0.0).xyz;
    let n1 = textureSampleLevel(fftNormal1, fftSampler, uv1, 0.0).xyz * 2.0 - 1.0;
    result.displacement += disp1;
    blendedNormal += n1 * 0.5;
  }

  if (cascadeCount >= 3) {
    // Cascade 2 (fine ripples)
    let uv2 = worldXZ / fftParams.tileSizes.z;
    let disp2 = textureSampleLevel(fftDisplacement2, fftSampler, uv2, 0.0).xyz;
    let n2 = textureSampleLevel(fftNormal2, fftSampler, uv2, 0.0).xyz * 2.0 - 1.0;
    result.displacement += disp2;
    blendedNormal += n2 * 0.25;
  }

  result.normal = normalize(blendedNormal);
  return result;
}

// ============================================================================
// Bindings - Group 1 (SDF - Global Distance Field for contact foam)
// ============================================================================

@group(1) @binding(0) var sdfTexture: texture_3d<f32>;
@group(1) @binding(1) var sdfSampler: sampler;
@group(1) @binding(2) var<uniform> sdfParams: SDFParams;

struct SDFParams {
  center: vec3f,
  _pad0: f32,
  extent: vec3f,
  voxelSize: f32,
}

fn sdfLoadTexel(coord: vec3i, maxCoord: vec3i) -> f32 {
  let c = clamp(coord, vec3i(0), maxCoord);
  return textureLoad(sdfTexture, vec3u(c), 0).r;
}

fn sampleSDF(worldPos: vec3f) -> f32 {
  let uvw = (worldPos - sdfParams.center + sdfParams.extent) / (sdfParams.extent * 2.0);
  if (any(uvw < vec3f(0.0)) || any(uvw > vec3f(1.0))) { return 999.0; }
  // Manual trilinear interpolation (r32float is unfilterable in WebGPU)
  let texSize = vec3f(textureDimensions(sdfTexture));
  let maxCoord = vec3i(texSize) - vec3i(1);
  let tc = uvw * texSize - 0.5; // texel center coords
  let tc0 = vec3i(floor(tc));
  let f = tc - floor(tc); // fractional part [0,1)
  // 8-corner trilinear
  let c000 = sdfLoadTexel(tc0, maxCoord);
  let c100 = sdfLoadTexel(tc0 + vec3i(1, 0, 0), maxCoord);
  let c010 = sdfLoadTexel(tc0 + vec3i(0, 1, 0), maxCoord);
  let c110 = sdfLoadTexel(tc0 + vec3i(1, 1, 0), maxCoord);
  let c001 = sdfLoadTexel(tc0 + vec3i(0, 0, 1), maxCoord);
  let c101 = sdfLoadTexel(tc0 + vec3i(1, 0, 1), maxCoord);
  let c011 = sdfLoadTexel(tc0 + vec3i(0, 1, 1), maxCoord);
  let c111 = sdfLoadTexel(tc0 + vec3i(1, 1, 1), maxCoord);
  let c00 = mix(c000, c100, f.x);
  let c10 = mix(c010, c110, f.x);
  let c01 = mix(c001, c101, f.x);
  let c11 = mix(c011, c111, f.x);
  let c0 = mix(c00, c10, f.y);
  let c1 = mix(c01, c11, f.y);
  return mix(c0, c1, f.z);
}

// ============================================================================
// Bindings - Group 3 (SceneEnvironment: Shadow + IBL)
// ============================================================================

@group(3) @binding(0) var env_shadowMap: texture_depth_2d;
@group(3) @binding(1) var env_shadowSampler: sampler_comparison;
@group(3) @binding(2) var env_iblDiffuse: texture_cube<f32>;
@group(3) @binding(3) var env_iblSpecular: texture_cube<f32>;
@group(3) @binding(4) var env_brdfLut: texture_2d<f32>;
@group(3) @binding(5) var env_cubeSampler: sampler;
@group(3) @binding(6) var env_lutSampler: sampler;
@group(3) @binding(7) var env_csmShadowArray: texture_depth_2d_array;

struct CSMUniforms {
  viewProjectionMatrices: array<mat4x4f, 4>,
  cascadeSplits: vec4f,
  config: vec4f,
  cameraForward: vec4f,
}

@group(3) @binding(8) var<uniform> env_csmUniforms: CSMUniforms;

// Multi-light buffers from SceneEnvironment (bindings 10-12)
@group(3) @binding(10) var<uniform> env_waterLightCounts: WaterLightCounts;
@group(3) @binding(11) var<storage, read> env_waterPointLights: array<WaterPointLightData>;
@group(3) @binding(12) var<storage, read> env_waterSpotLights: array<WaterSpotLightData>;
// Spot shadow atlas (bindings 13-14)
@group(3) @binding(13) var env_waterSpotShadowAtlas: texture_depth_2d_array;
@group(3) @binding(14) var env_waterSpotShadowSampler: sampler_comparison;

// Cloud shadow map (bindings 17-18) from SceneEnvironment
@group(3) @binding(17) var env_waterCloudShadowMap: texture_2d<f32>;
@group(3) @binding(18) var<uniform> env_waterCloudShadowUniforms: WaterCloudShadowUniforms;

struct WaterCloudShadowUniforms {
  shadowCenter: vec2f,
  shadowRadius: f32,
  averageCoverage: f32,
}

fn sampleCloudShadowWater(worldPos: vec3f) -> f32 {
  let offset = vec2f(worldPos.x, worldPos.z) - env_waterCloudShadowUniforms.shadowCenter;
  let uv = offset / (env_waterCloudShadowUniforms.shadowRadius * 2.0) + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 1.0; }
  return textureSampleLevel(env_waterCloudShadowMap, env_cubeSampler, uv, 0.0).r;
}

// ============ Multi-Light Structures (water) ============

struct WaterPointLightData {
  position: vec3f,
  range: f32,
  color: vec3f,
  intensity: f32,
};

struct WaterSpotLightData {
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

struct WaterLightCounts {
  numPoint: u32,
  numSpot: u32,
  _pad0: u32,
  _pad1: u32,
};

fn waterAttenuateDistance(distance: f32, range: f32) -> f32 {
  if (range <= 0.0) { return 0.0; }
  let ratio = distance / range;
  if (ratio >= 1.0) { return 0.0; }
  let window = pow(saturate(1.0 - ratio * ratio), 2.0);
  let invDist2 = 1.0 / (distance * distance + 0.01);
  return window * invDist2;
}

fn waterAttenuateSpotCone(cosAngle: f32, innerCos: f32, outerCos: f32) -> f32 {
  return saturate((cosAngle - outerCos) / max(innerCos - outerCos, 0.001));
}

fn sampleWaterSpotShadow(worldPos: vec3f, lightSpaceMatrix: mat4x4f, atlasIndex: i32) -> f32 {
  if (atlasIndex < 0) { return 1.0; }
  let lsp = lightSpaceMatrix * vec4f(worldPos, 1.0);
  let pc = lsp.xyz / lsp.w;
  let suv = pc.xy * 0.5 + 0.5;
  if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 || pc.z > 1.0) { return 1.0; }
  let uv = vec2f(suv.x, 1.0 - suv.y);
  return textureSampleCompareLevel(env_waterSpotShadowAtlas, env_waterSpotShadowSampler, uv, atlasIndex, pc.z - 0.002);
}

fn computeWaterMultiLight(worldPos: vec3f, normal: vec3f) -> vec3f {
  var totalLight = vec3f(0.0);

  let numPoint = min(env_waterLightCounts.numPoint, 64u);
  for (var i = 0u; i < numPoint; i++) {
    let light = env_waterPointLights[i];
    let toLight = light.position - worldPos;
    let dist = length(toLight);
    let L = toLight / max(dist, 0.001);
    let NdotL = max(dot(normal, L), 0.0);
    let atten = waterAttenuateDistance(dist, light.range);
    totalLight += light.color * light.intensity * NdotL * atten;
  }

  let numSpot = min(env_waterLightCounts.numSpot, 32u);
  for (var i = 0u; i < numSpot; i++) {
    let light = env_waterSpotLights[i];
    let toLight = light.position - worldPos;
    let dist = length(toLight);
    let L = toLight / max(dist, 0.001);
    let NdotL = max(dot(normal, L), 0.0);
    let atten = waterAttenuateDistance(dist, light.range);
    let cosAngle = dot(-L, normalize(light.direction));
    let spotFalloff = waterAttenuateSpotCone(cosAngle, light.innerCos, light.outerCos);
    let shadow = sampleWaterSpotShadow(worldPos, light.lightSpaceMatrix, light.shadowAtlasIndex);
    totalLight += light.color * light.intensity * NdotL * atten * spotFalloff * shadow;
  }

  return totalLight;
}

// ============================================================================
// Vertex Structures
// ============================================================================

struct VertexInput {
  @location(0) position: vec2f,
  @location(1) uv: vec2f,
}

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) texCoord: vec2f,
  @location(2) viewDir: vec3f,
  @location(3) distanceToCamera: f32,
  @location(4) gerstnerNormal: vec3f,
  @location(5) lightSpacePos: vec4f,
}

// ============================================================================
// Gerstner Wave
// ============================================================================

struct GerstnerResult {
  displacement: vec3f,
  binormal: vec3f,
  tangent: vec3f,
}

fn gerstnerWaveWithDerivatives(pos: vec2f, dir: vec2f, steepness: f32, wavelength: f32, time: f32) -> GerstnerResult {
  var result: GerstnerResult;
  let k = 2.0 * PI / wavelength;
  let c = sqrt(9.8 / k);
  let d = normalize(dir);
  let f = k * (dot(d, pos) - c * time);
  let a = steepness / k;
  let sinF = sin(f);
  let cosF = cos(f);
  result.displacement = vec3f(d.x * a * cosF, a * sinF, d.y * a * cosF);
  result.binormal = vec3f(1.0 - steepness * d.x * d.x * sinF, steepness * d.x * cosF, -steepness * d.x * d.y * sinF);
  result.tangent = vec3f(-steepness * d.x * d.y * sinF, steepness * d.y * cosF, 1.0 - steepness * d.y * d.y * sinF);
  return result;
}

fn getGerstnerWaves(worldXZ: vec2f, time: f32, waveScale: f32, baseWavelength: f32) -> GerstnerResult {
  var result: GerstnerResult;
  result.displacement = vec3f(0.0);
  result.binormal = vec3f(1.0, 0.0, 0.0);
  result.tangent = vec3f(0.0, 0.0, 1.0);
  let wl1 = baseWavelength;
  let wl2 = baseWavelength * 0.6;
  let wl3 = baseWavelength * 0.35;
  let wl4 = baseWavelength * 0.2;
  let w1 = gerstnerWaveWithDerivatives(worldXZ, vec2f(1.0, 0.3), 0.25 * waveScale, wl1, time);
  result.displacement += w1.displacement;
  result.binormal += w1.binormal - vec3f(1.0, 0.0, 0.0);
  result.tangent += w1.tangent - vec3f(0.0, 0.0, 1.0);
  let w2 = gerstnerWaveWithDerivatives(worldXZ, vec2f(-0.6, 0.8), 0.18 * waveScale, wl2, time * 1.1);
  result.displacement += w2.displacement;
  result.binormal += w2.binormal - vec3f(1.0, 0.0, 0.0);
  result.tangent += w2.tangent - vec3f(0.0, 0.0, 1.0);
  let w3 = gerstnerWaveWithDerivatives(worldXZ, vec2f(0.4, -0.9), 0.12 * waveScale, wl3, time * 0.9);
  result.displacement += w3.displacement;
  result.binormal += w3.binormal - vec3f(1.0, 0.0, 0.0);
  result.tangent += w3.tangent - vec3f(0.0, 0.0, 1.0);
  let w4 = gerstnerWaveWithDerivatives(worldXZ, vec2f(-0.8, -0.4), 0.08 * waveScale, wl4, time * 1.3);
  result.displacement += w4.displacement;
  result.binormal += w4.binormal - vec3f(1.0, 0.0, 0.0);
  result.tangent += w4.tangent - vec3f(0.0, 0.0, 1.0);
  return result;
}

// ============================================================================
// IBL / Atmosphere
// ============================================================================

fn cheapAtmosphere(rayDir: vec3f, sunDir: vec3f) -> vec3f {
  let special1 = 1.0 / (rayDir.y * 1.0 + 0.1);
  let special2 = 1.0 / (sunDir.y * 11.0 + 1.0);
  let raySunDot = pow(abs(dot(sunDir, rayDir)), 2.0);
  let sunColor = mix(vec3f(1.0), max(vec3f(0.0), vec3f(1.0) - vec3f(5.5, 13.0, 22.4) / 22.4), special2);
  let blueSky = vec3f(5.5, 13.0, 22.4) / 22.4 * sunColor;
  var blueSky2 = max(vec3f(0.0), blueSky - vec3f(5.5, 13.0, 22.4) * 0.002 * (special1 + -6.0 * sunDir.y * sunDir.y));
  blueSky2 *= special1 * (0.24 + raySunDot * 0.24);
  return blueSky2 * (1.0 + 1.0 * pow(1.0 - rayDir.y, 3.0));
}

fn sampleIBLReflection(reflectDir: vec3f, roughness: f32) -> vec3f {
  let lod = roughness * 6.0;
  return textureSampleLevel(env_iblSpecular, env_cubeSampler, reflectDir, lod).rgb;
}

fn getSun(rayDir: vec3f, sunDir: vec3f, intensity: f32) -> f32 {
  let sunDot = max(0.0, dot(rayDir, sunDir));
  return (pow(sunDot, 720.0) * 210.0 + pow(sunDot, 8.0) * 0.5) * intensity;
}

// ============================================================================
// Noise
// ============================================================================

fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2f(1.0, 0.0)), u.x), mix(hash(i + vec2f(0.0, 1.0)), hash(i + vec2f(1.0, 1.0)), u.x), u.y);
}

fn foamNoise(p: vec2f, time: f32) -> f32 {
  return noise(p * 0.5 + time * 0.1) * 0.5 + noise(p * 1.0 - time * 0.15) * 0.3 + noise(p * 2.0 + time * 0.2) * 0.2;
}

fn gradientNoise(p: vec2f) -> vec3f {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let du = 6.0 * f * (1.0 - f);
  let a = hash(i);
  let b = hash(i + vec2f(1.0, 0.0));
  let c = hash(i + vec2f(0.0, 1.0));
  let d = hash(i + vec2f(1.0, 1.0));
  let k1 = b - a;
  let k2 = c - a;
  let k3 = a - b - c + d;
  return vec3f(a + k1 * u.x + k2 * u.y + k3 * u.x * u.y, du.x * (k1 + k3 * u.y), du.y * (k2 + k3 * u.x));
}

fn detailNormalPerturbation(worldPos: vec2f, time: f32, baseWavelength: f32, strength: f32) -> vec3f {
  if (strength <= 0.001) { return vec3f(0.0); }
  var nd = vec3f(0.0);
  let ds = 1.0 / (baseWavelength * 0.1);
  let g1 = gradientNoise(worldPos * ds + time * 0.5);
  nd.x += g1.y * 0.5; nd.z += g1.z * 0.5;
  let g2 = gradientNoise(worldPos * ds * 2.5 - time * 0.3);
  nd.x += g2.y * 0.3; nd.z += g2.z * 0.3;
  let g3 = gradientNoise(worldPos * ds * 5.0 + vec2f(time * 0.2, -time * 0.15));
  nd.x += g3.y * 0.2; nd.z += g3.z * 0.2;
  return nd * strength;
}

// ============================================================================
// Depth Linearization
// ============================================================================

fn linearizeDepthReversed(d: f32, near: f32, far: f32) -> f32 {
  return near * far / (near + d * (far - near));
}

// ============================================================================
// Inline SSR
// ============================================================================

fn reconstructViewPos(uv: vec2f, depth: f32) -> vec3f {
  let ndc = vec4f(uv.x * 2.0 - 1.0, (1.0 - uv.y) * 2.0 - 1.0, depth, 1.0);
  let vp = uniforms.inverseProjectionMatrix * ndc;
  return vp.xyz / vp.w;
}

fn projectToScreen(viewPos: vec3f) -> vec3f {
  let cp = uniforms.projectionMatrix * vec4f(viewPos, 1.0);
  let ndc = cp.xyz / cp.w;
  return vec3f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5, ndc.z);
}

struct SSRResult {
  hit: bool,
  uv: vec2f,
  confidence: f32,
}

fn waterRayMarch(origin: vec3f, direction: vec3f, screenWidth: f32, screenHeight: f32, jitterAmount: f32) -> SSRResult {
  var result: SSRResult;
  result.hit = false;
  result.uv = vec2f(0.0);
  result.confidence = 0.0;
  let near = uniforms.gridScale.z;
  let far = uniforms.gridScale.w;
  // Read SSR params from material uniforms
  let maxSteps = i32(material.ssrParams1.x);
  let refinementSteps = i32(material.ssrParams1.y);
  let maxDistance = material.ssrParams1.z;
  let baseStepSize = material.ssrParams1.w;
  let thickness = material.ssrParams2.x;
  let edgeFade = material.ssrParams2.y;
  var rayPos = origin + direction * baseStepSize * jitterAmount;
  var stepSize = baseStepSize;
  for (var i = 0; i < maxSteps; i++) {
    rayPos += direction * stepSize;
    let rayDist = length(rayPos - origin);
    if (rayDist > maxDistance) { break; }
    let sc = projectToScreen(rayPos);
    let suv = sc.xy;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) { break; }
    let tc = vec2i(suv * vec2f(screenWidth, screenHeight));
    let sdNDC = textureLoad(depthTexture, tc, 0);
    if (sdNDC < 0.0001) { continue; }
    let sdLin = linearizeDepthReversed(sdNDC, near, far);
    let rdLin = -rayPos.z;
    let dd = rdLin - sdLin;
    if (dd > 0.0 && dd < thickness * (1.0 + rayDist * 0.01)) {
      var hitPos = rayPos;
      var sb = stepSize * 0.5;
      for (var r = 0; r < refinementSteps; r++) {
        hitPos -= direction * sb;
        let rs = projectToScreen(hitPos);
        let rtc = vec2i(rs.xy * vec2f(screenWidth, screenHeight));
        let rsd = textureLoad(depthTexture, rtc, 0);
        let rsl = linearizeDepthReversed(rsd, near, far);
        if (-hitPos.z - rsl > 0.0) { sb *= 0.5; } else { hitPos += direction * sb; sb *= 0.5; }
      }
      let fs = projectToScreen(hitPos);
      result.uv = fs.xy;
      var conf = 1.0;
      conf *= smoothstep(0.0, edgeFade, result.uv.x) * smoothstep(1.0, 1.0 - edgeFade, result.uv.x);
      conf *= smoothstep(0.0, edgeFade, result.uv.y) * smoothstep(1.0, 1.0 - edgeFade, result.uv.y);
      conf *= 1.0 - saturate(rayDist / maxDistance);
      conf *= 1.0 - saturate(dd / thickness);
      result.hit = true;
      result.confidence = saturate(conf);
      return result;
    }
    stepSize = baseStepSize * (1.0 + rayDist * 0.02);
  }
  return result;
}

// ============================================================================
// Vertex Shader
// ============================================================================

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let waterLevel = uniforms.params.y;
  let time = uniforms.cameraPositionTime.w;
  let cameraPosition = uniforms.cameraPositionTime.xyz;
  let waveScale = material.params1.x;
  let wavelength = material.params2.z;
  let fftEnabled = fftParams.params.z > 0.5;

  // Grid mode: 0 = uniform (world-space), 1 = projected (screen-space)
  let gridMode = uniforms.gridCenter.z;
  let isProjected = gridMode > 0.5;

  // ===== Determine world XZ position from grid vertex =====
  var worldXZ: vec2f;

  if (isProjected) {
    // PROJECTED GRID (W6): unproject screen-space [0,1]² grid onto water plane
    // input.position is in [0,1] range — convert to [-1,1] NDC
    let screenNDC = input.position * 2.0 - 1.0;

    // Unproject near and far points using inverse VP (projectorInverse)
    // Reversed-Z: near = depth 1.0, far = depth 0.0
    let nearClip = uniforms.projectorInverse * vec4f(screenNDC.x, screenNDC.y, 1.0, 1.0);
    let farClip  = uniforms.projectorInverse * vec4f(screenNDC.x, screenNDC.y, 0.0, 1.0);
    let nearW = nearClip.xyz / nearClip.w;
    let farW  = farClip.xyz / farClip.w;

    // Ray from near to far plane
    let rayDir = farW - nearW;

    // Intersect ray with water plane y = waterLevel
    // t = (waterLevel - nearW.y) / rayDir.y
    let denom = rayDir.y;
    let maxDist = select(50000.0, uniforms.gridCenter.w, uniforms.gridCenter.w > 0.0);

    if (abs(denom) < 0.00001) {
      // Ray parallel to water plane — degenerate vertex, push far away
      worldXZ = nearW.xz + normalize(rayDir.xz) * maxDist;
    } else {
      let t = (waterLevel - nearW.y) / denom;
      if (t < 0.0) {
        // Ray points away from water plane — push vertex to horizon
        worldXZ = nearW.xz + normalize(rayDir.xz) * maxDist;
      } else {
        let clampedT = min(t, maxDist / max(length(rayDir), 0.001));
        worldXZ = nearW.xz + rayDir.xz * clampedT;
      }
    }
  } else {
    // UNIFORM GRID (legacy): world-space grid centered at gridCenter
    let gridCenterXZ = uniforms.gridCenter.xy;
    let gridScaleXZ = uniforms.gridScale.xy;
    let normalizedPos = input.position - vec2f(0.5);
    worldXZ = gridCenterXZ + normalizedPos * gridScaleXZ;
  }

  // ===== Sample displacement (same for both grid modes) =====
  var displacement: vec3f;
  var normal: vec3f;

  // Distance-based fade: reduce FFT displacement/normals at far distances to prevent
  // pixelation from sparse grid vertices at the horizon. Blends to flat water.
  let camDist = length(worldXZ - cameraPosition.xz);
  let fftFade = 1.0 - smoothstep(500.0, 2000.0, camDist);

  if (fftEnabled) {
    let fftResult = sampleFFTOcean(worldXZ);
    displacement = fftResult.displacement * fftFade;
    normal = normalize(mix(vec3f(0.0, 1.0, 0.0), fftResult.normal, fftFade));
  } else {
    let gerstner = getGerstnerWaves(worldXZ, time, waveScale, wavelength);
    displacement = gerstner.displacement;
    normal = normalize(cross(gerstner.tangent, gerstner.binormal));
  }

  let worldPos = uniforms.modelMatrix * vec4f(
    worldXZ.x + displacement.x,
    waterLevel + displacement.y,
    worldXZ.y + displacement.z,
    1.0
  );
  output.clipPosition = uniforms.viewProjectionMatrix * worldPos;
  output.worldPosition = worldPos.xyz;
  output.texCoord = input.uv;
  output.viewDir = normalize(cameraPosition - worldPos.xyz);
  output.distanceToCamera = length(cameraPosition - worldPos.xyz);
  output.gerstnerNormal = normal;
  output.lightSpacePos = uniforms.lightSpaceMatrix * vec4f(worldPos.xyz, 1.0);
  return output;
}

// ============================================================================
// Shadow Sampling
// ============================================================================

fn waterSampleSingleShadow(lightSpacePos: vec4f, normal: vec3f, lightDir: vec3f) -> f32 {
  let projCoords = lightSpacePos.xyz / lightSpacePos.w;
  let shadowUV = vec2f(projCoords.x * 0.5 + 0.5, 0.5 - projCoords.y * 0.5);
  let clampedUV = clamp(shadowUV, vec2f(0.001), vec2f(0.999));
  let NdotL = max(dot(normal, lightDir), 0.001);
  let slopeFactor = sqrt(1.0 - NdotL * NdotL) / NdotL;
  let baseBias = uniforms.shadowParams.y;
  let shadowBias = baseBias + clamp(slopeFactor, 0.0, 5.0) * 0.002;
  let clampedDepth = clamp(projCoords.z - shadowBias, 0.0, 1.0);
  let shadowValue = textureSampleCompare(env_shadowMap, env_shadowSampler, clampedUV, clampedDepth);
  let inBounds = step(0.0, shadowUV.x) * step(shadowUV.x, 1.0) * step(0.0, shadowUV.y) * step(shadowUV.y, 1.0) * step(0.0, projCoords.z) * step(projCoords.z, 1.0);
  return mix(1.0, shadowValue, inBounds);
}

fn waterSelectCascade(viewDepth: f32) -> i32 {
  let cc = i32(env_csmUniforms.config.x);
  if (viewDepth < env_csmUniforms.cascadeSplits.x) { return 0; }
  if (viewDepth < env_csmUniforms.cascadeSplits.y && cc > 1) { return 1; }
  if (viewDepth < env_csmUniforms.cascadeSplits.z && cc > 2) { return 2; }
  if (cc > 3) { return 3; }
  return cc - 1;
}

fn waterSampleCascadeShadow(worldPos: vec4f, cascade: i32, normal: vec3f, lightDir: vec3f) -> f32 {
  let lsp = env_csmUniforms.viewProjectionMatrices[cascade] * worldPos;
  let pc = lsp.xyz / lsp.w;
  let suv = vec2f(pc.x * 0.5 + 0.5, 0.5 - pc.y * 0.5);
  let cuv = clamp(suv, vec2f(0.001), vec2f(0.999));
  let NdotL = max(dot(normal, lightDir), 0.001);
  let sf = sqrt(1.0 - NdotL * NdotL) / NdotL;
  let cb = 0.001 * (1.0 + f32(cascade) * 0.5);
  let sb = cb + clamp(sf, 0.0, 5.0) * cb * 2.0;
  let bd = clamp(pc.z - sb, 0.0, 1.0);
  let cs = textureDimensions(env_csmShadowArray);
  let ts = vec2f(1.0 / f32(cs.x), 1.0 / f32(cs.y));
  var sv = 0.0;
  for (var x = -1; x <= 1; x++) {
    for (var y = -1; y <= 1; y++) {
      let off = vec2f(f32(x), f32(y)) * ts;
      let sUV = clamp(cuv + off, vec2f(0.001), vec2f(0.999));
      sv += textureSampleCompareLevel(env_csmShadowArray, env_shadowSampler, sUV, cascade, bd);
    }
  }
  sv /= 9.0;
  let ib = step(0.0, suv.x) * step(suv.x, 1.0) * step(0.0, suv.y) * step(suv.y, 1.0) * step(0.0, pc.z) * step(pc.z, 1.0);
  return mix(1.0, sv, ib);
}

fn waterSampleCSMShadow(worldPos: vec4f, viewDepth: f32, normal: vec3f, lightDir: vec3f) -> f32 {
  let cascade = waterSelectCascade(viewDepth);
  let cc = i32(env_csmUniforms.config.x);
  var cs = env_csmUniforms.cascadeSplits.x;
  if (cascade == 1) { cs = env_csmUniforms.cascadeSplits.y; }
  else if (cascade == 2) { cs = env_csmUniforms.cascadeSplits.z; }
  else if (cascade == 3) { cs = env_csmUniforms.cascadeSplits.w; }
  let s0 = waterSampleCascadeShadow(worldPos, cascade, normal, lightDir);
  let br = cs * env_csmUniforms.config.z;
  let bs = cs - br;
  if (viewDepth > bs && cascade < cc - 1) {
    let s1 = waterSampleCascadeShadow(worldPos, cascade + 1, normal, lightDir);
    return mix(s0, s1, smoothstep(bs, cs, viewDepth));
  }
  return s0;
}

fn waterSampleShadow(lightSpacePos: vec4f, worldPos: vec3f, normal: vec3f, lightDir: vec3f) -> f32 {
  if (uniforms.shadowParams.x < 0.5) { return 1.0; }
  if (uniforms.shadowParams.z > 0.5) {
    let cFwd = normalize(env_csmUniforms.cameraForward.xyz);
    let cPos = uniforms.cameraPositionTime.xyz;
    let vd = abs(dot(worldPos - cPos, cFwd));
    return waterSampleCSMShadow(vec4f(worldPos, 1.0), vd, normal, lightDir);
  } else {
    return waterSampleSingleShadow(lightSpacePos, normal, lightDir);
  }
}

// ============================================================================
// Fragment Shader
// ============================================================================

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let waterLevel = uniforms.params.y;
  let sunIntensity = uniforms.params.w;
  let time = uniforms.cameraPositionTime.w;
  let near = uniforms.gridScale.z;
  let far = uniforms.gridScale.w;
  let foamThreshold = material.params1.y;
  let fresnelPower = material.params1.z;
  let opacity = material.params1.w;
  let ambientIntensity = material.params2.x;
  let depthFalloff = material.params2.y;
  let sunDir = normalize(material.sunDirection.xyz);
  let viewDir = normalize(input.viewDir);
  let sunIntensityFactor = saturate(sunIntensity / 5.0);

  // ===== Wave Normal =====
  let fftActiveFS = fftParams.params.z > 0.5;
  let distFactor = min(1.0, sqrt(input.distanceToCamera * 0.002) * 0.7);
  var N = normalize(mix(input.gerstnerNormal, vec3f(0.0, 1.0, 0.0), distFactor));
  // Only apply procedural detail normals when using Gerstner (non-FFT).
  // FFT normals already contain multi-octave detail from the compute pipeline.
  if (!fftActiveFS) {
    let detailStrength = material.params2.w;
    let wavelength = material.params2.z;
    let detailFade = 1.0 - min(1.0, input.distanceToCamera * 0.003);
    let detailDelta = detailNormalPerturbation(input.worldPosition.xz, time, wavelength, detailStrength * detailFade);
    N = normalize(N + vec3f(detailDelta.x, 0.0, detailDelta.z));
  }

  // ===== Physical Color Mode =====
  let usePhysicalColor = material.scatterTint.w > 0.5;

  // ===== Fresnel via BRDF LUT (split-sum) =====
  let NdotV = max(0.001, dot(N, viewDir));
  let waterRoughness = 0.05; // Water is nearly perfectly smooth
  let F0 = vec3f(0.02); // IOR 1.33 → F0 ≈ 0.02

  // Sample BRDF LUT: x = F0 scale, y = F0 bias
  let brdf = textureSampleLevel(env_brdfLut, env_lutSampler, vec2f(NdotV, waterRoughness), 0.0).rg;
  let specularScale = F0 * brdf.x + brdf.y; // Integrated Fresnel reflectance

  // Also compute scalar Fresnel for legacy path and alpha blending
  let rawFresnel = pow(1.0 - NdotV, fresnelPower);
  let fresnel = select(
    0.02 + 0.98 * smoothstep(0.0, 1.0, rawFresnel), // Legacy Fresnel
    specularScale.r,                                    // Physical Fresnel from BRDF LUT
    usePhysicalColor
  );

  // ===== Reflection =====
  var R = normalize(reflect(-viewDir, N));
  // Allow below-horizon reflections (SSR handles them); clamp only to avoid degenerate sampling
  R = normalize(R + vec3f(0.0, max(0.0, -R.y) * 0.01, 0.0));
  let envReflection = sampleIBLReflection(R, waterRoughness);
  let sunReflection = getSun(R, sunDir, sunIntensity) * sunIntensityFactor;
  var reflection = envReflection * select(vec3f(1.0), specularScale, usePhysicalColor)
                 + vec3f(1.0, 0.95, 0.9) * sunReflection;

  // ===== Inline SSR =====
  let ssrEnabled = uniforms.shadowParams.w > 0.5;
  let screenWidth = material.params3.y;
  let screenHeight = material.params3.z;

  // Transform water world-space normal to view space for reflection direction
  // Use matrix multiply (V * N) not transpose (V^T * N) for world→view transform
  let viewNormal = normalize((uniforms.viewMatrix * vec4f(N, 0.0)).xyz);

  // Get view-space position of this water pixel from its clip position
  let waterScreenUV = input.clipPosition.xy / vec2f(screenWidth, screenHeight);
  let waterDepthNDC = input.clipPosition.z;
  let viewPos = reconstructViewPos(waterScreenUV, waterDepthNDC);

  // Reflect the view direction in view space using the water normal
  let viewDirVS = normalize(viewPos);
  let reflectDirVS = reflect(viewDirVS, viewNormal);

  // Only ray march if SSR is globally enabled and reflection points into the scene
  if (ssrEnabled && reflectDirVS.z < 0.0) {
    // Per-pixel jitter based on screen position to break banding (controlled by SSR config)
    var jitterAmount = 0.0;
    if (material.ssrParams2.z > 0.5) {
      jitterAmount = fract(sin(dot(input.clipPosition.xy, vec2f(12.9898, 78.233))) * 43758.5453);
    }
    let ssrResult = waterRayMarch(viewPos, reflectDirVS, screenWidth, screenHeight, jitterAmount);
    if (ssrResult.hit && ssrResult.confidence > 0.01) {
      let hitTexCoord = vec2i(ssrResult.uv * vec2f(screenWidth, screenHeight));
      let ssrColor = textureLoad(sceneColorTexture, hitTexCoord, 0).rgb;
      reflection = mix(reflection, ssrColor, ssrResult.confidence);
    }
  }

  // ===== Water Depth =====
  let sceneDepthNDC = textureLoad(depthTexture, vec2i(input.clipPosition.xy), 0);
  let sceneLinear = linearizeDepthReversed(sceneDepthNDC, near, far);
  let waterLinear = linearizeDepthReversed(waterDepthNDC, near, far);
  let rawWaterDepth = max(sceneLinear - waterLinear, 0.0);
  let isOpenOcean = sceneDepthNDC < 0.0001;
  let maxColorDepth = 30.0;
  let waterDepthMeters = select(min(rawWaterDepth, maxColorDepth), maxColorDepth, isOpenOcean);

  // ===== Subsurface Scattering / Water Body Color =====
  var waterBodyColor: vec3f;
  if (usePhysicalColor) {
    // Physical absorption model: Beer-Lambert with sky-derived illumination
    let absorption = material.absorptionCoeffs.xyz * material.absorptionCoeffs.w; // coeffs * turbidity
    let physTransmittance = exp(-waterDepthMeters * absorption);

    // Sample diffuse sky irradiance for subsurface ambient light
    let skyDiffuse = textureSampleLevel(env_iblDiffuse, env_cubeSampler, vec3f(0.0, 1.0, 0.0), 0.0).rgb;

    // Water body color = sky light transmitted through water column + scattered light
    let scatterTint = material.scatterTint.xyz;
    waterBodyColor = skyDiffuse * physTransmittance + scatterTint * (1.0 - physTransmittance);
  } else {
    // Legacy path: manual waterColor/deepColor blend with depth falloff
    let absorptionCoeff = depthFalloff * 0.05;
    let transmittance = exp(-waterDepthMeters * absorptionCoeff);
    waterBodyColor = mix(material.scatterColor.rgb, material.waterColor.rgb, transmittance);
  }

  // ===== Shore Foam + SDF Contact Foam =====
  let foamPattern = foamNoise(input.worldPosition.xz * 0.3, time);
  let foamFade = 1.0 - saturate(waterDepthMeters / max(foamThreshold, 0.001));
  let shoreFoam = select(0.0, foamFade * foamPattern, foamThreshold > 0.0);

  // SDF-based contact foam: foam where water is just above terrain surface
  // sdfDist > 0 means water pixel is above terrain, < 0 means inside terrain
  // We want foam only where water is very close ABOVE terrain (shoreline contact)
  let contactFoamWidth = 1.0; // meters — foam appears within this distance above terrain
  let sdfDist = sampleSDF(input.worldPosition);
  // One-sided: only foam where 0 < sdfDist < contactFoamWidth (water just above terrain)
  // Guard: skip if sdfDist >= 100 (out of SDF bounds / no terrain data)
  let contactFoamRaw = select(0.0, smoothstep(contactFoamWidth, 0.0, sdfDist), sdfDist >= 0.0 && sdfDist < 100.0);
  let contactFoam = contactFoamRaw * foamPattern; // Use same noise for breakup

  // Combine shore foam and contact foam (take max)
  let totalFoam = max(shoreFoam, contactFoam);

  // ===== Refraction =====
  let refractionStrength = material.params3.x;
  var refractedColor = vec3f(0.0);
  var refractionMix = 0.0;
  if (refractionStrength > 0.001 && !isOpenOcean) {
    let screenUV = vec2f(input.clipPosition.x / screenWidth, input.clipPosition.y / screenHeight);
    let depthAttenuation = exp(-waterDepthMeters * 0.5);
    let refractionOffset = N.xz * refractionStrength * depthAttenuation * 0.1;
    let refractedUV = clamp(screenUV + refractionOffset, vec2f(0.001), vec2f(0.999));
    let texCoord = vec2i(refractedUV * vec2f(screenWidth, screenHeight));
    refractedColor = textureLoad(sceneColorTexture, texCoord, 0).rgb;
    refractionMix = depthAttenuation * (1.0 - fresnel * 0.5);
    let tintStrength = 1.0 - depthAttenuation;
    refractedColor = mix(refractedColor, refractedColor * waterBodyColor * 2.0, tintStrength);
  }

  // ===== Final Color Composition =====
  // ===== Shadow (CSM + cloud shadow combined) =====
  let waterNormalUp = vec3f(0.0, 1.0, 0.0);
  let csmShadow = waterSampleShadow(input.lightSpacePos, input.worldPosition, waterNormalUp, sunDir);
  let cloudShadow = sampleCloudShadowWater(input.worldPosition);
  let shadow = csmShadow * cloudShadow;

  var finalColor: vec3f;
  if (usePhysicalColor) {
    // Energy-conserving composition: kS + kD = 1 (for non-metals)
    let kS = specularScale;                   // Fresnel reflectance (from BRDF LUT)
    let kD = (vec3f(1.0) - kS);              // Water is non-metallic

    // Base transmitted color (water body + refraction)
    var transmitted = waterBodyColor;
    if (refractionMix > 0.001) {
      transmitted = mix(transmitted, refractedColor, refractionMix);
    }

    // Apply shadow to both transmitted and reflected light
    transmitted *= mix(0.4, 1.0, shadow);
    let shadowedReflection = reflection * mix(0.3, 1.0, shadow);

    // Energy-conserving: reflected + transmitted = 1
    finalColor = shadowedReflection * kS + transmitted * kD;

    // Direct sun specular added separately (not energy-conserved with IBL, intentional)
    // Sun specular is already in `reflection` via sunReflection
  } else {
    // Legacy composition path (preserved for backward compatibility)
    var baseColor = waterBodyColor * sunIntensityFactor * ambientIntensity;
    if (refractionMix > 0.001) {
      baseColor = mix(baseColor, refractedColor, refractionMix);
    }
    baseColor *= mix(0.4, 1.0, shadow);
    let shadowedReflection = reflection * mix(0.3, 1.0, shadow);
    finalColor = mix(baseColor, shadowedReflection, fresnel * 0.4) + fresnel * shadowedReflection * 0.3;
    finalColor += vec3f(0.02, 0.04, 0.08) * ambientIntensity * sunIntensityFactor;
  }

  // Foam (same for both paths) — uses combined shore + SDF contact foam
  finalColor = mix(finalColor, material.foamColor.rgb * sunIntensityFactor * ambientIntensity, totalFoam * 0.8);

  // ===== Alpha =====
  let minAlpha = 0.7;
  let baseAlpha = max(opacity, minAlpha);
  let shoreEdgeFade = saturate(waterDepthMeters / 2.0);
  let alpha = mix(minAlpha, baseAlpha, shoreEdgeFade) + fresnel * 0.15;

  // Multi-light contribution (point + spot lights on water surface)
  let waterMultiLight = computeWaterMultiLight(input.worldPosition, N);
  finalColor += waterMultiLight * 0.5; // Attenuated contribution for water

  return vec4f(finalColor * alpha, alpha);
}
