Here's my plan for replacing the wireframe grid with a solid UE5-style ground grid with shadow receiving:

## Current State
- `GridRendererGPU` renders a **wireframe** grid using `line-list` topology with 1-unit spacing over ±10 units
- It renders as a **viewport overlay** (after post-processing, to backbuffer) — no shadow support
- The grid shader (`grid.wgsl`) is a simple pass-through for vertex positions and colors

## Architecture Changes Required

The key insight: To receive shadows, the grid must render during the **scene pass** (before post-processing), not as a viewport overlay. This means it needs to render into the HDR buffer and participate in the shadow system. However, the grid lines (axes) should remain as a viewport overlay.

### Plan

**1. Rewrite `grid.wgsl` shader — Fullscreen quad approach**
- Instead of CPU-generated line geometry, use a **fullscreen quad on the XZ plane** (procedural grid via fragment shader)
- The fragment shader will:
  - Compute world-space XZ coordinates from vertex positions
  - Draw a **solid dark grey base** (like UE5's ground plane color ~`rgb(0.13, 0.13, 0.14)`)
  - Overlay **1-unit grid lines** (bright grey, thin) — these are the major grid
  - Overlay **0.1-unit subgrid lines** (subtle, very thin) — 10 subdivisions per unit
  - Use **anti-aliased grid lines** via `fwidth()` screen-space derivatives for crisp lines at any distance
  - **Distance-based fade**: fade subgrid lines out at distance, fade major lines at larger distance
  - **Shadow receiving**: sample the shadow map using the existing `SceneEnvironment` system (shadow map + comparison sampler at Group 3, bindings 0-1)
  - Apply basic directional lighting (N·L with normal = up `(0,1,0)`)

**2. Rewrite `GridRendererGPU.ts` renderer**
- Change topology from `line-list` to `triangle-list`
- Generate a large ground plane quad (e.g., 100×100 units, or even larger)
- Add **two pipelines**:
  - **Ground plane pipeline** (scene category): renders the solid grid ground into HDR buffer with depth, receives shadows
  - **Axis lines pipeline** (viewport category): keeps the existing axis line overlay behavior
- Add uniform buffer with:
  - `viewProjectionMatrix` (mat4)
  - `cameraPosition` (vec3)
  - `lightDirection` (vec3)
  - `lightColor` (vec3)
  - `lightSpaceMatrix` (mat4) for shadow mapping
  - `gridConfig` (gridSize, cellSize, subdivisions, lineWidth)
- Use `SceneEnvironment` mask-based bind group (just `ENV_BINDING_MASK.SHADOW` for shadow map + comparison sampler) at Group 1
- `depthWriteEnabled: true` and `depthCompare: 'greater'` (reversed-Z) so objects occlude the grid properly

**3. Move grid ground rendering to scene pass**
- In `passes/index.ts`, split the `OverlayPass` into:
  - The grid **ground plane** renders during the opaque pass (or a new dedicated pass right after sky, before opaque objects)
  - The **axis lines** remain in the overlay pass
- Update the `OverlayPass` to call the grid's axis-only render
- Add grid ground rendering to `OpaquePass` (or a new `GroundPass` at priority between SKY and OPAQUE)
- Pass `SceneEnvironment` and lighting parameters to the grid renderer

**4. Update `GPUForwardPipeline.ts`**
- Pass `sceneEnvironment` to the grid renderer for shadow bind group
- Pass lighting info (light direction, light space matrix) to grid renderer

### Files to modify:
1. **`src/core/gpu/shaders/grid.wgsl`** — Complete rewrite with procedural grid + shadow receiving
2. **`src/core/gpu/renderers/GridRendererGPU.ts`** — Complete rewrite with ground plane + axis pipelines
3. **`src/core/gpu/pipeline/passes/index.ts`** — Add ground plane to scene passes, keep axis in overlay
4. **`src/core/gpu/pipeline/GPUForwardPipeline.ts`** — Wire up shadow/lighting to grid renderer

### Visual Target (UE5-like):
- Solid dark neutral grey ground plane
- Subtle thin lines every 0.1 units (subgrid) — visible only up close
- Slightly brighter thin lines every 1.0 unit (major grid) — visible at medium distance
- Lines fade with distance to avoid moiré/aliasing
- Shadows from scene objects cast onto the ground plane
- Ground plane participates in depth testing (objects properly occlude it)

Task 1 is already complete - continue with the rest.