# Object Rendering WebGPU Migration Plan

## Overview

This document outlines the phased migration of object rendering from WebGL to WebGPU, covering:
- Gizmo visualization
- PBR material system with textures
- Lighting (directional, HDR/IBL)
- Shadow mapping
- Wind effects
- Terrain blending
- Selection visuals (outline, wireframe)

---

## Architecture

### Design Decision: Centralized vs Per-Object Renderers

#### Legacy WebGL Pattern (Per-Object Renderers)
```
RenderableObject (base class)
  └── renderer: IRenderer | null   // Each object owns its renderer

ForwardPipeline.render(objects: RenderObject[])
  └── for (obj of objects) {
        obj.renderer.render(vpMatrix, modelMatrix, ...);
      }
```
- Each ModelObject/PrimitiveObject creates its own renderer instance
- Pipeline iterates objects and calls each renderer
- Simple mental model, but limits batching opportunities

#### WebGPU Pattern (Centralized Renderer) ✅ CHOSEN
```
GPUContext
  └── objectRenderer: ObjectRendererGPU   // Single shared renderer

ObjectRendererGPU
  └── meshes: Map<number, GPUMeshInternal>  // All mesh GPU resources
  
OpaquePass.execute(ctx)
  └── Frustum cull → visibleIds[]
  └── objectRenderer.renderMeshes(pass, visibleIds, params)
```
- Single `ObjectRendererGPU` manages all mesh GPU resources
- Scene objects register meshes, receive mesh IDs
- Better batching, single shader pipeline, single bind group layout

### Renderer Ownership

The `ObjectRendererGPU` is owned by `GPUContext` and shared across all scene objects:

```
Viewport
  │
  ├─→ Creates GPUContext
  │     └── objectRenderer = new ObjectRendererGPU(ctx)
  │
  └─→ When ModelObject added to scene:
        └── modelObject.initWebGPU(gpuContext)
              └── this.gpuMeshId = ctx.objectRenderer.addMesh(geometry)
```

**Benefits:**
- Single source of truth for GPU resources
- Objects already need GPUContext for any GPU work
- Matches pattern: GPUContext = all GPU-related state

### Scene Object Integration

Scene objects interact with the centralized renderer:

```typescript
// ModelObject.ts
class ModelObject extends RenderableObject {
  private gpuMeshId: number | null = null;
  
  initWebGPU(ctx: GPUContext): void {
    // Register geometry with shared renderer
    this.gpuMeshId = ctx.objectRenderer.addMesh({
      positions: this.geometry.positions,
      normals: this.geometry.normals,
      uvs: this.geometry.uvs,
      indices: this.geometry.indices,
    });
  }
  
  // Called when transform changes (gizmo drag, panel edit)
  protected onTransformChanged(): void {
    if (this.gpuMeshId !== null) {
      this.gpuContext?.objectRenderer.setTransform(
        this.gpuMeshId, 
        this.getModelMatrix()
      );
    }
  }
  
  destroy(): void {
    if (this.gpuMeshId !== null) {
      this.gpuContext?.objectRenderer.removeMesh(this.gpuMeshId);
    }
  }
}
```

### Frustum Culling Flow

CPU-based frustum culling with centralized rendering:

```
OpaquePass.execute(ctx):
  1. Get all renderable objects from Scene
  2. For each object:
     - Get world AABB (object.getWorldBounds())
     - Test against camera frustum planes
     - If visible: add object.gpuMeshId to visibleIds[]
  3. objectRenderer.renderMeshes(pass, visibleIds, params)
```

**Future optimization path:** GPU compute culling (like CDLOD terrain uses).

### Model Matrix Management

Model matrices are stored in the renderer, updated on demand:

```
ObjectRendererGPU per-mesh storage:
  GPUMeshInternal {
    id: number,
    vertexBuffer, indexBuffer,
    modelMatrix: Float32Array,     // CPU copy
    modelBuffer: UnifiedGPUBuffer, // GPU buffer (64 bytes)
    modelBindGroup: GPUBindGroup,  // Binds to shader group 1
  }

Update flow:
  SceneObject.setPosition(x, y, z)
    → SceneObject.computeModelMatrix()
    → renderer.setTransform(meshId, modelMatrix)
    → GPU buffer write (only when dirty)
```

**Benefits:**
- Matrix always GPU-ready (no per-frame upload)
- Dirty tracking prevents redundant uploads
- Bind groups reused across frames
- Works with frustum culling (skip draw, matrix still valid)

### Data Flow Diagrams

#### Object Addition
```
User drops GLB file
  │
  ├─→ GLBLoader.load()
  │     └─→ Returns GLBModel with geometry/materials
  │
  ├─→ new ModelObject(glbModel)
  │
  ├─→ scene.add(modelObject)
  │
  └─→ modelObject.initWebGPU(gpuContext)
        │
        ├─→ ctx.objectRenderer.addMesh(geometry) → meshId
        ├─→ ctx.objectRenderer.setTransform(meshId, matrix)
        └─→ ctx.objectRenderer.setMaterial(meshId, material)
```

#### Transform Update
```
Gizmo drag / Panel edit
  │
  └─→ sceneObject.setPosition(x, y, z)
        │
        ├─→ this.position = [x, y, z]
        ├─→ this.modelMatrixDirty = true
        ├─→ this.computeModelMatrix()
        │
        └─→ gpuContext.objectRenderer.setTransform(meshId, matrix)
              │
              └─→ mesh.modelBuffer.write(ctx, matrix)
                    // GPU buffer updated immediately
```

