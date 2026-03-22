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
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'preact/hooks';
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
import {
  type NodePortDef,
  resolveOutput,
  applyInput,
  isConnectionValid,
} from './nodes/portTypes';
import { PBRNode, portDef as pbrPortDef } from './nodes/PBRNode';
import { ColorNode, portDef as colorPortDef } from './nodes/ColorNode';
import { NumberNode, portDef as numberPortDef } from './nodes/NumberNode';
import { TextureSetNode, portDef as textureSetPortDef } from './nodes/TextureSetNode';
import { PreviewNode, portDef as previewPortDef } from './nodes/PreviewNode';
import { ChannelPackNode, portDef as channelPackPortDef } from './nodes/ChannelPackNode';
import styles from './MaterialNodeEditor.module.css';

// ==================== Node Type + Port Definition Registration ====================

/** React Flow node type → component map */
const nodeTypes: NodeTypes = {
  pbr: PBRNode,
  color: ColorNode,
  number: NumberNode,
  textureSet: TextureSetNode,
  preview: PreviewNode,
  channelPack: ChannelPackNode,
};

/**
 * Node type → port definition map.
 * Each entry is the portDef exported by the corresponding node component.
 * The generic propagation engine uses this — no node-specific logic needed.
 */
const nodePortDefs: Record<string, NodePortDef> = {
  pbr: pbrPortDef,
  color: colorPortDef,
  number: numberPortDef,
  textureSet: textureSetPortDef,
  preview: previewPortDef,
  channelPack: channelPackPortDef,
};

// ==================== Default Graph for New Materials ====================

