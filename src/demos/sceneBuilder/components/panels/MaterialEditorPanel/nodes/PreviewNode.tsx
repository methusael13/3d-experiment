/**
 * Preview Node - GPU-rendered 3D material preview
 * 
 * Input: material (from PBR node)
 * Renders a PBR sphere/cube/plane using the offscreen MaterialPreviewRenderer.
 * Falls back to CSS gradient when GPU is not available.
 * 
 * Features:
 * - Shape selector: sphere (default), cube, plane
 * - Debounced GPU rendering (~150ms) on PBR property changes
 * - Texture propagation: loads and samples actual textures on the preview mesh
 * - Canvas-based display inside the React Flow node
 */

import { useRef, useMemo, useEffect, useState, useCallback } from 'preact/hooks';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { GPUContext } from '@/core/gpu/GPUContext';
import {
  getMaterialPreviewRenderer,
  type PreviewMaterialProps,
  type PreviewShape,
} from '@/core/materials/MaterialPreviewRenderer';
import type { NodePortDef } from './portTypes';
import styles from './nodeStyles.module.css';

/** Port definition — co-located with the node component */
export const portDef: NodePortDef = {
  outputs: {},
  inputs: {
    material: {
      accepts: ['material'],
      receiver: (value) => {
        const pbrData = value as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        
        // Forward all PBR scalar properties directly
        const directKeys = [
          'albedo', 'metallic', 'roughness', 'normalScale', 'occlusionStrength',
          'emissiveFactor', 'ior', 'clearcoatFactor', 'clearcoatRoughness', 'alphaCutoff',
        ];
        for (const key of directKeys) {
          if (pbrData[key] !== undefined) {
            result[key] = pbrData[key];
          }
        }
        
        // Map PBR texture path data to Preview texture path properties.
        // PBR stores texture paths under `{handle}TexPath` keys (e.g. albedoTexPath).
        const texPathMap: Record<string, string> = {
          albedoTexPath:              'baseColorTexPath',
          normalTexPath:              'normalTexPath',
          metallicRoughnessTexPath:   'metallicRoughnessTexPath',
          occlusionTexPath:           'occlusionTexPath',
          emissiveTexPath:            'emissiveTexPath',
          bumpTexPath:                'bumpTexPath',
          displacementTexPath:        'displacementTexPath',
        };
        
        // Forward bump/displacement scalar parameters
        const scalarKeys2 = ['bumpScale', 'displacementScale'];
        for (const key of scalarKeys2) {
          if (pbrData[key] !== undefined) {
            result[key] = pbrData[key];
          }
        }
        for (const [pbrKey, previewKey] of Object.entries(texPathMap)) {
          if (typeof pbrData[pbrKey] === 'string') {
            result[previewKey] = pbrData[pbrKey];
          }
        }
        
        return result;
      },
    },
  },
};

interface PreviewNodeData {
  albedo?: [number, number, number];
  metallic?: number;
  roughness?: number;
  normalScale?: number;
  occlusionStrength?: number;
  emissiveFactor?: [number, number, number];
  ior?: number;
  clearcoatFactor?: number;
  clearcoatRoughness?: number;
  alphaCutoff?: number;
  // Texture paths propagated from Texture Set → PBR → Preview
  baseColorTexPath?: string | null;
  normalTexPath?: string | null;
  metallicRoughnessTexPath?: string | null;
  occlusionTexPath?: string | null;
  emissiveTexPath?: string | null;
  bumpTexPath?: string | null;
  displacementTexPath?: string | null;
  bumpScale?: number;
  displacementScale?: number;
  // Shape (persisted in node data)
  shape?: PreviewShape;
  [key: string]: unknown;
}

const SHAPES: PreviewShape[] = ['sphere', 'cube', 'plane'];
const SHAPE_LABELS: Record<PreviewShape, string> = {
  sphere: '⚫',
  cube: '⬜',
  plane: '▬',
};

/**
 * Generate a simple 2D sphere gradient CSS as fallback.
 */