#### Render Frame
```
Viewport.render()
  │
  ├─→ GPUForwardPipeline.render(encoder, scene, options)
  │     │
  │     ├─→ SkyPass.execute()
  │     │
  │     ├─→ ShadowPass.execute()
  │     │
  │     └─→ OpaquePass.execute(ctx)
  │           │
  │           ├─→ Render terrain (if present)
  │           │
  │           └─→ Render objects:
  │                 ├─→ visibleIds = frustumCull(scene.getObjects())
  │                 └─→ objectRenderer.renderMeshes(pass, visibleIds)
  │                       │
  │                       └─→ for (id of visibleIds) {
  │                             mesh = meshes.get(id)
  │                             pass.setBindGroup(1, mesh.modelBindGroup)
  │                             pass.drawIndexed(mesh.indexCount)
  │                           }
  │
  └─→ TransparentPass.execute() // Ocean, etc.
```

#### Object Removal
```
User deletes object / Scene.remove()
  │
  └─→ sceneObject.destroy()
        │
        └─→ gpuContext.objectRenderer.removeMesh(meshId)
              │
              ├─→ mesh.vertexBuffer.destroy()
              ├─→ mesh.indexBuffer.destroy()
              ├─→ mesh.modelBuffer.destroy()
              └─→ meshes.delete(meshId)
```

#### Multi-Mesh GLB Models
```
GLBLoader.load() returns GLBModel
  │
  └─→ glbModel.meshes: GLBMesh[] // Can have multiple meshes
        │
        └─→ Each GLBMesh has:
              ├─→ geometry (positions, normals, uvs, indices)
              ├─→ materialIndex (references glbModel.materials[])
              └─→ name

ModelObject stores multiple mesh IDs:
  class ModelObject {
    private gpuMeshIds: number[] = [];  // One per GLB mesh
    
    initWebGPU(ctx: GPUContext): void {
      for (const mesh of this.glbModel.meshes) {
        const meshId = ctx.objectRenderer.addMesh(mesh.geometry);
        // Use material from GLB (read-only, no panel editing)
        ctx.objectRenderer.setMaterial(meshId, this.glbModel.materials[mesh.materialIndex]);
        this.gpuMeshIds.push(meshId);
      }
    }
    
    destroy(): void {
      for (const meshId of this.gpuMeshIds) {
        this.gpuContext?.objectRenderer.removeMesh(meshId);
      }
    }
  }
```

**Note:** GLB model materials are read-only (loaded from file). Material panel editing is only for primitives.

#### Primitive Objects (Cube, Plane, UVSphere)
```
User creates primitive via UI
  │
  ├─→ new PrimitiveObject(type: 'cube' | 'plane' | 'sphere')
  │     │
  │     └─→ Generates geometry via primitiveGeometry.ts
  │
  ├─→ scene.add(primitiveObject)
  │
  └─→ primitiveObject.initWebGPU(gpuContext)
        │
        ├─→ ctx.objectRenderer.addMesh(generatedGeometry) → meshId
        └─→ ctx.objectRenderer.setMaterial(meshId, defaultMaterial)
              // Default: white, roughness=0.5, metallic=0

Material Panel → Primitive Material Editing:
  User selects primitive → MaterialPanel shows
    │
    └─→ User edits roughness/metallic/color
          │
          ├─→ primitive.setMaterial({ roughness: value })
          │
          └─→ gpuContext.objectRenderer.setMaterial(meshId, updatedMaterial)
                // GPU material buffer updated
```

**Editable properties (primitives only):**
- `albedo` (color picker)
- `metallic` (slider 0-1)
- `roughness` (slider 0-1)

#### Sun vs HDR Lighting Mode
```
EnvironmentPanel controls lighting mode:
  lightingMode: 'sun' | 'hdr'

OpaquePass.execute(ctx) passes to renderer:
  objectRenderer.renderMeshes(pass, visibleIds, {
    lightMode: ctx.options.lightMode,
    
    // Sun mode params:
    sunDirection: ctx.options.lightDirection,
    sunIntensity: ctx.options.sunIntensity,
    ambientIntensity: ctx.options.ambientIntensity,
    
    // HDR mode params:
    hdrEnvMap: ctx.textures.hdrEnvMap,
    hdrExposure: ctx.options.hdrExposure,
    
    // Common:
    shadowMap: ctx.textures.shadowMap,
    lightSpaceMatrix: ctx.textures.lightSpaceMatrix,
  })

Shader branching:
  if (lightMode == SUN) {
    // Directional light + shadow + ambient
    lighting = pbrDirectional(N, V, L, albedo, metallic, roughness);
    lighting *= shadow;
    lighting += ambient * albedo;
  } else {  // HDR/IBL
    // Sample environment map for diffuse + specular IBL
    lighting = pbrIBL(N, V, R, albedo, metallic, roughness, hdrEnvMap);
  }
```

#### Selection State for Outline (Phase 4)
```
Render frame:
  OpaquePass.execute(ctx)
    │
    └─→ selectedMeshId = scene.getSelectedObject()?.gpuMeshId ?? -1
    └─→ objectRenderer.renderMeshes(pass, visibleIds, {
          selectedMeshId,
          outlineColor: [1.0, 0.5, 0.0],  // Orange
        })

Outline rendered in separate pass or via stencil technique.
```

