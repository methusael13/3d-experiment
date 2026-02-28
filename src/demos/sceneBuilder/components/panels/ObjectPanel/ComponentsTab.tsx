import { useCallback, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { Entity } from '@/core/ecs/Entity';
import type { Component } from '@/core/ecs/Component';
import type { ComponentType } from '@/core/ecs/types';
import { LODComponent } from '@/core/ecs/components/LODComponent';
import { WetnessComponent } from '@/core/ecs/components/WetnessComponent';
import { WindComponent } from '@/core/ecs/components/WindComponent';
import { SSRComponent } from '@/core/ecs/components/SSRComponent';
import { ReflectionProbeComponent } from '@/core/ecs/components/ReflectionProbeComponent';
import type { DebugTextureManager } from '@/core/gpu/renderers/DebugTextureManager';
import { WetnessSubPanel } from './subpanels/WetnessSubPanel';
import { LODSubPanel } from './subpanels/LODSubPanel';
import { WindSubPanel } from './subpanels/WindSubPanel';
import { SSRSubPanel } from './subpanels/SSRSubPanel';
import { ReflectionProbeSubPanel } from './subpanels/ReflectionProbeSubPanel';
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
  create: () => Component;
  renderPanel: (entity: Entity, onChanged: () => void, debugTextureManager?: DebugTextureManager | null) => ComponentChildren;
}[] = [
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

export interface ComponentsTabProps {
  /** The selected entity (single selection only) */
  entity: Entity | null;
  /** List of component types currently on the entity */
  activeComponents: ComponentType[];
  /** Called after a component is added or removed (for store sync) */
  onChanged: () => void;
  /** Optional debug texture manager for probe face visualization */
  debugTextureManager?: DebugTextureManager | null;
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
}: ComponentsTabProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const handleAdd = useCallback(
    (type: ComponentType) => {
      if (!entity) return;
      const reg = OPTIONAL_COMPONENTS.find((r) => r.type === type);
      if (reg && !entity.hasComponent(type)) {
        entity.addComponent(reg.create());
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

  return (
    <div class={styles.container}>
      {/* "Add Component" dropdown */}
      {available.length > 0 && (
        <div class={styles.dropdown}>
          <button
            class={styles.addBtn}
            type="button"
            onClick={() => setDropdownOpen((o) => !o)}
          >
            + Add Component
          </button>
          {dropdownOpen && (
            <div class={styles.dropdownMenu}>
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

      {/* Per-component subpanels */}
      {attached.map((reg) => (
        <SubPanelCard
          key={reg.type}
          label={reg.label}
          onRemove={() => handleRemove(reg.type)}
        >
          {reg.renderPanel(entity, onChanged, debugTextureManager)}
        </SubPanelCard>
      ))}

      {attached.length === 0 && available.length === 0 && (
        <div class={styles.empty}>No optional components available</div>
      )}
    </div>
  );
}