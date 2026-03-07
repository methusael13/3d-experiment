import { useCallback, useState } from 'preact/hooks';
import { Slider, Checkbox, Select } from '../../../ui';
import type { Entity } from '@/core/ecs/Entity';
import type { LightComponent } from '@/core/ecs/components/LightComponent';
import type { DebugTextureManager } from '@/core/gpu/renderers/DebugTextureManager';
import type { ShadowRendererGPU } from '@/core/gpu/renderers/ShadowRendererGPU';

export interface LightSubPanelProps {
  entity: Entity;
  onChanged: () => void;
  debugTextureManager?: DebugTextureManager | null;
  shadowRenderer?: ShadowRendererGPU | null;
}

/** Convert [r,g,b] (0-1) to hex color string */
function rgbToHex(color: [number, number, number]): string {
  const r = Math.round(color[0] * 255).toString(16).padStart(2, '0');
  const g = Math.round(color[1] * 255).toString(16).padStart(2, '0');
  const b = Math.round(color[2] * 255).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}

/** Convert hex color string to [r,g,b] (0-1) */
function hexToRgb(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return [1, 1, 1];
  return [
    parseInt(result[1], 16) / 255,
    parseInt(result[2], 16) / 255,
    parseInt(result[3], 16) / 255,
  ];
}

/** Generate a unique debug texture name for a light entity's shadow map */
function getShadowDebugName(entityId: string): string {
  return `shadow-spot-${entityId}`;
}

/**
 * LightSubPanel — property editor for LightComponent on light entities.
 *
 * Shows different controls based on light type:
 * - All: enabled, intensity, color picker, castsShadow
 * - Directional: azimuth, elevation, ambientIntensity
 * - Point: range
 * - Spot: range, innerConeAngle, outerConeAngle, shadow map debug
 */
