import { useCallback, useState, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { Entity } from '@/core/ecs/Entity';
import type { Component } from '@/core/ecs/Component';
import type { ComponentType } from '@/core/ecs/types';
import { LODComponent } from '@/core/ecs/components/LODComponent';
import { WetnessComponent } from '@/core/ecs/components/WetnessComponent';
import { WindComponent } from '@/core/ecs/components/WindComponent';
import { SSRComponent } from '@/core/ecs/components/SSRComponent';
import { ReflectionProbeComponent } from '@/core/ecs/components/ReflectionProbeComponent';
import { TransformComponent } from '@/core/ecs/components/TransformComponent';
import { PlayerComponent } from '@/core/ecs/components/PlayerComponent';
import { CameraComponent } from '@/core/ecs/components/CameraComponent';
import type { DebugTextureManager } from '@/core/gpu/renderers/DebugTextureManager';
import type { ShadowRendererGPU } from '@/core/gpu/renderers/ShadowRendererGPU';
import { CharacterControllerBridge } from '../../bridges/CharacterControllerBridge';
import { WetnessSubPanel } from './subpanels/WetnessSubPanel';
import { LODSubPanel } from './subpanels/LODSubPanel';
import { WindSubPanel } from './subpanels/WindSubPanel';
import { SSRSubPanel } from './subpanels/SSRSubPanel';
import { ReflectionProbeSubPanel } from './subpanels/ReflectionProbeSubPanel';
import { LightSubPanel } from './subpanels/LightSubPanel';
import { PlayerSubPanel } from './subpanels/PlayerSubPanel';
import { CameraSubPanel } from './subpanels/CameraSubPanel';
import { AnimationSubPanel } from './subpanels/AnimationSubPanel';
import styles from './ComponentsTab.module.css';

/**
 * Registry of optional components that can be added/removed by the user.
 * Each entry defines the component type, a display label, a description,
 * a factory function to create a new instance, and a subpanel renderer.
 */
export const OPTIONAL_COMPONENTS: {
  type: ComponentType;
  label: string;
  description: string;
  /** Component types that must be present — auto-added if missing */
  dependencies?: ComponentType[];
  create: () => Component;
  renderPanel?: (entity: Entity, onChanged: () => void, debugTextureManager?: DebugTextureManager | null) => ComponentChildren;
}[] = [
  {
    type: 'transform',
    label: 'Transform',
    description: 'Position, rotation, and scale in world space',
    create: () => new TransformComponent(),
    // No sub-panel — the existing Properties tab shows transform fields
  },
  {
    type: 'player',
    label: 'Player',
    description: 'First-person player controller (WASD + mouse look)',
    dependencies: ['transform'],
    create: () => {
      const player = new PlayerComponent();
      player.active = true;
      return player;
    },
    // renderPanel is set dynamically in ComponentsTab to inject onEditController
  },
  {
    type: 'camera',
    label: 'Camera',
    description: 'Camera projection (FOV, near/far, view matrices)',
    dependencies: ['transform'],
    create: () => new CameraComponent(),
    renderPanel: (entity, onChanged) => (
      <CameraSubPanel entity={entity} onChanged={onChanged} />
    ),
  },
  {
    type: 'lod',
    label: 'LOD (Level of Detail)',
    description: 'Distance-based LOD for quality scaling',
    create: () => new LODComponent(),
    renderPanel: (entity, onChanged) => (
      <LODSubPanel entity={entity} onChanged={onChanged} />
    ),
  },
  {
    type: 'wetness',
    label: 'Wetness',
    description: 'Water interaction & wet surface darkening',
    create: () => new WetnessComponent(),
    renderPanel: (entity, onChanged) => (
      <WetnessSubPanel entity={entity} onChanged={onChanged} />
    ),
  },
  {
    type: 'wind',
    label: 'Wind',
    description: 'Vegetation wind animation (sway & flutter)',
    create: () => new WindComponent(),
    renderPanel: (entity, onChanged) => (
      <WindSubPanel entity={entity} onChanged={onChanged} />
    ),
  },
  {
    type: 'ssr',
    label: 'Screen Space Reflections',
    description: 'Per-object SSR for metallic surfaces (LOD 0 only)',
    create: () => new SSRComponent(),
    renderPanel: (entity, onChanged) => (
      <SSRSubPanel entity={entity} onChanged={onChanged} />
    ),
  },
  {
    type: 'reflection-probe',
    label: 'Reflection Probe',
    description: 'Baked cubemap probe for metallic reflections (replaces SSR)',
    create: () => new ReflectionProbeComponent(),
    renderPanel: (entity, onChanged, debugTextureManager) => (
      <ReflectionProbeSubPanel entity={entity} onChanged={onChanged} debugTextureManager={debugTextureManager} />
    ),
  },
];

/**
 * Intrinsic component types that show their subpanel automatically when present
 * but cannot be added/removed by the user (they are part of the entity's identity).
 */
export const INTRINSIC_COMPONENT_PANELS: {
  type: ComponentType;
  label: string;
  renderPanel: (entity: Entity, onChanged: () => void, debugTextureManager?: DebugTextureManager | null, shadowRenderer?: ShadowRendererGPU | null) => ComponentChildren;
}[] = [
  {
    type: 'light',
    label: 'Light Properties',
    renderPanel: (entity, onChanged, debugTextureManager, shadowRenderer) => (
      <LightSubPanel entity={entity} onChanged={onChanged} debugTextureManager={debugTextureManager} shadowRenderer={shadowRenderer} />
    ),
  },
  {
    type: 'skeleton',
    label: 'Animation',
    renderPanel: (entity, onChanged) => (
      <AnimationSubPanel entity={entity} onChanged={onChanged} />
    ),
  },
];

export interface ComponentsTabProps {
  /** The selected entity (single selection only) */
  entity: Entity | null;
  /** List of component types currently on the entity */
  activeComponents: ComponentType[];
  /** Called after a component is added or removed (for store sync) */
  onChanged: () => void;
  /** Optional debug texture manager for probe face visualization */
  debugTextureManager?: DebugTextureManager | null;
  /** Optional shadow renderer for shadow map debug visualization */
  shadowRenderer?: ShadowRendererGPU | null;
}

// ---------- internal: collapsible subpanel wrapper ----------

interface SubPanelCardProps {
  label: string;
  onRemove: () => void;
  children: ComponentChildren;
}

function SubPanelCard({ label, onRemove, children }: SubPanelCardProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div class={styles.subpanel}>
      <div
        class={styles.subpanelHeader}
        onClick={() => setCollapsed((p) => !p)}
      >
        <span class={styles.subpanelArrow}>{collapsed ? '▶' : '▼'}</span>
        <span class={styles.subpanelTitle}>{label}</span>
        <button
          class={styles.removeBtn}
          title="Remove component"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          ✕
        </button>
      </div>
      {!collapsed && <div class={styles.subpanelBody}>{children}</div>}
    </div>
  );
}

