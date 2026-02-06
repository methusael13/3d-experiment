/**
 * GPURenderPipeline - Render pipeline wrapper for WebGPU
 * Simplifies render pipeline creation with sensible defaults
 */

import { GPUContext } from './GPUContext';
import { ShaderModuleManager } from './GPUShaderModule';

/** Primitive topology types */
export type PrimitiveTopology = 'point-list' | 'line-list' | 'line-strip' | 'triangle-list' | 'triangle-strip';

/** Cull mode types */
export type CullMode = 'none' | 'front' | 'back';

/** Front face winding */
export type FrontFace = 'ccw' | 'cw';

/** Depth compare functions */
export type DepthCompareFunction = 'never' | 'less' | 'equal' | 'less-equal' | 'greater' | 'not-equal' | 'greater-equal' | 'always';

/** Blend factor */
export type BlendFactor = 
  | 'zero' | 'one' 
  | 'src' | 'one-minus-src' 
  | 'src-alpha' | 'one-minus-src-alpha'
  | 'dst' | 'one-minus-dst'
  | 'dst-alpha' | 'one-minus-dst-alpha';

/** Blend operation */
export type BlendOperation = 'add' | 'subtract' | 'reverse-subtract' | 'min' | 'max';

/** Vertex attribute format */
export type VertexFormat = 
  | 'uint8x2' | 'uint8x4' | 'sint8x2' | 'sint8x4'
  | 'unorm8x2' | 'unorm8x4' | 'snorm8x2' | 'snorm8x4'
  | 'uint16x2' | 'uint16x4' | 'sint16x2' | 'sint16x4'
  | 'unorm16x2' | 'unorm16x4' | 'snorm16x2' | 'snorm16x4'
  | 'float16x2' | 'float16x4'
  | 'float32' | 'float32x2' | 'float32x3' | 'float32x4'
  | 'uint32' | 'uint32x2' | 'uint32x3' | 'uint32x4'
  | 'sint32' | 'sint32x2' | 'sint32x3' | 'sint32x4';

/** Vertex step mode */
export type VertexStepMode = 'vertex' | 'instance';

/** Simplified vertex attribute */
export interface VertexAttributeDesc {
  format: VertexFormat;
  offset: number;
  shaderLocation: number;
}

/** Simplified vertex buffer layout */
export interface VertexBufferLayoutDesc {
  arrayStride: number;
  stepMode?: VertexStepMode;
  attributes: VertexAttributeDesc[];
}

/** Simplified blend state */
export interface BlendStateDesc {
  color?: {
    srcFactor?: BlendFactor;
    dstFactor?: BlendFactor;
    operation?: BlendOperation;
  };
  alpha?: {
    srcFactor?: BlendFactor;
    dstFactor?: BlendFactor;
    operation?: BlendOperation;
  };
}

/** Render pipeline options */
export interface RenderPipelineOptions {
  label?: string;
  
  // Shaders
  vertexShader: string;
  fragmentShader?: string;
  vertexEntryPoint?: string;
  fragmentEntryPoint?: string;
  
  // Vertex layout
  vertexBuffers?: VertexBufferLayoutDesc[];
  
  // Pipeline layout
  bindGroupLayouts?: GPUBindGroupLayout[];
  
  // Primitive state
  topology?: PrimitiveTopology;
  cullMode?: CullMode;
  frontFace?: FrontFace;
  stripIndexFormat?: 'uint16' | 'uint32';
  
  // Depth/stencil
  depthFormat?: GPUTextureFormat;
  depthWriteEnabled?: boolean;
  depthCompare?: DepthCompareFunction;
  
  // Multisample
  sampleCount?: number;
  
  // Color targets
  colorFormats?: GPUTextureFormat[];
  blendStates?: (BlendStateDesc | null)[];
  writeMasks?: GPUColorWriteFlags[];
}

/**
 * Get the byte size of a vertex format
 */
export function getVertexFormatSize(format: VertexFormat): number {
  const sizes: Record<VertexFormat, number> = {
    'uint8x2': 2, 'uint8x4': 4, 'sint8x2': 2, 'sint8x4': 4,
    'unorm8x2': 2, 'unorm8x4': 4, 'snorm8x2': 2, 'snorm8x4': 4,
    'uint16x2': 4, 'uint16x4': 8, 'sint16x2': 4, 'sint16x4': 8,
    'unorm16x2': 4, 'unorm16x4': 8, 'snorm16x2': 4, 'snorm16x4': 8,
    'float16x2': 4, 'float16x4': 8,
    'float32': 4, 'float32x2': 8, 'float32x3': 12, 'float32x4': 16,
    'uint32': 4, 'uint32x2': 8, 'uint32x3': 12, 'uint32x4': 16,
    'sint32': 4, 'sint32x2': 8, 'sint32x3': 12, 'sint32x4': 16,
  };
  return sizes[format] || 4;
}

