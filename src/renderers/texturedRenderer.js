import { mat4 } from 'gl-matrix';

const VERTEX_SHADER = `#version 300 es
  precision highp float;
  
  in vec3 aPosition;
  in vec2 aTexCoord;
  in vec3 aNormal;
  
  uniform mat4 uModelViewProjection;
  uniform mat4 uModel;
  
  out vec2 vTexCoord;
  out vec3 vNormal;
  
  void main() {
    gl_Position = uModelViewProjection * vec4(aPosition, 1.0);
    vTexCoord = aTexCoord;
    vNormal = mat3(uModel) * aNormal;
  }
`;

const FRAGMENT_SHADER = `#version 300 es
  precision mediump float;
  
  uniform sampler2D uTexture;
  uniform vec4 uBaseColor;
  uniform bool uHasTexture;
  uniform vec3 uLightDir;
  
  in vec2 vTexCoord;
  in vec3 vNormal;
  
  out vec4 fragColor;
  
  void main() {
    vec4 color = uBaseColor;
    if (uHasTexture) {
      color = texture(uTexture, vTexCoord) * uBaseColor;
    }
    
    // Simple diffuse lighting
    vec3 normal = normalize(vNormal);
    float light = max(dot(normal, normalize(uLightDir)), 0.3);
    
    fragColor = vec4(color.rgb * light, color.a);
  }
`;

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Shader compile error:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl, vertexShader, fragmentShader) {
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Program link error:', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? [
    parseInt(result[1], 16) / 255,
    parseInt(result[2], 16) / 255,
    parseInt(result[3], 16) / 255
  ] : [1, 1, 1];
}

/**
 * Creates a pure WebGL textured renderer for GLB models
 * Only responsible for rendering - no animation loop or controls
 * 
 * @param {HTMLCanvasElement} canvas 
 * @param {object} glbModel - Loaded GLB model with meshes, textures, materials
 * @param {object} options - Optional configuration
 * @returns {object} { render(viewProjectionMatrix, modelMatrix), destroy() }
 */
export function createTexturedRenderer(canvas, glbModel, options = {}) {
  const gl = canvas.getContext('webgl2');
  
  if (!gl) {
    console.error('WebGL 2 not supported');
    return null;
  }
  
  const {
    background = '#0d0d0d',
  } = options;
  
  const bgColor = hexToRgb(background);
  
  // Create shaders
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = createProgram(gl, vertexShader, fragmentShader);
  
  // Get locations
  const aPosition = gl.getAttribLocation(program, 'aPosition');
  const aTexCoord = gl.getAttribLocation(program, 'aTexCoord');
  const aNormal = gl.getAttribLocation(program, 'aNormal');
  const uModelViewProjection = gl.getUniformLocation(program, 'uModelViewProjection');
  const uModel = gl.getUniformLocation(program, 'uModel');
  const uTexture = gl.getUniformLocation(program, 'uTexture');
  const uBaseColor = gl.getUniformLocation(program, 'uBaseColor');
  const uHasTexture = gl.getUniformLocation(program, 'uHasTexture');
  const uLightDir = gl.getUniformLocation(program, 'uLightDir');
  
  // Create GPU resources for meshes
  const gpuMeshes = glbModel.meshes.map((mesh) => {
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
      
      // WebGL 2 supports Uint32 indices natively - no extension needed
      if (mesh.indices instanceof Uint32Array) {
        indexType = gl.UNSIGNED_INT;
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      } else if (mesh.indices instanceof Uint16Array) {
        indexType = gl.UNSIGNED_SHORT;
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      } else {
        indexType = gl.UNSIGNED_SHORT;
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(mesh.indices), gl.STATIC_DRAW);
      }
      indexCount = mesh.indices.length;
    }
    
    return {
      posBuffer,
      uvBuffer,
      normalBuffer,
      indexBuffer,
      indexCount,
      indexType,
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
  
  // MVP matrix for combining
  const mvpMatrix = mat4.create();
  
  // Initial GL state
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(bgColor[0], bgColor[1], bgColor[2], 1.0);
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  
  return {
    /**
     * Render a single frame
     * @param {mat4} viewProjectionMatrix - Combined view-projection matrix
     * @param {mat4} modelMatrix - Model transformation matrix
     */
    render(viewProjectionMatrix, modelMatrix) {
      // Combine matrices: viewProjection * model
      mat4.multiply(mvpMatrix, viewProjectionMatrix, modelMatrix);
      
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      
      gl.useProgram(program);
      gl.uniformMatrix4fv(uModelViewProjection, false, mvpMatrix);
      gl.uniformMatrix4fv(uModel, false, modelMatrix);
      gl.uniform3fv(uLightDir, [0.5, 1, 0.5]);
      
      // Draw each mesh
      for (const gpuMesh of gpuMeshes) {
        // Bind position
        gl.bindBuffer(gl.ARRAY_BUFFER, gpuMesh.posBuffer);
        gl.enableVertexAttribArray(aPosition);
        gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
        
        // Bind UVs
        if (gpuMesh.uvBuffer && aTexCoord >= 0) {
          gl.bindBuffer(gl.ARRAY_BUFFER, gpuMesh.uvBuffer);
          gl.enableVertexAttribArray(aTexCoord);
          gl.vertexAttribPointer(aTexCoord, 2, gl.FLOAT, false, 0, 0);
        } else if (aTexCoord >= 0) {
          gl.disableVertexAttribArray(aTexCoord);
        }
        
        // Bind normals
        if (gpuMesh.normalBuffer && aNormal >= 0) {
          gl.bindBuffer(gl.ARRAY_BUFFER, gpuMesh.normalBuffer);
          gl.enableVertexAttribArray(aNormal);
          gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);
        } else if (aNormal >= 0) {
          gl.disableVertexAttribArray(aNormal);
        }
        
        // Material
        const material = glbModel.materials[gpuMesh.materialIndex] || { baseColorFactor: [1, 1, 1, 1] };
        gl.uniform4fv(uBaseColor, material.baseColorFactor);
        
        // Texture
        if (material.baseColorTextureIndex !== undefined && gpuTextures[material.baseColorTextureIndex]) {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, gpuTextures[material.baseColorTextureIndex]);
          gl.uniform1i(uTexture, 0);
          gl.uniform1i(uHasTexture, 1);
        } else {
          gl.uniform1i(uHasTexture, 0);
        }
        
        // Draw
        if (gpuMesh.indexBuffer) {
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gpuMesh.indexBuffer);
          gl.drawElements(gl.TRIANGLES, gpuMesh.indexCount, gpuMesh.indexType, 0);
        } else {
          gl.drawArrays(gl.TRIANGLES, 0, gpuMesh.vertexCount);
        }
      }
    },
    
    /**
     * Clean up WebGL resources
     */
    destroy() {
      for (const gpuMesh of gpuMeshes) {
        gl.deleteBuffer(gpuMesh.posBuffer);
        if (gpuMesh.uvBuffer) gl.deleteBuffer(gpuMesh.uvBuffer);
        if (gpuMesh.normalBuffer) gl.deleteBuffer(gpuMesh.normalBuffer);
        if (gpuMesh.indexBuffer) gl.deleteBuffer(gpuMesh.indexBuffer);
      }
      for (const texture of gpuTextures) {
        gl.deleteTexture(texture);
      }
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
    },
  };
}
