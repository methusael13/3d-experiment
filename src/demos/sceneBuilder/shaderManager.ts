/**
 * Shader Manager
 * Central registry for live shader editing and hot-reloading
 */

// ==================== Types ====================

export type ShaderType = 'vertex' | 'fragment';

export interface ShaderConfig {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  vsSource: string;
  fsSource: string;
  onRecompile?: (program: WebGLProgram) => void;
}

interface ShaderEntry {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  originalVsSource: string;
  currentVsSource: string;
  originalFsSource: string;
  currentFsSource: string;
  onRecompile?: (program: WebGLProgram) => void;
}

export interface CompileResult {
  success: boolean;
  error: string | null;
}

export interface ApplyAllResult {
  successes: number;
  failures: Array<{ name: string; error: string }>;
}

// ==================== Global Registry ====================

const shaderRegistry = new Map<string, ShaderEntry>();

// ==================== Registry Functions ====================

/**
 * Register a shader with the manager
 */
export function registerShader(name: string, config: ShaderConfig): void {
  shaderRegistry.set(name, {
    gl: config.gl,
    program: config.program,
    originalVsSource: config.vsSource,
    currentVsSource: config.vsSource,
    originalFsSource: config.fsSource,
    currentFsSource: config.fsSource,
    onRecompile: config.onRecompile,
  });
}

/**
 * Unregister a shader
 */
export function unregisterShader(name: string): void {
  shaderRegistry.delete(name);
}

/**
 * Get list of all registered shader names
 */
export function getShaderList(): string[] {
  return Array.from(shaderRegistry.keys());
}

/**
 * Get current fragment shader source for a shader
 */
export function getShaderSource(name: string, type: ShaderType = 'fragment'): string | null {
  const entry = shaderRegistry.get(name);
  if (!entry) return null;
  return type === 'vertex' ? entry.currentVsSource : entry.currentFsSource;
}

/**
 * Get original shader source (for reset)
 */
export function getOriginalSource(name: string, type: ShaderType = 'fragment'): string | null {
  const entry = shaderRegistry.get(name);
  if (!entry) return null;
  return type === 'vertex' ? entry.originalVsSource : entry.originalFsSource;
}

// ==================== Compilation ====================

interface ShaderCompileResult {
  success: boolean;
  error: string | null;
  shader: WebGLShader | null;
}

/**
 * Compile a shader from source
 */
function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string
): ShaderCompileResult {
  const shader = gl.createShader(type);
  if (!shader) {
    return { success: false, error: 'Failed to create shader', shader: null };
  }
  
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    return { success: false, error, shader: null };
  }
  
  return { success: true, error: null, shader };
}

/**
 * Compile and link a program with given VS and FS sources
 */
function compileAndLinkProgram(
  gl: WebGL2RenderingContext,
  vsSource: string,
  fsSource: string
): { success: boolean; error: string | null; program: WebGLProgram | null } {
  // Compile vertex shader
  const vsResult = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  if (!vsResult.success) {
    return { success: false, error: `Vertex shader error:\n${vsResult.error}`, program: null };
  }
  
  // Compile fragment shader
  const fsResult = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  if (!fsResult.success) {
    gl.deleteShader(vsResult.shader!);
    return { success: false, error: `Fragment shader error:\n${fsResult.error}`, program: null };
  }
  
  // Link program
  const newProgram = gl.createProgram();
  if (!newProgram) {
    gl.deleteShader(vsResult.shader!);
    gl.deleteShader(fsResult.shader!);
    return { success: false, error: 'Failed to create program', program: null };
  }
  
  gl.attachShader(newProgram, vsResult.shader!);
  gl.attachShader(newProgram, fsResult.shader!);
  gl.linkProgram(newProgram);
  
  if (!gl.getProgramParameter(newProgram, gl.LINK_STATUS)) {
    const error = gl.getProgramInfoLog(newProgram);
    gl.deleteProgram(newProgram);
    gl.deleteShader(vsResult.shader!);
    gl.deleteShader(fsResult.shader!);
    return { success: false, error: `Link error:\n${error}`, program: null };
  }
  
  // Clean up compiled shaders (program retains references)
  gl.deleteShader(vsResult.shader!);
  gl.deleteShader(fsResult.shader!);
  
  return { success: true, error: null, program: newProgram };
}

