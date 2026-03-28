import { useCallback } from 'preact/hooks';
import type { Entity } from '@/core/ecs/Entity';
import { PlayerComponent } from '@/core/ecs/components/PlayerComponent';
import { NumberInput } from '../../../ui/NumberInput/NumberInput';

export interface PlayerSubPanelProps {
  entity: Entity;
  onChanged: () => void;
  onEditController?: (entity: Entity) => void;
}

export function PlayerSubPanel({ entity, onChanged, onEditController }: PlayerSubPanelProps) {
  const player = entity.getComponent<PlayerComponent>('player');
  if (!player) return null;

  const handleToggleActive = useCallback(() => {
    player.active = !player.active;
    onChanged();
  }, [player, onChanged]);

  const set = useCallback(
    (field: string, value: number) => {
      (player as any)[field] = value;
      onChanged();
    },
    [player, onChanged],
  );

  const handleEditController = useCallback(() => {
    onEditController?.(entity);
  }, [entity, onEditController]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px' }}>
      {/* Active toggle */}
      <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <input
          type="checkbox"
          checked={player.active}
          onChange={handleToggleActive}
        />
        Active
      </label>

      <NumberInput label="Player Height" value={player.playerHeight} step={0.1} min={0.1} defaultValue={1.8} onChange={(v) => set('playerHeight', v)} />
      <NumberInput label="Move Speed" value={player.moveSpeed} step={0.5} min={0} defaultValue={5.0} onChange={(v) => set('moveSpeed', v)} />
      <NumberInput label="Sprint Multiplier" value={player.sprintMultiplier} step={0.5} min={1} defaultValue={2.0} onChange={(v) => set('sprintMultiplier', v)} />
      <NumberInput label="Sensitivity" value={player.mouseSensitivity} step={0.0005} min={0} defaultValue={0.002} precision={4} width="80px" onChange={(v) => set('mouseSensitivity', v)} />

      {/* Edit Controller button */}
      <button
        onClick={handleEditController}
        style={{
          marginTop: '4px',
          padding: '6px 12px',
          background: '#2a4a3a',
          color: '#aaddaa',
          border: '1px solid #3a6a4a',
          borderRadius: '4px',
          cursor: 'pointer',
          fontSize: '11px',
          fontWeight: 600,
          textAlign: 'center',
        }}
      >
        🎮 Edit Controller Graph
      </button>

      <div style={{ color: '#888', fontSize: '10px', marginTop: '4px' }}>
        Use View → Play Mode to enter first-person view.
      </div>
    </div>
  );
}
