import { mat4 } from 'gl-matrix';

/**
 * Creates a renderer for a GLB model in the scene
 */
export function createObjectRenderer(gl, glbModel) {
  // Vertex shader
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
    out vec4 vLightSpacePos;
    
    void main() {
      vec4 worldPos = uModel * vec4(aPosition, 1.0);
      gl_Position = uModelViewProjection * vec4(aPosition, 1.0);
      vTexCoord = aTexCoord;
      vNormal = mat3(uModel) * aNormal;
      vLightSpacePos = uLightSpaceMatrix * worldPos;
    }
  `;
  
  const fsSource = `#version 300 es
    precision mediump float;
    
    uniform sampler2D uTexture;
    uniform vec4 uBaseColor;
    uniform bool uHasTexture;
    uniform vec3 uLightDir;
    uniform bool uSelected;
    
    // Lighting uniforms
    uniform float uAmbientIntensity;
    uniform vec3 uLightColor;
    uniform int uLightMode; // 0 = sun, 1 = HDR
    uniform sampler2D uHdrTexture;
    uniform int uHasHdr;
    uniform float uHdrExposure;
    
    // Shadow uniforms
    uniform highp sampler2D uShadowMap;
    uniform int uShadowEnabled;
    
    in vec2 vTexCoord;
    in vec3 vNormal;
    in vec4 vLightSpacePos;
    
    out vec4 fragColor;
    
    const float PI = 3.14159265359;
    
    vec2 dirToEquirect(vec3 dir) {
      float phi = atan(dir.z, dir.x);
      float theta = asin(clamp(dir.y, -1.0, 1.0));
      return vec2(phi / (2.0 * PI) + 0.5, theta / PI + 0.5);
    }
    
    vec3 sampleHDR(vec3 dir, float exposure) {
      vec2 uv = dirToEquirect(dir);
      vec3 hdrColor = texture(uHdrTexture, uv).rgb * exposure;
      // Reinhard tone mapping
      return hdrColor / (hdrColor + vec3(1.0));
    }
    
    // Sample HDR in multiple directions for diffuse irradiance approximation
    vec3 sampleHDRDiffuse(vec3 normal, float exposure) {
      // Main direction
      vec3 result = sampleHDR(normal, exposure) * 0.5;
      
      // Sample in offset directions for softer ambient
      vec3 tangent = normalize(cross(normal, abs(normal.y) < 0.9 ? vec3(0,1,0) : vec3(1,0,0)));
      vec3 bitangent = cross(normal, tangent);
      
      // 4 offset samples at 45 degrees
      result += sampleHDR(normalize(normal + tangent * 0.7), exposure) * 0.125;
      result += sampleHDR(normalize(normal - tangent * 0.7), exposure) * 0.125;
      result += sampleHDR(normalize(normal + bitangent * 0.7), exposure) * 0.125;
      result += sampleHDR(normalize(normal - bitangent * 0.7), exposure) * 0.125;
      
      return result;
    }
    
    // PCF shadow sampling with manual depth comparison
    float calcShadow(vec4 lightSpacePos, vec3 normal, vec3 lightDir) {
      // Perspective divide
      vec3 projCoords = lightSpacePos.xyz / lightSpacePos.w;
      
      // Transform to [0,1] range
      projCoords = projCoords * 0.5 + 0.5;
      
      // Check if outside shadow map
      if (projCoords.z > 1.0 || projCoords.x < 0.0 || projCoords.x > 1.0 || 
          projCoords.y < 0.0 || projCoords.y > 1.0) {
        return 1.0; // No shadow outside map
      }
      
      // Slope-scaled bias
      float NdotL = max(dot(normal, lightDir), 0.0);
      float bias = 0.002 + 0.01 * (1.0 - NdotL);
      
      float currentDepth = projCoords.z;
      
      // PCF: sample 3x3 around current position with manual comparison
      float shadow = 0.0;
      vec2 texelSize = vec2(1.0 / 2048.0);
      
      for (int x = -1; x <= 1; x++) {
        for (int y = -1; y <= 1; y++) {
          float sampledDepth = texture(uShadowMap, projCoords.xy + vec2(x, y) * texelSize).r;
          shadow += currentDepth - bias > sampledDepth ? 0.0 : 1.0;
        }
      }
      shadow /= 9.0;
      
      return shadow;
    }
    
    void main() {
      vec4 color = uBaseColor;
      if (uHasTexture) {
        color = texture(uTexture, vTexCoord) * uBaseColor;
      }
      
      vec3 normal = normalize(vNormal);
      vec3 lightDir = normalize(uLightDir);
      
      vec3 lighting;
      
      if (uLightMode == 1 && uHasHdr == 1) {
        // HDR mode: sample environment for diffuse irradiance
        vec3 diffuseIBL = sampleHDRDiffuse(normal, uHdrExposure);
        
        // Add subtle directional highlight from up direction
        float upFactor = max(dot(normal, vec3(0.0, 1.0, 0.0)), 0.0);
        vec3 skyContrib = sampleHDR(vec3(0.0, 1.0, 0.0), uHdrExposure) * upFactor * 0.3;
        
        lighting = diffuseIBL + skyContrib;
      } else {
        // Sun mode
        vec3 ambient = vec3(uAmbientIntensity);
        float NdotL = max(dot(normal, lightDir), 0.0);
        vec3 diffuse = uLightColor * NdotL;
        
        // Apply shadow with slope-scaled bias
        float shadow = 1.0;
        if (uShadowEnabled == 1) {
          shadow = calcShadow(vLightSpacePos, normal, lightDir);
        }
        
        lighting = ambient + diffuse * shadow;
      }
      
      vec3 finalColor = color.rgb * lighting;
      
      if (uSelected) {
        finalColor = mix(finalColor, vec3(1.0, 0.4, 0.4), 0.3);
      }
      
      fragColor = vec4(finalColor, color.a);
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
  
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  
  // Get locations
  const locations = {
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
  };
  
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
     */
    render(vpMatrix, modelMatrix, isSelected, wireframeMode = false, lightParams = null) {
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
      if (light.shadowMap && light.lightSpaceMatrix) {
        gl.uniformMatrix4fv(locations.uLightSpaceMatrix, false, light.lightSpaceMatrix);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, light.shadowMap);
        gl.uniform1i(locations.uShadowMap, 2);
      }
      
      // Bind HDR texture to unit 1 if available
      if (light.hdrTexture) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, light.hdrTexture);
        gl.uniform1i(locations.uHdrTexture, 1);
      }
      
      for (const gpuMesh of gpuMeshes) {
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
    },
    
    destroy() {
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