/**
 * Attempt to compile and update a shader with new source
 */
export function compileAndUpdate(
  name: string,
  newSource: string,
  type: ShaderType = 'fragment'
): CompileResult {
  const entry = shaderRegistry.get(name);
  if (!entry) {
    return { success: false, error: `Shader "${name}" not found` };
  }
  
  const { gl, onRecompile, currentVsSource, currentFsSource } = entry;
  
  // Determine which sources to use
  const vsSource = type === 'vertex' ? newSource : currentVsSource;
  const fsSource = type === 'fragment' ? newSource : currentFsSource;
  
  const result = compileAndLinkProgram(gl, vsSource, fsSource);
  
  if (!result.success) {
    return { success: false, error: result.error };
  }
  
  // Success - update registry and notify renderer
  if (type === 'vertex') {
    entry.currentVsSource = newSource;
  } else {
    entry.currentFsSource = newSource;
  }
  entry.program = result.program!;
  
  if (onRecompile) {
    onRecompile(result.program!);
  }
  
  return { success: true, error: null };
}

/**
 * Reset shader to original source
 */
export function resetShader(name: string, type: ShaderType = 'fragment'): CompileResult {
  const entry = shaderRegistry.get(name);
  if (!entry) {
    return { success: false, error: `Shader "${name}" not found` };
  }
  
  const originalSource = type === 'vertex' ? entry.originalVsSource : entry.originalFsSource;
  return compileAndUpdate(name, originalSource, type);
}

/**
 * Reset both vertex and fragment shaders to original source
 */
export function resetShaderFull(name: string): CompileResult {
  const entry = shaderRegistry.get(name);
  if (!entry) {
    return { success: false, error: `Shader "${name}" not found` };
  }
  
  const { gl, onRecompile, originalVsSource, originalFsSource } = entry;
  
  const result = compileAndLinkProgram(gl, originalVsSource, originalFsSource);
  
  if (!result.success) {
    return { success: false, error: result.error };
  }
  
  entry.currentVsSource = originalVsSource;
  entry.currentFsSource = originalFsSource;
  entry.program = result.program!;
  
  if (onRecompile) {
    onRecompile(result.program!);
  }
  
  return { success: true, error: null };
}

/**
 * Check if a shader is modified from original
 */
export function isModified(name: string, type?: ShaderType): boolean {
  const entry = shaderRegistry.get(name);
  if (!entry) return false;
  
  if (type === 'vertex') {
    return entry.currentVsSource !== entry.originalVsSource;
  } else if (type === 'fragment') {
    return entry.currentFsSource !== entry.originalFsSource;
  }
  // Check both if no type specified
  return entry.currentVsSource !== entry.originalVsSource || 
         entry.currentFsSource !== entry.originalFsSource;
}

/**
 * Get all shader names that match a pattern (e.g., all "Object Main" shaders)
 */
export function getShadersMatching(pattern: string): string[] {
  return Array.from(shaderRegistry.keys()).filter(name => name.startsWith(pattern));
}

/**
 * Apply the same source to all shaders matching a prefix
 */
export function applyToAllMatching(prefix: string, newFsSource: string): ApplyAllResult {
  const matchingShaders = getShadersMatching(prefix);
  const results: ApplyAllResult = { successes: 0, failures: [] };
  
  for (const name of matchingShaders) {
    const result = compileAndUpdate(name, newFsSource);
    if (result.success) {
      results.successes++;
    } else {
      results.failures.push({ name, error: result.error || 'Unknown error' });
    }
  }
  
  return results;
}

/**
 * Get the registry for debugging
 */
export function getRegistry(): Map<string, ShaderEntry> {
  return shaderRegistry;
}
