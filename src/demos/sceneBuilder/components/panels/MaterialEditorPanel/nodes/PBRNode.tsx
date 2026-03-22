/**
 * PBR Node - Central material definition node
 * 
 * Inputs: albedo, metallic, roughness, normal, occlusion, emissive, ior, clearcoat
 * Output: material (connects to Preview node)
 * 
 * Each input shows an inline control when no edge is connected.
 * Uses `nopan nodrag` CSS classes to allow interactive controls inside nodes.
 */

import { useCallback } from 'preact/hooks';
import { Handle, Position, type NodeProps, useReactFlow } from '@xyflow/react';
import type { NodePortDef } from './portTypes';
import styles from './nodeStyles.module.css';

/**
 * Smart receiver for PBR inputs that accept both scalar/color AND texture values.
 * - If the incoming value is a string → it's a texture path, stored under `{handle}TexPath`
 * - If it's a number or array → it's a scalar/color, stored under the normal data key
 * This prevents texture path strings from overwriting albedo RGB arrays, etc.
 */
function pbrInputReceiver(scalarKey: string) {
  return (value: unknown, handleId: string): Record<string, unknown> => {
    if (typeof value === 'string') {
      // Texture path — store separately so scalar value is preserved
      return { [`${handleId}TexPath`]: value };
    }
    return { [scalarKey]: value };
  };
}

/** Port definition — co-located with the node component */
export const portDef: NodePortDef = {
  outputs: {
    material: { type: 'material', spread: true },
  },
  inputs: {
    // Inputs that accept both scalar/color AND texture use smart receivers
    metallic:           { accepts: ['float', 'texture'], receiver: pbrInputReceiver('metallic') },
    roughness:          { accepts: ['float', 'texture'], receiver: pbrInputReceiver('roughness') },
    albedo:             { accepts: ['color', 'texture'],  receiver: pbrInputReceiver('albedo') },
    emissive:           { accepts: ['texture'],           receiver: (_v, h) => ({ [`${h}TexPath`]: _v }) },
    // Pure scalar inputs (never receive texture paths)
    ior:                { accepts: ['float'],             dataKey: 'ior' },
    clearcoat:          { accepts: ['float'],             dataKey: 'clearcoatFactor' },
    normalScale:        { accepts: ['float'],             dataKey: 'normalScale' },
    occlusionStrength:  { accepts: ['float'],             dataKey: 'occlusionStrength' },
    // Pure texture inputs — always string paths
    normal:             { accepts: ['texture'],           receiver: (_v, h) => ({ [`${h}TexPath`]: _v }) },
    occlusion:          { accepts: ['texture'],           receiver: (_v, h) => ({ [`${h}TexPath`]: _v }) },
    metallicRoughness:  { accepts: ['texture'],           receiver: (_v, h) => ({ [`${h}TexPath`]: _v }) },
    bump:               { accepts: ['texture'],           receiver: (_v, h) => ({ [`${h}TexPath`]: _v }) },
    displacement:       { accepts: ['texture'],           receiver: (_v, h) => ({ [`${h}TexPath`]: _v }) },
    // Pure scalar inputs for bump/displacement parameters
    bumpScale:          { accepts: ['float'],             dataKey: 'bumpScale' },
    displacementScale:  { accepts: ['float'],             dataKey: 'displacementScale' },
  },
};

