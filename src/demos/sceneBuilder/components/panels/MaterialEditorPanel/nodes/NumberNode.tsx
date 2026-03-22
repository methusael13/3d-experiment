/**
 * Number Node - Scalar value node with slider
 * 
 * Outputs: value (float)
 */

import { useCallback } from 'preact/hooks';
import { Handle, Position, type NodeProps, useReactFlow } from '@xyflow/react';
import type { NodePortDef } from './portTypes';
import styles from './nodeStyles.module.css';

/** Port definition — co-located with the node component */
export const portDef: NodePortDef = {
  outputs: {
    value: { type: 'float', dataKey: 'value' },
  },
  inputs: {},
};

interface NumberNodeData {
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  [key: string]: unknown;
}

export function NumberNode({ data, id }: NodeProps) {
  const d = data as NumberNodeData;
  const value = d.value ?? 0.5;
  const min = d.min ?? 0;
  const max = d.max ?? 1;
  const step = d.step ?? 0.01;
  const label = d.label ?? 'Value';
  const { updateNodeData } = useReactFlow();
  
  const handleValueChange = useCallback((e: Event) => {
    const newValue = parseFloat((e.target as HTMLInputElement).value);
    updateNodeData(id, { value: newValue });
  }, [id, updateNodeData]);
  
  return (
    <div class={styles.node} style={{ minWidth: '160px' }}>
      <div class={styles.numberHeader}>
        <span class={styles.nodeHeaderIcon}>#</span>
        Number
      </div>
      <div class={styles.nodeBody}>
        <div class={styles.handleRow}>
          <span class={styles.handleLabel}>{label}</span>
          <span class={styles.inlineValue}>{value.toFixed(2)}</span>
          <Handle type="source" position={Position.Right} id="value" style={{ top: 'auto' }} />
        </div>
        <div class="nopan nodrag">
          <input
            type="range"
            class={styles.inlineSlider}
            style={{ width: '100%' }}
            min={min}
            max={max}
            step={step}
            value={value}
            onInput={handleValueChange}
          />
        </div>
      </div>
    </div>
  );
}
