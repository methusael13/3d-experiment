import { useCallback } from 'preact/hooks';
import type { Entity } from '@/core/ecs/Entity';
import { FPSCameraComponent } from '@/core/ecs/components/FPSCameraComponent';
import { NumberInput } from '../../../ui/NumberInput/NumberInput';

export interface FPSCameraSubPanelProps {
  entity: Entity;
  onChanged: () => void;
}

export function FPSCameraSubPanel({ entity, onChanged }: FPSCameraSubPanelProps) {
  const cam = entity.getComponent<FPSCameraComponent>('fps-camera');
  if (!cam) return null;

  const handleToggleActive = useCallback(() => {
    cam.active = !cam.active;
    onChanged();
  }, [cam, onChanged]);

  const set = useCallback(
    (field: string, value: number) => {
      (cam as any)[field] = value;
      onChanged();
    },
    [cam, onChanged],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px' }}>
      {/* Active toggle */}
      <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <input
          type="checkbox"
          checked={cam.active}
          onChange={handleToggleActive}
        />
        Active
      </label>

      <NumberInput label="Player Height" value={cam.playerHeight} step={0.1} min={0.1} defaultValue={1.8} onChange={(v) => set('playerHeight', v)} />
      <NumberInput label="Move Speed" value={cam.moveSpeed} step={0.5} min={0} defaultValue={5.0} onChange={(v) => set('moveSpeed', v)} />
      <NumberInput label="Sprint Multiplier" value={cam.sprintMultiplier} step={0.5} min={1} defaultValue={2.0} onChange={(v) => set('sprintMultiplier', v)} />
      <NumberInput label="Sensitivity" value={cam.mouseSensitivity} step={0.0005} min={0} defaultValue={0.002} precision={4} width="80px" onChange={(v) => set('mouseSensitivity', v)} />
      <NumberInput label="FOV (°)" value={Math.round((cam.fov * 180) / Math.PI)} step={5} min={10} max={170} defaultValue={60} onChange={(v) => set('fov', (v * Math.PI) / 180)} />

      {/* Near / Far */}
      <div style={{ display: 'flex', gap: '8px' }}>
        <NumberInput label="Near" value={cam.near} step={0.01} min={0.001} defaultValue={0.1} width="50px" onChange={(v) => set('near', v)} />
        <NumberInput label="Far" value={cam.far} step={100} min={1} defaultValue={1000} onChange={(v) => set('far', v)} />
      </div>

      <div style={{ color: '#888', fontSize: '10px', marginTop: '4px' }}>
        Use View → Play Mode to enter first-person view.
      </div>
    </div>
  );
}