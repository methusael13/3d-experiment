/**
 * WaterPanel - Panel for configuring FFT ocean water settings
 * Organized by: Surface > Wind & Spectrum > Appearance > Debug
 */
import { useCallback } from 'preact/hooks';
import { Panel, Slider, ColorPicker } from '../../ui';
import styles from './WaterPanel.module.css';
import { WaterConfig } from '../../../../../core/gpu/renderers/WaterRendererGPU';
import type { SpectrumType } from '../../../../../core/ocean/FFTOceanSpectrum';

export type WaterParams = WaterConfig;

/** FFT ocean parameters exposed to the UI */
export interface FFTParams {
  windSpeed: number;
  windDirectionAngle: number; // degrees 0-360
  choppiness: number;
  amplitudeScale: number;
  fetch: number;
  spectrumType: SpectrumType;
  directionalSpread: number;
}

/** FFT debug texture toggle names */
export const FFT_DEBUG_TEXTURES = [
  'fft-spectrum',
  'fft-dy-freq',
  'fft-dy-spatial',
  'fft-displacement',
  'fft-normal',
] as const;

export type FFTDebugTextureName = typeof FFT_DEBUG_TEXTURES[number];

export interface WaterPanelProps {
  params: WaterParams;
  onParamsChange: (params: Partial<WaterParams>) => void;
  /** FFT ocean parameters (null if FFT not available) */
  fftParams?: FFTParams | null;
  onFFTParamsChange?: (params: Partial<FFTParams>) => void;
  terrainSize?: number;
  /** Debug texture toggle states */
  debugTextures?: Record<FFTDebugTextureName, boolean>;
  onDebugTextureToggle?: (name: FFTDebugTextureName, enabled: boolean) => void;
}

