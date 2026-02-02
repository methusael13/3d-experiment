## Background
The engine currently generates a procedural terrain on the CPU using a domain-warped fBm simplex noise and then, running hydraulic and thermal erosion simulations for realistic looking terrains.

## Problem
All of the terrain mesh data is generated on the CPU on load and then uploaded to the GPU once. 
The vertex shader only references this height baked-in terrain mesh to render the final terrain at runtime.

For the FPS mode, where the camera floats 1.8m above the sampled terrain height at that location - we currently use Geometric clipmaps for terrain LOD.

However, there are some requirements to the camera navigation, like terrain flybys (about 1-5km above the terrain) which does not produce good results with the geometric clipmap method, since it requires the camera to be close to the terrain. 
There's also a limitation in the number of geometric ring meshes, which cannot account for far off terrain locations (like a visible mountain in the horizon).

## Solution
To overcome the limitations, we plan to use the CDLOD (Continuous distance-dependent level of detail) method for dynamic terrain generation.

### Implementation plan

#### Phase 1: The CPU Quadtree & Visibility
​The "core" of the CDLOD engine. It lives on the CPU and decides what the GPU should care about.
1. ​Define the Bounds: Create a TerrainNode class. Each node needs a world-space bounding box and an LOD level (0 for closest, N for farthest).
2. ​Recursive Selection: Every frame, run a function that starts at the root node.
   1. ​Frustum Culling: If the node is outside the camera view, discard it.
   2. ​Distance Check: If Distance(Camera, NodeCenter) < Threshold * NodeSize, subdivide into 4 children.
   3. ​Leaf Selection: If a node is small enough or the max LOD is reached, add it to the RenderList.
3. ​The Render List: This list should store the (x, z) offset and scale for every active node.

#### ​Phase 2: The WebGPU Simulation (Erosion)
​This happens "off-screen" to prepare the data.
1. ​Storage Buffers: Create two GPUBuffer objects (ping-pong buffers) to store the height data so the simulation can read from one and write to the other.
2. ​The Base Pass (fBm): Write a WGSL compute shader that takes coordinates and outputs fBm noise.
3. ​The Erosion Kernels:
    1. ​Thermal Pass: A kernel that compares a cell's height to its neighbors and moves "sediment" if the slope exceeds the angle of repose.
    2. ​Hydraulic Pass: A kernel that simulates water particles. Each workgroup can represent a "droplet" or a grid area where water accumulation is calculated.
4. ​Async Readback/Caching: Store these finished heightmaps in a GPUTextureArray.

#### ​Phase 3: The CDLOD Mesh & Morphing
​This is the "body" that uses the data from Phase 2.
1. ​The Static Grid: Create one index and vertex buffer representing a simple grid (e.g., 65 \times 65 vertices). This never changes.
2. ​Instanced Drawing: Use drawIndexedIndirect or a loop to draw the RenderList from Phase 1. Pass the offset and scale for each node as instance data.
3. ​The Vertex Shader (The "Magic"):
    1. ​Positioning: WorldPos = (LocalPos * Scale) + Offset.
    2. ​Morphing: Calculate the k (morph factor) based on distance.
    3. ​Sampling: Sample the heightmap at WorldPos. To prevent gaps, sample the current LOD height and the parent LOD height, then mix() them using k.

#### ​Phase 4: Integration & Streaming
​Making it feel like a seamless world.
1. ​Texture Management: Create a "LRU (Least Recently Used) Cache" for our tiles. If the Quadtree needs a tile that isn't eroded yet, trigger the Phase 2 simulation.
2. ​Stitch and Skirt: Even with morphing, tiny floating-point gaps can appear. Add "skirts" (extra geometry hanging down from edges) to ensure no holes are visible.
3. ​Normals: Don't calculate normals on the CPU. Generate a Normal Map in WebGPU right after the Erosion pass so the lighting looks crisp at high resolutions.

#### ​Immediate Next Step
Start with Phase 1 and a heightmap generated just via simple sine waves. Once we have the Quadtree selecting nodes and the vertex shader morphing them correctly without gaps, we can swap the sine-wave heightmap for our heavy WebGPU based domain-warped fBm and erosion simulation.

---

## Implementation Status

### ✅ Phase 1: CPU Quadtree & Visibility (COMPLETE)

**Files:**
- `src/core/terrain/TerrainQuadtree.ts` - Quadtree data structure with frustum culling and LOD selection
- `src/core/terrain/index.ts` - Module exports

**Features implemented:**
- `TerrainNode` class with AABB bounding boxes and LOD levels
- Recursive node selection with frustum culling (6-plane extraction from VP matrix)
- Distance-based subdivision with configurable thresholds
- Morph factor calculation for smooth LOD transitions
- Render list generation with node offset, scale, and morph data

### ✅ Phase 2A: WebGPU Foundation (COMPLETE)

**Files:**
- `src/core/gpu/` - Complete GPU abstraction layer for WebGPU

