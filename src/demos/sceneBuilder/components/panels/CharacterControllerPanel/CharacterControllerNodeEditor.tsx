/**
 * CharacterControllerNodeEditor — React Flow graph editor for the
 * character controller configuration. Opens in a DockableWindow.
 *
 * Mirrors the MaterialNodeEditor pattern:
 * - Reads graph from CharacterControllerComponent on mount
 * - Debounced save on every user edit
 * - No save on unmount (avoids React Flow teardown bugs)
 * - Toolbar with add-node buttons
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'preact/hooks';
import {
  ReactFlow,
  Background,
  Controls,
  type NodeTypes,
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import type { Entity } from '@/core/ecs/Entity';
import type { CharacterControllerComponent, SerializedNodeGraph } from '@/core/ecs/components/CharacterControllerComponent';
import { CharacterControllerGraphEvaluator } from '@/core/animation/CharacterControllerGraphEvaluator';

import { CharacterNode, portDef as characterPortDef } from './nodes/CharacterNode';
import { InputNode, portDef as inputPortDef } from './nodes/InputNode';
import { CameraNode, portDef as cameraPortDef } from './nodes/CameraNode';
import { AnimStateMachineNode, portDef as animStateMachinePortDef } from './nodes/AnimStateMachineNode';
import { TerrainNode, portDef as terrainPortDef } from './nodes/TerrainNode';
import { ScriptNode, portDef as scriptPortDef } from './nodes/ScriptNode';
import type { CCNodePortLayout } from './nodes/portTypes';

import styles from './CharacterControllerNodeEditor.module.css';

// ==================== Node Types ====================

const nodeTypes: NodeTypes = {
  character: CharacterNode as any,
  input: InputNode as any,
  camera: CameraNode as any,
  animStateMachine: AnimStateMachineNode as any,
  terrain: TerrainNode as any,
  script: ScriptNode as any,
};

/** Port definitions per node type — mirrors Material Editor pattern */
const nodePortDefs: Record<string, CCNodePortLayout> = {
  character: characterPortDef,
  input: inputPortDef,
  camera: cameraPortDef,
  animStateMachine: animStateMachinePortDef,
  terrain: terrainPortDef,
  script: scriptPortDef,
};

// ==================== Props ====================

export interface CharacterControllerNodeEditorProps {
  entity: Entity;
  evaluator: CharacterControllerGraphEvaluator;
}

// ==================== Helpers ====================

let nextNodeId = 100;
function genId() {
  return `cc-node-${nextNodeId++}`;
}

// ==================== Component ====================

function EditorInner({ entity, evaluator }: CharacterControllerNodeEditorProps) {
  const cc = entity.getComponent<CharacterControllerComponent>('character-controller');

  // Load initial graph from component (or create default)
  const initialGraph = useMemo<SerializedNodeGraph>(() => {
    if (cc?.nodeGraph) return cc.nodeGraph;
    return evaluator.createDefaultGraph();
  }, []);

  const [nodes, setNodes] = useState<Node[]>(initialGraph.nodes as Node[]);
  const [edges, setEdges] = useState<Edge[]>(initialGraph.edges as Edge[]);

  // Debounced save ref
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInitialized = useRef(false);

  // Mark initialized after first rAF (skip initial mount reconciliation saves)
  useEffect(() => {
    requestAnimationFrame(() => {
      isInitialized.current = true;
    });
  }, []);

  // Debounced save to component
  const scheduleSave = useCallback(() => {
    if (!isInitialized.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const graph: SerializedNodeGraph = {
        nodes: nodes.map(n => ({
          id: n.id,
          type: n.type!,
          position: n.position,
          data: n.data as Record<string, any>,
        })),
        edges: edges.map(e => ({
          id: e.id,
          source: e.source,
          sourceHandle: e.sourceHandle!,
          target: e.target,
          targetHandle: e.targetHandle!,
        })),
      };
      evaluator.evaluate(entity, graph);
    }, 300);
  }, [nodes, edges, entity, evaluator]);

  // Trigger save when nodes/edges change
  useEffect(() => {
    scheduleSave();
  }, [nodes, edges]);

  // Node/edge change handlers
  const onNodesChange: OnNodesChange = useCallback(
    (changes) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  );

  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    [],
  );

  const onConnect: OnConnect = useCallback(
    (connection) => setEdges((eds) => addEdge(connection, eds)),
    [],
  );

  // Add node handlers
  const addNode = useCallback((type: string, label: string) => {
    const id = genId();
    const newNode: Node = {
      id,
      type,
      position: { x: 200 + Math.random() * 200, y: 100 + Math.random() * 200 },
      data: type === 'animStateMachine' ? { states: [], transitions: [], defaultBlendDuration: 0.2 } : {},
    };
    setNodes((nds) => [...nds, newNode]);
  }, []);

  return (
    <div class={styles.container}>
      {/* Toolbar */}
      <div class={styles.toolbar}>
        <span class={styles.entityName}>🏃 {entity.name}</span>
        <div class={styles.toolbarActions}>
          <button class={styles.addNodeBtn} onClick={() => addNode('input', 'Input')}>+ Input</button>
          <button class={styles.addNodeBtn} onClick={() => addNode('camera', 'Camera')}>+ Camera</button>
          <button class={styles.addNodeBtn} onClick={() => addNode('terrain', 'Terrain')}>+ Terrain</button>
          <button class={styles.addNodeBtn} onClick={() => addNode('animStateMachine', 'Anim States')}>+ Anim States</button>
          <button class={styles.addNodeBtn} onClick={() => addNode('script', 'Script')}>+ Script</button>
        </div>
      </div>

      {/* React Flow — isolate keyboard events to prevent scene editor shortcuts,
          but allow Delete/Backspace through so React Flow can delete nodes/edges */}
      <div
        class={styles.flowContainer}
        onKeyDown={(e: KeyboardEvent) => {
          // Let Delete/Backspace bubble so React Flow handles node/edge deletion
          const key = e.key;
          if (key === 'Delete' || key === 'Backspace') return;
          e.stopPropagation();
        }}
        onKeyUp={(e: KeyboardEvent) => {
          const key = e.key;
          if (key === 'Delete' || key === 'Backspace') return;
          e.stopPropagation();
        }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.3}
          maxZoom={2}
          defaultEdgeOptions={{
            type: 'smoothstep',
            style: { stroke: '#555', strokeWidth: 2 },
          }}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#333" gap={20} />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}

export function CharacterControllerNodeEditor(props: CharacterControllerNodeEditorProps) {
  return (
    <ReactFlowProvider>
      <EditorInner {...props} />
    </ReactFlowProvider>
  );
}