---

## Current State Analysis

### WebGPU ObjectRendererGPU (Current)
| Feature | Status | Notes |
|---------|--------|-------|
| Transform uniforms | ✅ | MVP matrix to GPU buffer |
| Basic material (albedo/metallic/roughness) | ✅ | Uniform buffer only |
| Directional light | ✅ | Simple diffuse + specular |
| Ambient (hemisphere) | ✅ | Sky/ground interpolation |
| Per-mesh materials | ✅ | Material uniform per draw |
| Indexed geometry | ✅ | Uint16/Uint32 support |

### WebGL ObjectRenderer (Legacy - Features to Port)
| Feature | Status in WebGPU | Priority |
|---------|-----------------|----------|
| **Textures** | | |
| Base color texture | ❌ Missing | High |
| Normal map + TBN | ❌ Missing | High |
| Metallic-roughness texture | ❌ Missing | High |
| Occlusion texture | ❌ Missing | Medium |
| Emissive texture | ❌ Missing | Medium |
| **Lighting** | | |
| Full PBR (GGX/Fresnel) | ❌ Uses Blinn-Phong | High |
| HDR environment (IBL) | ❌ Missing | High |
| Shadow mapping | ❌ Missing | High |
| **Effects** | | |
| Wind animation | ❌ Missing | Medium |
| Terrain blending | ❌ Missing | Medium |
| Transmission/refraction | ❌ Missing | Low |
| **Selection** | | |
| Outline rendering | ❌ Missing | Medium |
| Wireframe mode | ❌ Missing | Low |
| **Debug** | | |
| Shadow debug viz | ❌ Missing | Low |
| Wind debug viz | ❌ Missing | Low |

### Transform Gizmos (Completely WebGL)
| Component | Status |
|-----------|--------|
| TransformGizmoManager | ❌ WebGL only |
| TranslateGizmo | ❌ WebGL only |
| RotateGizmo | ❌ WebGL only |
| ScaleGizmo | ❌ WebGL only |
| UniformScaleGizmo | ❌ WebGL only |

---

## Phase 0: Gizmo Rendering to WebGPU

**Goal:** Port transform gizmos so editor remains functional in pure WebGPU mode.

### Current Architecture
```
TransformGizmoManager (WebGL)
  ├── TranslateGizmo
  ├── RotateGizmo
  ├── ScaleGizmo
  └── UniformScaleGizmo
```

### Target Architecture
```
TransformGizmoManagerGPU (WebGPU)
  ├── Uses GPUContext
  ├── gizmo.wgsl shader
  └── Unlit colored geometry rendering
```

### Files to Create
- `src/core/gpu/renderers/GizmoRendererGPU.ts` - Unified gizmo renderer
- `src/core/gpu/shaders/gizmo.wgsl` - Unlit colored shader

### Files to Modify
- `src/demos/sceneBuilder/gizmos/TransformGizmoManager.ts` - Add WebGPU support
- `src/demos/sceneBuilder/Viewport.ts` - Use WebGPU gizmo renderer

### Implementation Details

1. **Create gizmo.wgsl shader**
   - Unlit vertex coloring
   - Depth test with write
   - Support for lines and triangles
   - Alpha for hover/selection states

2. **Create GizmoRendererGPU**
   - Manages gizmo geometry buffers
   - Arrow, ring, cube primitives
   - Color per-axis (R=X, G=Y, B=Z)
   - Highlight on hover

3. **Update TransformGizmoManager**
   - Accept GPUContext OR WebGL2Context
   - Delegate rendering to appropriate backend
   - Keep interaction logic unchanged (JS side)

### Shader Specification (gizmo.wgsl)
```wgsl
struct Uniforms {
  viewProjection: mat4x4f,
  model: mat4x4f,
  color: vec4f,
}

@vertex fn vs_main(@location(0) position: vec3f) -> @builtin(position) vec4f {
  return uniforms.viewProjection * uniforms.model * vec4f(position, 1.0);
}

@fragment fn fs_main() -> @location(0) vec4f {
  return uniforms.color;
}
```

---

## Phase 1: Full PBR + Textures

**Goal:** Support GLB/glTF textures with proper PBR material model.

### Files to Create
- `src/core/gpu/shaders/pbr.wgsl` - Full PBR lighting functions

### Files to Modify
- `src/core/gpu/shaders/object.wgsl` - Add texture samplers
- `src/core/gpu/renderers/ObjectRendererGPU.ts` - Texture management
- `src/core/sceneObjects/ModelObject.ts` - Store GPU textures

### Implementation Details

1. **Extend object.wgsl with textures**
   ```wgsl
   @group(2) @binding(0) var baseColorTexture: texture_2d<f32>;
   @group(2) @binding(1) var baseColorSampler: sampler;
   @group(2) @binding(2) var normalTexture: texture_2d<f32>;
   @group(2) @binding(3) var normalSampler: sampler;
   @group(2) @binding(4) var metallicRoughnessTexture: texture_2d<f32>;
   @group(2) @binding(5) var metallicRoughnessSampler: sampler;
   @group(2) @binding(6) var occlusionTexture: texture_2d<f32>;
   @group(2) @binding(7) var occlusionSampler: sampler;
   @group(2) @binding(8) var emissiveTexture: texture_2d<f32>;
   @group(2) @binding(9) var emissiveSampler: sampler;
   ```

