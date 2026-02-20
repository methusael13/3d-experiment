# Volumetric Clouds & God Rays — Implementation Plan

## Table of Contents

1. [Existing Architecture Overview](#1-existing-architecture-overview)
2. [Volumetric Cloud System](#2-volumetric-cloud-system)
3. [God Rays (Volumetric Light Scattering)](#3-god-rays-volumetric-light-scattering)
4. [Cloud Shadows on Terrain](#4-cloud-shadows-on-terrain)
5. [Integration with Existing Systems](#5-integration-with-existing-systems)
6. [Performance Budget & Optimization](#6-performance-budget--optimization)
7. [UI Controls](#7-ui-controls)
8. [Implementation Phases](#8-implementation-phases)
9. [File Structure](#9-file-structure)
10. [References](#10-references)

---

## 1. Existing Architecture Overview

### Current Render Pipeline (`GPUForwardPipeline`)

The forward pipeline renders in ordered passes to an **HDR intermediate buffer** (`rgba16float`), followed by post-processing:

```
1. ShadowPass      → CSM shadow maps (4 cascades, depth-only)
2. SkyPass         → Procedural atmospheric scattering (sky.wgsl)
3. GroundPass      → Grid overlay
4. OpaquePass      → Terrain (cdlod.wgsl) + objects (object.wgsl)
5. TransparentPass → Water (water.wgsl)
6. OverlayPass     → Axes, gizmos
7. SelectionPasses → Mask + outline
8. DebugPass       → Debug texture thumbnails
───── Post-Processing ─────
9. SSAOEffect      → Screen-space AO (optional, disabled by default)
10. CompositeEffect → Tonemapping (ACES) + gamma + dithering → backbuffer (bgra8unorm)
```

### Current Shadow System

- **`ShadowRendererGPU`**: Renders depth-only shadow maps from the directional light's perspective.
- **Cascaded Shadow Maps (CSM)**: Up to 4 cascades stored in a `texture_2d_array`. Configured via `CSMUtils.ts`.
- **`SceneEnvironment`** (Group 3): Shared bind group providing shadow map + CSM uniforms + IBL cubemaps to all scene shaders.
- **`shadow-csm.wgsl`**: Shared WGSL include for cascade selection and PCF filtering.

### Current Directional Light

- **`DirectionalLight`**: Holds azimuth, elevation, color, intensity. Computes direction vector from elevation/azimuth.
- **`lightingManager`**: Bridges UI controls to DirectionalLight, computes `sunVisibility` factor (smooth fadeout when elevation < -5°).
- **`Viewport`**: Passes light direction, ambient intensity, and `sunVisibility` to all renderers per frame.

### Current Post-Processing

- **`PostProcessPipeline`**: Plugin-based effect chain. Effects register with a priority order.
- **`PostProcessPass`/`BaseEffect`**: Abstract base for effects. Each effect declares inputs/outputs (texture names like `'color'`, `'ao'`).
- **`BufferPool`**: Manages intermediate texture allocation for effects.
- Swap chain format: `bgra8unorm`. Scene buffer: `rgba16float`.

### Current Sky

- **`SkyRendererGPU`** → `sky.wgsl`: Nishita atmospheric scattering with procedural star field. Renders as fullscreen quad.
- **`DynamicSkyIBL`**: Captures sky to cubemap, generates diffuse/specular IBL. Updates incrementally (one task per frame).

---

## 2. Volumetric Cloud System

### 2.1 Architecture Overview

Clouds are rendered as a **dedicated compute pass** that ray-marches through a cloud layer, producing a half-resolution cloud color + transmittance texture. This is composited with the scene in the post-processing stage.

```
┌─────────────────────────────────────────────────┐
│           Volumetric Cloud Pipeline              │
│                                                  │
│  ┌──────────┐   ┌───────────┐   ┌────────────┐ │
│  │ Weather  │   │ 3D Noise  │   │ Cloud Ray  │ │
│  │ Map (2D) │──▶│ Textures  │──▶│ March Pass │ │
│  │ Compute  │   │ (Compute) │   │ (Compute)  │ │
│  └──────────┘   └───────────┘   └─────┬──────┘ │
│                                        │        │
│                              ┌─────────▼──────┐ │
│                              │  Temporal       │ │
│                              │  Reprojection   │ │
│                              └─────────┬──────┘ │
│                                        │        │
│                              ┌─────────▼──────┐ │
│                              │  Cloud         │ │
│                              │  Composite     │ │
│                              │  (into scene)  │ │
│                              └────────────────┘ │
└─────────────────────────────────────────────────┘
```

### 2.2 Cloud Layer Model

Clouds exist in a **spherical shell** between two altitudes above the Earth's surface:

| Parameter | Value | Notes |
|-----------|-------|-------|
| Cloud base altitude | 1,500 m | Cumulus base |
| Cloud top altitude | 4,000 m | Cumulus tops |
| Layer thickness | 2,500 m | Ray march domain |
| Earth radius | 6,360,000 m | Matches `sky.wgsl` |

The ray-march domain is defined by two concentric spheres: `R_earth + cloud_base` and `R_earth + cloud_top`.

### 2.3 Noise Textures (Compute Shader Generation)

All noise textures are generated once at initialization via compute shaders (similar to existing `HeightmapGenerator` pattern).

#### 2.3.1 Base Shape Noise — 3D Worley-Perlin (128³)

- **Format**: `rgba8unorm`, 128×128×128, 3D texture
- **Channels**:
  - R: Perlin-Worley (low freq base shape)
  - G: Worley (octave 1)
  - B: Worley (octave 2)
  - A: Worley (octave 3)
- **Generation**: Single compute dispatch, `@workgroup_size(4, 4, 4)`, 32³ workgroups
- **Sampling**: Trilinear with `repeat` addressing (tileable noise)

#### 2.3.2 Detail Erosion Noise — 3D Worley (32³)

- **Format**: `rgba8unorm`, 32×32×32, 3D texture
- **Channels**: R/G/B = Worley at 3 frequencies, A = combined
- **Purpose**: Subtracts detail from cloud edges for wispy/turbulent appearance

#### 2.3.3 Weather Map — 2D (512×512)

- **Format**: `rgba8unorm`, 512×512, 2D texture
- **Channels**:
  - R: Cloud coverage (0 = clear, 1 = overcast)
  - G: Cloud type (0 = stratus, 1 = cumulus)
  - B: Precipitation (0 = none, 1 = heavy)
  - A: Reserved (wind distortion offset)
- **Generation**: Procedural via FBM noise + controllable parameters, regenerated when weather settings change
- **Animation**: UV offset scrolled by wind direction/speed each frame

### 2.4 Cloud Density Function

The density at any world-space point `p` is computed as:

```wgsl
fn cloudDensity(p: vec3f, weatherUV: vec2f) -> f32 {
    // 1. Height fraction within cloud layer [0, 1]
    let altitude = length(p) - EARTH_RADIUS;
    let heightFrac = saturate((altitude - cloudBase) / cloudThickness);
    
    // 2. Height-based density profile (round bottom, flat top for cumulus)
    let heightGradient = smoothstep(0.0, 0.1, heightFrac) 
                       * smoothstep(1.0, 0.6, heightFrac);
    
    // 3. Weather map sample (coverage, type)
    let weather = textureSampleLevel(weatherMap, weatherSampler, weatherUV, 0.0);
    let coverage = weather.r;
    let cloudType = weather.g;
    
    // 4. Base shape from 3D noise
    let uvw = p * 0.0003; // World-to-noise scale
    let shape = textureSampleLevel(shapeNoise, noiseSampler, uvw, 0.0);
    let baseShape = remap(shape.r, shape.g * 0.625 + shape.b * 0.25 + shape.a * 0.125, 
                          1.0, 0.0, 1.0);
    
    // 5. Apply coverage (Guerrilla's remap trick)
    var density = remap(baseShape * heightGradient, 1.0 - coverage, 1.0, 0.0, 1.0);
    density = saturate(density);
    
    // 6. Erode edges with detail noise (only where density > 0)
    if (density > 0.0) {
        let detailUVW = p * 0.002;
        let detail = textureSampleLevel(detailNoise, noiseSampler, detailUVW, 0.0);
        let detailFBM = detail.r * 0.625 + detail.g * 0.25 + detail.b * 0.125;
        let detailModifier = mix(detailFBM, 1.0 - detailFBM, saturate(heightFrac * 5.0));
        density = remap(density, detailModifier * 0.35, 1.0, 0.0, 1.0);
    }
    
    return max(0.0, density);
}
```

### 2.5 Ray Marching Strategy

Cloud ray marching runs as a **compute shader** writing to a half-resolution texture.

#### Render Target

- **Resolution**: Half viewport width × half viewport height (e.g., 960×540 for 1920×1080)
- **Format**: `rgba16float`
  - RGB: In-scattered light (cloud color from sun illumination)
  - A: Transmittance (1 = fully transparent/no cloud, 0 = fully opaque)

#### March Algorithm

```
for each pixel (dispatched as compute workgroup):
    1. Reconstruct view ray from inverse VP matrix + pixel coordinate
    2. Intersect ray with cloud shell spheres → [tEntry, tExit]
    3. If no intersection, write (0, 0, 0, 1) and return
    4. Blue noise dither: tEntry += blueNoise(pixel) * stepSize
    5. March from tEntry to tExit:
       a. Sample density at position
       b. If density > threshold:
          - Switch to fine step size (adaptive)
          - Compute lighting via sun-direction light march (6 steps)
          - Accumulate in-scattering using Beer-Lambert + HG phase
          - Apply multi-scattering approximation (Frostbite octave method)
       c. If density ≈ 0: use large step size (empty space skip)
       d. Early exit if transmittance < 0.01
    6. Write (scatteredLight, transmittance) to output
```

#### Step Counts & Sizes

| Phase | Step Size | Max Steps | Notes |
|-------|-----------|-----------|-------|
| Empty space | 200 m | — | Until density > 0 |
| Inside cloud | 50 m | 64 | Fine detail |
| Light march | ~400 m | 6 | Toward sun for shadowing |

### 2.6 Cloud Lighting

#### Beer-Lambert Extinction

```wgsl
let extinction = density * extinctionCoeff; // ~0.04 typical
let transmittanceStep = exp(-extinction * stepSize);
transmittance *= transmittanceStep;
```

#### In-Scattering (Henyey-Greenstein Phase + Multi-Scatter)

```wgsl
// Primary HG phase (forward scattering toward camera from sun)
let cosTheta = dot(rayDir, sunDir);
let phase = henyeyGreenstein(cosTheta, 0.8); // g=0.8 forward scatter

// Light march: accumulate optical depth toward sun
var lightOpticalDepth = 0.0;
for (var i = 0; i < 6; i++) {
    let lightPos = samplePos + sunDir * f32(i) * lightStepSize;
    lightOpticalDepth += cloudDensity(lightPos, weatherUV) * lightStepSize;
}
let sunTransmittance = exp(-lightOpticalDepth * extinctionCoeff);

// Frostbite multi-scattering approximation (3 octaves)
var totalScattering = vec3f(0.0);
var attenuationFactor = 1.0;
var contributionFactor = 1.0;
var phaseFactor = 1.0;
for (var oct = 0; oct < 3; oct++) {
    let octTransmittance = pow(sunTransmittance, attenuationFactor);
    let octPhase = mix(henyeyGreenstein(cosTheta, 0.8 * phaseFactor),
                       isotropicPhase(), 0.5);
    totalScattering += sunColor * octTransmittance * octPhase * contributionFactor;
    attenuationFactor *= 0.25;
    contributionFactor *= 0.5;
    phaseFactor *= 0.5;
}

// Accumulate
scatteredLight += totalScattering * density * stepSize * transmittance;
```

### 2.7 Temporal Reprojection

To amortize the expensive ray march, only a subset of pixels are marched each frame:

#### Strategy: Checkerboard with Blue Noise Offset

- **Frame N**: March even pixels (checkerboard pattern)
- **Frame N+1**: March odd pixels
- Reproject previous frame's result for non-marched pixels using motion vectors
- **Rejection**: If reprojected UV is outside [0,1] or velocity exceeds threshold, force re-march

#### Resources

| Resource | Format | Size | Purpose |
|----------|--------|------|---------|
| `cloudCurrent` | `rgba16float` | Half-res | Current frame cloud result |
| `cloudHistory` | `rgba16float` | Half-res | Previous frame (ping-pong) |
| `motionVectors` | `rg16float` | Full-res | Screen-space velocity (from depth delta) |

#### Reprojection Compute Shader

```
1. For this pixel, check if it was marched this frame
2. If marched: use current result directly
3. If not marched:
   a. Read motion vector at this pixel
   b. Sample cloudHistory at (currentUV - motionVector)
   c. Validate: if sampled UV out-of-bounds or neighborhood variance > threshold → reject
   d. If valid: blend 90% history + 10% current neighbor interpolation
   e. If rejected: force re-march (or use nearest valid neighbor)
4. Write to cloudCurrent
```

### 2.8 Cloud Compositing

After the cloud texture is resolved (temporal reprojection complete), it's composited into the scene color buffer:

```wgsl
// In composite or dedicated cloud-composite pass:
let cloudSample = textureSample(cloudTexture, cloudSampler, uv);
let cloudColor = cloudSample.rgb;
let cloudTransmittance = cloudSample.a;

// Depth test: clouds only behind scene geometry
let sceneDepth = textureSample(depthTexture, depthSampler, uv).r;
let sceneLinearDepth = linearizeDepth(sceneDepth, near, far);
let cloudDepth = /* computed from ray intersection */;
let behindScene = step(sceneLinearDepth, cloudDepth); // 1 if cloud is behind scene

// Composite: scene * transmittance + cloud color
let finalColor = sceneColor * mix(1.0, cloudTransmittance, behindScene) 
               + cloudColor * behindScene;
```

This compositing can be added as a new post-process effect (`CloudCompositeEffect`) inserted between the scene render and the existing `CompositeEffect` (tonemapping).

---

## 3. God Rays (Volumetric Light Scattering)

Two approaches are provided: screen-space (cheap fallback) and volumetric (full integration with clouds).

### 3.1 Screen-Space God Rays (Phase 1 — Post-Process Effect)

A radial blur post-process effect that's cheap and effective.

#### Algorithm

```wgsl
@fragment
fn fs_godRays(fragCoord: vec4f, uv: vec2f) -> vec4f {
    // Project sun position to screen space
    let sunScreenPos = (vpMatrix * vec4f(sunDir * 10000.0, 1.0)).xy / w;
    let sunUV = sunScreenPos * 0.5 + 0.5;
    
    // Direction from pixel toward sun
    let deltaUV = (sunUV - uv) / f32(NUM_SAMPLES);
    
    var sampleUV = uv;
    var accumLight = 0.0;
    var decay = 1.0;
    
    for (var i = 0; i < NUM_SAMPLES; i++) {
        sampleUV += deltaUV;
        
        // Sample scene depth — sky pixels contribute light, occluders block it
        let depth = textureSample(depthTexture, depthSampler, sampleUV).r;
        let isSky = step(depth, 0.0001); // Sky has depth ≈ 0 or 1 depending on convention
        
        // Also check cloud transmittance — clouds partially occlude god rays
        let cloudT = textureSample(cloudTexture, cloudSampler, sampleUV).a;
        
        accumLight += isSky * cloudT * decay;
        decay *= 0.96; // Exponential falloff
    }
    
    accumLight *= exposure / f32(NUM_SAMPLES);
    return vec4f(sunColor * accumLight, 0.0); // Additive blend
}
```

#### Integration

- New `GodRayEffect` class extending `BaseEffect`
- **Inputs**: `'color'`, `'depth'`, `'cloud'` (cloud transmittance from volumetric cloud pass)
- **Output**: Additive contribution blended into color buffer
- **Priority**: 150 (after SSAO at 100, before Composite at 200)
- **Cost**: ~0.1-0.3ms (32-64 samples, half-res)

### 3.2 Volumetric God Rays via Froxel Grid (Phase 2 — Full Integration)

A true volumetric scattering solution using a frustum-aligned voxel (froxel) grid.

#### Froxel Grid

| Dimension | Resolution | Notes |
|-----------|-----------|-------|
| Width | 160 | ~12px per froxel at 1920 |
| Height | 90 | ~12px per froxel at 1080 |
| Depth | 64 | Exponential depth slicing |

- **Format**: `rgba16float` 3D texture
- **Depth distribution**: Exponential — more slices near camera, fewer at distance:
  ```
  z_slice = log(linearDepth / near) / log(far / near) * NUM_SLICES
  ```

#### Compute Pass: Scatter & Absorb

For each froxel voxel, compute in-scattering from the directional light:

```wgsl
@compute @workgroup_size(8, 8, 1)
fn computeFroxelScattering(/* ... */) {
    let froxelCoord = globalId.xyz;
    let worldPos = froxelToWorld(froxelCoord);
    
    // 1. Check if this froxel is in shadow (sample CSM)
    let shadowFactor = sampleCSM(worldPos, csmUniforms, shadowArray);
    
    // 2. Check cloud occlusion (sample cloud density at this world position
    //    looking toward the sun — approximated by cloud shadow map, see §4)
    let cloudShadow = sampleCloudShadowMap(worldPos);
    
    // 3. Atmospheric density at this point (Rayleigh + Mie)
    let altitude = worldPos.y;
    let densityR = exp(-altitude / 7994.0);  // Rayleigh
    let densityM = exp(-altitude / 1200.0);  // Mie (+ optional fog density)
    
    // 4. In-scattering = sunColor * visibility * density * phase
    let visibility = shadowFactor * cloudShadow;
    let cosTheta = dot(normalize(worldPos - cameraPos), sunDir);
    let phaseR = rayleighPhase(cosTheta);
    let phaseM = miePhase(cosTheta, 0.76);
    
    let scattering = sunColor * visibility * (
        BETA_R * densityR * phaseR + BETA_M * densityM * phaseM
    );
    let extinction = BETA_R * densityR + BETA_M * densityM * 1.1;
    
    // Write to froxel 3D texture
    textureStore(froxelTexture, froxelCoord, vec4f(scattering, extinction));
}
```

#### Compute Pass: Integrate (Front-to-Back)

A second compute pass integrates the froxel grid front-to-back along each column (160×90 dispatches, each walking 64 depth slices):

```wgsl
@compute @workgroup_size(8, 8, 1)
fn integrateFroxels(/* ... */) {
    let xy = globalId.xy;
    var accumulatedScattering = vec3f(0.0);
    var accumulatedTransmittance = vec3f(1.0);
    
    for (var z = 0u; z < 64u; z++) {
        let scatterExtinct = textureLoad(froxelTexture, vec3u(xy, z), 0);
        let scattering = scatterExtinct.rgb;
        let extinction = scatterExtinct.a;
        
        let sliceThickness = froxelSliceThickness(z);
        let transmittance = exp(-vec3f(extinction) * sliceThickness);
        
        // Integrate: S * (1 - T) / extinction + carry
        let integScattering = scattering * (vec3f(1.0) - transmittance) / max(vec3f(extinction), vec3f(0.0001));
        accumulatedScattering += accumulatedTransmittance * integScattering;
        accumulatedTransmittance *= transmittance;
        
        textureStore(integratedFroxels, vec3u(xy, z), 
                     vec4f(accumulatedScattering, average(accumulatedTransmittance)));
    }
}
```

#### Application in Scene Shaders

Any scene shader can sample the integrated froxel grid to get volumetric fog + god rays at its fragment position:

```wgsl
fn applyVolumetricScattering(sceneColor: vec3f, worldPos: vec3f) -> vec3f {
    let froxelUV = worldToFroxel(worldPos);
    let vol = textureSampleLevel(integratedFroxels, froxelSampler, froxelUV, 0.0);
    return sceneColor * vol.a + vol.rgb; // transmittance * color + inscatter
}
```

---

## 4. Cloud Shadows on Terrain

Clouds should cast soft shadows on terrain, water, and objects. This is done via a **2D cloud shadow map** — a top-down projection of cloud density.

### 4.1 Cloud Shadow Map Generation

A compute shader projects cloud density along the sun direction onto a 2D texture:

| Parameter | Value |
|-----------|-------|
| Resolution | 1024×1024 |
| Coverage | Matches CSM far plane (shadowRadius × 2) |
| Format | `r16float` |
| Update rate | Every frame (cheap — 2D samples only) |

```wgsl
@compute @workgroup_size(8, 8, 1)
fn generateCloudShadowMap(globalId: vec3u) {
    let uv = (vec2f(globalId.xy) + 0.5) / vec2f(resolution);
    let worldXZ = shadowMapUVToWorld(uv); // Map UV to world XZ within shadow bounds
    
    // March along sun direction through cloud layer
    var shadowTransmittance = 1.0;
    let sunDir = normalize(uniforms.sunDirection);
    
    // Find entry/exit of sun ray through cloud layer at this XZ
    // (Project from cloud base/top along sun direction)
    for (var i = 0; i < 8; i++) {
        let sampleAlt = cloudBase + f32(i) / 7.0 * cloudThickness;
        let samplePos = vec3f(worldXZ.x, sampleAlt, worldXZ.y);
        let weatherUV = worldToWeatherUV(samplePos);
        let density = cloudDensity(samplePos, weatherUV);
        shadowTransmittance *= exp(-density * extinctionCoeff * (cloudThickness / 8.0));
    }
    
    textureStore(cloudShadowMap, globalId.xy, vec4f(shadowTransmittance, 0, 0, 0));
}
```

### 4.2 Integration with Existing Shaders

The cloud shadow map is added to `SceneEnvironment` (Group 3) alongside the existing CSM shadow array:

```wgsl
// In cdlod.wgsl, object.wgsl, water.wgsl:
let csmShadow = sampleCSMShadow(worldPos);         // Existing
let cloudShadow = textureSampleLevel(cloudShadowMap, shadowSampler, 
                                      worldToCloudShadowUV(worldPos), 0.0).r;
let totalShadow = csmShadow * cloudShadow;          // Combined
```

No changes to the shader bind group layout — just one additional texture in the existing SceneEnvironment group.

---

## 5. Integration with Existing Systems

### 5.1 Pipeline Pass Ordering

Updated pass order in `GPUForwardPipeline`:

```
1.  ShadowPass              (existing — CSM depth maps)
2.  CloudShadowPass  [NEW]  (compute — 2D cloud shadow map)
3.  SkyPass                 (existing — atmospheric scattering + stars)
4.  CloudRayMarchPass [NEW] (compute — volumetric cloud ray march, half-res)
5.  CloudTemporalPass [NEW] (compute — temporal reprojection)
6.  GroundPass              (existing)
7.  OpaquePass              (existing — terrain, objects; now sample cloud shadow)
8.  TransparentPass         (existing — water; now sample cloud shadow)
9.  OverlayPass             (existing)
10. SelectionPasses         (existing)
11. DebugPass               (existing)
───── Post-Processing ─────
12. CloudCompositeEffect [NEW] (composite cloud texture into scene color)
13. GodRayEffect [NEW]        (screen-space or froxel-based god rays)
14. SSAOEffect                 (existing, optional)
15. CompositeEffect            (existing — tonemapping + gamma + dither)
```

### 5.2 SceneEnvironment Updates

`SceneEnvironment` (Group 3 bind group shared by all scene shaders) gains:

| Binding | Current | Addition |
|---------|---------|----------|
| 0 | Shadow sampler | — |
| 1 | CSM shadow array | — |
| 2 | CSM uniforms | — |
| 3 | IBL diffuse cubemap | — |
| 4 | IBL specular cubemap | — |
| 5 | IBL BRDF LUT | — |
| 6 | IBL sampler | — |
| **7** | — | **Cloud shadow map (r16float)** |
| **8** | — | **Cloud shadow uniforms (projection matrix, bounds)** |

Shaders that need cloud shadows (`cdlod.wgsl`, `object.wgsl`, `water.wgsl`) add sampling of binding 7/8.

### 5.3 DynamicSkyIBL Updates

When clouds are enabled, the sky IBL cubemap capture should include cloud contribution. Options:

1. **Simple**: Capture sky-only (current behavior). Clouds affect IBL minimally since they're a thin layer.
2. **Accurate**: After cloud ray march, re-capture cubemap including cloud color. Expensive — only on weather change, not every frame.

Recommendation: Start with option 1. Cloud contribution to ambient lighting can be approximated by darkening the ambient intensity based on average cloud coverage.

### 5.4 Weather Map ↔ Wind System

The existing `wind.ts` module provides wind direction/speed. The weather map UV offset should be driven by this:

```typescript
// In cloud compute dispatch:
weatherMapOffset.x += windDirection.x * windSpeed * deltaTime * 0.0001;
weatherMapOffset.y += windDirection.z * windSpeed * deltaTime * 0.0001;
```

---

## 6. Performance Budget & Optimization

### 6.1 Target Budget

| Component | Target (ms) | Resolution | Notes |
|-----------|------------|------------|-------|
| Cloud shadow map | 0.05 | 1024² | 2D compute, cheap |
| Cloud ray march | 0.4-0.8 | Half-res, checkerboard | Amortized over 2 frames |
| Temporal reprojection | 0.05 | Half-res | Simple compute |
| Cloud composite | 0.05 | Full-res | Texture sample + blend |
| God rays (screen-space) | 0.1-0.2 | Half-res | 32-64 radial samples |
| **Total** | **0.65-1.15** | | |

### 6.2 Key Optimizations

1. **Temporal reprojection**: March only 50% of pixels per frame (checkerboard). Halves ray-march cost.

2. **Adaptive step size**: Start with 200m steps in empty space, drop to 50m inside clouds. Skip entirely if weather map coverage ≈ 0 at the ray's XZ.

3. **Early ray termination**: Exit when transmittance < 0.01 (cloud is fully opaque from camera's perspective).

4. **Blue noise dithering**: Per-pixel temporal blue noise offsets the ray start position. Combined with temporal accumulation, this produces smooth results from fewer samples.

5. **LOD for light march**: Use only 4-6 samples for the sun-direction light march (self-shadowing). Use exponentially increasing step sizes.

6. **Weather map early-out**: Before ray marching, sample the weather map at the ray's approximate XZ footprint. If coverage = 0, skip the entire ray.

7. **Mipmap noise sampling**: For distant clouds (high step size), sample noise at higher mip levels to avoid aliasing and reduce texture bandwidth.

8. **Half-resolution rendering**: Cloud texture is at 50% resolution. The bilinear upscale is masked by the soft nature of clouds.

### 6.3 WebGPU-Specific Considerations

- **3D textures**: WebGPU supports `texture_3d<f32>` and `textureStore` on 3D textures in compute shaders. The 128³ shape noise fits in ~8MB VRAM (rgba8unorm).
- **Compute dispatch limits**: WebGPU max workgroup size is 256 invocations. Using `@workgroup_size(8, 8, 1)` = 64 invocations is well within limits.
- **`textureSampleLevel` in compute**: Compute shaders cannot use `textureSample` (requires derivatives). All noise sampling must use `textureSampleLevel` with explicit LOD.
- **Storage texture formats**: WebGPU restricts which formats can be used with `textureStore`. `rgba16float` is supported for storage. `r16float` may require `rgba16float` with unused channels on some implementations.
- **Timestamp queries**: Use `timestamp-query` feature (if available) for GPU profiling of individual compute dispatches during development.

---

## 7. UI Controls

### 7.1 Environment Panel — Cloud Section

Add a collapsible **"Clouds"** section to `EnvironmentPanel` / `LightingTab`:

| Control | Type | Range | Default | Notes |
|---------|------|-------|---------|-------|
| Clouds Enabled | Toggle | on/off | off | Master enable |
| Coverage | Slider | 0.0–1.0 | 0.4 | Global coverage multiplier |
| Cloud Type | Slider | 0.0–1.0 | 0.5 | 0=stratus (flat), 1=cumulus (puffy) |
| Density | Slider | 0.01–0.1 | 0.04 | Extinction coefficient |
| Cloud Base (m) | Slider | 500–5000 | 1500 | Base altitude |
| Cloud Thickness (m) | Slider | 500–5000 | 2500 | Layer thickness |
| Wind Speed | Slider | 0–50 | 5 | m/s, drives weather map scroll |
| Wind Direction | Slider | 0–360° | 45 | Azimuth |
| Cloud Shadows | Toggle | on/off | on | Enable cloud shadow map |

### 7.2 Rendering Panel — Volumetric Section

Add a collapsible **"Volumetric"** section to `RenderingPanel`:

| Control | Type | Range | Default | Notes |
|---------|------|-------|---------|-------|
| God Rays | Toggle | on/off | off | Enable god ray effect |
| God Ray Intensity | Slider | 0.0–2.0 | 0.5 | Exposure multiplier |
| God Ray Samples | Dropdown | 32/64/128 | 64 | Quality vs performance |
| Temporal Reprojection | Toggle | on/off | on | Cloud temporal filtering |
| Cloud Resolution | Dropdown | Quarter/Half/Full | Half | Ray march resolution |

### 7.3 Debug Visualization

Register cloud textures with the existing `DebugTextureManager`:

| Debug Texture | Contents |
|---------------|----------|
| `cloud-result` | Final cloud color + transmittance (half-res) |
| `cloud-shadow` | Cloud shadow map (top-down transmittance) |
| `weather-map` | Weather map (coverage, type, precip) |
| `cloud-history` | Temporal history buffer |

---

## 8. Implementation Phases

### Phase 1: Foundation & 2D Cloud Fallback (3–4 days)

**Goal**: Get basic cloud shapes visible with minimal infrastructure.

1. **Noise texture generation** (`cloud-noise-gen.wgsl`)
   - Compute shaders for 3D Worley-Perlin (128³) and detail noise (32³)
   - `CloudNoiseGenerator.ts` class managing compute pipelines and textures
   - Verify with debug texture visualization

2. **Weather map generation** (`weather-map.wgsl`)
   - 2D FBM-based procedural weather map
   - `WeatherMapGenerator.ts` with coverage/type parameters
   - Wind-driven UV scrolling

3. **Cloud ray march** — basic version (`cloud-raymarch.wgsl`)
   - Compute shader, full resolution (no temporal yet)
   - Basic density function with shape noise + weather map
   - Simple Beer-Lambert lighting (no multi-scatter yet)
   - Output to rgba16float texture

4. **Cloud composite** (`CloudCompositeEffect.ts`)
   - Post-process effect that blends cloud texture into scene color
   - Depth-aware compositing (clouds behind geometry)
   - Register in PostProcessPipeline at priority 125

5. **UI controls** — basic coverage slider in Environment panel

**Deliverable**: Visible clouds that react to coverage slider and sun direction.

### Phase 2: Lighting & Shadows (3–4 days)

**Goal**: Realistic cloud illumination and cloud shadows on terrain.

1. **Multi-scattering approximation** in ray march shader
   - Frostbite octave-based analytical multi-scatter
   - Henyey-Greenstein phase function (dual-lobe for silver lining)

2. **Detail erosion noise** integration
   - Apply 32³ detail noise to erode cloud edges
   - Height-dependent erosion (more at top, less at bottom)

3. **Cloud shadow map** (`cloud-shadow.wgsl`)
   - Compute shader generating top-down transmittance map
   - `CloudShadowPass` integrated into pipeline before OpaquePass
   - Add to `SceneEnvironment` group 3 bindings

4. **Shader integration**
   - `cdlod.wgsl`: Sample cloud shadow map, multiply with CSM shadow
   - `object.wgsl`: Same
   - `water.wgsl`: Same + cloud reflection in specular

5. **Time-of-day coloring**
   - Clouds tinted by atmospheric scattering color at sunset/sunrise
   - Ambient sky color from existing IBL used for cloud ambient term

**Deliverable**: Clouds with self-shadowing, silver linings, and shadows on terrain.

### Phase 3: Temporal Reprojection & Performance (2–3 days)

**Goal**: Hit performance budget through temporal amortization.

1. **Half-resolution rendering**
   - Cloud ray march at 50% resolution
   - Bilateral upscale in composite pass

2. **Checkerboard rendering**
   - March alternating pixels per frame
   - Previous VP matrix uniform for reprojection

3. **Temporal reprojection** (`cloud-temporal.wgsl`)
   - Motion vector generation (from depth + VP delta)
   - History validation and blend
   - Ping-pong buffer management

4. **Blue noise dithering**
   - Generate or load blue noise texture (128×128)
   - Apply to ray start offset, rotated per frame

5. **Performance profiling**
   - Timestamp queries on each compute dispatch
   - Verify <1ms total on target hardware

**Deliverable**: Smooth, temporally stable clouds at <1ms GPU cost.

### Phase 4: God Rays (2–3 days)

**Goal**: Volumetric light shafts through cloud gaps.

1. **Screen-space god rays** (`god-rays.wgsl`)
   - Post-process radial blur sampling depth + cloud transmittance
   - `GodRayEffect.ts` extending BaseEffect
   - Sun screen-space projection uniform

2. **Integration with clouds**
   - God rays use cloud transmittance to determine occlusion
   - Fade out when sun below horizon (use existing `sunVisibility`)

3. **UI controls** — intensity, sample count, enable toggle

4. **(Optional) Froxel volumetric scattering**
   - Only if screen-space approach is insufficient
   - Full froxel grid with CSM + cloud shadow integration

**Deliverable**: Visible god rays through cloud gaps and terrain features.

### Phase 5: Polish & Advanced Features (2–3 days)

**Goal**: Production quality and edge cases.

1. **Night sky interaction**
   - Stars visible through cloud gaps (transmittance)
   - Moon illumination of cloud tops
   - Cloud darkening at night (consistent with existing `sunVisibility` system)

2. **Precipitation effects**
   - Dense cloud bases darken with precipitation channel
   - Optional: rain particle effects below precipitating clouds

3. **IBL interaction**
   - Reduce ambient intensity based on cloud coverage
   - Optional: re-capture IBL cubemap with clouds on weather change

4. **Edge cases**
   - Camera inside cloud layer (fog fallback)
   - Extremely low sun angles (grazing cloud illumination)
   - Clear sky (all systems early-out, zero cost)

5. **Serialization** — save/load cloud settings in scene files

**Deliverable**: Complete, polished volumetric cloud + god ray system.

---

## 9. File Structure

```
src/core/gpu/
├── clouds/
│   ├── index.ts                      # Public exports
│   ├── CloudNoiseGenerator.ts        # 3D noise texture compute generation
│   ├── WeatherMapGenerator.ts        # 2D weather map generation + animation
│   ├── CloudRayMarcher.ts            # Main ray-march compute pipeline
│   ├── CloudTemporalFilter.ts        # Temporal reprojection
│   ├── CloudShadowGenerator.ts       # 2D cloud shadow map
│   └── types.ts                      # Cloud config interfaces
│
├── shaders/
│   ├── clouds/
│   │   ├── cloud-noise-gen.wgsl      # 3D Worley-Perlin noise generation
│   │   ├── cloud-detail-noise.wgsl   # 3D detail erosion noise
│   │   ├── weather-map.wgsl          # 2D weather map generation
│   │   ├── cloud-raymarch.wgsl       # Main volumetric ray march
│   │   ├── cloud-temporal.wgsl       # Temporal reprojection
│   │   ├── cloud-shadow.wgsl         # Cloud shadow map generation
│   │   └── cloud-common.wgsl         # Shared: density function, phase, remap
│   │
│   └── common/
│       └── cloud-shadow-sample.wgsl  # Shared include for scene shaders
│
├── postprocess/
│   ├── effects/
│   │   ├── CloudCompositeEffect.ts   # Cloud → scene compositing
│   │   └── GodRayEffect.ts           # Screen-space god rays
│   └── shaders/
│       ├── cloud-composite.wgsl      # Cloud composite fragment shader
│       └── god-rays.wgsl             # God ray radial blur shader
│
├── pipeline/
│   └── passes/
│       ├── CloudShadowPass.ts        # Dispatches cloud shadow compute
│       ├── CloudRayMarchPass.ts      # Dispatches cloud ray march compute
│       └── CloudTemporalPass.ts      # Dispatches temporal reprojection
│
└── renderers/
    └── shared/
        └── SceneEnvironment.ts       # Updated: +cloud shadow bindings
```

---

## 10. References

### Core Papers & Talks

1. **Schneider, A. (2015)** — "The Real-time Volumetric Cloudscapes of Horizon: Zero Dawn" — SIGGRAPH 2015. The foundational Nubis technique for real-time volumetric clouds. Introduces Worley-Perlin noise, weather map, height gradient, and coverage remap.

2. **Hillaire, S. (2016)** — "Physically Based Sky, Atmosphere and Cloud Rendering in Frostbite" — SIGGRAPH 2016. Introduces the multi-scattering octave approximation and froxel-based volumetric fog with god rays.

3. **Schneider, A. (2017)** — "Nubis: Authoring Real-Time Volumetric Cloudscapes with the Decima Engine" — SIGGRAPH 2017. Refinements to the original technique: improved temporal reprojection, detail noise erosion, height-based cloud typing.

4. **Hillaire, S. (2020)** — "A Scalable and Production Ready Sky and Atmosphere Rendering Technique" — Eurographics 2020. UE5's sky atmosphere model, includes updated cloud integration approach.

### Optimization Techniques

5. **Jimenez, J. (2014)** — "Next Generation Post Processing in Call of Duty: Advanced Warfare" — SIGGRAPH 2014. Interleaved gradient noise for temporal dithering (already used in our composite shader).

6. **Patney, A. (2015)** — Checkerboard rendering for VR. Applied to cloud ray marching for 2× amortization.

7. **Bauer, F. (2019)** — "Creating the Atmospheric World of Red Dead Redemption 2" — GDC 2019. Practical production insights on volumetric clouds + weather systems.

### WebGPU-Specific

8. **WebGPU Specification** — W3C. Compute shader limits, storage texture format support, workgroup constraints.

9. **WGSL Specification** — W3C. `textureSampleLevel` requirement in compute, 3D texture operations, workgroup shared memory.
