# Fix: Selection Outline Shows T-Pose for Skinned Meshes

## Problem

The selection outline (orange border around selected objects) shows the mesh in its bind/T-pose instead of the current animated pose. This is because the selection mask rendering pass (`ObjectRendererGPU.renderSelectionMask()`) uses a hardcoded pipeline that only reads vertex positions without applying skeletal skinning.

## Root Cause

`ObjectRendererGPU.renderSelectionMask()` renders selected meshes to a binary mask texture using a simple vertex shader that reads `position` from vertex buffer slot 0 and transforms by `viewProjection × model`. It has:
- **1 vertex buffer** (interleaved position+normal+uv, 32 bytes/vertex)
- **No skin vertex buffer** (slot 1 with joint indices + weights)
- **No bone matrices** storage buffer binding
- **No skinning vertex shader code**

So skinned meshes are rendered in their bind pose (T-pose) in the selection mask, producing an outline that doesn't match the animated mesh.

## Fix Strategy

Create a **skinned variant** of the selection mask pipeline that applies bone transforms in the vertex shader, matching the main rendering path.

### Files to Modify

1. **`src/core/gpu/renderers/ObjectRendererGPU.ts`** — `ensureSelectionMaskPipeline()` and `renderSelectionMask()`
   
   Changes needed:
   - Add a second pipeline: `selectionMaskSkinnedPipeline` with 2 vertex buffer descriptors
   - Add a storage buffer binding in Group 2 for `boneMatrices: array<mat4x4f>`
   - Add a skinned vertex shader variant that includes `computeSkinMatrix` and `applySkinning`
   - In `renderSelectionMask()`: detect if mesh is skinned (via `VariantMeshPool.isSkinned(meshId)`), use the skinned pipeline, bind the skin vertex buffer at slot 1, and bind the bone matrices storage buffer

### Implementation Details

#### Skinned Selection Mask Vertex Shader
```wgsl
// Same globals as non-skinned (Group 0: viewProjection + cameraPos)
// Same per-mesh (Group 1: model matrix)
// NEW: Group 2: bone matrices storage buffer
@group(2) @binding(0) var<storage, read> boneMatrices: array<mat4x4f>;

struct VertexInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(5) jointIndices: vec4u,   // from skin buffer slot 1
  @location(6) jointWeights: vec4f,   // from skin buffer slot 1
}

fn computeSkinMatrix(joints: vec4u, weights: vec4f) -> mat4x4f {
  return boneMatrices[joints.x] * weights.x
       + boneMatrices[joints.y] * weights.y
       + boneMatrices[joints.z] * weights.z
       + boneMatrices[joints.w] * weights.w;
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let skinMat = computeSkinMatrix(input.jointIndices, input.jointWeights);
  let skinnedPos = (skinMat * vec4f(input.position, 1.0)).xyz;
  let worldPos = singleModel.model * vec4f(skinnedPos, 1.0);
  output.position = globals.viewProjection * worldPos;
  return output;
}
```

#### Pipeline Layout Changes
- Group 0: Global uniforms (existing)
- Group 1: Model matrix (existing)
- Group 2: Bone matrices storage buffer (NEW — only for skinned variant)

#### Vertex Buffer Layout (skinned variant)
- Slot 0: Standard interleaved (position+normal+uv) — 32 bytes, same as non-skinned
- Slot 1: Skin buffer (uint8x4 joints + float32x4 weights) — 20 bytes, from `VariantMeshPool.getSkinBuffer()`

#### Draw Call Changes in `renderSelectionMask()`
```typescript
for (const meshId of this.selectedMeshIds) {
  const mesh = this.meshes.get(meshId);
  if (!mesh) continue;

  const isSkinned = this.ctx.variantMeshPool.isSkinned(meshId);
  
  if (isSkinned) {
    passEncoder.setPipeline(this.selectionMaskSkinnedPipeline);
    // Bind skin vertex buffer at slot 1
    const skinBuffer = this.ctx.variantMeshPool.getSkinBuffer(meshId);
    if (skinBuffer) passEncoder.setVertexBuffer(1, skinBuffer);
    // Bind bone matrices at Group 2
    // ... create bind group from mesh's boneMatrices texture resource
  } else {
    passEncoder.setPipeline(this.selectionMaskPipeline);
  }
  
  // ... rest of draw call
}
```

### Key Considerations
- The bone matrices buffer is stored as a texture resource on the mesh via `setTextureResource(meshId, RES.BONE_MATRICES, { buffer })` in `MeshComponent.initBoneBuffer()`
- Need to look up the bone buffer from `VariantMeshPool`'s texture resources for the mesh
- The skinned pipeline needs a `GPUBindGroupLayout` for Group 2 with one storage buffer binding
- Fragment shader stays the same (just output r=1.0 for the mask)
