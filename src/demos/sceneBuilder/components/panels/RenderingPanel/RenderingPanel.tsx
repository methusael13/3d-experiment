import { useCallback } from 'preact/hooks';
import { Panel, Slider, Checkbox, Select, Section } from '../../ui';
import styles from './RenderingPanel.module.css';
import type { SSAOEffectConfig, CompositeEffectConfig, AtmosphericFogConfig } from '@/core/gpu/postprocess';
import type { SSRQualityLevel } from '@/core/gpu/pipeline/SSRConfig';
import type { DebugViewMode } from '@/core/gpu/pipeline/passes/DebugViewPass';
import type { CloudConfig } from '@/core/gpu/clouds/types';
import { WEATHER_PRESET_NAMES } from '@/core/gpu/clouds/WeatherPresets';

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

/**
 * Atmospheric fog settings for UI
 */
export interface AtmosphericFogSettings extends Required<AtmosphericFogConfig> {}

export type { DebugViewMode };

/**
 * Cloud settings for UI
 */
export interface CloudSettings {
  enabled: boolean;
  coverage: number;
  cloudType: number;
  density: number;
  cloudBase: number;
  cloudThickness: number;
  windSpeed: number;
  windDirection: number;
  seed: number;
}

/**
 * God ray settings for UI
 */
export type GodRayMode = 'screen-space' | 'volumetric';

export interface GodRaySettings {
  enabled: boolean;
  mode: GodRayMode;
  intensity: number;
  samples: number;
  decay: number;
  weight: number;
  density: number;
}

/**
 * Resolution scale preset value type
 */
export type ResolutionScalePreset = '1.0' | '0.75' | '0.5' | '0.25';

export interface RenderingPanelProps {
  // Resolution scale
  resolutionScale: ResolutionScalePreset;
  onResolutionScaleChange: (scale: ResolutionScalePreset) => void;
  /** Display string showing effective render resolution, e.g. "2400 × 1600" */
  renderResolutionLabel?: string;

  // Shadow settings
  shadowSettings: WebGPUShadowSettings;
  onShadowSettingsChange: (settings: Partial<WebGPUShadowSettings>) => void;

  // SSAO settings
  ssaoSettings: SSAOSettings;
  onSSAOSettingsChange: (settings: Partial<SSAOSettings>) => void;

  // SSR settings
  ssrSettings: SSRSettings;
  onSSRSettingsChange: (settings: Partial<SSRSettings>) => void;

  // Atmospheric fog settings
  atmosphericFogSettings: AtmosphericFogSettings;
  onAtmosphericFogSettingsChange: (settings: Partial<AtmosphericFogSettings>) => void;

  // Cloud settings
  cloudSettings: CloudSettings;
  onCloudSettingsChange: (settings: Partial<CloudSettings>) => void;
  showCloudShadowDebug: boolean;
  onCloudShadowDebugToggle: (enabled: boolean) => void;

  // Weather preset (Phase 5)
  weatherPreset: string | null;
  onWeatherPresetChange: (preset: string) => void;

