/**
 * ErosionSimulator - GPU-based erosion simulation
 * 
 * Orchestrates hydraulic and thermal erosion passes using compute shaders.
 * Uses ping-pong textures for iterative simulation.
 */

import {
  GPUContext,
  UnifiedGPUBuffer,
  UnifiedGPUTexture,
  ComputePipelineWrapper,
  BindGroupLayoutBuilder,
  BindGroupBuilder,
  calculateWorkgroupCount2D,
} from '../gpu';

// Import shader sources
import hydraulicErosionShader from '../gpu/shaders/terrain/hydraulic-erosion.wgsl?raw';
import thermalErosionShader from '../gpu/shaders/terrain/thermal-erosion.wgsl?raw';

/**
 * Hydraulic erosion parameters
 */
export interface HydraulicErosionParams {
  /** How much droplet keeps its direction (0-1) */
  inertia: number;
  /** Max sediment a droplet can carry per unit water */
  sedimentCapacity: number;
  /** Minimum sediment capacity */
  minCapacity: number;
  /** How quickly terrain erodes */
  erosionRate: number;
  /** How quickly sediment deposits */
  depositionRate: number;
  /** Water evaporation per step */
  evaporationRate: number;
  /** Acceleration due to gravity */
  gravity: number;
  /** Minimum slope for erosion */
  minSlope: number;
  /** Maximum steps per droplet */
  maxDropletLifetime: number;
  /** Erosion brush radius */
  brushRadius: number;
  /** Droplets per iteration */
  dropletsPerIteration: number;
  /** Height scale for erosion strength (world-space terrain height) */
  heightScale: number;
}

/**
 * Thermal erosion parameters
 */
export interface ThermalErosionParams {
  /** Maximum stable slope angle (tangent) */
  talusAngle: number;
  /** How much material moves per iteration */
  erosionRate: number;
  /** Iterations per dispatch */
  iterationsPerDispatch: number;
}

/**
 * Default hydraulic erosion parameters
 */
export function createDefaultHydraulicParams(): HydraulicErosionParams {
  return {
    inertia: 0.05,
    sedimentCapacity: 4.0,
    minCapacity: 0.01,
    erosionRate: 0.3,
    depositionRate: 0.3,
    evaporationRate: 0.01,
    gravity: 4.0,
    minSlope: 0.01,
    maxDropletLifetime: 30,
    brushRadius: 3,
    dropletsPerIteration: 10000,
    heightScale: 50.0, // Default terrain height scale
  };
}

/**
 * Default thermal erosion parameters
 */
export function createDefaultThermalParams(): ThermalErosionParams {
  return {
    talusAngle: 0.7, // ~35 degrees
    erosionRate: 0.5,
    iterationsPerDispatch: 1,
  };
}

/**
 * ErosionSimulator - Manages erosion compute passes
 */
export class ErosionSimulator {
  private ctx: GPUContext;
  private resolution: number;
  
  // Ping-pong textures
  private heightmapA: UnifiedGPUTexture | null = null;
  private heightmapB: UnifiedGPUTexture | null = null;
  private currentTexture: 'A' | 'B' = 'A';
  
  // Storage buffer for hydraulic erosion (parallel writes)
  private erosionMapBuffer: UnifiedGPUBuffer | null = null;
  
  // Hydraulic erosion pipelines
  private hydraulicInitPipeline: ComputePipelineWrapper | null = null;
  private hydraulicSimulatePipeline: ComputePipelineWrapper | null = null;
  private hydraulicFinalizePipeline: ComputePipelineWrapper | null = null;
  private hydraulicBindGroupLayout: GPUBindGroupLayout | null = null;
  private hydraulicParamsBuffer: UnifiedGPUBuffer | null = null;
  
  // Thermal erosion pipeline
  private thermalPipeline: ComputePipelineWrapper | null = null;
  private thermalBindGroupLayout: GPUBindGroupLayout | null = null;
  private thermalParamsBuffer: UnifiedGPUBuffer | null = null;
  
  // Iteration tracking
  private hydraulicIterationCount = 0;
  private thermalIterationCount = 0;
  
  constructor(ctx: GPUContext) {
    this.ctx = ctx;
    this.resolution = 0;
  }
  
