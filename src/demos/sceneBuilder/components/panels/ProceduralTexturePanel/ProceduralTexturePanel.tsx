/**
 * ProceduralTexturePanel — DockableWindow-based editor for procedural noise textures.
 *
 * Opens when user clicks a texture button next to a PBR slider in MaterialPanel.
 * Shows: noise type dropdown, parameter sliders, color ramp editor, texture preview.
 */

import { h } from 'preact';
import { useState, useCallback, useRef, useEffect } from 'preact/hooks';
import { DockableWindow } from '../../ui/DockableWindow/DockableWindow';
import type {
  NoiseType,
  ProceduralTextureParams,
  TextureTargetSlot,
  TextureResolution,
  ColorRamp,
  ProjectionMode,
} from '@/core/gpu/renderers/ProceduralTextureGenerator';
import { DEFAULT_PROCEDURAL_PARAMS } from '@/core/gpu/renderers/ProceduralTextureGenerator';
import styles from './ProceduralTexturePanel.module.css';

// Import CSS variables
import '../../styles/variables.css';

// ==================== Types ====================

export interface ProceduralTexturePanelProps {
  /** Which PBR slot this texture targets */
  targetSlot: TextureTargetSlot;
  /** Existing params to edit (null = new texture) */
  initialParams: ProceduralTextureParams | null;
  /** Called when user clicks Apply */
  onApply: (slot: TextureTargetSlot, params: ProceduralTextureParams) => void;
  /** Called when user clicks Clear (remove texture) */
  onClear: (slot: TextureTargetSlot) => void;
  /** Called when panel is closed */
  onClose: () => void;
}

// ==================== Noise type labels ====================

const NOISE_TYPES: { value: NoiseType; label: string }[] = [
  { value: 'perlin', label: 'Perlin' },
  { value: 'fbm', label: 'fBm (Fractal)' },
  { value: 'voronoiF1', label: 'Voronoi F1' },
  { value: 'voronoiF2', label: 'Voronoi F2' },
  { value: 'voronoiEdge', label: 'Voronoi Edge' },
  { value: 'musgrave', label: 'Musgrave (Ridged)' },
  { value: 'checker', label: 'Checker' },
  { value: 'whiteNoise', label: 'White Noise' },
];

const SLOT_LABELS: Record<TextureTargetSlot, string> = {
  baseColor: 'Albedo (Base Color)',
  metallic: 'Metallic',
  roughness: 'Roughness',
  occlusion: 'Occlusion',
  emissive: 'Emissive',
};

/** Whether a noise type uses octave-based parameters */
function usesOctaves(t: NoiseType): boolean {
  return t === 'fbm' || t === 'musgrave';
}

/** Whether a noise type uses cellDensity */
function usesCellDensity(t: NoiseType): boolean {
  return t === 'voronoiF1' || t === 'voronoiF2' || t === 'voronoiEdge' || t === 'checker';
}

// ==================== CPU Preview ====================

/**
 * Generate a quick CPU-side grayscale preview (low-res) for immediate feedback.
 * Uses a simplified version of the noise — not pixel-accurate to GPU but close enough.
 */
function generatePreviewData(params: ProceduralTextureParams): ImageData {
  const size = 64; // preview is always 64x64
  const imageData = new ImageData(size, size);
  const data = imageData.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;

      let value: number;
      const px = (u + params.offsetX) * params.scale + params.seed;
      const py = (v + params.offsetY) * params.scale + params.seed * 0.7;

      switch (params.noiseType) {
        case 'checker': {
          const d = params.cellDensity;
          const ix = Math.floor((u + params.offsetX) * d);
          const iy = Math.floor((v + params.offsetY) * d);
          value = ((ix + iy) & 1) === 0 ? 1 : 0;
          break;
        }
        case 'whiteNoise': {
          value = pseudoRandom(px * size, py * size);
          break;
        }
        default: {
          // Simple value noise approximation for preview
          value = simpleNoise(px, py, params);
          break;
        }
      }

      // Apply color ramp
      value = applyRamp(value, params.colorRamp);
      const byte = Math.max(0, Math.min(255, Math.round(value * 255)));
      const idx = (y * size + x) * 4;
      data[idx] = byte;
      data[idx + 1] = byte;
      data[idx + 2] = byte;
      data[idx + 3] = 255;
    }
  }

  return imageData;
}