2. **Add texture flags to MaterialUniforms**
   ```wgsl
   struct MaterialUniforms {
     albedo: vec3f,
     metallic: f32,
     roughness: f32,
     normalScale: f32,
     occlusionStrength: f32,
     hasBaseColorTex: f32,
     hasNormalTex: f32,
     hasMetallicRoughnessTex: f32,
     hasOcclusionTex: f32,
     hasEmissiveTex: f32,
     emissiveFactor: vec3f,
   }
   ```

3. **Implement GGX PBR in fragment shader**
   - Distribution function (GGX/Trowbridge-Reitz)
   - Fresnel-Schlick approximation
   - Geometry function (Smith GGX)
   - Energy conservation

4. **Update ObjectRendererGPU**
   - Load textures from GLBModel
   - Create GPUTexture + sampler per texture
   - Handle sRGB for base color / emissive
   - Create texture bind group per material

### Bind Group Layout
- Group 0: Global uniforms (VP matrix, camera, light)
- Group 1: Per-object (model matrix)
- Group 2: Per-material (textures)

---

## Phase 2: Lighting Integration

**Goal:** Support directional light, HDR environment, and shadow mapping.

### Files to Create
- `src/core/gpu/shaders/common/lighting.wgsl` - Shared lighting functions
- `src/core/gpu/shaders/common/shadow.wgsl` - Shadow sampling functions

### Files to Modify
- `src/core/gpu/shaders/object.wgsl` - Import lighting modules
- `src/core/gpu/renderers/ObjectRendererGPU.ts` - Light/shadow uniforms
- `src/core/gpu/pipeline/GPUForwardPipeline.ts` - Pass shadow map

### Implementation Details

1. **Directional Light Uniforms**
   ```wgsl
   struct LightUniforms {
     direction: vec3f,
     _pad0: f32,
     color: vec3f,
     intensity: f32,
     ambient: f32,
     shadowEnabled: f32,
     shadowBias: f32,
     _pad1: f32,
     lightSpaceMatrix: mat4x4f,
   }
   ```

2. **HDR/IBL Support**
   - Sample equirectangular HDR environment map
   - Diffuse irradiance (hemisphere integration)
   - Specular reflection (mip-mapped pre-filtered env)
   - Fresnel term for blend

3. **Shadow Mapping**
   - Accept shadow map texture from ShadowRendererGPU
   - PCF (percentage closer filtering) for soft shadows
   - Cascaded shadow maps (optional, future)

### Uniform Buffer Layout
```
Group 0:
  Binding 0: GlobalUniforms (VP, camera)
  Binding 1: MaterialUniforms
  Binding 2: LightUniforms
  Binding 3: shadowMap texture
  Binding 4: shadowSampler
  Binding 5: hdrEnvMap texture (optional)
  Binding 6: hdrSampler (optional)
```

---

## Phase 2.5: Dynamic Sky IBL

**Goal:** Generate environment map from procedural sky for physically-correct IBL lighting.

> **Note:** Phase 2 is NOT a prerequisite for Phase 2.5. They can be implemented independently and in parallel.

### Relationship to HDR Lighting Mode

The application supports two lighting modes, each with its own IBL approach:

| Mode | Source | IBL Type | When Active |
|------|--------|----------|-------------|
| **HDR Mode** | Static `.hdr` file | Pre-baked IBL from loaded texture | User loads HDR environment |
| **Sun Mode** | Procedural sky | **Dynamic Sky IBL** (this phase) | Default directional light mode |

**Key Points:**
- **HDR IBL** (Phase 2) remains unchanged - uses pre-loaded equirectangular environment maps
- **Dynamic Sky IBL** (Phase 2.5) ONLY activates in Sun/Directional Light mode
- When user switches to HDR mode, Dynamic Sky IBL is bypassed entirely
- Both systems share the same IBL sampling code in `object.wgsl` - only the source textures differ

### Concept

Instead of loading static HDR environment maps, capture the procedural sky (Nishita atmospheric scattering) 
to a cubemap and use it for Image-Based Lighting. The sun position affects both direct light AND ambient IBL,
creating a unified lighting model.

### Architecture

```
┌─────────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│  SkyRendererGPU     │      │  DynamicSkyIBL   │      │ObjectRendererGPU│
│  (procedural sky)   │ ───► │  (cubemap gen)   │ ───► │ (IBL sampling)  │
│  Nishita scattering │      │  + convolution   │      │                 │
└─────────────────────┘      └──────────────────┘      └─────────────────┘
         │                           │
         ▼                           ▼
    Main viewport              IBL textures:
    background                 - Diffuse irradiance (64³)
                               - Specular prefilter (128³ + mips)
```

### Incremental Update Strategy (Double-Buffering)

To avoid performance spikes, IBL updates are spread across multiple frames:

```
Frame N:   Detect sun moved > threshold → Mark dirty
Frame N+1: Render cubemap face +X (to "next" cubemap)
Frame N+2: Render cubemap face -X
Frame N+3: Render cubemap face +Y
Frame N+4: Render cubemap face -Y
Frame N+5: Render cubemap face +Z
Frame N+6: Render cubemap face -Z
Frame N+7: Run diffuse convolution compute shader
Frame N+8: Run specular prefilter mip 0
Frame N+9: Run specular prefilter mip 1
...
Frame N+14: Run specular prefilter mip 5
Frame N+15..N+25: Blend from "current" to "next" IBL (lerp factor 0→1)
Frame N+26: Swap buffers, "next" becomes "current"
```

