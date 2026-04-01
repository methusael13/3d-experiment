import { Slider, Checkbox, Select } from '../../../ui';
import type { SelectOption } from '../../../ui';
import type { Entity } from '@/core/ecs/Entity';
import type { WindSourceComponent } from '@/core/ecs/components/WindSourceComponent';
import type { WindSourceShape } from '@/core/wind/types';

const SHAPE_OPTIONS: SelectOption<WindSourceShape>[] = [
  { value: 'sphere', label: 'Sphere (Omni)' },
  { value: 'directional', label: 'Directional' },
  { value: 'cone', label: 'Cone' },
];

export interface WindSourceSubPanelProps {
  entity: Entity;
  onChanged: () => void;
}

export function WindSourceSubPanel({ entity, onChanged }: WindSourceSubPanelProps) {
  const ws = entity.getComponent<WindSourceComponent>('wind-source');
  if (!ws) return null;

  const isCone = ws.shape === 'cone';
  const isDirectional = ws.shape === 'directional' || isCone;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <Checkbox
        label="Enabled"
        checked={ws.enabled}
        onChange={(checked) => {
          ws.enabled = checked;
          onChanged();
        }}
      />

      <div style={{ opacity: ws.enabled ? 1 : 0.4, pointerEvents: ws.enabled ? 'auto' : 'none' }}>
        <Select
          label="Shape"
          value={ws.shape}
          options={SHAPE_OPTIONS}
          onChange={(value) => {
            ws.shape = value;
            onChanged();
          }}
        />

        {/* ─── Force Parameters ─── */}

        <Slider
          label="Strength"
          value={ws.strength}
          min={0}
          max={5}
          step={0.1}
          format={(v) => v.toFixed(1)}
          onChange={(value) => {
            ws.strength = value;
            onChanged();
          }}
        />

        {isDirectional && (
          <Slider
            label="Direction"
            value={ws.directionAngle}
            min={0}
            max={360}
            step={1}
            format={(v) => `${Math.round(v)}°`}
            onChange={(value) => {
              ws.setDirectionFromAngle(value);
              onChanged();
            }}
          />
        )}

        <Slider
          label="Turbulence"
          value={ws.turbulence}
          min={0}
          max={1}
          step={0.05}
          format={(v) => v.toFixed(2)}
          onChange={(value) => {
            ws.turbulence = value;
            onChanged();
          }}
        />

        <Slider
          label="Gust Strength"
          value={ws.gustStrength}
          min={0}
          max={1}
          step={0.05}
          format={(v) => v.toFixed(2)}
          onChange={(value) => {
            ws.gustStrength = value;
            onChanged();
          }}
        />

        <Slider
          label="Gust Frequency"
          value={ws.gustFrequency}
          min={0.1}
          max={2}
          step={0.1}
          format={(v) => `${v.toFixed(1)} Hz`}
          onChange={(value) => {
            ws.gustFrequency = value;
            onChanged();
          }}
        />

        {/* ─── Spatial Parameters ─── */}

        <div style={{ marginTop: '8px', marginBottom: '4px', fontSize: '11px', color: '#999', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Spatial
        </div>

        <Slider
          label="Radius"
          value={ws.radius}
          min={1}
          max={100}
          step={0.5}
          format={(v) => `${v.toFixed(1)}m`}
          onChange={(value) => {
            ws.radius = value;
            // Keep inner radius <= radius
            if (ws.innerRadius > value) {
              ws.innerRadius = value;
            }
            onChanged();
          }}
        />

        <Slider
          label="Inner Radius"
          value={ws.innerRadius}
          min={0}
          max={ws.radius}
          step={0.5}
          format={(v) => `${v.toFixed(1)}m`}
          onChange={(value) => {
            ws.innerRadius = Math.min(value, ws.radius);
            onChanged();
          }}
        />

        <Slider
          label="Falloff"
          value={ws.falloff}
          min={0.5}
          max={5}
          step={0.1}
          format={(v) => v.toFixed(1)}
          onChange={(value) => {
            ws.falloff = value;
            onChanged();
          }}
        />

        {isCone && (
          <Slider
            label="Cone Angle"
            value={ws.coneAngle}
            min={5}
            max={90}
            step={1}
            format={(v) => `${Math.round(v)}°`}
            onChange={(value) => {
              ws.coneAngle = value;
              onChanged();
            }}
          />
        )}
      </div>
    </div>
  );
}
