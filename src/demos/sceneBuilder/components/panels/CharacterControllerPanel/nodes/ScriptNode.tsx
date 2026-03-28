/**
 * Script Node — Attaches a custom TypeScript script to the character controller.
 *
 * The Script Node references a .ts file under public/scripts/ and displays
 * user-configurable parameters declared in the script's exported `params` object.
 * Multiple Script Nodes can be connected to the same Character Node.
 *
 * Input port: characterState (from Character Node)
 * Output ports: none (terminal node — scripts modify components via ECS API)
 */

import { useCallback } from 'preact/hooks';
import { Handle, Position, type NodeProps, useReactFlow } from '@xyflow/react';
import type { CCNodePortLayout } from './portTypes';
import styles from './nodeStyles.module.css';

/** Port definition */
export const portDef: CCNodePortLayout = {
  inputs: [
    { id: 'characterState', label: 'Character State', type: 'characterState', direction: 'input' },
  ],
  outputs: [],
};

export function ScriptNode({ data, id }: NodeProps) {
  const d = data as Record<string, any>;
  const { updateNodeData } = useReactFlow();

  const scriptPath = (d.scriptPath as string) || '';
  const label = (d.label as string) || 'Script';
  const playModeOnly = d.playModeOnly !== false; // Default true
  const exposedParams = (d.exposedParams as ScriptParamUI[]) || [];

  const setField = useCallback((key: string, value: any) => {
    updateNodeData(id, { [key]: value });
  }, [id, updateNodeData]);

  const setParam = useCallback((paramName: string, value: number | boolean | string) => {
    const updated = [...exposedParams];
    const idx = updated.findIndex(p => p.name === paramName);
    if (idx >= 0) {
      updated[idx] = { ...updated[idx], value };
      updateNodeData(id, { exposedParams: updated });
    }
  }, [id, updateNodeData, exposedParams]);

  return (
    <div class={styles.node}>
      <div class={styles.scriptHeader}>
        <span class={styles.nodeHeaderIcon}>📜</span>
        {label || 'Script'}
      </div>
      <div class={styles.nodeBody}>
        {/* Input port */}
        <div class={styles.handleRow}>
          <Handle type="target" position={Position.Left} id="characterState" style={{ top: 'auto' }} />
          <span class={styles.handleLabelLeft}>Character State</span>
        </div>

        {/* Script path */}
        <div class={styles.section}>
          <div class={styles.sectionLabel}>Script</div>
          <div class="nopan nodrag">
            <div class={styles.propRow}>
              <span class={styles.propLabel}>Path</span>
              <input
                class={styles.propInput}
                style={{ width: '110px' }}
                type="text"
                placeholder="camera-sway.ts"
                value={scriptPath}
                onInput={(e: any) => setField('scriptPath', e.target.value)}
              />
            </div>
            <div class={styles.propRow}>
              <span class={styles.propLabel}>Label</span>
              <input
                class={styles.propInput}
                style={{ width: '110px' }}
                type="text"
                placeholder="Script"
                value={label}
                onInput={(e: any) => setField('label', e.target.value)}
              />
            </div>
            <div class={styles.checkbox}>
              <input
                type="checkbox"
                checked={playModeOnly}
                onChange={(e: any) => setField('playModeOnly', e.target.checked)}
              />
              Play Mode Only
            </div>
          </div>
        </div>

        {/* Exposed parameters */}
        {exposedParams.length > 0 && (
          <div class={styles.section}>
            <div class={styles.sectionLabel}>Parameters</div>
            <div class="nopan nodrag">
              {exposedParams.map((param) => (
                <div key={param.name} class={styles.propRow}>
                  <span class={styles.propLabel}>{param.name}</span>
                  {param.type === 'number' && (
                    <input
                      class={styles.propInput}
                      type="number"
                      step={param.step ?? 0.01}
                      min={param.min}
                      max={param.max}
                      value={param.value as number}
                      onInput={(e: any) => setParam(param.name, +e.target.value)}
                    />
                  )}
                  {param.type === 'boolean' && (
                    <input
                      type="checkbox"
                      checked={param.value as boolean}
                      onChange={(e: any) => setParam(param.name, e.target.checked)}
                    />
                  )}
                  {param.type === 'string' && (
                    <input
                      class={styles.propInput}
                      style={{ width: '80px' }}
                      type="text"
                      value={param.value as string}
                      onInput={(e: any) => setParam(param.name, e.target.value)}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Add param button */}
        <button
          class={styles.addBtn}
          onClick={() => {
            const newParam: ScriptParamUI = {
              name: `param${exposedParams.length}`,
              type: 'number',
              value: 0,
              min: 0,
              max: 1,
              step: 0.01,
            };
            setField('exposedParams', [...exposedParams, newParam]);
          }}
        >
          + Add Param
        </button>
      </div>
    </div>
  );
}

/** Local UI type for script parameters displayed in the node */
interface ScriptParamUI {
  name: string;
  type: 'number' | 'boolean' | 'string';
  value: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
}