**Key abstractions:**
- `GPUContext` - Device and queue management
- `UnifiedGPUBuffer` - Vertex, index, uniform, storage buffers with automatic alignment
- `UnifiedGPUTexture` - 2D textures, heightmaps, render targets, depth textures
- `RenderPipelineWrapper` - Simplified render pipeline creation
- `ComputePipelineWrapper` - Compute pipeline for terrain generation
- `BindGroupLayoutBuilder` / `BindGroupBuilder` - Resource binding helpers
- `SamplerFactory` - Common sampler presets
- `ShaderModuleManager` - Shader caching and management

### ✅ Phase 2A.1: WGSL Shader Files (COMPLETE)

**Files:**
- `src/core/gpu/shaders/common/uniforms.wgsl` - Common uniform structures
- `src/core/gpu/shaders/terrain/noise.wgsl` - Simplex noise, fBm, domain warping
- `src/core/gpu/shaders/terrain/cdlod.wgsl` - CDLOD terrain rendering shader
- `src/core/gpu/shaders/terrain/heightmap-generation.wgsl` - GPU heightmap generation
- `src/core/gpu/shaders/terrain/normal-map-generation.wgsl` - Normal map from heightmap
- `src/core/gpu/ShaderLoader.ts` - Type-safe shader loading utility

### ✅ Phase 2B: CDLOD Terrain Renderer (COMPLETE)

**Files:**
- `src/core/terrain/CDLODRenderer.ts` - WebGL2 version (original)
- `src/core/terrain/CDLODRendererGPU.ts` - WebGPU version using GPU abstractions

**Features:**
- Instanced grid mesh rendering
- Per-instance node data (offset, scale, morph, LOD)
- Uniform buffer management for matrices and terrain params
- Material system with multi-texture terrain blending
- Debug visualization mode showing LOD levels and wireframe
- Procedural sine-wave heightmap for testing

### ✅ Phase 2C: GPU Terrain Generation (COMPLETE)

**Files:**
- `src/core/terrain/HeightmapGenerator.ts` - Compute pipeline for noise-based heightmaps
- `src/core/terrain/ErosionSimulator.ts` - Hydraulic and thermal erosion orchestrator
- `src/core/gpu/shaders/terrain/hydraulic-erosion.wgsl` - Particle-based water erosion
- `src/core/gpu/shaders/terrain/thermal-erosion.wgsl` - Talus angle-based erosion

**Features:**
- HeightmapGenerator:
  - Compute pipeline for domain-warped fBm noise
  - Multiple noise types: `fbm`, `ridged`, `warped`
  - Automatic normal map generation from heightmap
  - Configurable parameters: octaves, persistence, lacunarity, seed

- ErosionSimulator:
  - Hydraulic erosion with particle-based droplet simulation
  - Thermal erosion with talus angle-based sediment transport
  - Ping-pong textures for iterative simulation
  - Configurable erosion/deposition rates, brush radius, gravity
  - Multiple compute passes per iteration (init → simulate → finalize)

### ✅ Phase 3: Mesh Integration (COMPLETE)

**Files:**
- `src/core/terrain/CDLODRendererGPU.ts` - Updated with skirt geometry support
- `src/core/gpu/shaders/terrain/cdlod.wgsl` - Updated with isSkirt vertex attribute
- `src/core/terrain/TerrainManager.ts` - High-level terrain orchestration
- `src/core/terrain/TerrainTileCache.ts` - LRU cache for terrain tiles

**Features:**
- **Skirt Geometry**: Added vertical strips around patch edges to hide LOD gaps
  - `enableSkirts` config option (default: true)
  - `skirtDepthMultiplier` for adjustable depth
  - isSkirt vertex attribute (0.0 or 1.0) passed to shader
  - Skirt depth scales with node LOD level for consistent coverage

- **TerrainManager**: High-level orchestration class
  - Manages HeightmapGenerator → ErosionSimulator → CDLODRendererGPU pipeline
  - Async generation with progress callbacks
  - Configurable noise params, erosion iterations, normal strength
  - Simple `generate()` / `regenerate()` / `render()` API

- **TerrainTileCache**: LRU cache for terrain tiles
  - Keyed by (x, z, lod) for spatial lookup
  - Automatic eviction when capacity reached
  - Reserve/complete pattern for async generation
  - Cache hit/miss statistics

### ✅ Phase 4A: Streaming Terrain Loading (COMPLETE)

**Files:**
- `src/core/terrain/TerrainStreamer.ts` - On-demand terrain tile streaming
- `src/core/terrain/TerrainTileCache.ts` - LRU cache (from Phase 3)

**Features:**
- **TerrainStreamer**: Watches camera position and generates tiles as needed
  - Priority-based tile generation queue (closer tiles first, higher LOD first)
  - LOD-aware quality settings (high/medium/low resolution per LOD tier)
  - Async tile generation using HeightmapGenerator + ErosionSimulator
  - Integration with TerrainTileCache for storage
  - Configurable erosion iterations per LOD tier
  - Statistics tracking (tiles/sec, queue size, cache hits/misses)

