/**
 * GPUComputePipeline - Compute pipeline wrapper for WebGPU
 * Simplifies compute shader setup and dispatch
 */

import { GPUContext } from './GPUContext';
import { ShaderModuleManager } from './GPUShaderModule';

/** Compute pipeline options */
export interface ComputePipelineOptions {
  label?: string;
  shader: string;
  entryPoint?: string;
  bindGroupLayouts?: GPUBindGroupLayout[];
}

/**
 * Compute pipeline wrapper
 */
export class ComputePipelineWrapper {
  private _pipeline: GPUComputePipeline;
  private _layout: GPUPipelineLayout;
  private _label: string;

  private constructor(
    pipeline: GPUComputePipeline,
    layout: GPUPipelineLayout,
    label: string
  ) {
    this._pipeline = pipeline;
    this._layout = layout;
    this._label = label;
  }

  /**
   * Create a compute pipeline
   */
  static create(ctx: GPUContext, options: ComputePipelineOptions): ComputePipelineWrapper {
    const {
      label = 'compute-pipeline',
      shader,
      entryPoint = 'main',
      bindGroupLayouts = [],
    } = options;

    // Create shader module
    const shaderModule = ShaderModuleManager.getOrCreate(ctx, shader, `${label}-shader`);

    // Create pipeline layout
    const layout = ctx.device.createPipelineLayout({
      label: `${label}-layout`,
      bindGroupLayouts,
    });

    // Create compute pipeline
    const pipeline = ctx.device.createComputePipeline({
      label,
      layout,
      compute: {
        module: shaderModule,
        entryPoint,
      },
    });

    return new ComputePipelineWrapper(pipeline, layout, label);
  }

  // Getters
  get pipeline(): GPUComputePipeline {
    return this._pipeline;
  }

  get layout(): GPUPipelineLayout {
    return this._layout;
  }

  get label(): string {
    return this._label;
  }
}

/**
 * Helper class for running compute passes
 */
export class ComputePassHelper {
  private ctx: GPUContext;

  constructor(ctx: GPUContext) {
    this.ctx = ctx;
  }

  /**
   * Run a compute shader with automatic command encoding and submission
   */
  dispatch(
    pipeline: ComputePipelineWrapper | GPUComputePipeline,
    bindGroups: GPUBindGroup[],
    workgroupCountX: number,
    workgroupCountY = 1,
    workgroupCountZ = 1,
    label = 'compute-pass'
  ): void {
    const encoder = this.ctx.device.createCommandEncoder({
      label: `${label}-encoder`,
    });

    const pass = encoder.beginComputePass({
      label,
    });

    const gpuPipeline = pipeline instanceof ComputePipelineWrapper ? pipeline.pipeline : pipeline;
    pass.setPipeline(gpuPipeline);

    for (let i = 0; i < bindGroups.length; i++) {
      pass.setBindGroup(i, bindGroups[i]);
    }

    pass.dispatchWorkgroups(workgroupCountX, workgroupCountY, workgroupCountZ);
    pass.end();

    this.ctx.queue.submit([encoder.finish()]);
  }

  /**
   * Create a command encoder for manual compute pass control
   */
  beginEncoder(label = 'compute'): GPUCommandEncoder {
    return this.ctx.device.createCommandEncoder({
      label: `${label}-encoder`,
    });
  }

  /**
   * Submit a command encoder
   */
  submit(encoder: GPUCommandEncoder): void {
    this.ctx.queue.submit([encoder.finish()]);
  }
}

/**
 * Calculate workgroup count for a given problem size
 */
export function calculateWorkgroupCount(
  problemSize: number,
  workgroupSize: number
): number {
  return Math.ceil(problemSize / workgroupSize);
}

/**
 * Calculate 2D workgroup counts for a given problem size
 */
export function calculateWorkgroupCount2D(
  width: number,
  height: number,
  workgroupSizeX: number,
  workgroupSizeY: number
): { x: number; y: number } {
  return {
    x: Math.ceil(width / workgroupSizeX),
    y: Math.ceil(height / workgroupSizeY),
  };
}

// Compute shader templates are now in separate .wgsl files
// Import from ShaderLoader for shader sources:
//   import { ShaderSources } from './ShaderLoader';
//
// Available compute shaders:
//   - ShaderSources.heightmapGeneration  (terrain/heightmap-generation.wgsl)
//   - ShaderSources.normalMapGeneration  (terrain/normal-map-generation.wgsl)
