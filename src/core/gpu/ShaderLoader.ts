/**
 * ShaderLoader - Utility for loading WGSL shader files
 * Uses Vite's ?raw import to load shader source code
 */

import { GPUContext } from './GPUContext';

// Import shader files as raw strings using Vite's ?raw suffix
// These are loaded at build time

// Common shaders
import uniformsWGSL from './shaders/common/uniforms.wgsl?raw';

// Terrain shaders - rendering
import noiseWGSL from './shaders/terrain/noise.wgsl?raw';
import cdlodWGSL from './shaders/terrain/cdlod.wgsl?raw';

// Terrain shaders - compute
import heightmapGenerationWGSL from './shaders/terrain/heightmap-generation.wgsl?raw';
import normalMapGenerationWGSL from './shaders/terrain/normal-map-generation.wgsl?raw';

// Test shaders
import testTriangleWGSL from './shaders/test-triangle.wgsl?raw';

/**
 * Available shader sources
 */
export const ShaderSources = {
  // Common
  uniforms: uniformsWGSL,
  
  // Terrain - rendering
  terrainNoise: noiseWGSL,
  terrainCDLOD: cdlodWGSL,
  
  // Terrain - compute
  heightmapGeneration: heightmapGenerationWGSL,
  normalMapGeneration: normalMapGenerationWGSL,
  
  // Test
  testTriangle: testTriangleWGSL,
} as const;

export type ShaderName = keyof typeof ShaderSources;

/**
 * Shader cache for compiled modules
 */
const shaderCache = new Map<string, GPUShaderModule>();

/**
 * Load and compile a shader module
 */
export function loadShader(ctx: GPUContext, name: ShaderName, label?: string): GPUShaderModule {
  const cacheKey = name;
  
  if (shaderCache.has(cacheKey)) {
    return shaderCache.get(cacheKey)!;
  }
  
  const source = ShaderSources[name];
  if (!source) {
    throw new Error(`Shader "${name}" not found`);
  }
  
  const module = ctx.device.createShaderModule({
    code: source,
    label: label || name,
  });
  
  shaderCache.set(cacheKey, module);
  return module;
}

/**
 * Load a shader from raw WGSL source string
 */
export function loadShaderFromSource(
  ctx: GPUContext,
  source: string,
  label?: string
): GPUShaderModule {
  return ctx.device.createShaderModule({
    code: source,
    label: label || 'custom-shader',
  });
}

/**
 * Combine multiple shader sources (for includes/modules)
 */
export function combineShaderSources(...sources: string[]): string {
  return sources.join('\n\n');
}

/**
 * Clear the shader cache
 */
export function clearShaderCache(): void {
  shaderCache.clear();
}

/**
 * Get shader source by name (for debugging/inspection)
 */
export function getShaderSource(name: ShaderName): string {
  const source = ShaderSources[name];
  if (!source) {
    throw new Error(`Shader "${name}" not found`);
  }
  return source;
}

/**
 * Check if a shader is cached
 */
export function isShaderCached(name: ShaderName): boolean {
  return shaderCache.has(name);
}