**Result:** 
- Full IBL update takes ~25 frames (~400ms at 60fps)
- Per-frame cost: <0.5ms (one cubemap face OR one convolution pass)
- Smooth visual transition (no popping)
- Static scenes = zero IBL update cost

### Files to Create

| File | Description |
|------|-------------|
| `src/core/gpu/ibl/DynamicSkyIBL.ts` | Main manager class |
| `src/core/gpu/ibl/CubemapCapture.ts` | Render sky to 6 cubemap faces |
| `src/core/gpu/shaders/ibl/diffuse-convolution.wgsl` | Compute shader for diffuse irradiance |
| `src/core/gpu/shaders/ibl/specular-prefilter.wgsl` | Compute shader for specular mips |
| `src/core/gpu/shaders/ibl/sky-to-cubemap.wgsl` | Render sky to single face |

### Files to Modify

| File | Changes |
|------|---------|
| `src/core/gpu/renderers/SkyRendererGPU.ts` | Add `renderToCubemapFace()` method |
| `src/core/gpu/shaders/object.wgsl` | Add IBL sampling (cubemap textures) |
| `src/core/gpu/renderers/ObjectRendererGPU.ts` | Accept IBL textures in render params |
| `src/core/gpu/pipeline/GPUForwardPipeline.ts` | Integrate DynamicSkyIBL into render loop |
| `src/core/gpu/GPUContext.ts` | Own DynamicSkyIBL instance |

### DynamicSkyIBL Class Design

```typescript
interface IBLState {
  dirty: boolean;
  updateQueue: IBLTask[];
  blendFactor: number; // 0 = use current, 1 = use next
  lastSunDirection: [number, number, number];
}

type IBLTask = 
  | { type: 'face'; faceIndex: 0 | 1 | 2 | 3 | 4 | 5 }
  | { type: 'diffuse' }
  | { type: 'specular'; mipLevel: number }
  | { type: 'blend' };

class DynamicSkyIBL {
  // Double-buffered cubemaps
  private currentCubemap: GPUTexture;   // Currently used for rendering
  private nextCubemap: GPUTexture;      // Being updated
  
  // Processed IBL textures (also double-buffered)
  private currentDiffuse: GPUTexture;   // 64×64×6 faces
  private nextDiffuse: GPUTexture;
  private currentSpecular: GPUTexture;  // 128×128×6 faces, 6 mip levels
  private nextSpecular: GPUTexture;
  
  // Render/compute pipelines
  private skyToCubemapPipeline: GPURenderPipeline;
  private diffuseConvolutionPipeline: GPUComputePipeline;
  private specularPrefilterPipeline: GPUComputePipeline;
  
  // State
  private state: IBLState;
  
  constructor(ctx: GPUContext) {
    // Allocate cubemap textures (size 256×256 for sky capture)
    // Allocate diffuse (64×64) and specular (128×128 + mips)
  }
  
  /**
   * Check if sun has moved enough to trigger update
   */
  markDirtyIfSunMoved(sunDirection: [number, number, number]): void {
    const delta = vec3.distance(sunDirection, this.state.lastSunDirection);
    if (delta > 0.01) { // ~0.5° threshold
      this.state.dirty = true;
      this.state.lastSunDirection = [...sunDirection];
      this.queueFullUpdate();
    }
  }
  
  /**
   * Queue all update tasks
   */
  private queueFullUpdate(): void {
    this.state.updateQueue = [
      { type: 'face', faceIndex: 0 },
      { type: 'face', faceIndex: 1 },
      { type: 'face', faceIndex: 2 },
      { type: 'face', faceIndex: 3 },
      { type: 'face', faceIndex: 4 },
      { type: 'face', faceIndex: 5 },
      { type: 'diffuse' },
      { type: 'specular', mipLevel: 0 },
      { type: 'specular', mipLevel: 1 },
      { type: 'specular', mipLevel: 2 },
      { type: 'specular', mipLevel: 3 },
      { type: 'specular', mipLevel: 4 },
      { type: 'specular', mipLevel: 5 },
      // Blend tasks (10 frames for smooth transition)
      ...Array(10).fill({ type: 'blend' }),
    ];
  }
  
  /**
   * Process one task per frame
   * Called from GPUForwardPipeline before object rendering
   */
  update(ctx: GPUContext, encoder: GPUCommandEncoder, skyRenderer: SkyRendererGPU): void {
    if (this.state.updateQueue.length === 0) return;
    
    const task = this.state.updateQueue.shift()!;
    
    switch (task.type) {
      case 'face':
        this.renderCubemapFace(ctx, encoder, skyRenderer, task.faceIndex);
        break;
      case 'diffuse':
        this.runDiffuseConvolution(ctx, encoder);
        break;
      case 'specular':
        this.runSpecularPrefilter(ctx, encoder, task.mipLevel);
        break;
      case 'blend':
        this.state.blendFactor = Math.min(1.0, this.state.blendFactor + 0.1);
        if (this.state.blendFactor >= 1.0) {
          this.swapBuffers();
        }
        break;
    }
  }
  
  /**
   * Get current IBL textures for object rendering
   */
  getIBLTextures(): { diffuse: GPUTexture; specular: GPUTexture; blendFactor: number } {
    return {
      diffuse: this.currentDiffuse,
      specular: this.currentSpecular,
      blendFactor: this.state.blendFactor,
    };
  }
  
  // ... implementation methods
}
```

