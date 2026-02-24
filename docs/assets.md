Here's a breakdown on both fronts:

## Game-Ready Vegetation Asset Sources

Polyhaven models are indeed meant for film/archviz quality — they're not optimized for real-time rendering. Better sources for **game-ready** (low-poly, LOD-friendly) vegetation:

1. **Quaternius** (https://quaternius.com) — Free, stylized and realistic low-poly nature packs. Excellent for real-time use.
2. **Kenney** (https://kenney.nl) — Free low-poly asset packs including nature sets.
3. **Sketchfab** — Filter by "game ready" + "low poly". Many free CC0/CC-BY models available.
4. **CGTrader / TurboSquid** — Filter for "game ready" and "low poly". Mix of free and paid.
5. **Kitbash3D** (Nature Kit) — Paid, but optimized for real-time with LODs included.
6. **SpeedTree** — Industry standard for game vegetation. Has a free tier for indie/learning. Exports optimized meshes with LODs, wind animation data, and billboard imposters.
7. **Quixel Megascans** (now free via Fab/Epic) — Has some game-ready vegetation, though many scanned assets are still high-poly. Look for assets tagged with LODs.

## Blender Polygon Reduction

If you want to keep using Polyhaven assets and decimate them, Blender has several options:

### Built-in Tools
- **Decimate Modifier** — Three modes: Collapse (ratio-based), Un-Subdivide, Planar. Collapse with a ratio of 0.1–0.3 usually works well for trees.
- **Remesh Modifier** — Voxel-based retopology. Less useful for trees since it destroys thin geometry (leaves/branches).

### Recommended Add-ons
1. **Instant Meshes Remesh** (free, built-in bridge available) — Quad-dominant retopology. Better topology than Decimate but requires more setup.
2. **Mesh: Auto Decimate** (free, built-in since Blender 3.x under `Mesh > Clean Up > Decimate Geometry`) — Quick access to decimation from edit mode.
3. **QRemesher** (~$20, Blender Market) — Automatic quad remeshing with edge flow control. Good results for organic shapes.
4. **Polycount Reducer / LOD Tools** — Search Blender Market for "LOD generator" add-ons that can batch-create multiple LOD levels from a high-poly mesh.

### Practical Workflow for Trees
For your use case (instanced vegetation in a WebGPU engine), I'd suggest:

1. **Decimate the trunk/branches** aggressively (Collapse, ratio ~0.1–0.2).
2. **Replace leaf geometry** with simple quads/cards textured with alpha-cutout leaf atlas textures — this is how most game engines handle foliage.
3. **Generate LOD levels** (e.g., LOD0: 2k tris, LOD1: 500 tris, LOD2: billboard imposter) — your `VegetationBillboardRenderer` already supports the billboard LOD level.
4. **Batch process** using Blender's Python API if you have many assets to convert.

Given that your engine already has a `VegetationBillboardRenderer` and `VegetationMeshRenderer` with culling pipelines, the most impactful approach would be to either source pre-optimized assets (Quaternius, SpeedTree) or decimate Polyhaven models using the Decimate modifier and replace leaf clusters with textured cards.