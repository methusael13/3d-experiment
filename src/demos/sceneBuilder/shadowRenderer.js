/**
 * Shadow Renderer
 * Creates depth framebuffer and renders shadow map from sun perspective
 */

import { mat4, vec3 } from 'gl-matrix';

/**
 * Create shadow renderer
 * @param {WebGL2RenderingContext} gl 
 * @param {number} initialResolution - Shadow map resolution (1024, 2048, 4096)
 */
export function createShadowRenderer(gl, initialResolution = 2048) {
  let resolution = initialResolution;
  let depthTexture = null;
  let framebuffer = null;
  
  // Depth-only shader
  const vsSource = `#version 300 es
    precision highp float;
    
    in vec3 aPosition;
    
    uniform mat4 uLightSpaceMatrix;
    uniform mat4 uModel;
    
    void main() {
      gl_Position = uLightSpaceMatrix * uModel * vec4(aPosition, 1.0);
    }
  `;
  
  const fsSource = `#version 300 es
    precision mediump float;
    
    void main() {
      // Depth is automatically written to depth buffer
      // No color output needed
    }
  `;
  
  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shadow shader error:', gl.getShaderInfoLog(shader));
      return null;
    }
    return shader;
  }
  
  const vs = compileShader(gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);
  
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  
  const locations = {
    aPosition: gl.getAttribLocation(program, 'aPosition'),
    uLightSpaceMatrix: gl.getUniformLocation(program, 'uLightSpaceMatrix'),
    uModel: gl.getUniformLocation(program, 'uModel'),
  };
  
  // Light space matrices
  const lightViewMatrix = mat4.create();
  const lightProjMatrix = mat4.create();
  const lightSpaceMatrix = mat4.create();
  
  /**
   * Create or resize the shadow map framebuffer
   */
  function createFramebuffer(size) {
    // Clean up existing
    if (depthTexture) gl.deleteTexture(depthTexture);
    if (framebuffer) gl.deleteFramebuffer(framebuffer);
    
    resolution = size;
    
    // Create depth texture
    depthTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, depthTexture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24,
      resolution, resolution, 0,
      gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null
    );
    
    // Important: Use NEAREST for depth comparison, LINEAR can cause issues
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    
    // Use comparison mode for shadow sampler
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    
    // Create framebuffer
    framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTexture, 0);
    
    // No color attachment
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      console.error('Shadow framebuffer incomplete:', status);
    }
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  
  // Initialize framebuffer
  createFramebuffer(resolution);
  
  /**
   * Calculate light space matrix for given sun direction
   * @param {number[]} sunDir - Normalized sun direction [x, y, z]
   * @param {number} sceneSize - Size of the area to cover (e.g., grid size)
   */
  function calculateLightMatrix(sunDir, sceneSize = 20) {
    // Light position: far away in opposite direction of sun
    const lightDistance = sceneSize * 2;
    const lightPos = [
      -sunDir[0] * lightDistance,
      -sunDir[1] * lightDistance,
      -sunDir[2] * lightDistance,
    ];
    
    // Light looks at origin
    const target = [0, 0, 0];
    
    // Up vector (handle case when sun is directly above/below)
    let up = [0, 1, 0];
    if (Math.abs(sunDir[1]) > 0.99) {
      up = [0, 0, 1];
    }
    
    // View matrix
    mat4.lookAt(lightViewMatrix, lightPos, target, up);
    
    // Orthographic projection covering scene
    const halfSize = sceneSize / 2;
    const near = 0.1;
    const far = lightDistance * 2 + sceneSize;
    
    mat4.ortho(lightProjMatrix, -halfSize, halfSize, -halfSize, halfSize, near, far);
    
    // Combined light space matrix
    mat4.multiply(lightSpaceMatrix, lightProjMatrix, lightViewMatrix);
    
    return lightSpaceMatrix;
  }
  
  /**
   * Begin shadow pass - bind framebuffer and set up state
   * @param {number[]} sunDir - Normalized sun direction
   * @param {number} sceneSize - Size of scene to cover
   */
  function beginShadowPass(sunDir, sceneSize = 20) {
    calculateLightMatrix(sunDir, sceneSize);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, resolution, resolution);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    
    // Use front-face culling to reduce peter-panning
    gl.cullFace(gl.FRONT);
    
    gl.useProgram(program);
    gl.uniformMatrix4fv(locations.uLightSpaceMatrix, false, lightSpaceMatrix);
  }
  
  /**
   * Render an object to the shadow map
   * @param {object} gpuMeshes - Array of GPU mesh data with posBuffer
   * @param {Float32Array} modelMatrix - Model transform
   */
  function renderObject(gpuMeshes, modelMatrix) {
    gl.uniformMatrix4fv(locations.uModel, false, modelMatrix);
    
    for (const mesh of gpuMeshes) {
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.posBuffer);
      gl.enableVertexAttribArray(locations.aPosition);
      gl.vertexAttribPointer(locations.aPosition, 3, gl.FLOAT, false, 0, 0);
      
      if (mesh.indexBuffer) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indexBuffer);
        gl.drawElements(gl.TRIANGLES, mesh.indexCount, mesh.indexType, 0);
      } else {
        gl.drawArrays(gl.TRIANGLES, 0, mesh.vertexCount);
      }
    }
  }
  
  /**
   * End shadow pass - restore state
   * @param {number} canvasWidth 
   * @param {number} canvasHeight 
   */
  function endShadowPass(canvasWidth, canvasHeight) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.cullFace(gl.BACK);
  }
  
  return {
    /**
     * Get shadow map texture
     */
    getTexture() {
      return depthTexture;
    },
    
    /**
     * Get light space matrix for shadow lookup
     */
    getLightSpaceMatrix() {
      return lightSpaceMatrix;
    },
    
    /**
     * Get current resolution
     */
    getResolution() {
      return resolution;
    },
    
    /**
     * Change shadow map resolution
     */
    setResolution(newResolution) {
      if (newResolution !== resolution) {
        createFramebuffer(newResolution);
      }
    },
    
    beginShadowPass,
    renderObject,
    endShadowPass,
    
    destroy() {
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (depthTexture) gl.deleteTexture(depthTexture);
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
    },
  };
}
