# Skeletal Animation Plan — GLB Skinning & ECS Integration

> **Prerequisite:** Player system ECS refactoring (see `docs/player-system-plan.md`) must be
> complete. Character physics (gravity, jump, velocity) are already implemented via
> `CharacterPhysicsComponent`, `CharacterMovementSystem`, and `TerrainCollisionSystem`.
>
> **Asset pipeline:** Mixamo FBX → Blender → glTF/GLB export (with skeleton + animations).

---

## Overview

This plan adds skeletal animation to the engine, covering the full pipeline:
1. **GLBLoader** parses skeleton hierarchy, inverse bind matrices, animation clips, and
   per-vertex skin weights/joint indices from glTF `skin` and `animation` nodes
2. **ECS components** hold skeleton state and animation playback state
3. **AnimationSystem** evaluates animation clips each frame, walks the bone hierarchy,
   and writes final bone matrices to a CPU-side `Float32Array`
4. **GPU pipeline** uploads bone matrices to a storage buffer and applies vertex skinning
   in the WGSL vertex shader via a composable `skinningFeature`

The design keeps skinning as an opt-in shader feature: non-skinned meshes are completely
unaffected. A skinned mesh is just a regular mesh with two extra vertex attributes
(`JOINTS_0`, `WEIGHTS_0`) and a bone matrix buffer binding.

```
┌──────────────────────────────────────────────────────────────────┐
│                        GLB File                                  │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  ┌────────────────┐  │
│  │ Meshes  │  │  Skins   │  │Animations │  │  Textures/Mat  │  │
│  │positions│  │joints[]  │  │channels[] │  │  (unchanged)   │  │
│  │normals  │  │invBindMat│  │timestamps │  │                │  │
│  │JOINTS_0 │  │rootJoint │  │keyframes  │  │                │  │
│  │WEIGHTS_0│  │          │  │           │  │                │  │
│  └────┬────┘  └────┬─────┘  └─────┬─────┘  └───────┬────────┘  │
│       │            │              │                  │           │
└───────┼────────────┼──────────────┼──────────────────┼───────────┘
        │            │              │                  │
        ▼            ▼              ▼                  ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                    GLBModel (parsed)                         │
  │  meshes[].jointIndices    skeleton: GLBSkeleton              │
  │  meshes[].jointWeights    animations: GLBAnimationClip[]     │
  │  (existing fields)        (existing fields)                  │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                    ECS Entity                                │
  │  TransformComponent    MeshComponent (model with skeleton)   │
  │  SkeletonComponent     AnimationComponent                    │
  │  PlayerComponent       CharacterPhysicsComponent             │
  │  CameraComponent       BoundsComponent, VisibilityComponent  │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
  ┌───────────────┐  ┌───────────────────┐  ┌──────────────┐
  │ AnimationSystem│  │CharacterMovement  │  │  Terrain     │
  │ (priority 95) │  │System (pri 20)    │  │  Collision   │
  │               │  │                   │  │  (pri 25)    │
  │ Reads:        │  │ Writes velocity   │  │              │
  │  - physics vel│  │ from input        │  │ Snaps to     │
  │  - isGrounded │  │                   │  │ ground       │
  │               │  └───────────────────┘  └──────────────┘
  │ Determines:   │
  │  idle/walk/   │
  │  run/jump/fall│
  │               │
  │ Evaluates clip│
  │ Writes:       │
  │  boneMatrices │
  │  Float32Array │
  └───────┬───────┘
          │
          ▼
  ┌───────────────────────────────────────────────────────────┐
  │              MeshRenderSystem (priority 100)               │
  │                                                            │
  │  If entity has SkeletonComponent && boneMatrices dirty:    │
  │    Upload boneMatrices → GPU storage buffer                │
  │                                                            │
  │  If mesh has jointIndices + jointWeights:                  │
  │    Use 'skinning' shader variant                           │
  │    Bind bone matrix buffer to @group(2) @binding(N)        │
  │                                                            │
  │  Vertex shader applies:                                    │
  │    skinMatrix = Σ boneMatrices[joint[i]] * weight[i]       │
  │    position = (skinMatrix * vec4(pos, 1)).xyz              │
  │    normal = normalize((skinMatrix * vec4(nrm, 0)).xyz)     │
  └───────────────────────────────────────────────────────────┘
```

---

## Part 1: Loader Types (`src/loaders/types.ts`)

### New Skeleton Types

```typescript
/**
 * A single bone/joint in the skeleton hierarchy.
 * Index order matches the glTF skin.joints[] array.
 */
export interface GLBJoint {
  /** Human-readable name from glTF node (e.g., "mixamorig:Hips") */
  name: string;

  /** Index of this joint in the GLBSkeleton.joints[] array */
  index: number;

  /**
   * Parent joint index in GLBSkeleton.joints[] array.
   * -1 for the root joint (no parent).
   */
  parentIndex: number;

  /** Child joint indices in GLBSkeleton.joints[] array */
  children: number[];

  /**
   * Local bind-pose transform (from glTF node TRS).
   * This is the rest/bind pose of the joint — the default position
   * when no animation is applied.
   */
  localBindTransform: {
    translation: [number, number, number];
    rotation: [number, number, number, number]; // quaternion [x, y, z, w]
    scale: [number, number, number];
  };
}

/**
 * Skeleton data parsed from a glTF `skin` node.
 *
 * The skeleton is a tree of joints (bones). Each joint has a local bind-pose
 * transform and an inverse bind matrix. At runtime, the AnimationSystem
 * computes:
 *
 *   boneMatrix[i] = globalJointTransform[i] × inverseBindMatrix[i]
 *
 * which transforms vertices from bind-pose model space into animated
 * world-relative space.
 */
export interface GLBSkeleton {
  /** Ordered array of joints. Indices match glTF skin.joints[]. */
  joints: GLBJoint[];

  /**
   * Inverse bind matrices — one mat4 per joint.
   * Flat Float32Array of length `joints.length × 16`.
   * Column-major order (same as gl-matrix / glTF).
   *
   * inverseBindMatrix[i] transforms a vertex from model space to
   * joint-local space of joint i in its bind pose.
   */
  inverseBindMatrices: Float32Array;

  /** Index into joints[] for the skeleton root */
  rootJointIndex: number;
}

/**
 * A single animation channel targeting one joint's TRS property.
 */
export interface GLBAnimationChannel {
  /**
   * Index into GLBSkeleton.joints[].
   * -1 if the target node is not part of the skin (non-joint animation).
   */
  jointIndex: number;

  /** Which transform property this channel animates */
  path: 'translation' | 'rotation' | 'scale';

  /**
   * Keyframe timestamps in seconds.
   * Monotonically increasing. First value is typically 0.
   */
  times: Float32Array;

  /**
   * Keyframe values, tightly packed:
   * - translation: 3 floats per keyframe (x, y, z)
   * - rotation:    4 floats per keyframe (x, y, z, w) quaternion
   * - scale:       3 floats per keyframe (x, y, z)
   *
   * For CUBICSPLINE interpolation, each keyframe has 3× the values
   * (in-tangent, value, out-tangent), but LINEAR is the common case.
   */
  values: Float32Array;

  /** Interpolation method from glTF animation sampler */
  interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
}

/**
 * A complete animation clip (e.g., "idle", "Walking", "Running").
 * Contains all channels that animate the skeleton joints over time.
 */
export interface GLBAnimationClip {
  /** Clip name from glTF (e.g., "mixamo.com" for unnamed, or "Idle") */
  name: string;

  /** Total duration in seconds (max timestamp across all channels) */
  duration: number;

  /** All channels in this clip */
  channels: GLBAnimationChannel[];
}
```

