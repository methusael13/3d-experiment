import { useState, useCallback, useRef } from 'preact/hooks';
import { Panel, Tabs, type Tab } from '../../ui';
import { LightingTab } from './LightingTab';
import { WindTab } from './WindTab';
import { HdrGallery } from './HdrGallery';
import { useEnvironmentStore } from './useEnvironmentStore';
import type { PanelContext } from '../../../componentPanels/panelContext';
import type { WindManager } from '../../../wind';
import type { World } from '@/core/ecs/World';

// Import CSS variables
import '../../styles/variables.css';

export interface EnvironmentPanelProps {
  windManager: WindManager;
  context: PanelContext;
  world?: World | null;
}

export function EnvironmentPanel({
  windManager,
  context,
  world,
}: EnvironmentPanelProps) {
  const store = useEnvironmentStore(windManager, context, world);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedHdrName, setSelectedHdrName] = useState<string | null>(null);

  // HDR loading handlers
  const handleLoadSelectedHdr = useCallback(async () => {
    if (!selectedHdrName || store.isLoadingHdr) return;
    // Todo: Need support for ECS based HDR light
  }, [selectedHdrName, store, context]);

  const handleFileUpload = useCallback(async (e: Event) => {
    // Todo
  }, [store, context]);

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // Build tab content
  const tabs: Tab[] = [
    {
      id: 'lighting',
      label: 'Lighting',
      content: (
          <LightingTab
            lightMode={store.lightMode}
            sunAzimuth={store.sunAzimuth}
            sunElevation={store.sunElevation}
            sunAmbient={store.sunAmbient}
            hdrExposure={store.hdrExposure}
            dynamicIBL={store.dynamicIBL}
            onLightModeChange={store.setLightMode}
            onSunAzimuthChange={store.setSunAzimuth}
            onSunElevationChange={store.setSunElevation}
            onSunAmbientChange={store.setSunAmbient}
            onHdrExposureChange={store.setHdrExposure}
            onDynamicIBLChange={context.onDynamicIBLChanged ? store.setDynamicIBL : undefined}
            hdrControls={
            <HdrGallery
              selectedHdrName={selectedHdrName}
              isLoading={store.isLoadingHdr}
              progress={store.hdrProgress}
              hdrFilename={store.hdrFilename}
              onSelectHdr={setSelectedHdrName}
              onLoadSelected={handleLoadSelectedHdr}
              onUploadClick={handleUploadClick}
            />
          }
        />
      ),
    },
    {
      id: 'wind',
      label: 'Wind',
      content: (
        <WindTab
          windEnabled={store.windEnabled}
          windDirection={store.windDirection}
          windStrength={store.windStrength}
          windTurbulence={store.windTurbulence}
          windGustStrength={store.windGustStrength}
          onWindEnabledChange={store.setWindEnabled}
          onWindDirectionChange={store.setWindDirection}
          onWindStrengthChange={store.setWindStrength}
          onWindTurbulenceChange={store.setWindTurbulence}
          onWindGustStrengthChange={store.setWindGustStrength}
        />
      ),
    },
  ];

  return (
    <Panel title="Environment">
      {/* Hidden file input for HDR upload */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".hdr"
        style={{ display: 'none' }}
        onChange={handleFileUpload}
      />

      <Tabs tabs={tabs} defaultTab="lighting" />
    </Panel>
  );
}
