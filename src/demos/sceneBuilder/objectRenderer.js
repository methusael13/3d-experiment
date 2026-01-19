import { mat4 } from 'gl-matrix';
import { registerShader, unregisterShader } from './shaderManager.js';
import { simplexNoise, windUniforms, windDisplacement, terrainBlendUniforms, terrainBlendFunctions, hdrUniforms, hdrFunctions, shadowUniforms, shadowFunctions, lightingUniforms, lightingFunction } from './shaderChunks.js';

// Generate unique ID for each renderer instance
let rendererIdCounter = 0;

/**
 * Creates a renderer for a GLB model in the scene
 */
export function createObjectRenderer(gl, glbModel) {
  const rendererId = rendererIdCounter++;
  const shaderName = `Object Main #${rendererId}`;
  
  // Vertex shader with shared wind chunks
  const vsSource = `#version 300 es
    precision highp float;
    
    in vec3 aPosition;
    in vec2 aTexCoord;
    in vec3 aNormal;
    
    uniform mat4 uModelViewProjection;
    uniform mat4 uModel;
    uniform mat4 uLightSpaceMatrix;
    
    // Include shared shader chunks
    ${simplexNoise}
    ${windUniforms}
    ${windDisplacement}
    
    out vec2 vTexCoord;
    out vec3 vNormal;
    out vec4 vLightSpacePos;
    out float vWindType;
    out float vHeightFactor;
    out float vDisplacementMag;
    
    void main() {
      vec4 worldPos = uModel * vec4(aPosition, 1.0);
      
      // Calculate height factor for wind (vertices above anchor move more)
      float heightAboveAnchor = max(0.0, worldPos.y - uWindAnchorHeight);
      float heightFactor = clamp(heightAboveAnchor * 0.5, 0.0, 1.0);
      heightFactor = heightFactor * heightFactor; // Quadratic falloff
      
      // Apply wind displacement in world space
      vec3 windOffset = calcWindDisplacement(worldPos.xyz, heightFactor);
      worldPos.xyz += windOffset;
      
      // Recalculate MVP with displaced position
      // We need to transform back to local space first
      mat4 invModel = inverse(uModel);
      vec4 displacedLocal = invModel * worldPos;
      
      gl_Position = uModelViewProjection * vec4(aPosition, 1.0);
      // Apply wind offset in clip space (simpler and avoids matrix issues)
      vec4 worldOffset = vec4(windOffset, 0.0);
      mat4 vp = uModelViewProjection * inverse(uModel);
      gl_Position += vp * worldOffset;
      
      vTexCoord = aTexCoord;
      vNormal = mat3(uModel) * aNormal;
      vLightSpacePos = uLightSpaceMatrix * worldPos;
      
      // Pass debug info to fragment shader
      vWindType = float(uWindType);
      vHeightFactor = heightFactor;
      vDisplacementMag = length(windOffset);
    }
  `;
  
  const fsSource = `#version 300 es
    precision mediump float;
    
    uniform sampler2D uTexture;
    uniform vec4 uBaseColor;
    uniform bool uHasTexture;
    uniform bool uSelected;
    
    // Include shared shader chunks
    ${lightingUniforms}
    ${hdrUniforms}
    ${shadowUniforms}
    
    // Debug uniforms
    uniform int uShadowDebug; // 0=off, 1=depth, 2=lightspace UV, 3=shadow value
    uniform int uWindDebug; // 0=off, 1=wind type, 2=height factor, 3=displacement
    
    // HDR sampling functions
    ${hdrFunctions}
    
    // Shadow calculation functions
    ${shadowFunctions}
    
    // Lighting calculation function
    ${lightingFunction}
    
    // Terrain blend uniforms and functions
    ${terrainBlendUniforms}
    ${terrainBlendFunctions}
    
    in vec2 vTexCoord;
    in vec3 vNormal;
    in vec4 vLightSpacePos;
    in float vWindType;
    in float vHeightFactor;
    in float vDisplacementMag;
    
    out vec4 fragColor;
    
    void main() {
      vec4 color = uBaseColor;
      if (uHasTexture) {
        color = texture(uTexture, vTexCoord) * uBaseColor;
      }
      
      vec3 normal = normalize(vNormal);
      vec3 lightDir = normalize(uLightDir);
      
      vec3 lighting = calcLighting(normal, lightDir, vLightSpacePos);
      vec3 finalColor = color.rgb * lighting;
      
      if (uSelected) {
        finalColor = mix(finalColor, vec3(1.0, 0.4, 0.4), 0.3);
      }
      
      // Debug visualization
      if (uShadowDebug == 1) {
        // Show sampled depth from shadow map at CENTER of texture (should be ~1.0 if cleared properly)
        vec4 centerPacked = texture(uShadowMap, vec2(0.5, 0.5));
        float centerDepth = unpackDepth(centerPacked);
        // Also sample at computed UV
        vec3 projCoords = (vLightSpacePos.xyz / vLightSpacePos.w) * 0.5 + 0.5;
        vec4 packed = texture(uShadowMap, projCoords.xy);
        float depth = unpackDepth(packed);
        // Show center depth in red, computed UV depth in green, raw alpha in blue
        fragColor = vec4(centerDepth, depth, packed.a, 1.0);
        return;
      } else if (uShadowDebug == 2) {
        // Show light-space UV coordinates (R=X, G=Y, B=fragment depth)
        vec3 projCoords = (vLightSpacePos.xyz / vLightSpacePos.w) * 0.5 + 0.5;
        fragColor = vec4(projCoords.xy, projCoords.z, 1.0);
        return;
      } else if (uShadowDebug == 3) {
        // Show shadow value (white=lit, black=shadow)
        float shadowVal = calcShadow(vLightSpacePos, normal, lightDir);
        fragColor = vec4(vec3(shadowVal), 1.0);
        return;
      }
      
      // Wind debug visualization
      if (uWindDebug == 1) {
        // Wind type: Red=none, Green=leaf, Yellow=branch
        vec3 debugColor;
        if (vWindType < 0.5) {
          debugColor = vec3(1.0, 0.0, 0.0); // Red - no wind type
        } else if (vWindType < 1.5) {
          debugColor = vec3(0.0, 1.0, 0.0); // Green - leaf
        } else {
          debugColor = vec3(1.0, 1.0, 0.0); // Yellow - branch
        }
        fragColor = vec4(debugColor, 1.0);
        return;
      } else if (uWindDebug == 2) {
        // Height factor: Black=0, White=1
        fragColor = vec4(vec3(vHeightFactor), 1.0);
        return;
      } else if (uWindDebug == 3) {
        // Displacement magnitude: Blue=0, Red=max
        float normalizedDisp = clamp(vDisplacementMag * 5.0, 0.0, 1.0);
        vec3 debugColor = mix(vec3(0.0, 0.0, 1.0), vec3(1.0, 0.0, 0.0), normalizedDisp);
        fragColor = vec4(debugColor, 1.0);
        return;
      }
      
      vec4 finalFragment = vec4(finalColor, color.a);
      
      // Apply terrain blend if enabled (fade at intersections with other geometry)
      if (uTerrainBlendEnabled == 1) {
        finalFragment = applyTerrainBlend(finalFragment, gl_FragCoord.z);
      }
      
      fragColor = finalFragment;
    }
  `;
  
  // Compile shaders
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
  
  // Get locations - will be updated on shader recompile
  let locations = {
    aPosition: gl.getAttribLocation(program, 'aPosition'),
    aTexCoord: gl.getAttribLocation(program, 'aTexCoord'),
    aNormal: gl.getAttribLocation(program, 'aNormal'),
    uModelViewProjection: gl.getUniformLocation(program, 'uModelViewProjection'),
    uModel: gl.getUniformLocation(program, 'uModel'),
    uTexture: gl.getUniformLocation(program, 'uTexture'),
    uBaseColor: gl.getUniformLocation(program, 'uBaseColor'),
    uHasTexture: gl.getUniformLocation(program, 'uHasTexture'),
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
    uShadowBias: gl.getUniformLocation(program, 'uShadowBias'),
    uShadowDebug: gl.getUniformLocation(program, 'uShadowDebug'),
    uWindDebug: gl.getUniformLocation(program, 'uWindDebug'),
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
    // Terrain blend uniforms
    uTerrainBlendEnabled: gl.getUniformLocation(program, 'uTerrainBlendEnabled'),
    uTerrainBlendDistance: gl.getUniformLocation(program, 'uTerrainBlendDistance'),
    uSceneDepthTexture: gl.getUniformLocation(program, 'uSceneDepthTexture'),
    uScreenSize: gl.getUniformLocation(program, 'uScreenSize'),
    uNearPlane: gl.getUniformLocation(program, 'uNearPlane'),
    uFarPlane: gl.getUniformLocation(program, 'uFarPlane'),
  };
  
  // Function to update uniform locations after shader recompile
  function updateLocations(newProgram) {
    locations = {
      aPosition: gl.getAttribLocation(newProgram, 'aPosition'),
      aTexCoord: gl.getAttribLocation(newProgram, 'aTexCoord'),
      aNormal: gl.getAttribLocation(newProgram, 'aNormal'),
      uModelViewProjection: gl.getUniformLocation(newProgram, 'uModelViewProjection'),
      uModel: gl.getUniformLocation(newProgram, 'uModel'),
      uTexture: gl.getUniformLocation(newProgram, 'uTexture'),
      uBaseColor: gl.getUniformLocation(newProgram, 'uBaseColor'),
      uHasTexture: gl.getUniformLocation(newProgram, 'uHasTexture'),
      uLightDir: gl.getUniformLocation(newProgram, 'uLightDir'),
      uSelected: gl.getUniformLocation(newProgram, 'uSelected'),
      uAmbientIntensity: gl.getUniformLocation(newProgram, 'uAmbientIntensity'),
      uLightColor: gl.getUniformLocation(newProgram, 'uLightColor'),
      uLightMode: gl.getUniformLocation(newProgram, 'uLightMode'),
      uHdrTexture: gl.getUniformLocation(newProgram, 'uHdrTexture'),
      uHasHdr: gl.getUniformLocation(newProgram, 'uHasHdr'),
      uHdrExposure: gl.getUniformLocation(newProgram, 'uHdrExposure'),
      uLightSpaceMatrix: gl.getUniformLocation(newProgram, 'uLightSpaceMatrix'),
      uShadowMap: gl.getUniformLocation(newProgram, 'uShadowMap'),
      uShadowEnabled: gl.getUniformLocation(newProgram, 'uShadowEnabled'),
      uShadowBias: gl.getUniformLocation(newProgram, 'uShadowBias'),
      uShadowDebug: gl.getUniformLocation(newProgram, 'uShadowDebug'),
      uWindDebug: gl.getUniformLocation(newProgram, 'uWindDebug'),
      // Wind uniforms
      uWindEnabled: gl.getUniformLocation(newProgram, 'uWindEnabled'),
      uWindTime: gl.getUniformLocation(newProgram, 'uWindTime'),
      uWindStrength: gl.getUniformLocation(newProgram, 'uWindStrength'),
      uWindDirection: gl.getUniformLocation(newProgram, 'uWindDirection'),
      uWindTurbulence: gl.getUniformLocation(newProgram, 'uWindTurbulence'),
      uWindType: gl.getUniformLocation(newProgram, 'uWindType'),
      uWindInfluence: gl.getUniformLocation(newProgram, 'uWindInfluence'),
      uWindStiffness: gl.getUniformLocation(newProgram, 'uWindStiffness'),
      uWindAnchorHeight: gl.getUniformLocation(newProgram, 'uWindAnchorHeight'),
      uWindPhysicsDisplacement: gl.getUniformLocation(newProgram, 'uWindPhysicsDisplacement'),
      // Terrain blend uniforms
      uTerrainBlendEnabled: gl.getUniformLocation(newProgram, 'uTerrainBlendEnabled'),
      uTerrainBlendDistance: gl.getUniformLocation(newProgram, 'uTerrainBlendDistance'),
      uSceneDepthTexture: gl.getUniformLocation(newProgram, 'uSceneDepthTexture'),
      uScreenSize: gl.getUniformLocation(newProgram, 'uScreenSize'),
      uNearPlane: gl.getUniformLocation(newProgram, 'uNearPlane'),
      uFarPlane: gl.getUniformLocation(newProgram, 'uFarPlane'),
    };
  }
  
  // Register shader with shader manager for hot-reload
  registerShader(shaderName, {
    gl,
    program,
    vsSource,
    fsSource,
    onRecompile: (newProgram) => {
      // Delete old program
      gl.deleteProgram(program);
      program = newProgram;
      updateLocations(newProgram);
    },
  });
  
  // Create buffers for meshes
  const gpuMeshes = glbModel.meshes.map(mesh => {
    const posBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
    
    let uvBuffer = null;
    if (mesh.uvs) {
      uvBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.uvs, gl.STATIC_DRAW);
    }
    
    let normalBuffer = null;
    if (mesh.normals) {
      normalBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
    }
    
    let indexBuffer = null;
    let indexCount = 0;
    let indexType = gl.UNSIGNED_SHORT;
    if (mesh.indices) {
      indexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      if (mesh.indices instanceof Uint32Array) {
        indexType = gl.UNSIGNED_INT;
      }
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      indexCount = mesh.indices.length;
    }
    
    return {
      posBuffer, uvBuffer, normalBuffer, indexBuffer,
      indexCount, indexType,
      vertexCount: mesh.positions.length / 3,
      materialIndex: mesh.materialIndex,
    };
  });
  
  // Create textures
  const gpuTextures = glbModel.textures.map(imageData => {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imageData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return texture;
  });
  
  // Outline shader for selection
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
  
  const mvpMatrix = mat4.create();
  
  function renderOutline(vpMatrix, modelMatrix) {
    mat4.multiply(mvpMatrix, vpMatrix, modelMatrix);
    
    gl.useProgram(outlineProgram);
    gl.uniformMatrix4fv(outlineLocations.uModelViewProjection, false, mvpMatrix);
    gl.uniformMatrix4fv(outlineLocations.uModel, false, modelMatrix);
    gl.uniform1f(outlineLocations.uOutlineWidth, 0.01);
    gl.uniform3fv(outlineLocations.uOutlineColor, [1.0, 0.4, 0.2]); // Orange outline
    
    // Render backfaces only for outline effect
    gl.cullFace(gl.FRONT);
    
    for (const gpuMesh of gpuMeshes) {
      gl.bindBuffer(gl.ARRAY_BUFFER, gpuMesh.posBuffer);
      gl.enableVertexAttribArray(outlineLocations.aPosition);
      gl.vertexAttribPointer(outlineLocations.aPosition, 3, gl.FLOAT, false, 0, 0);
      
      if (gpuMesh.normalBuffer && outlineLocations.aNormal >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, gpuMesh.normalBuffer);
        gl.enableVertexAttribArray(outlineLocations.aNormal);
        gl.vertexAttribPointer(outlineLocations.aNormal, 3, gl.FLOAT, false, 0, 0);
      }
      
      if (gpuMesh.indexBuffer) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gpuMesh.indexBuffer);
        gl.drawElements(gl.TRIANGLES, gpuMesh.indexCount, gpuMesh.indexType, 0);
      } else {
        gl.drawArrays(gl.TRIANGLES, 0, gpuMesh.vertexCount);
      }
    }
    
    // Restore normal culling
    gl.cullFace(gl.BACK);
  }
  
  // Wireframe shader (simple color)
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
  
  // Generate wireframe indices from triangle indices
  const gpuWireframes = gpuMeshes.map((gpuMesh, meshIndex) => {
    const mesh = glbModel.meshes[meshIndex];
    if (!mesh.indices) return null;
    
    // Convert triangles to lines (edge list with duplicates removed via Set)
    const edgeSet = new Set();
    const indices = mesh.indices;
    
    for (let i = 0; i < indices.length; i += 3) {
      const i0 = indices[i], i1 = indices[i + 1], i2 = indices[i + 2];
      // Add edges, always with smaller index first to avoid duplicates
      edgeSet.add(i0 < i1 ? `${i0}-${i1}` : `${i1}-${i0}`);
      edgeSet.add(i1 < i2 ? `${i1}-${i2}` : `${i2}-${i1}`);
      edgeSet.add(i2 < i0 ? `${i2}-${i0}` : `${i0}-${i2}`);
    }
    
    const lineIndices = [];
    for (const edge of edgeSet) {
      const [a, b] = edge.split('-').map(Number);
      lineIndices.push(a, b);
    }
    
    const wireIndexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wireIndexBuffer);
    const wireIndexArray = mesh.indices instanceof Uint32Array 
      ? new Uint32Array(lineIndices)
      : new Uint16Array(lineIndices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, wireIndexArray, gl.STATIC_DRAW);
    
    return {
      buffer: wireIndexBuffer,
      count: lineIndices.length,
      type: mesh.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
    };
  });
  
  function renderWireframe(vpMatrix, modelMatrix, isSelected) {
    mat4.multiply(mvpMatrix, vpMatrix, modelMatrix);
    
    gl.useProgram(wireProgram);
    gl.uniformMatrix4fv(wireLocations.uModelViewProjection, false, mvpMatrix);
    gl.uniform3fv(wireLocations.uColor, isSelected ? [1.0, 0.5, 0.3] : [0.7, 0.7, 0.7]);
    
    for (let i = 0; i < gpuMeshes.length; i++) {
      const gpuMesh = gpuMeshes[i];
      const wireframe = gpuWireframes[i];
      if (!wireframe) continue;
      
      gl.bindBuffer(gl.ARRAY_BUFFER, gpuMesh.posBuffer);
      gl.enableVertexAttribArray(wireLocations.aPosition);
      gl.vertexAttribPointer(wireLocations.aPosition, 3, gl.FLOAT, false, 0, 0);
      
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wireframe.buffer);
      gl.drawElements(gl.LINES, wireframe.count, wireframe.type, 0);
    }
  }
  
  return {
    // Expose gpuMeshes for shadow rendering
    gpuMeshes,
    
    /**
     * Render the model
     * @param {Float32Array} vpMatrix 
     * @param {Float32Array} modelMatrix 
     * @param {boolean} isSelected 
     * @param {boolean} wireframeMode 
     * @param {object} lightParams - { mode: 'sun'|'hdr', sunDir: [x,y,z], ambient: number, lightColor: [r,g,b], hdrTexture: WebGLTexture|null }
     * @param {object} windParams - { enabled, time, strength, direction, turbulence } from wind manager
     * @param {object} objectWindSettings - { enabled, influence, stiffness, anchorHeight, leafMaterialIndices, branchMaterialIndices }
     * @param {object} terrainBlendParams - { enabled, blendDistance, depthTexture, screenSize, nearPlane, farPlane }
     */
    render(vpMatrix, modelMatrix, isSelected, wireframeMode = false, lightParams = null, windParams = null, objectWindSettings = null, terrainBlendParams = null) {
      if (wireframeMode) {
        renderWireframe(vpMatrix, modelMatrix, isSelected);
        return;
      }
      
      // Draw outline first if selected
      if (isSelected) {
        renderOutline(vpMatrix, modelMatrix);
      }
      
      // Default light params
      const light = lightParams || {
        mode: 'sun',
        sunDir: [0.5, 1, 0.5],
        ambient: 0.3,
        lightColor: [1, 1, 1],
        hdrTexture: null,
      };
      
      mat4.multiply(mvpMatrix, vpMatrix, modelMatrix);
      
      gl.useProgram(program);
      gl.uniformMatrix4fv(locations.uModelViewProjection, false, mvpMatrix);
      gl.uniformMatrix4fv(locations.uModel, false, modelMatrix);
      gl.uniform3fv(locations.uLightDir, light.sunDir);
      gl.uniform1i(locations.uSelected, isSelected ? 1 : 0);
      gl.uniform1f(locations.uAmbientIntensity, light.ambient);
      gl.uniform3fv(locations.uLightColor, light.lightColor);
      gl.uniform1i(locations.uLightMode, light.mode === 'hdr' ? 1 : 0);
      gl.uniform1i(locations.uHasHdr, light.hdrTexture ? 1 : 0);
      gl.uniform1f(locations.uHdrExposure, light.hdrExposure || 1.0);
      
      // Shadow uniforms
      gl.uniform1i(locations.uShadowEnabled, light.shadowEnabled ? 1 : 0);
      gl.uniform1f(locations.uShadowBias, light.shadowBias || 0.002);
      gl.uniform1i(locations.uShadowDebug, light.shadowDebug || 0);
      if (light.lightSpaceMatrix) {
        gl.uniformMatrix4fv(locations.uLightSpaceMatrix, false, light.lightSpaceMatrix);
      }
      // Always bind shadow map to texture unit 2 (even if null for debug)
      gl.activeTexture(gl.TEXTURE2);
      if (light.shadowMap) {
        gl.bindTexture(gl.TEXTURE_2D, light.shadowMap);
      }
      gl.uniform1i(locations.uShadowMap, 2);
      
      // Bind HDR texture to unit 1 if available
      if (light.hdrTexture) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, light.hdrTexture);
        gl.uniform1i(locations.uHdrTexture, 1);
      }
      
      // Wind uniforms (global)
      const wind = windParams || { enabled: false, time: 0, strength: 0, direction: [1, 0], turbulence: 0.5, debug: 0 };
      const objWind = objectWindSettings || { enabled: false, influence: 1.0, stiffness: 0.5, anchorHeight: 0, leafMaterialIndices: new Set() };
      
      // Set wind debug mode
      gl.uniform1i(locations.uWindDebug, wind.debug || 0);
      
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
      
      // Terrain blend uniforms
      const terrainBlend = terrainBlendParams || { enabled: false };
      gl.uniform1i(locations.uTerrainBlendEnabled, terrainBlend.enabled ? 1 : 0);
      gl.uniform1f(locations.uTerrainBlendDistance, terrainBlend.blendDistance || 0.5);
      gl.uniform2fv(locations.uScreenSize, terrainBlend.screenSize || [800, 600]);
      gl.uniform1f(locations.uNearPlane, terrainBlend.nearPlane || 0.1);
      gl.uniform1f(locations.uFarPlane, terrainBlend.farPlane || 100.0);
      
      // Bind scene depth texture to unit 3 if terrain blend is enabled
      if (terrainBlend.enabled && terrainBlend.depthTexture) {
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, terrainBlend.depthTexture);
        gl.uniform1i(locations.uSceneDepthTexture, 3);
        
        // Enable blending for terrain blend effect
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      }
      
      for (let meshIdx = 0; meshIdx < gpuMeshes.length; meshIdx++) {
        const gpuMesh = gpuMeshes[meshIdx];
        
        // Determine wind type for this mesh based on material index
        let windType = 0; // 0=none by default
        if (windActive) {
          if (objWind.leafMaterialIndices && objWind.leafMaterialIndices.has(gpuMesh.materialIndex)) {
            windType = 1; // leaf
          } else if (objWind.branchMaterialIndices && objWind.branchMaterialIndices.has(gpuMesh.materialIndex)) {
            windType = 2; // branch
          }
        }
        gl.uniform1i(locations.uWindType, windType);
        
        gl.bindBuffer(gl.ARRAY_BUFFER, gpuMesh.posBuffer);
        gl.enableVertexAttribArray(locations.aPosition);
        gl.vertexAttribPointer(locations.aPosition, 3, gl.FLOAT, false, 0, 0);
        
        if (gpuMesh.uvBuffer && locations.aTexCoord >= 0) {
          gl.bindBuffer(gl.ARRAY_BUFFER, gpuMesh.uvBuffer);
          gl.enableVertexAttribArray(locations.aTexCoord);
          gl.vertexAttribPointer(locations.aTexCoord, 2, gl.FLOAT, false, 0, 0);
        }
        
        if (gpuMesh.normalBuffer && locations.aNormal >= 0) {
          gl.bindBuffer(gl.ARRAY_BUFFER, gpuMesh.normalBuffer);
          gl.enableVertexAttribArray(locations.aNormal);
          gl.vertexAttribPointer(locations.aNormal, 3, gl.FLOAT, false, 0, 0);
        }
        
        const material = glbModel.materials[gpuMesh.materialIndex] || { baseColorFactor: [1, 1, 1, 1] };
        gl.uniform4fv(locations.uBaseColor, material.baseColorFactor);
        
        if (material.baseColorTextureIndex !== undefined && gpuTextures[material.baseColorTextureIndex]) {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, gpuTextures[material.baseColorTextureIndex]);
          gl.uniform1i(locations.uTexture, 0);
          gl.uniform1i(locations.uHasTexture, 1);
        } else {
          gl.uniform1i(locations.uHasTexture, 0);
        }
        
        if (gpuMesh.indexBuffer) {
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gpuMesh.indexBuffer);
          gl.drawElements(gl.TRIANGLES, gpuMesh.indexCount, gpuMesh.indexType, 0);
        } else {
          gl.drawArrays(gl.TRIANGLES, 0, gpuMesh.vertexCount);
        }
      }
      
      // Disable blending if it was enabled for terrain blend
      if (terrainBlend.enabled) {
        gl.disable(gl.BLEND);
      }
    },
    
    destroy() {
      // Unregister from shader manager
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
      gpuMeshes.forEach(m => {
        gl.deleteBuffer(m.posBuffer);
        if (m.uvBuffer) gl.deleteBuffer(m.uvBuffer);
        if (m.normalBuffer) gl.deleteBuffer(m.normalBuffer);
        if (m.indexBuffer) gl.deleteBuffer(m.indexBuffer);
      });
      gpuWireframes.forEach(w => {
        if (w) gl.deleteBuffer(w.buffer);
      });
      gpuTextures.forEach(t => gl.deleteTexture(t));
    },
  };
}