/**
 * Render pipeline wrapper
 */
export class RenderPipelineWrapper {
  private _pipeline: GPURenderPipeline;
  private _layout: GPUPipelineLayout;
  private _label: string;

  private constructor(
    pipeline: GPURenderPipeline,
    layout: GPUPipelineLayout,
    label: string
  ) {
    this._pipeline = pipeline;
    this._layout = layout;
    this._label = label;
  }

  /**
   * Create a render pipeline
   */
  static create(ctx: GPUContext, options: RenderPipelineOptions): RenderPipelineWrapper {
    const {
      label = 'render-pipeline',
      vertexShader,
      fragmentShader,
      vertexEntryPoint = 'vs_main',
      fragmentEntryPoint = 'fs_main',
      vertexBuffers = [],
      bindGroupLayouts = [],
      topology = 'triangle-list',
      cullMode = 'back',
      frontFace = 'ccw',
      stripIndexFormat,
      depthFormat,
      depthWriteEnabled = true,
      depthCompare = 'less',
      sampleCount = 1,
      colorFormats = [ctx.format],
      blendStates,
      writeMasks,
    } = options;

    // Create shader modules
    const vertexModule = ShaderModuleManager.getOrCreate(ctx, vertexShader, `${label}-vertex`);
    const fragmentModule = fragmentShader
      ? ShaderModuleManager.getOrCreate(ctx, fragmentShader, `${label}-fragment`)
      : vertexModule; // Combined shader

    // Create pipeline layout
    const layout = ctx.device.createPipelineLayout({
      label: `${label}-layout`,
      bindGroupLayouts,
    });

    // Build vertex buffer layouts
    const vertexBufferLayouts: GPUVertexBufferLayout[] = vertexBuffers.map((vb) => ({
      arrayStride: vb.arrayStride,
      stepMode: vb.stepMode || 'vertex',
      attributes: vb.attributes.map((attr) => ({
        format: attr.format,
        offset: attr.offset,
        shaderLocation: attr.shaderLocation,
      })),
    }));

    // Build color targets
    const colorTargets: GPUColorTargetState[] = colorFormats.map((format, i) => {
      const target: GPUColorTargetState = { format };
      
      if (blendStates && blendStates[i]) {
        const bs = blendStates[i]!;
        target.blend = {
          color: {
            srcFactor: bs.color?.srcFactor || 'one',
            dstFactor: bs.color?.dstFactor || 'zero',
            operation: bs.color?.operation || 'add',
          },
          alpha: {
            srcFactor: bs.alpha?.srcFactor || 'one',
            dstFactor: bs.alpha?.dstFactor || 'zero',
            operation: bs.alpha?.operation || 'add',
          },
        };
      }
      
      if (writeMasks && writeMasks[i] !== undefined) {
        target.writeMask = writeMasks[i];
      }
      
      return target;
    });

    // Create render pipeline
    const pipelineDescriptor: GPURenderPipelineDescriptor = {
      label,
      layout,
      vertex: {
        module: vertexModule,
        entryPoint: vertexEntryPoint,
        buffers: vertexBufferLayouts,
      },
      primitive: {
        topology,
        cullMode,
        frontFace,
        stripIndexFormat: topology.includes('strip') ? stripIndexFormat : undefined,
      },
      multisample: {
        count: sampleCount,
      },
    };

    // Add fragment stage if we have color targets
    if (colorTargets.length > 0) {
      pipelineDescriptor.fragment = {
        module: fragmentModule,
        entryPoint: fragmentEntryPoint,
        targets: colorTargets,
      };
    }

    // Add depth/stencil state (only if depthFormat is truthy and not explicitly disabled)
    // Note: depthFormat defaults to 'depth24plus', so pass undefined/null to disable
    if (depthFormat && depthFormat !== undefined) {
      pipelineDescriptor.depthStencil = {
        format: depthFormat,
        depthWriteEnabled,
        depthCompare,
      };
    }

    const pipeline = ctx.device.createRenderPipeline(pipelineDescriptor);

    return new RenderPipelineWrapper(pipeline, layout, label);
  }

