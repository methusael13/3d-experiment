/**
 * BiomeMaskContent - Content for biome mask editor dockable window
 * 
 * Layout:
 * - Preview area (top): Canvas showing colorized biome mask
 * - Controls (bottom): Parameter sliders for live editing
 */

import { useCallback } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { Slider, GPUTexturePreview } from '../../ui';
import type { BiomeParams } from '../../../../../core/vegetation';
import type { UnifiedGPUTexture } from '../../../../../core/gpu';
import styles from './BiomeMaskContent.module.css';

/**
 * Channel info for display
 */
type ChannelKey = 'grassland' | 'rock' | 'forest';

const CHANNEL_INFO: Record<ChannelKey, { name: string; color: string; description: string }> = {
  grassland: {
    name: 'Grassland (R)',
    color: '#e44',
    description: 'Moderate height, low slope',
  },
  rock: {
    name: 'Rock/Cliff (G)',
    color: '#4e4',
    description: 'Steep slopes, high altitude',
  },
  forest: {
    name: 'Forest (B)',
    color: '#44e',
    description: 'Good water flow areas',
  },
};

export interface BiomeMaskContentProps {
  /** Current biome parameters */
  params: BiomeParams;
  /** Called when parameters change */
  onParamsChange: (params: Partial<BiomeParams>) => void;
  /** Called to regenerate the biome mask */
  onRegenerate: () => void;
  /** Whether biome mask has been generated */
  hasBiomeMask: boolean;
  /** Whether terrain is ready (heightmap exists) */
  isTerrainReady: boolean;
  /** Get the biome mask texture for preview */
  getBiomeMaskTexture: () => UnifiedGPUTexture | null;
  /** GPU device for preview rendering */
  device: GPUDevice | null;
  /** Preview version - incremented by parent to trigger texture re-read */
  previewVersion: number;
}

