/**
 * Depth Pre-Pass Renderer
 * Renders scene depth to a texture for terrain/rock intersection blending
 */

import { mat4 } from 'gl-matrix';
import { simplexNoise, windUniforms, windDisplacement } from './shaderChunks.js';

/**
 * Create depth pre-pass renderer
 * @param {WebGL2RenderingContext} gl 
 * @param {number} width - Canvas width
 * @param {number} height - Canvas height
 */
export function createDepthPrePassRenderer(gl, width, height) {
  let currentWidth = width;
  let currentHeight = height;
  let depthTexture = null;
  let colorTexture = null;
  let framebuffer = null;
  
  // Depth-only shader with wind displacement support
  const vsSource = `#version 300 es
    precision highp float;
    
    in vec3 aPosition;
    
    uniform mat4 uModelViewProjection;
    uniform mat4 uModel;
    
    // Include shared shader chunks for wind
    ${simplexNoise}
    ${windUniforms}
    ${windDisplacement}
    
    out float vDepth;
    
    void main() {
      vec4 worldPos = uModel * vec4(aPosition, 1.0);
      
      // Calculate height factor for wind
      float heightAboveAnchor = max(0.0, worldPos.y - uWindAnchorHeight);
      float heightFactor = clamp(heightAboveAnchor * 0.5, 0.0, 1.0);
      heightFactor = heightFactor * heightFactor;
      
      // Apply wind displacement
      vec3 windOffset = calcWindDisplacement(worldPos.xyz, heightFactor);
      worldPos.xyz += windOffset;
      
      // Transform to clip space
      mat4 invModel = inverse(uModel);
      vec4 displacedLocal = invModel * worldPos;
      gl_Position = uModelViewProjection * vec4(aPosition, 1.0);
      
      // Apply wind offset in clip space
      vec4 worldOffset = vec4(windOffset, 0.0);
      mat4 vp = uModelViewProjection * inverse(uModel);
      gl_Position += vp * worldOffset;
      
      // Pass linear depth (will be stored as gl_FragCoord.z)
      vDepth = gl_Position.z / gl_Position.w;
    }
  `;
  
  const fsSource = `#version 300 es
    precision highp float;
    
    in float vDepth;
    out vec4 fragColor;
    
    void main() {
      // Store depth as linear value in color texture
      // Using gl_FragCoord.z for hardware depth buffer compatibility
      float depth = gl_FragCoord.z;
      fragColor = vec4(depth, depth, depth, 1.0);
    }
  `;
  
  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Depth pre-pass shader error:', gl.getShaderInfoLog(shader));
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
  
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Depth pre-pass program link error:', gl.getProgramInfoLog(program));
  }
  
  const locations = {
    aPosition: gl.getAttribLocation(program, 'aPosition'),
    uModelViewProjection: gl.getUniformLocation(program, 'uModelViewProjection'),
    uModel: gl.getUniformLocation(program, 'uModel'),
    // Wind uniforms
    uWindEnabled: gl.getUniformLocation(program, 'uWindEnabled'),
    uWindTime: gl.getUniformLocation(program, 'uWindTime'),
    uWindStrength: gl.getUniformLocation(program, 'uWindStrength'),
    uWindDirection: gl.getUniformLocation(program, 'uWindDirection'),
    uWindTurbulence: gl.getUniformLocation(program, 'uWindTurbulence'),
    uWindType: gl.getUniformLocation(program, 'uWindType'),
    uWindInfluence: gl.getUniformLocation(program, 'uWindInfluence'),
    uWindStiffness: gl.getUniformLocation(program, 'uWindStiffness'),
    uWindAnchorHeight: gl.getUniformLocation(program, 'uWindAnchorHeight'),
    uWindPhysicsDisplacement: gl.getUniformLocation(program, 'uWindPhysicsDisplacement'),
  };
  
  const mvpMatrix = mat4.create();
  
  /**
   * Create or resize the framebuffer
   */
  function createFramebuffer(w, h) {
    // Clean up existing
    if (depthTexture) gl.deleteTexture(depthTexture);
    if (colorTexture) gl.deleteTexture(colorTexture);
    if (framebuffer) gl.deleteFramebuffer(framebuffer);
    
    currentWidth = w;
    currentHeight = h;
    
    // Create color texture to store depth values (R32F for precision)
    colorTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, colorTexture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.R32F,
      currentWidth, currentHeight, 0,
      gl.RED, gl.FLOAT, null
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    
    // Create depth renderbuffer
    depthTexture = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthTexture);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, currentWidth, currentHeight);
    
    // Create framebuffer
    framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTexture, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthTexture);
    
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      console.error('Depth pre-pass framebuffer incomplete:', status);
    }
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  
  // Initialize framebuffer
  createFramebuffer(currentWidth, currentHeight);
  
  /**
   * Begin depth pre-pass
   * @param {Float32Array} vpMatrix - View-projection matrix
   */
  function beginPass(vpMatrix) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, currentWidth, currentHeight);
    
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.clearColor(1.0, 1.0, 1.0, 1.0); // Clear to far depth (1.0)
    gl.clearDepth(1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    
    gl.useProgram(program);
  }
  
  /**
   * Render an object to the depth buffer
   * @param {object} gpuMeshes - Array of GPU mesh data
   * @param {Float32Array} vpMatrix - View-projection matrix
   * @param {Float32Array} modelMatrix - Model transform
   * @param {object} windParams - Global wind parameters
   * @param {object} objectWindSettings - Per-object wind settings
   * @param {boolean} isTerrainBlendTarget - If true, skip this object (it will sample others)
   */
  function renderObject(gpuMeshes, vpMatrix, modelMatrix, windParams = null, objectWindSettings = null, isTerrainBlendTarget = false) {
    // Objects with terrain blend enabled should NOT write to depth pre-pass
    // They will sample this depth buffer instead
    if (isTerrainBlendTarget) return;
    
    mat4.multiply(mvpMatrix, vpMatrix, modelMatrix);
    gl.uniformMatrix4fv(locations.uModelViewProjection, false, mvpMatrix);
    gl.uniformMatrix4fv(locations.uModel, false, modelMatrix);
    
    // Set wind uniforms
    const wind = windParams || { enabled: false, time: 0, strength: 0, direction: [1, 0], turbulence: 0.5 };
    const objWind = objectWindSettings || { enabled: false, influence: 1.0, stiffness: 0.5, anchorHeight: 0, leafMaterialIndices: new Set(), branchMaterialIndices: new Set() };
    
    const windActive = wind.enabled && objWind.enabled;
    gl.uniform1i(locations.uWindEnabled, windActive ? 1 : 0);
    gl.uniform1f(locations.uWindTime, wind.time || 0);
    gl.uniform1f(locations.uWindStrength, wind.strength || 0);
    gl.uniform2fv(locations.uWindDirection, wind.direction || [1, 0]);
    gl.uniform1f(locations.uWindTurbulence, wind.turbulence || 0.5);
    gl.uniform1f(locations.uWindInfluence, objWind.influence || 1.0);
    gl.uniform1f(locations.uWindStiffness, objWind.stiffness || 0.5);
    gl.uniform1f(locations.uWindAnchorHeight, objWind.anchorHeight || 0);
    gl.uniform2fv(locations.uWindPhysicsDisplacement, objWind.displacement || [0, 0]);
    
    for (const mesh of gpuMeshes) {
      // Determine wind type for this mesh
      let windType = 0;
      if (windActive) {
        if (objWind.leafMaterialIndices && objWind.leafMaterialIndices.has(mesh.materialIndex)) {
          windType = 1;
        } else if (objWind.branchMaterialIndices && objWind.branchMaterialIndices.has(mesh.materialIndex)) {
          windType = 2;
        }
      }
      gl.uniform1i(locations.uWindType, windType);
      
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.posBuffer);
      gl.enableVertexAttribArray(locations.aPosition);
      gl.vertexAttribPointer(locations.aPosition, 3, gl.FLOAT, false, 0, 0);
      
      if (mesh.indexBuffer) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indexBuffer);
        gl.drawElements(gl.TRIANGLES, mesh.indexCount, mesh.indexType, 0);
      } else {
        gl.drawArrays(gl.TRIANGLES, 0, mesh.vertexCount);
      }
      
      gl.disableVertexAttribArray(locations.aPosition);
    }
  }
  
  /**
   * End depth pre-pass
   * @param {number} canvasWidth 
   * @param {number} canvasHeight 
   */
  function endPass(canvasWidth, canvasHeight) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasWidth, canvasHeight);
  }
  
  return {
    /**
     * Get depth texture for sampling in main pass
     */
    getDepthTexture() {
      return colorTexture;
    },
    
    /**
     * Resize framebuffer if canvas size changed
     */
    resize(w, h) {
      if (w !== currentWidth || h !== currentHeight) {
        createFramebuffer(w, h);
      }
    },
    
    beginPass,
    renderObject,
    endPass,
    
    destroy() {
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (depthTexture) gl.deleteRenderbuffer(depthTexture);
      if (colorTexture) gl.deleteTexture(colorTexture);
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
    },
  };
}