function pseudoRandom(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function simpleNoise(x: number, y: number, params: ProceduralTextureParams): number {
  // Simple value noise with fBm-like layering
  let value = 0;
  let amp = 1;
  let maxAmp = 0;
  let freq = 1;
  const oct = params.noiseType === 'perlin' ? 1 : params.octaves;
  
  for (let i = 0; i < oct; i++) {
    const nx = x * freq;
    const ny = y * freq;
    // Simple hash-based noise
    const n = pseudoRandom(Math.floor(nx), Math.floor(ny));
    const n10 = pseudoRandom(Math.floor(nx) + 1, Math.floor(ny));
    const n01 = pseudoRandom(Math.floor(nx), Math.floor(ny) + 1);
    const n11 = pseudoRandom(Math.floor(nx) + 1, Math.floor(ny) + 1);
    
    const fx = nx - Math.floor(nx);
    const fy = ny - Math.floor(ny);
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    
    const nx0 = n + sx * (n10 - n);
    const nx1 = n01 + sx * (n11 - n01);
    const v = nx0 + sy * (nx1 - nx0);
    
    if (params.noiseType === 'musgrave') {
      const signal = 1 - Math.abs(v * 2 - 1);
      value += amp * signal * signal;
    } else {
      value += amp * v;
    }
    
    maxAmp += amp;
    amp *= params.persistence;
    freq *= params.lacunarity;
  }
  
  return Math.max(0, Math.min(1, value / maxAmp));
}

function applyRamp(t: number, ramp: ColorRamp): number {
  const c = Math.max(0, Math.min(1, t));
  if (c <= ramp.stopX) {
    const f = ramp.stopX > 0 ? c / ramp.stopX : 0;
    return ramp.val0 + f * (ramp.valX - ramp.val0);
  } else if (c <= ramp.stopY) {
    const range = ramp.stopY - ramp.stopX;
    const f = range > 0 ? (c - ramp.stopX) / range : 0;
    return ramp.valX + f * (ramp.valY - ramp.valX);
  } else {
    const range = 1 - ramp.stopY;
    const f = range > 0 ? (c - ramp.stopY) / range : 0;
    return ramp.valY + f * (ramp.val1 - ramp.valY);
  }
}

// ==================== Slider Helper ====================

function ParamSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  const fmt = format || ((v: number) => v.toFixed(2));
  return (
    <div class={styles.sliderRow}>
      <span class={styles.sliderLabel}>{label}</span>
      <input
        type="range"
        class={styles.slider}
        min={min}
        max={max}
        step={step}
        value={value}
        onInput={(e) => onChange(parseFloat((e.target as HTMLInputElement).value))}
      />
      <span class={styles.sliderValue}>{fmt(value)}</span>
    </div>
  );
}

// ==================== Main Component ====================

