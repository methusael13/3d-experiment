import { useCallback } from 'preact/hooks';
import type { Entity } from '@/core/ecs/Entity';
import { CameraComponent } from '@/core/ecs/components/CameraComponent';
import { NumberInput } from '../../../ui/NumberInput/NumberInput';

export interface CameraSubPanelProps {
  entity: Entity;
  onChanged: () => void;
}

export function CameraSubPanel({ entity, onChanged }: CameraSubPanelProps) {
  const cam = entity.getComponent<CameraComponent>('camera');
  if (!cam) return null;

  const set = useCallback(
    (field: string, value: number) => {
      (cam as any)[field] = value;
      onChanged();
    },
    [cam, onChanged],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px' }}>
      <NumberInput label="FOV (°)" value={Math.round((cam.fov * 180) / Math.PI)} step={5} min={10} max={170} defaultValue={60} onChange={(v) => set('fov', (v * Math.PI) / 180)} />

      {/* Near / Far */}
      <div style={{ display: 'flex', gap: '8px' }}>
        <NumberInput label="Near" value={cam.near} step={0.01} min={0.001} defaultValue={0.1} width="50px" onChange={(v) => set('near', v)} />
        <NumberInput label="Far" value={cam.far} step={100} min={1} defaultValue={1000} onChange={(v) => set('far', v)} />
      </div>
    </div>
  );
}