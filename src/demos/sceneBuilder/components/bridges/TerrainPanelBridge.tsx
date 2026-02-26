/**
 * TerrainPanelBridge - Connects TerrainPanel Preact component to the store
 * Gets terrain reference from the selected scene object (like legacy ObjectPanel)
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'preact/hooks';
import { useComputed } from '@preact/signals';
import { getSceneBuilderStore } from '../state';
import { TerrainPanel, TERRAIN_PRESETS, type NoiseParams, type ErosionParams, type MaterialParams as TerrainMaterialParams, type DetailParams, type BiomeType, type BiomeTextureConfig } from '../panels';
import type { Asset } from '../hooks/useAssetLibrary';
import { BiomeMaskPanelBridge } from './BiomeMaskPanelBridge';
import { VegetationPanelBridge } from './VegetationPanelBridge';
import { TerrainComponent } from '@/core/ecs/components/TerrainComponent';
import { debounce } from '../../../../core/utils/debounce';
import { TerrainManager, TextureType } from '@/core/terrain';
import { AssetFile } from 'server/types';
import { BoundsComponent } from '@/core/ecs';

// ==================== Default Parameter Sets ====================

const DEFAULT_NOISE_PARAMS: NoiseParams = {
  seed: 12345,
  offsetX: 0,
  offsetZ: 0,
  scale: 2.0,
  octaves: 6,
  lacunarity: 2.0,
  persistence: 0.5,
  heightScale: 136,
  ridgeWeight: 0.5,
  warpStrength: 0.5,
  warpScale: 2.0,
  warpOctaves: 2,
  rotateOctaves: true,
  octaveRotation: 37.5,
  // Island mode (disabled by default)
  islandEnabled: false,
  islandRadius: 0.4,
  coastNoiseScale: 5,
  coastNoiseStrength: 0.2,
  coastFalloff: 0.3,
  seaFloorDepth: -0.3,
};

const DEFAULT_EROSION_PARAMS: ErosionParams = {
  hydraulicEnabled: true,
  hydraulicIterations: 300000,
  inertia: 0.05,
  sedimentCapacity: 4,
  depositSpeed: 0.3,
  erodeSpeed: 0.3,
  thermalEnabled: true,
  thermalIterations: 50,
  talusAngle: 0.5,
  showFlowMapDebug: false,
};

const DEFAULT_MATERIAL_PARAMS: TerrainMaterialParams = {
  // Primary biome colors (3 biomes: grass, rock, forest)
  grassColor: [0.2, 0.5, 0.1],
  rockColor: [0.4, 0.35, 0.3],
  forestColor: [0.35, 0.28, 0.18]
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
    // Island mode
    islandEnabled: params.islandEnabled,
    islandRadius: params.islandRadius,
    coastNoiseScale: params.coastNoiseScale,
    coastNoiseStrength: params.coastNoiseStrength,
    seaFloorDepth: params.seaFloorDepth,
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
    // Primary 3 biome colors
    grassColor: params.grassColor,
    rockColor: params.rockColor,
    forestColor: params.forestColor
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
    detailParams?: DetailParams;
  }) => Promise<void>;
}

// ==================== Connected Component ====================

type GPUTerrainInfo = {
  type: 'webgpu',
  manager?: TerrainManager
};
type SelectedTerrainInfo = GPUTerrainInfo | null;

export function ConnectedTerrainPanel({ 
  onTerrainUpdate,
}: ConnectedTerrainPanelProps = {}) {
  const store = getSceneBuilderStore();
  
  // Get terrain reference from selected entity's TerrainComponent
  const selectedTerrainInfo = useComputed<SelectedTerrainInfo>(() => {
    const entity = store.firstSelectedObject.value;
    if (!entity) return null;
    
    const terrainComp = entity.getComponent<TerrainComponent>('terrain');
    if (terrainComp) {
      return { type: 'webgpu', manager: terrainComp.manager } as GPUTerrainInfo;
    }
    
    return null;
  });
  
  // Local state for terrain parameters
  const [resolution, setResolution] = useState(1024);
  const [worldSize, setWorldSize] = useState(400);
  const [currentPreset, setCurrentPreset] = useState('default');
  
  const [noiseParams, setNoiseParams] = useState<NoiseParams>(DEFAULT_NOISE_PARAMS);
  const [erosionParams, setErosionParams] = useState<ErosionParams>(DEFAULT_EROSION_PARAMS);
  const [materialParams, setMaterialParams] = useState<TerrainMaterialParams>(DEFAULT_MATERIAL_PARAMS);
  const [detailParams, setDetailParams] = useState<DetailParams>(DEFAULT_DETAIL_PARAMS);
  
  // Progress state
  const [progress, setProgress] = useState<TerrainProgress | undefined>(undefined);
  
  // Biome texture configurations (per biome) - initialized in MaterialParams already
  // State is tracked via materialParams.{biome}Texture
  
  // Biome mask editor visibility
  const [biomeMaskEditorVisible, setBiomeMaskEditorVisible] = useState(false);
  
  // Vegetation editor visibility
  const [vegetationEditorVisible, setVegetationEditorVisible] = useState(false);
  
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
    // Recompute terrain worldBounds from updated config
    const entity = store.firstSelectedObject.value;
    if (entity) {
      const terrainComp = entity.getComponent?.('terrain') as TerrainComponent;
      const boundsComp = entity.getComponent?.('bounds') as BoundsComponent;
      if (terrainComp?.computeWorldBounds && boundsComp) {
        boundsComp.worldBounds = terrainComp.computeWorldBounds();
        boundsComp.dirty = false;
      }
    }
    // BoundsSystem callback will trigger camera update automatically
  }, [store]);

  // Handlers
  const handleNoiseParamsChange = useCallback((changes: Partial<NoiseParams>) => {
    const updated = { ...noiseParamsRef.current, ...changes };
    setNoiseParams(updated);
    
    const terrainInfo = selectedTerrainInfoRef.current.value;
    
    // Offset changes: immediate heightmap preview + debounced full regen
    if ('offsetX' in changes || 'offsetZ' in changes) {
      if (terrainInfo?.type === 'webgpu' && terrainInfo.manager) {
        // Immediate: regenerate heightmap only (no erosion) for live preview
        terrainInfo.manager.regenerateHeightmapOnly?.(buildNoiseConfig(updated));
        // Debounced: full regeneration with erosion once slider stops
        debouncedFullRegen();
      }
    }
    
    // Island mode toggle: instant (just enables/disables in shader)
    if ('islandEnabled' in changes) {
      if (terrainInfo?.type === 'webgpu' && terrainInfo.manager) {
        terrainInfo.manager.setIslandEnabled(updated.islandEnabled);
      }
    }
    
    // Sea floor depth: instant (uniform-only change)
    if ('seaFloorDepth' in changes) {
      if (terrainInfo?.type === 'webgpu' && terrainInfo.manager) {
        terrainInfo.manager.setSeaFloorDepth(updated.seaFloorDepth);
      }
    }

    // Island mask params: instant regeneration of mask texture only
    if (['islandRadius', 'coastNoiseScale', 'coastNoiseStrength', 'coastFalloff'].some(x => x in changes)) {
      if (terrainInfo?.type === 'webgpu' && terrainInfo.manager) {
        terrainInfo.manager.regenerateIslandMask({
          seed: updated.seed,
          islandRadius: updated.islandRadius,
          coastNoiseScale: updated.coastNoiseScale,
          coastNoiseStrength: updated.coastNoiseStrength,
          coastFalloff: updated.coastFalloff,
        });
      }
    }

    if ('worldSize' in changes || 'heightScale' in changes) {
      handleTerrainBoundsChange();
    }
  }, [debouncedFullRegen, handleTerrainBoundsChange]);
  
  const handleErosionParamsChange = useCallback((changes: Partial<ErosionParams>) => {
    setErosionParams(prev => {
      const updated = { ...prev, ...changes };
      
      // Handle flow map debug toggle
      if ('showFlowMapDebug' in changes) {
        const terrainInfo = selectedTerrainInfoRef.current.value;
        if (terrainInfo?.type === 'webgpu' && terrainInfo.manager) {
          const flowMap = terrainInfo.manager.getFlowMap();
          
          // Get debug texture manager from pipeline
          const viewport = store.viewport;
          const debugManager = viewport?.getDebugTextureManager?.();
          
          if (debugManager && flowMap) {
            // Register flow map if not already registered
            if (!debugManager.getRegisteredTextures().includes('flow-map')) {
              debugManager.register(
                'flow-map',
                'float',
                () => terrainInfo.manager?.getFlowMap()?.view ?? null,
                { colormap: 'grayscale-inverted' }  // Black flow on white background
              );
            }
            // Toggle visibility
            debugManager.setEnabled('flow-map', changes.showFlowMapDebug ?? false);
            
            console.log(
              `[TerrainPanel] Flow Map Debug ${changes.showFlowMapDebug ? 'enabled' : 'disabled'}`,
              `- Texture: ${flowMap.width}x${flowMap.height}`
            );
          } else if (!flowMap) {
            console.warn('[TerrainPanel] No flow map available - run hydraulic erosion first');
          }
        }
      }
      
      return updated;
    });
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
      } else {
        console.warn('[TerrainPanel] No terrain selected - select a terrain object first');
      }

      setProgress({ stage: 'Complete', percent: 100 });
    } catch (error) {
      console.error('[TerrainPanel] Update failed:', error);
      setProgress({ stage: 'Error', percent: 0 });
    }
    
    // Clear progress after a delay
    setTimeout(() => setProgress(undefined), 2000);
  }, [onTerrainUpdate, selectedTerrainInfo, resolution, worldSize, noiseParams, erosionParams, materialParams, detailParams, store.isWebGPU]);

  // Compute terrain state for VegetationSection
  const isTerrainReady = useMemo(() => {
    const terrainInfo = selectedTerrainInfo.value;
    return terrainInfo?.type === 'webgpu' && terrainInfo.manager?.isReady;
  }, [selectedTerrainInfo.value]);
  
  const hasFlowMap = useMemo(() => {
    const terrainInfo = selectedTerrainInfo.value;
    return terrainInfo?.type === 'webgpu' && terrainInfo.manager?.getFlowMap() != null;
  }, [selectedTerrainInfo.value]);
  
  const handleOpenBiomeMaskEditor = useCallback(() => {
    setBiomeMaskEditorVisible(true);
  }, []);
  
  const handleCloseBiomeMaskEditor = useCallback(() => {
    setBiomeMaskEditorVisible(false);
  }, []);
  
  const handleOpenVegetationEditor = useCallback(() => {
    setVegetationEditorVisible(true);
  }, []);
  
  const handleCloseVegetationEditor = useCallback(() => {
    setVegetationEditorVisible(false);
  }, []);
  
  // Handle biome texture selection from MaterialSection
  const handleBiomeTextureSelect = useCallback(async (
    biome: BiomeType,
    asset: Asset | null,
    tilingScale: number
  ) => {
    const terrainInfo = selectedTerrainInfo.value;
    if (terrainInfo?.type !== 'webgpu' || !terrainInfo.manager) {
      console.warn('[TerrainPanelBridge] Cannot set biome texture - no terrain manager');
      return;
    }

    const findAndSetTextureType = async (assetFiles: AssetFile[], type: TextureType) => {
      const texMap = assetFiles.find(f => f.fileSubType === type);
      if (texMap?.path) {
        const texUrl = texMap.path;
        console.log(`[TerrainPanelBridge] Loading ${biome} ${type} from ${texUrl}`);
        await manager.setBiomeTexture(biome, type, texUrl, tilingScale);
      }
    }
    
    const manager = terrainInfo.manager;
    
    if (asset) {
      // Find the basecolor/albedo texture URL from asset
      // Quixel assets have maps array with type: 'basecolor', 'normal', etc.
      const assetFiles = asset.files;
      
      // Get base path from asset
      const basePath = asset.path.substring(0, asset.path.lastIndexOf('/'));
      
      // Find basecolor/albedo map
      await findAndSetTextureType(assetFiles, 'albedo');
      // Find normal map
      await findAndSetTextureType(assetFiles, 'normal');
      // Find ao map
      await findAndSetTextureType(assetFiles, 'ao');
      
      // Update tiling
      manager.setBiomeTiling(biome, tilingScale);
    } else {
      // Clear the texture
      manager.clearBiomeTexture(biome, 'albedo');
      manager.clearBiomeTexture(biome, 'normal');
      manager.clearBiomeTexture(biome, 'ao');
    }
  }, [selectedTerrainInfo]);

  // Only render if terrain is selected
  if (selectedTerrainInfo.value === null) {
    return null;
  }
  
  return (
    <>
    <TerrainPanel
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
      detailParams={store.isWebGPU.value ? detailParams : undefined}
      onDetailParamsChange={store.isWebGPU.value ? handleDetailParamsChange : undefined}
      currentPreset={currentPreset}
      onPresetChange={handlePresetChange}
      onResetToPreset={handleResetToPreset}
      onUpdate={handleUpdate}
      progress={progress}
      isWebGPU={true}
      onOpenBiomeMaskEditor={handleOpenBiomeMaskEditor}
      onOpenPlantRegistry={handleOpenVegetationEditor}
      isTerrainReady={isTerrainReady}
      hasFlowMap={hasFlowMap}
      onBiomeTextureSelect={handleBiomeTextureSelect}
    />
    
    {/* Biome Mask Editor Dockable Window */}
    <BiomeMaskPanelBridge
      visible={biomeMaskEditorVisible}
      onClose={handleCloseBiomeMaskEditor}
      defaultPosition={{ x: 400, y: 100 }}
    />
    
    {/* Vegetation Editor Dockable Window */}
    <VegetationPanelBridge
      visible={vegetationEditorVisible}
      onClose={handleCloseVegetationEditor}
      defaultPosition={{ x: 450, y: 100 }}
    />
    </>
  );
}