### Cubemap Face Rendering

Reuse existing sky shader with different view matrices per face:

```typescript
// View matrices for 6 cubemap faces (+X, -X, +Y, -Y, +Z, -Z)
const CUBEMAP_VIEWS = [
  mat4.lookAt(mat4.create(), [0,0,0], [1,0,0], [0,-1,0]),  // +X
  mat4.lookAt(mat4.create(), [0,0,0], [-1,0,0], [0,-1,0]), // -X
  mat4.lookAt(mat4.create(), [0,0,0], [0,1,0], [0,0,1]),   // +Y
  mat4.lookAt(mat4.create(), [0,0,0], [0,-1,0], [0,0,-1]), // -Y
  mat4.lookAt(mat4.create(), [0,0,0], [0,0,1], [0,-1,0]),  // +Z
  mat4.lookAt(mat4.create(), [0,0,0], [0,0,-1], [0,-1,0]), // -Z
];

// 90° FOV projection for cubemap
const CUBEMAP_PROJ = mat4.perspective(mat4.create(), Math.PI/2, 1, 0.1, 1000);
```

### Diffuse Convolution Compute Shader

```wgsl
// diffuse-convolution.wgsl
// Compute shader: convolve cubemap for diffuse irradiance

@group(0) @binding(0) var inputCubemap: texture_cube<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var outputCubemap: texture_storage_2d_array<rgba16float, write>;

const PI = 3.14159265359;
const SAMPLE_DELTA = 0.05; // Sample spacing in radians

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let faceSize = textureDimensions(outputCubemap).x;
  if (id.x >= faceSize || id.y >= faceSize) { return; }
  
  let faceIndex = id.z;
  let uv = (vec2f(id.xy) + 0.5) / f32(faceSize) * 2.0 - 1.0;
  
  // Get world direction for this texel
  let N = cubemapDirection(faceIndex, uv);
  
  // Hemisphere integration
  var irradiance = vec3f(0.0);
  var sampleCount = 0.0;
  
  // Create tangent space basis
  let up = select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), abs(N.z) < 0.999);
  let tangent = normalize(cross(up, N));
  let bitangent = cross(N, tangent);
  
  // Uniform hemisphere sampling
  for (var phi = 0.0; phi < TWO_PI; phi += SAMPLE_DELTA) {
    for (var theta = 0.0; theta < HALF_PI; theta += SAMPLE_DELTA) {
      // Spherical to cartesian
      let sinTheta = sin(theta);
      let cosTheta = cos(theta);
      let sinPhi = sin(phi);
      let cosPhi = cos(phi);
      
      let tangentSample = vec3f(sinTheta * cosPhi, sinTheta * sinPhi, cosTheta);
      let sampleDir = tangentSample.x * tangent + tangentSample.y * bitangent + tangentSample.z * N;
      
      // Sample sky cubemap
      irradiance += textureSampleLevel(inputCubemap, inputSampler, sampleDir, 0.0).rgb * cosTheta * sinTheta;
      sampleCount += 1.0;
    }
  }
  
  irradiance = PI * irradiance / sampleCount;
  textureStore(outputCubemap, id.xy, faceIndex, vec4f(irradiance, 1.0));
}
```

### Specular Prefilter Compute Shader

```wgsl
// specular-prefilter.wgsl
// Compute shader: prefilter cubemap for specular IBL with varying roughness

@group(0) @binding(0) var inputCubemap: texture_cube<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var outputCubemap: texture_storage_2d_array<rgba16float, write>;

struct Params {
  roughness: f32,
  resolution: f32,
}
@group(0) @binding(3) var<uniform> params: Params;

const PI = 3.14159265359;
const SAMPLE_COUNT = 1024u;

// GGX importance sampling
fn importanceSampleGGX(Xi: vec2f, N: vec3f, roughness: f32) -> vec3f {
  let a = roughness * roughness;
  let phi = 2.0 * PI * Xi.x;
  let cosTheta = sqrt((1.0 - Xi.y) / (1.0 + (a*a - 1.0) * Xi.y));
  let sinTheta = sqrt(1.0 - cosTheta * cosTheta);
  
  let H = vec3f(cos(phi) * sinTheta, sin(phi) * sinTheta, cosTheta);
  
  // Transform to world space
  let up = select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), abs(N.z) < 0.999);
  let tangent = normalize(cross(up, N));
  let bitangent = cross(N, tangent);
  
  return tangent * H.x + bitangent * H.y + N * H.z;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let faceSize = u32(params.resolution);
  if (id.x >= faceSize || id.y >= faceSize) { return; }
  
  let faceIndex = id.z;
  let uv = (vec2f(id.xy) + 0.5) / f32(faceSize) * 2.0 - 1.0;
  let N = cubemapDirection(faceIndex, uv);
  let R = N;
  let V = R;
  
  var prefilteredColor = vec3f(0.0);
  var totalWeight = 0.0;
  
  for (var i = 0u; i < SAMPLE_COUNT; i++) {
    let Xi = hammersley(i, SAMPLE_COUNT);
    let H = importanceSampleGGX(Xi, N, params.roughness);
    let L = normalize(2.0 * dot(V, H) * H - V);
    
    let NdotL = max(dot(N, L), 0.0);
    if (NdotL > 0.0) {
      prefilteredColor += textureSampleLevel(inputCubemap, inputSampler, L, 0.0).rgb * NdotL;
      totalWeight += NdotL;
    }
  }
  
  prefilteredColor /= totalWeight;
  textureStore(outputCubemap, id.xy, faceIndex, vec4f(prefilteredColor, 1.0));
}
```

