/**
 * CharacterControllerBridge — Connects the Character Controller Node Editor
 * UI to the ECS entity's CharacterControllerComponent.
 *
 * Opens the node graph editor in a DockableWindow when triggered from
 * the PlayerSubPanel's "Edit Controller" button.
 */

import { useState, useCallback, useMemo } from 'preact/hooks';
import type { Entity } from '@/core/ecs/Entity';
import { CharacterControllerComponent } from '@/core/ecs/components/CharacterControllerComponent';
import { CharacterControllerGraphEvaluator } from '@/core/animation/CharacterControllerGraphEvaluator';
import { DockableWindow } from '../ui/DockableWindow/DockableWindow';
import { CharacterControllerNodeEditor } from '../panels/CharacterControllerPanel/CharacterControllerNodeEditor';

export interface CharacterControllerBridgeProps {
  entity: Entity | null;
  isOpen: boolean;
  onClose: () => void;
}

export function CharacterControllerBridge({ entity, isOpen, onClose }: CharacterControllerBridgeProps) {
  if (!isOpen || !entity) return null;

  // Ensure CharacterControllerComponent exists on the entity
  let cc = entity.getComponent<CharacterControllerComponent>('character-controller');
  if (!cc) {
    cc = entity.addComponent(new CharacterControllerComponent());
  }

  // Create evaluator (memoized per entity)
  const evaluator = useMemo(() => new CharacterControllerGraphEvaluator(), []);

  return (
    <DockableWindow
      id="character-controller-editor"
      title="Character Controller"
      icon="🎮"
      defaultSize={{ width: 800, height: 500 }}
      minSize={{ width: 600, height: 350 }}
      onClose={onClose}
    >
      <CharacterControllerNodeEditor
        entity={entity}
        evaluator={evaluator}
      />
    </DockableWindow>
  );
}