  // Getters
  get pipeline(): GPURenderPipeline {
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
 * Common vertex buffer layouts
 */
export const CommonVertexLayouts = {
  /**
   * Position only (float32x3)
   */
  positionOnly(): VertexBufferLayoutDesc {
    return {
      arrayStride: 12,
      attributes: [
        { format: 'float32x3', offset: 0, shaderLocation: 0 },
      ],
    };
  },

  /**
   * Position (float32x3) + Normal (float32x3)
   */
  positionNormal(): VertexBufferLayoutDesc {
    return {
      arrayStride: 24,
      attributes: [
        { format: 'float32x3', offset: 0, shaderLocation: 0 },
        { format: 'float32x3', offset: 12, shaderLocation: 1 },
      ],
    };
  },

  /**
   * Position (float32x3) + Normal (float32x3) + UV (float32x2)
   */
  positionNormalUV(): VertexBufferLayoutDesc {
    return {
      arrayStride: 32,
      attributes: [
        { format: 'float32x3', offset: 0, shaderLocation: 0 },
        { format: 'float32x3', offset: 12, shaderLocation: 1 },
        { format: 'float32x2', offset: 24, shaderLocation: 2 },
      ],
    };
  },

  /**
   * Terrain grid vertex (float32x2 for XZ position)
   */
  terrainGrid(): VertexBufferLayoutDesc {
    return {
      arrayStride: 8,
      attributes: [
        { format: 'float32x2', offset: 0, shaderLocation: 0 },
      ],
    };
  },

  /**
   * Instance data for CDLOD terrain patches
   */
  terrainInstance(): VertexBufferLayoutDesc {
    return {
      arrayStride: 32, // worldOffset(8) + scale(4) + lodLevel(4) + morphFactor(4) + padding(12)
      stepMode: 'instance',
      attributes: [
        { format: 'float32x2', offset: 0, shaderLocation: 3 },  // worldOffset
        { format: 'float32', offset: 8, shaderLocation: 4 },    // scale
        { format: 'float32', offset: 12, shaderLocation: 5 },   // lodLevel
        { format: 'float32', offset: 16, shaderLocation: 6 },   // morphFactor
      ],
    };
  },
};

/**
 * Common blend states
 */
export const CommonBlendStates = {
  /**
   * Alpha blending
   */
  alpha(): BlendStateDesc {
    return {
      color: {
        srcFactor: 'src-alpha',
        dstFactor: 'one-minus-src-alpha',
        operation: 'add',
      },
      alpha: {
        srcFactor: 'one',
        dstFactor: 'one-minus-src-alpha',
        operation: 'add',
      },
    };
  },

  /**
   * Additive blending
   */
  additive(): BlendStateDesc {
    return {
      color: {
        srcFactor: 'one',
        dstFactor: 'one',
        operation: 'add',
      },
      alpha: {
        srcFactor: 'one',
        dstFactor: 'one',
        operation: 'add',
      },
    };
  },

  /**
   * Premultiplied alpha
   */
  premultiplied(): BlendStateDesc {
    return {
      color: {
        srcFactor: 'one',
        dstFactor: 'one-minus-src-alpha',
        operation: 'add',
      },
      alpha: {
        srcFactor: 'one',
        dstFactor: 'one-minus-src-alpha',
        operation: 'add',
      },
    };
  },

  /**
   * Water blending: normal alpha blend for color, but clears alpha proportionally to mark water pixels.
   * This allows visual opacity control while signaling to post-processing (SSAO) to skip these pixels.
   * 
   * Water shader outputs pre-multiplied RGB (color * opacity) with alpha = opacity.
   * 
   * Color blend: finalColor = srcRGB + dstRGB * (1 - srcAlpha)  → correct visual blending
   * Alpha blend: finalAlpha = 0 + dstAlpha * (1 - srcAlpha)     → clears alpha where water is opaque
   * 
   * Result: High opacity water → low alpha → SSAO skipped
   */
  waterMask(): BlendStateDesc {
    return {
      color: {
        // Premultiplied: src already multiplied by opacity, add to dest * (1-opacity)
        srcFactor: 'one',
        dstFactor: 'one-minus-src-alpha',
        operation: 'add',
      },
      alpha: {
        // Clear alpha proportionally: more opaque water = lower final alpha = skip SSAO
        srcFactor: 'zero',
        dstFactor: 'one-minus-src-alpha',
        operation: 'add',
      },
    };
  },
};
