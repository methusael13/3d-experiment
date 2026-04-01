# Water Shader Enhancement & Global Distance Field Plan

> Comprehensive plan for upgrading the water rendering system to physically-based FFT ocean waves with IBL-driven coloring, Jacobian-based foam, and a Global Distance Field (GDF) shared across water, volumetric fog, and ambient occlusion.

---

## Table of Contents

1. [Current State Assessment](#1-current-state-assessment)
2. [Part A: Water Shader Enhancement](#2-part-a-water-shader-enhancement)
   - [Phase W1: Physical Water Color & IBL Integration](#phase-w1-physical-water-color--ibl-integration)
   - [Phase W2: FFT Ocean Spectrum (Compute Pipeline)](#phase-w2-fft-ocean-spectrum-compute-pipeline)
   - [Phase W3: Jacobian Foam & Whitecaps](#phase-w3-jacobian-foam--whitecaps)
   - [Phase W4: Wind System Integration](#phase-w4-wind-system-integration)
   - [Phase W5: WaterPanel UI Overhaul](#phase-w5-waterpanel-ui-overhaul)
   - [Phase W6: Projected Grid / Adaptive LOD Mesh](#phase-w6-projected-grid--adaptive-lod-mesh)
3. [Part B: Global Distance Field](#3-part-b-global-distance-field)
   - [Phase G1: Terrain-Only SDF (Single Cascade)](#phase-g1-terrain-only-sdf-single-cascade)
   - [Phase G2: Multi-Cascade + Camera Scrolling](#phase-g2-multi-cascade--camera-scrolling)
   - [Phase G3: Mesh Primitive Stamping](#phase-g3-mesh-primitive-stamping)
   - [Phase G4: Consumer Integration](#phase-g4-consumer-integration)
   - [Phase G5: JFA + Incremental Updates](#phase-g5-jfa--incremental-updates)
4. [Implementation Schedule](#4-implementation-schedule)
5. [File Structure](#5-file-structure)
6. [Config & Type Changes](#6-config--type-changes)

---

## 1. Current State Assessment

### What Works Well

The existing water system is a solid mid-tier implementation:

- **4-wave Gerstner displacement** with analytical binormals/tangents (proper normals from cross product, not finite-difference)
- **Detail normal perturbation** via 3-octave gradient noise, distance-faded
- **Fresnel** with Schlick approximation (`0.02 + 0.98 * smoothstep`)
- **IBL specular cubemap sampling** from `DynamicSkyIBL` via `env_iblSpecular` in Group 3
- **Inline SSR** with binary refinement for screen-space reflections
- **Refraction** via distorted scene color texture with depth-dependent tinting
- **Beer-Lambert subsurface scattering** (`exp(-depth * absorptionCoeff)`)
- **Shore foam** using procedural noise attenuated by water depth
- **Full shadow integration**: single map, CSM with cascade blending, cloud shadows, spot shadows
- **Multi-light support**: point + spot lights with proper attenuation
- **Hot-reloadable shader** via ShaderManager registration
- **CPU-side Gerstner evaluation** (`GerstnerWaves.ts`) for `WetnessSystem` height queries

### Gaps Identified

#### Wave System
| Aspect | Current | Target |
|--------|---------|--------|
| Wave model | 4 hardcoded Gerstner waves | FFT ocean spectrum (Tessendorf/JONSWAP) |
| Wave count | 4 | Thousands (via 256² or 512² FFT) |
| Frequency range | Base × {1.0, 0.6, 0.35, 0.2} | Full spectrum: swell → capillary waves |
| Wind influence | `waveScale` multiplier only | Wind speed, direction, fetch → spectrum shape |
| Calm→Rough | Adjust `waveScale` 0–3 | Beaufort scale → fundamentally different spectra |

#### Coloring & IBL Usage
- **`cheapAtmosphere` fallback** in `sampleIBLReflection()` — duplicates sky model, inconsistent with actual skybox
- **`env_iblDiffuse` never sampled** — bound but unused; subsurface ambient should derive from sky diffuse irradiance
- **`env_brdfLut` never sampled** — water should use split-sum PBR with F0=0.02 (IOR 1.33)
- **Hardcoded `waterColor`/`deepColor`** — not derived from physical absorption coefficients
- **Ad-hoc composition** — `mix(base, reflection, fresnel * 0.4) + fresnel * reflection * 0.3` with magic constants

#### Foam
- Shore foam only (depth-based) — no open-ocean whitecaps
- No wave-folding detection (Jacobian determinant)
- No foam persistence/decay texture
- No object contact foam (requires distance field)

#### Rendering
- `R.y = abs(R.y)` forces all reflections upward — prevents below-horizon reflections
- No BRDF energy conservation
- Fixed 4 wave directions — no wind-driven anisotropy

---

## 2. Part A: Water Shader Enhancement

### Phase W1: Physical Water Color & IBL Integration

**Goal**: Remove artificial color knobs; water color derived from sky + physical absorption.

**Effort**: ~2 days

#### Changes

**`water.wgsl` — Fragment Shader**:

1. **Sample `env_iblDiffuse` for subsurface ambient light**:
```wgsl
// Replace hardcoded ambient with sky-derived diffuse
let skyDiffuse = textureSampleLevel(env_iblDiffuse, env_cubeSampler, vec3f(0.0, 1.0, 0.0), 0.0).rgb;

// Physical absorption coefficients (per meter) — pure water absorbs red first
let absorption = material.absorptionCoeffs.xyz * material.turbidity;
let transmittance = exp(-waterDepthMeters * absorption);

// Water body color = sky light transmitted through water column
let waterBodyColor = skyDiffuse * transmittance + material.scatterTint.rgb * (1.0 - transmittance);
```

2. **Remove `cheapAtmosphere` fallback** — trust IBL always:
```wgsl
fn sampleIBLReflection(reflectDir: vec3f, roughness: f32) -> vec3f {
    let lod = roughness * 6.0;
    return textureSampleLevel(env_iblSpecular, env_cubeSampler, reflectDir, lod).rgb;
}
```

3. **Use BRDF LUT for proper Fresnel integration**:
```wgsl
// Water: F0 = 0.02 (IOR 1.33), roughness ≈ 0.05
let F0 = vec3f(0.02);
let brdf = textureSampleLevel(env_brdfLut, env_lutSampler, vec2f(NdotV, 0.05), 0.0).rg;
let specularScale = F0 * brdf.x + brdf.y;
let reflection = sampleIBLReflection(R, 0.05) * specularScale;
```

4. **Replace ad-hoc composition with energy-conserving blend**:
```wgsl
// Energy conservation: reflected + transmitted = 1
let kS = specularScale; // Fresnel reflectance
let kD = (1.0 - kS) * (1.0 - metallic); // For water, metallic=0

var finalColor = reflection * kS + waterBodyColor * kD;
finalColor += sunSpecular; // Direct sun reflection added separately
```

**`WaterRendererGPU.ts` — Material Buffer**:

Add new material uniforms:
- `absorptionCoeffs: vec4f` — RGB absorption per meter + turbidity
- `scatterTint: vec4f` — RGB scatter color + usePhysicalColor flag

Replace `waterColor`/`deepColor`/`depthFalloff` with these when `usePhysicalColor` is enabled.

**Backward compatibility**: Keep `waterColor`/`deepColor` path behind `usePhysicalColor` toggle (default: on for new scenes, off for loaded scenes missing the new params).

#### Files Modified
- `src/core/gpu/shaders/water.wgsl` — Fragment shader rewrite (color composition)
- `src/core/gpu/renderers/WaterRendererGPU.ts` — Material buffer layout, new config fields
- `src/core/ocean/OceanManager.ts` — Pass through new config

---

### Phase W2: FFT Ocean Spectrum (Compute Pipeline)

**Goal**: Replace 4 Gerstner waves with GPU-computed FFT ocean spectrum.

**Effort**: ~5 days

#### Architecture

```
Per-frame compute pipeline:
  1. Spectrum Generation (once on param change)
     → JONSWAP/Phillips spectrum → H₀(k) texture (complex amplitudes)
  
  2. Spectrum Animation (every frame)  
     → H₀(k) × e^(iωt) → H(k,t) texture (time-evolved)
  
  3. Inverse FFT (every frame)
     → H(k,t) → displacement(x,z) + normal(x,z) textures
     → Butterfly passes: log₂(N) horizontal + log₂(N) vertical
  
  4. Jacobian Computation (every frame, Phase W3)
     → Displacement partial derivatives → fold map for foam
```

#### Compute Shaders

**`src/core/gpu/shaders/ocean/ocean-spectrum.wgsl`** — Initial spectrum generation:
```wgsl
// Generates H₀(k) = 1/√2 * (ξ_r + i·ξ_i) * √(P(k))
// P(k) = JONSWAP spectrum as function of wind speed, direction, fetch
// Output: rgba16float texture (real, imag, conjReal, conjImag)
```

**`src/core/gpu/shaders/ocean/ocean-animate.wgsl`** — Time evolution:
```wgsl
// H(k,t) = H₀(k) * e^(iω(k)t) + conj(H₀(-k)) * e^(-iω(k)t)
// ω(k) = √(g|k|) — deep water dispersion relation
// Also computes Dx(k,t), Dz(k,t) for horizontal displacement (choppiness)
```

**`src/core/gpu/shaders/ocean/fft-butterfly.wgsl`** — FFT butterfly pass:
```wgsl
// Cooley-Tukey butterfly: one pass per bit in log₂(N)
// Operates on 2D complex texture
// Dispatched as compute with horizontal then vertical passes
```

**`src/core/gpu/shaders/ocean/ocean-finalize.wgsl`** — Post-FFT:
```wgsl
// Reads IFFT output, computes:
// - displacement.xyz (vertical + horizontal via choppiness)
// - normal.xyz (from displacement partial derivatives)
// - jacobian scalar (determinant of displacement Jacobian for foam)
// Outputs to displacement map + normal map + jacobian map
```

#### Cascade System

3 FFT cascades covering different wavelength ranges:

| Cascade | Tile Size | FFT Res | Wavelength Range | Purpose |
|---------|-----------|---------|-----------------|---------|
| 0 | 250m | 256² | 1–250m | Primary ocean waves |
| 1 | 37m | 256² | 0.1–37m | Medium detail waves |
| 2 | 5m | 256² | 0.01–5m | Small ripples/capillaries |

The water shader samples all 3 cascades at different UV scales and composites displacement + normals.

#### TypeScript Classes

**`src/core/ocean/FFTOceanSpectrum.ts`**:
```typescript
class FFTOceanSpectrum {
  // Manages spectrum generation, animation, IFFT, finalize
  // Owns all compute pipelines and textures
  // Public API:
  //   update(encoder, time, windSpeed, windDir, fetch, ...)
  //   getDisplacementMap(cascade): GPUTextureView
  //   getNormalMap(cascade): GPUTextureView
  //   getJacobianMap(cascade): GPUTextureView
}
```

**`src/core/ocean/FFTButterflyPass.ts`**:
```typescript
class FFTButterflyPass {
  // Pre-computed butterfly indices/twiddle factors texture
  // Executes log₂(N) * 2 compute dispatches per IFFT
}
```

#### Water Shader Integration

Replace vertex-shader Gerstner displacement with texture-sampled FFT displacement:

```wgsl
// Vertex shader: sample displacement from FFT textures
let uv0 = worldXZ / fftTileSize0;
let uv1 = worldXZ / fftTileSize1;
let uv2 = worldXZ / fftTileSize2;

let disp0 = textureSampleLevel(displacementMap0, sampler, uv0, 0).xyz;
let disp1 = textureSampleLevel(displacementMap1, sampler, uv1, 0).xyz;
let disp2 = textureSampleLevel(displacementMap2, sampler, uv2, 0).xyz;

let totalDisplacement = disp0 + disp1 + disp2;
let worldPos = vec3f(
    worldXZ.x + totalDisplacement.x * choppiness,
    waterLevel + totalDisplacement.y * amplitudeScale,
    worldXZ.y + totalDisplacement.z * choppiness
);
```

Fragment shader: sample pre-computed normals instead of computing from Gerstner derivatives:

```wgsl
let N0 = textureSampleLevel(normalMap0, sampler, uv0, 0).xyz * 2.0 - 1.0;
let N1 = textureSampleLevel(normalMap1, sampler, uv1, 0).xyz * 2.0 - 1.0;
let N2 = textureSampleLevel(normalMap2, sampler, uv2, 0).xyz * 2.0 - 1.0;
let N = normalize(N0 + N1 * 0.5 + N2 * 0.25);
```

#### CPU Height Query Update

`GerstnerWaves.ts` → `OceanHeightQuery.ts`:

The CPU needs to query water height for `WetnessSystem`. Options:
1. **GPU readback** — Read a small region of the displacement map back to CPU (1-frame latency)
2. **CPU FFT** — Run simplified FFT on CPU with reduced resolution (expensive)
3. **Hybrid** — Keep simplified 4-wave Gerstner on CPU for height queries, use FFT only for rendering

**Recommendation**: Option 3 initially (simplest), transition to Option 1 when readback latency is acceptable. The visual mismatch between CPU Gerstner and GPU FFT at the waterline is typically imperceptible.

#### Files Created
- `src/core/ocean/FFTOceanSpectrum.ts`
- `src/core/ocean/FFTButterflyPass.ts`
- `src/core/ocean/OceanHeightQuery.ts`
- `src/core/gpu/shaders/ocean/ocean-spectrum.wgsl`
- `src/core/gpu/shaders/ocean/ocean-animate.wgsl`
- `src/core/gpu/shaders/ocean/fft-butterfly.wgsl`
- `src/core/gpu/shaders/ocean/ocean-finalize.wgsl`

#### Files Modified
- `src/core/gpu/shaders/water.wgsl` — Replace Gerstner with texture sampling
- `src/core/ocean/OceanManager.ts` — Owns FFTOceanSpectrum, drives update
- `src/core/gpu/renderers/WaterRendererGPU.ts` — Bind FFT textures, new uniforms

---

### Phase W3: Jacobian Foam & Whitecaps

**Goal**: Open-ocean whitecaps from wave-folding detection + foam persistence.

**Effort**: ~3 days

#### How It Works

The Jacobian determinant of the horizontal displacement field tells us where waves fold over:

```
J = (1 + ∂Dx/∂x)(1 + ∂Dz/∂z) - (∂Dx/∂z)(∂Dz/∂x)
```

When `J < threshold` (e.g. 0.4), the wave surface has folded — this is where whitecaps form.

#### Foam Persistence Texture

Whitecaps don't appear/disappear instantly — they foam up, then slowly dissipate:

```
foam(t) = max(foam(t-1) * decay, newFoam)
```

This requires a **ping-pong foam texture** updated each frame via compute shader:

**`src/core/gpu/shaders/ocean/foam-persistence.wgsl`**:
```wgsl
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let prevFoam = textureLoad(foamPrev, gid.xy, 0).r;
    let jacobian = textureLoad(jacobianMap, gid.xy, 0).r;
    
    let newFoam = smoothstep(whitecapThreshold, whitecapThreshold - 0.1, jacobian) * whitecapCoverage;
    let decayed = prevFoam * exp(-deltaTime / whitecapDecay);
    
    let foam = max(decayed, newFoam);
    textureStore(foamCurrent, gid.xy, vec4f(foam));
}
```

#### Foam Rendering: Detail Texture vs. Flat Color

The persistence map stores a **scalar foam intensity** (0–1) per FFT texel. If we simply multiply this by a flat `foamColor`, the result looks like a smooth white gradient — not realistic. Real foam has structure: bubbles, streaks, dissolving patches.

**Approach: Multi-layer procedural + optional detail texture**

Three techniques combined, in increasing quality:

**Layer 1 — Procedural noise breakup (always on, free)**

Even without an external texture, we can break up the flat persistence mask using the same `foamNoise()` already in the shader, but sampled at the foam texel's world position with time-scrolling UVs:

```wgsl
// In fragment shader:
let foamUV = worldXZ / fftTileSize0;
let foamIntensity = textureSampleLevel(foamPersistenceMap, sampler, foamUV, 0).r;

// Break up flat foam with multi-octave noise (already exists in shader)
let foamDetail = foamNoise(worldXZ * 0.8, time);      // coarse bubble clusters
let foamFine = foamNoise(worldXZ * 3.0, time * 1.5);  // fine bubble detail

// Threshold noise against foam intensity for organic edges
let foamMask = smoothstep(0.3, 0.7, foamIntensity * (foamDetail * 0.6 + foamFine * 0.4));
```

This is what the current shader effectively does for shore foam — extending it to whitecaps costs zero extra textures.

**Layer 2 — Scrolling foam detail texture (recommended, 1 texture)**

For significantly better quality, use a tileable **foam detail texture** (grayscale, 512×512) that provides realistic bubble patterns. This is the industry standard approach (UE5 Water, Unity HDRP Water, Sea of Thieves):

```wgsl
// Foam detail texture — tileable, scrolls with wave motion  
@group(2) @binding(0) var foamDetailTexture: texture_2d<f32>;

// Sample at two scales with different scroll speeds for parallax effect
let foamUV1 = worldXZ * 0.15 + time * vec2f(0.02, 0.01);  // large bubble clusters
let foamUV2 = worldXZ * 0.4 - time * vec2f(0.015, 0.03);  // fine detail, counter-scroll

let detail1 = textureSample(foamDetailTexture, texSampler, foamUV1).r;
let detail2 = textureSample(foamDetailTexture, texSampler, foamUV2).r;
let foamPattern = detail1 * 0.6 + detail2 * 0.4;

// Use persistence intensity as a threshold — higher intensity reveals more of the pattern
let foamMask = smoothstep(1.0 - foamIntensity, 1.0, foamPattern);
```

The key insight: the **persistence map** controls *where* and *how much* foam exists (driven by Jacobian physics), while the **detail texture** controls *what it looks like* (visual breakup). The persistence intensity acts as a threshold — at low intensity only the brightest parts of the detail texture show through (thin scattered bubbles), at high intensity nearly the entire pattern is visible (dense whitecap coverage).

**Foam detail texture generation**: Can be procedurally generated at startup using a compute shader (Voronoi cells for bubbles + FBM for structure), or loaded from a baked asset. A single 512×512 R8 texture suffices — ~256KB.

**Layer 3 — Foam albedo variation (optional polish)**

Real foam isn't pure white — it has subtle blue/green tinting from subsurface scattering through the bubble layer, and older decaying foam turns slightly translucent:

```wgsl
// Foam color varies with intensity and age
let foamAge = 1.0 - foamIntensity; // lower persistence = older foam
let freshFoamColor = vec3f(0.95, 0.97, 1.0);  // bright white, slight blue
let agedFoamColor = vec3f(0.7, 0.75, 0.8);    // translucent grey-blue

let foamRGB = mix(freshFoamColor, agedFoamColor, foamAge * 0.5);

// Foam also catches light differently — rough diffuse, not specular
let litFoam = foamRGB * sunIntensity * ambientIntensity * max(dot(N, sunDir), 0.3);
```

#### Water Shader Integration (Full Foam Composition)

```wgsl
// In fragment shader — full foam pipeline:
let foamUV = worldXZ / fftTileSize0;
let foamIntensity = textureSampleLevel(foamPersistenceMap, sampler, foamUV, 0).r;

// Detail texture breakup (Layer 2)
let dUV1 = worldXZ * 0.15 + time * vec2f(0.02, 0.01);
let dUV2 = worldXZ * 0.4 - time * vec2f(0.015, 0.03);
let detail = textureSample(foamDetailTexture, texSampler, dUV1).r * 0.6
           + textureSample(foamDetailTexture, texSampler, dUV2).r * 0.4;
let openOceanFoam = smoothstep(1.0 - foamIntensity, 1.0, detail);

// Shore foam (depth-based, existing) — also use detail texture
let shoreFoamRaw = 1.0 - saturate(waterDepthMeters / max(shoreFoamWidth, 0.001));
let shoreFoam = shoreFoamRaw * detail; // breakup shore foam with same texture

// Contact foam (SDF-based, Phase G4)
let sdfDist = sampleSDF(input.worldPosition);
let contactFoamRaw = smoothstep(contactFoamWidth, 0.0, sdfDist);
let contactFoam = contactFoamRaw * detail; // breakup contact foam too

// Combine all foam sources
let totalFoam = max(max(shoreFoam, openOceanFoam), contactFoam);

// Foam color with age variation
let foamAge = 1.0 - foamIntensity;
let foamRGB = mix(foamColor, foamColor * 0.75, foamAge * 0.3);
let litFoam = foamRGB * sunIntensity * ambientIntensity * max(dot(N, sunDir), 0.3);

// Blend foam over water — foam replaces water specular (it's rough diffuse)
finalColor = mix(finalColor, litFoam, totalFoam * 0.85);

// Foam also adds to alpha (foam is opaque even in shallow water)
alpha = max(alpha, totalFoam * 0.9);
```

#### Foam Config Summary

| Config | Purpose | Default |
|--------|---------|---------|
| `foamColor` | Base foam tint (RGB) | (0.95, 0.97, 1.0) |
| `foamDetailTexture` | Tileable bubble pattern (optional, procedural fallback) | Generated at init |
| `foamDetailScale1` | Large cluster UV scale | 0.15 |
| `foamDetailScale2` | Fine detail UV scale | 0.4 |
| `foamScrollSpeed` | Time-based UV scroll rate | 0.02 |
| `whitecapThreshold` | Jacobian fold threshold for open-ocean foam | 0.4 |
| `whitecapCoverage` | How broadly whitecaps spread | 0.5 |
| `whitecapDecay` | Foam persistence decay (seconds) | 1.5 |
| `shoreFoamWidth` | Depth-based shore foam extent (meters) | 3.0 |
| `contactFoamWidth` | SDF-based contact foam radius (meters) | 1.0 |

#### Files Created
- `src/core/ocean/FoamPersistence.ts` — Ping-pong foam texture manager
- `src/core/ocean/FoamDetailGenerator.ts` — Procedural foam detail texture (Voronoi + FBM compute)
- `src/core/gpu/shaders/ocean/foam-persistence.wgsl`
- `src/core/gpu/shaders/ocean/foam-detail-gen.wgsl` — One-time foam texture generation compute

#### Files Modified
- `src/core/gpu/shaders/ocean/ocean-finalize.wgsl` — Output Jacobian map
- `src/core/gpu/shaders/water.wgsl` — Sample foam persistence texture
- `src/core/ocean/OceanManager.ts` — Orchestrate foam update

---

### Phase W4: Wind System Integration

**Goal**: FFT ocean parameters driven by the existing wind system.

**Effort**: ~1 day

#### Integration Points

The `WindSystem` already evaluates global wind via `WindForce`:
- `WindForceParams.direction` → FFT wind direction
- `WindForceParams.strength` → FFT wind speed
- `WindForceParams.turbulence` → Directional spread modulation
- `WindForceParams.gustIntensity` → Temporal spectrum amplitude variation

**`OceanManager.ts`** — Add wind sync:
```typescript
update(encoder, time, deltaTime, windParams?: WindForceParams) {
    if (this.config.windLinked && windParams) {
        this.fftSpectrum.setWindSpeed(windParams.strength);
        this.fftSpectrum.setWindDirection(windParams.direction);
        // Gusts modulate spectrum amplitude temporarily
        this.fftSpectrum.setGustFactor(1.0 + windParams.gustIntensity * 0.3);
    }
    this.fftSpectrum.update(encoder, time);
    this.foamPersistence.update(encoder, deltaTime);
}
```

#### Files Modified
- `src/core/ocean/OceanManager.ts` — Wind parameter forwarding
- `src/core/ocean/FFTOceanSpectrum.ts` — Accept wind params, dirty spectrum on change
- `src/core/gpu/pipeline/GPUForwardPipeline.ts` — Pass wind state to ocean update

---

### Phase W5: WaterPanel UI Overhaul

**Goal**: Update UI to expose FFT ocean controls organized by physical concept.

**Effort**: ~2 days

#### New Panel Sections

```
╔═══════════════════════════════════╗
║ 🌊 Water                          ║
╠═══════════════════════════════════╣
║ ▼ Surface                         ║
║   Water Level        [====|===]   ║
║   Amplitude Scale    [===|====]   ║
║   Choppiness         [===|====]   ║
║   Detail Strength    [===|====]   ║
║                                   ║
║ ▼ Wind & Spectrum                 ║
║   ☑ Link to Global Wind           ║
║   Wind Speed         [===|====]   ║
║   Wind Direction     [===|====]   ║
║   Fetch              [===|====]   ║
║   Spectrum           [JONSWAP ▼]  ║
║   Directional Spread [===|====]   ║
║   Swell Mix          [===|====]   ║
║                                   ║
║ ▼ Physical Appearance             ║
║   ☑ Physical Water Color          ║
║   Turbidity          [===|====]   ║
║   Scatter Tint       [■ color]    ║
║   Opacity            [===|====]   ║
║                                   ║
║ ▼ Foam & Whitecaps               ║
║   Whitecap Threshold [===|====]   ║
║   Whitecap Coverage  [===|====]   ║
║   Whitecap Decay     [===|====]   ║
║   Shore Foam Width   [===|====]   ║
║   Contact Foam Width [===|====]   ║
║   Foam Color         [■ color]    ║
║                                   ║
║ ▸ FFT Quality (collapsed)         ║
║   FFT Resolution     [256 ▼]     ║
║   Cascade Count      [3 ▼]       ║
║   Tile Size          [===|====]   ║
║                                   ║
║ ▸ Grid Placement (collapsed)      ║
╚═══════════════════════════════════╝
```

#### Control Mapping

| Section | Control | Config Key | Type | Range | Default |
|---------|---------|-----------|------|-------|---------|
| Surface | Water Level | `waterLevel` | Slider | -0.5–0.5 | 0.2 |
| Surface | Amplitude Scale | `amplitudeScale` | Slider | 0–3 | 1.0 |
| Surface | Choppiness | `choppiness` | Slider | 0–2 | 1.0 |
| Surface | Detail Strength | `detailStrength` | Slider | 0–1 | 0.3 |
| Wind | Link to Wind | `windLinked` | Checkbox | — | true |
| Wind | Wind Speed | `windSpeed` | Slider | 0–30 m/s | 8 |
| Wind | Wind Direction | `windDirection` | Angle | 0–360° | (from wind) |
| Wind | Fetch | `fetch` | Slider | 100–100,000 m | 10,000 |
| Wind | Spectrum Type | `spectrumType` | Dropdown | phillips/jonswap/pm | jonswap |
| Wind | Dir. Spread | `directionalSpread` | Slider | 1–32 | 8 |
| Wind | Swell Mix | `swellMix` | Slider | 0–1 | 0.3 |
| Appearance | Physical Color | `usePhysicalColor` | Checkbox | — | true |
| Appearance | Turbidity | `turbidity` | Slider | 0–5 | 1.0 |
| Appearance | Scatter Tint | `scatterTint` | Color | RGB | (0.03,0.07,0.17) |
| Appearance | Opacity | `opacity` | Slider | 0.1–1 | 0.92 |
| Foam | Whitecap Threshold | `whitecapThreshold` | Slider | 0–1 | 0.4 |
| Foam | Whitecap Coverage | `whitecapCoverage` | Slider | 0–1 | 0.5 |
| Foam | Whitecap Decay | `whitecapDecay` | Slider | 0.1–5 s | 1.5 |
| Foam | Shore Foam Width | `shoreFoamWidth` | Slider | 0–10 m | 3.0 |
| Foam | Contact Foam Width | `contactFoamWidth` | Slider | 0–5 m | 1.0 |
| Foam | Foam Color | `foamColor` | Color | RGB | (0.9,0.95,1.0) |
| FFT Quality | Resolution | `fftResolution` | Dropdown | 128/256/512 | 256 |
| FFT Quality | Cascades | `fftCascadeCount` | Dropdown | 1/2/3 | 3 |
| FFT Quality | Tile Size | `fftTileSize` | Slider | 50–2000 m | 250 |

#### Files Modified
- `src/demos/sceneBuilder/components/panels/WaterPanel/WaterPanel.tsx` — Full rewrite
- `src/demos/sceneBuilder/components/bridges/WaterPanelBridge.tsx` — New config fields
- `src/core/gpu/renderers/WaterRendererGPU.ts` — `WaterConfig` type expansion

---

### Phase W6: Projected Grid / Adaptive LOD Mesh

**Goal**: Replace the fixed uniform grid with a screen-space projected grid that provides infinite ocean detail near the camera while using far fewer triangles at distance.

**Effort**: ~3 days

#### Problem With Current Grid

The current water mesh is a uniform grid in world space:
```
Grid: gridSizeX/cellSize × gridSizeZ/cellSize quads (e.g. 256×256 = 65K quads)
```

Issues:
- **Near camera**: Vertices are too spread apart — FFT displacement undersampled, wave silhouettes look faceted, Gerstner lateral displacement causes mesh tearing
- **Far from camera**: Vertices are wasted — hundreds of sub-pixel triangles that contribute nothing visually
- **Fixed extent**: Grid has finite boundaries — ocean "ends" at grid edges unless oversized (wasting even more far-field triangles)
- **No horizon**: A 1024m grid at water level doesn't reach the horizon; a 10km grid wastes 99% of triangles

#### Solution: Projected Grid (Johanson 2004)

A **projected grid** starts with a screen-space regular grid and projects it onto the water plane. This naturally places:
- Dense vertices near the camera (where you need FFT detail)
- Sparse vertices at the horizon (where you only need the silhouette)
- Vertices everywhere the camera can see (no grid edges visible)

```
Screen-space grid (uniform)  →  Inverse VP projection  →  Water plane intersection
     ┌─┬─┬─┬─┬─┐                                           ╱    ╲
     ├─┼─┼─┼─┼─┤              project rays                ╱      ╲
     ├─┼─┼─┼─┼─┤              onto y=waterLevel           ╱ dense  ╲
     ├─┼─┼─┼─┼─┤                  ───►                   ╱  near    ╲
     ├─┼─┼─┼─┼─┤                                        ╱   camera   ╲
     └─┴─┴─┴─┴─┘                                       ╱sparse at dist╲
```

#### How It Works

1. **CPU**: Compute a "projector" matrix — an adjusted camera matrix that ensures the projected grid covers the visible water surface, including looking up from below the water level
2. **Vertex Shader**: Each vertex starts as a 2D screen-space coordinate (0–1 range), gets unprojected through the inverse projector matrix to create a ray, then intersected with the `y = waterLevel` plane
3. **Result**: A grid that adapts to any camera angle, reaches to the horizon, and concentrates vertices where they matter

#### Vertex Shader Changes

```wgsl
@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    // input.position is in [0,1] screen space (same mesh as current, but interpreted differently)
    let screenPos = input.position * 2.0 - 1.0; // to [-1, 1] NDC
    
    // Unproject to world-space ray using inverse projector matrix
    let nearPoint = projectorInverse * vec4f(screenPos.x, screenPos.y, 1.0, 1.0); // reversed-Z near
    let farPoint  = projectorInverse * vec4f(screenPos.x, screenPos.y, 0.0, 1.0); // reversed-Z far
    let nearW = nearPoint.xyz / nearPoint.w;
    let farW = farPoint.xyz / farPoint.w;
    
    let ray = normalize(farW - nearW);
    
    // Intersect with water plane y = waterLevel
    let t = (waterLevel - nearW.y) / ray.y;
    
    // Clamp to reasonable range (avoid infinite projection at horizon)
    let maxDist = 50000.0; // 50km — well beyond visible horizon
    let clampedT = clamp(t, 0.0, maxDist);
    
    var worldXZ = nearW.xz + ray.xz * clampedT;
    
    // Now sample FFT displacement at this world position (same as before)
    let disp = sampleFFTDisplacement(worldXZ);
    let worldPos = vec3f(worldXZ.x + disp.x, waterLevel + disp.y, worldXZ.y + disp.z);
    
    // Project back through the actual camera VP for rasterization
    output.clipPosition = viewProjectionMatrix * vec4f(worldPos, 1.0);
    // ...
}
```

#### Projector Matrix Construction

The projector is a modified camera matrix that ensures good grid coverage:

```typescript
class ProjectedGridBuilder {
    /**
     * Compute the projector matrix for a projected ocean grid.
     * 
     * The projector is the camera frustum extended/adjusted so the grid
     * covers all visible water surface including edge cases:
     * - Camera looking down at water
     * - Camera at horizon angle
     * - Camera below water level looking up
     */
    computeProjector(
        camera: { position: vec3; viewMatrix: mat4; projectionMatrix: mat4; fov: number },
        waterLevel: number,
    ): mat4 {
        // 1. Start with camera VP
        // 2. Compute the 8 frustum corners in world space
        // 3. Intersect each with the water plane
        // 4. Find the bounding box of all valid intersections
        // 5. If camera looks above horizon, extend grid to a "horizon line"
        // 6. Build an orthographic or perspective projector that covers this region
        //
        // The key insight: we want the *inverse* of this matrix in the vertex
        // shader to unproject grid vertices to world positions on the water plane.
        
        const vp = mat4.multiply(mat4.create(), camera.projectionMatrix, camera.viewMatrix);
        const ivp = mat4.invert(mat4.create(), vp);
        
        // For a basic implementation, just use the inverse VP directly.
        // Refinements (range clamping, below-water handling) improve edge cases.
        return ivp;
    }
}
```

**Refinement levels**:
1. **Basic**: Use inverse camera VP directly (works 80% of the time)
2. **Intermediate**: Clamp projected grid range to avoid extreme stretching at horizon
3. **Advanced**: Use a separate "projector camera" slightly above the water plane, tilted to optimize vertex distribution (Johanson's method)

#### Grid Resolution

The projected grid doesn't need to be as large as the current world-space grid because vertices are distributed efficiently:

| Grid Size | Quad Count | Visual Quality |
|-----------|-----------|---------------|
| 128×128 | 16K | Good for medium-distance views |
| 256×256 | 65K | High quality, same count as current |
| 512×128 | 65K | Extra horizontal resolution for wide FOV |

A **128×128 projected grid** typically looks better than a **256×256 uniform grid** because the near-camera vertices are 4–8× denser while using 4× fewer total triangles.

#### Edge Cases

1. **Camera below water level**: Flip the projection plane or render a separate underwater grid
2. **Camera looking straight up**: No water visible — skip render entirely (dot(viewDir, waterNormal) check)
3. **Camera at water level**: Grid degenerates at the horizon — clamp maximum projection distance
4. **Grid seams**: The projected grid has no world-space edges, so no visible "end of ocean"

#### Morph Targets for LOD Transitions

For smooth transitions when the camera moves, vertices can morph between LOD positions:

```wgsl
// Optional: smooth LOD morphing to prevent popping
let lodFactor = saturate(distanceToCamera / lodTransitionRange);
let morphedPos = mix(highDetailPos, lowDetailPos, lodFactor);
```

#### Alternative Considered: CDLOD-Style Quadtree Grid

Your terrain uses CDLOD (Continuous Distance-Dependent LOD) with a quadtree. The same approach could work for water:
- Quadtree tiles with 2:1 LOD transitions
- Geomorphing at tile boundaries

However, a **projected grid is simpler and better suited for water** because:
- Water is a flat plane (no heightmap hierarchy to traverse)
- Projected grid adapts to any viewing angle automatically
- No tile boundaries = no T-junction stitching needed
- GPU mesh generation is trivial (uniform grid reinterpreted)

The CDLOD approach is better for terrain because terrain has a static heightmap hierarchy. Water is dynamic — the FFT displacement is applied after grid generation, so the grid just needs good screen-space distribution.

#### Integration With Current System

The projected grid **replaces** the current `createMesh()` in `WaterRendererGPU.ts`:

```typescript
// Current: createMesh(cellsX, cellsZ) — uniform world-space grid
// New: createProjectedGrid(screenResX, screenResZ) — screen-space grid

private createProjectedGrid(resX: number = 256, resZ: number = 256): void {
    // Vertices are in [0,1]² screen space — exactly the same format
    // Only the vertex shader interpretation changes
    // The mesh itself is identical to the current one!
    // This means: zero mesh changes, only shader + uniform changes
}
```

**Key insight**: The mesh data (`position: vec2f` in [0,1] range) is already compatible. The only change is:
1. A new uniform: `projectorInverse: mat4x4f` (replaces `gridCenter`/`gridScale`)
2. Vertex shader: Unproject screen coords → water plane instead of scaling to world coords

This makes Phase W6 a **non-breaking upgrade** — the same mesh structure, same bind group layout, just a different interpretation in the vertex shader.

#### New Config Fields

```typescript
// Added to WaterConfig:
gridMode: 'uniform' | 'projected';    // 'uniform' = current behavior, 'projected' = new
projectedGridResX: number;             // 128–512, default 256
projectedGridResZ: number;             // 128–512, default 256
projectedMaxDistance: number;           // Max projection distance in meters (default: 50000)
```

#### Files Created
- `src/core/ocean/ProjectedGridBuilder.ts` — Projector matrix computation

#### Files Modified
- `src/core/gpu/renderers/WaterRendererGPU.ts` — Add projector matrix uniform, toggle grid mode
- `src/core/gpu/shaders/water.wgsl` — Vertex shader: projected grid path
- `src/core/ocean/OceanManager.ts` — Compute projector each frame from camera

---

## 3. Part B: Global Distance Field

### Overview

A **Cascaded Signed Distance Field** stored as 3D textures, updated incrementally via compute shaders. Provides a continuous distance-to-nearest-surface function consumed by water foam, volumetric fog, and AO.

### Consumers

| Consumer | Current Limitation | GDF Benefit |
|----------|-------------------|-------------|
| **Water contact foam** | Depth-buffer shore foam only | 3D foam wrapping around rocks, piers, any submerged geometry |
| **Volumetric fog** | Fog passes through walls, no terrain hugging | Fog zeroed inside geometry, pools in valleys, hugs surfaces |
| **Ambient occlusion** | SSAO: screen-space only, limited radius | SDF-AO: view-independent, large-scale, no screen-edge artifacts |

### Cascade Layout

| Cascade | Resolution | World Extent | Voxel Size | VRAM | Primary Consumer |
|---------|-----------|-------------|------------|------|------------------|
| 0 (Fine) | 128³ | 64m × 64m × 32m | 0.5m | 4 MB | Water contact foam, near AO |
| 1 (Medium) | 128³ | 256m × 256m × 128m | 2m | 4 MB | SSAO replacement, mid fog |
| 2 (Coarse) | 128³ | 1024m × 1024m × 512m | 8m | 4 MB | Volumetric fog, distant AO |

**Total VRAM**: ~12 MB (3 × 128³ × `r16float`)

---

### Phase G1: Terrain-Only SDF (Single Cascade)

**Goal**: Generate SDF from terrain heightmap → sample in water shader for contact foam.

**Effort**: ~3 days

#### Compute Shaders

**`src/core/gpu/shaders/sdf/sdf-clear.wgsl`**:
```wgsl
// Initialize all voxels to maximum distance
@compute @workgroup_size(8, 8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    if (any(gid >= vec3u(RESOLUTION))) { return; }
    textureStore(sdfTexture, gid, vec4f(MAX_DISTANCE));
}
```

**`src/core/gpu/shaders/sdf/sdf-terrain.wgsl`**:
```wgsl
// For each voxel, compute signed distance to terrain surface
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let worldPos = voxelToWorld(gid);
    
    // Sample terrain height at this XZ
    let terrainUV = worldPosToTerrainUV(worldPos.xz);
    let terrainHeight = textureSampleLevel(heightmap, heightmapSampler, terrainUV, 0.0).r * heightScale;
    
    // Signed distance: positive above terrain, negative below
    let signedDist = worldPos.y - terrainHeight;
    
    // For each Y slice at this XZ, store the distance
    for (var y = 0u; y < RESOLUTION; y++) {
        let voxel = vec3u(gid.x, y, gid.y);
        let vWorldPos = voxelToWorld(voxel);
        let dist = vWorldPos.y - terrainHeight;
        textureStore(sdfTexture, voxel, vec4f(dist));
    }
}
```

#### TypeScript

**`src/core/gpu/sdf/GlobalDistanceField.ts`**:
```typescript
interface SDFCascade {
    texture: GPUTexture;           // r16float 3D storage
    storageView: GPUTextureView;   // write
    sampleView: GPUTextureView;    // read
    center: vec3;                  // world-space center
    extent: vec3;                  // half-extents
    voxelSize: number;
    resolution: number;            // 128
    dirty: boolean;
}

interface SDFConfig {
    cascadeCount: number;           // 1–3
    baseResolution: number;         // 128
    cascadeExtents: vec3[];         // per-cascade half-extents
    updateBudgetMs: number;         // max compute time/frame
    hysteresisDistance: number;     // min camera move before recenter
}

class GlobalDistanceField {
    constructor(ctx: GPUContext, config?: Partial<SDFConfig>);
    
    update(encoder: GPUCommandEncoder, params: {
        cameraPosition: vec3;
        terrainHeightmapView: GPUTextureView;
        terrainHeightScale: number;
        terrainWorldSize: number;
        meshPrimitives?: SDFPrimitive[];  // Phase G3
    }): void;
    
    getCascade(index: number): SDFCascade;
    getSampler(): GPUSampler;
    getBindResources(cascade: number): { texture: GPUTextureView; uniforms: GPUBuffer };
}
```

**`src/core/gpu/sdf/SDFTerrainStamper.ts`**:
```typescript
class SDFTerrainStamper {
    constructor(ctx: GPUContext);
    stamp(encoder: GPUCommandEncoder, cascade: SDFCascade, heightmap: GPUTextureView, heightScale: number): void;
}
```

#### Water Shader Integration (Phase G1 deliverable)

Add SDF sampling to `water.wgsl`:
```wgsl
// New binding for SDF (added to Group 0 or new Group 1)
@group(1) @binding(0) var sdfTexture: texture_3d<f32>;
@group(1) @binding(1) var sdfSampler: sampler;
@group(1) @binding(2) var<uniform> sdfParams: SDFParams;

struct SDFParams {
    center: vec3f,
    _pad0: f32,
    extent: vec3f,
    voxelSize: f32,
}

fn sampleSDF(worldPos: vec3f) -> f32 {
    let uvw = (worldPos - sdfParams.center + sdfParams.extent) / (sdfParams.extent * 2.0);
    if (any(uvw < vec3f(0.0)) || any(uvw > vec3f(1.0))) { return 999.0; }
    return textureSampleLevel(sdfTexture, sdfSampler, uvw, 0.0).r;
}

// In fragment shader — contact foam from SDF:
let sdfDist = sampleSDF(input.worldPosition);
let contactFoam = smoothstep(contactFoamWidth, 0.0, sdfDist);
```

#### Files Created
- `src/core/gpu/sdf/GlobalDistanceField.ts`
- `src/core/gpu/sdf/SDFTerrainStamper.ts`
- `src/core/gpu/sdf/types.ts`
- `src/core/gpu/sdf/index.ts`
- `src/core/gpu/shaders/sdf/sdf-clear.wgsl`
- `src/core/gpu/shaders/sdf/sdf-terrain.wgsl`
- `src/core/gpu/shaders/sdf/sdf-common.wgsl`

#### Files Modified
- `src/core/gpu/shaders/water.wgsl` — Add SDF sampling for contact foam
- `src/core/gpu/renderers/WaterRendererGPU.ts` — Bind SDF resources
- `src/core/gpu/pipeline/GPUForwardPipeline.ts` — Create & update GDF

---

### Phase G2: Multi-Cascade + Camera Scrolling

**Goal**: 3 cascades with camera-following and incremental updates.

**Effort**: ~3 days

#### Camera Scrolling

When the camera moves beyond `hysteresisDistance`, the cascade re-centers:

```typescript
// In GlobalDistanceField.update():
for (const cascade of this.cascades) {
    const offset = vec3.subtract(vec3.create(), cameraPosition, cascade.center);
    const maxDrift = cascade.voxelSize * this.config.hysteresisDistance;
    
    if (vec3.length(offset) > maxDrift) {
        // Snap center to voxel grid
        cascade.center = snapToVoxelGrid(cameraPosition, cascade.voxelSize);
        cascade.dirty = true;
    }
}
```

**Optimization**: Rather than rebuilding the entire cascade, use **texture scrolling** — only compute the newly-revealed voxel slices, shifting existing data via texture copy.

#### Budget System

```typescript
private processUpdateQueue(encoder: GPUCommandEncoder, budgetMs: number): void {
    const startTime = performance.now();
    while (this.updateQueue.length > 0) {
        if (performance.now() - startTime > budgetMs) break;
        const task = this.updateQueue.shift()!;
        this.executeTask(encoder, task);
    }
}
```

Task types:
- `{ type: 'clear', cascade: number }`
- `{ type: 'terrain-slice', cascade: number, sliceAxis: 'x'|'y'|'z', sliceRange: [number, number] }`
- `{ type: 'primitives', cascade: number }` (Phase G3)

---

### Phase G3: Mesh Primitive Stamping

**Goal**: Scene meshes contribute to the SDF as simplified primitives.

**Effort**: ~2 days

#### Primitive Types

Rather than voxelizing full mesh geometry (expensive), approximate each mesh with simple SDF primitives:

```typescript
interface SDFPrimitive {
    type: 'sphere' | 'box' | 'capsule';
    center: vec3;
    extents: vec3;      // radius for sphere, half-extents for box, radius+halfHeight for capsule
    rotation?: quat;    // for oriented boxes
}
```

#### Scene Collection

**`src/core/gpu/sdf/SDFSceneCollector.ts`**:
```typescript
class SDFSceneCollector {
    collect(world: World): SDFPrimitive[] {
        const primitives: SDFPrimitive[] = [];
        
        // Query all entities with BoundsComponent
        for (const entity of world.query('bounds', 'transform')) {
            const bounds = entity.getComponent<BoundsComponent>('bounds');
            const transform = entity.getComponent<TransformComponent>('transform');
            
            if (!bounds.worldBounds) continue;
            
            // Convert AABB to box primitive
            const aabb = bounds.worldBounds;
            primitives.push({
                type: 'box',
                center: aabbCenter(aabb),
                extents: aabbHalfExtents(aabb),
            });
        }
        return primitives;
    }
}
```

#### Compute Shader

**`src/core/gpu/shaders/sdf/sdf-primitives.wgsl`**:
```wgsl
// For each voxel, compute min distance to all primitives
// Uses storage buffer of packed primitive descriptors
@compute @workgroup_size(8, 8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let worldPos = voxelToWorld(gid);
    var minDist = textureLoad(sdfTexture, gid, 0).r; // existing terrain SDF
    
    for (var i = 0u; i < primitiveCount; i++) {
        let prim = primitives[i];
        var dist: f32;
        switch (prim.type) {
            case 0u: { dist = sdfSphere(worldPos, prim.center, prim.extents.x); }
            case 1u: { dist = sdfBox(worldPos, prim.center, prim.extents); }
            case 2u: { dist = sdfCapsule(worldPos, prim.center, prim.extents.xy); }
            default: { dist = 999.0; }
        }
        minDist = min(minDist, dist);
    }
    
    textureStore(sdfTexture, gid, vec4f(minDist));
}
```

#### Files Created
- `src/core/gpu/sdf/SDFSceneCollector.ts`
- `src/core/gpu/sdf/SDFPrimitiveStamper.ts`
- `src/core/gpu/shaders/sdf/sdf-primitives.wgsl`

---

### Phase G4: Consumer Integration

**Goal**: Wire GDF into all 3 consumers.

**Effort**: ~3 days

#### Consumer 1: Water Contact Foam (already done in G1)

Refinement: also use SDF for wave damping near surfaces:
```wgsl
let sdfDist = sampleSDF(input.worldPosition);
let dampFactor = smoothstep(0.0, waveDampRange, sdfDist);
// Reduce wave displacement amplitude near surfaces
let effectiveAmplitude = amplitudeScale * dampFactor;
```

#### Consumer 2: Volumetric Fog

**`fog-density-inject.wgsl`** additions:
```wgsl
// New bindings
@group(0) @binding(3) var sdfTextureCoarse: texture_3d<f32>;
@group(0) @binding(4) var sdfSampler: sampler;
@group(0) @binding(5) var<uniform> sdfFogParams: SDFFogParams;

// In main():
let sdfDist = sampleSDFCoarse(worldPos);

// Prevent fog inside solid geometry
if (sdfDist < 0.0) {
    density = 0.0;
} else {
    // Fog hugging near surfaces (ground fog effect)
    let surfaceProximity = exp(-sdfDist * 2.0);
    density += u.groundFogDensity * surfaceProximity;
    
    // Fog pooling in concavities
    let grad = sdfGradient(worldPos);
    let concavity = 1.0 - max(dot(grad, vec3f(0, 1, 0)), 0.0);
    density *= (1.0 + concavity * u.concavityStrength);
}
```

**`FogDensityInjector.ts`** changes:
- Add SDF texture + sampler + uniform bindings
- New uniforms: `groundFogDensity`, `concavityStrength`

#### Consumer 3: SDF Ambient Occlusion

**New post-process effect**: `SDFAOEffect.ts`

```wgsl
// SDF cone-traced AO — 5 samples along surface normal
fn sdfAO(worldPos: vec3f, normal: vec3f) -> f32 {
    var occlusion = 0.0;
    let steps = 5u;
    for (var i = 1u; i <= steps; i++) {
        let stepDist = f32(i) * aoStepSize;
        let samplePos = worldPos + normal * stepDist;
        
        // Sample appropriate cascade based on distance
        let sdfDist = sampleSDFMultiCascade(samplePos);
        
        // If SDF distance < expected distance, something is occluding
        let expected = stepDist;
        let diff = max(0.0, expected - sdfDist);
        // Weight by 1/distance² for correct falloff
        occlusion += diff / (expected * expected) * (1.0 / f32(steps));
    }
    return saturate(1.0 - occlusion * aoIntensity);
}
```

**Integration approach**: Hybrid SSAO + SDF-AO
- SSAO: handles small-scale creases on mesh surfaces
- SDF-AO: handles large-scale room corners, terrain valleys, overhangs
- Final AO = SSAO * SDF-AO (multiply both terms)

In the PBR shader (`environment.wgsl`):
```wgsl
let ssao = textureLoad(aoTexture, pixelCoord, 0).r;
let sdfAo = sdfAO(worldPos, normal);
let combinedAO = ssao * sdfAo;
// Apply to ambient/diffuse lighting
let ambient = envDiffuse * combinedAO;
```

#### Files Created
- `src/core/gpu/postprocess/effects/SDFAOEffect.ts`
- `src/core/gpu/postprocess/shaders/sdf-ao.wgsl`

#### Files Modified
- `src/core/gpu/shaders/volumetric/fog-density-inject.wgsl` — SDF bindings + density logic
- `src/core/gpu/volumetric/FogDensityInjector.ts` — Bind SDF resources
- `src/core/gpu/shaders/common/environment.wgsl` — Hybrid AO composition
- `src/core/gpu/pipeline/GPUForwardPipeline.ts` — Wire SDF to all consumers

---

### Phase G5: JFA + Incremental Updates

**Goal**: Proper distance propagation and incremental update system.

**Effort**: ~3 days

#### 3D Jump Flood Algorithm

The terrain and primitive stampers provide initial distance seeds, but distances only propagate locally. JFA computes exact Euclidean distances globally:

**`src/core/gpu/shaders/sdf/sdf-jfa.wgsl`**:
```wgsl
// One JFA pass: check 26 neighbors at offset distance
// Run with offset = N/2, N/4, ..., 2, 1 (log₂(N) passes)
@compute @workgroup_size(8, 8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let currentDist = textureLoad(sdfTexture, gid, 0).r;
    var bestDist = currentDist;
    
    let offset = i32(jfaUniforms.offset);
    for (var dz = -1; dz <= 1; dz++) {
        for (var dy = -1; dy <= 1; dy++) {
            for (var dx = -1; dx <= 1; dx++) {
                if (dx == 0 && dy == 0 && dz == 0) { continue; }
                let neighbor = vec3i(gid) + vec3i(dx, dy, dz) * offset;
                if (any(neighbor < vec3i(0)) || any(neighbor >= vec3i(RESOLUTION))) { continue; }
                
                let neighborDist = textureLoad(sdfTexture, vec3u(neighbor), 0).r;
                let stepDist = length(vec3f(f32(dx), f32(dy), f32(dz)) * f32(offset)) * voxelSize;
                let totalDist = neighborDist + stepDist;
                
                if (abs(totalDist) < abs(bestDist)) {
                    bestDist = totalDist;
                }
            }
        }
    }
    
    textureStore(sdfOutput, gid, vec4f(bestDist));
}
```

For 128³: 7 JFA passes (offsets: 64, 32, 16, 8, 4, 2, 1).

Uses ping-pong between two 3D textures per cascade.

#### Incremental Region Updates

Track dirty voxel regions via spatial hash:
```typescript
class DirtyRegionTracker {
    private dirtyRegions: Set<string> = new Set(); // "cascade:x:y:z" at chunk granularity
    
    markDirty(cascade: number, worldMin: vec3, worldMax: vec3): void;
    consumeDirtyRegions(cascade: number, maxRegions: number): DirtyRegion[];
}
```

Only re-stamp and JFA-propagate dirty regions, not the entire cascade.

#### Files Created
- `src/core/gpu/sdf/SDFJumpFlood.ts`
- `src/core/gpu/sdf/DirtyRegionTracker.ts`
- `src/core/gpu/shaders/sdf/sdf-jfa.wgsl`

---

## 4. Implementation Schedule

### Phase Dependencies

```
W1 ─────────────────────────────────────────────── (standalone)
W2 ───────── W3 ──── W4 ──── W5 ──── W6           (sequential)
G1 ──── G2 ──── G3 ──── G4 ──── G5                (sequential)
                        │
         W3 ←──── G1 ──┘  (foam uses SDF from G1)
         W5 ←──── G4       (UI exposes contact foam from G4)
         W6 ←──── W2       (projected grid needs FFT texture sampling)
```

### Suggested Order

| Week | Phase | Description | Depends On |
|------|-------|-------------|-----------|
| 1 | **W1** | Physical water color + IBL | — |
| 1–2 | **G1** | Terrain SDF + water contact foam | — |
| 2–3 | **W2** | FFT ocean spectrum compute pipeline | W1 |
| 3 | **G2** | Multi-cascade + camera scrolling | G1 |
| 3–4 | **W3** | Jacobian foam + whitecaps | W2 + G1 |
| 4 | **G3** | Mesh primitive stamping | G2 |
| 4 | **W4** | Wind system integration | W2 |
| 5 | **G4** | Fog + AO consumer integration | G3 |
| 5 | **W5** | WaterPanel UI overhaul | W4 + G4 |
| 5–6 | **W6** | Projected grid / adaptive LOD mesh | W2 |
| 6 | **G5** | JFA + incremental updates | G4 |

**Total estimated effort**: ~6–7 weeks

### Quick Wins (can be done anytime)

These are low-effort improvements independent of the main phases:

1. **Remove `cheapAtmosphere` fallback** — 15 min, immediate visual consistency
2. **Sample `env_iblDiffuse` for ambient** — 30 min, water matches sky
3. **Remove `R.y = abs(R.y)` hack** — 5 min, better with SSR handling below-horizon
4. **Use BRDF LUT for Fresnel** — 1 hour, proper energy conservation

---

## 5. File Structure

### New Files (Water)

```
src/core/ocean/
├── OceanManager.ts                 (MODIFY — orchestrates FFT + foam)
├── GerstnerWaves.ts                (KEEP — CPU fallback for height queries)
├── OceanHeightQuery.ts             (NEW — unified height query API)
├── FFTOceanSpectrum.ts             (NEW — spectrum gen + animation + IFFT)
├── FFTButterflyPass.ts             (NEW — reusable FFT butterfly compute)
├── FoamPersistence.ts              (NEW — ping-pong foam decay texture)
├── ProjectedGridBuilder.ts         (NEW — projector matrix for screen-space grid)
└── index.ts                        (MODIFY)

src/core/gpu/shaders/ocean/
├── ocean-spectrum.wgsl             (NEW — JONSWAP/Phillips H₀(k))
├── ocean-animate.wgsl              (NEW — H₀ × e^(iωt))
├── fft-butterfly.wgsl              (NEW — Cooley-Tukey butterfly)
├── ocean-finalize.wgsl             (NEW — displacement/normal/Jacobian output)
└── foam-persistence.wgsl           (NEW — foam decay compute)
```

### New Files (GDF)

```
src/core/gpu/sdf/
├── GlobalDistanceField.ts          (NEW — cascade manager)
├── SDFTerrainStamper.ts            (NEW — heightmap → SDF)
├── SDFPrimitiveStamper.ts          (NEW — mesh AABB → SDF)
├── SDFSceneCollector.ts            (NEW — ECS → primitive list)
├── SDFJumpFlood.ts                 (NEW — 3D JFA compute)
├── DirtyRegionTracker.ts           (NEW — incremental updates)
├── types.ts                        (NEW)
└── index.ts                        (NEW)

src/core/gpu/shaders/sdf/
├── sdf-common.wgsl                 (NEW — shared sampling functions)
├── sdf-clear.wgsl                  (NEW)
├── sdf-terrain.wgsl                (NEW)
├── sdf-primitives.wgsl             (NEW)
└── sdf-jfa.wgsl                    (NEW)

src/core/gpu/postprocess/
├── effects/SDFAOEffect.ts          (NEW)
└── shaders/sdf-ao.wgsl             (NEW)
```

### Modified Files

```
src/core/gpu/shaders/water.wgsl                  — Major rewrite (FFT sampling, physical color, SDF foam)
src/core/gpu/renderers/WaterRendererGPU.ts        — New config, FFT texture bindings, SDF bindings
src/core/gpu/pipeline/GPUForwardPipeline.ts       — GDF update, FFT update, consumer wiring
src/core/gpu/shaders/volumetric/fog-density-inject.wgsl — SDF sampling for geometry-aware fog
src/core/gpu/volumetric/FogDensityInjector.ts     — SDF bind group additions
src/core/gpu/shaders/common/environment.wgsl      — Hybrid AO (SSAO × SDF-AO)
src/core/ocean/OceanManager.ts                     — FFT orchestration, wind sync
src/core/Engine.ts                                 — GDF lifecycle
src/demos/sceneBuilder/components/panels/WaterPanel/WaterPanel.tsx   — Full UI rewrite
src/demos/sceneBuilder/components/bridges/WaterPanelBridge.tsx       — New config fields
```

---

## 6. Config & Type Changes

### WaterConfig (Complete New Definition)

```typescript
export interface WaterConfig {
  // === Surface ===
  waterLevel: number;              // -0.5 to 0.5 (normalized, scaled by heightScale)
  amplitudeScale: number;          // 0–3, global FFT displacement multiplier
  choppiness: number;              // 0–2, horizontal displacement strength
  detailStrength: number;          // 0–1, high-frequency normal detail layer
  opacity: number;                 // 0.1–1, base alpha
  refractionStrength: number;      // 0–1.5, underwater distortion
  
  // === Wind & Spectrum ===
  windLinked: boolean;             // auto-sync with global wind system
  windSpeed: number;               // 0–30 m/s
  windDirection: [number, number]; // normalized [x, z]
  fetch: number;                   // 100–100,000 meters (calm lake → open ocean)
  spectrumType: 'phillips' | 'jonswap' | 'pierson-moskowitz';
  directionalSpread: number;       // 1–32 (narrow → broad spread)
  swellMix: number;                // 0–1, distant swell contribution
  swellDirection: [number, number];
  swellWavelength: number;         // 50–500m
  
  // === Physical Appearance ===
  usePhysicalColor: boolean;       // true = absorption model, false = manual colors
  absorptionCoeffs: [number, number, number]; // per-meter (R=0.45, G=0.064, B=0.0145 for pure water)
  turbidity: number;               // 0–5, absorption multiplier (1=clear, 5=muddy)
  scatterTint: [number, number, number]; // suspended particle color
  // Legacy (used when usePhysicalColor = false):
  waterColor: [number, number, number];
  deepColor: [number, number, number];
  depthFalloff: number;
  
  // === Foam & Whitecaps ===
  foamColor: [number, number, number];
  whitecapThreshold: number;       // 0–1, Jacobian fold threshold
  whitecapCoverage: number;        // 0–1, foam spread around folds
  whitecapDecay: number;           // 0.1–5 seconds, foam persistence
  shoreFoamWidth: number;          // 0–10 meters, depth-based shore foam
  contactFoamWidth: number;        // 0–5 meters, SDF-based contact foam
  
  // === FFT Quality ===
  fftResolution: 128 | 256 | 512;
  fftCascadeCount: 1 | 2 | 3;
  fftTileSize: number;             // 50–2000 meters, physical tile size
  
  // === Grid / Mesh ===
  gridMode: 'uniform' | 'projected'; // 'uniform' = world-space grid, 'projected' = screen-space
  gridCenterX: number;             // uniform mode only
  gridCenterZ: number;             // uniform mode only
  gridSizeX: number;               // uniform mode only
  gridSizeZ: number;               // uniform mode only
  cellSize: number;                // uniform mode only
  projectedGridResX: number;       // projected mode: 128–512, default 256
  projectedGridResZ: number;       // projected mode: 128–512, default 256
  projectedMaxDistance: number;     // projected mode: max projection meters (default: 50000)
  
  // === Lighting (kept from current) ===
  fresnelPower: number;            // For fallback/artistic override
  specularPower: number;
}
```

### SDFConfig

```typescript
export interface SDFConfig {
  enabled: boolean;
  cascadeCount: 1 | 2 | 3;
  baseResolution: 64 | 128 | 256;
  cascadeExtents: Array<{
    halfWidth: number;              // X half-extent in world units
    halfHeight: number;             // Y half-extent
    halfDepth: number;              // Z half-extent
  }>;
  updateBudgetMs: number;           // max compute time per frame
  hysteresisDistance: number;        // voxels of camera drift before recenter
  enableTerrainStamping: boolean;
  enableMeshStamping: boolean;
  enableJFA: boolean;
}
```

### Performance Budget (Estimated)

| System | Per-Frame Cost |
|--------|---------------|
| FFT spectrum animate (256² × 3 cascades) | ~0.3 ms |
| FFT butterfly (8 passes × 3 cascades × 3 textures) | ~1.2 ms |
| FFT finalize (256² × 3 cascades) | ~0.2 ms |
| Foam persistence (256² ping-pong) | ~0.1 ms |
| **Total FFT ocean** | **~1.8 ms** |
| SDF clear (128³ × dirty regions) | ~0.1 ms |
| SDF terrain stamp (128² × dirty slices) | ~0.3 ms |
| SDF primitive stamp (per dirty cascade) | ~0.2 ms |
| SDF JFA (7 passes × dirty cascades) | ~1.0 ms |
| **Total GDF (worst case)** | **~1.6 ms** |
| SDF-AO post-process | ~0.3 ms |
| Water SDF sampling (per-pixel fetch) | ~0.05 ms |
| Fog SDF sampling (per-froxel fetch) | ~0.1 ms |
| **Total runtime sampling** | **~0.45 ms** |

**Grand total worst case**: ~3.85 ms additional GPU time. In practice, the SDF is mostly idle after initial build (static scenes), and the FFT is constant cost but replaces the vertex-shader Gerstner computation.
