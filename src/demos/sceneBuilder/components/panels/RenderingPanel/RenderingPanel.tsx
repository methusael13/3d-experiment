import { useCallback } from 'preact/hooks';
import { Panel, Slider, Checkbox, Select, Section } from '../../ui';
import styles from './RenderingPanel.module.css';
import type { SSAOEffectConfig, CompositeEffectConfig } from '@/core/gpu/postprocess';
import type { SSRQualityLevel } from '@/core/gpu/pipeline/SSRConfig';
import type { DebugViewMode } from '@/core/gpu/pipeline/passes/DebugViewPass';

// Import CSS variables
import '../../styles/variables.css';

export interface WebGPUShadowSettings {
  enabled: boolean;
  resolution: number;
  shadowRadius: number;
  softShadows: boolean;
  // CSM settings
  csmEnabled: boolean;
  cascadeCount: number;
  cascadeBlendFraction: number;
}

/**
 * SSAO Settings for UI - extends SSAOConfig with enabled flag
 * Uses SSAOConfig from postprocess module for consistency
 */
export interface SSAOSettings extends Required<SSAOEffectConfig> {
  /** Whether SSAO effect is enabled */
  enabled: boolean;
}

/**
 * SSR Settings for UI
 */
export interface SSRSettings {
  /** Whether SSR is enabled */
  enabled: boolean;
  /** Quality preset */
  quality: SSRQualityLevel;
}

export type { DebugViewMode };

export interface RenderingPanelProps {
  // Shadow settings
  shadowSettings: WebGPUShadowSettings;
  onShadowSettingsChange: (settings: Partial<WebGPUShadowSettings>) => void;

  // SSAO settings
  ssaoSettings: SSAOSettings;
  onSSAOSettingsChange: (settings: Partial<SSAOSettings>) => void;

  // SSR settings
  ssrSettings: SSRSettings;
  onSSRSettingsChange: (settings: Partial<SSRSettings>) => void;

  // Debug view
  debugViewMode: DebugViewMode;
  onDebugViewModeChange: (mode: DebugViewMode) => void;

  // Tonemapping settings
  compositeSettings: Required<CompositeEffectConfig>;
  onCompositeSettingsChange: (settings: Partial<CompositeEffectConfig>) => void;

  showShadowThumbnail: boolean;
  onShadowDebugToggle: (enabled: boolean) => void;
}

const resolutionOptions = [
  { value: '512', label: '512' },
  { value: '1024', label: '1024' },
  { value: '2048', label: '2048' },
  { value: '4096', label: '4096' },
];

const cascadeCountOptions = [
  { value: '2', label: '2 Cascades' },
  { value: '3', label: '3 Cascades' },
  { value: '4', label: '4 Cascades' },
];

const ssaoSamplesOptions = [
  { value: '8', label: '8' },
  { value: '16', label: '16' },
  { value: '32', label: '32' },
  { value: '64', label: '64' },
];

const tonemappingOptions = [
  { value: '0', label: 'None (Linear)' },
  { value: '1', label: 'Reinhard' },
  { value: '2', label: 'Uncharted 2' },
  { value: '3', label: 'ACES Filmic' },
];

const debugViewOptions = [
  { value: 'off', label: 'Off (Normal)' },
  { value: 'depth', label: 'Depth Buffer' },
  { value: 'normals', label: 'Normals' },
  { value: 'ssr', label: 'SSR Result' },
];

const ssrQualityOptions = [
  { value: 'low', label: 'Low (32 steps)' },
  { value: 'medium', label: 'Medium (64 steps)' },
  { value: 'high', label: 'High (128 steps)' },
  { value: 'ultra', label: 'Ultra (256 steps)' },
];