export function BiomeMaskContent({
  params,
  onParamsChange,
  onRegenerate,
  hasBiomeMask,
  isTerrainReady,
  getBiomeMaskTexture,
  device,
  previewVersion,
}: BiomeMaskContentProps) {
  // Expanded sections state
  const expandedSections = useSignal({
    influences: true,
    grassland: false,
    rock: false,
    forest: false,
  });

  // Get texture for preview
  const biomeMaskTexture = hasBiomeMask ? getBiomeMaskTexture() : null;

  // Handle slider changes - parent handles debouncing
  const handleChange = useCallback(
    <K extends keyof BiomeParams>(key: K, value: BiomeParams[K]) => {
      onParamsChange({ [key]: value } as Partial<BiomeParams>);
    },
    [onParamsChange]
  );

  const toggleSection = useCallback(
    (section: keyof typeof expandedSections.value) => {
      expandedSections.value = {
        ...expandedSections.value,
        [section]: !expandedSections.value[section],
      };
    },
    []
  );

  return (
    <div class={styles.content}>
      {/* Preview Area */}
      <div class={styles.previewArea}>
        {!isTerrainReady ? (
          <div class={styles.previewPlaceholder}>
            <span class={styles.warning}>⚠ Generate terrain first</span>
          </div>
        ) : !hasBiomeMask ? (
          <div class={styles.previewPlaceholder}>
            <span class={styles.info}>Click Generate to create biome mask</span>
          </div>
        ) : (
          <GPUTexturePreview
            texture={biomeMaskTexture}
            device={device}
            width={256}
            height={256}
            version={previewVersion}
            className={styles.previewCanvas}
            pixelated={false}
          />
        )}

        {/* Channel Legend overlay */}
        <div class={styles.legend}>
          {(['grassland', 'rock', 'forest'] as ChannelKey[]).map((channel) => (
            <div key={channel} class={styles.legendItem}>
              <div
                class={styles.legendColor}
                style={{ backgroundColor: CHANNEL_INFO[channel].color }}
              />
              <span class={styles.legendLabel}>{CHANNEL_INFO[channel].name}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Generate button */}
      <button
        class={styles.generateButton}
        onClick={onRegenerate}
        disabled={!isTerrainReady}
      >
        {hasBiomeMask ? 'Regenerate' : 'Generate Biome Mask'}
      </button>

      {/* Controls Area */}
      <div class={styles.controls}>
        {/* Influence Weights */}
        <div class={styles.section}>
          <div
            class={styles.sectionHeader}
            onClick={() => toggleSection('influences')}
          >
            <span class={styles.sectionTitle}>Influence Weights</span>
            <span class={styles.expandIcon}>
              {expandedSections.value.influences ? '▼' : '▶'}
            </span>
          </div>
          {expandedSections.value.influences && (
            <div class={styles.sectionContent}>
              <Slider
                label="Height"
                value={params.heightInfluence}
                min={0}
                max={2}
                step={0.1}
                format={(v) => v.toFixed(1)}
                onChange={(v) => handleChange('heightInfluence', v)}
              />
              <Slider
                label="Slope"
                value={params.slopeInfluence}
                min={0}
                max={2}
                step={0.1}
                format={(v) => v.toFixed(1)}
                onChange={(v) => handleChange('slopeInfluence', v)}
              />
              <Slider
                label="Water Flow"
                value={params.flowInfluence}
                min={0}
                max={2}
                step={0.1}
                format={(v) => v.toFixed(1)}
                onChange={(v) => handleChange('flowInfluence', v)}
              />
            </div>
          )}
        </div>

        {/* Grassland Settings */}
        <div class={styles.section}>
          <div
            class={styles.sectionHeader}
            onClick={() => toggleSection('grassland')}
          >
            <div class={styles.sectionTitleGroup}>
              <div
                class={styles.sectionColorDot}
                style={{ backgroundColor: CHANNEL_INFO.grassland.color }}
              />
              <span class={styles.sectionTitle}>Grassland</span>
            </div>
            <span class={styles.expandIcon}>
              {expandedSections.value.grassland ? '▼' : '▶'}
            </span>
          </div>
          {expandedSections.value.grassland && (
            <div class={styles.sectionContent}>
              <Slider
                label="Height Min"
                value={params.grassHeightMin}
                min={0}
                max={0.5}
                step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={(v) => handleChange('grassHeightMin', v)}
              />
              <Slider
                label="Height Max"
                value={params.grassHeightMax}
                min={0.3}
                max={1}
                step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={(v) => handleChange('grassHeightMax', v)}
              />
              <Slider
                label="Max Slope"
                value={params.grassSlopeMax}
                min={0.1}
                max={0.8}
                step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={(v) => handleChange('grassSlopeMax', v)}
              />
            </div>
          )}
        </div>

        {/* Rock Settings */}
        <div class={styles.section}>
          <div
            class={styles.sectionHeader}
            onClick={() => toggleSection('rock')}
          >
            <div class={styles.sectionTitleGroup}>
              <div
                class={styles.sectionColorDot}
                style={{ backgroundColor: CHANNEL_INFO.rock.color }}
              />
              <span class={styles.sectionTitle}>Rock/Cliff</span>
            </div>
            <span class={styles.expandIcon}>
              {expandedSections.value.rock ? '▼' : '▶'}
            </span>
          </div>
          {expandedSections.value.rock && (
            <div class={styles.sectionContent}>
              <Slider
                label="Min Slope"
                value={params.rockSlopeMin}
                min={0}
                max={0.8}
                step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={(v) => handleChange('rockSlopeMin', v)}
              />
            </div>
          )}
        </div>

        {/* Forest Settings */}
        <div class={styles.section}>
          <div
            class={styles.sectionHeader}
            onClick={() => toggleSection('forest')}
          >
            <div class={styles.sectionTitleGroup}>
              <div
                class={styles.sectionColorDot}
                style={{ backgroundColor: CHANNEL_INFO.forest.color }}
              />
              <span class={styles.sectionTitle}>Forest Edge</span>
            </div>
            <span class={styles.expandIcon}>
              {expandedSections.value.forest ? '▼' : '▶'}
            </span>
          </div>
          {expandedSections.value.forest && (
            <div class={styles.sectionContent}>
              <Slider
                label="Flow Min"
                value={params.forestFlowMin}
                min={0}
                max={0.5}
                step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={(v) => handleChange('forestFlowMin', v)}
              />
              <Slider
                label="Flow Max"
                value={params.forestFlowMax}
                min={0.3}
                max={1}
                step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={(v) => handleChange('forestFlowMax', v)}
              />
              <Slider
                label="Height Min"
                value={params.forestHeightMin}
                min={0}
                max={0.5}
                step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={(v) => handleChange('forestHeightMin', v)}
              />
              <Slider
                label="Height Max"
                value={params.forestHeightMax}
                min={0.3}
                max={1}
                step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={(v) => handleChange('forestHeightMax', v)}
              />
            </div>
          )}
        </div>

        {/* Seed */}
        <div class={styles.section}>
          <div class={styles.sectionContent}>
            <Slider
              label="Seed"
              value={params.seed}
              min={0}
              max={99999}
              step={1}
              format={(v) => String(Math.round(v))}
              onChange={(v) => handleChange('seed', v)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default BiomeMaskContent;