### Object Shader IBL Sampling

```wgsl
// In object.wgsl - IBL sampling functions

@group(3) @binding(0) var iblDiffuse: texture_cube<f32>;
@group(3) @binding(1) var iblSpecular: texture_cube<f32>;
@group(3) @binding(2) var iblSampler: sampler;
@group(3) @binding(3) var brdfLUT: texture_2d<f32>; // Pre-computed BRDF LUT

fn sampleIBL(N: vec3f, V: vec3f, albedo: vec3f, metallic: f32, roughness: f32) -> vec3f {
  let F0 = mix(vec3f(0.04), albedo, metallic);
  let NdotV = max(dot(N, V), 0.0);
  
  // Diffuse IBL
  let irradiance = textureSample(iblDiffuse, iblSampler, N).rgb;
  let kD = (1.0 - fresnelSchlickRoughness(NdotV, F0, roughness)) * (1.0 - metallic);
  let diffuse = irradiance * albedo * kD;
  
  // Specular IBL
  let R = reflect(-V, N);
  let maxMipLevel = 5.0; // log2(128) - 1
  let mipLevel = roughness * maxMipLevel;
  let prefilteredColor = textureSampleLevel(iblSpecular, iblSampler, R, mipLevel).rgb;
  
  // BRDF LUT: x = NdotV, y = roughness
  let brdf = textureSample(brdfLUT, iblSampler, vec2f(NdotV, roughness)).rg;
  let specular = prefilteredColor * (F0 * brdf.x + brdf.y);
  
  return diffuse + specular;
}
```

### Pipeline Integration

```typescript
// In GPUForwardPipeline.render():

render(encoder: GPUCommandEncoder, scene: Scene, options: RenderOptions): void {
  // 1. Update Dynamic IBL if sun moved
  if (this.dynamicSkyIBL) {
    this.dynamicSkyIBL.markDirtyIfSunMoved(options.sunDirection);
    this.dynamicSkyIBL.update(this.ctx, encoder, this.skyRenderer);
  }
  
  // 2. Shadow pass
  this.shadowPass.execute(encoder, scene, options);
  
  // 3. Sky pass (render to main target + captured by IBL if updating)
  this.skyPass.execute(encoder, options);
  
  // 4. Opaque pass (uses IBL textures)
  const iblTextures = this.dynamicSkyIBL?.getIBLTextures() ?? null;
  this.opaquePass.execute(encoder, scene, {
    ...options,
    iblDiffuse: iblTextures?.diffuse,
    iblSpecular: iblTextures?.specular,
    iblBlendFactor: iblTextures?.blendFactor ?? 0,
  });
  
  // 5. Transparent, post-process, etc.
}
```

### Success Criteria for Phase 2.5

- [ ] Sky cubemap captured correctly (all 6 faces)
- [ ] Diffuse irradiance convolution produces smooth ambient
- [ ] Specular prefilter produces glossy-to-matte reflections
- [ ] IBL updates spread across frames (no frame time spikes)
- [ ] Smooth blend transition when sun moves
- [ ] Objects reflect sky colors correctly
- [ ] Static scenes have zero IBL update cost
- [ ] BRDF LUT pre-generated at startup

### Timeline Estimate

| Task | Effort |
|------|--------|
| DynamicSkyIBL class + double buffering | 1 day |
| Cubemap face rendering | 0.5 day |
| Diffuse convolution compute shader | 0.5 day |
| Specular prefilter compute shader | 1 day |
| Object shader IBL sampling | 0.5 day |
| Pipeline integration + blend | 0.5 day |
| Testing + tuning | 1 day |

**Total: ~5 days**

---

## Phase 3: Wind & Terrain Blend

**Goal:** Port wind animation and terrain blending effects.

### Files to Modify
- `src/core/gpu/shaders/object.wgsl` - Add vertex displacement
- `src/core/gpu/renderers/ObjectRendererGPU.ts` - Wind uniforms

### Implementation Details

1. **Wind Vertex Displacement**
   ```wgsl
   struct WindUniforms {
     enabled: f32,
     time: f32,
     strength: f32,
     _pad0: f32,
     direction: vec2f,
     turbulence: f32,
     influence: f32,
     stiffness: f32,
     anchorHeight: f32,
     windType: f32,  // 0=trunk, 1=leaf, 2=branch
     _pad1: f32,
   }
   ```

2. **Wind Displacement Calculation**
   - Height-based influence (vertices above anchor)
   - Sine wave oscillation
   - Turbulence noise
   - Material-based type (leaf flutter vs branch sway)

3. **Terrain Blending**
   - Sample scene depth texture
   - Compare fragment depth with terrain depth
   - Alpha blend based on depth difference
   - Blend distance parameter

### Per-Object Wind Settings
Store on ModelObject:
- windEnabled: boolean
- windInfluence: number
- windStiffness: number
- windAnchorHeight: number
- leafMaterialIndices: Set<number>
- branchMaterialIndices: Set<number>

---

## Phase 4: Selection & Debug

**Goal:** Selection outline and wireframe rendering.

