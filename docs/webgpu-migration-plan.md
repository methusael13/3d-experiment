# WebGPU Migration Plan

## Executive Summary

This document outlines the complete migration of the 3D engine from WebGL2 to WebGPU. The primary driver is enabling compute shaders for CDLOD terrain generation (noise + erosion), but we're taking this opportunity to modernize the entire rendering pipeline.

**Goal**: Full WebGPU implementation with no WebGL2 fallback  
**Primary Feature**: CDLOD terrain with GPU-based procedural generation  
**Approach**: Progressive migration with verification at each phase

---

## Current Architecture (WebGL2)

### Rendering Pipeline

```
ForwardPipeline (src/core/renderers/pipeline/ForwardPipeline.ts)
├── ShadowPass          → ShadowRenderer, TerrainShadowRenderer
├── DepthPrePass        → DepthPrePassRenderer
├── SkyPass             → SkyRenderer (atmospheric scattering / HDR)
├── OpaquePass          → TerrainRenderer, CDLODRenderer, ObjectRenderer (via external renderers)
├── ContactShadowPass   → ContactShadowRenderer
└── OverlayPass         → GridRenderer, OriginMarkerRenderer
```

### Renderer Files (12 total)

| File | Purpose | Complexity | Priority |
|------|---------|------------|----------|
| `CDLODRenderer.ts` | CDLOD terrain LOD | High | **1** (primary goal) |
| `TerrainRenderer.ts` | Static/clipmap terrain | High | 2 |
| `ObjectRenderer.ts` | GLB/PBR models | High | 3 |
| `ShadowRenderer.ts` | Directional shadows | Medium | 4 |
| `SkyRenderer.ts` | Atmosphere/HDR sky | Medium | 5 |
| `GridRenderer.ts` | Debug grid/axes | Low | 6 |
| `ContactShadowRenderer.ts` | Screen-space shadows | Medium | 7 |
| `DepthPrePassRenderer.ts` | Depth buffer | Low | 8 |
| `OriginMarkerRenderer.ts` | Scene origin | Low | 9 |
| `PrimitiveRenderer.ts` | Basic shapes | Low | 10 |
| `ClipmapGeometry.ts` | Ring mesh generation | Low | 11 |
| `TerrainShadowRenderer.ts` | Terrain in shadow pass | Medium | 12 |

### Shader Chunks (src/demos/sceneBuilder/shaderChunks.ts)

- `windComplete` - Wind vertex animation
- `shadowUniforms`, `shadowFunctions` - Shadow mapping
- `hdrUniforms` - HDR environment
- `lightingUniforms` - Light parameters
- `pbrFunctions` - PBR material calculations
- `iblFunctions` - Image-based lighting
- `pbrLighting` - Combined PBR lighting
- `terrainBlendComplete` - Terrain/object blending
- `toneMappingComplete` - Tone mapping operators

---

## Target Architecture (WebGPU)

### Directory Structure

```
src/core/gpu/
├── GPUContext.ts           # Device, adapter, queue, canvas context
├── GPUBuffer.ts            # Buffer abstraction (vertex, index, uniform, storage)
├── GPUTexture.ts           # Texture and sampler management
├── GPURenderPipeline.ts    # Render pipeline wrapper
├── GPUComputePipeline.ts   # Compute pipeline wrapper  
├── GPUBindGroup.ts         # Bind group and layout utilities
├── GPUShaderModule.ts      # WGSL shader compilation
├── types.ts                # TypeScript interfaces
└── index.ts                # Public exports

src/core/gpu/shaders/       # WGSL shader files
├── common/
│   ├── uniforms.wgsl       # Shared uniform structures
│   ├── pbr.wgsl            # PBR functions
│   ├── shadow.wgsl         # Shadow mapping
│   └── tonemap.wgsl        # Tone mapping
├── terrain/
│   ├── cdlod.wgsl          # CDLOD vertex/fragment
│   ├── noise.wgsl          # Compute: fBm noise generation
│   ├── thermal.wgsl        # Compute: Thermal erosion
│   └── hydraulic.wgsl      # Compute: Hydraulic erosion
├── object.wgsl             # Object PBR shader
├── sky.wgsl                # Sky rendering
├── shadow.wgsl             # Shadow map generation
└── grid.wgsl               # Debug grid
```