export function WaterPanel({ params, onParamsChange, fftParams, onFFTParamsChange, terrainSize = 1024, debugTextures, onDebugTextureToggle }: WaterPanelProps) {
  const handleChange = useCallback(
    <K extends keyof WaterParams>(key: K, value: WaterParams[K]) => {
      onParamsChange({ [key]: value } as Partial<WaterParams>);
    },
    [onParamsChange]
  );

  const handleFFTChange = useCallback(
    <K extends keyof FFTParams>(key: K, value: FFTParams[K]) => {
      onFFTParamsChange?.({ [key]: value } as Partial<FFTParams>);
    },
    [onFFTParamsChange]
  );

  const isFFTActive = !!fftParams;

  return (
    <Panel title="🌊 Water">
      <div class={styles.container}>
        {/* ===== Surface ===== */}
        <div class={styles.section}>
          <div class={styles.sectionTitle}>Surface</div>
          
          <Slider
            label="Water Level"
            value={params.waterLevel}
            min={-0.5}
            max={0.5}
            step={0.01}
            format={(v) => v.toFixed(2)}
            onChange={(v) => handleChange('waterLevel', v)}
          />

          {isFFTActive && (
            <>
              <Slider
                label="Amplitude"
                value={fftParams.amplitudeScale}
                min={0}
                max={5}
                step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={(v) => handleFFTChange('amplitudeScale', v)}
              />

              <Slider
                label="Choppiness"
                value={fftParams.choppiness}
                min={0}
                max={3}
                step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={(v) => handleFFTChange('choppiness', v)}
              />
            </>
          )}

          <Slider
            label="Opacity"
            value={params.opacity}
            min={0.1}
            max={1}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onChange={(v) => handleChange('opacity', v)}
          />

          <Slider
            label="Refraction"
            value={params.refractionStrength}
            min={0}
            max={1.5}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onChange={(v) => handleChange('refractionStrength', v)}
          />
        </div>

        {/* ===== Wind & Spectrum ===== */}
        {isFFTActive && (
          <div class={styles.section}>
            <div class={styles.sectionTitle}>Wind & Spectrum</div>

            <Slider
              label="Wind Speed"
              value={fftParams.windSpeed}
              min={0}
              max={30}
              step={0.5}
              format={(v) => `${v.toFixed(1)} m/s`}
              onChange={(v) => handleFFTChange('windSpeed', v)}
            />

            <Slider
              label="Wind Direction"
              value={fftParams.windDirectionAngle}
              min={0}
              max={360}
              step={5}
              format={(v) => `${v.toFixed(0)}°`}
              onChange={(v) => handleFFTChange('windDirectionAngle', v)}
            />

            <Slider
              label="Fetch"
              value={fftParams.fetch}
              min={100}
              max={100000}
              step={500}
              format={(v) => v >= 1000 ? `${(v / 1000).toFixed(1)}km` : `${v.toFixed(0)}m`}
              onChange={(v) => handleFFTChange('fetch', v)}
            />

            <Slider
              label="Dir. Spread"
              value={fftParams.directionalSpread}
              min={1}
              max={32}
              step={1}
              format={(v) => v.toFixed(0)}
              onChange={(v) => handleFFTChange('directionalSpread', v)}
            />

            <div class={styles.gridInfo}>
              {fftParams.spectrumType.toUpperCase()} · 3 cascades @ 256²
            </div>
          </div>
        )}

        {/* ===== Appearance ===== */}
        <div class={styles.section}>
          <div class={styles.sectionTitle}>Appearance</div>
          
          <label class={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={params.usePhysicalColor}
              onChange={(e) => handleChange('usePhysicalColor', (e.target as HTMLInputElement).checked)}
            />
            Physical Water Color
          </label>

          {params.usePhysicalColor ? (
            <>
              <Slider
                label="Turbidity"
                value={params.turbidity}
                min={0}
                max={5}
                step={0.1}
                format={(v) => v.toFixed(1)}
                onChange={(v) => handleChange('turbidity', v)}
              />

              <div class={styles.colorColumn}>
                <ColorPicker
                  label="Scatter Tint"
                  value={params.scatterTint}
                  onChange={(v) => handleChange('scatterTint', v)}
                />
              </div>
            </>
          ) : (
            <>
              <div class={styles.colorColumn}>
                <ColorPicker
                  label="Water Color"
                  value={params.waterColor}
                  onChange={(v) => handleChange('waterColor', v)}
                />
                <ColorPicker
                  label="Deep Color"
                  value={params.deepColor}
                  onChange={(v) => handleChange('deepColor', v)}
                />
              </div>

              <Slider
                label="Depth Falloff"
                value={params.depthFalloff}
                min={0.01}
                max={10.0}
                step={0.01}
                format={(v) => v.toFixed(2)}
                onChange={(v) => handleChange('depthFalloff', v)}
              />
            </>
          )}

          <div class={styles.colorColumn}>
            <ColorPicker
              label="Foam Color"
              value={params.foamColor}
              onChange={(v) => handleChange('foamColor', v)}
            />
          </div>

          <Slider
            label="Shore Foam"
            value={params.foamThreshold}
            min={0}
            max={10}
            step={0.1}
            format={(v) => `${v.toFixed(1)}m`}
            onChange={(v) => handleChange('foamThreshold', v)}
          />
        </div>

        {/* ===== Grid Mode ===== */}
        <div class={styles.section}>
          <div class={styles.sectionTitle}>Grid</div>
          
          <label class={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={params.gridMode === 'projected'}
              onChange={(e) => handleChange('gridMode', (e.target as HTMLInputElement).checked ? 'projected' : 'uniform')}
            />
            Projected Grid (infinite ocean)
          </label>

          {params.gridMode === 'projected' && (
            <div class={styles.gridInfo}>
              256×256 screen-space grid · adapts to camera
            </div>
          )}
        </div>

        {/* ===== FFT Debug Textures ===== */}
        {isFFTActive && debugTextures && onDebugTextureToggle && (
          <div class={styles.section}>
            <div class={styles.sectionTitle}>Debug Textures</div>
            {FFT_DEBUG_TEXTURES.map(name => (
              <label key={name} class={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={debugTextures[name] ?? false}
                  onChange={(e) => onDebugTextureToggle(name, (e.target as HTMLInputElement).checked)}
                />
                {name.replace('fft-', '').replace(/-/g, ' ')}
              </label>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
