/**
 * Shader Manager
 * Central registry for live shader editing and hot-reloading
 */

// Global shader registry
const shaderRegistry = new Map();

/**
 * Register a shader with the manager
 * @param {string} name - Unique shader name (e.g., "Object Main", "Shadow")
 * @param {object} config
 * @param {WebGL2RenderingContext} config.gl - WebGL context
 * @param {WebGLProgram} config.program - Current program
 * @param {string} config.vsSource - Vertex shader source (kept for recompilation)
 * @param {string} config.fsSource - Fragment shader source
 * @param {function} config.onRecompile - Callback when shader is recompiled (receives new program)
 */
export function registerShader(name, config) {
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
export function unregisterShader(name) {
  shaderRegistry.delete(name);
}

/**
 * Get list of all registered shader names
 */
export function getShaderList() {
  return Array.from(shaderRegistry.keys());
}

/**
 * Get current fragment shader source for a shader
 */
export function getShaderSource(name) {
  const entry = shaderRegistry.get(name);
  return entry ? entry.currentFsSource : null;
}

/**
 * Get original fragment shader source (for reset)
 */
export function getOriginalSource(name) {
  const entry = shaderRegistry.get(name);
  return entry ? entry.originalFsSource : null;
}

/**
 * Compile a shader from source
 */
function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
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
 * @returns {{ success: boolean, error: string|null }}
 */
export function compileAndUpdate(name, newFsSource) {
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
    gl.deleteShader(vsResult.shader);
    return { success: false, error: `Fragment shader error:\n${fsResult.error}` };
  }
  
  // Link new program
  const newProgram = gl.createProgram();
  gl.attachShader(newProgram, vsResult.shader);
  gl.attachShader(newProgram, fsResult.shader);
  gl.linkProgram(newProgram);
  
  if (!gl.getProgramParameter(newProgram, gl.LINK_STATUS)) {
    const error = gl.getProgramInfoLog(newProgram);
    gl.deleteProgram(newProgram);
    gl.deleteShader(vsResult.shader);
    gl.deleteShader(fsResult.shader);
    return { success: false, error: `Link error:\n${error}` };
  }
  
  // Success - update registry and notify renderer
  entry.currentFsSource = newFsSource;
  entry.program = newProgram;
  
  if (onRecompile) {
    onRecompile(newProgram);
  }
  
  // Clean up compiled shaders (program retains references)
  gl.deleteShader(vsResult.shader);
  gl.deleteShader(fsResult.shader);
  
  return { success: true, error: null };
}

/**
 * Reset shader to original source
 */
export function resetShader(name) {
  const entry = shaderRegistry.get(name);
  if (!entry) {
    return { success: false, error: `Shader "${name}" not found` };
  }
  
  return compileAndUpdate(name, entry.originalFsSource);
}

/**
 * Check if a shader is modified from original
 */
export function isModified(name) {
  const entry = shaderRegistry.get(name);
  if (!entry) return false;
  return entry.currentFsSource !== entry.originalFsSource;
}

/**
 * Get all shader names that match a pattern (e.g., all "Object Main" shaders)
 */
export function getShadersMatching(pattern) {
  return Array.from(shaderRegistry.keys()).filter(name => name.startsWith(pattern));
}

/**
 * Apply the same source to all shaders matching a prefix
 * @returns {{ successes: number, failures: Array<{name: string, error: string}> }}
 */
export function applyToAllMatching(prefix, newFsSource) {
  const matchingShaders = getShadersMatching(prefix);
  const results = { successes: 0, failures: [] };
  
  for (const name of matchingShaders) {
    const result = compileAndUpdate(name, newFsSource);
    if (result.success) {
      results.successes++;
    } else {
      results.failures.push({ name, error: result.error });
    }
  }
  
  return results;
}

// Export registry for debugging
export function getRegistry() {
  return shaderRegistry;
}