function generateFallbackGradient(
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

export function PreviewNode({ data, id }: NodeProps) {
  const d = data as PreviewNodeData;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const debounceTimerRef = useRef<number | null>(null);
  const gpuAvailableRef = useRef<boolean | null>(null);
  const [gpuReady, setGpuReady] = useState(false);
  const [rendering, setRendering] = useState(false);
  
  const albedo: [number, number, number] = d.albedo ?? [0.75, 0.75, 0.75];
  const metallic = d.metallic ?? 0;
  const roughness = d.roughness ?? 0.5;
  const shape: PreviewShape = d.shape ?? 'sphere';
  
  // Shape cycling (no updateNodeData since shape is read-only display; 
  // we store in local state and the parent propagateData will pick it up)
  const [localShape, setLocalShape] = useState<PreviewShape>(shape);
  
  const cycleShape = useCallback(() => {
    setLocalShape(prev => {
      const idx = SHAPES.indexOf(prev);
      return SHAPES[(idx + 1) % SHAPES.length];
    });
  }, []);
  
  // Initialize GPU renderer
  useEffect(() => {
    let cancelled = false;
    
    (async () => {
      try {
        const ctx = await GPUContext.getInstance();
        if (cancelled) return;
        
        const renderer = getMaterialPreviewRenderer();
        await renderer.init(ctx);
        if (cancelled) return;
        
        gpuAvailableRef.current = true;
        setGpuReady(true);
      } catch (err) {
        console.warn('[PreviewNode] GPU not available, using CSS fallback:', err);
        gpuAvailableRef.current = false;
      }
    })();
    
    return () => {
      cancelled = true;
    };
  }, []);
  
  // Debounced GPU render on property changes
  useEffect(() => {
    if (!gpuReady || !canvasRef.current) return;
    
    // Clear previous debounce
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
    }
    
    debounceTimerRef.current = window.setTimeout(async () => {
      if (!canvasRef.current) return;
      
      // When MR packed texture is connected, force metallic/roughness scalars to 1.0
      // so the texture values pass through unscaled (matches engine: scalar * texture)
      const hasMRTex = !!d.metallicRoughnessTexPath;
      
      const props: PreviewMaterialProps = {
        albedo: d.albedo ?? [0.75, 0.75, 0.75],
        metallic: hasMRTex ? 1.0 : (d.metallic ?? 0),
        roughness: hasMRTex ? 1.0 : (d.roughness ?? 0.5),
        normalScale: d.normalScale ?? 1.0,
        occlusionStrength: d.occlusionStrength ?? 1.0,
        emissiveFactor: d.emissiveFactor ?? [0, 0, 0],
        ior: d.ior ?? 1.5,
        clearcoatFactor: d.clearcoatFactor ?? 0,
        clearcoatRoughness: d.clearcoatRoughness ?? 0,
        alphaCutoff: d.alphaCutoff ?? 0.5,
        baseColorTexPath: d.baseColorTexPath ?? null,
        normalTexPath: d.normalTexPath ?? null,
        metallicRoughnessTexPath: d.metallicRoughnessTexPath ?? null,
        occlusionTexPath: d.occlusionTexPath ?? null,
        emissiveTexPath: d.emissiveTexPath ?? null,
        bumpTexPath: d.bumpTexPath ?? null,
        displacementTexPath: d.displacementTexPath ?? null,
        bumpScale: d.bumpScale ?? 1.0,
        displacementScale: d.displacementScale ?? 0.05,
      };
      
      setRendering(true);
      try {
        const renderer = getMaterialPreviewRenderer();
        await renderer.render(props, localShape, canvasRef.current);
      } catch (err) {
        console.error('[PreviewNode] Render failed:', err);
      }
      setRendering(false);
    }, 150); // 150ms debounce
    
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [
    gpuReady, localShape,
    d.albedo?.[0], d.albedo?.[1], d.albedo?.[2],
    d.metallic, d.roughness, d.normalScale, d.occlusionStrength,
    d.emissiveFactor?.[0], d.emissiveFactor?.[1], d.emissiveFactor?.[2],
    d.ior, d.clearcoatFactor, d.clearcoatRoughness, d.alphaCutoff,
    d.baseColorTexPath, d.normalTexPath, d.metallicRoughnessTexPath,
    d.occlusionTexPath, d.emissiveTexPath, d.bumpTexPath, d.displacementTexPath,
    d.bumpScale, d.displacementScale,
  ]);
  
  // CSS fallback gradient (shown when GPU not available or still loading)
  const fallbackGradient = useMemo(() => 
    generateFallbackGradient(albedo, metallic, roughness),
    [albedo[0], albedo[1], albedo[2], metallic, roughness]
  );
  
  return (
    <div class={styles.node} style={{ minWidth: '180px' }}>
      <div class={styles.previewHeader}>
        <span class={styles.nodeHeaderIcon}>👁️</span>
        Preview
        {/* Shape selector */}
        <button
          class={`${styles.shapeBtn} nopan nodrag`}
          onClick={cycleShape}
          title={`Shape: ${localShape}`}
        >
          {SHAPE_LABELS[localShape]}
        </button>
      </div>
      <div class={styles.nodeBody}>
        {/* Material input */}
        <div class={styles.handleRow}>
          <Handle type="target" position={Position.Left} id="material" style={{ top: 'auto' }} />
          <span class={styles.handleLabelLeft}>Material</span>
        </div>
        
        {/* Preview area */}
        <div class={styles.previewContainer}>
          {/* GPU canvas (hidden when not ready) */}
          <canvas
            ref={canvasRef}
            width={512}
            height={512}
            class={styles.previewCanvas}
            style={{
              display: gpuReady ? 'block' : 'none',
            }}
          />
          
          {/* CSS fallback sphere (shown when GPU not ready) */}
          {!gpuReady && (
            <div
              class={styles.previewSphere}
              style={{ background: fallbackGradient }}
            />
          )}
          
          {/* Loading indicator */}
          {rendering && (
            <div class={styles.previewLoading}>⟳</div>
          )}
        </div>
        
        <div class={styles.previewLabel}>
          {gpuReady ? `GPU • ${localShape}` : '2D Fallback'}
        </div>
      </div>
    </div>
  );
}