export function RenderingPanel({
  shadowSettings,
  showShadowThumbnail,
  onShadowDebugToggle,
  onShadowSettingsChange,
  ssaoSettings,
  onSSAOSettingsChange,
  ssrSettings,
  onSSRSettingsChange,
  debugViewMode,
  onDebugViewModeChange,
  compositeSettings,
  onCompositeSettingsChange,
}: RenderingPanelProps) {
  // Shadow enabled toggle
  const handleShadowEnabled = useCallback(
    (enabled: boolean) => {
      onShadowSettingsChange({ enabled });
    },
    [onShadowSettingsChange]
  );

  // Shadow resolution
  const handleResolutionChange = useCallback(
    (value: string) => {
      onShadowSettingsChange({ resolution: parseInt(value, 10) });
    },
    [onShadowSettingsChange]
  );

  // Shadow radius
  const handleRadiusChange = useCallback(
    (value: number) => {
      onShadowSettingsChange({ shadowRadius: value });
    },
    [onShadowSettingsChange]
  );

  // Soft shadows
  const handleSoftShadows = useCallback(
    (enabled: boolean) => {
      onShadowSettingsChange({ softShadows: enabled });
    },
    [onShadowSettingsChange]
  );

  // CSM enabled
  const handleCSMEnabled = useCallback(
    (enabled: boolean) => {
      onShadowSettingsChange({ csmEnabled: enabled });
    },
    [onShadowSettingsChange]
  );

  // CSM cascade count
  const handleCascadeCount = useCallback(
    (value: string) => {
      onShadowSettingsChange({ cascadeCount: parseInt(value, 10) });
    },
    [onShadowSettingsChange]
  );

  // CSM cascade blend fraction
  const handleCascadeBlendFraction = useCallback(
    (value: number) => {
      onShadowSettingsChange({ cascadeBlendFraction: value });
    },
    [onShadowSettingsChange]
  );

  // SSAO handlers
  const handleSSAOEnabled = useCallback(
    (enabled: boolean) => {
      onSSAOSettingsChange({ enabled });
    },
    [onSSAOSettingsChange]
  );

  const handleSSAORadius = useCallback(
    (radius: number) => {
      onSSAOSettingsChange({ radius });
    },
    [onSSAOSettingsChange]
  );

  const handleSSAOIntensity = useCallback(
    (intensity: number) => {
      onSSAOSettingsChange({ intensity });
    },
    [onSSAOSettingsChange]
  );

  const handleSSAOBias = useCallback(
    (bias: number) => {
      onSSAOSettingsChange({ bias });
    },
    [onSSAOSettingsChange]
  );

  const handleSSAOSamples = useCallback(
    (value: string) => {
      onSSAOSettingsChange({ samples: parseInt(value, 10) });
    },
    [onSSAOSettingsChange]
  );

  const handleSSAOBlur = useCallback(
    (blur: boolean) => {
      onSSAOSettingsChange({ blur });
    },
    [onSSAOSettingsChange]
  );

  // Tonemapping handlers
  const handleTonemappingChange = useCallback(
    (value: string) => {
      onCompositeSettingsChange({ tonemapping: parseInt(value, 10) });
    },
    [onCompositeSettingsChange]
  );

  const handleGammaChange = useCallback(
    (gamma: number) => {
      onCompositeSettingsChange({ gamma });
    },
    [onCompositeSettingsChange]
  );

  const handleExposureChange = useCallback(
    (exposure: number) => {
      onCompositeSettingsChange({ exposure });
    },
    [onCompositeSettingsChange]
  );

  // SSR handlers
  const handleSSREnabled = useCallback(
    (enabled: boolean) => {
      onSSRSettingsChange({ enabled });
    },
    [onSSRSettingsChange]
  );

  const handleSSRQualityChange = useCallback(
    (value: string) => {
      onSSRSettingsChange({ quality: value as SSRQualityLevel });
    },
    [onSSRSettingsChange]
  );

  const controlsDisabled = !shadowSettings.enabled;
  const ssaoControlsDisabled = !ssaoSettings.enabled;
  const handleDebugViewChange = useCallback(
    (value: string) => {
      onDebugViewModeChange(value as DebugViewMode);
    },
    [onDebugViewModeChange]
  );

  const ssrControlsDisabled = !ssrSettings.enabled;

  return (
    <Panel title="Rendering">
      {/* Shadows Section */}
      <Section title="Shadows (WebGPU)" defaultCollapsed={false}>
        <Checkbox
          label="Shadows Enabled"
          checked={shadowSettings.enabled}
          onChange={handleShadowEnabled}
        />

        <div class={`${styles.shadowControls} ${controlsDisabled ? styles.disabled : ''}`}>
          <div class={styles.controlGroup}>
            <label class={styles.controlLabel}>Resolution</label>
            <Select
              value={String(shadowSettings.resolution)}
              options={resolutionOptions}
              onChange={handleResolutionChange}
              disabled={controlsDisabled}
            />
          </div>

          <Slider
            label="Shadow Radius"
            value={shadowSettings.shadowRadius}
            min={50}
            max={500}
            step={10}
            format={(v) => String(Math.round(v))}
            onChange={handleRadiusChange}
            disabled={controlsDisabled}
          />

          <Checkbox
            label="Soft Shadows (PCF)"
            checked={shadowSettings.softShadows}
            onChange={handleSoftShadows}
            disabled={controlsDisabled}
          />

          <Checkbox
            label="Show Debug Thumbnail"
            checked={showShadowThumbnail}
            onChange={onShadowDebugToggle}
            disabled={controlsDisabled}
          />

          {/* CSM Settings */}
          <div class={styles.csmSection}>
            <Checkbox
              label="Cascaded Shadow Maps (CSM)"
              checked={shadowSettings.csmEnabled}
              onChange={handleCSMEnabled}
              disabled={controlsDisabled}
            />

            <div class={`${styles.csmControls} ${(!shadowSettings.csmEnabled || controlsDisabled) ? styles.disabled : ''}`}>
              <div class={styles.controlGroup}>
                <label class={styles.controlLabel}>Cascades</label>
                <Select
                  value={String(shadowSettings.cascadeCount)}
                  options={cascadeCountOptions}
                  onChange={handleCascadeCount}
                  disabled={!shadowSettings.csmEnabled || controlsDisabled}
                />
              </div>

              <Slider
                label="Cascade Blend"
                value={shadowSettings.cascadeBlendFraction}
                min={0.01}
                max={0.3}
                step={0.01}
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={handleCascadeBlendFraction}
                disabled={!shadowSettings.csmEnabled || controlsDisabled}
              />
            </div>
          </div>
        </div>
      </Section>

      {/* Tonemapping Section */}
      <Section title="Tonemapping" defaultCollapsed={false}>
        <div class={styles.controlGroup}>
          <label class={styles.controlLabel}>Operator</label>
          <Select
            value={String(compositeSettings.tonemapping)}
            options={tonemappingOptions}
            onChange={handleTonemappingChange}
          />
        </div>

        <Slider
          label="Exposure"
          value={compositeSettings.exposure}
          min={0.1}
          max={5.0}
          step={0.1}
          format={(v) => v.toFixed(1)}
          onChange={handleExposureChange}
        />

        <Slider
          label="Gamma"
          value={compositeSettings.gamma}
          min={1.0}
          max={3.0}
          step={0.05}
          format={(v) => v.toFixed(2)}
          onChange={handleGammaChange}
        />
      </Section>

      {/* Debug View */}
      <Section title="Debug View" defaultCollapsed={true}>
        <div class={styles.controlGroup}>
          <label class={styles.controlLabel}>View Mode</label>
          <Select
            value={debugViewMode}
            options={debugViewOptions}
            onChange={handleDebugViewChange}
          />
        </div>
      </Section>

      {/* Post Processing - SSR */}
      <Section title="Screen Space Reflections" defaultCollapsed={false}>
        <Checkbox
          label="Enable SSR"
          checked={ssrSettings.enabled}
          onChange={handleSSREnabled}
        />

        <div class={`${styles.shadowControls} ${ssrControlsDisabled ? styles.disabled : ''}`}>
          <div class={styles.controlGroup}>
            <label class={styles.controlLabel}>Quality</label>
            <Select
              value={ssrSettings.quality}
              options={ssrQualityOptions}
              onChange={handleSSRQualityChange}
              disabled={ssrControlsDisabled}
            />
          </div>
        </div>
      </Section>

      {/* Post Processing - SSAO */}
      <Section title="Ambient Occlusion" defaultCollapsed={false}>
        <Checkbox
          label="Enable SSAO"
          checked={ssaoSettings.enabled}
          onChange={handleSSAOEnabled}
        />

        <div class={`${styles.shadowControls} ${ssaoControlsDisabled ? styles.disabled : ''}`}>
          <Slider
            label="Radius"
            value={ssaoSettings.radius}
            min={0.1}
            max={5.0}
            step={0.1}
            format={(v) => v.toFixed(1)}
            onChange={handleSSAORadius}
            disabled={ssaoControlsDisabled}
          />

          <Slider
            label="Intensity"
            value={ssaoSettings.intensity}
            min={0.1}
            max={5.0}
            step={0.1}
            format={(v) => v.toFixed(1)}
            onChange={handleSSAOIntensity}
            disabled={ssaoControlsDisabled}
          />

          <Slider
            label="Bias"
            value={ssaoSettings.bias}
            min={0.001}
            max={0.1}
            step={0.001}
            format={(v) => v.toFixed(3)}
            onChange={handleSSAOBias}
            disabled={ssaoControlsDisabled}
          />

          <div class={styles.controlGroup}>
            <label class={styles.controlLabel}>Samples</label>
            <Select
              value={String(ssaoSettings.samples)}
              options={ssaoSamplesOptions}
              onChange={handleSSAOSamples}
              disabled={ssaoControlsDisabled}
            />
          </div>

          <Checkbox
            label="Blur (Edge-Aware)"
            checked={ssaoSettings.blur}
            onChange={handleSSAOBlur}
            disabled={ssaoControlsDisabled}
          />
        </div>
      </Section>
    </Panel>
  );
}