export function LightSubPanel({ entity, onChanged, debugTextureManager, shadowRenderer }: LightSubPanelProps) {
  const lc = entity.getComponent<LightComponent>('light');
  if (!lc) return null;

  const isDirectional = lc.lightType === 'directional';
  const isPoint = lc.lightType === 'point';
  const isSpot = lc.lightType === 'spot';

  // Force re-render after debug toggle
  const [, setTick] = useState(0);

  const lightTypeLabel = isDirectional
    ? '☀️ Directional Light'
    : isPoint
      ? '💡 Point Light'
      : '🔦 Spot Light';

  const handleColorChange = useCallback((e: Event) => {
    const hex = (e.target as HTMLInputElement).value;
    lc.color = hexToRgb(hex);
    onChanged();
  }, [lc, onChanged]);

  // Shadow debug toggle logic
  const shadowDebugName = getShadowDebugName(entity.id);
  const canShowShadowDebug = isSpot && lc.castsShadow && !!debugTextureManager && !!shadowRenderer;

  const handleToggleShadowDebug = useCallback(() => {
    if (!debugTextureManager || !shadowRenderer) return;

    // Register if not yet registered
    const registered = debugTextureManager.getRegisteredTextures();
    if (!registered.includes(shadowDebugName)) {
      const atlasIndex = lc.shadowAtlasIndex;
      debugTextureManager.register(
        shadowDebugName,
        'depth',
        () => {
          // Dynamic callback: reads the current atlas index from the component
          // in case it changes (e.g., slot reallocation)
          const currentIndex = lc.shadowAtlasIndex;
          if (currentIndex < 0) return null;
          return shadowRenderer.getSpotShadowAtlasLayerView(currentIndex);
        },
      );
    }

    debugTextureManager.toggle(shadowDebugName);
    setTick((t) => t + 1);
  }, [debugTextureManager, shadowRenderer, shadowDebugName, lc]);

  const shadowDebugActive = canShowShadowDebug && debugTextureManager!.isEnabled(shadowDebugName);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
        {lightTypeLabel}
      </div>

      <Checkbox
        label="Enabled"
        checked={lc.enabled}
        onChange={(checked) => {
          lc.enabled = checked;
          onChanged();
        }}
      />

      <div style={{ opacity: lc.enabled ? 1 : 0.4, pointerEvents: lc.enabled ? 'auto' : 'none' }}>
        <Slider
          label="Intensity"
          value={lc.intensity}
          min={0}
          max={100}
          step={0.5}
          format={(v) => v.toFixed(1)}
          onChange={(value) => {
            lc.intensity = value;
            onChanged();
          }}
        />

        {/* Color picker */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 0' }}>
          <label style={{ fontSize: '11px', color: 'var(--text-secondary)', minWidth: '40px' }}>Color</label>
          <input
            type="color"
            value={rgbToHex(lc.color)}
            onInput={handleColorChange}
            style={{
              width: '32px',
              height: '24px',
              border: '1px solid var(--border)',
              borderRadius: '3px',
              padding: '1px',
              cursor: 'pointer',
              background: 'transparent',
            }}
          />
          <span style={{ fontSize: '10px', color: 'var(--text-tertiary)' }}>
            {rgbToHex(lc.color)}
          </span>
        </div>

        <Checkbox
          label="Cast Shadows"
          checked={lc.castsShadow}
          onChange={(checked) => {
            lc.castsShadow = checked;
            // If shadows disabled, clean up debug texture registration
            if (!checked && debugTextureManager) {
              debugTextureManager.setEnabled(shadowDebugName, false);
              debugTextureManager.unregister(shadowDebugName);
            }
            onChanged();
          }}
        />

        {/* Directional-specific */}
        {isDirectional && (
          <>
            <Slider
              label="Azimuth"
              value={lc.azimuth ?? 45}
              min={0}
              max={360}
              step={1}
              format={(v) => `${Math.round(v)}°`}
              onChange={(value) => {
                lc.azimuth = value;
                onChanged();
              }}
            />
            <Slider
              label="Elevation"
              value={lc.elevation ?? 45}
              min={-90}
              max={90}
              step={1}
              format={(v) => `${Math.round(v)}°`}
              onChange={(value) => {
                lc.elevation = value;
                onChanged();
              }}
            />
            <Slider
              label="Ambient Intensity"
              value={lc.ambientIntensity ?? 1.0}
              min={0}
              max={2}
              step={0.05}
              format={(v) => v.toFixed(2)}
              onChange={(value) => {
                lc.ambientIntensity = value;
                onChanged();
              }}
            />
          </>
        )}

        {/* Point-specific */}
        {isPoint && (
          <Slider
            label="Range"
            value={lc.range ?? 10}
            min={0.1}
            max={100}
            step={0.5}
            format={(v) => v.toFixed(1)}
            onChange={(value) => {
              lc.range = value;
              onChanged();
            }}
          />
        )}

        {/* Spot-specific */}
        {isSpot && (
          <>
            <Slider
              label="Range"
              value={lc.range ?? 10}
              min={0.1}
              max={100}
              step={0.5}
              format={(v) => v.toFixed(1)}
              onChange={(value) => {
                lc.range = value;
                onChanged();
              }}
            />
            <Slider
              label="Inner Angle"
              value={((lc.innerConeAngle ?? Math.PI / 6) * 180) / Math.PI}
              min={1}
              max={89}
              step={1}
              format={(v) => `${Math.round(v)}°`}
              onChange={(value) => {
                lc.innerConeAngle = (value * Math.PI) / 180;
                onChanged();
              }}
            />
            <Slider
              label="Outer Angle"
              value={((lc.outerConeAngle ?? Math.PI / 4) * 180) / Math.PI}
              min={2}
              max={90}
              step={1}
              format={(v) => `${Math.round(v)}°`}
              onChange={(value) => {
                lc.outerConeAngle = (value * Math.PI) / 180;
                onChanged();
              }}
            />
            {lc.castsShadow && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 0' }}>
                <label style={{ fontSize: '11px', color: 'var(--text-secondary)', minWidth: '70px' }}>Shadow Res</label>
                <Select
                  value={String(lc.shadowMapResolution)}
                  options={[
                    { value: '256', label: '256' },
                    { value: '512', label: '512' },
                    { value: '1024', label: '1024' },
                    { value: '2048', label: '2048' },
                    { value: '4096', label: '4096' },
                  ]}
                  onChange={(value) => {
                    lc.shadowMapResolution = parseInt(value, 10);
                    onChanged();
                  }}
                />
              </div>
            )}
          </>
        )}

        {/* Shadow map debug button (spot lights with active shadow slot only) */}
        {canShowShadowDebug && (
          <div style={{ marginTop: '6px' }}>
            <button
              type="button"
              onClick={handleToggleShadowDebug}
              style={{
                padding: '4px 12px',
                fontSize: '12px',
                cursor: 'pointer',
                background: shadowDebugActive ? '#4a3520' : undefined,
              }}
            >
              {shadowDebugActive ? '🔍 Hide Shadow Map' : '🔍 Show Shadow Map'}
            </button>
            {lc.shadowAtlasIndex >= 0 && (
              <span style={{ fontSize: '10px', color: '#888', marginLeft: '6px' }}>
                Atlas slot {lc.shadowAtlasIndex}
              </span>
            )}
            {lc.shadowAtlasIndex < 0 && (
              <span style={{ fontSize: '10px', color: '#888', marginLeft: '6px' }}>
                ⏳ Awaiting slot…
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}