### Core Classes

#### GPUContext
```typescript
class GPUContext {
  private static instance: GPUContext | null = null;
  
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
  readonly queue: GPUQueue;
  readonly canvasFormat: GPUTextureFormat;
  readonly context: GPUCanvasContext;
  
  static async create(canvas: HTMLCanvasElement): Promise<GPUContext>;
  static get(): GPUContext;
  
  // Frame management
  getCurrentTexture(): GPUTexture;
  beginFrame(): GPUCommandEncoder;
  submitFrame(encoder: GPUCommandEncoder): void;
  
  // Resource creation shortcuts
  createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer;
  createTexture(descriptor: GPUTextureDescriptor): GPUTexture;
  createShaderModule(code: string): GPUShaderModule;
}
```

#### GPUBuffer
```typescript
class GPUBuffer {
  readonly buffer: GPUBuffer;
  readonly size: number;
  readonly usage: GPUBufferUsageFlags;
  
  static createVertex(ctx: GPUContext, data: Float32Array): GPUBuffer;
  static createIndex(ctx: GPUContext, data: Uint16Array | Uint32Array): GPUBuffer;
  static createUniform(ctx: GPUContext, size: number): GPUBuffer;
  static createStorage(ctx: GPUContext, size: number): GPUBuffer;
  
  write(data: BufferSource, offset?: number): void;
  read(): Promise<ArrayBuffer>;
  destroy(): void;
}
```

#### GPUTexture
```typescript
class GPUTextureWrapper {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly sampler: GPUSampler;
  
  static create2D(ctx: GPUContext, width: number, height: number, format: GPUTextureFormat): GPUTextureWrapper;
  static createFromImage(ctx: GPUContext, image: ImageBitmap): GPUTextureWrapper;
  static createDepth(ctx: GPUContext, width: number, height: number): GPUTextureWrapper;
  static createStorage2D(ctx: GPUContext, width: number, height: number, format: GPUTextureFormat): GPUTextureWrapper;
  
  destroy(): void;
}
```

---

## GLSL → WGSL Translation Guide

### Key Differences

| Feature | GLSL 300 ES | WGSL |
|---------|-------------|------|
| **Entry Point** | `void main()` | `@vertex fn vs_main()` / `@fragment fn fs_main()` |
| **Attributes** | `in vec3 aPos` | `@location(0) pos: vec3f` |
| **Varyings** | `out/in vec3 vPos` | Struct with `@location` |
| **Uniforms** | `uniform mat4 uMVP` | `@group(0) @binding(0) var<uniform> uniforms: Uniforms` |
| **UBOs** | `uniform Block { ... }` | `struct Uniforms { ... }` |
| **Samplers** | `uniform sampler2D tex` | `var tex: texture_2d<f32>` + `var samp: sampler` |
| **Sample** | `texture(tex, uv)` | `textureSample(tex, samp, uv)` |
| **Output** | `out vec4 fragColor` | `@location(0) -> vec4f` |
| **Types** | `vec3`, `mat4` | `vec3f`, `mat4x4f` |
| **Swizzle** | `.xyz`, `.rgb` | Same |
| **Intrinsics** | `mix`, `clamp`, etc. | Same |
| **Storage** | N/A | `var<storage, read_write>` |
| **Compute** | N/A | `@compute @workgroup_size(8,8,1)` |

### Example: Vertex Shader

**GLSL:**
```glsl
#version 300 es
precision highp float;

in vec3 aPosition;
in vec2 aTexCoord;

uniform mat4 uModelViewProjection;
uniform mat4 uModel;

out vec2 vTexCoord;
out vec3 vWorldPos;

void main() {
  vec4 worldPos = uModel * vec4(aPosition, 1.0);
  gl_Position = uModelViewProjection * vec4(aPosition, 1.0);
  vTexCoord = aTexCoord;
  vWorldPos = worldPos.xyz;
}
```

