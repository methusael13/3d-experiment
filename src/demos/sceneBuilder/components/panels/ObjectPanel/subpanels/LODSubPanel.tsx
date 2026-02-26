import { useState, useEffect, useCallback } from 'preact/hooks';
import { Slider } from '../../../ui';
import type { Entity } from '@/core/ecs/Entity';
import type { LODComponent } from '@/core/ecs/components/LODComponent';

export interface LODSubPanelProps {
  entity: Entity;
  onChanged: () => void;
}

/** Poll interval for reading runtime LOD state (ms) */
const LOD_POLL_MS = 250;

/** Default distance spacing when adding a new threshold */
const DEFAULT_THRESHOLD_STEP = 150;

export function LODSubPanel({ entity, onChanged }: LODSubPanelProps) {
  const lod = entity.getComponent<LODComponent>('lod');

  // Poll the runtime currentLOD value so it updates as camera moves
  const [liveLOD, setLiveLOD] = useState(lod?.currentLOD ?? 0);
  // Local revision counter to force re-render when thresholds array changes
  const [, setRevision] = useState(0);

  useEffect(() => {
    if (!lod) return;
    setLiveLOD(lod.currentLOD);
    const id = setInterval(() => {
      setLiveLOD(lod.currentLOD);
    }, LOD_POLL_MS);
    return () => clearInterval(id);
  }, [lod]);

  /**
   * "LOD Levels" = number of discrete LOD levels (e.g. 3 → levels 0,1,2).
   * Internally: lod.maxLOD = levels - 1, thresholds.length = levels - 1
   * (one threshold per transition between adjacent levels).
   */
  const handleLevelCountChange = useCallback(
    (value: number) => {
      if (!lod) return;
      const levels = Math.round(value);
      lod.maxLOD = levels - 1;

      // Resize thresholds array: need (levels - 1) entries
      const needed = levels - 1;
      const current = [...lod.thresholds];
      while (current.length < needed) {
        const lastVal = current.length > 0 ? current[current.length - 1] : 0;
        current.push(lastVal + DEFAULT_THRESHOLD_STEP);
      }
      lod.thresholds = current.slice(0, needed);

      setRevision((r) => r + 1);
      onChanged();
    },
    [lod, onChanged]
  );

  if (!lod) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <Slider
        label="LOD Levels"
        value={lod.maxLOD + 1}
        min={2}
        max={6}
        step={1}
        format={(v) => String(Math.round(v))}
        onChange={handleLevelCountChange}
      />
      <div style={{ fontSize: '10px', color: 'var(--sb-text-muted)', marginTop: '2px' }}>
        Distance Thresholds
      </div>
      {lod.thresholds.map((threshold, i) => (
        <Slider
          key={i}
          label={`LOD ${i} → ${i + 1}`}
          value={threshold}
          min={5}
          max={1000}
          step={5}
          format={(v) => `${Math.round(v)}m`}
          onChange={(value) => {
            lod.thresholds[i] = value;
            onChanged();
          }}
        />
      ))}
      <div style={{ fontSize: '10px', color: 'var(--sb-text-muted)', opacity: 0.7 }}>
        Current LOD: {liveLOD}
      </div>
    </div>
  );
}