### Extended GLBMesh

```typescript
export interface GLBMesh {
  // ... existing fields (positions, normals, uvs, tangents, indices, materialIndex) ...

  /**
   * Joint indices per vertex (from glTF JOINTS_0 attribute).
   * vec4 per vertex — 4 bone influences per vertex.
   * Values are indices into GLBSkeleton.joints[].
   * Uint8Array for ≤256 joints (common), Uint16Array otherwise.
   */
  jointIndices?: Uint8Array | Uint16Array | null;

  /**
   * Joint weights per vertex (from glTF WEIGHTS_0 attribute).
   * vec4 per vertex — sum of weights should be 1.0 for each vertex.
   * Matches jointIndices element-by-element.
   */
  jointWeights?: Float32Array | null;
}
```

### Extended GLBModel

```typescript
export interface GLBModel {
  // ... existing fields (meshes, textures, texturesWithType, materials, nodes) ...

  /**
   * Skeleton hierarchy and bind-pose data.
   * Present only if the glTF file contains a `skin` node.
   * Null for static (non-skinned) models.
   */
  skeleton?: GLBSkeleton | null;

  /**
   * Animation clips parsed from glTF `animations[]`.
   * Empty array if no animations are present.
   * Each clip can be registered in AnimationComponent.clips by name.
   */
  animations?: GLBAnimationClip[];
}
```

---

## Part 2: GLBLoader Changes (`src/loaders/GLBLoader.ts`)

### 2a. Parse JOINTS_0 and WEIGHTS_0 vertex attributes

In the mesh primitive loop, add parsing alongside existing POSITION, NORMAL, etc.:

```typescript
// Inside the primitive loop, after TANGENT parsing:

if (primitive.attributes.JOINTS_0 !== undefined) {
  const rawData = await asset.accessorData(primitive.attributes.JOINTS_0);
  const accessor = gltf.accessors![primitive.attributes.JOINTS_0];
  const bufferView = accessor.bufferView !== undefined
    ? gltf.bufferViews![accessor.bufferView] : null;
  meshData.jointIndices = toTypedArray(rawData, accessor, bufferView) as Uint8Array | Uint16Array;
}

if (primitive.attributes.WEIGHTS_0 !== undefined) {
  const rawData = await asset.accessorData(primitive.attributes.WEIGHTS_0);
  const accessor = gltf.accessors![primitive.attributes.WEIGHTS_0];
  const bufferView = accessor.bufferView !== undefined
    ? gltf.bufferViews![accessor.bufferView] : null;
  meshData.jointWeights = toTypedArray(rawData, accessor, bufferView) as Float32Array;
}
```

### 2b. Parse glTF skin node

After mesh parsing, before scene graph parsing:

```typescript
// Parse skeleton from first skin (most glTF files have one skin)
if (gltf.skins && gltf.skins.length > 0) {
  const skin = gltf.skins[0];
  const jointNodeIndices: number[] = skin.joints; // glTF node indices

  // Build node-index → joint-index mapping
  const nodeToJoint = new Map<number, number>();
  jointNodeIndices.forEach((nodeIdx, jointIdx) => {
    nodeToJoint.set(nodeIdx, jointIdx);
  });

  // Parse inverse bind matrices
  let inverseBindMatrices = new Float32Array(jointNodeIndices.length * 16);
  if (skin.inverseBindMatrices !== undefined) {
    const rawData = await asset.accessorData(skin.inverseBindMatrices);
    const accessor = gltf.accessors![skin.inverseBindMatrices];
    const bufferView = accessor.bufferView !== undefined
      ? gltf.bufferViews![accessor.bufferView] : null;
    inverseBindMatrices = toTypedArray(rawData, accessor, bufferView) as Float32Array;
  } else {
    // Default: identity matrices (uncommon but spec-valid)
    for (let i = 0; i < jointNodeIndices.length; i++) {
      mat4.identity(inverseBindMatrices.subarray(i * 16, (i + 1) * 16) as any);
    }
  }

  // Build joint array from glTF nodes
  const joints: GLBJoint[] = jointNodeIndices.map((nodeIdx, jointIdx) => {
    const node = gltf.nodes![nodeIdx];
    const t = node.translation ?? [0, 0, 0];
    const r = node.rotation ?? [0, 0, 0, 1];
    const s = node.scale ?? [1, 1, 1];

    // Determine parent: walk joint list, check if any joint's glTF node
    // lists this node as a child
    let parentIndex = -1;
    for (let pj = 0; pj < jointNodeIndices.length; pj++) {
      const parentNode = gltf.nodes![jointNodeIndices[pj]];
      if (parentNode.children?.includes(nodeIdx)) {
        parentIndex = pj;
        break;
      }
    }

    // Determine children: which joints have this joint as parent
    const children: number[] = [];
    if (node.children) {
      for (const childNodeIdx of node.children) {
        const childJointIdx = nodeToJoint.get(childNodeIdx);
        if (childJointIdx !== undefined) {
          children.push(childJointIdx);
        }
      }
    }

    return {
      name: node.name ?? `Joint_${jointIdx}`,
      index: jointIdx,
      parentIndex,
      children,
      localBindTransform: {
        translation: [t[0], t[1], t[2]] as [number, number, number],
        rotation: [r[0], r[1], r[2], r[3]] as [number, number, number, number],
        scale: [s[0], s[1], s[2]] as [number, number, number],
      },
    };
  });

  // Find root joint
  const rootJointIndex = joints.findIndex(j => j.parentIndex === -1);

  result.skeleton = {
    joints,
    inverseBindMatrices,
    rootJointIndex: rootJointIndex >= 0 ? rootJointIndex : 0,
  };

  // Store nodeToJoint mapping for animation channel resolution
  result._nodeToJoint = nodeToJoint; // temporary, used during animation parsing
}
```

### 2c. Parse glTF animations

After skeleton parsing:

