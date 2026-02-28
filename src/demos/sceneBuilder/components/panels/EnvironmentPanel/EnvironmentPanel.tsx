import { useState, useCallback, useRef } from 'preact/hooks';
import { Panel, Tabs, type Tab } from '../../ui';
import { LightingTab } from './LightingTab';
import { WindTab } from './WindTab';
import { HdrGallery } from './HdrGallery';
import { useEnvironmentStore } from './useEnvironmentStore';
import type { PanelContext } from '../../../componentPanels/panelContext';
import type { LightingManager } from '../../../lightingManager';
import type { WindManager } from '../../../wind';
import { HDRLoader } from '../../../../../loaders';

// Import CSS variables
import '../../styles/variables.css';

export interface EnvironmentPanelProps {
  lightingManager: LightingManager;
  windManager: WindManager;
  context: PanelContext;
}

export function EnvironmentPanel({
  lightingManager,
  windManager,
  context,
}: EnvironmentPanelProps) {
  const store = useEnvironmentStore(lightingManager, windManager, context);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedHdrName, setSelectedHdrName] = useState<string | null>(null);

  // HDR loading handlers
  const handleLoadSelectedHdr = useCallback(async () => {
    if (!selectedHdrName || store.isLoadingHdr) return;

    store.setIsLoadingHdr(true);
    store.setHdrProgress(0);

    try {
      const hdrPath = `/ibl/${selectedHdrName}.hdr`;
      store.setHdrFilename('Loading...');

      const response = await fetch(hdrPath);
      if (!response.ok) throw new Error(`Failed to fetch ${hdrPath}`);

      // Todo: Need support for HDR loader with WebGPU textures
      const buffer = await response.arrayBuffer();
      const hdrData = HDRLoader.parse(buffer);

      lightingManager.hdrLight.setTexture(null, `${selectedHdrName}.hdr`);
      store.setHdrFilename(selectedHdrName);

      context.setHDRTexture(null);
      store.setLightMode('hdr');
    } catch (err) {
      console.error('Failed to load HDR:', err);
      store.setHdrFilename('Error loading HDR');
    } finally {
      store.setIsLoadingHdr(false);
    }
  }, [selectedHdrName, store, context, lightingManager]);

  const handleFileUpload = useCallback(async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;

    store.setIsLoadingHdr(true);
    store.setHdrProgress(0);

    try {
      store.setHdrFilename('Loading...');

      const buffer = await file.arrayBuffer();

      // Todo: Need support for HDR loader with WebGPU textures
      const hdrData = HDRLoader.parse(buffer);

      lightingManager.hdrLight.setTexture(null, file.name);
      store.setHdrFilename(file.name);

      context.setHDRTexture(null);
      store.setLightMode('hdr');
    } catch (err) {
      console.error('Failed to load HDR:', err);
      store.setHdrFilename('Error loading HDR');
    } finally {
      store.setIsLoadingHdr(false);
    }
  }, [store, context, lightingManager]);

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