  // God ray settings
  godRaySettings: GodRaySettings;
  onGodRaySettingsChange: (settings: Partial<GodRaySettings>) => void;

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

const fogModeOptions = [
  { value: 'exp', label: 'Exponential (Natural)' },
  { value: 'exp2', label: 'Exp² (Sharp Wall)' },
];

const resolutionScaleOptions = [
  { value: '1.0', label: 'Native (Full DPR)' },
  { value: '0.75', label: 'High (75%)' },
  { value: '0.5', label: 'Medium (50%)' },
  { value: '0.25', label: 'Low (25%)' },
];

export function RenderingPanel({
  resolutionScale,
  onResolutionScaleChange,
  renderResolutionLabel,
  shadowSettings,
  showShadowThumbnail,
  onShadowDebugToggle,
  onShadowSettingsChange,
  ssaoSettings,
  onSSAOSettingsChange,
  ssrSettings,
  onSSRSettingsChange,
  atmosphericFogSettings,
  onAtmosphericFogSettingsChange,
  cloudSettings,
  onCloudSettingsChange,
  showCloudShadowDebug,
  onCloudShadowDebugToggle,
  weatherPreset,
  onWeatherPresetChange,
  godRaySettings,
  onGodRaySettingsChange,
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
      {/* Resolution Scale */}
      <Section title="Resolution" defaultCollapsed={false}>
        <div class={styles.controlGroup}>
          <label class={styles.controlLabel}>Render Scale</label>
          <Select
            value={resolutionScale}
            options={resolutionScaleOptions}
            onChange={(v) => onResolutionScaleChange(v as ResolutionScalePreset)}
          />
        </div>
        {renderResolutionLabel && (
          <div class={styles.resolutionInfo}>{renderResolutionLabel}</div>
        )}
      </Section>

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

      {/* Post Processing - Atmosphere */}
      <Section title="Atmosphere" defaultCollapsed={true}>
        <Checkbox
          label="Enable Atmospheric Fog"
          checked={atmosphericFogSettings.enabled}
          onChange={(enabled) => onAtmosphericFogSettingsChange({ enabled })}
        />

        <div class={`${styles.shadowControls} ${!atmosphericFogSettings.enabled ? styles.disabled : ''}`}>
          {/* Aerial Perspective (Haze) */}
          <div class={styles.controlGroup}>
            <label class={styles.controlLabel} style={{ fontWeight: 600, fontSize: '11px', marginTop: '4px' }}>Aerial Perspective</label>
          </div>

          <Slider
            label="Visibility Distance"
            value={atmosphericFogSettings.visibilityDistance}
            min={200}
            max={10000}
            step={100}
            format={(v) => `${Math.round(v)}m`}
            onChange={(v) => onAtmosphericFogSettingsChange({ visibilityDistance: v })}
            disabled={!atmosphericFogSettings.enabled}
          />

          <Slider
            label="Haze Intensity"
            value={atmosphericFogSettings.hazeIntensity}
            min={0}
            max={2}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onChange={(v) => onAtmosphericFogSettingsChange({ hazeIntensity: v })}
            disabled={!atmosphericFogSettings.enabled}
          />

          <Slider
            label="Scale Height"
            value={atmosphericFogSettings.hazeScaleHeight}
            min={100}
            max={5000}
            step={50}
            format={(v) => `${Math.round(v)}m`}
            onChange={(v) => onAtmosphericFogSettingsChange({ hazeScaleHeight: v })}
            disabled={!atmosphericFogSettings.enabled}
          />

          {/* Height Fog */}
          <div class={styles.controlGroup}>
            <label class={styles.controlLabel} style={{ fontWeight: 600, fontSize: '11px', marginTop: '8px' }}>Height Fog</label>
          </div>

          <Checkbox
            label="Enable Height Fog"
            checked={atmosphericFogSettings.heightFogEnabled}
            onChange={(v) => onAtmosphericFogSettingsChange({ heightFogEnabled: v })}
            disabled={!atmosphericFogSettings.enabled}
          />

          <div class={styles.controlGroup}>
            <label class={styles.controlLabel}>Fog Mode</label>
            <Select
              value={atmosphericFogSettings.fogMode}
              options={fogModeOptions}
              onChange={(v) => onAtmosphericFogSettingsChange({ fogMode: v as 'exp' | 'exp2' })}
              disabled={!atmosphericFogSettings.enabled || !atmosphericFogSettings.heightFogEnabled}
            />
          </div>

          <Slider
            label="Fog Visibility"
            value={atmosphericFogSettings.fogVisibilityDistance}
            min={50}
            max={10000}
            step={50}
            format={(v) => `${Math.round(v)}m`}
            onChange={(v) => onAtmosphericFogSettingsChange({ fogVisibilityDistance: v })}
            disabled={!atmosphericFogSettings.enabled || !atmosphericFogSettings.heightFogEnabled}
          />

          <Slider
            label="Fog Height"
            value={atmosphericFogSettings.fogHeight}
            min={-900}
            max={900}
            step={5}
            format={(v) => `${Math.round(v)}m`}
            onChange={(v) => onAtmosphericFogSettingsChange({ fogHeight: v })}
            disabled={!atmosphericFogSettings.enabled || !atmosphericFogSettings.heightFogEnabled}
          />

          <Slider
            label="Height Falloff"
            value={atmosphericFogSettings.fogHeightFalloff}
            min={0.005}
            max={1.0}
            step={0.005}
            format={(v) => v.toFixed(3)}
            onChange={(v) => onAtmosphericFogSettingsChange({ fogHeightFalloff: v })}
            disabled={!atmosphericFogSettings.enabled || !atmosphericFogSettings.heightFogEnabled}
          />

          <Slider
            label="Sun Scattering"
            value={atmosphericFogSettings.fogSunScattering}
            min={0}
            max={1}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onChange={(v) => onAtmosphericFogSettingsChange({ fogSunScattering: v })}
            disabled={!atmosphericFogSettings.enabled || !atmosphericFogSettings.heightFogEnabled}
          />
        </div>
      </Section>

      {/* God Rays */}
      <Section title="God Rays" defaultCollapsed={true}>
        <Checkbox
          label="Enable God Rays"
          checked={godRaySettings.enabled}
          onChange={(enabled) => onGodRaySettingsChange({ enabled })}
        />

        <div class={`${styles.shadowControls} ${!godRaySettings.enabled ? styles.disabled : ''}`}>
          <div class={styles.controlGroup}>
            <label class={styles.controlLabel}>Mode</label>
            <Select
              value={godRaySettings.mode}
              options={[
                { value: 'screen-space', label: 'Screen-Space (Fast)' },
                { value: 'volumetric', label: 'Volumetric / Froxel (HQ)' },
              ]}
              onChange={(v) => onGodRaySettingsChange({ mode: v as 'screen-space' | 'volumetric' })}
              disabled={!godRaySettings.enabled}
            />
          </div>

          <Slider
            label="Intensity"
            value={godRaySettings.intensity}
            min={0}
            max={2}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onChange={(v) => onGodRaySettingsChange({ intensity: v })}
            disabled={!godRaySettings.enabled}
          />

          <Slider
            label="Density"
            value={godRaySettings.density}
            min={0.5}
            max={2.0}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onChange={(v) => onGodRaySettingsChange({ density: v })}
            disabled={!godRaySettings.enabled}
          />

          <Slider
            label="Weight"
            value={godRaySettings.weight}
            min={0.1}
            max={1.5}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onChange={(v) => onGodRaySettingsChange({ weight: v })}
            disabled={!godRaySettings.enabled}
          />

          <Slider
            label="Decay"
            value={godRaySettings.decay}
            min={0.9}
            max={0.99}
            step={0.005}
            format={(v) => v.toFixed(3)}
            onChange={(v) => onGodRaySettingsChange({ decay: v })}
            disabled={!godRaySettings.enabled}
          />

          <Slider
            label="Samples"
            value={godRaySettings.samples}
            min={16}
            max={128}
            step={16}
            format={(v) => String(Math.round(v))}
            onChange={(v) => onGodRaySettingsChange({ samples: Math.round(v) })}
            disabled={!godRaySettings.enabled}
          />
        </div>
      </Section>

      {/* Volumetric Clouds */}
      <Section title="Volumetric Clouds" defaultCollapsed={true}>
        <Checkbox
          label="Enable Clouds"
          checked={cloudSettings.enabled}
          onChange={(enabled) => onCloudSettingsChange({ enabled })}
        />

        <div class={`${styles.shadowControls} ${!cloudSettings.enabled ? styles.disabled : ''}`}>
          {/* Weather Preset Dropdown (Phase 5) */}
          <div class={styles.controlGroup}>
            <label class={styles.controlLabel}>Weather Preset</label>
            <Select
              value={weatherPreset ?? 'Custom'}
              options={[
                ...WEATHER_PRESET_NAMES.map(name => ({ value: name, label: name })),
                { value: 'Custom', label: '— Custom —' },
              ]}
              onChange={(v) => {
                if (v !== 'Custom') onWeatherPresetChange(v);
              }}
              disabled={!cloudSettings.enabled}
            />
          </div>

          <Slider
            label="Coverage"
            value={cloudSettings.coverage}
            min={0}
            max={1}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => onCloudSettingsChange({ coverage: v })}
            disabled={!cloudSettings.enabled}
          />

          <Slider
            label="Cloud Type"
            value={cloudSettings.cloudType}
            min={0}
            max={1}
            step={0.05}
            format={(v) => v < 0.3 ? 'Stratus' : v < 0.65 ? 'Stratocumulus' : 'Cumulus'}
            onChange={(v) => onCloudSettingsChange({ cloudType: v })}
            disabled={!cloudSettings.enabled}
          />

          <Slider
            label="Density"
            value={cloudSettings.density}
            min={0.01}
            max={0.5}
            step={0.01}
            format={(v) => v.toFixed(2)}
            onChange={(v) => onCloudSettingsChange({ density: v })}
            disabled={!cloudSettings.enabled}
          />

          <Slider
            label="Cloud Base"
            value={cloudSettings.cloudBase}
            min={500}
            max={5000}
            step={100}
            format={(v) => `${Math.round(v)}m`}
            onChange={(v) => onCloudSettingsChange({ cloudBase: v })}
            disabled={!cloudSettings.enabled}
          />

          <Slider
            label="Thickness"
            value={cloudSettings.cloudThickness}
            min={500}
            max={5000}
            step={100}
            format={(v) => `${Math.round(v)}m`}
            onChange={(v) => onCloudSettingsChange({ cloudThickness: v })}
            disabled={!cloudSettings.enabled}
          />

          <Slider
            label="Wind Speed"
            value={cloudSettings.windSpeed}
            min={0}
            max={50}
            step={1}
            format={(v) => `${Math.round(v)} m/s`}
            onChange={(v) => onCloudSettingsChange({ windSpeed: v })}
            disabled={!cloudSettings.enabled}
          />

          <Slider
            label="Wind Direction"
            value={cloudSettings.windDirection}
            min={0}
            max={360}
            step={5}
            format={(v) => `${Math.round(v)}°`}
            onChange={(v) => onCloudSettingsChange({ windDirection: v })}
            disabled={!cloudSettings.enabled}
          />

          <Slider
            label="Seed"
            value={cloudSettings.seed}
            min={0}
            max={1000}
            step={1}
            format={(v) => String(Math.round(v))}
            onChange={(v) => onCloudSettingsChange({ seed: Math.round(v) })}
            disabled={!cloudSettings.enabled}
          />

          <Checkbox
            label="Show Cloud Shadow Map"
            checked={showCloudShadowDebug}
            onChange={onCloudShadowDebugToggle}
            disabled={!cloudSettings.enabled}
          />
        </div>
      </Section>
    </Panel>
  );
}
