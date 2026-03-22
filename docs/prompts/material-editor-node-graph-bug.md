# Fix: Material Editor Node Graph State Loss

## Bug Description

The material editor's node graph (React Flow) loses nodes and edges when switching between materials or tabs:

1. **Preview node disappears on preset switch**: When switching from a custom material to a preset material and back, the Preview node is missing from the restored graph.

2. **Edge loss on tab switch**: When switching between the Material Editor tab and other sidebar tabs (e.g., Materials list), the edge connecting PBR → Preview sometimes disappears. Data propagation still works (the preview updates), but the visual edge is gone and you can't manually reconnect PBR output to Preview input.

3. **Preview node gone permanently**: In some cases, returning to a custom material after viewing a preset shows only the PBR node with no Preview node at all.

## Likely Root Causes

- **Preset materials have `nodeGraph: null`** in `MaterialDefinition`. When the editor switches to a preset, it may not properly save the current custom material's graph state before clearing it. When switching back, the saved state is lost.

- **React Flow state vs. serialized state mismatch**: The node graph may be serialized (via `onNodesChange`/`onEdgesChange`) at the wrong time, or the restoration from `SerializedNodeGraph` may drop the Preview node or the PBR→Preview edge.

- **Default graph creation**: When `nodeGraph` is null, `MaterialNodeEditor` creates default PBR + Preview nodes with an edge. But this default creation may not fire correctly on every material switch, or may conflict with residual React Flow state.

## Files to Investigate

1. **`src/demos/sceneBuilder/components/panels/MaterialEditorPanel/MaterialNodeEditor.tsx`** — Main node editor component. Look at:
   - How it handles `materialId` changes (the `useEffect` that loads/saves node graphs)
   - The `createDefaultNodes()` function that builds PBR + Preview + edge
   - The `saveCurrentGraph()` / `restoreGraph()` logic
   - React Flow's `onNodesChange` / `onEdgesChange` handlers — are they accidentally saving partial state during transitions?

2. **`src/demos/sceneBuilder/components/panels/MaterialEditorPanel/MaterialEditorView.tsx`** — The parent that manages which material is selected and switches between editor/browser views. Check if material switching triggers proper save→clear→load sequence.

3. **`src/core/materials/types.ts`** — `SerializedNodeGraph` type — ensure the `'preview'` node type is included in `SerializedNode.type` union.

4. **`src/core/materials/MaterialRegistry.ts`** — Check if `updateMaterial()` properly persists the `nodeGraph` field, and if preset materials correctly return `nodeGraph: null`.

5. **`src/demos/sceneBuilder/components/panels/MaterialEditorPanel/nodes/PreviewNode.tsx`** — The `portDef` — ensure the `material` input handle ID matches what the edge serialization expects.

## Reproduction Steps

1. Open the Material Editor panel
2. Create or select a custom material — observe PBR + Preview nodes with connecting edge
3. Switch to a preset material (e.g., "Polished Metal") in the material browser
4. Switch back to the custom material — **Preview node may be missing**
5. Alternatively: switch to a different sidebar tab and back — **edge may disappear**

## Expected Behavior

- Switching between materials should save the current graph and restore the target material's graph (or create default nodes for presets)
- Tab switches should preserve the current graph state without losing nodes or edges
- The PBR → Preview edge should always be present and connectable