**WGSL:**
```wgsl
struct Uniforms {
  modelViewProjection: mat4x4f,
  model: mat4x4f,
}

struct VertexInput {
  @location(0) position: vec3f,
  @location(1) texCoord: vec2f,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) texCoord: vec2f,
  @location(1) worldPos: vec3f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = uniforms.model * vec4f(input.position, 1.0);
  output.position = uniforms.modelViewProjection * vec4f(input.position, 1.0);
  output.texCoord = input.texCoord;
  output.worldPos = worldPos.xyz;
  return output;
}
```

### Example: Compute Shader (Terrain Noise)

```wgsl
struct NoiseParams {
  octaves: u32,
  frequency: f32,
  persistence: f32,
  lacunarity: f32,
  heightScale: f32,
  worldSize: f32,
  resolution: u32,
  seed: u32,
}

@group(0) @binding(0) var<uniform> params: NoiseParams;
@group(0) @binding(1) var<storage, read_write> heightmap: array<f32>;

// Simplex noise implementation
fn simplex2d(v: vec2f) -> f32 {
  // ... noise implementation
}

fn fbm(p: vec2f) -> f32 {
  var value: f32 = 0.0;
  var amplitude: f32 = 1.0;
  var frequency: f32 = params.frequency;
  
  for (var i: u32 = 0u; i < params.octaves; i++) {
    value += amplitude * simplex2d(p * frequency);
    amplitude *= params.persistence;
    frequency *= params.lacunarity;
  }
  
  return value * params.heightScale;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let x = id.x;
  let y = id.y;
  
  if (x >= params.resolution || y >= params.resolution) {
    return;
  }
  
  let worldX = (f32(x) / f32(params.resolution - 1u)) * params.worldSize - params.worldSize * 0.5;
  let worldZ = (f32(y) / f32(params.resolution - 1u)) * params.worldSize - params.worldSize * 0.5;
  
  let height = fbm(vec2f(worldX, worldZ));
  
  let index = y * params.resolution + x;
  heightmap[index] = height;
}
```

---

## Implementation Phases

### Phase 2A: WebGPU Foundation (Current)

**Files to create:**
1. `src/core/gpu/GPUContext.ts`
2. `src/core/gpu/GPUBuffer.ts`
3. `src/core/gpu/GPUTexture.ts`
4. `src/core/gpu/types.ts`
5. `src/core/gpu/index.ts`

**Verification:**
- [ ] `GPUContext.create()` successfully initializes WebGPU device
- [ ] Console logs adapter info and limits
- [ ] Buffer creation works
- [ ] Texture creation works

### Phase 2B: Minimal Pipeline

**Goal:** Render a solid color triangle to verify pipeline works

**Files to create:**
1. `src/core/gpu/GPURenderPipeline.ts`
2. `src/core/gpu/GPUShaderModule.ts`
3. `src/core/gpu/shaders/test-triangle.wgsl`

**Verification:**
- [ ] Triangle renders on screen
- [ ] No WebGPU validation errors in console

### Phase 2C: CDLOD Terrain (Primary Goal)

**Step 1: CDLOD Render Pipeline**
- Create `src/core/gpu/renderers/CDLODRendererGPU.ts`
- Create `src/core/gpu/shaders/terrain/cdlod.wgsl`
- Use sine-wave heightmap (same as current test)

**Step 2: Terrain Compute Shaders**
- Create `src/core/gpu/shaders/terrain/noise.wgsl` - fBm noise generation
- Create `src/core/gpu/shaders/terrain/thermal.wgsl` - Thermal erosion
- Create `src/core/gpu/shaders/terrain/hydraulic.wgsl` - Hydraulic erosion
- Create `src/core/gpu/compute/TerrainGenerator.ts` - Compute pipeline orchestration

