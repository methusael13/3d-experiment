/**
 * Animation State Machine Node — Defines states, clips, and transitions.
 * Input port: characterState.
 *
 * Each state has: name (editable), type (simple/sequence), clip (via AssetPicker), loop toggle.
 * Transitions show from → to with condition summary.
 */

import { useState, useCallback } from 'preact/hooks';
import { Handle, Position, type NodeProps, useReactFlow } from '@xyflow/react';
import type { CCNodePortLayout } from './portTypes';
import { AssetPickerModal } from '../../../ui/AssetPickerModal';
import type { Asset } from '../../../hooks/useAssetLibrary';
import styles from './nodeStyles.module.css';

/** Port definition — co-located with the node component */
export const portDef: CCNodePortLayout = {
  inputs: [
    { id: 'characterState', label: 'Character State', type: 'characterState', direction: 'input' },
  ],
  outputs: [],
};

export function AnimStateMachineNode({ data, id }: NodeProps) {
  const d = data as Record<string, any>;
  const states: any[] = d.states ?? [];
  const transitions: any[] = d.transitions ?? [];
  const { updateNodeData } = useReactFlow();

  // Asset picker state
  const [showPicker, setShowPicker] = useState(false);
  const [pickerStateIndex, setPickerStateIndex] = useState(0);

  const updateState = useCallback((index: number, field: string, value: any) => {
    const newStates = [...states];
    newStates[index] = { ...newStates[index], [field]: value };
    updateNodeData(id, { states: newStates });
  }, [id, states, updateNodeData]);

  const removeState = useCallback((index: number) => {
    const newStates = states.filter((_: any, i: number) => i !== index);
    updateNodeData(id, { states: newStates });
  }, [id, states, updateNodeData]);

  const addState = useCallback(() => {
    const name = `state_${states.length}`;
    updateNodeData(id, {
      states: [...states, { name, type: 'simple', clip: '', loop: true, playbackSpeed: 1.0 }],
    });
  }, [id, states, updateNodeData]);

  const updateTransition = useCallback((index: number, field: string, value: any) => {
    const newTransitions = [...transitions];
    newTransitions[index] = { ...newTransitions[index], [field]: value };
    updateNodeData(id, { transitions: newTransitions });
  }, [id, transitions, updateNodeData]);

  const removeTransition = useCallback((index: number) => {
    const newTransitions = transitions.filter((_: any, i: number) => i !== index);
    updateNodeData(id, { transitions: newTransitions });
  }, [id, transitions, updateNodeData]);

  const addTransition = useCallback(() => {
    updateNodeData(id, {
      transitions: [...transitions, {
        from: 'any',
        to: states[0]?.name ?? 'idle',
        condition: { type: 'comparison', variable: 'speed', operator: '>', value: 0.5 },
      }],
    });
  }, [id, states, transitions, updateNodeData]);

  // Build list of available state names for transition dropdowns (includes 'any')
  const stateOptions = ['any', ...states.map((s: any) => s.name)];

  // Open the asset picker for a specific state
  const handlePickClip = useCallback((index: number) => {
    setPickerStateIndex(index);
    setShowPicker(true);
  }, []);

  // Handle asset selection from the picker
  const handleAssetSelected = useCallback((asset: Asset) => {
    updateState(pickerStateIndex, 'clip', asset.path);
    setShowPicker(false);
  }, [pickerStateIndex, updateState]);

  // Extract just the filename from a path for display
  const clipDisplayName = (clipPath: string): string => {
    if (!clipPath) return '';
    const parts = clipPath.split('/');
    return parts[parts.length - 1].replace('.glb', '').replace('.gltf', '');
  };

  return (
    <div class={styles.node} style={{ minWidth: '280px' }}>
      <div class={styles.animHeader}>
        <span class={styles.nodeHeaderIcon}>🎬</span>
        Animation States
      </div>
      <div class={styles.nodeBody}>
        {/* Input port */}
        <div class={styles.handleRow}>
          <Handle type="target" position={Position.Left} id="characterState" style={{ top: 'auto' }} />
          <span class={styles.handleLabelLeft}>Character State</span>
        </div>

        {/* States list */}
        <div class={styles.section}>
          <div class={styles.sectionLabel}>States ({states.length})</div>
          <div class={styles.stateList}>
            {states.map((s: any, i: number) => (
              <div key={i} class={styles.stateItem} style={{ flexDirection: 'column', gap: '3px', padding: '4px 6px' }}>
                <div class="nopan nodrag" style={{ display: 'flex', gap: '4px', alignItems: 'center', width: '100%' }}>
                  {/* Editable name */}
                  <input
                    style={{
                      flex: 1, padding: '2px 4px', background: '#252525', color: '#ddd',
                      border: '1px solid #444', borderRadius: '2px', fontSize: '10px',
                    }}
                    value={s.name}
                    onInput={(e: any) => updateState(i, 'name', e.target.value)}
                  />
                  {/* Type selector */}
                  <select
                    style={{
                      padding: '2px', background: '#252525', color: '#999',
                      border: '1px solid #444', borderRadius: '2px', fontSize: '9px',
                    }}
                    value={s.type ?? 'simple'}
                    onChange={(e: any) => updateState(i, 'type', e.target.value)}
                  >
                    <option value="simple">simple</option>
                    <option value="sequence">sequence</option>
                  </select>
                  {/* Remove button */}
                  <button
                    style={{
                      padding: '0 4px', background: 'none', color: '#666',
                      border: 'none', cursor: 'pointer', fontSize: '10px',
                    }}
                    onClick={() => removeState(i)}
                    title="Remove state"
                  >✕</button>
                </div>
                {/* Clip assignment via AssetPicker */}
                <div style={{ display: 'flex', gap: '4px', alignItems: 'center', width: '100%' }}>
                  <span style={{ fontSize: '9px', color: '#666', whiteSpace: 'nowrap' }}>Clip:</span>
                  {s.clip ? (
                    <span
                      style={{
                        flex: 1, fontSize: '9px', color: '#aaa', overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}
                      title={s.clip}
                    >
                      {clipDisplayName(s.clip)}
                    </span>
                  ) : (
                    <span style={{ flex: 1, fontSize: '9px', color: '#555', fontStyle: 'italic' }}>none</span>
                  )}
                  <button
                    style={{
                      padding: '1px 6px', background: '#333', color: '#aaa',
                      border: '1px solid #444', borderRadius: '2px', cursor: 'pointer', fontSize: '9px',
                    }}
                    onClick={() => handlePickClip(i)}
                    title="Browse animation clips"
                  >📂</button>
                  {/* Loop toggle */}
                  <label style={{ display: 'flex', alignItems: 'center', gap: '2px', fontSize: '9px', color: '#888' }}>
                    <input
                      type="checkbox"
                      checked={s.loop ?? true}
                      onChange={(e: any) => updateState(i, 'loop', e.target.checked)}
                      style={{ margin: 0 }}
                    />
                    Loop
                  </label>
                </div>
              </div>
            ))}
          </div>
          <button class={styles.addBtn} onClick={addState}>+ Add State</button>
        </div>

        {/* Transitions list */}
        <div class={styles.section}>
          <div class={styles.sectionLabel}>Transitions ({transitions.length})</div>
          <div class="nopan nodrag" style={{ display: 'flex', flexDirection: 'column', gap: '3px', maxHeight: '120px', overflowY: 'auto' }}>
            {transitions.map((t: any, i: number) => (
              <div key={i} style={{
                display: 'flex', flexDirection: 'column', gap: '2px',
                padding: '4px 5px', background: '#1a1a1a', borderRadius: '2px', fontSize: '9px',
              }}>
                {/* Row 1: From → To + remove */}
                <div style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
                  <select
                    style={{ flex: 1, padding: '1px 2px', background: '#252525', color: '#bbb', border: '1px solid #444', borderRadius: '2px', fontSize: '9px' }}
                    value={t.from}
                    onChange={(e: any) => updateTransition(i, 'from', e.target.value)}
                  >
                    {stateOptions.map((name: string) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                  <span style={{ color: '#666' }}>→</span>
                  <select
                    style={{ flex: 1, padding: '1px 2px', background: '#252525', color: '#bbb', border: '1px solid #444', borderRadius: '2px', fontSize: '9px' }}
                    value={t.to}
                    onChange={(e: any) => updateTransition(i, 'to', e.target.value)}
                  >
                    {states.map((s: any) => (
                      <option key={s.name} value={s.name}>{s.name}</option>
                    ))}
                  </select>
                  <button
                    style={{ padding: '0 3px', background: 'none', color: '#666', border: 'none', cursor: 'pointer', fontSize: '9px' }}
                    onClick={() => removeTransition(i)}
                    title="Remove transition"
                  >✕</button>
                </div>
                {/* Row 2+: Condition builder — supports AND composite */}
                {(() => {
                  // Normalize condition to an array for AND display
                  const cond = t.condition;
                  const conditions: any[] = cond?.type === 'and' ? cond.children : [cond ?? { type: 'comparison', variable: 'speed', operator: '>', value: 0.5 }];

                  const updateConditions = (newConds: any[]) => {
                    if (newConds.length === 1) {
                      updateTransition(i, 'condition', newConds[0]);
                    } else {
                      updateTransition(i, 'condition', { type: 'and', children: newConds });
                    }
                  };

                  const updateSingleCond = (ci: number, newCond: any) => {
                    const updated = [...conditions];
                    updated[ci] = newCond;
                    updateConditions(updated);
                  };

                  const removeCond = (ci: number) => {
                    const updated = conditions.filter((_: any, j: number) => j !== ci);
                    if (updated.length === 0) return;
                    updateConditions(updated);
                  };

                  const addCond = () => {
                    updateConditions([...conditions, { type: 'comparison', variable: 'grounded', operator: '==', value: true }]);
                  };

                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', paddingLeft: '2px' }}>
                      {conditions.map((c: any, ci: number) => (
                        <div key={ci} style={{ display: 'flex', gap: '2px', alignItems: 'center' }}>
                          <span style={{ color: '#555', fontSize: '7px', width: '22px' }}>{ci === 0 ? 'when' : 'AND'}</span>
                          <select
                            style={{ flex: 1, padding: '1px', background: '#222', color: '#aaa', border: '1px solid #3a3a3a', borderRadius: '2px', fontSize: '8px' }}
                            value={c?.type === 'input' ? `input_${c.action}` : c?.type === 'clipFinished' ? 'clipFinished' : (c?.variable ?? 'speed')}
                            onChange={(e: any) => {
                              const v = e.target.value;
                              if (v.startsWith('input_')) {
                                updateSingleCond(ci, { type: 'input', action: v.replace('input_', '') });
                              } else if (v === 'clipFinished') {
                                updateSingleCond(ci, { type: 'clipFinished' });
                              } else {
                                updateSingleCond(ci, { type: 'comparison', variable: v, operator: c?.operator ?? '>', value: c?.value ?? 0 });
                              }
                            }}
                          >
                            <optgroup label="Variables">
                              <option value="speed">speed</option>
                              <option value="grounded">grounded</option>
                              <option value="velY">velY</option>
                              <option value="airTime">airTime</option>
                            </optgroup>
                            <optgroup label="Input">
                              <option value="input_jump">input: jump</option>
                              <option value="input_attack">input: attack</option>
                              <option value="input_dodge">input: dodge</option>
                            </optgroup>
                            <optgroup label="Clip">
                              <option value="clipFinished">clip finished</option>
                            </optgroup>
                          </select>
                          {c?.type === 'comparison' && (
                            <>
                              <select
                                style={{ width: '28px', padding: '1px', background: '#222', color: '#aaa', border: '1px solid #3a3a3a', borderRadius: '2px', fontSize: '8px' }}
                                value={c.operator ?? '>'}
                                onChange={(e: any) => updateSingleCond(ci, { ...c, operator: e.target.value })}
                              >
                                <option value=">">&gt;</option>
                                <option value="<">&lt;</option>
                                <option value=">=">&gt;=</option>
                                <option value="<=">&lt;=</option>
                                <option value="==">==</option>
                                <option value="!=">!=</option>
                              </select>
                              <input
                                style={{ width: '30px', padding: '1px 2px', background: '#222', color: '#bbb', border: '1px solid #3a3a3a', borderRadius: '2px', fontSize: '8px', textAlign: 'right' }}
                                type="number"
                                step="0.1"
                                value={c.value ?? 0}
                                onInput={(e: any) => updateSingleCond(ci, { ...c, value: +e.target.value })}
                              />
                            </>
                          )}
                          {conditions.length > 1 && (
                            <button style={{ padding: '0 2px', background: 'none', color: '#555', border: 'none', cursor: 'pointer', fontSize: '8px' }} onClick={() => removeCond(ci)}>✕</button>
                          )}
                        </div>
                      ))}
                      <button
                        style={{ alignSelf: 'flex-start', padding: '1px 4px', background: 'none', color: '#555', border: '1px dashed #3a3a3a', borderRadius: '2px', cursor: 'pointer', fontSize: '7px', marginTop: '1px' }}
                        onClick={addCond}
                      >+ AND</button>
                    </div>
                  );
                })()}
              </div>
            ))}
          </div>
          <button class={styles.addBtn} onClick={addTransition}>+ Add Transition</button>
        </div>

        <div class="nopan nodrag">
          <div class={styles.propRow}>
            <span class={styles.propLabel}>Default Blend</span>
            <input
              class={styles.propInput}
              type="number"
              step="0.05"
              value={d.defaultBlendDuration ?? 0.2}
              onInput={(e: any) => updateNodeData(id, { defaultBlendDuration: +e.target.value })}
            />
          </div>
        </div>
      </div>

      {/* Asset Picker Modal for clip selection */}
      <AssetPickerModal
        isOpen={showPicker}
        title={`Select Animation: ${states[pickerStateIndex]?.name ?? ''}`}
        filterType="model"
        filterCategory="animation"
        onSelect={handleAssetSelected}
        onClose={() => setShowPicker(false)}
      />
    </div>
  );
}
