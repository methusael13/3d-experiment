/**
 * EnvironmentPanelBridge - Connects EnvironmentPanel to the store (ECS Step 3)
 * Wind is managed by WindSystem in ECS. Lighting via ECS LightComponent (LightingSystem).
 */

import { useMemo } from 'preact/hooks';
import { getSceneBuilderStore } from '../state';
import { EnvironmentPanel } from '../panels';
import { createPanelContext, type PanelContext } from '../../componentPanels/panelContext';
import type { WindSystem } from '@/core/ecs/systems/WindSystem';

// ==================== Types ====================

export interface ConnectedEnvironmentPanelProps {
  externalContext?: PanelContext;
}

/**
 * Get the WindManager from the ECS WindSystem.
 */
function getWindManagerFromWorld(store: ReturnType<typeof getSceneBuilderStore>) {
  const world = store.world;
  if (!world) return null;
  const windSystem = world.getSystem<WindSystem>('wind');
  return windSystem?.getWindManager() ?? null;
}

// ==================== Connected Component ====================

export function ConnectedEnvironmentPanel({ externalContext }: ConnectedEnvironmentPanelProps = {}) {
  const store = getSceneBuilderStore();
  
  if (!store.viewportInitialized.value) {
    return <div style={{ padding: '8px', color: 'var(--text-secondary)' }}>Loading...</div>;
  }
  
  // Get WindManager from ECS WindSystem
  const windManager = getWindManagerFromWorld(store);
  
  // Create panel context
  const context = useMemo(() => {
    if (externalContext) return externalContext;
    
    const container = document.createElement('div');
    const wm = getWindManagerFromWorld(store);
    
    return createPanelContext({
      container,
      windManager: wm!, // WindManager from ECS WindSystem
      cameraController: null,
      objectWindSettings: store.objectWindSettings.value,
      
      onLightingChanged: () => {
        // No-op: ECS LightComponent is now the single source of truth.
        // LightingSystem computes derived values each frame automatically.
      },
      setHDRTexture: (_texture) => {
        // TODO: HDR texture via ECS
      },
      onWindChanged: () => {
        // WindSystem updates automatically each frame; just sync wind params to viewport
        const wm = getWindManagerFromWorld(store);
        if (wm && store.viewport) {
          store.viewport.setWindParams(wm.getShaderUniforms());
        }
      },
      onDynamicIBLChanged: store.isWebGPU.value ? (enabled: boolean) => {
        store.viewport?.setDynamicIBL?.(enabled);
      } : undefined,
    });
  }, [store.isWebGPU.value, store.world, externalContext]);
  
  return (
    <EnvironmentPanel
      windManager={windManager!}
      context={context}
      world={store.world ?? null}
    />
  );
}
