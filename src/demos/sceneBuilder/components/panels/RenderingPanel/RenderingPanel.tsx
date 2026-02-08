import { useCallback } from 'preact/hooks';
import { Panel, Slider, Checkbox, Select, Section } from '../../ui';
import styles from './RenderingPanel.module.css';
import type { SSAOEffectConfig, CompositeEffectConfig } from '@/core/gpu/postprocess';

// Import CSS variables
import '../../styles/variables.css';

export interface WebGPUShadowSettings {
  enabled: boolean;
  resolution: number;
  shadowRadius: number;
  softShadows: boolean;
}

/**
 * SSAO Settings for UI - extends SSAOConfig with enabled flag
 * Uses SSAOConfig from postprocess module for consistency
 */
export interface SSAOSettings extends Required<SSAOEffectConfig> {
  /** Whether SSAO effect is enabled */
  enabled: boolean;
}

export interface RenderingPanelProps {
  // Shadow settings
  shadowSettings: WebGPUShadowSettings;
  showShadowThumbnail: boolean;
  onShadowSettingsChange: (settings: Partial<WebGPUShadowSettings>) => void;
  onShowShadowThumbnailChange: (show: boolean) => void;

  // SSAO settings
  ssaoSettings: SSAOSettings;
  onSSAOSettingsChange: (settings: Partial<SSAOSettings>) => void;

  // Tonemapping settings
  compositeSettings: Required<CompositeEffectConfig>;
  onCompositeSettingsChange: (settings: Partial<CompositeEffectConfig>) => void;

  // WebGPU mode
  webgpuEnabled: boolean;
  webgpuStatus: string;
  onToggleWebGPU: (enabled: boolean) => void;
}

const resolutionOptions = [
  { value: '512', label: '512' },
  { value: '1024', label: '1024' },
  { value: '2048', label: '2048' },
  { value: '4096', label: '4096' },
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

export function RenderingPanel({
  shadowSettings,
  showShadowThumbnail,
  onShadowSettingsChange,
  onShowShadowThumbnailChange,
  ssaoSettings,
  onSSAOSettingsChange,
  compositeSettings,
  onCompositeSettingsChange,
  webgpuEnabled,
  webgpuStatus,
  onToggleWebGPU,
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

  // WebGPU toggle
  const handleWebGPUToggle = useCallback(
    async (enabled: boolean) => {
      await onToggleWebGPU(enabled);
    },
    [onToggleWebGPU]
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

  const controlsDisabled = !shadowSettings.enabled;
  const ssaoControlsDisabled = !ssaoSettings.enabled;

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
            onChange={onShowShadowThumbnailChange}
            disabled={controlsDisabled}
          />
        </div>
      </Section>

      {/* WebGPU Mode Section */}
      <Section title="WebGPU Mode" defaultCollapsed={false}>
        <Checkbox
          label="Enable WebGPU"
          checked={webgpuEnabled}
          onChange={handleWebGPUToggle}
        />
        <div class={styles.webgpuStatus}>{webgpuStatus}</div>
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