  /**
   * Initialize the simulator with a source heightmap
   */
  initialize(sourceHeightmap: UnifiedGPUTexture): void {
    this.resolution = sourceHeightmap.width;
    
    // Create ping-pong textures
    this.heightmapA = UnifiedGPUTexture.create2D(this.ctx, {
      label: 'erosion-heightmap-A',
      width: this.resolution,
      height: this.resolution,
      format: 'r32float',
      storage: true,
      sampled: true,
      copySrc: true,
      copyDst: true,
    });
    
    this.heightmapB = UnifiedGPUTexture.create2D(this.ctx, {
      label: 'erosion-heightmap-B',
      width: this.resolution,
      height: this.resolution,
      format: 'r32float',
      storage: true,
      sampled: true,
      copySrc: true,
      copyDst: true,
    });
    
    // Copy source heightmap to A
    const encoder = this.ctx.device.createCommandEncoder();
    encoder.copyTextureToTexture(
      { texture: sourceHeightmap.texture },
      { texture: this.heightmapA.texture },
      [this.resolution, this.resolution, 1]
    );
    this.ctx.queue.submit([encoder.finish()]);
    
    this.currentTexture = 'A';
    
    // Create erosion map storage buffer
    const bufferSize = this.resolution * this.resolution * 4; // float32 per texel
    this.erosionMapBuffer = UnifiedGPUBuffer.createStorage(this.ctx, {
      label: 'erosion-map-buffer',
      size: bufferSize,
    });
    
    // Initialize pipelines
    this.initializeHydraulicPipeline();
    this.initializeThermalPipeline();
  }
  
