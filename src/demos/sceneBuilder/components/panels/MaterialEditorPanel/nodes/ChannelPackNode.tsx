/**
 * Channel Pack Node - Combines separate textures into a single packed RGBA texture
 * 
 * Inputs: R Channel, G Channel, B Channel, A Channel (accept Number or Texture Set outputs)
 * Output: Single packed RGBA texture
 * 
 * Presets:
 * - Metallic-Roughness (MR): R=0, G=roughness, B=metallic, A=1
 * - ARM (AO+Rough+Metal): R=AO, G=roughness, B=metallic, A=1
 * - Custom: user-defined
 */

import { useCallback, useState } from 'preact/hooks';
import { Handle, Position, type NodeProps, useReactFlow } from '@xyflow/react';
import type { NodePortDef } from './portTypes';
import styles from './nodeStyles.module.css';

/** Port definition — co-located with the node component */
export const portDef: NodePortDef = {
  outputs: {
    packed: { type: 'texture', dataKey: 'packedResult' },
  },
  inputs: {
    channelR: { accepts: ['float', 'texture'], dataKey: 'channelR' },
    channelG: { accepts: ['float', 'texture'], dataKey: 'channelG' },
    channelB: { accepts: ['float', 'texture'], dataKey: 'channelB' },
    channelA: { accepts: ['float', 'texture'], dataKey: 'channelA' },
  },
};

export type ChannelPackPreset = 'mr' | 'arm' | 'custom';

interface ChannelPackNodeData {
  preset?: ChannelPackPreset;
  scalarR?: number;
  scalarG?: number;
  scalarB?: number;
  scalarA?: number;
  [key: string]: unknown;
}

const PRESET_LABELS: Record<ChannelPackPreset, string> = {
  mr: 'Metallic-Roughness',
  arm: 'ARM (AO+Rough+Metal)',
  custom: 'Custom',
};

const PRESET_DEFAULTS: Record<ChannelPackPreset, { r: number; g: number; b: number; a: number }> = {
  mr: { r: 0, g: 1, b: 0, a: 1 },
  arm: { r: 1, g: 1, b: 0, a: 1 },
  custom: { r: 0, g: 0, b: 0, a: 1 },
};

const CHANNEL_LABELS: Record<ChannelPackPreset, [string, string, string, string]> = {
  mr: ['(unused)', 'Roughness', 'Metallic', '(1.0)'],
  arm: ['AO', 'Roughness', 'Metallic', '(1.0)'],
  custom: ['R Channel', 'G Channel', 'B Channel', 'A Channel'],
};

/** Channel color coding */
const CHANNEL_COLORS = ['#ff6666', '#66ff66', '#6666ff', '#cccccc'];

