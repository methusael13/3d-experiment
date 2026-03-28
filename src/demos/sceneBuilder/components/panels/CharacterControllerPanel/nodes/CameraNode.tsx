/**
 * Camera Node — Defines camera behavior (FPS or TPS orbit).
 * Input port: characterState.
 */

import { useCallback } from 'preact/hooks';
import { Handle, Position, type NodeProps, useReactFlow } from '@xyflow/react';
import type { CCNodePortLayout } from './portTypes';
import styles from './nodeStyles.module.css';

/** Port definition — co-located with the node component */
export const portDef: CCNodePortLayout = {
  inputs: [
    { id: 'characterState', label: 'Character State', type: 'characterState', direction: 'input' },
  ],
  outputs: [],
};

export function CameraNode({ data, id }: NodeProps) {
  const d = data as Record<string, any>;
  const { updateNodeData } = useReactFlow();

  const set = useCallback((key: string, value: any) => {
    updateNodeData(id, { [key]: value });
  }, [id, updateNodeData]);

  return (
    <div class={styles.node}>
      <div class={styles.cameraHeader}>
        <span class={styles.nodeHeaderIcon}>📷</span>
        Camera
      </div>
      <div class={styles.nodeBody}>
        {/* Input port */}
        <div class={styles.handleRow}>
          <Handle type="target" position={Position.Left} id="characterState" style={{ top: 'auto' }} />
          <span class={styles.handleLabelLeft}>Character State</span>
        </div>

        <div class="nopan nodrag">
          <div class={styles.propRow}>
            <span class={styles.propLabel}>Mode</span>
            <select class={styles.propSelect} value={d.mode ?? 'tps-orbit'} onChange={(e: any) => set('mode', e.target.value)}>
              <option value="tps-orbit">TPS Orbit</option>
              <option value="fps">FPS</option>
            </select>
          </div>

          <div class={styles.section}>
            <div class={styles.sectionLabel}>Orbit</div>
            <div class={styles.propRow}>
              <span class={styles.propLabel}>Distance</span>
              <input class={styles.propInput} type="number" step="0.5" value={d.orbitDistance ?? 5} onInput={(e: any) => set('orbitDistance', +e.target.value)} />
            </div>
            <div class={styles.propRow}>
              <span class={styles.propLabel}>Pitch</span>
              <input class={styles.propInput} type="number" step="1" value={d.orbitPitch ?? 20} onInput={(e: any) => set('orbitPitch', +e.target.value)} />
            </div>
            <div class={styles.propRow}>
              <span class={styles.propLabel}>Yaw Offset</span>
              <input class={styles.propInput} type="number" step="5" value={d.initialYawOffset ?? 0} onInput={(e: any) => set('initialYawOffset', +e.target.value)} />
            </div>
            <div class={styles.propRow}>
              <span class={styles.propLabel}>Smooth</span>
              <input class={styles.propInput} type="number" step="0.5" value={d.positionSmoothSpeed ?? 8} onInput={(e: any) => set('positionSmoothSpeed', +e.target.value)} />
            </div>
          </div>

          <div class={styles.section}>
            <div class={styles.sectionLabel}>Look-At Offset</div>
            <div class={styles.propRow}>
              <span class={styles.propLabel}>X</span>
              <input class={styles.propInput} type="number" step="0.1" value={(d.lookAtOffset ?? [0, 1.5, 0])[0]} onInput={(e: any) => set('lookAtOffset', [(+e.target.value), (d.lookAtOffset ?? [0, 1.5, 0])[1], (d.lookAtOffset ?? [0, 1.5, 0])[2]])} />
            </div>
            <div class={styles.propRow}>
              <span class={styles.propLabel}>Y</span>
              <input class={styles.propInput} type="number" step="0.1" value={(d.lookAtOffset ?? [0, 1.5, 0])[1]} onInput={(e: any) => set('lookAtOffset', [(d.lookAtOffset ?? [0, 1.5, 0])[0], (+e.target.value), (d.lookAtOffset ?? [0, 1.5, 0])[2]])} />
            </div>
            <div class={styles.propRow}>
              <span class={styles.propLabel}>Z</span>
              <input class={styles.propInput} type="number" step="0.1" value={(d.lookAtOffset ?? [0, 1.5, 0])[2]} onInput={(e: any) => set('lookAtOffset', [(d.lookAtOffset ?? [0, 1.5, 0])[0], (d.lookAtOffset ?? [0, 1.5, 0])[1], (+e.target.value)])} />
            </div>
          </div>

          <div class={styles.section}>
            <label class={styles.checkbox}>
              <input type="checkbox" checked={d.collisionEnabled ?? true} onChange={(e: any) => set('collisionEnabled', e.target.checked)} />
              Terrain Collision
            </label>
            <label class={styles.checkbox}>
              <input type="checkbox" checked={d.swayEnabled ?? false} onChange={(e: any) => set('swayEnabled', e.target.checked)} />
              Camera Sway
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
