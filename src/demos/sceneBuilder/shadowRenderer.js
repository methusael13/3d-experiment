/**
 * Shadow Renderer
 * Creates depth framebuffer and renders shadow map from sun perspective
 */

import { mat4, vec3 } from 'gl-matrix';
import { simplexNoise, windUniforms, windDisplacement } from './shaderChunks.js';

/**
 * Create shadow renderer
 * @param {WebGL2RenderingContext} gl 
 * @param {number} initialResolution - Shadow map resolution (1024, 2048, 4096)
 */
export function createShadowRenderer(gl, initialResolution = 2048) {
  let resolution = initialResolution;
  let depthTexture = null;
  let framebuffer = null;
  
  // Depth-only shader with wind displacement (uses shared chunks)
  const vsSource = `#version 300 es
    precision highp float;
    
    in vec3 aPosition;
    
    uniform mat4 uLightSpaceMatrix;
    uniform mat4 uModel;
    
    // Include shared shader chunks
    ${simplexNoise}
    ${windUniforms}
    ${windDisplacement}
    
    void main() {
      vec4 worldPos = uModel * vec4(aPosition, 1.0);
      
      // Calculate height factor for wind
      float heightAboveAnchor = max(0.0, worldPos.y - uWindAnchorHeight);
      float heightFactor = clamp(heightAboveAnchor * 0.5, 0.0, 1.0);
      heightFactor = heightFactor * heightFactor;
      
      // Apply wind displacement
      vec3 windOffset = calcWindDisplacement(worldPos.xyz, heightFactor);
      worldPos.xyz += windOffset;
      
      gl_Position = uLightSpaceMatrix * worldPos;
    }
  `;
  
  const fsSource = `#version 300 es
    precision highp float;
    
    out vec4 fragColor;
    
    // Pack float depth into RGBA8 (24-bit precision)
    vec4 packDepth(float depth) {
      const vec4 bitShift = vec4(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0, 1.0);
      const vec4 bitMask = vec4(0.0, 1.0 / 256.0, 1.0 / 256.0, 1.0 / 256.0);
      vec4 res = fract(depth * bitShift);
      res -= res.xxyz * bitMask;
      return res;
    }
    
    void main() {
      // Pack depth into RGBA channels
      fragColor = packDepth(gl_FragCoord.z);
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
  
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Shadow program link error:', gl.getProgramInfoLog(program));
  }
  
  const locations = {
    aPosition: gl.getAttribLocation(program, 'aPosition'),
    uLightSpaceMatrix: gl.getUniformLocation(program, 'uLightSpaceMatrix'),
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
  
  // Debug thumbnail renderer (full-screen quad)
  const debugVsSource = `#version 300 es
    precision highp float;
    
    in vec2 aPosition;
    out vec2 vUV;
    
    uniform vec4 uViewport; // x, y, width, height in pixels
    uniform vec2 uScreenSize;
    
    void main() {
      // Convert from [0,1] quad to screen position
      vec2 pixelPos = uViewport.xy + aPosition * uViewport.zw;
      // Convert to NDC [-1, 1]
      vec2 ndc = (pixelPos / uScreenSize) * 2.0 - 1.0;
      gl_Position = vec4(ndc, 0.0, 1.0);
      vUV = aPosition;
    }
  `;
  
  const debugFsSource = `#version 300 es
    precision highp float;
    
    in vec2 vUV;
    uniform sampler2D uDepthTexture;
    out vec4 fragColor;
    
    // Unpack depth from RGBA8
    float unpackDepth(vec4 rgba) {
      const vec4 bitShift = vec4(1.0 / (256.0 * 256.0 * 256.0), 1.0 / (256.0 * 256.0), 1.0 / 256.0, 1.0);
      return dot(rgba, bitShift);
    }
    
    void main() {
      vec4 packed = texture(uDepthTexture, vUV);
      float depth = unpackDepth(packed);
      // Enhance contrast - depth values are usually close to 1.0
      // float visualDepth = pow(depth, 50.0); // Exaggerate differences
      fragColor = vec4(vec3(depth), 1.0);
    }
  `;
  
  const debugVs = compileShader(gl.VERTEX_SHADER, debugVsSource);
  const debugFs = compileShader(gl.FRAGMENT_SHADER, debugFsSource);
  
  const debugProgram = gl.createProgram();
  gl.attachShader(debugProgram, debugVs);
  gl.attachShader(debugProgram, debugFs);
  gl.linkProgram(debugProgram);
  
  const debugLocations = {
    aPosition: gl.getAttribLocation(debugProgram, 'aPosition'),
    uViewport: gl.getUniformLocation(debugProgram, 'uViewport'),
    uScreenSize: gl.getUniformLocation(debugProgram, 'uScreenSize'),
    uDepthTexture: gl.getUniformLocation(debugProgram, 'uDepthTexture'),
  };
  
  // Create quad buffer for debug rendering
  const quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    0, 0,  1, 0,  0, 1,
    1, 0,  1, 1,  0, 1,
  ]), gl.STATIC_DRAW);
  
  // Light space matrices
  const lightViewMatrix = mat4.create();
  const lightProjMatrix = mat4.create();
  const lightSpaceMatrix = mat4.create();
  
  let colorTexture = null;
  let depthRenderbuffer = null;
  
  /**
   * Create or resize the shadow map framebuffer
   * Uses color texture for depth to avoid depth texture sampling issues
   */
  function createFramebuffer(size) {
    // Clean up existing
    if (depthTexture) gl.deleteTexture(depthTexture);
    if (colorTexture) gl.deleteTexture(colorTexture);
    if (depthRenderbuffer) gl.deleteRenderbuffer(depthRenderbuffer);
    if (framebuffer) gl.deleteFramebuffer(framebuffer);
    
    resolution = size;
    
    // Create color texture to store depth values (RGBA8 for compatibility)
    colorTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, colorTexture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA8,
      resolution, resolution, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null
    );
    
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    
    // Create depth renderbuffer for depth testing during shadow pass
    depthRenderbuffer = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthRenderbuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, resolution, resolution);
    
    // Create framebuffer
    framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTexture, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRenderbuffer);
    
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      console.error('Shadow framebuffer incomplete:', status);
    }
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    
    // Store color texture as the shadow map
    depthTexture = colorTexture;
  }
  
  // Initialize framebuffer
  createFramebuffer(resolution);
  
  /**
   * Calculate light space matrix for given sun direction
   * @param {number[]} sunDir - Normalized sun direction [x, y, z] (points TOWARD the sun)
   * @param {number} sceneSize - Size of the area to cover (e.g., grid size)
   */
  function calculateLightMatrix(sunDir, sceneSize = 20) {
    // Light position: far away in the direction of the sun
    // sunDir points toward the sun, so light camera is positioned along that direction
    const lightDistance = sceneSize * 2;
    const lightPos = [
      sunDir[0] * lightDistance,
      sunDir[1] * lightDistance,
      sunDir[2] * lightDistance,
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
    // Use symmetric bounds centered on target
    const halfSize = sceneSize;
    // Near/far must encompass all geometry from light's perspective
    const near = 1;
    const far = lightDistance * 2 + sceneSize * 2;
    
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
    
    // Ensure depth testing is enabled and clear to far (1.0)
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.clearColor(1.0, 1.0, 1.0, 1.0); // Clear to 1.0 (far)
    gl.clearDepth(1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    
    // Disable culling during shadow pass to catch all geometry
    gl.disable(gl.CULL_FACE);
    
    gl.useProgram(program);
    gl.uniformMatrix4fv(locations.uLightSpaceMatrix, false, lightSpaceMatrix);
  }
  
  /**
   * Render an object to the shadow map
   * @param {object} gpuMeshes - Array of GPU mesh data with posBuffer
   * @param {Float32Array} modelMatrix - Model transform
   * @param {object} windParams - Global wind parameters (from wind manager)
   * @param {object} objectWindSettings - Per-object wind settings
   */
  let debugLogged = false;
  
  function renderObject(gpuMeshes, modelMatrix, windParams = null, objectWindSettings = null) {
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
    
    if (!debugLogged) {
      console.log('Shadow pass rendering', gpuMeshes.length, 'meshes');
      console.log('Light space matrix:', Array.from(lightSpaceMatrix));
      console.log('Model matrix:', Array.from(modelMatrix));
      debugLogged = true;
    }
    
    for (const mesh of gpuMeshes) {
      // Determine wind type for this mesh based on material index
      let windType = 0; // 0=none by default
      if (windActive) {
        if (objWind.leafMaterialIndices && objWind.leafMaterialIndices.has(mesh.materialIndex)) {
          windType = 1; // leaf
        } else if (objWind.branchMaterialIndices && objWind.branchMaterialIndices.has(mesh.materialIndex)) {
          windType = 2; // branch
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
      
      // Disable attribute after drawing to avoid conflicts with other shaders
      gl.disableVertexAttribArray(locations.aPosition);
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
    // Re-enable culling
    gl.enable(gl.CULL_FACE);
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
    
    /**
     * Render debug thumbnail of shadow map
     * @param {number} x - X position in pixels (from left)
     * @param {number} y - Y position in pixels (from bottom)
     * @param {number} size - Size of thumbnail in pixels
     * @param {number} screenWidth - Canvas width
     * @param {number} screenHeight - Canvas height
     */
    renderDebugThumbnail(x, y, size, screenWidth, screenHeight) {
      if (!depthTexture) return;
      
      gl.useProgram(debugProgram);
      
      // Disable depth test for overlay
      gl.disable(gl.DEPTH_TEST);
      
      // Set uniforms
      gl.uniform4f(debugLocations.uViewport, x, y, size, size);
      gl.uniform2f(debugLocations.uScreenSize, screenWidth, screenHeight);
      
      // Bind shadow map texture
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, depthTexture);
      gl.uniform1i(debugLocations.uDepthTexture, 0);
      
      // Draw quad
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.enableVertexAttribArray(debugLocations.aPosition);
      gl.vertexAttribPointer(debugLocations.aPosition, 2, gl.FLOAT, false, 0, 0);
      
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      
      gl.disableVertexAttribArray(debugLocations.aPosition);
      
      // Re-enable depth test
      gl.enable(gl.DEPTH_TEST);
    },
    
    destroy() {
      gl.deleteProgram(program);
      gl.deleteProgram(debugProgram);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteShader(debugVs);
      gl.deleteShader(debugFs);
      gl.deleteBuffer(quadBuffer);
      if (depthTexture) gl.deleteTexture(depthTexture);
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
    },
  };
}