function createDefaultGraph(): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: [
      {
        id: 'pbr-1',
        type: 'pbr',
        position: { x: 400, y: 100 },
        data: {},
      },
      {
        id: 'preview-1',
        type: 'preview',
        position: { x: 750, y: 180 },
        data: {},
      },
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
  
  // Load graph when selected material changes
  useEffect(() => {
    const mat = selectedMaterial.value;
    if (!mat) {
      setNodes([]);
      setEdges([]);
      return;
    }
    
    if (mat.nodeGraph && mat.nodeGraph.nodes.length > 0) {
      // Load saved graph
      setNodes(mat.nodeGraph.nodes.map(n => ({
        id: n.id,
        type: n.type,
        position: n.position,
        data: n.data,
      })));
      setEdges(mat.nodeGraph.edges.map(e => ({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourceHandle,
        target: e.target,
        targetHandle: e.targetHandle,
      })));
    } else {
      // Create default graph for new materials
      const defaultGraph = createDefaultGraph();
      
      // Pre-populate PBR node data from the material's current values
      const pbrNode = defaultGraph.nodes.find(n => n.type === 'pbr');
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
      
      setNodes(defaultGraph.nodes);
      setEdges(defaultGraph.edges);
    }
  }, [selectedMaterial.value?.id]);
  
  // Save graph back to registry on changes
  const saveGraph = useCallback((currentNodes: Node[], currentEdges: Edge[]) => {
    const id = selectedId.value;
    if (!id) return;
    
    registry.update(id, {
      nodeGraph: {
        nodes: currentNodes.map(n => ({
          id: n.id,
          type: n.type as any,
          position: n.position,
          data: n.data as Record<string, unknown>,
        })),
        edges: currentEdges.map(e => ({
          id: e.id,
          source: e.source,
          sourceHandle: e.sourceHandle ?? '',
          target: e.target,
          targetHandle: e.targetHandle ?? '',
        })),
      },
    });
  }, [selectedId.value, registry]);
  
  /**
   * Generic data propagation engine.
   * 
   * Iterates all edges and uses the declarative portDef from each node type
   * to resolve output values and apply them to target inputs.
   * Also tracks _connectedInputs for any node with input ports.
   * 
   * No node-type-specific logic — all behavior is driven by the portDef
   * exported from each node component file.
   */
  const propagateData = useCallback((currentNodes: Node[], currentEdges: Edge[]): Node[] => {
    const nodeMap = new Map(currentNodes.map(n => [n.id, n]));
    const updates = new Map<string, Record<string, unknown>>();
    
    // Pass 1: Track _connectedInputs for all nodes with input ports
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
    
    // Pass 2: Resolve outputs and apply to target inputs
    for (const edge of currentEdges) {
      const sourceNode = nodeMap.get(edge.source);
      const targetNode = nodeMap.get(edge.target);
      if (!sourceNode?.type || !targetNode?.type) continue;
      
      const sourceHandle = edge.sourceHandle ?? '';
      const targetHandle = edge.targetHandle ?? '';
      
      const srcPortDef = nodePortDefs[sourceNode.type];
      const tgtPortDef = nodePortDefs[targetNode.type];
      if (!srcPortDef || !tgtPortDef) continue;
      
      // Resolve output value using source node's portDef
      const value = resolveOutput(srcPortDef, sourceHandle, sourceNode.data as Record<string, unknown>);
      if (value === undefined) continue;
      
      // Apply input value using target node's portDef
      const inputUpdates = applyInput(tgtPortDef, targetHandle, value);
      
      // Merge into accumulated updates for this target node
      const existing = updates.get(targetNode.id) ?? {};
      Object.assign(existing, inputUpdates);
      updates.set(targetNode.id, existing);
    }
    
    if (updates.size === 0) return currentNodes;
    
    // Create new node objects for changed nodes (immutable update)
    return currentNodes.map(node => {
      const nodeUpdates = updates.get(node.id);
      if (!nodeUpdates) return node;
      
      const currentData = node.data as Record<string, unknown>;
      let hasChange = false;
      for (const [key, val] of Object.entries(nodeUpdates)) {
        if (JSON.stringify(currentData[key]) !== JSON.stringify(val)) {
          hasChange = true;
          break;
        }
      }
      
      if (!hasChange) return node;
      
      return {
        ...node,
        data: { ...currentData, ...nodeUpdates },
      };
    });
  }, []);

  // Serialized edge fingerprint — changes on add/remove, not just count
  const edgeKey = edges.map(e => `${e.source}:${e.sourceHandle}->${e.target}:${e.targetHandle}`).join('|');
  // Track previous edge key to detect edge changes (not just node data changes)
  const prevEdgeKeyRef = useRef(edgeKey);
  
  useEffect(() => {
    if (nodes.length === 0) return;
    
    const edgesChanged = prevEdgeKeyRef.current !== edgeKey;
    prevEdgeKeyRef.current = edgeKey;
    
    // Build base nodes: if edges changed, strip propagated keys first to avoid stale data
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
    
    // Check if anything actually changed
    let changed = false;
    for (let i = 0; i < nodes.length; i++) {
      if (JSON.stringify(nodes[i].data) !== JSON.stringify(propagated[i].data)) {
        changed = true;
        break;
      }
    }
    
    if (changed) {
      setNodes(propagated);
    }
  }, [
    nodes.map(n => JSON.stringify(n.data)).join('|'),
    edgeKey,
  ]);


  const onNodesChange: OnNodesChange = useCallback((changes) => {
    setNodes((nds) => {
      const updated = applyNodeChanges(changes, nds);
      const hasMeaningfulChange = changes.some(c => c.type !== 'position' || (c.type === 'position' && !c.dragging));
      if (hasMeaningfulChange) {
        setTimeout(() => saveGraph(updated, edges), 0);
      }
      return updated;
    });
  }, [saveGraph, edges]);
  
  const onEdgesChange: OnEdgesChange = useCallback((changes) => {
    setEdges((eds) => {
      const updated = applyEdgeChanges(changes, eds);
      setTimeout(() => saveGraph(nodes, updated), 0);
      return updated;
    });
  }, [saveGraph, nodes]);
  
  const onConnect: OnConnect = useCallback((connection) => {
    setEdges((eds) => {
      // Remove any existing edges to the same target input handle (single-connection-per-input)
      const filtered = eds.filter(e =>
        !(e.target === connection.target && e.targetHandle === connection.targetHandle)
      );
      const updated = addEdge(connection, filtered);
      setTimeout(() => saveGraph(nodes, updated), 0);
      return updated;
    });
  }, [saveGraph, nodes]);
  
  /**
   * Generic connection validation using portDef type compatibility.
   * Each node's portDef declares what data types its outputs produce
   * and what types each input accepts — no node-specific checks needed.
   */
  const isValidConnectionCb = useCallback((connection: { source: string; target: string; sourceHandle: string | null; targetHandle: string | null }) => {
    const sourceNode = nodes.find(n => n.id === connection.source);
    const targetNode = nodes.find(n => n.id === connection.target);
    if (!sourceNode?.type || !targetNode?.type) return false;
    
    const srcDef = nodePortDefs[sourceNode.type];
    const tgtDef = nodePortDefs[targetNode.type];
    if (!srcDef || !tgtDef) return true; // Permissive fallback for unknown types
    
    return isConnectionValid(
      srcDef,
      connection.sourceHandle ?? '',
      tgtDef,
      connection.targetHandle ?? '',
    );
  }, [nodes]);
  
  // Add node helpers
  const addNode = useCallback((type: string) => {
    const id = `${type}-${Date.now()}`;
    const positions: Record<string, { x: number; y: number }> = {
      color: { x: 50, y: 100 },
      number: { x: 50, y: 250 },
      textureSet: { x: 50, y: 50 },
      pbr: { x: 400, y: 100 },
      preview: { x: 750, y: 180 },
    };
    
    const newNode: Node = {
      id,
      type,
      position: positions[type] ?? { x: 200, y: 200 },
      data: {},
    };
    
    setNodes((nds) => {
      const updated = [...nds, newNode];
      setTimeout(() => saveGraph(updated, edges), 0);
      return updated;
    });
  }, [saveGraph, edges]);
  
  // No material selected state
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
      {/* Toolbar */}
      <div class={styles.toolbar}>
        <span class={styles.materialName}>{selectedMaterial.value.name}</span>
        <div class={styles.toolbarActions}>
          <button class={styles.addNodeBtn} onClick={() => addNode('textureSet')}>
            + Texture Set
          </button>
          <button class={styles.addNodeBtn} onClick={() => addNode('color')}>
            + Color
          </button>
          <button class={styles.addNodeBtn} onClick={() => addNode('number')}>
            + Number
          </button>
          <button class={styles.addNodeBtn} onClick={() => addNode('channelPack')}>
            + Channel Pack
          </button>
        </div>
      </div>
      
      {/* React Flow Canvas */}
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
          defaultEdgeOptions={{
            animated: true,
            style: { stroke: '#555', strokeWidth: 2 },
          }}
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