**Step 3: Integration**
- Generate heightmap via compute shader
- Use as texture in CDLOD vertex shader
- Match output quality with current CPU erosion

**Verification:**
- [ ] Sine-wave terrain renders with LOD transitions
- [ ] Compute-generated terrain matches CPU quality
- [ ] Performance improvement measured

### Phase 2D: Supporting Renderers

**Grid & Sky:**
- `src/core/gpu/renderers/GridRendererGPU.ts`
- `src/core/gpu/renderers/SkyRendererGPU.ts`
- `src/core/gpu/shaders/grid.wgsl`
- `src/core/gpu/shaders/sky.wgsl`

**Verification:**
- [ ] Grid renders correctly
- [ ] Atmospheric scattering sky works
- [ ] HDR skybox works

### Phase 2E: Object Renderer

**Files:**
- `src/core/gpu/renderers/ObjectRendererGPU.ts`
- `src/core/gpu/shaders/object.wgsl`
- `src/core/gpu/shaders/common/pbr.wgsl`

**Features to port:**
- [ ] PBR lighting (metallic-roughness workflow)
- [ ] Normal mapping
- [ ] Emissive
- [ ] Wind animation
- [ ] Terrain blending

### Phase 2F: Shadows & Post-Effects

**Shadows:**
- `src/core/gpu/renderers/ShadowRendererGPU.ts`
- Shadow map generation
- PCF filtering

**Contact Shadows:**
- Screen-space ray marching

**Depth Pre-Pass:**
- For terrain blend and contact shadows

### Phase 2G: Pipeline Integration & Switchover

1. Create `src/core/gpu/pipeline/GPUForwardPipeline.ts`
2. Update `Viewport.ts` to use WebGPU context
3. Remove WebGL2 code
4. Final testing of all features

---

## Risk Mitigation

### Browser Compatibility
- WebGPU is available in Chrome 113+, Edge 113+, Safari 17.4+
- No Firefox support yet (behind flag)
- **Decision:** Target Chrome/Edge/Safari, document Firefox limitation

### Performance Regression
- Keep CPU terrain generation code until GPU version matches quality
- Benchmark both paths before removing old code

### Shader Complexity
- WGSL is more verbose than GLSL
- Create reusable shader modules to avoid duplication
- Consider shader preprocessor or includes

### Debugging
- Use `@webgpu/types` for TypeScript support
- Enable WebGPU DevTools in Chrome
- Add validation layers in development mode

---

## Checklist Summary

### Phase 2A: Foundation
- [x] `GPUContext.ts` - Device initialization
- [x] `GPUBuffer.ts` - Buffer abstraction
- [x] `GPUTexture.ts` - Texture abstraction
- [x] `types.ts` - TypeScript interfaces
- [x] `index.ts` - Exports
- [ ] Verification: Device initializes, logs adapter info

### Phase 2B: Minimal Pipeline
- [x] `GPURenderPipeline.ts`
- [x] `GPUShaderModule.ts`
- [x] `test-triangle.wgsl`
- [ ] Verification: Triangle renders

### Phase 2C: CDLOD Terrain
- [ ] `CDLODRendererGPU.ts`
- [ ] `cdlod.wgsl`
- [ ] `noise.wgsl` compute shader
- [ ] `thermal.wgsl` compute shader
- [ ] `hydraulic.wgsl` compute shader
- [ ] `TerrainGenerator.ts`
- [ ] Verification: Terrain matches CPU quality

### Phase 2D-2G: Remaining Migration
- [ ] GridRendererGPU
- [ ] SkyRendererGPU
- [ ] ObjectRendererGPU
- [ ] ShadowRendererGPU
- [ ] ContactShadowRendererGPU
- [ ] GPUForwardPipeline
- [ ] Viewport WebGPU integration
- [ ] Remove WebGL2 code

---

*Document created: January 30, 2026*  
*Last updated: January 30, 2026*
