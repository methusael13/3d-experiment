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
import styles from './nodeStyles.module.css';

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
        
        {/* Metallic input */}
        <div class={styles.handleRow}>
          <Handle type="target" position={Position.Left} id="metallic" />
          <span class={styles.handleLabelLeft}>Metallic</span>
          {isConnected('metallic') ? (
            <span class={styles.inlineValue} style={{ color: '#4a9eff', fontStyle: 'italic' }}>linked</span>
          ) : (
            <div class={`${styles.inlineControl} nopan nodrag`}>
              <input type="range" class={styles.inlineSlider} min="0" max="1" step="0.01" value={metallic} onInput={handleSlider('metallic')} />
              <span class={styles.inlineValue}>{metallic.toFixed(2)}</span>
            </div>
          )}
        </div>
        
        {/* Roughness input */}
        <div class={styles.handleRow}>
          <Handle type="target" position={Position.Left} id="roughness" />
          <span class={styles.handleLabelLeft}>Roughness</span>
          {isConnected('roughness') ? (
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
