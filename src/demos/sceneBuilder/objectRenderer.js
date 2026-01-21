import { mat4 } from 'gl-matrix';
import { registerShader, unregisterShader } from './shaderManager.js';
import { windComplete, shadowUniforms, shadowFunctions, hdrUniforms, lightingUniforms, pbrFunctions, iblFunctions, pbrLighting, terrainBlendComplete, toneMappingComplete } from './shaderChunks.js';

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
    in vec4 aTangent; // xyz = tangent direction, w = handedness (-1 or 1)
    
    uniform mat4 uModelViewProjection;
    uniform mat4 uModel;
    uniform mat4 uLightSpaceMatrix;
    uniform bool uHasTangent;
    
    // Include wind system (noise + uniforms + displacement)
    ${windComplete}
    
    out vec2 vTexCoord;
    out vec3 vNormal;
    out vec3 vWorldPos;
    out vec4 vLightSpacePos;
    out float vWindType;
    out float vHeightFactor;
    out float vDisplacementMag;
    out mat3 vTBN; // Tangent-Bitangent-Normal matrix
    out float vHasTangent;
    
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
      vec3 N = normalize(mat3(uModel) * aNormal);
      vNormal = N;
      vWorldPos = worldPos.xyz;
      vLightSpacePos = uLightSpaceMatrix * worldPos;
      
      // Compute TBN matrix if tangent data is available
      vHasTangent = uHasTangent ? 1.0 : 0.0;
      if (uHasTangent) {
        vec3 T = normalize(mat3(uModel) * aTangent.xyz);
        // Re-orthogonalize T with respect to N
        T = normalize(T - dot(T, N) * N);
        // Compute bitangent with handedness
        vec3 B = cross(N, T) * aTangent.w;
        vTBN = mat3(T, B, N);
      } else {
        vTBN = mat3(1.0); // Identity, will use fallback in fragment shader
      }
      
      // Pass debug info to fragment shader
      vWindType = float(uWindType);
      vHeightFactor = heightFactor;
      vDisplacementMag = length(windOffset);
    }
  `;
  
  const fsSource = `#version 300 es
    precision highp float;
    
    uniform sampler2D uTexture;
    uniform sampler2D uMetallicRoughnessTexture;
    uniform sampler2D uNormalTexture;
    uniform sampler2D uOcclusionTexture;
    uniform sampler2D uEmissiveTexture;
    uniform vec4 uBaseColor;
    uniform bool uHasTexture;
    uniform bool uHasMetallicRoughnessTexture;
    uniform bool uHasNormalTexture;
    uniform bool uHasOcclusionTexture;
    uniform bool uHasEmissiveTexture;
    uniform float uMetallicFactor;
    uniform float uRoughnessFactor;
    uniform float uNormalScale;
    uniform float uOcclusionStrength;
    uniform vec3 uEmissiveFactor;
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
    
    // Debug uniforms
    uniform int uShadowDebug; // 0=off, 1=depth, 2=lightspace UV, 3=shadow value
    uniform int uWindDebug; // 0=off, 1=wind type, 2=height factor, 3=displacement
    
    // Terrain blend (uniforms + functions)
    ${terrainBlendComplete}
    
    // Tone mapping
    ${toneMappingComplete}
    
    in vec2 vTexCoord;
    in vec3 vNormal;
    in vec3 vWorldPos;
    in vec4 vLightSpacePos;
    in float vWindType;
    in float vHeightFactor;
    in float vDisplacementMag;
    in mat3 vTBN;
    in float vHasTangent;
    
    out vec4 fragColor;
    
    void main() {
      vec4 color = uBaseColor;
      if (uHasTexture) {
        color = texture(uTexture, vTexCoord) * uBaseColor;
      }
      
      vec3 N = normalize(vNormal);
      
      // Apply normal map if available
      if (uHasNormalTexture) {
        vec3 normalMap = texture(uNormalTexture, vTexCoord).rgb * 2.0 - 1.0;
        normalMap.xy *= uNormalScale;
        
        // Use vertex TBN if available, otherwise fall back to screen-space derivatives
        if (vHasTangent > 0.5) {
          // Use pre-computed TBN from vertex shader (more accurate)
          N = normalize(vTBN * normalMap);
        } else {
          // Fallback: approximate tangent frame from screen-space derivatives
          vec3 dp1 = dFdx(vWorldPos);
          vec3 dp2 = dFdy(vWorldPos);
          vec2 duv1 = dFdx(vTexCoord);
          vec2 duv2 = dFdy(vTexCoord);
          
          vec3 dp2perp = cross(dp2, N);
          vec3 dp1perp = cross(N, dp1);
          vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
          vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
          
          float invmax = inversesqrt(max(dot(T, T), dot(B, B)));
          mat3 TBN = mat3(T * invmax, B * invmax, N);
          
          N = normalize(TBN * normalMap);
        }
      }
      
      vec3 V = normalize(uCameraPos - vWorldPos);
      
      // GLB models: use base color as albedo
      vec3 albedo = color.rgb;
      
      // Sample metallic-roughness from texture if available
      // glTF spec: roughness is in G channel, metallic is in B channel
      float metallic = uMetallicFactor;
      float roughness = uRoughnessFactor;
      if (uHasMetallicRoughnessTexture) {
        vec4 mrSample = texture(uMetallicRoughnessTexture, vTexCoord);
        roughness *= mrSample.g;
        metallic *= mrSample.b;
      }
      
      // Sample ambient occlusion
      float ao = 1.0;
      if (uHasOcclusionTexture) {
        ao = texture(uOcclusionTexture, vTexCoord).r;
        ao = mix(1.0, ao, uOcclusionStrength);
      }
      
      vec3 finalColor = calcPBRLighting(
        N, V, vWorldPos,
        albedo, metallic, roughness,
        uLightDir, uLightColor, uAmbientIntensity,
        uLightMode, uHdrTexture, uHasHdr, uHdrExposure,
        uShadowMap, uShadowEnabled, vLightSpacePos
      );
      
      // Apply ambient occlusion to the final lighting
      finalColor *= ao;
      
      // Add emissive contribution (before tone mapping)
      if (uHasEmissiveTexture) {
        vec3 emissive = texture(uEmissiveTexture, vTexCoord).rgb * uEmissiveFactor;
        finalColor += emissive;
      } else if (length(uEmissiveFactor) > 0.0) {
        finalColor += uEmissiveFactor;
      }
      
      // Apply tone mapping
      finalColor = applyToneMapping(finalColor, uToneMapping);
      
      // Gamma correction
      finalColor = pow(finalColor, vec3(1.0 / 2.2));
      
      // Selection highlighting is done via outline only (no fill tint)
      
      // Debug visualization
      if (uShadowDebug == 1) {
        vec3 lightDir = normalize(uLightDir);
        vec4 centerPacked = texture(uShadowMap, vec2(0.5, 0.5));
        float centerDepth = unpackDepth(centerPacked);
        vec3 projCoords = (vLightSpacePos.xyz / vLightSpacePos.w) * 0.5 + 0.5;
        vec4 packed = texture(uShadowMap, projCoords.xy);
        float depth = unpackDepth(packed);
        fragColor = vec4(centerDepth, depth, packed.a, 1.0);
        return;
      } else if (uShadowDebug == 2) {
        vec3 projCoords = (vLightSpacePos.xyz / vLightSpacePos.w) * 0.5 + 0.5;
        fragColor = vec4(projCoords.xy, projCoords.z, 1.0);
        return;
      } else if (uShadowDebug == 3) {
        vec3 lightDir = normalize(uLightDir);
        float shadowVal = calcShadow(vLightSpacePos, N, lightDir);
        fragColor = vec4(vec3(shadowVal), 1.0);
        return;
      }
      
      // Wind debug visualization
      if (uWindDebug == 1) {
        vec3 debugColor;
        if (vWindType < 0.5) {
          debugColor = vec3(1.0, 0.0, 0.0);
        } else if (vWindType < 1.5) {
          debugColor = vec3(0.0, 1.0, 0.0);
        } else {
          debugColor = vec3(1.0, 1.0, 0.0);
        }
        fragColor = vec4(debugColor, 1.0);
        return;
      } else if (uWindDebug == 2) {
        fragColor = vec4(vec3(vHeightFactor), 1.0);
        return;
      } else if (uWindDebug == 3) {
        float normalizedDisp = clamp(vDisplacementMag * 5.0, 0.0, 1.0);
        vec3 debugColor = mix(vec3(0.0, 0.0, 1.0), vec3(1.0, 0.0, 0.0), normalizedDisp);
        fragColor = vec4(debugColor, 1.0);
        return;
      }
      
      vec4 finalFragment = vec4(finalColor, color.a);
      
      // Apply terrain blend if enabled
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

  // Get locations - will be updated on shader recompile
  const mapShaderLocations = (shaderProgram) => ({
    aPosition: gl.getAttribLocation(shaderProgram, 'aPosition'),
    aTexCoord: gl.getAttribLocation(shaderProgram, 'aTexCoord'),
    aNormal: gl.getAttribLocation(shaderProgram, 'aNormal'),
    aTangent: gl.getAttribLocation(shaderProgram, 'aTangent'),
    uHasTangent: gl.getUniformLocation(shaderProgram, 'uHasTangent'),
    uModelViewProjection: gl.getUniformLocation(shaderProgram, 'uModelViewProjection'),
    uModel: gl.getUniformLocation(shaderProgram, 'uModel'),
    uTexture: gl.getUniformLocation(shaderProgram, 'uTexture'),
    uBaseColor: gl.getUniformLocation(shaderProgram, 'uBaseColor'),
    uHasTexture: gl.getUniformLocation(shaderProgram, 'uHasTexture'),
    uLightDir: gl.getUniformLocation(shaderProgram, 'uLightDir'),
    uSelected: gl.getUniformLocation(shaderProgram, 'uSelected'),
    uAmbientIntensity: gl.getUniformLocation(shaderProgram, 'uAmbientIntensity'),
    uLightColor: gl.getUniformLocation(shaderProgram, 'uLightColor'),
    uSkyColor: gl.getUniformLocation(shaderProgram, 'uSkyColor'),
    uGroundColor: gl.getUniformLocation(shaderProgram, 'uGroundColor'),
    uLightMode: gl.getUniformLocation(shaderProgram, 'uLightMode'),
    uHdrTexture: gl.getUniformLocation(shaderProgram, 'uHdrTexture'),
    uHasHdr: gl.getUniformLocation(shaderProgram, 'uHasHdr'),
    uHdrExposure: gl.getUniformLocation(shaderProgram, 'uHdrExposure'),
    uLightSpaceMatrix: gl.getUniformLocation(shaderProgram, 'uLightSpaceMatrix'),
    uShadowMap: gl.getUniformLocation(shaderProgram, 'uShadowMap'),
    uShadowEnabled: gl.getUniformLocation(shaderProgram, 'uShadowEnabled'),
    uShadowBias: gl.getUniformLocation(shaderProgram, 'uShadowBias'),
    uShadowDebug: gl.getUniformLocation(shaderProgram, 'uShadowDebug'),
    uWindDebug: gl.getUniformLocation(shaderProgram, 'uWindDebug'),
    // Wind uniforms
    uWindEnabled: gl.getUniformLocation(shaderProgram, 'uWindEnabled'),
    uWindTime: gl.getUniformLocation(shaderProgram, 'uWindTime'),
    uWindStrength: gl.getUniformLocation(shaderProgram, 'uWindStrength'),
    uWindDirection: gl.getUniformLocation(shaderProgram, 'uWindDirection'),
    uWindTurbulence: gl.getUniformLocation(shaderProgram, 'uWindTurbulence'),
    uWindType: gl.getUniformLocation(shaderProgram, 'uWindType'),
    uWindInfluence: gl.getUniformLocation(shaderProgram, 'uWindInfluence'),
    uWindStiffness: gl.getUniformLocation(shaderProgram, 'uWindStiffness'),
    uWindAnchorHeight: gl.getUniformLocation(shaderProgram, 'uWindAnchorHeight'),
    uWindPhysicsDisplacement: gl.getUniformLocation(shaderProgram, 'uWindPhysicsDisplacement'),
    // Terrain blend uniforms
    uTerrainBlendEnabled: gl.getUniformLocation(shaderProgram, 'uTerrainBlendEnabled'),
    uTerrainBlendDistance: gl.getUniformLocation(shaderProgram, 'uTerrainBlendDistance'),
    uSceneDepthTexture: gl.getUniformLocation(shaderProgram, 'uSceneDepthTexture'),
    uScreenSize: gl.getUniformLocation(shaderProgram, 'uScreenSize'),
    uNearPlane: gl.getUniformLocation(shaderProgram, 'uNearPlane'),
    uFarPlane: gl.getUniformLocation(shaderProgram, 'uFarPlane'),
    uCameraPos: gl.getUniformLocation(shaderProgram, 'uCameraPos'),
    // PBR material uniforms
    uMetallicRoughnessTexture: gl.getUniformLocation(shaderProgram, 'uMetallicRoughnessTexture'),
    uHasMetallicRoughnessTexture: gl.getUniformLocation(shaderProgram, 'uHasMetallicRoughnessTexture'),
    uMetallicFactor: gl.getUniformLocation(shaderProgram, 'uMetallicFactor'),
    uRoughnessFactor: gl.getUniformLocation(shaderProgram, 'uRoughnessFactor'),
    // Normal map
    uNormalTexture: gl.getUniformLocation(shaderProgram, 'uNormalTexture'),
    uHasNormalTexture: gl.getUniformLocation(shaderProgram, 'uHasNormalTexture'),
    uNormalScale: gl.getUniformLocation(shaderProgram, 'uNormalScale'),
    // Occlusion
    uOcclusionTexture: gl.getUniformLocation(shaderProgram, 'uOcclusionTexture'),
    uHasOcclusionTexture: gl.getUniformLocation(shaderProgram, 'uHasOcclusionTexture'),
    uOcclusionStrength: gl.getUniformLocation(shaderProgram, 'uOcclusionStrength'),
    // Emissive
    uEmissiveTexture: gl.getUniformLocation(shaderProgram, 'uEmissiveTexture'),
    uHasEmissiveTexture: gl.getUniformLocation(shaderProgram, 'uHasEmissiveTexture'),
    uEmissiveFactor: gl.getUniformLocation(shaderProgram, 'uEmissiveFactor'),
    // Tone mapping
    uToneMapping: gl.getUniformLocation(shaderProgram, 'uToneMapping'),
  });
  
  let program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  // Get locations - will be updated on shader recompile
  let locations = mapShaderLocations(program);
  
  // Function to update uniform locations after shader recompile
  function updateLocations(newProgram) {
    locations = mapShaderLocations(newProgram);
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
    
    let tangentBuffer = null;
    if (mesh.tangents) {
      tangentBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, tangentBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.tangents, gl.STATIC_DRAW);
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
      posBuffer, uvBuffer, normalBuffer, tangentBuffer, indexBuffer,
      indexCount, indexType,
      vertexCount: mesh.positions.length / 3,
      materialIndex: mesh.materialIndex,
    };
  });
  
  // Identify which texture indices are used for sRGB color data (base color, emissive)
  // vs linear data (metallic-roughness, normal, occlusion)
  const srgbTextureIndices = new Set();
  for (const material of glbModel.materials) {
    if (material.baseColorTextureIndex !== undefined) {
      srgbTextureIndices.add(material.baseColorTextureIndex);
    }
    if (material.emissiveTextureIndex !== undefined) {
      srgbTextureIndices.add(material.emissiveTextureIndex);
    }
    // Note: metallic-roughness, normal, occlusion stay linear (data textures)
  }
  
  // Create textures with proper wrapping, mipmaps, and color space
  const gpuTextures = glbModel.textures.map((imageData, index) => {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    
    // Use SRGB8_ALPHA8 for color textures (base color, emissive)
    // This tells GPU to convert sRGB→linear when sampling
    // Use RGBA for data textures (metallic-roughness, normal, occlusion)
    const isSrgb = srgbTextureIndices.has(index);
    const internalFormat = isSrgb ? gl.SRGB8_ALPHA8 : gl.RGBA;
    
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, gl.RGBA, gl.UNSIGNED_BYTE, imageData);
    
    // Generate mipmaps for better filtering
    gl.generateMipmap(gl.TEXTURE_2D);
    
    // Use REPEAT wrapping (most GLB models expect this)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    
    // Use trilinear filtering with mipmaps
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
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
      gl.uniform3fv(locations.uSkyColor, light.skyColor || [0.4, 0.6, 1.0]);
      gl.uniform3fv(locations.uGroundColor, light.groundColor || [0.3, 0.25, 0.2]);
      gl.uniform1i(locations.uLightMode, light.mode === 'hdr' ? 1 : 0);
      gl.uniform1i(locations.uHasHdr, light.hdrTexture ? 1 : 0);
      gl.uniform1f(locations.uHdrExposure, light.hdrExposure || 1.0);
      gl.uniform3fv(locations.uCameraPos, light.cameraPos || [0, 0, 5]);
      gl.uniform1i(locations.uToneMapping, light.toneMapping !== undefined ? light.toneMapping : 3); // Default ACES
      
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
        
        // Tangent attribute for proper normal mapping (vec4: xyz=tangent, w=handedness)
        if (gpuMesh.tangentBuffer && locations.aTangent >= 0) {
          gl.bindBuffer(gl.ARRAY_BUFFER, gpuMesh.tangentBuffer);
          gl.enableVertexAttribArray(locations.aTangent);
          gl.vertexAttribPointer(locations.aTangent, 4, gl.FLOAT, false, 0, 0);
          gl.uniform1i(locations.uHasTangent, 1);
        } else {
          if (locations.aTangent >= 0) {
            gl.disableVertexAttribArray(locations.aTangent);
          }
          gl.uniform1i(locations.uHasTangent, 0);
        }
        
        const material = glbModel.materials[gpuMesh.materialIndex] || { 
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 0.0,
          roughnessFactor: 0.5
        };
        gl.uniform4fv(locations.uBaseColor, material.baseColorFactor);
        
        // PBR factors
        gl.uniform1f(locations.uMetallicFactor, material.metallicFactor ?? 0.0);
        gl.uniform1f(locations.uRoughnessFactor, material.roughnessFactor ?? 0.5);
        
        // Base color texture
        if (material.baseColorTextureIndex !== undefined && gpuTextures[material.baseColorTextureIndex]) {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, gpuTextures[material.baseColorTextureIndex]);
          gl.uniform1i(locations.uTexture, 0);
          gl.uniform1i(locations.uHasTexture, 1);
        } else {
          gl.uniform1i(locations.uHasTexture, 0);
        }
        
        // Metallic-roughness texture (glTF: G=roughness, B=metallic)
        if (material.metallicRoughnessTextureIndex !== undefined && gpuTextures[material.metallicRoughnessTextureIndex]) {
          gl.activeTexture(gl.TEXTURE4);
          gl.bindTexture(gl.TEXTURE_2D, gpuTextures[material.metallicRoughnessTextureIndex]);
          gl.uniform1i(locations.uMetallicRoughnessTexture, 4);
          gl.uniform1i(locations.uHasMetallicRoughnessTexture, 1);
        } else {
          gl.uniform1i(locations.uHasMetallicRoughnessTexture, 0);
        }
        
        // Normal map texture
        if (material.normalTextureIndex !== undefined && gpuTextures[material.normalTextureIndex]) {
          gl.activeTexture(gl.TEXTURE5);
          gl.bindTexture(gl.TEXTURE_2D, gpuTextures[material.normalTextureIndex]);
          gl.uniform1i(locations.uNormalTexture, 5);
          gl.uniform1i(locations.uHasNormalTexture, 1);
          gl.uniform1f(locations.uNormalScale, material.normalScale ?? 1.0);
        } else {
          gl.uniform1i(locations.uHasNormalTexture, 0);
          gl.uniform1f(locations.uNormalScale, 1.0);
        }
        
        // Occlusion texture (R channel)
        if (material.occlusionTextureIndex !== undefined && gpuTextures[material.occlusionTextureIndex]) {
          gl.activeTexture(gl.TEXTURE6);
          gl.bindTexture(gl.TEXTURE_2D, gpuTextures[material.occlusionTextureIndex]);
          gl.uniform1i(locations.uOcclusionTexture, 6);
          gl.uniform1i(locations.uHasOcclusionTexture, 1);
          gl.uniform1f(locations.uOcclusionStrength, material.occlusionStrength ?? 1.0);
        } else {
          gl.uniform1i(locations.uHasOcclusionTexture, 0);
          gl.uniform1f(locations.uOcclusionStrength, 1.0);
        }
        
        // Emissive texture
        if (material.emissiveTextureIndex !== undefined && gpuTextures[material.emissiveTextureIndex]) {
          gl.activeTexture(gl.TEXTURE7);
          gl.bindTexture(gl.TEXTURE_2D, gpuTextures[material.emissiveTextureIndex]);
          gl.uniform1i(locations.uEmissiveTexture, 7);
          gl.uniform1i(locations.uHasEmissiveTexture, 1);
          gl.uniform3fv(locations.uEmissiveFactor, material.emissiveFactor || [1, 1, 1]);
        } else {
          gl.uniform1i(locations.uHasEmissiveTexture, 0);
          gl.uniform3fv(locations.uEmissiveFactor, material.emissiveFactor || [0, 0, 0]);
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
        if (m.tangentBuffer) gl.deleteBuffer(m.tangentBuffer);
        if (m.indexBuffer) gl.deleteBuffer(m.indexBuffer);
      });
      gpuWireframes.forEach(w => {
        if (w) gl.deleteBuffer(w.buffer);
      });
      gpuTextures.forEach(t => gl.deleteTexture(t));
    },
  };
}