// ---------- main ComponentsTab ----------

export function ComponentsTab({
  entity,
  activeComponents,
  onChanged,
  debugTextureManager,
  shadowRenderer,
}: ComponentsTabProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Character Controller Graph editor state
  const [ccEditorEntity, setCcEditorEntity] = useState<Entity | null>(null);
  const [ccEditorOpen, setCcEditorOpen] = useState(false);

  const handleEditController = useCallback((ent: Entity) => {
    setCcEditorEntity(ent);
    setCcEditorOpen(true);
  }, []);

  const handleCloseController = useCallback(() => {
    setCcEditorOpen(false);
  }, []);

  const toggleDropdown = useCallback(() => {
    if (dropdownOpen) {
      setDropdownOpen(false);
      return;
    }
    // Compute position from button rect for fixed-position dropdown
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom + 2, left: rect.left, width: rect.width });
    }
    setDropdownOpen(true);
  }, [dropdownOpen]);

  const handleAdd = useCallback(
    (type: ComponentType) => {
      if (!entity) return;
      const reg = OPTIONAL_COMPONENTS.find((r) => r.type === type);
      if (reg && !entity.hasComponent(type)) {
        // Auto-add dependencies first
        if (reg.dependencies) {
          for (const dep of reg.dependencies) {
            if (!entity.hasComponent(dep)) {
              const depReg = OPTIONAL_COMPONENTS.find((r) => r.type === dep);
              if (depReg) {
                entity.addComponent(depReg.create());
              }
            }
          }
        }
        // Add the requested component
        entity.addComponent(reg.create());
        // When adding player, also auto-add camera if not present (common composition)
        if (type === 'player' && !entity.hasComponent('camera')) {
          entity.addComponent(new CameraComponent());
        }
      }
      setDropdownOpen(false);
      onChanged();
    },
    [entity, onChanged]
  );

  const handleRemove = useCallback(
    (type: ComponentType) => {
      if (!entity) return;
      entity.removeComponent(type);
      onChanged();
    },
    [entity, onChanged]
  );

  if (!entity) {
    return <div class={styles.empty}>No entity selected</div>;
  }

  // Components available to add (not yet on entity)
  const available = OPTIONAL_COMPONENTS.filter(
    (r) => !activeComponents.includes(r.type)
  );

  // Components currently on entity that have a subpanel
  const attached = OPTIONAL_COMPONENTS.filter((r) =>
    activeComponents.includes(r.type)
  );

    // Intrinsic component panels (light, etc.) — shown but not removable
    const intrinsic = INTRINSIC_COMPONENT_PANELS.filter((r) =>
      activeComponents.includes(r.type)
    );

    return (
    <div class={styles.container}>
      {/* Intrinsic component panels (non-removable, e.g., Light) */}
      {intrinsic.map((reg) => (
        <div key={reg.type} class={styles.subpanel}>
          <div class={styles.subpanelHeader}>
            <span class={styles.subpanelTitle}>{reg.label}</span>
          </div>
          <div class={styles.subpanelBody}>
            {reg.renderPanel(entity, onChanged, debugTextureManager, shadowRenderer)}
          </div>
        </div>
      ))}

      {/* "Add Component" dropdown */}
      {available.length > 0 && (
        <div class={styles.dropdown}>
          <button
            ref={btnRef}
            class={styles.addBtn}
            type="button"
            onClick={toggleDropdown}
          >
            + Add Component
          </button>
          {dropdownOpen && dropdownPos && (
            <div
              class={styles.dropdownMenu}
              style={{
                position: 'fixed',
                top: dropdownPos.top,
                left: dropdownPos.left,
                width: dropdownPos.width,
              }}
            >
              {available.map((reg) => (
                <button
                  key={reg.type}
                  class={styles.dropdownItem}
                  type="button"
                  onClick={() => handleAdd(reg.type)}
                >
                  <span>{reg.label}</span>
                  <span class={styles.dropdownItemDesc}>
                    {reg.description}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Player subpanel — rendered with onEditController injected */}
      {activeComponents.includes('player') && (
        <SubPanelCard
          key="player"
          label="Player"
          onRemove={() => handleRemove('player')}
        >
          <PlayerSubPanel entity={entity} onChanged={onChanged} onEditController={handleEditController} />
        </SubPanelCard>
      )}

      {/* Per-component subpanels (excluding player, handled above) */}
      {attached.filter(reg => reg.renderPanel && reg.type !== 'player').map((reg) => (
        <SubPanelCard
          key={reg.type}
          label={reg.label}
          onRemove={() => handleRemove(reg.type)}
        >
          {reg.renderPanel!(entity, onChanged, debugTextureManager)}
        </SubPanelCard>
      ))}

      {attached.length === 0 && available.length === 0 && (
        <div class={styles.empty}>No optional components available</div>
      )}

      {/* Character Controller Graph Editor (DockableWindow) */}
      <CharacterControllerBridge
        entity={ccEditorEntity}
        isOpen={ccEditorOpen}
        onClose={handleCloseController}
      />
    </div>
  );
}