export function ProceduralTexturePanel({
  targetSlot,
  initialParams,
  onApply,
  onClear,
  onClose,
}: ProceduralTexturePanelProps) {
  const [params, setParams] = useState<ProceduralTextureParams>(
    initialParams
      ? { ...initialParams, colorRamp: { ...initialParams.colorRamp } }
      : { ...DEFAULT_PROCEDURAL_PARAMS, colorRamp: { ...DEFAULT_PROCEDURAL_PARAMS.colorRamp } }
  );

  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Update preview when params change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = 64;
    canvas.height = 64;
    const imageData = generatePreviewData(params);
    ctx.putImageData(imageData, 0, 0);
  }, [params]);

  const updateParam = useCallback(<K extends keyof ProceduralTextureParams>(key: K, value: ProceduralTextureParams[K]) => {
    setParams((p) => ({ ...p, [key]: value }));
  }, []);

  const updateRamp = useCallback(<K extends keyof ColorRamp>(key: K, value: ColorRamp[K]) => {
    setParams((p) => ({
      ...p,
      colorRamp: { ...p.colorRamp, [key]: value },
    }));
  }, []);

  const handleApply = useCallback(() => {
    onApply(targetSlot, params);
  }, [targetSlot, params, onApply]);

  const handleClear = useCallback(() => {
    onClear(targetSlot);
  }, [targetSlot, onClear]);

  // Gradient bar background
  const ramp = params.colorRamp;
  const gradientCSS = `linear-gradient(to right, 
    rgb(${Math.round(ramp.val0 * 255)},${Math.round(ramp.val0 * 255)},${Math.round(ramp.val0 * 255)}) 0%, 
    rgb(${Math.round(ramp.valX * 255)},${Math.round(ramp.valX * 255)},${Math.round(ramp.valX * 255)}) ${ramp.stopX * 100}%, 
    rgb(${Math.round(ramp.valY * 255)},${Math.round(ramp.valY * 255)},${Math.round(ramp.valY * 255)}) ${ramp.stopY * 100}%, 
    rgb(${Math.round(ramp.val1 * 255)},${Math.round(ramp.val1 * 255)},${Math.round(ramp.val1 * 255)}) 100%)`;

  return (
    <DockableWindow
      id={`procedural-texture-${targetSlot}`}
      title="Procedural Texture"
      icon="🔲"
      defaultSize={{ width: 340, height: 560 }}
      minSize={{ width: 300, height: 400 }}
      maxSize={{ width: 500, height: 800 }}
      zIndex={1100}
      onClose={onClose}
    >
      <div class={styles.content}>
        {/* Target slot indicator */}
        <div class={styles.targetSlot}>
          Target: {SLOT_LABELS[targetSlot]}
        </div>

        {/* Noise Type */}
        <div class={styles.section}>
          <div class={styles.sectionTitle}>Noise Type</div>
          <div class={styles.row}>
            <select
              class={styles.select}
              value={params.noiseType}
              onChange={(e) => updateParam('noiseType', (e.target as HTMLSelectElement).value as NoiseType)}
            >
              {NOISE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Parameters */}
        <div class={styles.section}>
          <div class={styles.sectionTitle}>Parameters</div>

          <ParamSlider
            label="Scale"
            value={params.scale}
            min={0.1}
            max={32}
            step={0.1}
            onChange={(v) => updateParam('scale', v)}
          />

          <ParamSlider
            label="Seed"
            value={params.seed}
            min={0}
            max={100}
            step={0.1}
            onChange={(v) => updateParam('seed', v)}
          />

          <ParamSlider
            label="Offset X"
            value={params.offsetX}
            min={-10}
            max={10}
            step={0.1}
            onChange={(v) => updateParam('offsetX', v)}
          />

          <ParamSlider
            label="Offset Y"
            value={params.offsetY}
            min={-10}
            max={10}
            step={0.1}
            onChange={(v) => updateParam('offsetY', v)}
          />

          {usesOctaves(params.noiseType) && (
            <>
              <ParamSlider
                label="Octaves"
                value={params.octaves}
                min={1}
                max={8}
                step={1}
                format={(v) => v.toFixed(0)}
                onChange={(v) => updateParam('octaves', Math.round(v))}
              />
              <ParamSlider
                label="Lacunarity"
                value={params.lacunarity}
                min={1}
                max={4}
                step={0.1}
                onChange={(v) => updateParam('lacunarity', v)}
              />
              <ParamSlider
                label="Persistence"
                value={params.persistence}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => updateParam('persistence', v)}
              />
            </>
          )}

          {usesCellDensity(params.noiseType) && (
            <ParamSlider
              label="Cell Density"
              value={params.cellDensity}
              min={1}
              max={32}
              step={1}
              format={(v) => v.toFixed(0)}
              onChange={(v) => updateParam('cellDensity', v)}
            />
          )}
        </div>

        {/* Color Ramp */}
        <div class={styles.section}>
          <div class={styles.sectionTitle}>Color Ramp</div>
          <div class={styles.colorRamp}>
            <div
              class={styles.gradientBar}
              style={{ background: gradientCSS }}
            >
              <div
                class={styles.stopMarker}
                style={{ left: `${ramp.stopX * 100}%` }}
                title={`Stop X: ${ramp.stopX.toFixed(2)}`}
              />
              <div
                class={styles.stopMarker}
                style={{ left: `${ramp.stopY * 100}%` }}
                title={`Stop Y: ${ramp.stopY.toFixed(2)}`}
              />
            </div>

            <ParamSlider
              label="Stop X"
              value={ramp.stopX}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => updateRamp('stopX', Math.min(v, ramp.stopY))}
            />
            <ParamSlider
              label="Stop Y"
              value={ramp.stopY}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => updateRamp('stopY', Math.max(v, ramp.stopX))}
            />

            <div class={styles.rampValues}>
              <ParamSlider
                label="Val @ 0"
                value={ramp.val0}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => updateRamp('val0', v)}
              />
              <ParamSlider
                label="Val @ X"
                value={ramp.valX}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => updateRamp('valX', v)}
              />
              <ParamSlider
                label="Val @ Y"
                value={ramp.valY}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => updateRamp('valY', v)}
              />
              <ParamSlider
                label="Val @ 1"
                value={ramp.val1}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => updateRamp('val1', v)}
              />
            </div>
          </div>
        </div>

        {/* Projection */}
        <div class={styles.section}>
          <div class={styles.sectionTitle}>Projection</div>
          <div class={styles.row}>
            <select
              class={styles.select}
              value={params.projection}
              onChange={(e) => updateParam('projection', (e.target as HTMLSelectElement).value as ProjectionMode)}
            >
              <option value="uv">UV Mapping</option>
              <option value="triplanar">Triplanar (seamless)</option>
            </select>
          </div>
          {params.projection === 'triplanar' && (
            <ParamSlider
              label="Tri Scale"
              value={params.triplanarScale}
              min={0.1}
              max={10}
              step={0.1}
              onChange={(v) => updateParam('triplanarScale', v)}
            />
          )}
        </div>

        {/* Resolution */}
        <div class={styles.section}>
          <div class={styles.sectionTitle}>Resolution</div>
          <div class={styles.resolutionRow}>
            {([128, 256, 512] as TextureResolution[]).map((res) => (
              <button
                key={res}
                type="button"
                class={`${styles.resBtn} ${params.resolution === res ? styles.resBtnActive : ''}`}
                onClick={() => updateParam('resolution', res)}
              >
                {res}
              </button>
            ))}
          </div>
        </div>

        {/* Preview */}
        <div class={styles.section}>
          <div class={styles.sectionTitle}>Preview</div>
          <div class={styles.preview}>
            <canvas ref={canvasRef} class={styles.previewCanvas} width={64} height={64} />
          </div>
        </div>

        {/* Actions */}
        <div class={styles.actions}>
          <button type="button" class={styles.applyBtn} onClick={handleApply}>
            Apply
          </button>
          {initialParams && (
            <button type="button" class={styles.clearBtn} onClick={handleClear}>
              Clear
            </button>
          )}
        </div>
      </div>
    </DockableWindow>
  );
}

export default ProceduralTexturePanel;