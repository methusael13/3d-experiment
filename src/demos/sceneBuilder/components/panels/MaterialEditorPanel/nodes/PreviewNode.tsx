/**
 * Preview Node - 2D material preview
 * 
 * Input: material (from PBR node)
 * Displays a simplified 2D sphere preview showing albedo, metallic, roughness.
 */

import { useMemo } from 'preact/hooks';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import styles from './nodeStyles.module.css';

interface PreviewNodeData {
  albedo?: [number, number, number];
  metallic?: number;
  roughness?: number;
  [key: string]: unknown;
}

/**
 * Generate a simple 2D sphere gradient CSS to approximate PBR appearance.
 */
function generatePreviewGradient(
  albedo: [number, number, number],
  metallic: number,
  roughness: number,
): string {
  const [r, g, b] = albedo.map(v => Math.round(v * 255));
  
  const highlightIntensity = 1.0 - roughness * 0.7;
  const highlightSize = 15 + roughness * 30;
  
  const specR = Math.round(metallic > 0.5 ? r * highlightIntensity + 255 * (1 - metallic) * highlightIntensity : 255 * highlightIntensity);
  const specG = Math.round(metallic > 0.5 ? g * highlightIntensity + 255 * (1 - metallic) * highlightIntensity : 255 * highlightIntensity);
  const specB = Math.round(metallic > 0.5 ? b * highlightIntensity + 255 * (1 - metallic) * highlightIntensity : 255 * highlightIntensity);
  
  const shadowR = Math.round(r * 0.15);
  const shadowG = Math.round(g * 0.15);
  const shadowB = Math.round(b * 0.15);
  
  const midR = Math.round(r * 0.6);
  const midG = Math.round(g * 0.6);
  const midB = Math.round(b * 0.6);
  
  return `radial-gradient(circle at 35% 30%, 
    rgba(${specR},${specG},${specB},${highlightIntensity * 0.9}) 0%, 
    rgba(${specR},${specG},${specB},0) ${highlightSize}%),
    radial-gradient(circle at 45% 40%, 
    rgb(${r},${g},${b}) 0%, 
    rgb(${midR},${midG},${midB}) 50%, 
    rgb(${shadowR},${shadowG},${shadowB}) 100%)`;
}

export function PreviewNode({ data }: NodeProps) {
  const d = data as PreviewNodeData;
  
  const albedo: [number, number, number] = d.albedo ?? [0.75, 0.75, 0.75];
  const metallic = d.metallic ?? 0;
  const roughness = d.roughness ?? 0.5;
  
  const gradient = useMemo(() => 
    generatePreviewGradient(albedo, metallic, roughness),
    [albedo[0], albedo[1], albedo[2], metallic, roughness]
  );
  
  return (
    <div class={styles.node} style={{ minWidth: '180px' }}>
      <div class={styles.previewHeader}>
        <span class={styles.nodeHeaderIcon}>👁️</span>
        Preview
      </div>
      <div class={styles.nodeBody}>
        {/* Material input */}
        <div class={styles.handleRow}>
          <Handle type="target" position={Position.Left} id="material" style={{ top: 'auto' }} />
          <span class={styles.handleLabelLeft}>Material</span>
        </div>
        
        {/* 2D sphere preview */}
        <div class={styles.previewContainer}>
          <div
            class={styles.previewSphere}
            style={{ background: gradient }}
          />
        </div>
        <div class={styles.previewLabel}>
          2D Preview
        </div>
      </div>
    </div>
  );
}
