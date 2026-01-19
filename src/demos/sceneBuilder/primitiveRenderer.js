import { mat4, vec3 } from 'gl-matrix';
import { generatePrimitiveGeometry, computeBounds } from './primitiveGeometry.js';
import { shadowUniforms, shadowFunctions, hdrUniforms, lightingUniforms, pbrFunctions, iblFunctions, pbrLighting } from './shaderChunks.js';
import { registerShader, unregisterShader } from './shaderManager.js';

// Counter for unique shader names
let primitiveShaderCounter = 0;

/**
 * Creates a renderer for primitive geometry (cube, plane, sphere)
 * @param {WebGL2RenderingContext} gl
 * @param {string} primitiveType - 'cube' | 'plane' | 'sphere'
 * @param {object} config - { size, subdivision }
 */
export function createPrimitiveRenderer(gl, primitiveType, config = {}) {
  // Default PBR material properties
  let material = {
    albedo: [0.75, 0.75, 0.75],
    metallic: 0.0,
    roughness: 0.5,
  };
  
  // Track if this is a single-sided primitive (plane)
  const isSingleSided = primitiveType === 'plane';
  
  // Generate initial geometry
  let geometry = generatePrimitiveGeometry(primitiveType, config);
  let currentConfig = { ...config };
  
  // Vertex shader with world position for PBR
  const vsSource = `#version 300 es
    precision highp float;
    
    in vec3 aPosition;
    in vec2 aTexCoord;
    in vec3 aNormal;
    
    uniform mat4 uModelViewProjection;
    uniform mat4 uModel;
    uniform mat4 uLightSpaceMatrix;
    
    out vec2 vTexCoord;
    out vec3 vNormal;
    out vec3 vWorldPos;
    out vec4 vLightSpacePos;
    
    void main() {
      vec4 worldPos = uModel * vec4(aPosition, 1.0);
      gl_Position = uModelViewProjection * vec4(aPosition, 1.0);
      
      vTexCoord = aTexCoord;
      vNormal = mat3(uModel) * aNormal;
      vWorldPos = worldPos.xyz;
      vLightSpacePos = uLightSpaceMatrix * worldPos;
    }
  `;
  
  const fsSource = `#version 300 es
    precision mediump float;
    
    // PBR material uniforms
    uniform vec3 uAlbedo;
    uniform float uMetallic;
    uniform float uRoughness;
    uniform bool uSelected;
    uniform vec3 uCameraPos;
    
    // Lighting uniforms
    ${lightingUniforms}
    ${hdrUniforms}
    ${shadowUniforms}
    
    // Shadow functions (needed by PBR lighting)
    ${shadowFunctions}
    
    // PBR functions
    ${pbrFunctions}
    
    // IBL functions
    ${iblFunctions}
    
    // PBR lighting calculation
    ${pbrLighting}
    
    in vec2 vTexCoord;
    in vec3 vNormal;
    in vec3 vWorldPos;
    in vec4 vLightSpacePos;
    
    out vec4 fragColor;
    
    void main() {
      vec3 N = normalize(vNormal);
      vec3 V = normalize(uCameraPos - vWorldPos);
      
      vec3 finalColor = calcPBRLighting(
        N, V, vWorldPos,
        uAlbedo, uMetallic, uRoughness,
        uLightDir, uLightColor, uAmbientIntensity,
        uLightMode, uHdrTexture, uHasHdr, uHdrExposure,
        uShadowMap, uShadowEnabled, vLightSpacePos
      );
      
      // Tone mapping (Reinhard)
      finalColor = finalColor / (finalColor + vec3(1.0));
      
      // Gamma correction
      finalColor = pow(finalColor, vec3(1.0 / 2.2));
      
      if (uSelected) {
        finalColor = mix(finalColor, vec3(1.0, 0.4, 0.4), 0.3);
      }
      
      fragColor = vec4(finalColor, 1.0);
    }
  `;
  
  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader error:', gl.getShaderInfoLog(shader));
      return null;
    }
    return shader;
  }
  
  const vs = compileShader(gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);
  
  let program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  
  // Register with shader manager for live editing
  const shaderName = `Primitive ${primitiveType} #${primitiveShaderCounter++}`;
  
  function updateLocations() {
    return {
      aPosition: gl.getAttribLocation(program, 'aPosition'),
      aTexCoord: gl.getAttribLocation(program, 'aTexCoord'),
      aNormal: gl.getAttribLocation(program, 'aNormal'),
      uModelViewProjection: gl.getUniformLocation(program, 'uModelViewProjection'),
      uModel: gl.getUniformLocation(program, 'uModel'),
      // PBR material
      uAlbedo: gl.getUniformLocation(program, 'uAlbedo'),
      uMetallic: gl.getUniformLocation(program, 'uMetallic'),
      uRoughness: gl.getUniformLocation(program, 'uRoughness'),
      uCameraPos: gl.getUniformLocation(program, 'uCameraPos'),
      // Lighting
      uLightDir: gl.getUniformLocation(program, 'uLightDir'),
      uSelected: gl.getUniformLocation(program, 'uSelected'),
      uAmbientIntensity: gl.getUniformLocation(program, 'uAmbientIntensity'),
      uLightColor: gl.getUniformLocation(program, 'uLightColor'),
      uLightMode: gl.getUniformLocation(program, 'uLightMode'),
      uHdrTexture: gl.getUniformLocation(program, 'uHdrTexture'),
      uHasHdr: gl.getUniformLocation(program, 'uHasHdr'),
      uHdrExposure: gl.getUniformLocation(program, 'uHdrExposure'),
      uLightSpaceMatrix: gl.getUniformLocation(program, 'uLightSpaceMatrix'),
      uShadowMap: gl.getUniformLocation(program, 'uShadowMap'),
      uShadowEnabled: gl.getUniformLocation(program, 'uShadowEnabled'),
    };
  }
  
  let locations = updateLocations();
  
  // Register shader for live editing
  registerShader(shaderName, {
    gl,
    program,
    vsSource,
    fsSource,
    onRecompile: (newProgram) => {
      program = newProgram;
      locations = updateLocations();
    },
  });
  
  // Create buffers
  let posBuffer = gl.createBuffer();
  let uvBuffer = gl.createBuffer();
  let normalBuffer = gl.createBuffer();
  let indexBuffer = gl.createBuffer();
  let indexCount = 0;
  
  function uploadGeometry(geom) {
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, geom.positions, gl.STATIC_DRAW);
    
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, geom.uvs, gl.STATIC_DRAW);
    
    gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, geom.normals, gl.STATIC_DRAW);
    
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geom.indices, gl.STATIC_DRAW);
    
    indexCount = geom.indices.length;
  }
  
  // Initial upload
  uploadGeometry(geometry);
  
  // Outline shader
  const outlineVsSource = `#version 300 es
    precision highp float;
    in vec3 aPosition;
    in vec3 aNormal;
    uniform mat4 uModelViewProjection;
    uniform mat4 uModel;
    uniform float uOutlineWidth;
    void main() {
      vec3 normal = normalize(mat3(uModel) * aNormal);
      vec3 expandedPos = aPosition + normal * uOutlineWidth;
      gl_Position = uModelViewProjection * vec4(expandedPos, 1.0);
    }
  `;
  
  const outlineFsSource = `#version 300 es
    precision mediump float;
    uniform vec3 uOutlineColor;
    out vec4 fragColor;
    void main() {
      fragColor = vec4(uOutlineColor, 1.0);
    }
  `;
  
  const outlineVs = compileShader(gl.VERTEX_SHADER, outlineVsSource);
  const outlineFs = compileShader(gl.FRAGMENT_SHADER, outlineFsSource);
  
  const outlineProgram = gl.createProgram();
  gl.attachShader(outlineProgram, outlineVs);
  gl.attachShader(outlineProgram, outlineFs);
  gl.linkProgram(outlineProgram);
  
  const outlineLocations = {
    aPosition: gl.getAttribLocation(outlineProgram, 'aPosition'),
    aNormal: gl.getAttribLocation(outlineProgram, 'aNormal'),
    uModelViewProjection: gl.getUniformLocation(outlineProgram, 'uModelViewProjection'),
    uModel: gl.getUniformLocation(outlineProgram, 'uModel'),
    uOutlineWidth: gl.getUniformLocation(outlineProgram, 'uOutlineWidth'),
    uOutlineColor: gl.getUniformLocation(outlineProgram, 'uOutlineColor'),
  };
  
  // Wireframe shader
  const wireVsSource = `#version 300 es
    precision highp float;
    in vec3 aPosition;
    uniform mat4 uModelViewProjection;
    void main() {
      gl_Position = uModelViewProjection * vec4(aPosition, 1.0);
    }
  `;
  
  const wireFsSource = `#version 300 es
    precision mediump float;
    uniform vec3 uColor;
    out vec4 fragColor;
    void main() {
      fragColor = vec4(uColor, 1.0);
    }
  `;
  
  const wireVs = compileShader(gl.VERTEX_SHADER, wireVsSource);
  const wireFs = compileShader(gl.FRAGMENT_SHADER, wireFsSource);
  
  const wireProgram = gl.createProgram();
  gl.attachShader(wireProgram, wireVs);
  gl.attachShader(wireProgram, wireFs);
  gl.linkProgram(wireProgram);
  
  const wireLocations = {
    aPosition: gl.getAttribLocation(wireProgram, 'aPosition'),
    uModelViewProjection: gl.getUniformLocation(wireProgram, 'uModelViewProjection'),
    uColor: gl.getUniformLocation(wireProgram, 'uColor'),
  };
  
  // Generate wireframe indices
  let wireIndexBuffer = gl.createBuffer();
  let wireIndexCount = 0;
  
  function generateWireframeIndices(indices) {
    const edgeSet = new Set();
    
    for (let i = 0; i < indices.length; i += 3) {
      const i0 = indices[i], i1 = indices[i + 1], i2 = indices[i + 2];
      edgeSet.add(i0 < i1 ? `${i0}-${i1}` : `${i1}-${i0}`);
      edgeSet.add(i1 < i2 ? `${i1}-${i2}` : `${i2}-${i1}`);
      edgeSet.add(i2 < i0 ? `${i2}-${i0}` : `${i0}-${i2}`);
    }
    
    const lineIndices = [];
    for (const edge of edgeSet) {
      const [a, b] = edge.split('-').map(Number);
      lineIndices.push(a, b);
    }
    
    return new Uint16Array(lineIndices);
  }
  
  function uploadWireframe(indices) {
    const wireIndices = generateWireframeIndices(indices);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wireIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, wireIndices, gl.STATIC_DRAW);
    wireIndexCount = wireIndices.length;
  }
  
  uploadWireframe(geometry.indices);
  
  const mvpMatrix = mat4.create();
  
  function renderOutline(vpMatrix, modelMatrix) {
    mat4.multiply(mvpMatrix, vpMatrix, modelMatrix);
    
    gl.useProgram(outlineProgram);
    gl.uniformMatrix4fv(outlineLocations.uModelViewProjection, false, mvpMatrix);
    gl.uniformMatrix4fv(outlineLocations.uModel, false, modelMatrix);
    gl.uniform1f(outlineLocations.uOutlineWidth, 0.01);
    gl.uniform3fv(outlineLocations.uOutlineColor, [1.0, 0.4, 0.2]);
    
    // For single-sided geometry (planes), disable culling entirely
    // For double-sided (cube, sphere), use back-face technique
    if (isSingleSided) {
      gl.disable(gl.CULL_FACE);
    } else {
      gl.cullFace(gl.FRONT);
    }
    
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.enableVertexAttribArray(outlineLocations.aPosition);
    gl.vertexAttribPointer(outlineLocations.aPosition, 3, gl.FLOAT, false, 0, 0);
    
    gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
    gl.enableVertexAttribArray(outlineLocations.aNormal);
    gl.vertexAttribPointer(outlineLocations.aNormal, 3, gl.FLOAT, false, 0, 0);
    
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);
    
    // Restore culling state
    if (isSingleSided) {
      gl.enable(gl.CULL_FACE);
    }
    gl.cullFace(gl.BACK);
  }
  
  function renderWireframe(vpMatrix, modelMatrix, isSelected) {
    mat4.multiply(mvpMatrix, vpMatrix, modelMatrix);
    
    gl.useProgram(wireProgram);
    gl.uniformMatrix4fv(wireLocations.uModelViewProjection, false, mvpMatrix);
    gl.uniform3fv(wireLocations.uColor, isSelected ? [1.0, 0.5, 0.3] : [0.7, 0.7, 0.7]);
    
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.enableVertexAttribArray(wireLocations.aPosition);
    gl.vertexAttribPointer(wireLocations.aPosition, 3, gl.FLOAT, false, 0, 0);
    
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wireIndexBuffer);
    gl.drawElements(gl.LINES, wireIndexCount, gl.UNSIGNED_SHORT, 0);
  }
  
  // Track destroyed state
  let destroyed = false;
  
  return {
    // Expose for shadow rendering (compatible with objectRenderer interface)
    gpuMeshes: [{
      posBuffer,
      normalBuffer,
      indexBuffer,
      indexCount,
      indexType: gl.UNSIGNED_SHORT,
      vertexCount: geometry.positions.length / 3,
      materialIndex: 0,
    }],
    
    // Check if renderer has been destroyed
    get isDestroyed() { return destroyed; },
    
    /**
     * Update geometry when config changes
     * @param {object} newConfig - { size, subdivision }
     */
    updateGeometry(newConfig) {
      currentConfig = { ...currentConfig, ...newConfig };
      geometry = generatePrimitiveGeometry(primitiveType, currentConfig);
      uploadGeometry(geometry);
      uploadWireframe(geometry.indices);
      
      // Update gpuMeshes reference for shadow renderer
      this.gpuMeshes[0].indexCount = indexCount;
      this.gpuMeshes[0].vertexCount = geometry.positions.length / 3;
    },
    
    /**
     * Get current bounds for scene graph
     */
    getBounds() {
      return computeBounds(geometry.positions);
    },
    
    /**
     * Set PBR material properties
     */
    setMaterial(mat) {
      if (mat.albedo) material.albedo = [...mat.albedo];
      if (mat.metallic !== undefined) material.metallic = mat.metallic;
      if (mat.roughness !== undefined) material.roughness = mat.roughness;
    },
    
    /**
     * Get current PBR material properties
     */
    getMaterial() {
      return { ...material };
    },
    
    /**
     * Render the primitive
     */
    render(vpMatrix, modelMatrix, isSelected, wireframeMode = false, lightParams = null) {
      if (wireframeMode) {
        renderWireframe(vpMatrix, modelMatrix, isSelected);
        return;
      }
      
      if (isSelected) {
        renderOutline(vpMatrix, modelMatrix);
      }
      
      const light = lightParams || {
        mode: 'sun',
        sunDir: [0.5, 1, 0.5],
        ambient: 0.3,
        lightColor: [1, 1, 1],
        hdrTexture: null,
        cameraPos: [0, 0, 5],
      };
      
      mat4.multiply(mvpMatrix, vpMatrix, modelMatrix);
      
      gl.useProgram(program);
      gl.uniformMatrix4fv(locations.uModelViewProjection, false, mvpMatrix);
      gl.uniformMatrix4fv(locations.uModel, false, modelMatrix);
      
      // PBR material uniforms
      gl.uniform3fv(locations.uAlbedo, material.albedo);
      gl.uniform1f(locations.uMetallic, material.metallic);
      gl.uniform1f(locations.uRoughness, Math.max(0.04, material.roughness)); // Clamp to avoid div by zero
      gl.uniform3fv(locations.uCameraPos, light.cameraPos || [0, 0, 5]);
      
      // Lighting uniforms
      gl.uniform3fv(locations.uLightDir, light.sunDir);
      gl.uniform1i(locations.uSelected, isSelected ? 1 : 0);
      gl.uniform1f(locations.uAmbientIntensity, light.ambient);
      gl.uniform3fv(locations.uLightColor, light.lightColor);
      gl.uniform1i(locations.uLightMode, light.mode === 'hdr' ? 1 : 0);
      gl.uniform1i(locations.uHasHdr, light.hdrTexture ? 1 : 0);
      gl.uniform1f(locations.uHdrExposure, light.hdrExposure || 1.0);
      
      gl.uniform1i(locations.uShadowEnabled, light.shadowEnabled ? 1 : 0);
      if (light.lightSpaceMatrix) {
        gl.uniformMatrix4fv(locations.uLightSpaceMatrix, false, light.lightSpaceMatrix);
      }
      
      gl.activeTexture(gl.TEXTURE2);
      if (light.shadowMap) {
        gl.bindTexture(gl.TEXTURE_2D, light.shadowMap);
      }
      gl.uniform1i(locations.uShadowMap, 2);
      
      if (light.hdrTexture) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, light.hdrTexture);
        gl.uniform1i(locations.uHdrTexture, 1);
      }
      
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
      gl.enableVertexAttribArray(locations.aPosition);
      gl.vertexAttribPointer(locations.aPosition, 3, gl.FLOAT, false, 0, 0);
      
      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
      gl.enableVertexAttribArray(locations.aTexCoord);
      gl.vertexAttribPointer(locations.aTexCoord, 2, gl.FLOAT, false, 0, 0);
      
      gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
      gl.enableVertexAttribArray(locations.aNormal);
      gl.vertexAttribPointer(locations.aNormal, 3, gl.FLOAT, false, 0, 0);
      
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);
    },
    
    destroy() {
      destroyed = true;
      unregisterShader(shaderName);
      gl.deleteProgram(program);
      gl.deleteProgram(outlineProgram);
      gl.deleteProgram(wireProgram);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteShader(outlineVs);
      gl.deleteShader(outlineFs);
      gl.deleteShader(wireVs);
      gl.deleteShader(wireFs);
      gl.deleteBuffer(posBuffer);
      gl.deleteBuffer(uvBuffer);
      gl.deleteBuffer(normalBuffer);
      gl.deleteBuffer(indexBuffer);
      gl.deleteBuffer(wireIndexBuffer);
      // Clear gpuMeshes to prevent stale references
      this.gpuMeshes.length = 0;
    },
  };
}
