import { useCallback } from 'preact/hooks';
import { Panel, Slider, Checkbox, Select, Section } from '../../ui';
import styles from './RenderingPanel.module.css';

// Import CSS variables
import '../../styles/variables.css';

export interface WebGPUShadowSettings {
  enabled: boolean;
  resolution: number;
  shadowRadius: number;
  softShadows: boolean;
}

export interface RenderingPanelProps {
  // Shadow settings
  shadowSettings: WebGPUShadowSettings;
  showShadowThumbnail: boolean;
  onShadowSettingsChange: (settings: Partial<WebGPUShadowSettings>) => void;
  onShowShadowThumbnailChange: (show: boolean) => void;

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

export function RenderingPanel({
  shadowSettings,
  showShadowThumbnail,
  onShadowSettingsChange,
  onShowShadowThumbnailChange,
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

  const controlsDisabled = !shadowSettings.enabled;

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
      <Section title="🧪 WebGPU Mode" defaultCollapsed={false}>
        <Checkbox
          label="Enable WebGPU Terrain"
          checked={webgpuEnabled}
          onChange={handleWebGPUToggle}
        />
        <div class={styles.webgpuStatus}>{webgpuStatus}</div>
      </Section>

      {/* Post Processing (disabled) */}
      <Section title="Post Processing (coming soon)" defaultCollapsed>
        <div class={styles.disabledSection}>
          <Checkbox
            label="Anti-aliasing (FXAA)"
            checked={false}
            onChange={() => {}}
            disabled
          />
          <Checkbox
            label="Ambient Occlusion (SSAO)"
            checked={false}
            onChange={() => {}}
            disabled
          />
          <Checkbox
            label="Bloom"
            checked={false}
            onChange={() => {}}
            disabled
          />
        </div>
      </Section>
    </Panel>
  );
}
