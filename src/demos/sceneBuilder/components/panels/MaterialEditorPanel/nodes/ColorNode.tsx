/**
 * Color Node - Solid color picker node
 * 
 * Outputs: color (RGB)
 */

import { useCallback } from 'preact/hooks';
import { Handle, Position, type NodeProps, useReactFlow } from '@xyflow/react';
import type { NodePortDef } from './portTypes';
import styles from './nodeStyles.module.css';

/** Port definition — co-located with the node component */
export const portDef: NodePortDef = {
  outputs: {
    color: { type: 'color', dataKey: 'color' },
  },
  inputs: {},
};

interface ColorNodeData {
  color?: [number, number, number];
  [key: string]: unknown;
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return [r, g, b];
}

export function ColorNode({ data, id }: NodeProps) {
  const d = data as ColorNodeData;
  const color = d.color ?? [0.75, 0.75, 0.75];
  const { updateNodeData } = useReactFlow();
  
  const handleColorChange = useCallback((e: Event) => {
    const hex = (e.target as HTMLInputElement).value;
    const rgb = hexToRgb(hex);
    updateNodeData(id, { color: rgb });
  }, [id, updateNodeData]);
  
  return (
    <div class={styles.node} style={{ minWidth: '140px' }}>
      <div class={styles.colorHeader}>
        <span class={styles.nodeHeaderIcon}>🎨</span>
        Color
      </div>
      <div class={styles.nodeBody}>
        <div class={styles.handleRow}>
          <input
            type="color"
            class={`${styles.colorInput} nopan nodrag`}
            value={rgbToHex(color[0], color[1], color[2])}
            onInput={handleColorChange}
          />
          <span class={styles.inlineValue}>
            {color.map(v => Math.round(v * 255)).join(', ')}
          </span>
          <Handle type="source" position={Position.Right} id="color" style={{ top: 'auto' }} />
        </div>
      </div>
    </div>
  );
}
