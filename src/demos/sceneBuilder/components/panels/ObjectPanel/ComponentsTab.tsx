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
import { TransformComponent } from '@/core/ecs/components/TransformComponent';
import { FPSCameraComponent } from '@/core/ecs/components/FPSCameraComponent';
import type { DebugTextureManager } from '@/core/gpu/renderers/DebugTextureManager';
import type { ShadowRendererGPU } from '@/core/gpu/renderers/ShadowRendererGPU';
import { WetnessSubPanel } from './subpanels/WetnessSubPanel';
import { LODSubPanel } from './subpanels/LODSubPanel';
import { WindSubPanel } from './subpanels/WindSubPanel';
import { SSRSubPanel } from './subpanels/SSRSubPanel';
import { ReflectionProbeSubPanel } from './subpanels/ReflectionProbeSubPanel';
import { LightSubPanel } from './subpanels/LightSubPanel';
import { FPSCameraSubPanel } from './subpanels/FPSCameraSubPanel';
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
    type: 'fps-camera',
    label: 'FPS Camera',
    description: 'First-person camera controller (WASD + mouse look)',
    dependencies: ['transform'],
    create: () => {
      const cam = new FPSCameraComponent();
      cam.active = true;
      return cam;
    },
    renderPanel: (entity, onChanged) => (
      <FPSCameraSubPanel entity={entity} onChanged={onChanged} />
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
        // Singleton enforcement for FPS Camera: deactivate others
        if (type === 'fps-camera') {
          const world = (window as any).__ecsWorld; // fallback — ideally passed via props
          // Deactivate other FPS camera components in the world
          if (entity) {
            // We only have access to the current entity; full world singleton
            // enforcement happens in FPSCameraSystem.enter()
          }
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
      {attached.filter(reg => reg.renderPanel).map((reg) => (
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
    </div>
  );
}