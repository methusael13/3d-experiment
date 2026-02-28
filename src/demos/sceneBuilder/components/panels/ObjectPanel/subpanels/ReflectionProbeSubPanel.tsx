import { useCallback, useState } from 'preact/hooks';
import type { Entity } from '@/core/ecs/Entity';
import { ReflectionProbeComponent, type ProbeResolution } from '@/core/ecs/components/ReflectionProbeComponent';
import type { DebugTextureManager } from '@/core/gpu/renderers/DebugTextureManager';
import { Slider, Checkbox } from '../../../ui';
import { Select } from '../../../ui/Select/Select';

const RESOLUTION_OPTIONS = [
  { value: '64', label: '64×64 (Fast)' },
  { value: '128', label: '128×128 (Default)' },
  { value: '256', label: '256×256 (High)' },
];

const BAKE_STATE_LABELS: Record<string, string> = {
  none: '⚪ Not baked',
  pending: '🟡 Pending…',
  baking: '🟠 Baking…',
  baked: '🟢 Baked',
};

export interface ReflectionProbeSubPanelProps {
  entity: Entity;
  onChanged: () => void;
  debugTextureManager?: DebugTextureManager | null;
}

export function ReflectionProbeSubPanel({ entity, onChanged, debugTextureManager }: ReflectionProbeSubPanelProps) {
  const probe = entity.getComponent<ReflectionProbeComponent>('reflection-probe');
  if (!probe) return null;

  // Force re-render after bake or debug toggle
  const [, setTick] = useState(0);

  const handleResolutionChange = useCallback(
    (value: string) => {
      probe.resolution = parseInt(value, 10) as ProbeResolution;
      onChanged();
    },
    [probe, onChanged],
  );

  const handleIntensityChange = useCallback(
    (value: number) => {
      probe.intensity = value;
      onChanged();
    },
    [probe, onChanged],
  );

  const handleAutoBakeChange = useCallback(
    (checked: boolean) => {
      probe.autoBakeOnTransformChange = checked;
      onChanged();
    },
    [probe, onChanged],
  );

  const handleBake = useCallback(() => {
    probe.requestBake();
    onChanged();
    // Poll for completion to update UI
    const interval = setInterval(() => {
      if (probe.bakeState === 'baked' || probe.bakeState === 'none') {
        clearInterval(interval);
        // Auto-register debug textures after bake
        if (probe.isBaked && debugTextureManager && !probe._debugRegistered) {
          probe.registerDebugTextures(debugTextureManager);
        }
        setTick((t) => t + 1);
      }
    }, 100);
  }, [probe, onChanged, debugTextureManager]);

  const handleToggleDebug = useCallback(() => {
    if (!debugTextureManager || !probe.isBaked) return;
    // Register if not yet
    if (!probe._debugRegistered) {
      probe.registerDebugTextures(debugTextureManager);
    }
    probe.toggleDebugTextures(debugTextureManager);
    setTick((t) => t + 1);
  }, [probe, debugTextureManager]);

  const stateLabel = BAKE_STATE_LABELS[probe.bakeState] ?? probe.bakeState;
  const isBaking = probe.bakeState === 'pending' || probe.bakeState === 'baking';
  const debugActive = debugTextureManager ? probe.isDebugActive(debugTextureManager) : false;

  return (
    <div>
      <Select
        label="Resolution"
        value={String(probe.resolution)}
        options={RESOLUTION_OPTIONS}
        onChange={handleResolutionChange}
      />

      <Slider
        label="Intensity"
        value={probe.intensity}
        min={0}
        max={1}
        step={0.05}
        format={(v) => v.toFixed(2)}
        onChange={handleIntensityChange}
      />

      <Checkbox
        label="Auto-bake on move"
        checked={probe.autoBakeOnTransformChange}
        onChange={handleAutoBakeChange}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
        <button
          type="button"
          onClick={handleBake}
          disabled={isBaking}
          style={{
            padding: '4px 12px',
            fontSize: '12px',
            cursor: isBaking ? 'not-allowed' : 'pointer',
            opacity: isBaking ? 0.6 : 1,
          }}
        >
          {probe.isBaked ? '🔄 Re-Bake' : '🎯 Bake Probe'}
        </button>
        <span style={{ fontSize: '11px', color: '#aaa' }}>{stateLabel}</span>
      </div>

      {probe.isBaked && debugTextureManager && (
        <div style={{ marginTop: '6px' }}>
          <button
            type="button"
            onClick={handleToggleDebug}
            style={{
              padding: '4px 12px',
              fontSize: '12px',
              cursor: 'pointer',
              background: debugActive ? '#4a3520' : undefined,
            }}
          >
            {debugActive ? '🔍 Hide Debug Faces' : '🔍 Show Debug Faces'}
          </button>
        </div>
      )}
    </div>
  );
}