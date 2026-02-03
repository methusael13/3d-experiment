/**
 * TerrainPanelBridge - Connects TerrainPanel Preact component to the store
 * Gets terrain reference from the selected scene object (like legacy ObjectPanel)
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'preact/hooks';
import { useComputed } from '@preact/signals';
import { getSceneBuilderStore } from '../state';
import { TerrainPanel, TERRAIN_PRESETS, type NoiseParams, type ErosionParams, type MaterialParams as TerrainMaterialParams, type WaterParams, type DetailParams } from '../panels';
import { isGPUTerrainObject, isTerrainObject, type GPUTerrainSceneObject, type TerrainObject } from '../../../../core/sceneObjects';
import { debounce } from '../../../../core/utils/debounce';
import { TerrainManager } from '@/core/terrain';

// ==================== Default Parameter Sets ====================

const DEFAULT_NOISE_PARAMS: NoiseParams = {
  seed: 12345,
  offsetX: 0,
  offsetZ: 0,
  scale: 2.0,
  octaves: 6,
  lacunarity: 2.0,
  persistence: 0.5,
  heightScale: 100,
  ridgeWeight: 0.5,
  warpStrength: 0.5,
  warpScale: 2.0,
  warpOctaves: 2,
  rotateOctaves: true,
  octaveRotation: 37.5,
};

const DEFAULT_EROSION_PARAMS: ErosionParams = {
  hydraulicEnabled: true,
  hydraulicIterations: 50000,
  inertia: 0.05,
  sedimentCapacity: 4,
  depositSpeed: 0.3,
  erodeSpeed: 0.3,
  thermalEnabled: false,
  thermalIterations: 50,
  talusAngle: 0.5,
};

const DEFAULT_MATERIAL_PARAMS: TerrainMaterialParams = {
  snowLine: 0.7,
  rockLine: 0.4,
  maxGrassSlope: 0.6,
  grassColor: [0.2, 0.5, 0.1],
  rockColor: [0.4, 0.35, 0.3],
  snowColor: [0.95, 0.95, 0.97],
  dirtColor: [0.4, 0.3, 0.2],
};

const DEFAULT_WATER_PARAMS: WaterParams = {
  enabled: false,
  waterLevel: 0.2,
  waveHeight: 0.5,
  waveSpeed: 1.0,
  shallowColor: [0.1, 0.4, 0.5],
  deepColor: [0.0, 0.1, 0.3],
  depthFalloff: 0.1,
  opacity: 0.8,
};

const DEFAULT_DETAIL_PARAMS: DetailParams = {
  frequency: 0.5,
  amplitude: 0.5,
  octaves: 3,
  fadeStart: 50,
  fadeEnd: 200,
  slopeInfluence: 0.5,
};

// ==================== Helper Functions ====================

/** Convert UI noise params to TerrainManager noise config */
function buildNoiseConfig(params: NoiseParams) {
  return {
    seed: params.seed,
    offsetX: params.offsetX,
    offsetY: params.offsetZ, // Map Z to Y for WebGPU
    scaleX: params.scale,
    scaleY: params.scale,
    octaves: params.octaves,
    lacunarity: params.lacunarity,
    persistence: params.persistence,
    ridgeWeight: params.ridgeWeight,
    warpStrength: params.warpStrength,
    warpScale: params.warpScale,
    warpOctaves: params.warpOctaves,
    rotateOctaves: params.rotateOctaves,
    octaveRotation: params.octaveRotation,
  };
}

/** Convert UI erosion params to TerrainManager erosion config */
function buildErosionConfig(params: ErosionParams) {
  return {
    enableHydraulicErosion: params.hydraulicEnabled,
    hydraulicIterations: Math.ceil(params.hydraulicIterations / 10000),
    hydraulicParams: {
      inertia: params.inertia,
      sedimentCapacity: params.sedimentCapacity,
      depositionRate: params.depositSpeed,
      erosionRate: params.erodeSpeed,
    },
    enableThermalErosion: params.thermalEnabled,
    thermalIterations: params.thermalIterations,
    thermalParams: {
      talusAngle: params.talusAngle,
    },
  };
}

/** Convert UI material params to TerrainManager material config */
function buildMaterialConfig(params: TerrainMaterialParams) {
  return {
    snowLine: params.snowLine,
    rockLine: params.rockLine,
    maxGrassSlope: params.maxGrassSlope,
    grassColor: params.grassColor,
    rockColor: params.rockColor,
    snowColor: params.snowColor,
    dirtColor: params.dirtColor,
  };
}

// ==================== Types ====================

interface TerrainProgress {
  stage: string;
  percent: number;
}

