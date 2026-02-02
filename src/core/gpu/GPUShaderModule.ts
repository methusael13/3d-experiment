/**
 * GPUShaderModule - WGSL shader compilation and management
 * Provides caching and error handling for shader modules
 */

import { GPUContext } from './GPUContext';

/** Shader compilation result */
export interface ShaderCompilationResult {
  module: GPUShaderModule;
  compilationInfo?: GPUCompilationInfo;
  hasErrors: boolean;
  hasWarnings: boolean;
}

/**
 * Simple hash function for shader source caching
 */
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString(36);
}

/**
 * Shader module manager with caching and compilation utilities
 */
export class ShaderModuleManager {
  private static cache = new Map<string, GPUShaderModule>();

  /**
   * Create or retrieve a cached shader module
   */
  static getOrCreate(ctx: GPUContext, code: string, label?: string): GPUShaderModule {
    const hash = hashString(code);
    
    if (this.cache.has(hash)) {
      return this.cache.get(hash)!;
    }

    const module = ctx.device.createShaderModule({
      code,
      label: label || `shader-${hash}`,
    });

    this.cache.set(hash, module);
    return module;
  }

  /**
   * Create a shader module with compilation info
   */
  static async createWithInfo(
    ctx: GPUContext,
    code: string,
    label?: string
  ): Promise<ShaderCompilationResult> {
    const module = ctx.device.createShaderModule({
      code,
      label: label || 'shader',
    });

    // Get compilation info if available
    let compilationInfo: GPUCompilationInfo | undefined;
    let hasErrors = false;
    let hasWarnings = false;

    try {
      compilationInfo = await module.getCompilationInfo();
      
      for (const message of compilationInfo.messages) {
        if (message.type === 'error') {
          hasErrors = true;
          console.error(`[Shader Error] ${message.message}`, {
            lineNum: message.lineNum,
            linePos: message.linePos,
          });
        } else if (message.type === 'warning') {
          hasWarnings = true;
          console.warn(`[Shader Warning] ${message.message}`, {
            lineNum: message.lineNum,
            linePos: message.linePos,
          });
        }
      }
    } catch {
      // Some browsers may not support getCompilationInfo
    }

    return {
      module,
      compilationInfo,
      hasErrors,
      hasWarnings,
    };
  }

  /**
   * Clear the shader cache
   */
  static clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  static getCacheStats(): { size: number } {
    return { size: this.cache.size };
  }
}

/**
 * WGSL shader builder for common patterns
 */
export class WGSLBuilder {
  private code: string[] = [];

  /**
   * Add a struct definition
   */
  struct(name: string, fields: Record<string, string>): this {
    this.code.push(`struct ${name} {`);
    for (const [fieldName, fieldType] of Object.entries(fields)) {
      this.code.push(`  ${fieldName}: ${fieldType},`);
    }
    this.code.push('}\n');
    return this;
  }

  /**
   * Add a uniform binding
   */
  uniformBinding(group: number, binding: number, name: string, type: string): this {
    this.code.push(`@group(${group}) @binding(${binding}) var<uniform> ${name}: ${type};`);
    return this;
  }

  /**
   * Add a storage binding (read-only)
   */
  storageBinding(group: number, binding: number, name: string, type: string): this {
    this.code.push(`@group(${group}) @binding(${binding}) var<storage, read> ${name}: ${type};`);
    return this;
  }

  /**
   * Add a storage binding (read-write)
   */
  storageBindingRW(group: number, binding: number, name: string, type: string): this {
    this.code.push(`@group(${group}) @binding(${binding}) var<storage, read_write> ${name}: ${type};`);
    return this;
  }

  /**
   * Add a texture binding
   */
  textureBinding(group: number, binding: number, name: string, type = 'texture_2d<f32>'): this {
    this.code.push(`@group(${group}) @binding(${binding}) var ${name}: ${type};`);
    return this;
  }

  /**
   * Add a storage texture binding
   */
  storageTextureBinding(
    group: number,
    binding: number,
    name: string,
    format: string,
    access: 'read' | 'write' | 'read_write' = 'write'
  ): this {
    this.code.push(`@group(${group}) @binding(${binding}) var ${name}: texture_storage_2d<${format}, ${access}>;`);
    return this;
  }

  /**
   * Add a sampler binding
   */
  samplerBinding(group: number, binding: number, name: string, comparison = false): this {
    const samplerType = comparison ? 'sampler_comparison' : 'sampler';
    this.code.push(`@group(${group}) @binding(${binding}) var ${name}: ${samplerType};`);
    return this;
  }

  /**
   * Add raw WGSL code
   */
  raw(wgsl: string): this {
    this.code.push(wgsl);
    return this;
  }

  /**
   * Add a newline
   */
  newline(): this {
    this.code.push('');
    return this;
  }

  /**
   * Build the final WGSL code
   */
  build(): string {
    return this.code.join('\n');
  }

  /**
   * Reset the builder
   */
  reset(): this {
    this.code = [];
    return this;
  }
}

// Shader snippets are now in separate .wgsl files
// Import from ShaderLoader for shader sources:
//   import { ShaderSources } from './ShaderLoader';
//
// Available shaders:
//   - ShaderSources.uniforms       (common/uniforms.wgsl)
//   - ShaderSources.terrainNoise   (terrain/noise.wgsl)
//   - ShaderSources.terrainCDLOD   (terrain/cdlod.wgsl)
//   - ShaderSources.testTriangle   (test-triangle.wgsl)
