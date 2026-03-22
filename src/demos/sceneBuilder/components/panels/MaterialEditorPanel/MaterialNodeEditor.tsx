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

import { useState, useCallback, useMemo, useEffect } from 'preact/hooks';
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
import { PBRNode } from './nodes/PBRNode';
import { ColorNode } from './nodes/ColorNode';
import { NumberNode } from './nodes/NumberNode';
import { TextureSetNode } from './nodes/TextureSetNode';
import { PreviewNode } from './nodes/PreviewNode';
import styles from './MaterialNodeEditor.module.css';

// ==================== Node Type Registration ====================

const nodeTypes: NodeTypes = {
  pbr: PBRNode,
  color: ColorNode,
  number: NumberNode,
  textureSet: TextureSetNode,
  preview: PreviewNode,
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
   * Propagate data through edges immutably.
   * Returns a new array of nodes if any data changed, or the same array if not.
   * React Flow requires immutable node objects to detect changes.
   */
  const propagateData = useCallback((currentNodes: Node[], currentEdges: Edge[]): Node[] => {
    const nodeMap = new Map(currentNodes.map(n => [n.id, n]));
    const updates = new Map<string, Record<string, unknown>>();
    
    for (const edge of currentEdges) {
      const sourceNode = nodeMap.get(edge.source);
      const targetNode = nodeMap.get(edge.target);
      if (!sourceNode || !targetNode) continue;
      
      const sourceHandle = edge.sourceHandle ?? '';
      const targetHandle = edge.targetHandle ?? '';
      
      // Determine the value to propagate from source
      let value: unknown = undefined;
      
      if (sourceNode.type === 'color' && sourceHandle === 'color') {
        value = (sourceNode.data as any).color;
      } else if (sourceNode.type === 'number' && sourceHandle === 'value') {
        value = (sourceNode.data as any).value;
      } else if (sourceNode.type === 'textureSet') {
        // Texture set outputs a file path per map type (albedo, normal, roughness, etc.)
        const asset = (sourceNode.data as any).asset;
        if (asset?.files) {
          const file = asset.files.find((f: any) => f.fileSubType === sourceHandle);
          if (file) {
            value = file.path; // Pass file path as a string reference
          }
        }
      } else if (sourceNode.type === 'pbr' && sourceHandle === 'material') {
        // Pass PBR data to preview
        value = { ...(sourceNode.data as any) };
      }
      
      if (value === undefined) continue;
      
      // Collect updates for target nodes
      if (targetNode.type === 'pbr' && targetHandle) {
        const existing = updates.get(targetNode.id) ?? {};
        existing[targetHandle] = value;
        updates.set(targetNode.id, existing);
      } else if (targetNode.type === 'preview' && targetHandle === 'material') {
        const pbrData = value as Record<string, unknown>;
        const existing = updates.get(targetNode.id) ?? {};
        for (const key of ['albedo', 'metallic', 'roughness']) {
          if (pbrData[key] !== undefined) {
            existing[key] = pbrData[key];
          }
        }
        updates.set(targetNode.id, existing);
      }
    }
    
    // Also track which PBR inputs have connections (for disabling inline controls)
    for (const edge of currentEdges) {
      const targetNode = nodeMap.get(edge.target);
      if (targetNode?.type === 'pbr' && edge.targetHandle) {
        const existing = updates.get(targetNode.id) ?? {};
        const connectedSet = new Set<string>((existing._connectedInputs as string[]) ?? []);
        connectedSet.add(edge.targetHandle);
        existing._connectedInputs = Array.from(connectedSet);
        updates.set(targetNode.id, existing);
      }
    }
    
    if (updates.size === 0) return currentNodes;
    
    // Create new node objects for changed nodes (immutable update)
    return currentNodes.map(node => {
      const nodeUpdates = updates.get(node.id);
      if (!nodeUpdates) return node;
      
      // Check if anything actually changed
      const currentData = node.data as Record<string, unknown>;
      let hasChange = false;
      for (const [key, val] of Object.entries(nodeUpdates)) {
        if (JSON.stringify(currentData[key]) !== JSON.stringify(val)) {
          hasChange = true;
          break;
        }
      }
      
      if (!hasChange) return node;
      
      // Return new node with merged data
      return {
        ...node,
        data: { ...currentData, ...nodeUpdates },
      };
    });
  }, []);

  // Run propagation after nodes or edges change
  useEffect(() => {
    if (nodes.length === 0 || edges.length === 0) return;
    const propagated = propagateData(nodes, edges);
    if (propagated !== nodes) {
      setNodes(propagated);
    }
  }, [
    // Re-propagate when any node data changes — use a serialized key of all node data
    nodes.map(n => JSON.stringify(n.data)).join('|'),
    edges.length,
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
      const updated = addEdge(connection, eds);
      setTimeout(() => saveGraph(nodes, updated), 0);
      return updated;
    });
  }, [saveGraph, nodes]);
  
  /**
   * Type guardrails: validate connections based on source/target handle types.
   * - Float inputs (metallic, roughness, ior, clearcoat, normalScale, occlusionStrength)
   *   accept: number output, texture output (single channel)
   *   reject: color output (vec3)
   * - Color inputs (albedo, emissive) accept: color output, texture output
   *   reject: number output
   * - Texture inputs (normal) accept: texture output only
   * - Material input (preview) accepts: pbr material output only
   */
  const isValidConnection = useCallback((connection: { source: string; target: string; sourceHandle: string | null; targetHandle: string | null }) => {
    const sourceNode = nodes.find(n => n.id === connection.source);
    const targetNode = nodes.find(n => n.id === connection.target);
    if (!sourceNode || !targetNode) return false;
    
    const sourceType = sourceNode.type;
    const targetHandle = connection.targetHandle ?? '';
    
    // Preview node: only accept PBR material output
    if (targetNode.type === 'preview' && targetHandle === 'material') {
      return sourceType === 'pbr' && connection.sourceHandle === 'material';
    }
    
    // PBR node inputs
    if (targetNode.type === 'pbr') {
      const floatInputs = ['metallic', 'roughness', 'ior', 'clearcoat', 'normalScale', 'occlusionStrength'];
      const colorInputs = ['albedo', 'emissive'];
      const textureInputs = ['normal', 'occlusion', 'metallicRoughness'];
      
      if (floatInputs.includes(targetHandle)) {
        // Float inputs accept: number, textureSet (single channel maps like roughness/ao)
        return sourceType === 'number' || sourceType === 'textureSet';
      }
      if (colorInputs.includes(targetHandle)) {
        // Color inputs accept: color, textureSet (albedo maps)
        return sourceType === 'color' || sourceType === 'textureSet';
      }
      if (textureInputs.includes(targetHandle)) {
        // Texture inputs accept: textureSet only
        return sourceType === 'textureSet';
      }
    }
    
    return true; // Allow other connections by default
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
          isValidConnection={isValidConnection}
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
