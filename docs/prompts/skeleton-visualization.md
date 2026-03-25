# Feature: Skeleton & Joint Debug Visualization

## Goal

Add a real-time skeleton debug overlay that renders animated bone connections and joint positions as colored lines and points in the 3D viewport. This is essential for debugging skeletal animation issues — verifying that bone hierarchy, joint positions, and animation playback are correct before the skinning shader applies them.

## Requirements

### UI Toggle
- Add a **"Show Skeleton"** checkbox in `AnimationSubPanel.tsx` (the Animation section of the Object Panel)
- When enabled, renders the skeleton overlay on top of the mesh for the selected entity
- Should work whether the animation is playing or paused
- Optional: color-code bones by depth in hierarchy (root=red, tips=green)

### What to Render
1. **Bones (lines)**: Draw a line segment from each joint's world position to its parent joint's world position
2. **Joints (points/spheres)**: Draw a small marker (dot or octahedron) at each joint's world position
3. **Root joint**: Highlight with a different color or larger marker
4. **Joint names**: Optional — show joint name labels on hover (future enhancement)

### Data Source
- Joint world positions come from `SkeletonComponent.globalTransforms` (computed per-frame by `AnimationSystem.computeBoneMatrices`)
- Each joint's world position = column 3 (translation) of `globalTransforms[i * 16 .. i * 16 + 15]`
- The entity's model matrix from `TransformComponent.modelMatrix` must also be applied to transform skeleton from model space to world space
- Parent-child relationships come from `GLBSkeleton.joints[i].parentIndex`

### Rendering Approach

**Option A: CPU line list + existing line renderer (recommended for simplicity)**
- Each frame, extract joint world positions from `globalTransforms`
- Build a line vertex list: for each joint with a parent, add (parentPos, jointPos)
- Render using the existing `GizmoRendererGPU` or a dedicated line-drawing utility
- Pros: Simple, no new shaders needed, works with existing debug rendering
- Cons: CPU overhead for large skeletons (66 joints = 65 lines = negligible)

**Option B: GPU-side skeleton renderer**
- Upload `globalTransforms` as a storage buffer
- Use a vertex shader that reads joint positions from the buffer
- Instance a line per bone, reading parent/child from a joint-pair index buffer
- Pros: Zero CPU per-frame cost
- Cons: More complex setup, probably overkill for a debug tool

### Key Files to Modify/Create

1. **`src/demos/sceneBuilder/components/panels/ObjectPanel/subpanels/AnimationSubPanel.tsx`**
   - Add "Show Skeleton" checkbox
   - Store state in AnimationComponent or a local UI store

2. **`src/core/ecs/components/SkeletonComponent.ts`** (or AnimationComponent)
   - Add `showSkeleton: boolean` flag

3. **New: `src/core/gpu/renderers/SkeletonDebugRenderer.ts`**
   - Takes `SkeletonComponent.globalTransforms`, `GLBSkeleton.joints`, and entity model matrix
   - Extracts world positions, builds line segments
   - Renders using line-list topology or the gizmo renderer
   - Should render after the main scene pass but before post-processing

4. **`src/core/gpu/pipeline/GPUForwardPipeline.ts`** or **`src/demos/sceneBuilder/Viewport.ts`**
   - Call `SkeletonDebugRenderer.render()` when any selected entity has `showSkeleton` enabled

5. **Existing reference: `src/core/gpu/renderers/GizmoRendererGPU.ts`**
   - This already renders colored lines/shapes in the viewport
   - Can be used as a pattern or directly extended for skeleton lines

### Visual Style
- **Bone lines**: 2px width (if supported), solid color
  - Default: cyan/teal for visibility against most materials
  - Alternatively: gradient from parent color to child color
- **Joint dots**: Small circles or 3D octahedra at each joint position
  - Root joint: larger, red/orange
  - Leaf joints: smaller, green
  - Regular joints: medium, cyan
- **Depth-based coloring** (optional): HSL hue mapped from 0 (root) to 120° (deepest leaf)

### Performance Notes
- Only render when `showSkeleton` is true (zero cost when disabled)
- 66 joints = ~65 line segments + 66 point markers = trivial GPU cost
- CPU cost: extracting 66 vec3 positions from Float32Array = negligible
- No need for LOD or culling for skeleton debug overlay

### Integration with Animation Playback
- The skeleton visualization MUST update in real-time as the animation plays
- When paused, it should show the skeleton in its current frozen pose
- Joint positions come from `globalTransforms` which is updated every frame by `AnimationSystem` before `MeshRenderSystem` runs
- The debug renderer should run after the ECS world update but during the render phase

### Testing Checklist
- [ ] Skeleton renders correctly in bind/T-pose (no animation)
- [ ] Skeleton animates smoothly with walk/idle clips
- [ ] Root joint is visually distinct
- [ ] Lines connect correct parent→child pairs
- [ ] Skeleton follows entity transform (translation, rotation, scale)
- [ ] Toggle on/off works without artifacts
- [ ] No performance impact when toggled off
- [ ] Works with paused animations