  /**
   * Initialize hydraulic erosion pipelines
   */
  private initializeHydraulicPipeline(): void {
    // Bind group layout for hydraulic erosion
    this.hydraulicBindGroupLayout = new BindGroupLayoutBuilder('hydraulic-erosion-layout')
      .uniformBuffer(0, 'compute')
      .texture(1, 'compute', 'unfilterable-float')
      .storageTexture(2, 'r32float', 'compute', 'write-only')
      .storageBufferRW(3, 'compute')
      .build(this.ctx);
    
    // Create pipelines for each entry point
    this.hydraulicInitPipeline = ComputePipelineWrapper.create(this.ctx, {
      label: 'hydraulic-init-pipeline',
      shader: hydraulicErosionShader,
      entryPoint: 'initErosionMap',
      bindGroupLayouts: [this.hydraulicBindGroupLayout],
    });
    
    this.hydraulicSimulatePipeline = ComputePipelineWrapper.create(this.ctx, {
      label: 'hydraulic-simulate-pipeline',
      shader: hydraulicErosionShader,
      entryPoint: 'simulateDroplets',
      bindGroupLayouts: [this.hydraulicBindGroupLayout],
    });
    
    this.hydraulicFinalizePipeline = ComputePipelineWrapper.create(this.ctx, {
      label: 'hydraulic-finalize-pipeline',
      shader: hydraulicErosionShader,
      entryPoint: 'finalizeErosion',
      bindGroupLayouts: [this.hydraulicBindGroupLayout],
    });
    
    // Uniform buffer (64 bytes for ErosionParams struct)
    this.hydraulicParamsBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'hydraulic-params-buffer',
      size: 64,
    });
  }
  
  /**
   * Initialize thermal erosion pipeline
   */
  private initializeThermalPipeline(): void {
    // Bind group layout for thermal erosion
    this.thermalBindGroupLayout = new BindGroupLayoutBuilder('thermal-erosion-layout')
      .uniformBuffer(0, 'compute')
      .texture(1, 'compute', 'unfilterable-float')
      .storageTexture(2, 'r32float', 'compute', 'write-only')
      .build(this.ctx);
    
    this.thermalPipeline = ComputePipelineWrapper.create(this.ctx, {
      label: 'thermal-erosion-pipeline',
      shader: thermalErosionShader,
      entryPoint: 'mainPingPong',
      bindGroupLayouts: [this.thermalBindGroupLayout],
    });
    
    // Uniform buffer (16 bytes for ThermalParams struct)
    this.thermalParamsBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'thermal-params-buffer',
      size: 16,
    });
  }
  
  /**
   * Run hydraulic erosion for specified number of iterations
   */
  applyHydraulicErosion(
    iterations: number,
    params: Partial<HydraulicErosionParams> = {}
  ): void {
    if (!this.hydraulicInitPipeline || !this.hydraulicSimulatePipeline ||
        !this.hydraulicFinalizePipeline || !this.hydraulicBindGroupLayout) {
      console.warn('Hydraulic erosion not initialized');
      return;
    }
    
    const fullParams = { ...createDefaultHydraulicParams(), ...params };
    
    // Resolution-independent scaling:
    // Base resolution is 1024 - scale parameters for consistent world-space results
    const resScale = this.resolution / 1024;
    const resScaleSquared = resScale ** 2;
    
    // Droplet count: scale by resolution² (same density per world area)
    const scaledDropletCount = Math.floor(fullParams.dropletsPerIteration * resScaleSquared);
    
    // Lifetime: scale by resolution (droplet travels same world distance)
    // At 4K, each step is 4x smaller in world space, so need 4x more steps
    const scaledLifetime = Math.floor(fullParams.maxDropletLifetime * resScale);
    
    // Erosion/Deposition rates: scale by resolution
    // deltaHeight per texel-step is ~resScale times smaller at higher res
    // Multiply rates to compensate
    const scaledErosionRate = fullParams.erosionRate * resScale;
    const scaledDepositionRate = fullParams.depositionRate * resScale;
    
    // Update params buffer
    const paramsData = new Float32Array([
      fullParams.inertia,
      fullParams.sedimentCapacity,
      fullParams.minCapacity,
      scaledErosionRate,      // Scaled erosion rate
      scaledDepositionRate,   // Scaled deposition rate
      fullParams.evaporationRate,
      fullParams.gravity,
      fullParams.minSlope,
    ]);
    const paramsDataUint = new Uint32Array([
      this.resolution,
      scaledLifetime,         // Scaled lifetime
      scaledDropletCount,     // Scaled droplet count
    ]);
    const seedData = new Float32Array([
      this.hydraulicIterationCount, // Use iteration count as seed
    ]);
    const brushData = new Int32Array([
      fullParams.brushRadius,
    ]);
    
    // Create combined buffer (must match ErosionParams struct layout)
    const combinedBuffer = new ArrayBuffer(64);
    const floatView = new Float32Array(combinedBuffer);
    const uintView = new Uint32Array(combinedBuffer);
    const intView = new Int32Array(combinedBuffer);
    
    // Copy data to combined buffer
    // Must match ErosionParams struct layout in hydraulic-erosion.wgsl:
    // offset 0-7: f32 params (inertia, sedimentCapacity, minCapacity, erosionRate, depositionRate, evaporationRate, gravity, minSlope)
    // offset 8-10: u32 params (mapSize, maxDropletLifetime, dropletCount)
    // offset 11: f32 seed
    // offset 12: i32 brushRadius
    // offset 13: f32 heightScale
    // offset 14-15: padding
    floatView.set(paramsData, 0); // offset 0-7
    uintView.set(paramsDataUint, 8); // offset 8-10
    floatView[11] = seedData[0]; // offset 11
    intView[12] = brushData[0]; // offset 12
    floatView[13] = fullParams.heightScale; // offset 13 - NEW
    // padding at 14-15
    
    this.hydraulicParamsBuffer!.write(this.ctx, new Float32Array(combinedBuffer));
    
    const sourceHeightmap = this.currentTexture === 'A' ? this.heightmapA! : this.heightmapB!;
    const targetHeightmap = this.currentTexture === 'A' ? this.heightmapB! : this.heightmapA!;
    
    for (let i = 0; i < iterations; i++) {
      // Update seed for each iteration
      floatView[11] = this.hydraulicIterationCount + i;
      this.hydraulicParamsBuffer!.write(this.ctx, new Float32Array(combinedBuffer));
      
      // Create bind group
      const bindGroup = new BindGroupBuilder('hydraulic-bind-group')
        .buffer(0, this.hydraulicParamsBuffer!)
        .texture(1, sourceHeightmap)
        .texture(2, targetHeightmap)
        .buffer(3, this.erosionMapBuffer!)
        .build(this.ctx, this.hydraulicBindGroupLayout);
      
      const encoder = this.ctx.device.createCommandEncoder({
        label: 'hydraulic-erosion-encoder',
      });
      
      // Step 1: Initialize erosion map
      const initPass = encoder.beginComputePass({ label: 'hydraulic-init-pass' });
      initPass.setPipeline(this.hydraulicInitPipeline.pipeline);
      initPass.setBindGroup(0, bindGroup);
      const initWorkgroups = calculateWorkgroupCount2D(this.resolution, this.resolution, 8, 8);
      initPass.dispatchWorkgroups(initWorkgroups.x, initWorkgroups.y);
      initPass.end();
      
      // Step 2: Simulate droplets
      const simPass = encoder.beginComputePass({ label: 'hydraulic-simulate-pass' });
      simPass.setPipeline(this.hydraulicSimulatePipeline.pipeline);
      simPass.setBindGroup(0, bindGroup);
      const dropletWorkgroups = Math.ceil(scaledDropletCount / 64);  // Use scaled count
      simPass.dispatchWorkgroups(dropletWorkgroups);
      simPass.end();
      
      // Step 3: Finalize - write erosion map back to texture
      const finalPass = encoder.beginComputePass({ label: 'hydraulic-finalize-pass' });
      finalPass.setPipeline(this.hydraulicFinalizePipeline.pipeline);
      finalPass.setBindGroup(0, bindGroup);
      finalPass.dispatchWorkgroups(initWorkgroups.x, initWorkgroups.y);
      finalPass.end();
      
      this.ctx.queue.submit([encoder.finish()]);
      
      // Swap textures
      this.currentTexture = this.currentTexture === 'A' ? 'B' : 'A';
    }
    
    this.hydraulicIterationCount += iterations;
  }
  
  /**
   * Run thermal erosion for specified number of iterations
   */
  applyThermalErosion(
    iterations: number,
    params: Partial<ThermalErosionParams> = {}
  ): void {
    if (!this.thermalPipeline || !this.thermalBindGroupLayout) {
      console.warn('Thermal erosion not initialized');
      return;
    }
    
    const fullParams = { ...createDefaultThermalParams(), ...params };
    
    for (let i = 0; i < iterations; i++) {
      // Update params buffer
      const paramsData = new Float32Array([
        fullParams.talusAngle,
        fullParams.erosionRate,
      ]);
      const paramsDataUint = new Uint32Array([
        fullParams.iterationsPerDispatch,
        this.resolution,
      ]);
      
      // Create combined buffer (must match ThermalParams struct layout)
      const combinedBuffer = new ArrayBuffer(16);
      const floatView = new Float32Array(combinedBuffer);
      const uintView = new Uint32Array(combinedBuffer);
      
      floatView[0] = paramsData[0];
      floatView[1] = paramsData[1];
      uintView[2] = paramsDataUint[0];
      uintView[3] = paramsDataUint[1];
      
      this.thermalParamsBuffer!.write(this.ctx, new Float32Array(combinedBuffer));
      
      const sourceHeightmap = this.currentTexture === 'A' ? this.heightmapA! : this.heightmapB!;
      const targetHeightmap = this.currentTexture === 'A' ? this.heightmapB! : this.heightmapA!;
      
      // Create bind group
      const bindGroup = new BindGroupBuilder('thermal-bind-group')
        .buffer(0, this.thermalParamsBuffer!)
        .texture(1, sourceHeightmap)
        .texture(2, targetHeightmap)
        .build(this.ctx, this.thermalBindGroupLayout);
      
      // Dispatch compute
      const encoder = this.ctx.device.createCommandEncoder({
        label: 'thermal-erosion-encoder',
      });
      
      const pass = encoder.beginComputePass({ label: 'thermal-erosion-pass' });
      pass.setPipeline(this.thermalPipeline.pipeline);
      pass.setBindGroup(0, bindGroup);
      const workgroups = calculateWorkgroupCount2D(this.resolution, this.resolution, 8, 8);
      pass.dispatchWorkgroups(workgroups.x, workgroups.y);
      pass.end();
      
      this.ctx.queue.submit([encoder.finish()]);
      
      // Swap textures
      this.currentTexture = this.currentTexture === 'A' ? 'B' : 'A';
    }
    
    this.thermalIterationCount += iterations;
  }
  
  /**
   * Get the current heightmap result
   */
  getResultHeightmap(): UnifiedGPUTexture | null {
    return this.currentTexture === 'A' ? this.heightmapA : this.heightmapB;
  }
  
  /**
   * Get iteration counts
   */
  getIterationCounts(): { hydraulic: number; thermal: number } {
    return {
      hydraulic: this.hydraulicIterationCount,
      thermal: this.thermalIterationCount,
    };
  }
  
  /**
   * Reset iteration counts
   */
  resetIterationCounts(): void {
    this.hydraulicIterationCount = 0;
    this.thermalIterationCount = 0;
  }
  
  /**
   * Clean up GPU resources
   */
  destroy(): void {
    this.heightmapA?.destroy();
    this.heightmapB?.destroy();
    this.erosionMapBuffer?.destroy();
    this.hydraulicParamsBuffer?.destroy();
    this.thermalParamsBuffer?.destroy();
    
    this.heightmapA = null;
    this.heightmapB = null;
    this.erosionMapBuffer = null;
    this.hydraulicInitPipeline = null;
    this.hydraulicSimulatePipeline = null;
    this.hydraulicFinalizePipeline = null;
    this.thermalPipeline = null;
    this.hydraulicParamsBuffer = null;
    this.thermalParamsBuffer = null;
  }
}
