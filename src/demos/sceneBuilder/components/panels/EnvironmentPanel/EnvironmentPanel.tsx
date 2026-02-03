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
import { TONE_MAPPING, TONE_MAPPING_NAMES } from '../../../../../core/sceneObjects/lights';

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

      const buffer = await response.arrayBuffer();
      const hdrData = HDRLoader.parse(buffer);

      const result = HDRLoader.createPrefilteredTextureWithMIS(
        context.gl,
        hdrData,
        (progress) => {
          store.setHdrProgress(0.1 + progress * 0.9);
        }
      );

      lightingManager.hdrLight.setTexture(result.texture, `${selectedHdrName}.hdr`);
      store.setHdrFilename(selectedHdrName);

      context.setHDRTexture(result.texture);
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
      const hdrData = HDRLoader.parse(buffer);

      const result = HDRLoader.createPrefilteredTextureWithMIS(
        context.gl,
        hdrData,
        (progress) => {
          store.setHdrProgress(progress);
        }
      );

      lightingManager.hdrLight.setTexture(result.texture, file.name);
      store.setHdrFilename(file.name);

      context.setHDRTexture(result.texture);
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

  const handleToneMappingChange = useCallback((value: string) => {
    store.setToneMapping(value);
    lightingManager.toneMapping = (TONE_MAPPING_NAMES as any)[value] ?? TONE_MAPPING.ACES;
    context.onLightingChanged();
  }, [store, lightingManager, context]);

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
          toneMapping={store.toneMapping}
          onLightModeChange={store.setLightMode}
          onSunAzimuthChange={store.setSunAzimuth}
          onSunElevationChange={store.setSunElevation}
          onSunAmbientChange={store.setSunAmbient}
          onHdrExposureChange={store.setHdrExposure}
          onToneMappingChange={handleToneMappingChange}
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
          windDebug={store.windDebug}
          onWindEnabledChange={store.setWindEnabled}
          onWindDirectionChange={store.setWindDirection}
          onWindStrengthChange={store.setWindStrength}
          onWindTurbulenceChange={store.setWindTurbulence}
          onWindGustStrengthChange={store.setWindGustStrength}
          onWindDebugChange={store.setWindDebug}
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
