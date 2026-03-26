/**
 * AnimationSubPanel — Shows animation clip assignments, playback controls,
 * and speed thresholds for entities with SkeletonComponent + AnimationComponent.
 *
 * Displays as an intrinsic panel (auto-shown when skeleton is present, not removable).
 */

import { useState, useCallback } from 'preact/hooks';
import { Slider, Checkbox } from '../../../ui';
import { AssetPickerModal } from '../../../ui/AssetPickerModal';
import type { Asset } from '../../../hooks/useAssetLibrary';
import type { Entity } from '@/core/ecs/Entity';
import { SkeletonComponent } from '@/core/ecs/components/SkeletonComponent';
import { AnimationComponent, type AnimationState } from '@/core/ecs/components/AnimationComponent';
import { isSkeletonCompatible, loadAnimationClipsCached } from '@/core/animation/utils';
import { getModelUrl } from '@/loaders';
import { remapAnimationClip } from '@/core/animation/utils';
import styles from '../ObjectPanel.module.css';

/** All animation states that can be assigned clips */
const ANIMATION_STATES: AnimationState[] = ['idle', 'walk', 'run', 'jump', 'fall', 'land'];

export interface AnimationSubPanelProps {
  entity: Entity;
  onChanged: () => void;
}

export function AnimationSubPanel({ entity, onChanged }: AnimationSubPanelProps) {
  const skel = entity.getComponent<SkeletonComponent>('skeleton');
  const anim = entity.getComponent<AnimationComponent>('animation');

  // Asset picker state
  const [showPicker, setShowPicker] = useState(false);
  const [targetState, setTargetState] = useState<AnimationState>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  if (!skel?.skeleton || !anim) return null;

  const jointCount = skel.skeleton.joints.length;

  // Resolve clip name for a state
  const getClipName = (state: AnimationState): string | null => {
    const clipKey = anim.stateToClip.get(state) ?? state;
    return anim.clips.has(clipKey) ? clipKey : null;
  };

  // Open the asset picker for a specific animation state
  const handleAddClip = useCallback((state: AnimationState) => {
    setTargetState(state);
    setLoadError(null);
    setShowPicker(true);
  }, []);

  // Handle asset selected from the picker
  const handleAnimationSelected = useCallback(async (asset: Asset) => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const url = getModelUrl(asset.path);
      const { clips, skeleton: animSkel } = await loadAnimationClipsCached(url);

      // Validate skeleton compatibility
      if (skel.skeleton && animSkel) {
        if (!isSkeletonCompatible(skel.skeleton, animSkel)) {
          setLoadError(`Skeleton mismatch: "${asset.name}" is not compatible with this character (${animSkel.joints.length} vs ${skel.skeleton.joints.length} joints)`);
          setIsLoading(false);
          return;
        }
      }

      if (clips.length > 0) {
        // If the animation source skeleton has different joint ordering, remap channels
        let clip = clips[0];
        if (skel.skeleton && animSkel && animSkel.joints.length === skel.skeleton.joints.length) {
          // Check if joint ordering differs (names match but indices may differ)
          let needsRemap = false;
          for (let i = 0; i < animSkel.joints.length; i++) {
            if (animSkel.joints[i].name !== skel.skeleton.joints[i].name) {
              needsRemap = true;
              break;
            }
          }
          if (needsRemap) {
            clip = remapAnimationClip(clip, animSkel.joints, skel.skeleton.joints);
          }
        }

        // Use the first clip from the file, keyed by the asset name for readability
        const clipName = clip.name || asset.name;
        anim.clips.set(clipName, clip);
        anim.stateToClip.set(targetState, clipName);

        // If the current state has no clip assigned, switch to the newly assigned
        // state so the animation starts playing immediately (instead of staying in T-pose)
        const currentClipKey = anim.stateToClip.get(anim.currentState) ?? anim.currentState;
        if (!anim.clips.has(currentClipKey)) {
          anim.currentState = targetState;
          anim.animationTime = 0;
          anim.blendFactor = 1;
        }

        onChanged();
      } else {
        setLoadError(`No animation clips found in "${asset.name}"`);
      }
    } catch (err) {
      console.error('[AnimationSubPanel] Failed to load animation clip:', err);
      setLoadError(`Failed to load "${asset.name}": ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsLoading(false);
    }
  }, [skel, anim, targetState, onChanged]);

  // Remove a clip assignment
  const handleRemoveClip = useCallback((state: AnimationState) => {
    const clipKey = anim.stateToClip.get(state) ?? state;
    anim.clips.delete(clipKey);
    anim.stateToClip.delete(state);
    onChanged();
  }, [anim, onChanged]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {/* Skeleton info */}
      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
        Skeleton: {jointCount} joints • {anim.clips.size} clips loaded
      </div>

      {/* Show Skeleton debug overlay */}
      <Checkbox
        label="Show Skeleton"
        checked={skel.showSkeleton}
        onChange={(checked) => {
          skel.showSkeleton = checked;
          onChanged();
        }}
      />

      {/* Hide mesh (bones only mode) — only visible when skeleton is shown */}
      {skel.showSkeleton && (
        <Checkbox
          label="Hide Mesh"
          checked={skel.hideMesh}
          onChange={(checked) => {
            skel.hideMesh = checked;
            onChanged();
          }}
        />
      )}

      {/* Current state (read-only, driven by physics) */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px' }}>
        <span style={{ color: 'var(--text-secondary)' }}>State:</span>
        <span style={{ color: 'var(--accent-color)', fontWeight: 'bold', textTransform: 'capitalize' }}>
          {anim.currentState}
        </span>
      </div>

      {/* Playback controls */}
      <Checkbox
        label="Paused"
        checked={anim.paused}
        onChange={(checked) => {
          anim.paused = checked;
          onChanged();
        }}
      />

      <Checkbox
        label="Auto State (Physics)"
        checked={anim.autoStateFromPhysics}
        onChange={(checked) => {
          anim.autoStateFromPhysics = checked;
          onChanged();
        }}
      />

      <Slider
        label="Speed"
        value={anim.playbackSpeed}
        min={0}
        max={3}
        step={0.1}
        format={(v) => `${v.toFixed(1)}×`}
        onChange={(value) => {
          anim.playbackSpeed = value;
          onChanged();
        }}
      />

      <Slider
        label="Blend Duration"
        value={anim.blendDuration}
        min={0}
        max={1}
        step={0.05}
        format={(v) => `${v.toFixed(2)}s`}
        onChange={(value) => {
          anim.blendDuration = value;
          onChanged();
        }}
      />

      {/* Speed thresholds */}
      <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '6px', marginTop: '2px' }}>
        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
          Speed Thresholds
        </div>
        <Slider
          label="Idle <"
          value={anim.idleThreshold}
          min={0}
          max={5}
          step={0.1}
          format={(v) => v.toFixed(1)}
          onChange={(value) => {
            anim.idleThreshold = value;
            onChanged();
          }}
        />
        <Slider
          label="Run >"
          value={anim.runThreshold}
          min={1}
          max={20}
          step={0.5}
          format={(v) => v.toFixed(1)}
          onChange={(value) => {
            anim.runThreshold = value;
            onChanged();
          }}
        />
      </div>

      {/* Clip assignments */}
      <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '6px', marginTop: '2px' }}>
        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
          Clip Assignments
        </div>
        {ANIMATION_STATES.map((state) => {
          const clipName = getClipName(state);
          return (
            <div
              key={state}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '3px 0',
                fontSize: '12px',
              }}
            >
              <span style={{
                textTransform: 'capitalize',
                color: clipName ? 'var(--text-primary)' : 'var(--text-tertiary)',
                minWidth: '40px',
              }}>
                {state}
              </span>
              {clipName ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-secondary)', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {clipName}
                  </span>
                  <button
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--accent-color)',
                      cursor: 'pointer',
                      fontSize: '11px',
                      padding: '0 2px',
                      opacity: 0.7,
                    }}
                    title={`Change ${state} clip`}
                    onClick={() => handleAddClip(state)}
                  >
                    ✎
                  </button>
                  <button
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--text-tertiary)',
                      cursor: 'pointer',
                      fontSize: '12px',
                      padding: '0 2px',
                    }}
                    title={`Remove ${state} clip`}
                    onClick={() => handleRemoveClip(state)}
                  >
                    ✕
                  </button>
                </div>
              ) : (
                <button
                  style={{
                    background: 'none',
                    border: '1px dashed var(--border-color)',
                    borderRadius: '3px',
                    color: 'var(--text-tertiary)',
                    cursor: 'pointer',
                    fontSize: '11px',
                    padding: '1px 8px',
                  }}
                  title={`Assign animation clip for ${state}`}
                  onClick={() => handleAddClip(state)}
                >
                  + assign
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Error message */}
      {loadError && (
        <div style={{
          fontSize: '11px',
          color: '#e55',
          padding: '4px 6px',
          background: 'rgba(255,50,50,0.08)',
          borderRadius: '3px',
          marginTop: '2px',
        }}>
          {loadError}
        </div>
      )}

      {/* Loading indicator */}
      {isLoading && (
        <div style={{ fontSize: '11px', color: 'var(--accent-color)', marginTop: '2px' }}>
          Loading animation clip…
        </div>
      )}

      {/* Asset picker modal for animation clip selection */}
      <AssetPickerModal
        isOpen={showPicker}
        title={`Select Animation: ${targetState}`}
        filterType="model"
        filterCategory="animation"
        onSelect={handleAnimationSelected}
        onClose={() => setShowPicker(false)}
      />

      {/* All loaded clips listing */}
      {anim.clips.size > 0 && (
        <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '6px', marginTop: '2px' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
            Loaded Clips ({anim.clips.size})
          </div>
          {Array.from(anim.clips.entries()).map(([name, clip]) => (
            <div key={name} style={{ fontSize: '11px', color: 'var(--text-secondary)', padding: '1px 0' }}>
              <span style={{ color: 'var(--text-primary)' }}>{name}</span>
              {' — '}
              {clip.duration.toFixed(2)}s, {clip.channels.length} channels
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
