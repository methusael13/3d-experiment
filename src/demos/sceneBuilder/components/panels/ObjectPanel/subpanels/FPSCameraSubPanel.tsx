import { useCallback } from 'preact/hooks';
import type { Entity } from '@/core/ecs/Entity';
import { FPSCameraComponent } from '@/core/ecs/components/FPSCameraComponent';
import { Section } from '../../../ui/Section/Section';

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

  const handleNumberChange = useCallback(
    (field: keyof FPSCameraComponent, value: number) => {
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

      {/* Player Height */}
      <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Player Height</span>
        <input
          type="number"
          step="0.1"
          value={cam.playerHeight}
          style={{ width: '60px' }}
          onInput={(e) => handleNumberChange('playerHeight', parseFloat((e.target as HTMLInputElement).value) || 1.8)}
        />
      </label>

      {/* Move Speed */}
      <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Move Speed</span>
        <input
          type="number"
          step="0.5"
          value={cam.moveSpeed}
          style={{ width: '60px' }}
          onInput={(e) => handleNumberChange('moveSpeed', parseFloat((e.target as HTMLInputElement).value) || 5.0)}
        />
      </label>

      {/* Sprint Multiplier */}
      <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Sprint Multiplier</span>
        <input
          type="number"
          step="0.5"
          value={cam.sprintMultiplier}
          style={{ width: '60px' }}
          onInput={(e) => handleNumberChange('sprintMultiplier', parseFloat((e.target as HTMLInputElement).value) || 2.0)}
        />
      </label>

      {/* Mouse Sensitivity */}
      <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Sensitivity</span>
        <input
          type="number"
          step="0.0005"
          value={cam.mouseSensitivity}
          style={{ width: '80px' }}
          onInput={(e) => handleNumberChange('mouseSensitivity', parseFloat((e.target as HTMLInputElement).value) || 0.002)}
        />
      </label>

      {/* FOV (display in degrees) */}
      <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>FOV (°)</span>
        <input
          type="number"
          step="5"
          value={Math.round((cam.fov * 180) / Math.PI)}
          style={{ width: '60px' }}
          onInput={(e) => {
            const deg = parseFloat((e.target as HTMLInputElement).value) || 60;
            handleNumberChange('fov', (deg * Math.PI) / 180);
          }}
        />
      </label>

      {/* Near / Far */}
      <div style={{ display: 'flex', gap: '8px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '4px', flex: 1 }}>
          <span>Near</span>
          <input
            type="number"
            step="0.01"
            value={cam.near}
            style={{ width: '50px' }}
            onInput={(e) => handleNumberChange('near', parseFloat((e.target as HTMLInputElement).value) || 0.1)}
          />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '4px', flex: 1 }}>
          <span>Far</span>
          <input
            type="number"
            step="100"
            value={cam.far}
            style={{ width: '60px' }}
            onInput={(e) => handleNumberChange('far', parseFloat((e.target as HTMLInputElement).value) || 1000)}
          />
        </label>
      </div>

      <div style={{ color: '#888', fontSize: '10px', marginTop: '4px' }}>
        Use View → Play Mode to enter first-person view.
      </div>
    </div>
  );
}