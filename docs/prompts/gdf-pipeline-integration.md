# GDF Pipeline Integration: Move to Dedicated Compute Pass + Wire Mesh Primitives

## Context

The Global Distance Field (GDF) system has been upgraded to support:
- **3 cascades** (64m/256m/1024m) with hysteresis-based camera scrolling (G2)
- **Mesh primitive stamping** — boxes, spheres, capsules stamped into the SDF via compute shader (G3)

The core infrastructure is complete:
- `src/core/gpu/sdf/GlobalDistanceField.ts` — Multi-cascade update with `meshPrimitives?: SDFPrimitive[]` parameter
- `src/core/gpu/sdf/SDFPrimitiveStamper.ts` — Compute pipeline for stamping primitives
- `src/core/gpu/shaders/sdf/sdf-primitives.wgsl` — WGSL compute shader with SDF box/sphere/capsule distance functions
- `src/core/gpu/sdf/types.ts` — `SDFPrimitive` type, 3-cascade default config

## Problem

The GDF is currently initialized and updated inside the **TransparentPass** (`src/core/gpu/pipeline/passes/index.ts`), which is coupled to water rendering. This means:
1. GDF only runs when water/ocean is in the scene
2. Other consumers (volumetric fog, AO) can't use GDF without water
3. Mesh primitives are never collected or passed to `gdf.update()`

## Task

### 1. Move GDF to GPUForwardPipeline Level

Move GDF ownership from TransparentPass to `GPUForwardPipeline` (`src/core/gpu/pipeline/GPUForwardPipeline.ts`). The GDF should be:
- **Created** in `GPUForwardPipeline` constructor (or lazily on first use)
- **Updated** early in the frame, before any render passes, as a compute-only pre-pass
- **Accessible** to all passes that need it (TransparentPass for water, VolumetricFogManager for fog, future AO pass)

The update should happen in the main `render()` method of GPUForwardPipeline, before shadow/opaque/transparent passes:

```typescript
// In GPUForwardPipeline.render():
// 1. Compute pre-passes (GDF, FFT ocean, etc.)
if (this.gdf) {
  const primitives = this.collectSDFPrimitives();
  this.gdf.update(encoder, cameraPosition, terrainStampParams, primitives);
}
// 2. Shadow pass
// 3. Opaque pass  
// 4. Transparent pass (water reads GDF via bind group)
// 5. Post-process (fog reads GDF, AO reads GDF)
```

### 2. Collect Mesh Primitives from ECS

Create a method `collectSDFPrimitives()` that queries the ECS world for entities with `BoundsComponent` (from `BoundsSystem`) and converts their world AABBs to `SDFPrimitive` box types:

```typescript
private collectSDFPrimitives(): SDFPrimitive[] {
  const primitives: SDFPrimitive[] = [];
  // Query all entities that have world bounds computed by BoundsSystem
  // BoundsSystem stores worldBounds as AABB { min: vec3, max: vec3 }
  // Convert each AABB to an SDFPrimitive { type: 'box', center, extents }
  // Skip terrain, ocean, and other non-mesh objects
  // Skip entities outside a reasonable range of the camera
  return primitives;
}
```

Look at `src/core/ecs/systems/BoundsSystem.ts` for how world bounds are computed and stored. The `BoundsComponent` on each entity should have `worldBounds` with min/max vectors.

### 3. Remove GDF from TransparentPass

- Remove GDF creation/initialization from TransparentPass
- TransparentPass should receive GDF as a dependency (passed in from GPUForwardPipeline)
- The water renderer already receives `globalDistanceField` via `WaterRenderParams` — just ensure the pipeline passes the GDF reference through

### 4. Wire GDF to VolumetricFogManager

The `VolumetricFogManager` (`src/core/gpu/pipeline/VolumetricFogManager.ts`) should also receive the GDF reference so fog can sample the distance field. This is consumer integration (Phase G4 partial):
- Pass GDF's sample view + sampler + uniform buffer to `FogDensityInjector`
- In `fog-density-inject.wgsl`, sample SDF to zero density inside solid geometry and enhance density near surfaces

## Key Files to Modify

1. `src/core/gpu/pipeline/GPUForwardPipeline.ts` — Own GDF, update early, pass to consumers
2. `src/core/gpu/pipeline/passes/index.ts` — Remove GDF ownership from TransparentPass, receive as parameter
3. `src/core/gpu/pipeline/VolumetricFogManager.ts` — Accept GDF reference for fog sampling (optional, can be a follow-up)

## Key Files to Reference

- `src/core/gpu/sdf/GlobalDistanceField.ts` — The GDF class with `update(encoder, camera, terrain, primitives)`
- `src/core/gpu/sdf/types.ts` — `SDFPrimitive` type definition
- `src/core/ecs/systems/BoundsSystem.ts` — Where world bounds are computed
- `src/core/ecs/components/` — BoundsComponent definition
- `docs/water-shader-and-gdf-plan.md` — Phase G2/G3/G4 specification

## Notes

- The GDF currently uses `r32float` 3D textures with `read-write` storage access for primitive stamping. Ensure the device supports `"float32-filterable"` or continue using manual trilinear interpolation in `water.wgsl` (already implemented).
- The 3 cascades total ~12MB VRAM (3 × 128³ × 4 bytes).
- Hysteresis distance of 8 voxels means fine cascade (0.5m voxels) re-centers every 4m of camera movement, medium (2m) every 16m, coarse (8m) every 64m.
- The `sdf-primitives.wgsl` shader uses `read_write` storage texture access which requires the `"readonly-and-readwrite-storage-textures"` WebGPU feature. If not available, a two-pass approach (read terrain into temp, then write combined) would be needed.
