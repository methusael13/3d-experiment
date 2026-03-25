# Debug: Skeletal Animation Bone Matrix Distortion

## Problem

Skinned meshes render with severe distortion when bone matrices are applied. The mesh looks correct as a T-pose when skinning is bypassed in the shader, confirming the issue is **exclusively in the CPU-side bone matrix computation** (`computeBoneMatrices` in `AnimationSystem.ts`), not in the GPU pipeline.

## What's Been Verified Working

- ✅ GLBLoader correctly parses skeleton, animations, JOINTS_0, WEIGHTS_0
- ✅ Vertex data alignment: positions=8722v, joints=8722v (Uint16Array), weights=8722v
- ✅ Joint index range: 0–65 (66 joints total, all valid)
- ✅ Skin vertex buffer (Buffer 1) created correctly with `setSkinBuffer()`
- ✅ Bone matrix GPU storage buffer created and registered via `setTextureResource()`
- ✅ Pipeline has 2 vertex buffer descriptors for skinned variants
- ✅ Skin buffer bound at slot 1 in both color and depth passes
- ✅ Bone buffer bound at binding 14 in Group 2 (textures)
- ✅ Per-frame bone upload via `MeshRenderSystem.uploadBoneMatrices()`
- ✅ WGSL `computeSkinMatrix` and `applySkinning` functions compile and execute
- ✅ **T-pose renders correctly when skinning is bypassed** (shader reads `input.position` directly)

## What's Broken

When `computeBoneMatrices()` produces bone matrices and they're uploaded to the GPU, the mesh is severely distorted — stretched triangles reaching extreme positions. This happens **even with identity bone matrices from `initBoneBuffer()`** being overwritten by the AnimationSystem, AND even when the AnimationComponent is paused.

## Key Files to Investigate

1. **`src/core/ecs/systems/AnimationSystem.ts`** — `computeBoneMatrices()` function (lines ~100-160)
   - Walks the joint hierarchy in topological order
   - Builds local transform from animated TRS via `mat4.fromRotationTranslationScale`
   - Composes global = parent.global × local
   - Computes `boneMatrix[i] = globalTransform[i] × inverseBindMatrix[i]`

2. **`src/core/ecs/components/MeshComponent.ts`** — `initBoneBuffer()` (lines ~240-280)
   - Creates GPU buffer initialized to identity matrices
   - Registers as `RES.BONE_MATRICES` texture resource

3. **`src/core/ecs/systems/MeshRenderSystem.ts`** — `uploadBoneMatrices()` (lines ~250-260)
   - Uploads `skeleton.boneMatrices` to GPU when `skeleton.dirty` is true

4. **`src/loaders/GLBLoader.ts`** — Skeleton and inverse bind matrix parsing

## Debugging Steps

### Step 1: Verify bind-pose bone matrices should be identity

When evaluation starts from bind-pose TRS defaults (no animation), `computeBoneMatrices` should produce identity for each joint:
- `localTransform[i]` = mat4 from bind-pose TRS
- `globalTransform[i]` = parent.global × localTransform[i]  
- `boneMatrix[i]` = globalTransform[i] × inverseBindMatrix[i]

For the bind pose, `globalTransform[i]` should equal the bind-pose world transform, and `inverseBindMatrix[i]` should be its inverse. So `boneMatrix[i]` should be identity.

**Add logging:** After `computeBoneMatrices` runs, log the first 3 bone matrices. They should all be approximately identity (diagonal = 1, off-diagonal ≈ 0). If they're not, the issue is in how inverse bind matrices or local bind transforms are loaded.

### Step 2: Check gl-matrix mat4 column-major convention

gl-matrix uses column-major layout. glTF also uses column-major for inverse bind matrices. Verify:
- `mat4.fromRotationTranslationScale(out, quat, vec3, vec3)` — does it produce column-major output compatible with how we store/read `globalTransforms`?
- `mat4.multiply(out, a, b)` — is the order correct? We want `out = a × b` (parent × child for global, global × invBind for bone).

### Step 3: Check if the MeshComponent bone buffer is being overwritten

The `initBoneBuffer()` in MeshComponent initializes bone matrices to identity. Then `MeshRenderSystem.uploadBoneMatrices()` overwrites them from `SkeletonComponent.boneMatrices` when dirty. The SkeletonComponent's `initBuffers()` also initializes to identity, but `computeBoneMatrices()` overwrites those per frame.

**Quick test:** In `MeshRenderSystem.uploadBoneMatrices()`, temporarily skip the upload (comment out `meshComp.uploadBoneMatrices(...)`) to keep the GPU buffer at its initial identity state. If the mesh renders as T-pose, this confirms the bug is in `computeBoneMatrices`. If still distorted, the initial identity in `initBoneBuffer()` is somehow wrong.

### Step 4: Check inverse bind matrix loading

In `GLBLoader.ts`, inverse bind matrices are loaded from the glTF accessor. Verify:
- The accessor data is correctly copied (not sharing a buffer view with other data that gets offset)
- The Float32Array has the correct length (joints.length × 16)
- Values look reasonable (no NaN, no extremely large numbers)

### Step 5: Verify that `skin.skeleton` armature node is handled

Some glTF files have `skin.skeleton` pointing to an armature node whose world transform needs to be incorporated. If the skeleton root joint is a child of an armature node with a non-identity transform, the bone hierarchy walk needs to include that transform as the initial `globalTransform` for the root joint, rather than starting from identity.

Check: In the GLBLoader skeleton parsing, does it handle `skin.skeleton` (the armature root node index)? If the armature node has a rotation (e.g., Blender's coordinate system conversion), that rotation needs to be the "parent transform" of the skeleton root in `computeBoneMatrices`.

## Expected Behavior

When `computeBoneMatrices` produces correct results:
- **Bind pose (no animation):** All bone matrices ≈ identity → mesh in T-pose (same as bypassed skinning)
- **Animated:** Bone matrices transform vertices from bind-pose to current animation pose → smooth humanoid movement