### Files to Create
- `src/core/gpu/shaders/outline.wgsl` - Outline extrusion shader
- `src/core/gpu/shaders/wireframe.wgsl` - Simple line shader

### Files to Modify
- `src/core/gpu/renderers/ObjectRendererGPU.ts` - Outline pass
- `src/core/gpu/pipeline/GPUForwardPipeline.ts` - Selection rendering

### Implementation Details

1. **Selection Outline**
   - Separate render pass with front-face culling
   - Extrude vertices along normal
   - Solid color (orange)
   - Render before main object pass

2. **Wireframe Mode**
   - Separate pipeline with line topology
   - Generate edge indices from triangle mesh
   - Simple unlit color

3. **Debug Visualizations**
   - Shadow debug: show depth/cascade
   - Wind debug: show displacement magnitude
   - Normal debug: visualize tangent space

---

## File Summary

### New Files
| File | Phase | Description |
|------|-------|-------------|
| `src/core/gpu/renderers/GizmoRendererGPU.ts` | 0 | Gizmo visualization |
| `src/core/gpu/shaders/gizmo.wgsl` | 0 | Gizmo shader |
| `src/core/gpu/shaders/pbr.wgsl` | 1 | PBR functions |
| `src/core/gpu/shaders/common/lighting.wgsl` | 2 | Lighting module |
| `src/core/gpu/shaders/common/shadow.wgsl` | 2 | Shadow module |
| `src/core/gpu/ibl/DynamicSkyIBL.ts` | 2.5 | Dynamic IBL manager |
| `src/core/gpu/ibl/CubemapCapture.ts` | 2.5 | Render sky to cubemap |
| `src/core/gpu/shaders/ibl/diffuse-convolution.wgsl` | 2.5 | Diffuse irradiance compute |
| `src/core/gpu/shaders/ibl/specular-prefilter.wgsl` | 2.5 | Specular mips compute |
| `src/core/gpu/shaders/ibl/sky-to-cubemap.wgsl` | 2.5 | Sky to cubemap face |
| `src/core/gpu/shaders/outline.wgsl` | 4 | Outline shader |
| `src/core/gpu/shaders/wireframe.wgsl` | 4 | Wireframe shader |

### Modified Files
| File | Phase | Changes |
|------|-------|---------|
| `src/core/gpu/shaders/object.wgsl` | 1-3 | Textures, PBR, wind, IBL sampling |
| `src/core/gpu/renderers/ObjectRendererGPU.ts` | 1-4 | Full feature set, IBL textures |
| `src/demos/sceneBuilder/gizmos/TransformGizmoManager.ts` | 0 | WebGPU backend |
| `src/demos/sceneBuilder/Viewport.ts` | 0 | Use GPU gizmos |
| `src/core/gpu/pipeline/GPUForwardPipeline.ts` | 2-4 | Light/shadow/selection, IBL integration |
| `src/core/gpu/renderers/SkyRendererGPU.ts` | 2.5 | Add `renderToCubemapFace()` |
| `src/core/gpu/GPUContext.ts` | 2.5 | Own DynamicSkyIBL instance |
| `src/core/sceneObjects/ModelObject.ts` | 1, 3 | Textures, wind settings |

---

## Dependencies Between Phases

```
Phase 0 (Gizmos)            → Independent
Phase 1 (PBR/Textures)      → Independent  
Phase 2 (HDR Lighting)      → Depends on Phase 1 (PBR functions)
Phase 2.5 (Dynamic Sky IBL) → Depends on Phase 1 (PBR functions) - Independent of Phase 2!
Phase 3 (Wind/Blend)        → Depends on Phase 1 (shader structure)
Phase 4 (Selection)         → Depends on Phase 1 (object pipeline)
```

> **Note:** Phase 2 (HDR/static IBL) and Phase 2.5 (Dynamic Sky IBL) are **independent** of each other.
> They both need Phase 1's PBR infrastructure, but Phase 2.5 does NOT require Phase 2.
> They can be implemented in any order or in parallel.

**Recommended Order:** 0 → 1 → (2 or 2.5) → 3 → 4

---

## Success Criteria

### Phase 0 Complete
- [ ] Gizmos render in WebGPU mode
- [ ] Translate/Rotate/Scale all functional
- [ ] Hover highlighting works
- [ ] No WebGL fallback needed for gizmos

### Phase 1 Complete
- [ ] GLB models display all textures
- [ ] PBR materials look correct
- [ ] Primitives use material uniforms
- [ ] sRGB color space handled

### Phase 2 Complete
- [ ] Directional light with shadows
- [ ] HDR environment reflection
- [ ] IBL diffuse and specular
- [ ] Shadow soft edges (PCF)

### Phase 3 Complete
- [ ] Wind animation on vegetation
- [ ] Per-material wind types
- [ ] Terrain blend on intersecting objects

### Phase 4 Complete
- [ ] Orange outline on selection
- [ ] Wireframe toggle works
- [ ] Debug modes accessible

---

## Timeline Estimate

| Phase | Effort | Notes |
|-------|--------|-------|
| Phase 0 | 1-2 days | Simple geometry, unlit shader |
| Phase 1 | 2-3 days | Texture binding complexity |
| Phase 2 | 2-3 days | IBL and shadows |
| Phase 3 | 1-2 days | Port existing wind logic |
| Phase 4 | 1 day | Simple additional passes |

**Total: ~8-11 days**