```typescript
result.animations = [];

if (gltf.animations && result.skeleton) {
  const nodeToJoint = result._nodeToJoint as Map<number, number>;

  for (const anim of gltf.animations) {
    const channels: GLBAnimationChannel[] = [];
    let maxTime = 0;

    for (const channel of anim.channels) {
      const sampler = anim.samplers[channel.sampler];
      const targetNode = channel.target.node;
      const targetPath = channel.target.path; // "translation" | "rotation" | "scale"

      // Skip non-TRS channels (e.g., morph target weights)
      if (!['translation', 'rotation', 'scale'].includes(targetPath)) continue;

      // Resolve joint index
      const jointIndex = targetNode !== undefined ? (nodeToJoint.get(targetNode) ?? -1) : -1;
      if (jointIndex === -1) continue; // Not a skeleton joint, skip

      // Parse timestamps (sampler input)
      const timesRaw = await asset.accessorData(sampler.input);
      const timesAccessor = gltf.accessors![sampler.input];
      const timesBV = timesAccessor.bufferView !== undefined
        ? gltf.bufferViews![timesAccessor.bufferView] : null;
      const times = toTypedArray(timesRaw, timesAccessor, timesBV) as Float32Array;

      // Parse keyframe values (sampler output)
      const valuesRaw = await asset.accessorData(sampler.output);
      const valuesAccessor = gltf.accessors![sampler.output];
      const valuesBV = valuesAccessor.bufferView !== undefined
        ? gltf.bufferViews![valuesAccessor.bufferView] : null;
      const values = toTypedArray(valuesRaw, valuesAccessor, valuesBV) as Float32Array;

      // Track max time for clip duration
      const lastTime = times[times.length - 1];
      if (lastTime > maxTime) maxTime = lastTime;

      channels.push({
        jointIndex,
        path: targetPath as 'translation' | 'rotation' | 'scale',
        times,
        values,
        interpolation: (sampler.interpolation ?? 'LINEAR') as 'LINEAR' | 'STEP' | 'CUBICSPLINE',
      });
    }

    if (channels.length > 0) {
      result.animations.push({
        name: anim.name ?? `Animation_${result.animations.length}`,
        duration: maxTime,
        channels,
      });
    }
  }

  delete result._nodeToJoint; // cleanup temporary
}
```

### 2d. Skip bakeNodeTransforms for skinned meshes

The existing `bakeNodeTransforms()` function must **not** bake transforms into skinned
mesh vertices, because the skeleton handles transforms at runtime:

```typescript
function bakeNodeTransforms(model: GLBModel): void {
  if (!model.nodes || model.nodes.length === 0) return;

  // If model has a skeleton, don't bake — skinning handles transforms
  if (model.skeleton) return;

  // ... existing bake logic (unchanged for static models) ...
}
```

---

## Part 3: ECS Components

### SkeletonComponent (`src/core/ecs/components/SkeletonComponent.ts`)

```typescript
import { Component } from '../Component';
import type { ComponentType } from '../types';
import type { GLBSkeleton } from '../../../loaders/types';

export class SkeletonComponent extends Component {
  readonly type: ComponentType = 'skeleton';

  /** Parsed skeleton hierarchy and bind-pose data (from GLBModel.skeleton) */
  skeleton: GLBSkeleton | null = null;

  /**
   * Current-frame bone matrices.
   * Length = joints.length × 16 (one mat4 per joint, column-major).
   *
   * Each matrix = globalJointTransform × inverseBindMatrix.
   * Written by AnimationSystem each frame.
   * Uploaded to GPU storage buffer by MeshRenderSystem when dirty.
   */
  boneMatrices: Float32Array | null = null;

  /**
   * Workspace for computing global joint transforms.
   * Same layout as boneMatrices (joints.length × 16).
   * Used internally by AnimationSystem — not uploaded to GPU.
   */
  globalTransforms: Float32Array | null = null;

  /** GPU storage buffer for bone matrices (created/managed by MeshRenderSystem) */
  boneBuffer: GPUBuffer | null = null;

  /** Whether bone matrices have been updated this frame and need GPU re-upload */
  dirty = true;

  /**
   * Initialize bone matrix arrays based on skeleton joint count.
   * Call this after setting `skeleton`.
   */
  initBuffers(): void {
    if (!this.skeleton) return;
    const count = this.skeleton.joints.length;
    this.boneMatrices = new Float32Array(count * 16);
    this.globalTransforms = new Float32Array(count * 16);

    // Initialize all to identity
    for (let i = 0; i < count; i++) {
      const offset = i * 16;
      this.boneMatrices[offset + 0] = 1;
      this.boneMatrices[offset + 5] = 1;
      this.boneMatrices[offset + 10] = 1;
      this.boneMatrices[offset + 15] = 1;
      this.globalTransforms[offset + 0] = 1;
      this.globalTransforms[offset + 5] = 1;
      this.globalTransforms[offset + 10] = 1;
      this.globalTransforms[offset + 15] = 1;
    }
  }
}
```

### AnimationComponent (`src/core/ecs/components/AnimationComponent.ts`)

```typescript
import { Component } from '../Component';
import type { ComponentType } from '../types';
import type { GLBAnimationClip } from '../../../loaders/types';

/**
 * Animation state labels.
 * Extensible — add states as needed for different character types.
 */
export type AnimationState = 'idle' | 'walk' | 'run' | 'jump' | 'fall' | 'land';

export class AnimationComponent extends Component {
  readonly type: ComponentType = 'animation';

  // ==================== State Machine ====================

  /** Current animation state (determines which clip plays) */
  currentState: AnimationState = 'idle';

  /** Previous state (for blending transitions) */
  previousState: AnimationState = 'idle';

  /** Playback time within the current clip (seconds) */
  animationTime = 0;

  /** Playback time within the previous clip (for blend source) */
  previousAnimationTime = 0;

  // ==================== Blending ====================

  /** 0 = fully previous clip, 1 = fully current clip */
  blendFactor = 1;

  /** Duration of crossfade transition in seconds */
  blendDuration = 0.2;

  /** Timer tracking blend progress */
  blendTimer = 0;

  // ==================== Clip Registry ====================

  /**
   * Map of state name → animation clip data.
   * Populated from GLBModel.animations on entity creation.
   * Key is the animation state, value is the parsed clip.
   *
   * Example:
   *   clips.set('idle', idleClip);
   *   clips.set('walk', walkClip);
   *   clips.set('run', runClip);
   */
  clips: Map<string, GLBAnimationClip> = new Map();

  /**
   * Mapping from animation state to clip name.
   * Allows remapping when clip names don't match state names.
   * If no entry, uses the state name as the clip key.
   *
   * Example:
   *   stateToClip.set('idle', 'Idle');
   *   stateToClip.set('walk', 'Walking');
   */
  stateToClip: Map<AnimationState, string> = new Map();

  // ==================== Playback Control ====================

  /** Whether to loop the current clip */
  loop = true;

  /** Playback speed multiplier (1.0 = normal) */
  playbackSpeed = 1.0;

  /** Whether animation is paused */
  paused = false;

  /**
   * Whether the animation state is automatically driven by physics.
   * When true, AnimationSystem reads CharacterPhysicsComponent velocity/isGrounded
   * to determine the animation state.
   * When false, the state must be set externally (e.g., for cutscenes).
   */
  autoStateFromPhysics = true;

  // ==================== Speed Thresholds ====================
  // Used by AnimationSystem to map horizontal speed → animation state

  /** Speed below which character plays 'idle' */
  idleThreshold = 0.5;

  /** Speed above which character plays 'run' (between idle and run = 'walk') */
  runThreshold = 7.0;
}
```

