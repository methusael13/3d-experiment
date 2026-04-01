# Volumetric Clouds & God Rays — Implementation Plan

## Table of Contents

1. [Existing Architecture Overview](#1-existing-architecture-overview)
2. [Volumetric Cloud System](#2-volumetric-cloud-system)
3. [God Rays (Volumetric Light Scattering)](#3-god-rays-volumetric-light-scattering)
4. [Cloud Shadows on Terrain](#4-cloud-shadows-on-terrain)
5. [Froxel-Based Volumetric Fog](#5-froxel-based-volumetric-fog)
6. [Integration with Existing Systems](#6-integration-with-existing-systems)
7. [Performance Budget & Optimization](#7-performance-budget--optimization)
8. [UI Controls](#8-ui-controls)
9. [Implementation Phases](#9-implementation-phases)
10. [File Structure](#10-file-structure)
11. [References](#11-references)

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

### 2.2 Cloud Type System

The system supports multiple cloud types, each with distinct visual characteristics and height profiles. The weather map's **Cloud Type** channel (G) selects the active type, and the density function adapts accordingly.

| Cloud Type | Real-World Equivalent | Height Profile | Noise Character | Coverage Range | Altitude |
|------------|----------------------|----------------|-----------------|----------------|----------|
| **Cumulus** (default) | Cumulus mediocris / humilis | Round bottom, flat top, billowy | Perlin-Worley dominant, high detail erosion | 0.0–0.6 | 1,500–4,000m |
| **Stratocumulus** | Stratocumulus | Thin lumpy sheet, less vertical | Worley dominant, moderate erosion | 0.4–0.8 | 800–2,000m |
| **Stratus / Overcast** | Stratus, Nimbostratus | Very thin uniform layer, nearly flat | Minimal noise, low-frequency only | 0.8–1.0 | 500–1,500m |
| **Cumulonimbus** | Cumulonimbus (storm) | Tall tower, anvil top, dark base | High-amplitude Worley, dense base | 0.3–0.7 | 500–10,000m |

The density function (§2.4) branches on cloud type to select the appropriate **height gradient**:

```wgsl
fn heightGradient(heightFrac: f32, cloudType: f32) -> f32 {
    // cloudType: 0.0 = stratus, 0.5 = stratocumulus, 1.0 = cumulus
    if (cloudType < 0.25) {
        // Stratus/overcast: thin flat slab
        return smoothstep(0.0, 0.05, heightFrac) * smoothstep(1.0, 0.95, heightFrac);
    } else if (cloudType < 0.6) {
        // Stratocumulus: slightly lumpy layer
        return smoothstep(0.0, 0.08, heightFrac) * smoothstep(1.0, 0.7, heightFrac);
    } else {
        // Cumulus: round bottom, puffy top (default)
        return smoothstep(0.0, 0.1, heightFrac) * smoothstep(1.0, 0.6, heightFrac);
    }
}
```

For stratus/overcast, the detail erosion noise strength is also reduced (wispy edges look wrong on flat uniform layers).

### 2.2.1 Cirrus Layer (High-Altitude Ice Clouds)

A separate **2D scrolling layer** rendered above the volumetric cloud shell at 8,000–12,000m. Cirrus clouds are too thin and streaky for volumetric ray-marching; a textured quad is more appropriate and extremely cheap.

| Property | Value |
|----------|-------|
| Altitude | 8,000–12,000 m |
| Rendering | Fullscreen quad in sky pass, alpha-blended |
| Texture | Tileable 2D cirrus noise (512×512, `r8unorm`) |
| Animation | UV offset scrolled by wind × 2 (jet-stream speed) |
| Cost | ~0.05ms (single texture sample per pixel) |

Cirrus opacity is controlled by the weather preset (0 = none, 1 = dense cirrus). It's rendered **before** the volumetric cloud composite so volumetric clouds correctly occlude cirrus behind them.

### 2.3 Cloud Layer Model

Clouds exist in a **spherical shell** between two altitudes above the Earth's surface:

| Parameter | Value | Notes |
|-----------|-------|-------|
| Cloud base altitude | 1,500 m | Cumulus base (adjustable per cloud type) |
| Cloud top altitude | 4,000 m | Cumulus tops (up to 10,000m for cumulonimbus) |
| Layer thickness | 2,500 m | Ray march domain |
| Earth radius | 6,360,000 m | Matches `sky.wgsl` |

The ray-march domain is defined by two concentric spheres: `R_earth + cloud_base` and `R_earth + cloud_top`. The base and top altitudes shift based on the active cloud type.

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

## 5. Froxel-Based Volumetric Fog

### 5.1 Overview & Motivation

The current atmospheric fog system (`atmospheric-fog.wgsl`) is a **screen-space post-process** that analytically computes fog along each view ray. While efficient, it can only respond to the single directional light (sun/moon). It cannot produce:

- **Point light glow spheres** in fog (e.g., a streetlamp illuminating surrounding mist)
- **Spot light cones/beams** visible in foggy air (e.g., headlights, flashlights)
- **Volumetric shadows** (objects blocking light through fog, creating dark shafts)
- **Light shafts / god rays** from local lights through occluders
- **Heterogeneous fog** (local fog pockets, density noise for wispy effects)

Froxel-based volumetric fog solves all of these by evaluating **every light source** at every point in a 3D frustum-aligned voxel grid, then integrating the accumulated scattering/extinction along each view ray.

### 5.2 Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│              Froxel Volumetric Fog Pipeline                   │
│                                                              │
│  ┌────────────────┐   ┌─────────────────┐                   │
│  │ Density         │   │ Light Culling   │                   │
│  │ Injection       │   │ (Cluster/Froxel)│                   │
│  │ (Compute)       │   │ (Compute)       │                   │
│  └───────┬────────┘   └────────┬────────┘                   │
│          │                      │                            │
│          ▼                      ▼                            │
│  ┌──────────────────────────────────────┐                    │
│  │ Scattering + Extinction Injection    │                    │
│  │ Per-froxel: accumulate all lights    │                    │
│  │ (Compute — main pass)               │                    │
│  └───────────────────┬──────────────────┘                    │
│                      │                                       │
│          ┌───────────▼──────────────┐                        │
│          │ Temporal Reprojection    │                         │
│          │ (smooth over frames)     │                         │
│          └───────────┬──────────────┘                        │
│                      │                                       │
│          ┌───────────▼──────────────┐                        │
│          │ Front-to-Back Integration│                         │
│          │ (ray march through grid) │                         │
│          └───────────┬──────────────┘                        │
│                      │                                       │
│          ┌───────────▼──────────────┐                        │
│          │ Apply to Scene           │                         │
│          │ (sample 3D tex per pixel)│                         │
│          └──────────────────────────┘                        │
└──────────────────────────────────────────────────────────────┘
```

### 5.3 Froxel Grid Specification

The frustum is divided into a 3D grid of "frustum voxels" (froxels):

| Property | Value | Notes |
|----------|-------|-------|
| Width | 160 | ~12px per froxel at 1920×1080 |
| Height | 90 | ~12px per froxel at 1080 |
| Depth slices | 64 | Exponential distribution |
| Format (scatter) | `rgba16float` | RGB = in-scattered light, A = extinction |
| Format (integrated) | `rgba16float` | RGB = accumulated scatter, A = transmittance |
| Total 3D texture size | 160×90×64 = ~921,600 voxels | ~7.2 MB per texture |

#### Exponential Depth Slicing

More resolution near the camera (where fog detail matters most), fewer slices at distance:

```wgsl
// World-space depth → slice index
fn depthToSlice(linearDepth: f32) -> f32 {
    return log(linearDepth / near) / log(far / near) * f32(NUM_DEPTH_SLICES);
}

// Slice index → world-space depth (center of slice)
fn sliceToDepth(slice: f32) -> f32 {
    return near * pow(far / near, slice / f32(NUM_DEPTH_SLICES));
}

// Thickness of a given slice (for integration)
fn sliceThickness(slice: u32) -> f32 {
    let d0 = sliceToDepth(f32(slice));
    let d1 = sliceToDepth(f32(slice + 1u));
    return d1 - d0;
}
```

With near=0.1, far=2000:
- Slice 0: 0.1m–0.13m (very thin near camera)
- Slice 16: 1.7m–2.2m
- Slice 32: 28m–37m
- Slice 48: 470m–620m
- Slice 63: 1520m–2000m

### 5.4 Pass 1: Fog Density Injection

A compute shader writes fog density into each froxel. This supports multiple density sources:

```wgsl
@compute @workgroup_size(8, 8, 1)
fn injectFogDensity(@builtin(global_invocation_id) gid: vec3u) {
    if (any(gid.xy >= vec2u(GRID_WIDTH, GRID_HEIGHT)) || gid.z >= NUM_DEPTH_SLICES) { return; }

    let worldPos = froxelToWorld(gid);

    // ── Source 1: Global height fog (matches existing AtmosphericFog settings) ──
    let heightAboveFog = worldPos.y - u.fogHeight;
    var density = u.fogBaseDensity * exp(-u.fogHeightFalloff * heightAboveFog);

    // ── Source 2: 3D noise for heterogeneous/wispy fog ──
    if (u.noiseEnabled > 0.5) {
        let noiseUV = worldPos * u.noiseScale + u.noiseOffset; // animated by wind
        let noise = textureSampleLevel(fogNoise3D, noiseSampler, noiseUV, 0.0).r;
        // Modulate density: noise can add local pockets or thin the fog
        density *= mix(1.0, noise * 2.0, u.noiseStrength);
    }

    // ── Source 3: Local fog volumes (future — sphere/box emitters) ──
    // for each fog volume overlapping this froxel:
    //     density += volumeContribution(worldPos, volume);

    // Store: density is extinction coefficient σ_t
    let extinction = max(0.0, density);
    textureStore(densityGrid, gid, vec4f(0.0, 0.0, 0.0, extinction));
}
```

#### 3D Noise Texture for Heterogeneous Fog

| Property | Value |
|----------|-------|
| Size | 64³ or 128³ |
| Format | `r8unorm` (single channel) |
| Content | Tileable 3D Perlin/Worley FBM |
| Animation | UV offset scrolled by wind direction × speed |

This noise creates wispy, non-uniform fog that looks natural rather than a flat gradient.

### 5.5 Pass 2: Light Injection (Scattering Computation)

The most performance-critical pass. For each froxel, accumulate in-scattered light from **all** light sources that illuminate it.

> **Existing Engine Infrastructure:** The engine already has a full multi-light system that the froxel fog can leverage directly:
> - **`LightBufferManager`** (`renderers/LightBufferManager.ts`): Manages GPU storage buffers for up to 16 point lights and 16 spot lights. Buffers are at SceneEnvironment Group 3 bindings 10–12 (`LightCounts` uniform, `PointLightData[]` storage, `SpotLightData[]` storage). Updated each frame by `LightingSystem`.
> - **`lights.wgsl`** (`shaders/common/lights.wgsl`): Already defines `PointLightData`, `SpotLightData`, `LightCounts` structs and `attenuateDistance()` / `attenuateSpotCone()` functions matching the GPU buffer layout.
> - **Spot shadow atlas**: `ShadowRendererGPU` already maintains a spot shadow atlas (`texture_depth_2d_array`) at binding 13, with a comparison sampler at binding 14. Each `SpotLightData` carries a `shadowAtlasIndex` and `lightSpaceMatrix` for shadow lookup.
> - **Cookie atlas**: Light cookie support exists at bindings 15–16 (2D array + sampler).
>
> The froxel scattering compute shader should **bind these existing buffers directly** rather than creating a separate light system. The `FroxelLightList` clustered assignment pass reads from the same `PointLightData[]`/`SpotLightData[]` storage buffers. For spot shadow sampling, use the existing atlas via `textureLoadCompare` on binding 13 with the light's `lightSpaceMatrix`.

#### 5.5.1 Light Types Supported

| Light Type | Visible Effect in Fog | Shadow Support |
|------------|----------------------|----------------|
| **Directional** (sun/moon) | Uniform glow + god rays via CSM shadows | CSM shadow map sampling |
| **Point** | Glowing sphere of illuminated fog | Optional shadow cubemap |
| **Spot** | Visible cone/beam of light | Spot shadow atlas (existing binding 13) |

#### 5.5.2 Clustered Light Assignment

Before the scattering pass, a **light-to-froxel assignment** compute pass determines which lights affect which froxels. This avoids iterating all lights for every froxel.

```wgsl
// Light cluster structure (per froxel)
struct FroxelLightList {
    count: u32,
    lightIndices: array<u32, MAX_LIGHTS_PER_FROXEL>, // e.g., 32
}
```

The assignment pass:
1. For each light, compute its AABB in froxel space
2. For each froxel in that AABB, append the light index to that froxel's list
3. Output: `storage buffer` of `FroxelLightList` per froxel

This is the same clustered shading approach used by modern forward+ renderers, adapted to the froxel grid.

#### 5.5.3 Main Scattering Compute Shader

```wgsl
@compute @workgroup_size(8, 8, 1)
fn computeScattering(@builtin(global_invocation_id) gid: vec3u) {
    if (any(gid.xy >= vec2u(GRID_WIDTH, GRID_HEIGHT)) || gid.z >= NUM_DEPTH_SLICES) { return; }

    let worldPos = froxelToWorld(gid);
    let viewDir = normalize(worldPos - u.cameraPosition);

    // Read density from injection pass
    let stored = textureLoad(densityGrid, gid, 0);
    let extinction = stored.a;

    // Skip empty froxels (no fog here)
    if (extinction < 0.00001) {
        textureStore(scatterGrid, gid, vec4f(0.0, 0.0, 0.0, 0.0));
        return;
    }

    var totalScattering = vec3f(0.0);

    // ── Directional light (sun/moon) ──
    {
        // Shadow test via CSM
        let shadowFactor = sampleCSMShadow(worldPos);
        // Cloud shadow (if clouds enabled)
        let cloudShadow = select(1.0, sampleCloudShadow(worldPos), u.cloudsEnabled > 0.5);

        let visibility = shadowFactor * cloudShadow;
        let cosTheta = dot(viewDir, u.sunDirection);

        // Rayleigh + Mie phase functions
        let phaseR = rayleighPhase(cosTheta);
        let phaseM = henyeyGreenstein(cosTheta, u.mieG); // g ≈ 0.76

        let sunScatter = u.sunColor * u.sunIntensity * visibility *
            (u.betaR * phaseR + u.betaM * phaseM) * extinction;
        totalScattering += sunScatter;
    }

    // ── Point & Spot lights (from clustered assignment) ──
    let froxelIndex = gid.x + gid.y * GRID_WIDTH + gid.z * GRID_WIDTH * GRID_HEIGHT;
    let lightList = lightClusters[froxelIndex];

    for (var i = 0u; i < lightList.count; i++) {
        let lightIdx = lightList.lightIndices[i];
        let light = lights[lightIdx];

        let toLight = light.position - worldPos;
        let dist = length(toLight);
        let lightDir = toLight / max(dist, 0.001);

        // Distance attenuation (inverse square with range cutoff)
        let attenuation = pointLightAttenuation(dist, light.range);
        if (attenuation < 0.001) { continue; }

        // Spot cone attenuation (if spot light)
        var spotFactor = 1.0;
        if (light.type == LIGHT_SPOT) {
            let cosAngle = dot(-lightDir, light.direction);
            spotFactor = smoothstep(light.outerConeAngle, light.innerConeAngle, cosAngle);
            if (spotFactor < 0.001) { continue; }
        }

        // Shadow test (if this light has a shadow map)
        var shadowFactor = 1.0;
        if (light.shadowMapIndex >= 0) {
            shadowFactor = sampleLocalShadow(worldPos, light);
        }

        // Phase function (isotropic for point lights, or HG for spot)
        let cosTheta = dot(viewDir, lightDir);
        let phase = select(
            isotropicPhase(),                       // Point: uniform scatter
            henyeyGreenstein(cosTheta, 0.5),        // Spot: mild forward scatter
            light.type == LIGHT_SPOT
        );

        let lightScatter = light.color * light.intensity * attenuation *
            spotFactor * shadowFactor * phase * extinction;
        totalScattering += lightScatter;
    }

    // ── Ambient / sky light ──
    // Small ambient term so fog doesn't go completely black in unlit areas
    let ambientScatter = u.ambientColor * u.ambientIntensity * extinction * isotropicPhase();
    totalScattering += ambientScatter;

    textureStore(scatterGrid, gid, vec4f(totalScattering, extinction));
}
```

#### 5.5.4 Point Light Attenuation

```wgsl
fn pointLightAttenuation(dist: f32, range: f32) -> f32 {
    // Smooth inverse-square with range cutoff (UE4/UE5 style)
    let d2 = dist * dist;
    let r2 = range * range;
    let falloff = saturate(1.0 - d2 * d2 / (r2 * r2));
    return falloff * falloff / max(d2, 0.01);
}
```

#### 5.5.5 Phase Functions

```wgsl
// Isotropic: light scatters equally in all directions
fn isotropicPhase() -> f32 {
    return 1.0 / (4.0 * PI);
}

// Rayleigh: small particles (air molecules) — more scatter at 90°
fn rayleighPhase(cosTheta: f32) -> f32 {
    return 3.0 / (16.0 * PI) * (1.0 + cosTheta * cosTheta);
}

// Henyey-Greenstein: large particles (fog droplets) — forward scatter
fn henyeyGreenstein(cosTheta: f32, g: f32) -> f32 {
    let g2 = g * g;
    let denom = 1.0 + g2 - 2.0 * g * cosTheta;
    return (1.0 - g2) / (4.0 * PI * pow(denom, 1.5));
}

// Cornette-Shanks (improved HG for Mie): better energy conservation
fn cornetteShanks(cosTheta: f32, g: f32) -> f32 {
    let g2 = g * g;
    let num = 3.0 * (1.0 - g2) * (1.0 + cosTheta * cosTheta);
    let denom = 2.0 * (2.0 + g2) * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
    return num / (4.0 * PI * denom);
}
```

### 5.6 Pass 3: Temporal Reprojection

To hide the low spatial resolution of the froxel grid and reduce flickering:

```wgsl
@compute @workgroup_size(8, 8, 1)
fn temporalFilter(@builtin(global_invocation_id) gid: vec3u) {
    let current = textureLoad(scatterGrid, gid, 0);

    // Reproject: find where this froxel was in the previous frame
    let worldPos = froxelToWorld(gid);
    let prevClip = u.prevViewProj * vec4f(worldPos, 1.0);
    let prevUV = prevClip.xy / prevClip.w * 0.5 + 0.5;
    let prevSlice = depthToSlice(prevClip.z / prevClip.w);
    let prevCoord = vec3f(prevUV * vec2f(GRID_WIDTH, GRID_HEIGHT), prevSlice);

    // Validate: is the reprojected coordinate in bounds?
    let inBounds = all(prevCoord >= vec3f(0.0)) && all(prevCoord < vec3f(GRID_WIDTH, GRID_HEIGHT, NUM_DEPTH_SLICES));

    if (inBounds) {
        let history = textureSampleLevel(historyGrid, linearSampler, 
                                          prevCoord / vec3f(GRID_WIDTH, GRID_HEIGHT, NUM_DEPTH_SLICES), 0.0);
        // Blend: 95% history + 5% current (aggressive temporal smoothing)
        let blended = mix(current, history, 0.95);
        textureStore(scatterGrid, gid, blended);
    }
    // If out of bounds, keep current (no history available)
}
```

### 5.7 Pass 4: Front-to-Back Ray Integration

Integrates the 3D scatter/extinction grid into a final **accumulated scattering + transmittance** texture that can be sampled per-pixel:

```wgsl
@compute @workgroup_size(8, 8, 1)
fn integrateScattering(@builtin(global_invocation_id) gid: vec2u) {
    if (any(gid >= vec2u(GRID_WIDTH, GRID_HEIGHT))) { return; }

    var accumScatter = vec3f(0.0);
    var accumTransmittance = 1.0;

    for (var z = 0u; z < NUM_DEPTH_SLICES; z++) {
        let data = textureLoad(scatterGrid, vec3u(gid, z), 0);
        let scattering = data.rgb;
        let extinction = data.a;

        let thickness = sliceThickness(z);
        let sliceTransmittance = exp(-extinction * thickness);

        // Energy-conserving integration:
        // in-scattered = scattering × (1 - transmittance) / extinction
        let integScatter = scattering * (1.0 - sliceTransmittance) / max(extinction, 0.00001);

        accumScatter += accumTransmittance * integScatter;
        accumTransmittance *= sliceTransmittance;

        // Store per-slice (so scene shaders can sample at any depth)
        textureStore(integratedGrid, vec3u(gid, z), 
                     vec4f(accumScatter, accumTransmittance));
    }
}
```

### 5.8 Application: Sampling the Fog Volume

After integration, any pixel can look up its fog contribution by converting its world position to a froxel UV:

```wgsl
fn applyVolumetricFog(sceneColor: vec3f, worldPos: vec3f) -> vec3f {
    // Convert world position to froxel UVW
    let clipPos = u.viewProjMatrix * vec4f(worldPos, 1.0);
    let ndc = clipPos.xyz / clipPos.w;
    let uv = ndc.xy * 0.5 + 0.5;
    let linearDepth = length(worldPos - u.cameraPosition);
    let w = depthToSlice(linearDepth) / f32(NUM_DEPTH_SLICES);

    let fogSample = textureSampleLevel(integratedGrid, trilinearSampler, vec3f(uv, w), 0.0);
    let inScatter = fogSample.rgb;
    let transmittance = fogSample.a;

    // Apply: scene fades by transmittance, fog light adds on top
    return sceneColor * transmittance + inScatter;
}
```

This can be applied either:
- **As a post-process** (like the current AtmosphericFogEffect — reads depth, reconstructs world pos, samples grid)
- **Inline in scene shaders** (each object samples the grid at its fragment position — more accurate for transparent objects)

### 5.9 Relationship to Existing Atmospheric Fog

The froxel volumetric fog **replaces** the current `AtmosphericFogEffect` post-process when enabled. The transition strategy:

| Feature | Current (Post-Process) | Volumetric (Froxel) |
|---------|----------------------|---------------------|
| Height fog | ✅ Analytical integration | ✅ Density injection pass |
| Haze / aerial perspective | ✅ Distance-based extinction | ✅ Rayleigh scattering in froxels |
| Directional light | ✅ Sun illumination only | ✅ Sun + CSM shadows = god rays |
| Point lights | ❌ | ✅ Clustered light injection |
| Spot lights | ❌ | ✅ Cone + shadow map |
| Volumetric shadows | ❌ | ✅ Shadow map sampling per froxel |
| God rays | ❌ (separate SS pass) | ✅ Automatic from CSM occlusion |
| Heterogeneous fog | ❌ (uniform density) | ✅ 3D noise modulation |
| Fog mode (exp/exp²) | ✅ | ✅ (via density function) |
| Performance | ~0.1ms | ~1-3ms |

The existing `AtmosphericFogEffect` remains as a **lightweight fallback** for scenarios where volumetric cost is too high, or as the default when volumetric fog is disabled.

### 5.10 Local Fog Volumes (Emitters)

Beyond global height fog, the system supports **local fog volume emitters** — placed as entities in the scene:

#### Volume Types

| Shape | Use Case | Parameters |
|-------|----------|------------|
| **Sphere** | Campfire smoke, explosions | center, radius, density, falloff |
| **Box** | Room interiors, caves | transform, extents, density |
| **Cylinder** | Chimney smoke columns | center, radius, height, density |

#### ECS Integration

```typescript
// FogVolumeComponent
interface FogVolumeComponent {
    shape: 'sphere' | 'box' | 'cylinder';
    density: number;       // Base density inside volume
    falloff: number;       // How quickly density drops at edges (0 = hard, 1 = soft)
    color?: [number, number, number]; // Optional tint
    noiseScale?: number;   // Optional noise for non-uniform interior
}
```

During the density injection pass, fog volume entities are queried and their contributions added to the froxel grid. A GPU buffer of active fog volumes is uploaded each frame and iterated in the compute shader.

### 5.11 Visible Light Effects Summary

With the complete froxel system, these visual effects emerge naturally:

| Effect | How It Works |
|--------|-------------|
| **Spot light beams** | Spot light cone intersects fog froxels → scattering accumulated inside cone → visible beam |
| **Point light glow** | Point light attenuates with distance² → nearby froxels get high in-scatter → soft glow sphere |
| **God rays (sun)** | CSM shadows sampled per froxel → shadowed froxels get no sun scatter → visible shafts of light |
| **Volumetric shadows** | Any shadow-casting geometry blocks light → froxels behind it stay dark → shadow visible in fog |
| **Light shafts through windows** | Spot or directional shadow map has window shape → froxels in beam lit, others dark → shaft |
| **Fog around fire/torch** | Local fog volume emitter + point light → dense fog + strong scatter = glowing haze |
| **Flashlight beam** | Spot light with narrow cone + fog → classic horror game flashlight visible in misty air |

---

## 6. Integration with Existing Systems

### 6.1 Pipeline Pass Ordering

Updated pass order in `GPUForwardPipeline`:

```
1.  ShadowPass              (existing — CSM depth maps)
2.  CloudShadowPass  [NEW]  (compute — 2D cloud shadow map)
3.  SkyPass                 (existing — atmospheric scattering + stars)
4.  CloudRayMarchPass [NEW] (compute — volumetric cloud ray march, half-res)
5.  CloudTemporalPass [NEW] (compute — temporal reprojection)
6.  GroundPass              (existing)
7.  OpaquePass              (existing — terrain, objects; now sample cloud shadow)
8.  SSRPass                 (existing — screen-space reflections for metallic objects)
9.  TransparentPass         (existing — water; now sample cloud shadow)
10. OverlayPass             (existing)
11. SelectionPasses         (existing)
12. DebugPass               (existing)
───── Post-Processing ─────
13. CloudCompositeEffect [NEW] (composite cloud texture into scene color)
14. GodRayEffect [NEW]        (screen-space or froxel-based god rays)
15. AtmosphericFogEffect       (existing, optional — disabled when froxel fog active)
16. SSAOEffect                 (existing, optional)
17. CompositeEffect            (existing — tonemapping + gamma + dither)
```

### 6.2 SceneEnvironment Updates

`SceneEnvironment` (Group 3 bind group shared by all scene shaders) currently occupies **bindings 0–16**:

| Binding | Current Content |
|---------|----------------|
| 0 | Shadow depth texture |
| 1 | Shadow comparison sampler |
| 2 | IBL diffuse cubemap |
| 3 | IBL specular cubemap |
| 4 | BRDF LUT texture |
| 5 | IBL cubemap sampler |
| 6 | IBL LUT sampler |
| 7 | CSM shadow map array (4 cascades) |
| 8 | CSM uniforms buffer |
| 9 | SSR texture |
| 10 | Light counts uniform |
| 11 | Point lights storage |
| 12 | Spot lights storage |
| 13 | Spot shadow atlas (depth 2d-array) |
| 14 | Spot shadow comparison sampler |
| 15 | Cookie atlas (2d-array) |
| 16 | Cookie sampler |

New bindings for clouds:

| Binding | Addition |
|---------|----------|
| **17** | **Cloud shadow map (`r16float`)** |
| **18** | **Cloud shadow uniforms (projection matrix, bounds)** |

The `ENVIRONMENT_BINDINGS` constant in `shared/types.ts` must be extended with `CLOUD_SHADOW_MAP: 17` and `CLOUD_SHADOW_UNIFORMS: 18`. The `ENV_BINDING_MASK.ALL` bitmask must expand from `0x1FFFF` to `0x7FFFF` (19 bindings, 0–18). `PlaceholderTextures` needs a 1×1 `r16float` placeholder for the cloud shadow map and a 64-byte placeholder uniform buffer for cloud shadow uniforms.

Shaders that need cloud shadows (`cdlod.wgsl`, `object-template.wgsl`, `water.wgsl`) add sampling of binding 17/18.

### 6.3 DynamicSkyIBL Updates

When clouds are enabled, the sky IBL cubemap capture should include cloud contribution. Options:

1. **Simple**: Capture sky-only (current behavior). Clouds affect IBL minimally since they're a thin layer.
2. **Accurate**: After cloud ray march, re-capture cubemap including cloud color. Expensive — only on weather change, not every frame.

Recommendation: Start with option 1. Cloud contribution to ambient lighting can be approximated by darkening the ambient intensity based on average cloud coverage.

### 6.4 Weather-Aware Lighting Adaptation

Cloud coverage fundamentally changes how the scene is lit. Under clear skies, the sun provides strong directional light with hard CSM shadows and the sky IBL provides ambient. Under overcast, the sun is nearly fully occluded — the scene flips to almost entirely ambient/diffuse lighting with no visible shadows. The cloud system must feed back into the lighting pipeline to handle this correctly.

#### 6.4.1 Average Cloud Coverage (Per-Frame Metric)

Each frame, compute the **average cloud coverage** across the visible sky. This single value drives all lighting adaptation:

```typescript
// Sample weather map at 16 points within the camera frustum footprint
// Average the R channel (coverage) → single float [0, 1]
averageCoverage = sampleWeatherMapGrid(cameraPosition, frustumRadius, 4×4);
```

This is cheap (~16 texture reads on CPU or a small compute dispatch).

#### 6.4.2 Direct Light Attenuation

The sun's effective intensity is reduced proportionally to coverage. Different cloud types occlude different amounts:

```typescript
// coverageOcclusionStrength: how much coverage reduces direct light
//   Stratus/overcast: 0.95 (thick uniform layer blocks almost all direct light)
//   Cumulus: 0.6 (fluffy clouds let more light through gaps — per-pixel cloud shadow handles the rest)
const occlusionStrength = lerp(0.6, 0.95, 1.0 - cloudType); // 0=stratus, 1=cumulus

sunEffectiveIntensity = sunBaseIntensity * (1.0 - averageCoverage * occlusionStrength);
```

This is passed to all scene shaders via the existing sun intensity uniform. The per-pixel cloud shadow map (§4) still provides local variation — this global attenuation sets the overall mood.

#### 6.4.3 CSM Shadow Fade Under Overcast

Under heavy overcast, the sun is fully diffused by the cloud layer — directional shadows should fade to invisible. Without this, you get the uncanny look of hard shadows under a gray sky:

```wgsl
// In shadow-csm.wgsl (shared shadow sampling):
let shadowVisibility = 1.0 - smoothstep(0.6, 0.9, u.averageCoverage);
let finalShadow = mix(1.0, csmShadowFactor * cloudShadowFactor, shadowVisibility);
```

- Coverage < 60%: Full shadows (clear/partly cloudy)
- Coverage 60–90%: Shadows fade out (transition to overcast)
- Coverage > 90%: No visible shadows (fully overcast / rainy)

The `averageCoverage` uniform is added to the CSM uniform buffer (binding 8) — a single extra float.

#### 6.4.4 IBL Re-Capture Under Clouds

The `DynamicSkyIBL` cubemap captures the Nishita sky scattering. Under clear skies this produces a bright blue dome. Under overcast, the sky should be a gray dome — the IBL must be re-captured with cloud contribution:

**Strategy:**
1. Track `lastIBLCoverage` — the coverage when IBL was last captured
2. When `|averageCoverage - lastIBLCoverage| > 0.1`, queue a re-capture
3. During re-capture, render sky pass **with cloud transmittance overlay**:
   - For each cubemap face direction, ray-march through cloud layer (simplified, 8 steps max)
   - Multiply sky color by cloud transmittance, add cloud scattering
4. Re-capture is amortized: 1 face per frame, 6 frames total (same as existing `DynamicSkyIBL`)

This ensures the IBL correctly shifts from blue → gray as overcast increases, and PBR ambient lighting responds appropriately.

#### 6.4.5 Ambient Boost Under Overcast

Under overcast, real-world ambient light is actually relatively bright (the cloud layer acts as a giant diffuser), while direct light drops. The net effect: ambient proportion increases.

```typescript
// Compensate for lost direct light by boosting ambient
ambientMultiplier = 1.0 + averageCoverage * 0.3;
ambientIntensity = baseAmbientIntensity * ambientMultiplier;
```

This prevents the scene from going too dark under overcast — it should feel flat and diffuse, not dim.

#### 6.4.6 Weather State Summary

| Weather State | Coverage | Direct Light | CSM Shadows | IBL (Ambient) | Net Scene Feel |
|---|---|---|---|---|---|
| **Clear** | 0.0–0.2 | 100% | Full, hard | Bright blue sky | Sunny, high contrast |
| **Partly Cloudy** | 0.2–0.5 | 70–85% | Hard in clear, soft under cloud shadow | Blue sky, slightly dimmed | Patchy sun/shade |
| **Cloudy** | 0.5–0.7 | 40–60% | Fading, soft | Gray-blue mix | Diffuse, low contrast |
| **Overcast** | 0.7–0.95 | 5–20% | Nearly invisible | Gray dome | Flat, uniform lighting |
| **Heavy Overcast / Rain** | 0.95–1.0 | ~2% | None | Dark gray | Dark, moody, no shadows |

### 6.5 Weather Preset System

Weather presets provide coordinated control over all atmospheric parameters. Each preset defines cloud, lighting, fog, and sky settings that work together for a consistent look.

```typescript
interface WeatherPreset {
  name: string;
  // Cloud parameters
  cloudCoverage: number;          // 0–1
  cloudType: number;              // 0=stratus, 0.5=stratocumulus, 1.0=cumulus
  cloudDensity: number;           // extinction coefficient
  cloudBaseAltitude: number;      // meters
  cloudThickness: number;         // meters
  cirrusOpacity: number;          // 0–1
  precipitation: number;          // 0=none, 1=heavy
  // Lighting adaptation
  sunIntensityScale: number;      // multiplier on DirectionalLight intensity
  ambientBoost: number;           // extra ambient under overcast
  shadowVisibility: number;       // 0=no shadows, 1=full shadows
  // Fog parameters
  fogDensity: number;             // height fog density
  fogHeight: number;              // fog base height
  fogVisibility: number;          // visibility distance
  // Wind
  windSpeed: number;              // m/s
  windDirection: number;          // azimuth degrees
}

const WEATHER_PRESETS: Record<string, WeatherPreset> = {
  'Clear':          { cloudCoverage: 0.1,  cloudType: 1.0, sunIntensityScale: 1.0,  shadowVisibility: 1.0,  ambientBoost: 0.0,  cirrusOpacity: 0.1, ... },
  'Partly Cloudy':  { cloudCoverage: 0.4,  cloudType: 0.8, sunIntensityScale: 0.85, shadowVisibility: 0.9,  ambientBoost: 0.1,  cirrusOpacity: 0.2, ... },
  'Cloudy':         { cloudCoverage: 0.65, cloudType: 0.5, sunIntensityScale: 0.5,  shadowVisibility: 0.5,  ambientBoost: 0.15, cirrusOpacity: 0.0, ... },
  'Overcast':       { cloudCoverage: 0.92, cloudType: 0.1, sunIntensityScale: 0.1,  shadowVisibility: 0.05, ambientBoost: 0.3,  cirrusOpacity: 0.0, ... },
  'Rainy':          { cloudCoverage: 1.0,  cloudType: 0.0, sunIntensityScale: 0.05, shadowVisibility: 0.0,  ambientBoost: 0.2,  cirrusOpacity: 0.0, fogDensity: 0.01, precipitation: 0.8, ... },
  'Stormy':         { cloudCoverage: 0.85, cloudType: 0.3, sunIntensityScale: 0.08, shadowVisibility: 0.0,  ambientBoost: 0.15, cirrusOpacity: 0.0, fogDensity: 0.005, precipitation: 1.0, windSpeed: 25, ... },
};
```

Transitions between presets **lerp all parameters** over a configurable duration (default 5–10 seconds) for smooth weather changes. The UI provides a dropdown to select a preset plus individual parameter overrides.

### 6.6 Weather Map ↔ Wind System

The existing `wind.ts` module provides wind direction/speed. The weather map UV offset should be driven by this:

```typescript
// In cloud compute dispatch:
weatherMapOffset.x += windDirection.x * windSpeed * deltaTime * 0.0001;
weatherMapOffset.y += windDirection.z * windSpeed * deltaTime * 0.0001;
```

---

## 7. Performance Budget & Optimization

### 7.1 Target Budget

| Component | Target (ms) | Resolution | Notes |
|-----------|------------|------------|-------|
| Cloud shadow map | 0.05 | 1024² | 2D compute, cheap |
| Cloud ray march | 0.4-0.8 | Half-res, checkerboard | Amortized over 2 frames |
| Temporal reprojection | 0.05 | Half-res | Simple compute |
| Cloud composite | 0.05 | Full-res | Texture sample + blend |
| God rays (screen-space) | 0.1-0.2 | Half-res | 32-64 radial samples |
| **Total** | **0.65-1.15** | | |

### 7.2 Key Optimizations

1. **Temporal reprojection**: March only 50% of pixels per frame (checkerboard). Halves ray-march cost.

2. **Adaptive step size**: Start with 200m steps in empty space, drop to 50m inside clouds. Skip entirely if weather map coverage ≈ 0 at the ray's XZ.

3. **Early ray termination**: Exit when transmittance < 0.01 (cloud is fully opaque from camera's perspective).

4. **Blue noise dithering**: Per-pixel temporal blue noise offsets the ray start position. Combined with temporal accumulation, this produces smooth results from fewer samples.

5. **LOD for light march**: Use only 4-6 samples for the sun-direction light march (self-shadowing). Use exponentially increasing step sizes.

6. **Weather map early-out**: Before ray marching, sample the weather map at the ray's approximate XZ footprint. If coverage = 0, skip the entire ray.

7. **Mipmap noise sampling**: For distant clouds (high step size), sample noise at higher mip levels to avoid aliasing and reduce texture bandwidth.

8. **Half-resolution rendering**: Cloud texture is at 50% resolution. The bilinear upscale is masked by the soft nature of clouds.

9. **Coarse→fine two-pass ray marching**: Instead of a single-pass with adaptive step sizes, use a structured two-pass approach within each ray:
   - **Coarse pass** (Phase 1): March through the cloud shell at large steps (300–500m) using only the weather map coverage check (no 3D noise sampling). This cheaply identifies which intervals along the ray contain cloud plumes and which are empty sky.
   - **Fine pass** (Phase 2): For each interval where the coarse pass found non-zero coverage, march back through that interval at the fine step size (50–80m) with full 3D noise sampling, detail erosion, and lighting.
   - **Benefit**: Rays that pass through long stretches of empty sky between cloud plumes skip them entirely at coarse resolution, saving expensive 3D texture samples. The coarse pass costs ~1 weather map sample per step (cheap 2D texture), while the fine pass concentrates all the expensive 3D noise + light march work only where clouds actually exist.
   - **Implementation**: Store coarse intervals as `(tStart, tEnd)` pairs in a small local array (max 4–8 intervals per ray). The fine pass iterates through these intervals.
   - **Expected savings**: 30–60% reduction in 3D noise samples for partly cloudy scenes where cloud coverage is patchy.

### 7.3 WebGPU-Specific Considerations

- **3D textures**: WebGPU supports `texture_3d<f32>` and `textureStore` on 3D textures in compute shaders. The 128³ shape noise fits in ~8MB VRAM (rgba8unorm).
- **Compute dispatch limits**: WebGPU max workgroup size is 256 invocations. Using `@workgroup_size(8, 8, 1)` = 64 invocations is well within limits.
- **`textureSampleLevel` in compute**: Compute shaders cannot use `textureSample` (requires derivatives). All noise sampling must use `textureSampleLevel` with explicit LOD.
- **Storage texture formats**: WebGPU restricts which formats can be used with `textureStore`. `rgba16float` is supported for storage. `r16float` may require `rgba16float` with unused channels on some implementations.
- **Timestamp queries**: Use `timestamp-query` feature (if available) for GPU profiling of individual compute dispatches during development.

---

## 8. UI Controls

### 8.1 Environment Panel — Cloud Section

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

### 8.2 Rendering Panel — Volumetric Section

Add a collapsible **"Volumetric"** section to `RenderingPanel`:

| Control | Type | Range | Default | Notes |
|---------|------|-------|---------|-------|
| God Rays | Toggle | on/off | off | Enable god ray effect |
| God Ray Intensity | Slider | 0.0–2.0 | 0.5 | Exposure multiplier |
| God Ray Samples | Dropdown | 32/64/128 | 64 | Quality vs performance |
| Temporal Reprojection | Toggle | on/off | on | Cloud temporal filtering |
| Cloud Resolution | Dropdown | Quarter/Half/Full | Half | Ray march resolution |

### 8.3 Debug Visualization

Register cloud textures with the existing `DebugTextureManager`:

| Debug Texture | Contents |
|---------------|----------|
| `cloud-result` | Final cloud color + transmittance (half-res) |
| `cloud-shadow` | Cloud shadow map (top-down transmittance) |
| `weather-map` | Weather map (coverage, type, precip) |
| `cloud-history` | Temporal history buffer |

---

## 9. Implementation Phases

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

6. **Cloud type branching** in density function (§2.2)
   - Height gradient adapts to cloud type (stratus flat slab vs cumulus billowy)
   - Detail erosion strength reduced for stratus/overcast

7. **Direct light attenuation from average coverage** (§6.4.2)
   - Compute average cloud coverage per frame (16-point weather map sample)
   - Scale sun effective intensity by `(1 - coverage × occlusionStrength)`
   - CSM shadow fade under overcast (§6.4.3): shadows lerp toward invisible when coverage > 60%

**Deliverable**: Clouds with self-shadowing, silver linings, shadows on terrain, and weather-aware scene lighting.

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

### Phase 4: God Rays (3–4 days)

**Goal**: Volumetric light shafts through cloud gaps, with both screen-space and froxel-based approaches implemented and togglable.

1. **Screen-space god rays** (`god-rays.wgsl`)
   - Post-process radial blur sampling depth + cloud transmittance
   - `GodRayEffect.ts` extending BaseEffect
   - Sun screen-space projection uniform
   - This serves as the **lightweight fallback** when froxel scattering is disabled

2. **Froxel volumetric scattering** (`froxel-god-rays.wgsl`)
   - Simplified froxel grid (directional light only — point/spot lights deferred to Phase 6)
   - CSM shadow sampling per froxel → automatic god ray shafts from terrain/geometry occlusion
   - Cloud shadow map sampling per froxel → god rays through cloud gaps
   - Front-to-back integration along view rays
   - `FroxelGodRayEffect.ts` extending BaseEffect, applied as post-process
   - This is the **high-quality mode** — produces physically correct volumetric shafts

3. **Integration with clouds**
   - Both modes use cloud transmittance to determine occlusion
   - Fade out when sun below horizon (use existing `sunVisibility`)

4. **UI controls**
   - God Rays enable toggle (master on/off)
   - God Ray Mode dropdown: `Screen-Space` (default) / `Volumetric (Froxel)`
   - Intensity slider, sample count (screen-space only)
   - When `Volumetric` is selected, the screen-space effect is auto-disabled and vice versa
   - Froxel resolution dropdown (Low/Medium/High) for quality vs performance

5. **Fallback behavior**
   - Default: Screen-space mode (cheaper, ~0.1-0.3ms)
   - Volumetric mode: Froxel grid (~0.5-1.5ms, directional light only in this phase)
   - Pipeline auto-switches: `GodRayEffect` enabled XOR `FroxelGodRayEffect` enabled

**Deliverable**: Visible god rays through cloud gaps and terrain features, with UI toggle between screen-space (fast) and froxel volumetric (high quality) modes.

### Phase 5: Weather, Lighting & Polish (3–4 days)

**Goal**: Weather variety, correct lighting adaptation, and production polish.

1. **IBL re-capture trigger under clouds** (§6.4.4 — Option 1: Simple)
   - Trigger `DynamicSkyIBL.forceUpdate()` when average coverage changes by >0.1
   - Re-captures sky-only (Nishita atmospheric scattering) with weather-dimmed sun intensity
   - Result: IBL shifts from bright blue → dimmer/grayer as coverage increases, because the sun intensity input is attenuated by `effectiveSunScale`
   - **Note:** This is the simple approach — clouds are NOT rendered into the cubemap faces. The accurate approach (Option 2: ray-marching through the cloud layer during cubemap capture) is deferred to Phase 6d.

2. **Ambient boost under overcast** (§6.4.5)
   - `ambientMultiplier = 1.0 + coverage × 0.3` — prevents overly dark overcast scenes

3. **Cirrus layer** (§2.2.1)
   - 2D scrolling texture at 8,000–12,000m altitude
   - Alpha-blended fullscreen quad in sky pass, wind-driven
   - Opacity controlled by weather preset

4. **Weather preset system** (§6.5)
   - `WeatherPreset` interface with coordinated cloud/lighting/fog/wind params
   - 6 presets: Clear, Partly Cloudy, Cloudy, Overcast, Rainy, Stormy
   - Smooth lerp transitions (5–10s) between presets
   - UI dropdown in Environment panel + individual overrides

5. **Night sky interaction**
   - Stars visible through cloud gaps (transmittance)
   - Moon illumination of cloud tops
   - Cloud darkening at night (consistent with existing `sunVisibility` system)

6. **Edge cases**
   - Camera inside cloud layer (fog fallback)
   - Extremely low sun angles (grazing cloud illumination)
   - Clear sky (all systems early-out, zero cost)

7. **Serialization** — save/load cloud + weather settings in scene files

**Deliverable**: Complete weather system with overcast/rain support, correct lighting adaptation across all weather states, and production-quality clouds.

### Phase 6: Froxel Volumetric Fog (8–10 days)

**Goal**: Full froxel-based volumetric fog with point/spot light support, replacing `AtmosphericFogEffect` when enabled.

> **Note:** This phase implements the system designed in §5. It leverages the existing `LightBufferManager` (bindings 10–12), spot shadow atlas (bindings 13–14), and `lights.wgsl` structs. No new light infrastructure is needed — only the froxel grid and compute passes are new.

> **Implementation Note (from Phase 4 froxel god rays):** The Phase 4 froxel volumetric scattering system (`FroxelGodRayEffect`) uses physically-based Rayleigh+Mie scattering coefficients which produce correct results at Earth-atmosphere scale (hundreds of km) but are nearly invisible at game scale (meters to few km far plane). Boosting the coefficients to make scattering visible causes excessive extinction that darkens the sky to black (transmittance → 0 across the 64 depth slices spanning 0.1m–2000m). Phase 6 should address this by:
> 1. **Decoupling scattering from extinction** — use a separate, lower extinction coefficient so the medium scatters light without absorbing it excessively (common in game fog systems)
> 2. **Using fog density injection** (§5.4) instead of atmospheric height-based density — the density injection pass provides direct artistic control over fog density per-froxel, independent of physical atmospheric models
> 3. **CSM uniform buffer readback** — the Phase 4 froxel system passes `null` for CSM uniform data because the CSM uniforms live on the GPU and aren't easily readable from CPU. Phase 6 should either maintain a CPU-side copy of CSM uniforms or use a buffer with `MAP_READ` usage
> 4. **Scene-adaptive scattering scale** — scale beta coefficients based on the scene's far plane distance so the effect is visible regardless of scene size

#### Phase 6a: Froxel Grid + Directional Sun Fog (3–4 days)

1. **Froxel grid infrastructure** (`FroxelGrid.ts`)
   - Create 160×90×64 `rgba16float` 3D textures (scatter, integrated, history)
   - Exponential depth slicing utilities (`depthToSlice`, `sliceToDepth`, `sliceThickness`)
   - Resize handling when viewport changes

2. **Density injection compute** (`fog-density-inject.wgsl`)
   - Global height fog (matching `AtmosphericFogEffect` parameters for seamless transition)
   - 3D noise modulation for heterogeneous fog (reuse cloud detail noise texture if available)

3. **Directional light scattering compute** (`froxel-scattering.wgsl`)
   - Sun/moon only (no point/spot lights yet)
   - CSM shadow sampling per froxel → automatic god rays
   - Cloud shadow map sampling (if clouds enabled)

4. **Front-to-back integration compute** (`froxel-integrate.wgsl`)
   - Walk 64 depth slices, accumulate scattering + transmittance
   - Output integrated 3D texture

5. **Post-process application** (`VolumetricFogEffect.ts`)
   - New `BaseEffect` subclass at priority 150 (replaces `AtmosphericFogEffect` when active)
   - Reads depth, reconstructs world position, samples integrated froxel grid
   - `GPUForwardPipeline` auto-disables `AtmosphericFogEffect` when froxel fog is active

**Deliverable**: Height fog + directional god rays from CSM occlusion. Visual parity with `AtmosphericFogEffect` plus volumetric shadow shafts.

#### Phase 6b: Point & Spot Light Injection (2–3 days)

1. **Light-to-froxel culling compute** (`froxel-light-cull.wgsl`)
   - Read existing `PointLightData[]` / `SpotLightData[]` from SceneEnvironment bindings 10–12
   - Compute each light's AABB in froxel space, write to `FroxelLightList` storage buffer

2. **Multi-light scattering** in `froxel-scattering.wgsl`
   - Iterate `FroxelLightList` per froxel, accumulate point/spot in-scattered light
   - Use existing `attenuateDistance()` / `attenuateSpotCone()` from `lights.wgsl`
   - Sample spot shadow atlas (binding 13) via each light's `lightSpaceMatrix`

3. **UI controls** — volumetric fog enable toggle, density sliders in Rendering Panel

**Deliverable**: Point light glow spheres + spot light beams visible in fog. Spot shadow volumetric shafts.

#### Phase 6c: Temporal Reprojection + Local Fog Volumes (2–3 days)

1. **Temporal reprojection** (`froxel-temporal.wgsl`)
   - Reproject previous frame froxels using inverse VP delta
   - 95/5 history blend with validation (out-of-bounds rejection)
   - Ping-pong 3D textures for history

2. **`FogVolumeComponent`** (ECS component)
   - Sphere/box/cylinder shapes with density, falloff, optional color tint
   - GPU buffer of active fog volumes uploaded each frame
   - Density injection pass samples fog volumes

3. **Heterogeneous fog noise**
   - Generate 64³ tileable 3D Perlin/Worley noise texture (or reuse cloud noise)
   - Animate UV offset via Wind system

**Deliverable**: Smooth temporally-stable fog, wispy non-uniform fog, local fog volume emitters.

#### Phase 6d: Integration + Polish (1–2 days)

1. **Cloud shadow integration** in froxel scattering (if cloud system enabled)
2. **Debug textures** — register froxel scatter/integrated grids with `DebugTextureManager`
3. **Performance profiling** — target 1–3ms total for froxel pipeline
4. **Serialization** — save/load volumetric fog settings in scene files
5. **ECS `CloudComponent`** and `VolumetricFogComponent`** on scene entity for settings persistence
6. **Accurate IBL re-capture with cloud transmittance** (§6.4.4 — Option 2)
   - During `DynamicSkyIBL` cubemap face capture, ray-march through the cloud layer (simplified, 8 steps max per direction)
   - Multiply sky color by cloud transmittance, add cloud in-scattering to each cubemap texel
   - Result: IBL cubemap correctly reflects cloud-occluded sky — gray dome under overcast, bright patches where cloud gaps let sunlight through
   - Amortized: 1 face/frame, 6 frames total (same cadence as existing `DynamicSkyIBL`)
   - Only triggered when `|averageCoverage - lastIBLCoverage| > 0.1` (existing trigger in `CloudManager.needsIBLRecapture()`)
   - Requires passing cloud noise textures + weather map to the sky-to-cubemap capture shader, or using a simplified density lookup
   - This upgrades the Phase 5 simple approach (which only dims the sun intensity input) to produce physically accurate cloud-affected ambient lighting

**Deliverable**: Complete froxel volumetric fog integrated with clouds, all light types, scene serialization, and accurate cloud-aware IBL.

---

## 10. File Structure

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
├── volumetric/                        # Froxel volumetric fog system (Phase 6)
│   ├── index.ts                      # Public exports
│   ├── FroxelGrid.ts                 # 3D texture management, depth slicing utilities
│   ├── FogDensityInjector.ts         # Pass 1: density injection compute pipeline
│   ├── FroxelLightCuller.ts          # Light-to-froxel assignment compute pipeline
│   ├── FroxelScatteringPass.ts       # Pass 2: light injection compute (sun + point + spot)
│   ├── FroxelTemporalFilter.ts       # Pass 3: temporal reprojection for froxel grid
│   ├── FroxelIntegrator.ts           # Pass 4: front-to-back ray integration
│   ├── VolumetricFogEffect.ts        # Post-process application (replaces AtmosphericFog)
│   └── types.ts                      # Froxel config, fog volume interfaces
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
│   ├── volumetric/                    # Froxel fog shaders (Phase 6)
│   │   ├── fog-density-inject.wgsl   # Density injection (height fog + noise + volumes)
│   │   ├── froxel-light-cull.wgsl    # Light-to-froxel assignment
│   │   ├── froxel-scattering.wgsl    # Per-froxel light injection (sun + point + spot)
│   │   ├── froxel-temporal.wgsl      # Temporal reprojection for froxel grid
│   │   ├── froxel-integrate.wgsl     # Front-to-back ray integration
│   │   └── volumetric-fog-apply.wgsl # Post-process: sample froxel grid per pixel
│   │
│   └── common/
│       ├── cloud-shadow-sample.wgsl  # Shared include for scene shaders
│       └── phase-functions.wgsl      # Shared: HG, Rayleigh, Cornette-Shanks, isotropic
│
├── postprocess/
│   ├── effects/
│   │   ├── CloudCompositeEffect.ts   # Cloud → scene compositing
│   │   ├── GodRayEffect.ts           # Screen-space god rays
│   │   └── VolumetricFogEffect.ts    # Froxel fog application (Phase 6)
│   └── shaders/
│       ├── cloud-composite.wgsl      # Cloud composite fragment shader
│       ├── god-rays.wgsl             # God ray radial blur shader
│       └── volumetric-fog-apply.wgsl # (symlink/import from volumetric/)
│
├── pipeline/
│   └── passes/
│       ├── CloudShadowPass.ts        # Dispatches cloud shadow compute
│       ├── CloudRayMarchPass.ts      # Dispatches cloud ray march compute
│       └── CloudTemporalPass.ts      # Dispatches temporal reprojection
│
└── renderers/
    └── shared/
        └── SceneEnvironment.ts       # Updated: +cloud shadow bindings (17-18)

src/core/ecs/
├── components/
│   ├── CloudComponent.ts             # Cloud settings on scene entity (coverage, type, etc.)
│   ├── VolumetricFogComponent.ts     # Global froxel fog settings on scene entity
│   └── FogVolumeComponent.ts         # Local fog volume emitter (sphere/box/cylinder)
│
└── systems/
    └── VolumetricFogSystem.ts         # Queries fog volumes, updates FroxelGrid each frame
```

---

## 11. References

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