### ✅ Phase 4B: GPU-Driven Frustum Culling (COMPLETE)

**Files:**
- `src/core/gpu/shaders/terrain/frustum-cull.wgsl` - Compute shader for GPU culling
- `src/core/terrain/GPUCullingPipeline.ts` - GPU culling pipeline management

**Features:**
- **frustum-cull.wgsl**: Compute shader that tests quadtree nodes against frustum
  - AABB-plane intersection tests for conservative culling
  - Atomic append to visible nodes buffer
  - Dynamic morph factor calculation based on camera distance
  - Reset shader for clearing instance count

- **GPUCullingPipeline**: Manages GPU-driven culling workflow
  - Upload all quadtree nodes to GPU once (not just visible)
  - Extract frustum planes from view-projection matrix
  - Run compute pass to cull nodes on GPU
  - Output to indirect draw buffer for drawIndexedIndirect()
  - Eliminates CPU-GPU data transfer bottleneck

### ✅ Phase 4C: LOD Heightmap Textures (COMPLETE)

**Files:**
- `src/core/gpu/shaders/terrain/heightmap-downsample.wgsl` - GPU downsample compute shader
- `src/core/terrain/HeightmapMipmapGenerator.ts` - Mipmap chain generation

**Features:**
- **heightmap-downsample.wgsl**: Box filter downsample compute shader
  - 2x2 pixel averaging for smooth downsampling
  - Alternative min-max preserving filter for peak/valley preservation
  - Generates mip chain: 1024 → 512 → 256 → 128 → 64

- **HeightmapMipmapGenerator**: Mipmap chain generation
  - `generateMipChain()` - Creates complete mip hierarchy from base heightmap
  - Configurable minimum resolution and max mip levels
  - Static helpers for LOD-to-mip mapping
  - Async version with GPU sync for streaming use

- **LOD-to-Mip Mapping**:
  - LOD 0-2 → mip 0 (full resolution)
  - LOD 3-4 → mip 1 (half resolution)
  - LOD 5-6 → mip 2 (quarter resolution)
  - LOD 7+  → mip 3 (eighth resolution)

### ✅ Phase 5: WebGPU Forward Pipeline (COMPLETE)

**Files:**
- `src/core/gpu/renderers/GridRendererGPU.ts` - WebGPU grid renderer
- `src/core/gpu/renderers/SkyRendererGPU.ts` - WebGPU sky renderer (sun + HDR modes)
- `src/core/gpu/shaders/grid.wgsl` - Grid rendering shader with anti-aliasing
- `src/core/gpu/shaders/sky.wgsl` - Atmospheric scattering + HDR equirectangular
- `src/core/gpu/pipeline/GPUForwardPipeline.ts` - Complete forward rendering pipeline
- `src/core/gpu/renderers/index.ts` - Renderer exports
- `src/core/gpu/pipeline/index.ts` - Pipeline exports

**Features:**
- **GridRendererGPU**: Procedural infinite grid rendering
  - Anti-aliased lines using coverage-based blending
  - Configurable grid size, line width, fade distance
  - Optional axis indicators (RGB = XYZ)
  - Full-screen quad with ray-based intersection

- **SkyRendererGPU**: Dual-mode sky rendering
  - **Sun Mode**: Physical Rayleigh/Mie scattering model
    - Configurable sun direction, elevation, azimuth
    - Wavelength-dependent atmospheric scattering
    - Sun disc rendering with bloom
  - **HDR Mode**: Equirectangular environment map rendering
    - Configurable exposure
    - UV mapping from view direction to spherical coordinates

- **GPUForwardPipeline**: Complete rendering orchestration
  - Multi-pass architecture:
    1. Sky pass (no depth, background)
    2. Opaque pass (terrain, objects with depth)
    3. Overlay pass (grid, gizmos with depth test)
  - Optional MSAA support with resolve targets
  - Automatic depth buffer management
  - Integration with TerrainManager for CDLOD rendering
  - HDR texture support for environment maps

---

## Usage Example

```typescript
import { GPUContext, CDLODRendererGPU } from './core/gpu';
import { createDefaultCDLODGPUConfig } from './core/terrain';

// Initialize WebGPU context
const ctx = await GPUContext.create(canvas);

// Create CDLOD renderer
const terrainRenderer = new CDLODRendererGPU(ctx, 
  { worldSize: 4096, maxLODLevels: 8 },
  { gridSize: 65, debugMode: true }
);

// In render loop
terrainRenderer.render(passEncoder, {
  viewProjectionMatrix: vpMatrix,
  modelMatrix: modelMatrix,
  cameraPosition: camera.position,
  terrainSize: 4096,
  heightScale: 512,
});

// Cleanup
terrainRenderer.destroy();
```
