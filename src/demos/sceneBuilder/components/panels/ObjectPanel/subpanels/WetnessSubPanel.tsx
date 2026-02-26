import { Slider, Checkbox } from '../../../ui';
import type { Entity } from '@/core/ecs/Entity';
import type { WetnessComponent } from '@/core/ecs/components/WetnessComponent';

export interface WetnessSubPanelProps {
  entity: Entity;
  onChanged: () => void;
}

export function WetnessSubPanel({ entity, onChanged }: WetnessSubPanelProps) {
  const wc = entity.getComponent<WetnessComponent>('wetness');
  if (!wc) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <Slider
        label="Evaporation Rate"
        value={wc.evaporationRate}
        min={0}
        max={1}
        step={0.01}
        format={(v) => v.toFixed(2)}
        onChange={(value) => {
          wc.evaporationRate = value;
          onChanged();
        }}
      />
      <Checkbox
        label="Enabled"
        checked={wc.enabled}
        onChange={(checked) => {
          wc.enabled = checked;
          onChanged();
        }}
      />
      <Checkbox
        label="Debug (blue overlay)"
        checked={wc.debug}
        onChange={(checked) => {
          wc.debug = checked;
          onChanged();
        }}
      />
    </div>
  );
}