interface PBRNodeData {
  albedo?: [number, number, number];
  metallic?: number;
  roughness?: number;
  ior?: number;
  clearcoatFactor?: number;
  clearcoatRoughness?: number;
  emissiveFactor?: [number, number, number];
  normalScale?: number;
  occlusionStrength?: number;
  bumpScale?: number;
  displacementScale?: number;
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

export function PBRNode({ data, id }: NodeProps) {
  const d = data as PBRNodeData;
  const albedo = d.albedo ?? [0.75, 0.75, 0.75];
  const metallic = d.metallic ?? 0;
  const roughness = d.roughness ?? 0.5;
  const ior = d.ior ?? 1.5;
  const clearcoat = d.clearcoatFactor ?? 0;
  const { updateNodeData } = useReactFlow();
  
  // Track which inputs have external connections (set by propagateData in MaterialNodeEditor)
  const connectedInputs = new Set<string>((d._connectedInputs as string[]) ?? []);
  const isConnected = (handle: string) => connectedInputs.has(handle);

  const handleAlbedoChange = useCallback((e: Event) => {
    const hex = (e.target as HTMLInputElement).value;
    updateNodeData(id, { albedo: hexToRgb(hex) });
  }, [id, updateNodeData]);

  const handleSlider = useCallback((key: string) => (e: Event) => {
    updateNodeData(id, { [key]: parseFloat((e.target as HTMLInputElement).value) });
  }, [id, updateNodeData]);

  return (
    <div class={styles.node}>
      <div class={styles.pbrHeader}>
        <span class={styles.nodeHeaderIcon}>🔮</span>
        PBR Material
      </div>
      <div class={styles.nodeBody}>
        {/* Albedo input */}
        <div class={styles.handleRow}>
          <Handle type="target" position={Position.Left} id="albedo" />
          <span class={styles.handleLabelLeft}>Albedo</span>
          {isConnected('albedo') ? (
            <span class={styles.inlineValue} style={{ color: '#4a9eff', fontStyle: 'italic' }}>linked</span>
          ) : (
            <input
              type="color"
              class={`${styles.colorInput} nopan nodrag`}
              value={rgbToHex(albedo[0], albedo[1], albedo[2])}
              onInput={handleAlbedoChange}
            />
          )}
        </div>
        
        {/* Metallic input — disabled when MR packed is connected */}
        <div class={styles.handleRow}>
          <Handle type="target" position={Position.Left} id="metallic" />
          <span class={styles.handleLabelLeft}>Metallic</span>
          {isConnected('metallicRoughness') ? (
            <span class={styles.inlineValue} style={{ color: '#888', fontStyle: 'italic' }}>overridden</span>
          ) : isConnected('metallic') ? (
            <span class={styles.inlineValue} style={{ color: '#4a9eff', fontStyle: 'italic' }}>linked</span>
          ) : (
            <div class={`${styles.inlineControl} nopan nodrag`}>
              <input type="range" class={styles.inlineSlider} min="0" max="1" step="0.01" value={metallic} onInput={handleSlider('metallic')} />
              <span class={styles.inlineValue}>{metallic.toFixed(2)}</span>
            </div>
          )}
        </div>
        
        {/* Roughness input — disabled when MR packed is connected */}
        <div class={styles.handleRow}>
          <Handle type="target" position={Position.Left} id="roughness" />
          <span class={styles.handleLabelLeft}>Roughness</span>
          {isConnected('metallicRoughness') ? (
            <span class={styles.inlineValue} style={{ color: '#888', fontStyle: 'italic' }}>overridden</span>
          ) : isConnected('roughness') ? (
            <span class={styles.inlineValue} style={{ color: '#4a9eff', fontStyle: 'italic' }}>linked</span>
          ) : (
            <div class={`${styles.inlineControl} nopan nodrag`}>
              <input type="range" class={styles.inlineSlider} min="0.04" max="1" step="0.01" value={roughness} onInput={handleSlider('roughness')} />
              <span class={styles.inlineValue}>{roughness.toFixed(2)}</span>
            </div>
          )}
        </div>
        
        {/* MetallicRoughness packed texture input */}
        <div class={styles.handleRow}>
          <Handle type="target" position={Position.Left} id="metallicRoughness" />
          <span class={styles.handleLabelLeft}>MR Packed</span>
          {isConnected('metallicRoughness') && <span class={styles.inlineValue} style={{ color: '#4a9eff', fontStyle: 'italic' }}>linked</span>}
        </div>
        
        {/* Normal input */}
        <div class={styles.handleRow}>
          <Handle type="target" position={Position.Left} id="normal" />
          <span class={styles.handleLabelLeft}>Normal</span>
          {isConnected('normal') && <span class={styles.inlineValue} style={{ color: '#4a9eff', fontStyle: 'italic' }}>linked</span>}
        </div>
        
        {/* Occlusion input */}
        <div class={styles.handleRow}>
          <Handle type="target" position={Position.Left} id="occlusion" />
          <span class={styles.handleLabelLeft}>Occlusion</span>
          {isConnected('occlusion') && <span class={styles.inlineValue} style={{ color: '#4a9eff', fontStyle: 'italic' }}>linked</span>}
        </div>
        
        {/* Emissive input */}
        <div class={styles.handleRow}>
          <Handle type="target" position={Position.Left} id="emissive" />
          <span class={styles.handleLabelLeft}>Emissive</span>
          {isConnected('emissive') && <span class={styles.inlineValue} style={{ color: '#4a9eff', fontStyle: 'italic' }}>linked</span>}
        </div>
        
        {/* Bump input */}
        <div class={styles.handleRow}>
          <Handle type="target" position={Position.Left} id="bump" />
          <span class={styles.handleLabelLeft}>Bump</span>
          {isConnected('bump') ? (
            <span class={styles.inlineValue} style={{ color: '#4a9eff', fontStyle: 'italic' }}>linked</span>
          ) : (
            <span class={styles.inlineValue} style={{ color: '#666' }}>—</span>
          )}
        </div>
        
        {/* Bump Scale (only shown when bump is connected) */}
        {isConnected('bump') && (
          <div class={styles.handleRow}>
            <Handle type="target" position={Position.Left} id="bumpScale" />
            <span class={styles.handleLabelLeft}>Bump Scale</span>
            <div class={`${styles.inlineControl} nopan nodrag`}>
              <input type="range" class={styles.inlineSlider} min="0" max="5" step="0.1" value={d.bumpScale ?? 1.0} onInput={handleSlider('bumpScale')} />
              <span class={styles.inlineValue}>{(d.bumpScale ?? 1.0).toFixed(1)}</span>
            </div>
          </div>
        )}
        
        {/* Displacement input */}
        <div class={styles.handleRow}>
          <Handle type="target" position={Position.Left} id="displacement" />
          <span class={styles.handleLabelLeft}>Displacement</span>
          {isConnected('displacement') ? (
            <span class={styles.inlineValue} style={{ color: '#4a9eff', fontStyle: 'italic' }}>linked</span>
          ) : (
            <span class={styles.inlineValue} style={{ color: '#666' }}>—</span>
          )}
        </div>
        
        {/* Displacement Scale (only shown when displacement is connected) */}
        {isConnected('displacement') && (
          <div class={styles.handleRow}>
            <Handle type="target" position={Position.Left} id="displacementScale" />
            <span class={styles.handleLabelLeft}>Disp Scale</span>
            <div class={`${styles.inlineControl} nopan nodrag`}>
              <input type="range" class={styles.inlineSlider} min="0" max="0.5" step="0.005" value={d.displacementScale ?? 0.05} onInput={handleSlider('displacementScale')} />
              <span class={styles.inlineValue}>{(d.displacementScale ?? 0.05).toFixed(3)}</span>
            </div>
          </div>
        )}
        
        {/* IOR */}
        <div class={styles.handleRow}>
          <Handle type="target" position={Position.Left} id="ior" />
          <span class={styles.handleLabelLeft}>IOR</span>
          {isConnected('ior') ? (
            <span class={styles.inlineValue} style={{ color: '#4a9eff', fontStyle: 'italic' }}>linked</span>
          ) : (
            <div class={`${styles.inlineControl} nopan nodrag`}>
              <input type="range" class={styles.inlineSlider} min="1" max="3" step="0.01" value={ior} onInput={handleSlider('ior')} />
              <span class={styles.inlineValue}>{ior.toFixed(2)}</span>
            </div>
          )}
        </div>
        
        {/* Clearcoat */}
        <div class={styles.handleRow}>
          <Handle type="target" position={Position.Left} id="clearcoat" />
          <span class={styles.handleLabelLeft}>Clearcoat</span>
          {isConnected('clearcoat') ? (
            <span class={styles.inlineValue} style={{ color: '#4a9eff', fontStyle: 'italic' }}>linked</span>
          ) : (
            <div class={`${styles.inlineControl} nopan nodrag`}>
              <input type="range" class={styles.inlineSlider} min="0" max="1" step="0.01" value={clearcoat} onInput={handleSlider('clearcoatFactor')} />
              <span class={styles.inlineValue}>{clearcoat.toFixed(2)}</span>
            </div>
          )}
        </div>
        
        {/* Material output */}
        <div class={styles.outputSection}>
          <div class={styles.outputHandle}>
            <span class={styles.handleLabelRight}>Material</span>
            <Handle type="source" position={Position.Right} id="material" />
          </div>
        </div>
      </div>
    </div>
  );
}