### ComponentType additions

Add to `src/core/ecs/types.ts`:

```typescript
export type ComponentType =
  // ... existing types ...
  | 'skeleton'
  | 'animation';
```

---

## Part 4: AnimationSystem (`src/core/ecs/systems/AnimationSystem.ts`)

**Priority:** 95 (after all gameplay/physics at 5-25, before MeshRenderSystem at 100)

**Required components:** `['skeleton', 'animation']`

### Clip Evaluation Algorithm

For each joint in a clip, we need to sample the animation at a given time `t`:

1. **Find keyframe pair** — binary search for the two keyframes that bracket `t`
2. **Compute interpolation factor** — `alpha = (t - t0) / (t1 - t0)`
3. **Interpolate value**:
   - `translation`/`scale`: linear interpolation (`lerp`)
   - `rotation`: spherical linear interpolation (`slerp`) on quaternions
   - `STEP` interpolation: use t0 value (no interpolation)
   - `CUBICSPLINE`: cubic Hermite spline (less common, can defer)

```typescript
/**
 * Sample a single channel at time t.
 * Returns interpolated value (vec3 for translation/scale, vec4 for rotation).
 */
function sampleChannel(
  channel: GLBAnimationChannel,
  time: number,
  outVec: Float32Array, // length 3 or 4
): void {
  const times = channel.times;
  const values = channel.values;
  const compCount = channel.path === 'rotation' ? 4 : 3;

  // Clamp time to clip range
  if (time <= times[0]) {
    for (let i = 0; i < compCount; i++) outVec[i] = values[i];
    return;
  }
  if (time >= times[times.length - 1]) {
    const lastOffset = (times.length - 1) * compCount;
    for (let i = 0; i < compCount; i++) outVec[i] = values[lastOffset + i];
    return;
  }

  // Binary search for keyframe pair
  let lo = 0, hi = times.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) lo = mid; else hi = mid;
  }

  const t0 = times[lo];
  const t1 = times[hi];
  const alpha = (time - t0) / (t1 - t0);

  const offset0 = lo * compCount;
  const offset1 = hi * compCount;

  if (channel.interpolation === 'STEP') {
    for (let i = 0; i < compCount; i++) outVec[i] = values[offset0 + i];
    return;
  }

  // LINEAR interpolation
  if (channel.path === 'rotation') {
    // Spherical linear interpolation for quaternions
    quat.slerp(outVec as any, values.subarray(offset0, offset0 + 4) as any,
               values.subarray(offset1, offset1 + 4) as any, alpha);
  } else {
    // Linear interpolation for translation/scale
    for (let i = 0; i < compCount; i++) {
      outVec[i] = values[offset0 + i] * (1 - alpha) + values[offset1 + i] * alpha;
    }
  }
}
```

### Bone Matrix Computation

After evaluating all channels for all joints, compute the final bone matrices:

```typescript
function computeBoneMatrices(
  skeleton: GLBSkeleton,
  localPoses: Array<{ t: vec3, r: quat, s: vec3 }>,
  globalTransforms: Float32Array, // joints.length * 16
  boneMatrices: Float32Array,     // joints.length * 16
): void {
  const tempLocal = mat4.create();
  const tempGlobal = mat4.create();

  // Process joints in hierarchy order (parents before children).
  // Since joints are stored in the order from glTF skin.joints[],
  // and Mixamo exports them in a proper hierarchy order, we can
  // iterate linearly. If not, topological sort is needed.
  for (const joint of skeleton.joints) {
    const i = joint.index;
    const offset = i * 16;

    // Build local transform from animated TRS
    mat4.fromRotationTranslationScale(
      tempLocal,
      localPoses[i].r,
      localPoses[i].t,
      localPoses[i].s,
    );

    // Compose global transform: parent's global × local
    if (joint.parentIndex >= 0) {
      const parentOffset = joint.parentIndex * 16;
      const parentGlobal = globalTransforms.subarray(parentOffset, parentOffset + 16);
      mat4.multiply(
        globalTransforms.subarray(offset, offset + 16) as unknown as mat4,
        parentGlobal as unknown as mat4,
        tempLocal,
      );
    } else {
      // Root joint: global = local
      globalTransforms.set(tempLocal, offset);
    }

    // Final bone matrix = globalTransform × inverseBindMatrix
    const invBind = skeleton.inverseBindMatrices.subarray(offset, offset + 16);
    mat4.multiply(
      boneMatrices.subarray(offset, offset + 16) as unknown as mat4,
      globalTransforms.subarray(offset, offset + 16) as unknown as mat4,
      invBind as unknown as mat4,
    );
  }
}
```

### State Machine (auto-driven by physics)

```typescript
// In AnimationSystem.update(), for each entity:

if (anim.autoStateFromPhysics) {
  const physics = entity.getComponent<CharacterPhysicsComponent>('character-physics');
  if (physics) {
    const hSpeed = Math.sqrt(physics.velocity[0] ** 2 + physics.velocity[2] ** 2);

    let targetState: AnimationState;
    if (!physics.isGrounded) {
      targetState = physics.velocity[1] > 0 ? 'jump' : 'fall';
    } else if (hSpeed > anim.runThreshold) {
      targetState = 'run';
    } else if (hSpeed > anim.idleThreshold) {
      targetState = 'walk';
    } else {
      targetState = 'idle';
    }

    // Trigger state transition if changed
    if (targetState !== anim.currentState) {
      anim.previousState = anim.currentState;
      anim.previousAnimationTime = anim.animationTime;
      anim.currentState = targetState;
      anim.animationTime = 0;
      anim.blendTimer = 0;
      anim.blendFactor = 0;
    }
  }
}
```

### Full System Update Loop (pseudocode)

