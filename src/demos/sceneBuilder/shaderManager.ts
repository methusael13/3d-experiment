/**
 * Shader Manager
 * Central registry for live shader editing and hot-reloading
 */

// ==================== Types ====================

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
  vsSource: string;
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
    vsSource: config.vsSource,
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
export function getShaderSource(name: string): string | null {
  const entry = shaderRegistry.get(name);
  return entry ? entry.currentFsSource : null;
}

/**
 * Get original fragment shader source (for reset)
 */
export function getOriginalSource(name: string): string | null {
  const entry = shaderRegistry.get(name);
  return entry ? entry.originalFsSource : null;
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
 * Attempt to compile and update a shader with new fragment source
 */
export function compileAndUpdate(name: string, newFsSource: string): CompileResult {
  const entry = shaderRegistry.get(name);
  if (!entry) {
    return { success: false, error: `Shader "${name}" not found` };
  }
  
  const { gl, vsSource, onRecompile } = entry;
  
  // Compile vertex shader
  const vsResult = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  if (!vsResult.success) {
    return { success: false, error: `Vertex shader error:\n${vsResult.error}` };
  }
  
  // Compile new fragment shader
  const fsResult = compileShader(gl, gl.FRAGMENT_SHADER, newFsSource);
  if (!fsResult.success) {
    gl.deleteShader(vsResult.shader!);
    return { success: false, error: `Fragment shader error:\n${fsResult.error}` };
  }
  
  // Link new program
  const newProgram = gl.createProgram();
  if (!newProgram) {
    gl.deleteShader(vsResult.shader!);
    gl.deleteShader(fsResult.shader!);
    return { success: false, error: 'Failed to create program' };
  }
  
  gl.attachShader(newProgram, vsResult.shader!);
  gl.attachShader(newProgram, fsResult.shader!);
  gl.linkProgram(newProgram);
  
  if (!gl.getProgramParameter(newProgram, gl.LINK_STATUS)) {
    const error = gl.getProgramInfoLog(newProgram);
    gl.deleteProgram(newProgram);
    gl.deleteShader(vsResult.shader!);
    gl.deleteShader(fsResult.shader!);
    return { success: false, error: `Link error:\n${error}` };
  }
  
  // Success - update registry and notify renderer
  entry.currentFsSource = newFsSource;
  entry.program = newProgram;
  
  if (onRecompile) {
    onRecompile(newProgram);
  }
  
  // Clean up compiled shaders (program retains references)
  gl.deleteShader(vsResult.shader!);
  gl.deleteShader(fsResult.shader!);
  
  return { success: true, error: null };
}

/**
 * Reset shader to original source
 */
export function resetShader(name: string): CompileResult {
  const entry = shaderRegistry.get(name);
  if (!entry) {
    return { success: false, error: `Shader "${name}" not found` };
  }
  
  return compileAndUpdate(name, entry.originalFsSource);
}

/**
 * Check if a shader is modified from original
 */
export function isModified(name: string): boolean {
  const entry = shaderRegistry.get(name);
  if (!entry) return false;
  return entry.currentFsSource !== entry.originalFsSource;
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
