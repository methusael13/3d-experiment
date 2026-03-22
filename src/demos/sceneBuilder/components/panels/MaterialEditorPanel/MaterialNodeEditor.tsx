/**
 * MaterialNodeEditor - Center panel in the Materials tab
 * 
 * Visual node-based material editor using React Flow (@xyflow/react).
 * Shows a node graph for the currently selected material in the registry.
 * 
 * Node types:
 * - PBR Node: Central material definition with all PBR inputs
 * - Texture Set Node: Multi-output from asset library texture packs
 * - Color Node: Solid color picker
 * - Number Node: Scalar value slider
 * - Preview Node: 2D material preview
 * 
 * Persistence strategy:
 * A single useEffect watches `nodes` and `edges` and auto-saves the
 * serialized graph to the registry whenever either changes.  A load-version
 * counter and `isMountedRef` guard prevent saves during material-switch
 * reconciliation and component teardown, which is where React Flow fires
 * synthetic remove-changes that would otherwise overwrite the real graph
 * with an empty one.
 */

import { useState, useCallback, useEffect, useRef } from 'preact/hooks';
import { useComputed } from '@preact/signals';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type NodeTypes,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { getMaterialRegistry } from '@/core/materials';
import type { MaterialDefinition, SerializedNodeGraph } from '@/core/materials/types';
import {
  type NodePortDef,
  resolveOutput,
  applyInput,
  isConnectionValid,
} from './nodes/portTypes';
import { PBRNode, portDef as pbrPortDef, extractTextureRefs, extractPBRScalars } from './nodes/PBRNode';
import { ColorNode, portDef as colorPortDef } from './nodes/ColorNode';
import { NumberNode, portDef as numberPortDef } from './nodes/NumberNode';
import { TextureSetNode, portDef as textureSetPortDef } from './nodes/TextureSetNode';
import { PreviewNode, portDef as previewPortDef } from './nodes/PreviewNode';
import { ChannelPackNode, portDef as channelPackPortDef } from './nodes/ChannelPackNode';
import styles from './MaterialNodeEditor.module.css';

// ==================== Node Type + Port Definition Registration ====================

const nodeTypes: NodeTypes = {
  pbr: PBRNode,
  color: ColorNode,
  number: NumberNode,
  textureSet: TextureSetNode,
  preview: PreviewNode,
  channelPack: ChannelPackNode,
};

const nodePortDefs: Record<string, NodePortDef> = {
  pbr: pbrPortDef,
  color: colorPortDef,
  number: numberPortDef,
  textureSet: textureSetPortDef,
  preview: previewPortDef,
  channelPack: channelPackPortDef,
};

// ==================== Default Graph ====================

function createDefaultGraph(): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: [
      { id: 'pbr-1', type: 'pbr', position: { x: 400, y: 100 }, data: {} },
      { id: 'preview-1', type: 'preview', position: { x: 750, y: 180 }, data: {} },
    ],
    edges: [
      {
        id: 'e-pbr-preview',
        source: 'pbr-1',
        sourceHandle: 'material',
        target: 'preview-1',
        targetHandle: 'material',
      },
    ],
  };
}

// ==================== Serialization helpers ====================

function serializeGraph(ns: Node[], es: Edge[]): SerializedNodeGraph {
  return {
    nodes: ns.map(n => ({
      id: n.id,
      type: n.type as any,
      position: n.position,
      data: n.data as Record<string, unknown>,
    })),
    edges: es.map(e => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle ?? '',
      target: e.target,
      targetHandle: e.targetHandle ?? '',
    })),
  };
}

function deserializeGraph(g: SerializedNodeGraph): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: g.nodes.map(n => ({ id: n.id, type: n.type, position: n.position, data: n.data })),
    edges: g.edges.map(e => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      targetHandle: e.targetHandle,
    })),
  };
}

// ==================== Component ====================

