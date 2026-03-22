/**
 * Node Port Types — Shared interface for declarative port definitions.
 * 
 * Each node component exports a `portDef: NodePortDef` alongside its React component.
 * The propagation engine collects all port definitions and operates generically —
 * no node-type-specific logic in the graph evaluator.
 * 
 * To add a new node:
 *   1. Create MyNode.tsx with `export function MyNode(...)`
 *   2. Export `export const portDef: NodePortDef = { ... }` from the same file
 *   3. Register in MaterialNodeEditor.tsx nodeTypes + nodePortDefs maps
 *   Done — propagation, _connectedInputs, and validation all work automatically.
 */

// ============================================================================
// Data Types
// ============================================================================

/** Data type flowing through edges. Used for connection validation. */
export type PortDataType = 'float' | 'color' | 'texture' | 'material' | 'any';

// ============================================================================
// Output Port
// ============================================================================

export interface OutputPortDef {
  /** Data type this output produces */
  type: PortDataType;
  
  /** 
   * Read value from `node.data[dataKey]`.
   * Ignored if `resolver` or `spread` is set.
   */
  dataKey?: string;
  
  /**
   * Custom resolver for dynamic/complex outputs.
   * Called with (nodeData, handleId) → value to propagate.
   */
  resolver?: (data: Record<string, unknown>, handleId: string) => unknown;
  
  /**
   * If true, spread all of node.data as the output value.
   * Used for composite outputs like PBR → material.
   */
  spread?: boolean;
}

// ============================================================================
// Input Port
// ============================================================================

export interface InputPortDef {
  /** Accepted incoming data types (for connection validation) */
  accepts: PortDataType[];
  
  /**
   * Write received value to `node.data[dataKey]`.
   * Ignored if `receiver` is set.
   */
  dataKey?: string;
  
  /**
   * Custom receiver for composite inputs.
   * Called with (receivedValue, handleId) → partial data updates to merge.
   */
  receiver?: (value: unknown, handleId: string) => Record<string, unknown>;
}

// ============================================================================
// Node Port Definition
// ============================================================================

export interface NodePortDef {
  /** 
   * Output ports.
   * Key = handle ID, or '*' for dynamic wildcard (matches any handle not explicitly listed).
   */
  outputs: Record<string, OutputPortDef>;
  
  /**
   * Input ports.
   * Key = handle ID, or '*' for catch-all.
   */
  inputs: Record<string, InputPortDef>;
}

// ============================================================================
// Generic Graph Helpers
// ============================================================================

/**
 * Resolve the output value from a source node.
 */
export function resolveOutput(
  portDef: NodePortDef,
  handleId: string,
  data: Record<string, unknown>,
): unknown {
  const def = portDef.outputs[handleId] ?? portDef.outputs['*'];
  if (!def) return undefined;
  
  if (def.resolver) return def.resolver(data, handleId);
  if (def.spread) return { ...data };
  
  const key = def.dataKey ?? handleId;
  return data[key];
}

/**
 * Apply a received value to a target node, returning partial data updates.
 */
export function applyInput(
  portDef: NodePortDef,
  handleId: string,
  value: unknown,
): Record<string, unknown> {
  const def = portDef.inputs[handleId] ?? portDef.inputs['*'];
  if (!def) return { [handleId]: value };
  
  if (def.receiver) return def.receiver(value, handleId);
  
  const key = def.dataKey ?? handleId;
  return { [key]: value };
}

/**
 * Check if a connection is type-compatible.
 */
export function isConnectionValid(
  sourceDef: NodePortDef,
  sourceHandle: string,
  targetDef: NodePortDef,
  targetHandle: string,
): boolean {
  const outDef = sourceDef.outputs[sourceHandle] ?? sourceDef.outputs['*'];
  const inDef = targetDef.inputs[targetHandle] ?? targetDef.inputs['*'];
  
  if (!outDef || !inDef) return true; // Permissive fallback
  
  return inDef.accepts.includes(outDef.type) || inDef.accepts.includes('any');
}
