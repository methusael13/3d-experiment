import { useCallback } from 'preact/hooks';
import type { Entity } from '@/core/ecs/Entity';
import { SSRComponent } from '@/core/ecs/components/SSRComponent';
import { Slider, Checkbox } from '../../../ui';

export interface SSRSubPanelProps {
  entity: Entity;
  onChanged: () => void;
}

export function SSRSubPanel({ entity, onChanged }: SSRSubPanelProps) {
  const ssr = entity.getComponent<SSRComponent>('ssr');
  if (!ssr) return null;

  const handleIntensityChange = useCallback(
    (value: number) => {
      ssr.intensity = value;
      onChanged();
    },
    [ssr, onChanged]
  );

  const handleThresholdChange = useCallback(
    (value: number) => {
      ssr.metallicThreshold = value;
      onChanged();
    },
    [ssr, onChanged]
  );

  return (
    <div>
      <Slider
        label="SSR Intensity"
        value={ssr.intensity}
        min={0}
        max={1}
        step={0.05}
        format={(v) => v.toFixed(2)}
        onChange={handleIntensityChange}
      />
      <Slider
        label="Metallic Threshold"
        value={ssr.metallicThreshold}
        min={0}
        max={1}
        step={0.05}
        format={(v) => v.toFixed(2)}
        onChange={handleThresholdChange}
      />
    </div>
  );
}