export function MaterialNodeEditor() {
  const registry = getMaterialRegistry();
  const selectedId = registry.selectedMaterialId;
  const selectedMaterial = useComputed(() => {
    const id = selectedId.value;
    return id ? registry.get(id) ?? null : null;
  });

  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  // Live-state refs (always current — used by callbacks to avoid stale closures)
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  /** Which material ID the current graph state belongs to. */
  const activeMaterialIdRef = useRef<string | null>(null);

  /**
   * False after the component unmounts.  React Flow fires onNodesChange /
   * onEdgesChange with removal changes during teardown — this flag lets
   * handlers and the auto-save effect ignore those.
   */
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  /**
   * Load version counter.  Incremented each time we programmatically load
   * a graph (material switch or mount).  The auto-persist effect captures
   * the version at the time it was queued; if it doesn't match the current
   * version, the save is skipped.  This is more robust than timing-based
   * guards (requestAnimationFrame) because React Flow's reconciliation
   * callbacks can fire unpredictably late.
   *
   * The loaded edge count is also tracked: if the current edge count is
   * less than what we loaded, it's a reconciliation artifact (React Flow
   * removing edges during its internal sync) and we skip the save.
   */
  const loadVersionRef = useRef(0);
  const loadedEdgeCountRef = useRef(0);

  /**
   * The version that the user has "accepted" (i.e. the version after which
   * a genuine user-driven state change has been observed).
   * Set to loadVersionRef.current after the first user-initiated state change
   * following a load.
   */
  const userEditVersionRef = useRef(0);
  
  /**
   * Set true while the propagation engine is updating nodes.
   * Propagation-triggered node changes must NOT mark the load version as
   * "user-edited" — otherwise late React Flow reconciliation (which removes
   * edges) would bypass the edge-count guard.
   */
  const isPropagatingRef = useRef(false);

  // ==================== Auto-persist on every edit ====================

  /**
   * Single source of truth for persistence.
   * Runs every time `nodes` or `edges` change.  Guards ensure we only
   * write when the change is a genuine user edit.
   */
  useEffect(() => {
    if (!isMountedRef.current) return;

    const matId = activeMaterialIdRef.current;
    if (!matId) return;

    const mat = registry.get(matId);
    if (!mat || mat.isPreset) return;
    if (nodes.length === 0) return;

    // If edges shrunk below what we loaded, this is React Flow
    // reconciliation — skip unless the user has explicitly edited edges
    // (user edit version tracks *edge* changes, not propagation-triggered
    // node changes).
    if (edges.length < loadedEdgeCountRef.current && userEditVersionRef.current < loadVersionRef.current) {
      return;
    }

    // Only count non-propagation changes as user edits that unlock saves
    if (!isPropagatingRef.current) {
      userEditVersionRef.current = loadVersionRef.current;
    }

    // Build the update payload: always include the serialized node graph
    const updatePayload: Partial<MaterialDefinition> = {
      nodeGraph: serializeGraph(nodes, edges),
    };

    // Sync PBR node textures + scalars back to MaterialDefinition so
    // downstream consumers (terrain, object rendering, serialization)
    // can read material.textures / material.albedo / etc. directly
    // without parsing the nodeGraph structure.
    const pbrNode = nodes.find(n => n.type === 'pbr');
    if (pbrNode) {
      const pbrData = pbrNode.data as Record<string, unknown>;
      updatePayload.textures = extractTextureRefs(pbrData);
      Object.assign(updatePayload, extractPBRScalars(pbrData));
    }

    registry.update(matId, updatePayload);
  }, [nodes, edges]);

  // ==================== Material switch: load graph ====================

  useEffect(() => {
    const mat = selectedMaterial.value;
    const newMatId = mat?.id ?? null;

    // Bump load version — auto-persist will ignore any state changes that
    // are part of the reconciliation until a genuine user edit is detected.
    loadVersionRef.current += 1;
    activeMaterialIdRef.current = newMatId;

    if (!mat) {
      loadedEdgeCountRef.current = 0;
      setNodes([]);
      setEdges([]);
      return;
    }

    if (mat.nodeGraph && mat.nodeGraph.nodes.length > 0) {
      const { nodes: ln, edges: le } = deserializeGraph(mat.nodeGraph);
      loadedEdgeCountRef.current = le.length;
      setNodes(ln);
      setEdges(le);
    } else {
      // Build default PBR + Preview graph
      const def = createDefaultGraph();
      const pbrNode = def.nodes.find(n => n.type === 'pbr');
      if (pbrNode) {
        pbrNode.data = {
          albedo: mat.albedo,
          metallic: mat.metallic,
          roughness: mat.roughness,
          ior: mat.ior,
          clearcoatFactor: mat.clearcoatFactor,
          clearcoatRoughness: mat.clearcoatRoughness,
          emissiveFactor: mat.emissiveFactor,
          normalScale: mat.normalScale,
          occlusionStrength: mat.occlusionStrength,
        };
      }
      loadedEdgeCountRef.current = def.edges.length;
      setNodes(def.nodes);
      setEdges(def.edges);

      // Persist the default graph immediately for non-presets
      if (!mat.isPreset) {
        registry.update(mat.id, { nodeGraph: serializeGraph(def.nodes, def.edges) });
      }
    }
  }, [selectedMaterial.value?.id]);

  // ==================== Data propagation engine ====================

  const propagateData = useCallback((currentNodes: Node[], currentEdges: Edge[]): Node[] => {
    const nodeMap = new Map(currentNodes.map(n => [n.id, n]));
    const updates = new Map<string, Record<string, unknown>>();

    // Pass 1: Track _connectedInputs
    for (const edge of currentEdges) {
      const targetNode = nodeMap.get(edge.target);
      if (!targetNode?.type || !edge.targetHandle) continue;
      const targetPortDef = nodePortDefs[targetNode.type];
      if (!targetPortDef || Object.keys(targetPortDef.inputs).length === 0) continue;
      const existing = updates.get(targetNode.id) ?? {};
      const connectedSet = new Set<string>((existing._connectedInputs as string[]) ?? []);
      connectedSet.add(edge.targetHandle);
      existing._connectedInputs = Array.from(connectedSet);
      updates.set(targetNode.id, existing);
    }

    // Pass 2: Resolve outputs → apply to inputs
    for (const edge of currentEdges) {
      const sourceNode = nodeMap.get(edge.source);
      const targetNode = nodeMap.get(edge.target);
      if (!sourceNode?.type || !targetNode?.type) continue;
      const srcPortDef = nodePortDefs[sourceNode.type];
      const tgtPortDef = nodePortDefs[targetNode.type];
      if (!srcPortDef || !tgtPortDef) continue;
      const value = resolveOutput(srcPortDef, edge.sourceHandle ?? '', sourceNode.data as Record<string, unknown>);
      if (value === undefined) continue;
      const inputUpdates = applyInput(tgtPortDef, edge.targetHandle ?? '', value);
      const existing = updates.get(targetNode.id) ?? {};
      Object.assign(existing, inputUpdates);
      updates.set(targetNode.id, existing);
    }

    if (updates.size === 0) return currentNodes;

    return currentNodes.map(node => {
      const nodeUpdates = updates.get(node.id);
      if (!nodeUpdates) return node;
      const currentData = node.data as Record<string, unknown>;
      let hasChange = false;
      for (const [key, val] of Object.entries(nodeUpdates)) {
        if (JSON.stringify(currentData[key]) !== JSON.stringify(val)) { hasChange = true; break; }
      }
      if (!hasChange) return node;
      return { ...node, data: { ...currentData, ...nodeUpdates } };
    });
  }, []);

  // Edge fingerprint for detecting topology changes
  const edgeKey = edges.map(e => `${e.source}:${e.sourceHandle}->${e.target}:${e.targetHandle}`).join('|');
  const prevEdgeKeyRef = useRef(edgeKey);

  useEffect(() => {
    if (nodes.length === 0) return;
    const edgesChanged = prevEdgeKeyRef.current !== edgeKey;
    prevEdgeKeyRef.current = edgeKey;

    let baseNodes = nodes;
    if (edgesChanged) {
      baseNodes = nodes.map(node => {
        if (!node.type) return node;
        const pDef = nodePortDefs[node.type];
        if (!pDef || Object.keys(pDef.inputs).length === 0) return node;
        const data = node.data as Record<string, unknown>;
        const cleanedData = { ...data };
        delete cleanedData._connectedInputs;
        for (const key of Object.keys(cleanedData)) {
          if (key.endsWith('TexPath')) delete cleanedData[key];
        }
        return { ...node, data: cleanedData };
      });
    }

    const propagated = propagateData(baseNodes, edges);
    let changed = false;
    for (let i = 0; i < nodes.length; i++) {
      if (JSON.stringify(nodes[i].data) !== JSON.stringify(propagated[i].data)) { changed = true; break; }
    }
    if (changed) {
      isPropagatingRef.current = true;
      setNodes(propagated);
      // Clear after microtask so the auto-persist effect sees isPropagatingRef=true
      // when it runs in response to this setNodes
      queueMicrotask(() => { isPropagatingRef.current = false; });
    }
  }, [nodes.map(n => JSON.stringify(n.data)).join('|'), edgeKey]);

  // ==================== React Flow event handlers ====================
  // Handlers are now thin — they just update state.
  // The auto-persist useEffect above handles saving.

  const onNodesChange: OnNodesChange = useCallback((changes) => {
    if (!isMountedRef.current) return;
    setNodes(nds => applyNodeChanges(changes, nds));
  }, []);

  const onEdgesChange: OnEdgesChange = useCallback((changes) => {
    if (!isMountedRef.current) return;
    
    // Filter out spurious edge removals from React Flow's internal reconciliation.
    // React Flow removes edges when it can't find their Handle elements in the DOM
    // (e.g., during node re-renders or material switches). We only allow edge removals
    // when the source or target NODE has been deleted — not when handles are temporarily
    // unmounted. This is the definitive fix for the edge loss bug.
    const currentNodeIds = new Set(nodesRef.current.map(n => n.id));
    const filteredChanges = changes.filter(change => {
      if (change.type !== 'remove') return true;
      // Find the edge being removed
      const edge = edgesRef.current.find(e => e.id === change.id);
      if (!edge) return true; // Edge doesn't exist anyway, allow
      // Only allow removal if source or target node was actually deleted
      return !currentNodeIds.has(edge.source) || !currentNodeIds.has(edge.target);
    });
    
    if (filteredChanges.length === 0) return;
    setEdges(eds => applyEdgeChanges(filteredChanges, eds));
  }, []);

  const onConnect: OnConnect = useCallback((connection) => {
    if (!isMountedRef.current) return;
    setEdges(eds => {
      const filtered = eds.filter(e =>
        !(e.target === connection.target && e.targetHandle === connection.targetHandle)
      );
      return addEdge(connection, filtered);
    });
  }, []);

  const isValidConnectionCb = useCallback(
    (conn: { source: string; target: string; sourceHandle: string | null; targetHandle: string | null }) => {
      const ns = nodesRef.current;
      const sn = ns.find(n => n.id === conn.source);
      const tn = ns.find(n => n.id === conn.target);
      if (!sn?.type || !tn?.type) return false;
      const sd = nodePortDefs[sn.type], td = nodePortDefs[tn.type];
      if (!sd || !td) return true;
      return isConnectionValid(sd, conn.sourceHandle ?? '', td, conn.targetHandle ?? '');
    },
    [],
  );

  const addNode = useCallback((type: string) => {
    const id = `${type}-${Date.now()}`;
    const positions: Record<string, { x: number; y: number }> = {
      color: { x: 50, y: 100 },
      number: { x: 50, y: 250 },
      textureSet: { x: 50, y: 50 },
      pbr: { x: 400, y: 100 },
      preview: { x: 750, y: 180 },
    };
    const newNode: Node = { id, type, position: positions[type] ?? { x: 200, y: 200 }, data: {} };
    setNodes(nds => [...nds, newNode]);
  }, []);

  // ==================== Render ====================

  if (!selectedMaterial.value) {
    return (
      <div class={styles.emptyState}>
        <div class={styles.emptyIcon}>🎨</div>
        <div class={styles.emptyTitle}>No Material Selected</div>
        <div class={styles.emptyDesc}>
          Select a material from the browser or create a new one to start editing.
        </div>
      </div>
    );
  }

  return (
    <div class={styles.container}>
      <div class={styles.toolbar}>
        <span class={styles.materialName}>{selectedMaterial.value.name}</span>
        <div class={styles.toolbarActions}>
          <button class={styles.addNodeBtn} onClick={() => addNode('textureSet')}>+ Texture Set</button>
          <button class={styles.addNodeBtn} onClick={() => addNode('color')}>+ Color</button>
          <button class={styles.addNodeBtn} onClick={() => addNode('number')}>+ Number</button>
          <button class={styles.addNodeBtn} onClick={() => addNode('channelPack')}>+ Channel Pack</button>
        </div>
      </div>

      <div class={styles.flowContainer}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnectionCb}
          nodeTypes={nodeTypes}
          fitView
          colorMode="dark"
          deleteKeyCode={['Backspace', 'Delete']}
          defaultEdgeOptions={{ animated: true, style: { stroke: '#555', strokeWidth: 2 } }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#333" />
          <Controls showInteractive={false} />
          <MiniMap
            nodeColor={() => '#444'}
            maskColor="rgba(0,0,0,0.7)"
            style={{ background: '#1a1a1a' }}
          />
        </ReactFlow>
      </div>
    </div>
  );
}