```typescript
class AnimationSystem extends System {
  readonly name = 'animation';
  readonly requiredComponents = ['skeleton', 'animation'] as const;
  priority = 95;

  // Reusable workspace to avoid per-frame allocations
  private tempT = vec3.create();
  private tempR = quat.create();
  private tempS = vec3.create();

  update(entities: Entity[], dt: number): void {
    for (const entity of entities) {
      const skel = entity.getComponent<SkeletonComponent>('skeleton');
      const anim = entity.getComponent<AnimationComponent>('animation');
      if (!skel?.skeleton || !skel.boneMatrices || !anim || anim.paused) continue;

      // 1. Auto-determine animation state from physics (see above)
      this.updateStateFromPhysics(entity, anim);

      // 2. Advance animation time
      anim.animationTime += dt * anim.playbackSpeed;
      if (anim.blendTimer < anim.blendDuration) {
        anim.blendTimer += dt;
        anim.blendFactor = Math.min(1, anim.blendTimer / anim.blendDuration);
        anim.previousAnimationTime += dt * anim.playbackSpeed;
      }

      // 3. Resolve clip from state name
      const clipKey = anim.stateToClip.get(anim.currentState) ?? anim.currentState;
      const currentClip = anim.clips.get(clipKey);
      if (!currentClip) continue;

      // Loop the animation
      if (anim.loop && currentClip.duration > 0) {
        anim.animationTime %= currentClip.duration;
      }

      // 4. Evaluate current clip → per-joint local poses
      const skeleton = skel.skeleton;
      const jointCount = skeleton.joints.length;
      const localPoses = this.evaluateClip(currentClip, skeleton, anim.animationTime);

      // 5. If blending, evaluate previous clip and interpolate
      if (anim.blendFactor < 1) {
        const prevClipKey = anim.stateToClip.get(anim.previousState as AnimationState) ?? anim.previousState;
        const prevClip = anim.clips.get(prevClipKey);
        if (prevClip) {
          let prevTime = anim.previousAnimationTime;
          if (anim.loop && prevClip.duration > 0) prevTime %= prevClip.duration;
          const prevPoses = this.evaluateClip(prevClip, skeleton, prevTime);

          // Blend: lerp translations/scales, slerp rotations
          for (let j = 0; j < jointCount; j++) {
            vec3.lerp(localPoses[j].t, prevPoses[j].t, localPoses[j].t, anim.blendFactor);
            quat.slerp(localPoses[j].r, prevPoses[j].r, localPoses[j].r, anim.blendFactor);
            vec3.lerp(localPoses[j].s, prevPoses[j].s, localPoses[j].s, anim.blendFactor);
          }
        }
      }

      // 6. Compute bone matrices (hierarchy walk + inverse bind)
      computeBoneMatrices(skeleton, localPoses, skel.globalTransforms!, skel.boneMatrices);
      skel.dirty = true;
    }
  }

  /**
   * Evaluate all channels of a clip to produce per-joint local TRS poses.
   * Joints not animated by the clip use their bind-pose defaults.
   */
  private evaluateClip(
    clip: GLBAnimationClip,
    skeleton: GLBSkeleton,
    time: number,
  ): Array<{ t: vec3, r: quat, s: vec3 }> {
    // Start from bind pose
    const poses = skeleton.joints.map(j => ({
      t: vec3.fromValues(...j.localBindTransform.translation),
      r: quat.fromValues(...j.localBindTransform.rotation),
      s: vec3.fromValues(...j.localBindTransform.scale),
    }));

    // Apply animated channels on top
    const tempVec = new Float32Array(4);
    for (const ch of clip.channels) {
      if (ch.jointIndex < 0 || ch.jointIndex >= poses.length) continue;
      sampleChannel(ch, time, tempVec);
      const pose = poses[ch.jointIndex];
      switch (ch.path) {
        case 'translation':
          vec3.set(pose.t, tempVec[0], tempVec[1], tempVec[2]);
          break;
        case 'rotation':
          quat.set(pose.r, tempVec[0], tempVec[1], tempVec[2], tempVec[3]);
          break;
        case 'scale':
          vec3.set(pose.s, tempVec[0], tempVec[1], tempVec[2]);
          break;
      }
    }

    return poses;
  }
}
```

---

## Part 5: GPU Pipeline — Vertex Skinning Shader

### 5a. Skinning Feature (`src/core/gpu/shaders/features/skinningFeature.ts`)

This integrates with the existing shader composition system (`ShaderFeature` interface):

```typescript
import type { ShaderFeature } from '../composition/types';

export const skinningFeature: ShaderFeature = {
  id: 'skinning',
  stage: 'vertex',

  resources: [
    {
      name: 'boneMatrices',
      kind: 'storage',
      group: 'perObject',
      provider: 'skeleton',
    },
  ],

  // Additional vertex attributes needed for skinned meshes
  // (these are added to the vertex buffer layout, not declared here in WGSL
  //  because vertex inputs come from the pipeline layout, not bind groups)
  varyings: '', // No extra varyings needed — skinning transforms before model matrix

  functions: `
// ── Skeletal Skinning ──
// boneMatrices is bound as a read-only storage buffer
// @group(?) @binding(?) var<storage, read> boneMatrices: array<mat4x4f>;

fn computeSkinMatrix(joints: vec4u, weights: vec4f) -> mat4x4f {
  return boneMatrices[joints.x] * weights.x
       + boneMatrices[joints.y] * weights.y
       + boneMatrices[joints.z] * weights.z
       + boneMatrices[joints.w] * weights.w;
}

fn applySkinning(pos: vec3f, nrm: vec3f, joints: vec4u, weights: vec4f) -> array<vec3f, 2> {
  let skinMat = computeSkinMatrix(joints, weights);
  let skinnedPos = (skinMat * vec4f(pos, 1.0)).xyz;
  let skinnedNrm = normalize((skinMat * vec4f(nrm, 0.0)).xyz);
  return array<vec3f, 2>(skinnedPos, skinnedNrm);
}
`,

  vertexInject: `
  // Apply skeletal skinning before model matrix transform
  // (jointIndices and jointWeights come from vertex attributes @location(5) and @location(6))
  #ifdef HAS_SKINNING
    let skinResult = applySkinning(localPosition, localNormal, in.jointIndices, in.jointWeights);
    localPosition = skinResult[0];
    localNormal = skinResult[1];
  #endif
`,
};
```

### 5b. Vertex Buffer Layout Changes

When a mesh has `jointIndices` and `jointWeights`, add two extra vertex attributes:

| Location | Attribute | Format | Source |
|---|---|---|---|
| 0 | position | `float32x3` | existing |
| 1 | normal | `float32x3` | existing |
| 2 | uv | `float32x2` | existing |
| 3 | tangent | `float32x4` | existing |
| 4 | (reserved) | — | — |
| **5** | **jointIndices** | **`uint8x4` or `uint16x4`** | **JOINTS_0** |
| **6** | **jointWeights** | **`float32x4`** | **WEIGHTS_0** |

The `VariantMeshPool` needs to:
1. Detect `mesh.jointIndices` and `mesh.jointWeights` on the `GLBMesh`
2. Include them in the interleaved or separate vertex buffer
3. Return a vertex buffer layout descriptor with the extra attributes
4. Tag the mesh variant as "skinned" so `VariantPipelineManager` selects the
   skinning shader variant

### 5c. Bone Matrix GPU Buffer

For each entity with a `SkeletonComponent`:

```typescript
// In MeshRenderSystem, when processing a skinned entity:

if (skeleton.dirty && skeleton.boneMatrices) {
  if (!skeleton.boneBuffer) {
    // Create storage buffer: jointCount × 64 bytes (mat4 = 16 floats × 4 bytes)
    skeleton.boneBuffer = device.createBuffer({
      label: `bone-matrices-${entity.id}`,
      size: skeleton.boneMatrices.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  // Upload bone matrices
  queue.writeBuffer(skeleton.boneBuffer, 0, skeleton.boneMatrices);
  skeleton.dirty = false;
}
```

The bone buffer is bound in the per-object bind group (alongside the model matrix
uniform). The `ShaderComposer` assigns it a binding index automatically based on
the `skinningFeature.resources` declaration.

### 5d. Shadow Pass for Skinned Meshes

The shadow depth pass also needs skinning — animated characters must cast correct
shadows. The shadow vertex shader must apply the same `computeSkinMatrix` transform.

The existing `ShadowPass` / shadow shader template needs a skinning variant:

```wgsl
// In shadow vertex shader (when skinning is active):
let skinMat = computeSkinMatrix(in.jointIndices, in.jointWeights);
let skinnedPos = (skinMat * vec4f(in.position, 1.0)).xyz;
let worldPos = modelMatrix * vec4f(skinnedPos, 1.0);
// ... project to light space as usual
```

This reuses the same `boneMatrices` storage buffer — no duplicate upload needed.

---

## Part 6: Entity Assembly (Updated `createPlayerEntity`)

```typescript
// src/core/ecs/factories.ts — updated createPlayerEntity

export async function createPlayerEntity(
  world: World,
  options: {
    name?: string;
    modelPath: string;              // GLB with skeleton + animations
    position?: [number, number, number];
    moveSpeed?: number;
    runSpeed?: number;
    jumpForce?: number;
    active?: boolean;
    // Animation clip name mapping (state → clip name in GLB)
    clipMapping?: Record<string, string>;
  },
): Promise<Entity> {
  const entity = world.createEntity(options.name ?? 'Player');

  // Standard components
  entity.addComponent(new TransformComponent());
  entity.addComponent(new PlayerComponent({ ... }));
  entity.addComponent(new CharacterPhysicsComponent({ ... }));
  entity.addComponent(new CameraComponent({ ... }));
  entity.addComponent(new BoundsComponent());
  entity.addComponent(new VisibilityComponent());

  // Load character model (GLB with skeleton + animations)
  const { loadGLB, getModelUrl } = await import('../../loaders');
  const url = getModelUrl(options.modelPath);
  const model = await loadGLB(url);

  // MeshComponent
  const mesh = entity.addComponent(new MeshComponent());
  mesh.modelPath = options.modelPath;
  mesh.model = model;

  // MaterialComponent (from GLB materials)
  const material = entity.addComponent(new MaterialComponent());
  material.hasIntrinsicTextures = true;

  // ShadowComponent (character casts shadow)
  const shadow = entity.addComponent(new ShadowComponent());
  shadow.castsShadow = true;

  // SkeletonComponent (from GLBModel.skeleton)
  if (model.skeleton) {
    const skel = entity.addComponent(new SkeletonComponent());
    skel.skeleton = model.skeleton;
    skel.initBuffers();
  }

  // AnimationComponent (from GLBModel.animations)
  if (model.animations && model.animations.length > 0) {
    const anim = entity.addComponent(new AnimationComponent());

    for (const clip of model.animations) {
      anim.clips.set(clip.name, clip);
    }

    // Apply clip name mapping if provided
    if (options.clipMapping) {
      for (const [state, clipName] of Object.entries(options.clipMapping)) {
        anim.stateToClip.set(state as AnimationState, clipName);
      }
    }
  }

  return entity;
}
```

### Mixamo Clip Naming Convention

Mixamo exports typically have clip names like:
- `"mixamo.com"` (default, unnamed)
- `"Idle"`, `"Walking"`, `"Running"`, `"Jump"` (when named in Mixamo)

When downloading from Mixamo, name your animations before downloading. If using
the default `"mixamo.com"` name, you'll need the `clipMapping` to map states:

```typescript
const player = await createPlayerEntity(world, {
  modelPath: 'models/character.glb',
  clipMapping: {
    idle: 'Idle',
    walk: 'Walking',
    run: 'Running',
    jump: 'Jump',
    fall: 'Falling',
  },
});
```

Alternatively, if each animation is in a separate GLB file (common Mixamo workflow),
load them separately and register clips:

```typescript
const idleModel = await loadGLB('models/character-idle.glb');
const walkModel = await loadGLB('models/character-walk.glb');
const runModel  = await loadGLB('models/character-run.glb');

const anim = player.getComponent<AnimationComponent>('animation');
anim.clips.set('idle', idleModel.animations![0]);
anim.clips.set('walk', walkModel.animations![0]);
anim.clips.set('run',  runModel.animations![0]);
```

---

## System Execution Order (Complete)

```
Priority  5  — PlayerSystem             input reading, yaw/pitch, WASD → inputDirection
Priority  6  — CameraSystem             view/projection matrices
Priority  7  — TransformSystem          hierarchy propagation
Priority 10  — BoundsSystem             AABB computation
Priority 10  — LODSystem                LOD from camera distance
Priority 20  — CharacterMovementSystem  velocity, gravity, jump, position integration
Priority 25  — TerrainCollisionSystem   heightmap sampling, ground snap, bounds clamp
Priority 50  — WindSystem               wind spring physics
Priority 55  — WetnessSystem            wetness from ocean proximity
Priority 80  — LightingSystem           light direction/color computation
Priority 85  — FrustumCullSystem        visibility culling
Priority 90  — ShadowCasterSystem       shadow caster collection
Priority 95  — AnimationSystem          ← NEW: clip eval, bone matrix computation
Priority 95  — SSRSystem                LOD-gated SSR
Priority 96  — ReflectionProbeSystem    probe bake lifecycle
Priority 100 — MeshRenderSystem         shader variants, GPU upload, bone buffer upload
```

AnimationSystem at priority 95 runs after all gameplay/physics systems have finalized
the character's velocity and grounding state, and before MeshRenderSystem uploads
bone matrices to the GPU.

---

## What Existing Systems Handle Automatically

| Feature | Skinned Mesh? | Notes |
|---|---|---|
| PBR rendering | ✅ Same materials | Skinning only affects vertex positions |
| Shadow casting | ✅ With skinning variant | Shadow shader needs bone matrices too |
| Shadow receiving | ✅ Automatic | Fragment shader unchanged |
| IBL ambient | ✅ Automatic | Fragment shader unchanged |
| Wind (cloak/hair) | ⚠️ Future | Could layer wind displacement on top of skinned positions |
| Frustum culling | ✅ Via BoundsComponent | Bounds should use animated AABB (future improvement) |
| LOD | ✅ Automatic | Distance-based, works with any mesh |

---

## Part 7: Animation Library — Separated Mesh & Animation Assets

### Overview

The plan supports two asset workflows:

1. **All-in-one GLB**: mesh + skeleton + animations in a single file (simple, good for prototyping)
2. **Separated assets**: mesh+skeleton in one GLB, animations in separate GLBs (production workflow)

Workflow #2 enables **animation reuse** — a shared set of humanoid animations (idle, walk,
run, jump) can be applied to any character that shares the same skeleton topology (e.g., all
Mixamo characters use the same 65-joint skeleton).

### Asset Organization

```
public/models/characters/
  warrior/
    warrior.glb              ← mesh + armature + skinning (NO animations)
  mage/
    mage.glb                 ← different character, same Mixamo skeleton
  
  animations/
    humanoid/                ← shared across all Mixamo humanoid characters
      idle.glb              ← armature + animation ONLY (no mesh)
      walk.glb
      run.glb
      jump.glb
      fall.glb
```

### Blender Export Settings

**Character GLB** (mesh + skeleton, no animations):
- Export → glTF 2.0 (.glb)
- Include: ☑ Mesh, ☑ Armature, ☐ Animation
- Result: geometry, skeleton hierarchy, inverse bind matrices, JOINTS_0/WEIGHTS_0

**Animation-only GLB** (skeleton + animation, no mesh):
- Export → glTF 2.0 (.glb)
- Include: ☐ Mesh, ☑ Armature, ☑ Animation
- Result: skeleton hierarchy + animation channels (very small, ~50-200KB per clip)

### GLBLoader: Handle Animation-Only Files

The loader already handles this naturally — an animation-only GLB simply has:
- `gltf.meshes = []` (no mesh primitives)
- `gltf.skins[0]` present (skeleton hierarchy)
- `gltf.animations[0]` present (keyframe data)

The parsed `GLBModel` will have:
- `meshes: []` — empty, no geometry
- `skeleton: GLBSkeleton` — present, has joint hierarchy
- `animations: [GLBAnimationClip]` — present, has channels targeting joints

No special loader changes needed. The existing parsing code naturally handles this case.

### Skeleton Compatibility Validation

When loading animation clips from a separate file and applying them to a character,
the skeletons must be compatible. Add a utility function:

```typescript
// src/loaders/types.ts or a new src/core/animation/utils.ts

/**
 * Check if an animation's skeleton is compatible with a character's skeleton.
 * Compatible means: same number of joints, same names, same hierarchy.
 *
 * @param meshSkeleton - The character's skeleton (from mesh+armature GLB)
 * @param animSkeleton - The animation source's skeleton (from animation-only GLB)
 * @returns true if animations can be applied to the character
 */
function isSkeletonCompatible(
  meshSkeleton: GLBSkeleton,
  animSkeleton: GLBSkeleton,
): boolean {
  if (meshSkeleton.joints.length !== animSkeleton.joints.length) return false;
  for (let i = 0; i < meshSkeleton.joints.length; i++) {
    if (meshSkeleton.joints[i].name !== animSkeleton.joints[i].name) return false;
    if (meshSkeleton.joints[i].parentIndex !== animSkeleton.joints[i].parentIndex) return false;
  }
  return true;
}

/**
 * Remap animation channels from one skeleton ordering to another.
 * Needed when joint ordering differs between mesh and animation GLBs
 * (uncommon with Mixamo but possible with hand-authored rigs).
 *
 * @param clip - The animation clip to remap
 * @param sourceJoints - Joint names from the animation source skeleton
 * @param targetJoints - Joint names from the character's skeleton
 * @returns Remapped clip with jointIndex values corrected for the target skeleton
 */
function remapAnimationClip(
  clip: GLBAnimationClip,
  sourceJoints: GLBJoint[],
  targetJoints: GLBJoint[],
): GLBAnimationClip {
  // Build name → target index mapping
  const nameToTargetIndex = new Map<string, number>();
  for (const joint of targetJoints) {
    nameToTargetIndex.set(joint.name, joint.index);
  }

  const remappedChannels = clip.channels.map(ch => {
    const sourceName = sourceJoints[ch.jointIndex]?.name;
    const targetIndex = sourceName ? (nameToTargetIndex.get(sourceName) ?? -1) : -1;
    return { ...ch, jointIndex: targetIndex };
  }).filter(ch => ch.jointIndex >= 0); // Drop channels for joints that don't exist in target

  return {
    name: clip.name,
    duration: clip.duration,
    channels: remappedChannels,
  };
}
```

### Convenience: `loadAnimationClips()` Helper

Add a dedicated function for loading animation-only GLBs:

```typescript
// src/loaders/GLBLoader.ts

/**
 * Load animation clips from a GLB file (animation-only or full model).
 * Returns parsed animation clips with their source skeleton for compatibility checking.
 *
 * For animation-only GLBs (no mesh), this is the primary loading function.
 * For full model GLBs, this extracts just the animation data.
 *
 * @param url - URL to the GLB file containing animations
 * @returns Object with clips array and source skeleton
 */
export async function loadAnimationClips(
  url: string,
): Promise<{
  clips: GLBAnimationClip[];
  skeleton: GLBSkeleton | null;
}> {
  const model = await loadGLB(url);
  return {
    clips: model.animations ?? [],
    skeleton: model.skeleton ?? null,
  };
}
```

### Updated Entity Assembly: Separate Character + Animation Loading

```typescript
// Example: create a warrior with shared humanoid animations

const characterModel = await loadGLB('models/characters/warrior/warrior.glb');
const { clips: idleClips, skeleton: idleSkel } = await loadAnimationClips('models/characters/animations/humanoid/idle.glb');
const { clips: walkClips, skeleton: walkSkel } = await loadAnimationClips('models/characters/animations/humanoid/walk.glb');
const { clips: runClips }  = await loadAnimationClips('models/characters/animations/humanoid/run.glb');
const { clips: jumpClips } = await loadAnimationClips('models/characters/animations/humanoid/jump.glb');

// Verify skeleton compatibility
if (characterModel.skeleton && idleSkel) {
  if (!isSkeletonCompatible(characterModel.skeleton, idleSkel)) {
    console.warn('Animation skeleton does not match character skeleton!');
  }
}

// Register clips on the AnimationComponent
const anim = entity.getComponent<AnimationComponent>('animation');
anim.clips.set('idle', idleClips[0]);
anim.clips.set('walk', walkClips[0]);
anim.clips.set('run',  runClips[0]);
anim.clips.set('jump', jumpClips[0]);
```

### Updated `createPlayerEntity` Factory

The factory should support both workflows:

```typescript
export async function createPlayerEntity(
  world: World,
  options: {
    name?: string;
    modelPath: string;                    // GLB with mesh + skeleton
    position?: [number, number, number];
    active?: boolean;
    // Option A: all-in-one (animations embedded in modelPath GLB)
    clipMapping?: Record<string, string>; // state → embedded clip name
    // Option B: separated animations (loaded from separate GLBs)
    animationPaths?: Record<string, string>; // state → animation GLB path
  },
): Promise<Entity> {
  const characterModel = await loadGLB(options.modelPath);
  // ... create entity, add mesh/skeleton components ...

  const anim = entity.addComponent(new AnimationComponent());

  // Option A: clips from the character GLB itself
  if (characterModel.animations) {
    for (const clip of characterModel.animations) {
      anim.clips.set(clip.name, clip);
    }
    if (options.clipMapping) {
      for (const [state, clipName] of Object.entries(options.clipMapping)) {
        anim.stateToClip.set(state as AnimationState, clipName);
      }
    }
  }

  // Option B: load clips from separate GLBs
  if (options.animationPaths) {
    for (const [state, path] of Object.entries(options.animationPaths)) {
      const { clips, skeleton: animSkel } = await loadAnimationClips(path);
      if (clips.length > 0) {
        // Validate skeleton compatibility
        if (characterModel.skeleton && animSkel) {
          if (!isSkeletonCompatible(characterModel.skeleton, animSkel)) {
            console.warn(`[createPlayerEntity] Skeleton mismatch for '${state}' animation: ${path}`);
            continue;
          }
        }
        anim.clips.set(state, clips[0]);
      }
    }
  }

  return entity;
}
```

Usage:
```typescript
// All-in-one workflow
const player = await createPlayerEntity(world, {
  modelPath: 'models/characters/warrior-with-anims.glb',
  clipMapping: { idle: 'Idle', walk: 'Walking', run: 'Running' },
});

// Separated assets workflow (preferred for production)
const player = await createPlayerEntity(world, {
  modelPath: 'models/characters/warrior/warrior.glb',
  animationPaths: {
    idle: 'models/characters/animations/humanoid/idle.glb',
    walk: 'models/characters/animations/humanoid/walk.glb',
    run:  'models/characters/animations/humanoid/run.glb',
    jump: 'models/characters/animations/humanoid/jump.glb',
    fall: 'models/characters/animations/humanoid/fall.glb',
  },
});
```

### Animation Clip Caching

When multiple characters share the same animation clips, the `GLBAnimationClip` data
(timestamps + keyframe values) should be loaded once and shared by reference:

```typescript
// Simple cache keyed by URL
const animationClipCache = new Map<string, GLBAnimationClip[]>();

async function loadAnimationClipsCached(url: string): Promise<GLBAnimationClip[]> {
  if (animationClipCache.has(url)) return animationClipCache.get(url)!;
  const { clips } = await loadAnimationClips(url);
  animationClipCache.set(url, clips);
  return clips;
}
```

This means 50 characters sharing the same "walk" clip → only one copy of the keyframe
data in memory. Each character has its own `AnimationComponent` (playback state, blend
timers) but references the same `GLBAnimationClip` data. This is safe because clips are
read-only after loading.

---

## Edge Cases and Gotchas

### 1. Joint ordering

glTF spec does not guarantee parents appear before children in `skin.joints[]`.
Mixamo exports are well-ordered, but in general we should either:
- Verify parent-first ordering at load time
- Or topologically sort joints once during `GLBSkeleton` construction

### 2. Bind pose vs. rest pose

The `inverseBindMatrix` transforms from model space → joint space. If the model
was exported in T-pose, the bind pose IS the T-pose. If the model was exported in
A-pose, the bind pose is A-pose. The animation clips encode delta from bind pose.
This is handled correctly as long as we start from bind-pose TRS as defaults.

### 3. Quaternion normalization

After slerp/lerp blending, quaternions can drift from unit length. Normalize after
blending to prevent accumulating error.

### 4. Multiple skins per model

glTF allows multiple skins. For simplicity, we parse only `skins[0]`. This covers
99% of character models. Multi-skin support can be added later if needed.

### 5. Morph targets (blend shapes)

Not covered in this plan. Morph targets are a separate glTF feature
(`mesh.primitives[].targets`) used for facial expressions, etc. Can be added
independently as a `MorphTargetComponent` + compute shader in the future.

### 6. GPU skinning buffer size limits

WebGPU storage buffers have a minimum max size of 128MB. A typical Mixamo character
has ~65 joints × 64 bytes/matrix = 4,160 bytes per entity. Even 100 animated
characters = ~416KB, well within limits.

---

## File Structure

```
src/loaders/
  types.ts                          ← Extended: GLBJoint, GLBSkeleton, GLBAnimationChannel,
                                      GLBAnimationClip, GLBMesh.jointIndices/jointWeights,
                                      GLBModel.skeleton/animations
  GLBLoader.ts                      ← Extended: parse JOINTS_0, WEIGHTS_0, skins, animations

src/core/ecs/
  types.ts                          ← Extended: 'skeleton' | 'animation' in ComponentType
  components/
    SkeletonComponent.ts            ← NEW: skeleton hierarchy, boneMatrices, GPU buffer ref
    AnimationComponent.ts           ← NEW: state machine, clip registry, blend state
  systems/
    AnimationSystem.ts              ← NEW: clip evaluation, bone matrix computation

src/core/gpu/
  shaders/
    features/
      skinningFeature.ts            ← NEW: shader feature for vertex skinning
    templates/
      object-template.wgsl          ← Modified: skinning injection point in vertex main
  pipeline/
    VariantMeshPool.ts              ← Modified: skinned vertex layout with JOINTS_0/WEIGHTS_0
    VariantPipelineManager.ts       ← Modified: skinning pipeline variant
  renderers/
    (MeshRenderSystem handles bone buffer upload)
```

---

## Implementation Order

| Step | What | Files | Effort | Dependencies |
|------|------|-------|--------|--------------|
| 1 | Extend `types.ts` with skeleton/animation types | `src/loaders/types.ts` | 0.5 day | None |
| 2 | Extend `GLBLoader` to parse skins, animations, JOINTS_0/WEIGHTS_0 | `src/loaders/GLBLoader.ts` | 1–2 days | Step 1 |
| 3 | Create `SkeletonComponent` + `AnimationComponent` | `src/core/ecs/components/` | 0.5 day | Step 1 |
| 4 | Create `AnimationSystem` (clip eval, hierarchy walk, bone matrices) | `src/core/ecs/systems/` | 2 days | Steps 2, 3 |
| 5 | Add `skinningFeature` to shader composition | `src/core/gpu/shaders/features/` | 1 day | Step 3 |
| 6 | Extend `VariantMeshPool` for skinned vertex layout + bone buffer | `src/core/gpu/pipeline/` | 1–2 days | Steps 2, 5 |
| 7 | Extend shadow pass for skinned meshes | `src/core/gpu/pipeline/passes/` | 0.5 day | Steps 5, 6 |
| 8 | Update `createPlayerEntity` factory + test with Mixamo GLB | `src/core/ecs/factories.ts` | 1 day | Steps 1–7 |

**Total: ~7–9 days**

Steps 1–3 are data plumbing (straightforward). Step 4 (AnimationSystem) is the core
algorithmic work. Steps 5–7 are GPU integration. Step 8 is the integration test.
