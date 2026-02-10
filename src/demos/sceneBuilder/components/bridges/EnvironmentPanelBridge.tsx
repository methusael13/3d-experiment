/**
 * EnvironmentPanelBridge - Connects EnvironmentPanel Preact component to the store
 */

import { useMemo } from 'preact/hooks';
import { getSceneBuilderStore } from '../state';
import { EnvironmentPanel } from '../panels';
import { createPanelContext, type PanelContext } from '../../componentPanels/panelContext';
import { createObjectWindSettings } from '../../wind';

// ==================== Types ====================

export interface ConnectedEnvironmentPanelProps {
  // Optional external context override
  externalContext?: PanelContext;
}

// ==================== Connected Component ====================

export function ConnectedEnvironmentPanel({ externalContext }: ConnectedEnvironmentPanelProps = {}) {
  const store = getSceneBuilderStore();
  
  // Check if managers are available
  if (!store.lightingManager || !store.windManager || !store.scene) {
    return <div style={{ padding: '8px', color: 'var(--text-secondary)' }}>Loading...</div>;
  }
  
  // Create panel context if not provided externally
  const context = useMemo(() => {
    if (externalContext) return externalContext;
    
    // Create a minimal container for the context
    const container = document.createElement('div');
    
    return createPanelContext({
      container,
      scene: store.scene!,
      windManager: store.windManager!,
      lightingManager: store.lightingManager!,
      shadowRenderer: null,
      cameraController: null,
      objectWindSettings: store.objectWindSettings.value,
      
      // Wire up callbacks
      onLightingChanged: () => {
        if (store.lightingManager && store.viewport) {
          const params = store.lightingManager.getLightParams(null);
          store.viewport.setLightParams(params);
        }
      },
      setHDRTexture: (texture) => {
        // Todo
      },
      onWindChanged: () => {
        if (store.windManager && store.viewport) {
          store.viewport.setWindParams(store.windManager.getShaderUniforms());
        }
      },
      // Dynamic IBL callback - only provided in WebGPU mode
      onDynamicIBLChanged: store.isWebGPU.value ? (enabled: boolean) => {
        store.viewport?.setDynamicIBL?.(enabled);
      } : undefined,
    });
  }, [store.scene, store.windManager, store.lightingManager, store.isWebGPU.value, externalContext]);
  
  return (
    <EnvironmentPanel
      lightingManager={store.lightingManager}
      windManager={store.windManager}
      context={context}
    />
  );
}