export interface ConnectedTerrainPanelProps {
  onTerrainUpdate?: (params: {
    resolution: number;
    worldSize: number;
    noiseParams: NoiseParams;
    erosionParams: ErosionParams;
    materialParams: TerrainMaterialParams;
    waterParams?: WaterParams;
    detailParams?: DetailParams;
  }) => Promise<void>;
}

// ==================== Connected Component ====================

type GPUTerrainInfo = {
  type: 'webgpu',
  manager?: TerrainManager
};
type TerrainInfo = {
  type: 'webgl',
  terrainObject: TerrainObject
};
type SelectedTerrainInfo = GPUTerrainInfo | TerrainInfo | null;

export function ConnectedTerrainPanel({ 
  onTerrainUpdate,
}: ConnectedTerrainPanelProps = {}) {
  const store = getSceneBuilderStore();
  
  // Get terrain reference from selected scene object (like legacy ObjectPanel)
  const selectedTerrainInfo = useComputed<SelectedTerrainInfo>(() => {
    const selectedObj = store.firstSelectedObject.value;
    if (!selectedObj || !store.scene) return null;
    
    const sceneObj = store.scene.getObject(selectedObj.id);
    if (!sceneObj) return null;
    
    // Check for WebGPU terrain
    if (isGPUTerrainObject(sceneObj)) {
      const gpuTerrain = sceneObj as GPUTerrainSceneObject;
      const manager = gpuTerrain.getTerrainManager();
      return { type: 'webgpu', manager } as GPUTerrainInfo;
    }
    
    // Check for WebGL terrain
    if (isTerrainObject(sceneObj)) {
      return { type: 'webgl', terrainObject: sceneObj as TerrainObject } as TerrainInfo;
    }
    
    return null;
  });
  
  // Local state for terrain parameters
  const [resolution, setResolution] = useState(512);
  const [worldSize, setWorldSize] = useState(100);
  const [currentPreset, setCurrentPreset] = useState('default');
  
  const [noiseParams, setNoiseParams] = useState<NoiseParams>(DEFAULT_NOISE_PARAMS);
  const [erosionParams, setErosionParams] = useState<ErosionParams>(DEFAULT_EROSION_PARAMS);
  const [materialParams, setMaterialParams] = useState<TerrainMaterialParams>(DEFAULT_MATERIAL_PARAMS);
  const [waterParams, setWaterParams] = useState<WaterParams>(DEFAULT_WATER_PARAMS);
  const [detailParams, setDetailParams] = useState<DetailParams>(DEFAULT_DETAIL_PARAMS);
  
  // Rendering mode (WebGL only)
  const [cdlodEnabled, setCdlodEnabled] = useState(false);
  const [clipmapEnabled, setClipmapEnabled] = useState(false);
  
  // Progress state
  const [progress, setProgress] = useState<TerrainProgress | undefined>(undefined);
  
  // Refs to hold current values for debounced callbacks (avoids stale closures)
  const noiseParamsRef = useRef(noiseParams);
  const erosionParamsRef = useRef(erosionParams);
  const resolutionRef = useRef(resolution);
  const selectedTerrainInfoRef = useRef(selectedTerrainInfo);
  
  // Keep refs in sync with state
  noiseParamsRef.current = noiseParams;
  erosionParamsRef.current = erosionParams;
  resolutionRef.current = resolution;
  selectedTerrainInfoRef.current = selectedTerrainInfo;
  
  // Debounced full terrain regeneration - created once, uses refs for current values
  const debouncedFullRegen = useMemo(() => debounce(async () => {
    const terrainInfo = selectedTerrainInfoRef.current.value;
    if (terrainInfo?.type === 'webgpu' && terrainInfo.manager) {
      const manager = terrainInfo.manager;
      setProgress({ stage: 'Running erosion...', percent: 50 });
      
      await manager.regenerate({
        resolution: resolutionRef.current,
        noise: buildNoiseConfig(noiseParamsRef.current),
        ...buildErosionConfig(erosionParamsRef.current),
      }, (stage, percent) => setProgress({ stage, percent }));
      
      setProgress({ stage: 'Complete', percent: 100 });
      setTimeout(() => setProgress(undefined), 1000);
    }
  }, 500), []);  // Empty deps - created once on mount
  
  // Cleanup debounce timer on unmount only
  useEffect(() => () => debouncedFullRegen.cancel(), [debouncedFullRegen]);

  const handleTerrainBoundsChange = useCallback(() => {
    if (selectedTerrainInfoRef.current.value?.type === 'webgpu') {
      const radius = selectedTerrainInfoRef.current.value.manager?.getApproximateSceneRadius();
      if (radius) {
        store.viewport?.updateCameraForSceneBounds(radius);
      }
    }
  }, [store]);

  // Handlers
  const handleNoiseParamsChange = useCallback((changes: Partial<NoiseParams>) => {
    const updated = { ...noiseParamsRef.current, ...changes };
    setNoiseParams(updated);
    
    // Offset changes: immediate heightmap preview + debounced full regen
    if ('offsetX' in changes || 'offsetZ' in changes) {
      const terrainInfo = selectedTerrainInfoRef.current.value;
      if (terrainInfo?.type === 'webgpu' && terrainInfo.manager) {
        // Immediate: regenerate heightmap only (no erosion) for live preview
        terrainInfo.manager.regenerateHeightmapOnly?.(buildNoiseConfig(updated));
        // Debounced: full regeneration with erosion once slider stops
        debouncedFullRegen();
      }
    }

    if ('worldSize' in changes || 'heightScale' in changes) {
      handleTerrainBoundsChange();
    }
  }, [debouncedFullRegen, handleTerrainBoundsChange]);
  
  const handleErosionParamsChange = useCallback((changes: Partial<ErosionParams>) => {
    setErosionParams(prev => ({ ...prev, ...changes }));
  }, []);
  
  const handleMaterialParamsChange = useCallback((changes: Partial<TerrainMaterialParams>) => {
    setMaterialParams(prev => {
      const updated = { ...prev, ...changes };
      
      // Live update: immediately apply material changes to terrain
      const terrainInfo = selectedTerrainInfo.value;
      if (terrainInfo?.type === 'webgpu' && terrainInfo.manager) {
        terrainInfo.manager.setMaterial(buildMaterialConfig(updated));
      }
      
      return updated;
    });
  }, [selectedTerrainInfo]);
  
  const handleWaterParamsChange = useCallback((changes: Partial<WaterParams>) => {
    setWaterParams(prev => {
      const updated = { ...prev, ...changes };
      
      // Send water config to viewport if available
      if (store.viewport && 'setWebGPUWaterConfig' in store.viewport) {
        (store.viewport as any).setWebGPUWaterConfig(updated);
      }
      
      return updated;
    });
  }, [store.viewport]);
  
  const handleDetailParamsChange = useCallback((changes: Partial<DetailParams>) => {
    setDetailParams(prev => {
      const updated = { ...prev, ...changes };
      
      // Live update: immediately apply detail config to terrain
      const terrainInfo = selectedTerrainInfo.value;
      if (terrainInfo?.type === 'webgpu' && terrainInfo.manager) {
        terrainInfo.manager.setDetailConfig?.({
          frequency: updated.frequency,
          amplitude: updated.amplitude,
          octaves: updated.octaves,
          fadeStart: updated.fadeStart,
          fadeEnd: updated.fadeEnd,
          slopeInfluence: updated.slopeInfluence,
        });
      }
      
      return updated;
    });
  }, [selectedTerrainInfo]);
  
  const handlePresetChange = useCallback((presetKey: string) => {
    setCurrentPreset(presetKey);
    // Note: In a full implementation, this would load preset values
    // For now, we just track the preset name
  }, []);
  
  const handleResetToPreset = useCallback(() => {
    // Reset to default values for now
    setNoiseParams(DEFAULT_NOISE_PARAMS);
    setErosionParams(DEFAULT_EROSION_PARAMS);
    setMaterialParams(DEFAULT_MATERIAL_PARAMS);
    setWaterParams(DEFAULT_WATER_PARAMS);
    setDetailParams(DEFAULT_DETAIL_PARAMS);
  }, []);
  
  const handleUpdate = useCallback(async () => {
    setProgress({ stage: 'Starting...', percent: 0 });
    
    // Get terrain from selected object
    const terrainInfo = selectedTerrainInfo.value;
    
    try {
      // Use external callback if provided
      if (onTerrainUpdate) {
        await onTerrainUpdate({
          resolution,
          worldSize,
          noiseParams,
          erosionParams,
          materialParams,
          waterParams: store.isWebGPU.value ? waterParams : undefined,
          detailParams: store.isWebGPU.value ? detailParams : undefined,
        });
      }
      // WebGPU mode - use terrain manager from selected GPUTerrainSceneObject
      else if (terrainInfo?.type === 'webgpu' && terrainInfo.manager) {
        const manager = terrainInfo.manager;
        const progressCallback = (stage: string, percent: number) => {
          setProgress({ stage, percent });
        };
        
        // Map UI params to TerrainManager config format
        manager.setWorldSize(worldSize);
        manager.setHeightScale(noiseParams.heightScale);
        
        await manager.regenerate({
          resolution,
          noise: buildNoiseConfig(noiseParams),
          ...buildErosionConfig(erosionParams),
        }, progressCallback);
        
        // Update material
        manager.setMaterial(buildMaterialConfig(materialParams));
      }
      // WebGL mode - use terrain object from selected TerrainObject
      else if (terrainInfo?.type === 'webgl' && terrainInfo.terrainObject) {
        const terrain = terrainInfo.terrainObject;
        const progressCallback = (info: { progress: number; stage: string }) => {
          setProgress({ stage: info.stage, percent: Math.round(info.progress * 100) });
        };
        
        // Update terrain params
        const params = terrain.params;
        params.resolution = resolution;
        params.worldSize = worldSize;
        params.noise.seed = noiseParams.seed;
        params.noise.scale = noiseParams.scale;
        params.noise.octaves = noiseParams.octaves;
        params.noise.lacunarity = noiseParams.lacunarity;
        params.noise.persistence = noiseParams.persistence;
        params.noise.heightScale = noiseParams.heightScale;
        params.noise.ridgeWeight = noiseParams.ridgeWeight;
        params.noise.warpStrength = noiseParams.warpStrength;
        params.noise.warpScale = noiseParams.warpScale;
        params.noise.warpOctaves = noiseParams.warpOctaves;
        params.noise.rotateOctaves = noiseParams.rotateOctaves;
        params.noise.octaveRotation = noiseParams.octaveRotation;
        
        params.erosion.enabled = erosionParams.hydraulicEnabled;
        params.erosion.iterations = erosionParams.hydraulicIterations;
        params.erosion.inertia = erosionParams.inertia;
        params.erosion.sedimentCapacity = erosionParams.sedimentCapacity;
        params.erosion.depositSpeed = erosionParams.depositSpeed;
        params.erosion.erodeSpeed = erosionParams.erodeSpeed;
        params.erosion.thermalEnabled = erosionParams.thermalEnabled;
        params.erosion.thermalIterations = erosionParams.thermalIterations;
        params.erosion.talusAngle = erosionParams.talusAngle;
        
        params.material.snowLine = materialParams.snowLine;
        params.material.rockLine = materialParams.rockLine;
        params.material.maxGrassSlope = materialParams.maxGrassSlope;
        params.material.grassColor = materialParams.grassColor;
        params.material.rockColor = materialParams.rockColor;
        params.material.snowColor = materialParams.snowColor;
        params.material.dirtColor = materialParams.dirtColor;
        
        // Set rendering modes
        terrain.cdlodEnabled = cdlodEnabled;
        terrain.clipmapEnabled = clipmapEnabled;
        
        await terrain.regenerate(progressCallback);
      }
      else {
        console.warn('[TerrainPanel] No terrain selected - select a terrain object first');
      }
      
      setProgress({ stage: 'Complete', percent: 100 });
    } catch (error) {
      console.error('[TerrainPanel] Update failed:', error);
      setProgress({ stage: 'Error', percent: 0 });
    }
    
    // Clear progress after a delay
    setTimeout(() => setProgress(undefined), 2000);
  }, [onTerrainUpdate, selectedTerrainInfo, resolution, worldSize, noiseParams, erosionParams, materialParams, waterParams, detailParams, store.isWebGPU, cdlodEnabled, clipmapEnabled]);
  
  // Determine if a terrain is selected
  const hasTerrainSelected = selectedTerrainInfo.value !== null;
  
  return (
    <TerrainPanel
      hasTerrainSelected={hasTerrainSelected}
      resolution={resolution}
      onResolutionChange={setResolution}
      worldSize={worldSize}
      onWorldSizeChange={setWorldSize}
      noiseParams={noiseParams}
      onNoiseParamsChange={handleNoiseParamsChange}
      erosionParams={erosionParams}
      onErosionParamsChange={handleErosionParamsChange}
      materialParams={materialParams}
      onMaterialParamsChange={handleMaterialParamsChange}
      waterParams={store.isWebGPU.value ? waterParams : undefined}
      onWaterParamsChange={store.isWebGPU.value ? handleWaterParamsChange : undefined}
      detailParams={store.isWebGPU.value ? detailParams : undefined}
      onDetailParamsChange={store.isWebGPU.value ? handleDetailParamsChange : undefined}
      cdlodEnabled={cdlodEnabled}
      onCdlodEnabledChange={setCdlodEnabled}
      clipmapEnabled={clipmapEnabled}
      onClipmapEnabledChange={setClipmapEnabled}
      currentPreset={currentPreset}
      onPresetChange={handlePresetChange}
      onResetToPreset={handleResetToPreset}
      onUpdate={handleUpdate}
      progress={progress}
      isWebGPU={store.isWebGPU.value}
    />
  );
}