export function ChannelPackNode({ data, id }: NodeProps) {
  const d = data as ChannelPackNodeData;
  const preset: ChannelPackPreset = d.preset ?? 'mr';
  const { updateNodeData } = useReactFlow();
  
  // Track which inputs have external connections
  const connectedInputs = new Set<string>((d._connectedInputs as string[]) ?? []);
  
  const labels = CHANNEL_LABELS[preset];
  
  const handlePresetChange = useCallback((e: Event) => {
    const newPreset = (e.target as HTMLSelectElement).value as ChannelPackPreset;
    const defaults = PRESET_DEFAULTS[newPreset];
    updateNodeData(id, {
      preset: newPreset,
      scalarR: defaults.r,
      scalarG: defaults.g,
      scalarB: defaults.b,
      scalarA: defaults.a,
    });
  }, [id, updateNodeData]);
  
  const handleScalar = useCallback((channel: string) => (e: Event) => {
    updateNodeData(id, { [channel]: parseFloat((e.target as HTMLInputElement).value) });
  }, [id, updateNodeData]);
  
  return (
    <div class={styles.node} style={{ minWidth: '200px' }}>
      <div class={styles.channelPackHeader}>
        <span class={styles.nodeHeaderIcon}>🔀</span>
        Channel Pack
      </div>
      <div class={styles.nodeBody}>
        {/* Preset selector */}
        <div class={styles.handleRow} style={{ justifyContent: 'center', paddingBottom: '4px' }}>
          <select
            class={`${styles.presetSelect} nopan nodrag`}
            value={preset}
            onChange={handlePresetChange}
          >
            <option value="mr">{PRESET_LABELS.mr}</option>
            <option value="arm">{PRESET_LABELS.arm}</option>
            <option value="custom">{PRESET_LABELS.custom}</option>
          </select>
        </div>
        
        {/* R Channel input */}
        <div class={styles.handleRow}>
          <Handle type="target" position={Position.Left} id="channelR" />
          <span class={styles.handleLabelLeft} style={{ color: CHANNEL_COLORS[0] }}>
            {labels[0]}
          </span>
          {!connectedInputs.has('channelR') && (
            <div class={`${styles.inlineControl} nopan nodrag`}>
              <input
                type="range"
                class={styles.inlineSlider}
                min="0" max="1" step="0.01"
                value={d.scalarR ?? PRESET_DEFAULTS[preset].r}
                onInput={handleScalar('scalarR')}
              />
              <span class={styles.inlineValue}>
                {(d.scalarR ?? PRESET_DEFAULTS[preset].r).toFixed(2)}
              </span>
            </div>
          )}
          {connectedInputs.has('channelR') && (
            <span class={styles.inlineValue} style={{ color: '#4a9eff', fontStyle: 'italic' }}>linked</span>
          )}
        </div>
        
        {/* G Channel input */}
        <div class={styles.handleRow}>
          <Handle type="target" position={Position.Left} id="channelG" />
          <span class={styles.handleLabelLeft} style={{ color: CHANNEL_COLORS[1] }}>
            {labels[1]}
          </span>
          {!connectedInputs.has('channelG') && (
            <div class={`${styles.inlineControl} nopan nodrag`}>
              <input
                type="range"
                class={styles.inlineSlider}
                min="0" max="1" step="0.01"
                value={d.scalarG ?? PRESET_DEFAULTS[preset].g}
                onInput={handleScalar('scalarG')}
              />
              <span class={styles.inlineValue}>
                {(d.scalarG ?? PRESET_DEFAULTS[preset].g).toFixed(2)}
              </span>
            </div>
          )}
          {connectedInputs.has('channelG') && (
            <span class={styles.inlineValue} style={{ color: '#4a9eff', fontStyle: 'italic' }}>linked</span>
          )}
        </div>
        
        {/* B Channel input */}
        <div class={styles.handleRow}>
          <Handle type="target" position={Position.Left} id="channelB" />
          <span class={styles.handleLabelLeft} style={{ color: CHANNEL_COLORS[2] }}>
            {labels[2]}
          </span>
          {!connectedInputs.has('channelB') && (
            <div class={`${styles.inlineControl} nopan nodrag`}>
              <input
                type="range"
                class={styles.inlineSlider}
                min="0" max="1" step="0.01"
                value={d.scalarB ?? PRESET_DEFAULTS[preset].b}
                onInput={handleScalar('scalarB')}
              />
              <span class={styles.inlineValue}>
                {(d.scalarB ?? PRESET_DEFAULTS[preset].b).toFixed(2)}
              </span>
            </div>
          )}
          {connectedInputs.has('channelB') && (
            <span class={styles.inlineValue} style={{ color: '#4a9eff', fontStyle: 'italic' }}>linked</span>
          )}
        </div>
        
        {/* A Channel input */}
        <div class={styles.handleRow}>
          <Handle type="target" position={Position.Left} id="channelA" />
          <span class={styles.handleLabelLeft} style={{ color: CHANNEL_COLORS[3] }}>
            {labels[3]}
          </span>
          {!connectedInputs.has('channelA') && (
            <div class={`${styles.inlineControl} nopan nodrag`}>
              <input
                type="range"
                class={styles.inlineSlider}
                min="0" max="1" step="0.01"
                value={d.scalarA ?? PRESET_DEFAULTS[preset].a}
                onInput={handleScalar('scalarA')}
              />
              <span class={styles.inlineValue}>
                {(d.scalarA ?? PRESET_DEFAULTS[preset].a).toFixed(2)}
              </span>
            </div>
          )}
          {connectedInputs.has('channelA') && (
            <span class={styles.inlineValue} style={{ color: '#4a9eff', fontStyle: 'italic' }}>linked</span>
          )}
        </div>
        
        {/* Packed output */}
        <div class={styles.outputSection}>
          <div class={styles.outputHandle}>
            <span class={styles.handleLabelRight}>Packed</span>
            <Handle type="source" position={Position.Right} id="packed" />
          </div>
        </div>
        
        {/* Visual channel preview */}
        <div class={styles.channelPreview}>
          <div class={styles.channelBar} style={{ background: CHANNEL_COLORS[0], opacity: 0.7 }} />
          <div class={styles.channelBar} style={{ background: CHANNEL_COLORS[1], opacity: 0.7 }} />
          <div class={styles.channelBar} style={{ background: CHANNEL_COLORS[2], opacity: 0.7 }} />
          <div class={styles.channelBar} style={{ background: CHANNEL_COLORS[3], opacity: 0.5 }} />
        </div>
      </div>
    </div>
  );
}
