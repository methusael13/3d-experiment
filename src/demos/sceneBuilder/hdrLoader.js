/**
 * HDR (Radiance RGBE) file loader
 * Parses .hdr files and returns Float32Array RGB data
 */

/**
 * Load and parse an HDR file
 * @param {string} url - URL to the .hdr file
 * @returns {Promise<{width: number, height: number, data: Float32Array}>}
 */
export async function loadHDR(url) {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  return parseHDR(buffer);
}

/**
 * Parse HDR from ArrayBuffer
 * @param {ArrayBuffer} buffer 
 * @returns {{width: number, height: number, data: Float32Array}}
 */
export function parseHDR(buffer) {
  const bytes = new Uint8Array(buffer);
  let pos = 0;
  
  // Read header line by line
  function readLine() {
    let line = '';
    while (pos < bytes.length) {
      const char = String.fromCharCode(bytes[pos++]);
      if (char === '\n') break;
      if (char !== '\r') line += char;
    }
    return line;
  }
  
  // Verify magic number
  const magic = readLine();
  if (!magic.startsWith('#?RADIANCE') && !magic.startsWith('#?RGBE')) {
    throw new Error('Invalid HDR format: missing RADIANCE header');
  }
  
  // Parse header
  let format = null;
  let exposure = 1.0;
  
  while (pos < bytes.length) {
    const line = readLine();
    if (line === '') break; // Empty line marks end of header
    
    if (line.startsWith('FORMAT=')) {
      format = line.substring(7);
    } else if (line.startsWith('EXPOSURE=')) {
      exposure = parseFloat(line.substring(9));
    }
  }
  
  if (format !== '32-bit_rle_rgbe' && format !== '32-bit_rle_xyze') {
    console.warn('HDR format:', format, '- assuming RGBE');
  }
  
  // Parse resolution line: -Y height +X width
  const resLine = readLine();
  const resMatch = resLine.match(/-Y (\d+) \+X (\d+)/);
  if (!resMatch) {
    throw new Error('Invalid HDR resolution line: ' + resLine);
  }
  
  const height = parseInt(resMatch[1], 10);
  const width = parseInt(resMatch[2], 10);
  
  // Parse pixel data (RLE encoded)
  const pixels = new Float32Array(width * height * 3);
  
  for (let y = 0; y < height; y++) {
    const scanline = readScanline(bytes, pos, width);
    pos = scanline.newPos;
    
    // Convert RGBE to float RGB
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const j = x * 4;
      
      const r = scanline.data[j];
      const g = scanline.data[j + 1];
      const b = scanline.data[j + 2];
      const e = scanline.data[j + 3];
      
      if (e === 0) {
        pixels[i] = 0;
        pixels[i + 1] = 0;
        pixels[i + 2] = 0;
      } else {
        const scale = Math.pow(2, e - 128 - 8) / exposure;
        pixels[i] = r * scale;
        pixels[i + 1] = g * scale;
        pixels[i + 2] = b * scale;
      }
    }
  }
  
  return { width, height, data: pixels };
}

/**
 * Read one scanline of RGBE data (handles RLE compression)
 */
function readScanline(bytes, pos, width) {
  const data = new Uint8Array(width * 4);
  
  // Check for new RLE format
  if (bytes[pos] === 2 && bytes[pos + 1] === 2) {
    // New RLE format
    const scanWidth = (bytes[pos + 2] << 8) | bytes[pos + 3];
    if (scanWidth !== width) {
      throw new Error('Scanline width mismatch');
    }
    pos += 4;
    
    // Read each channel separately (RGBE as 4 separate runs)
    for (let ch = 0; ch < 4; ch++) {
      let x = 0;
      while (x < width) {
        const code = bytes[pos++];
        if (code > 128) {
          // Run of same value
          const count = code - 128;
          const value = bytes[pos++];
          for (let i = 0; i < count; i++) {
            data[x * 4 + ch] = value;
            x++;
          }
        } else {
          // Run of different values
          for (let i = 0; i < code; i++) {
            data[x * 4 + ch] = bytes[pos++];
            x++;
          }
        }
      }
    }
  } else {
    // Old format (uncompressed or old RLE)
    for (let x = 0; x < width; x++) {
      data[x * 4] = bytes[pos++];
      data[x * 4 + 1] = bytes[pos++];
      data[x * 4 + 2] = bytes[pos++];
      data[x * 4 + 3] = bytes[pos++];
    }
  }
  
  return { data, newPos: pos };
}

/**
 * Create a WebGL texture from HDR data
 * @param {WebGL2RenderingContext} gl 
 * @param {{width: number, height: number, data: Float32Array}} hdrData 
 * @returns {WebGLTexture}
 */
export function createHDRTexture(gl, hdrData) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  
  // Upload as RGB16F for HDR range
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGB16F,
    hdrData.width,
    hdrData.height,
    0,
    gl.RGB,
    gl.FLOAT,
    hdrData.data
  );
  
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  
  return texture;
}

/**
 * Create pre-filtered HDR texture with mipmaps for IBL specular
 * Each mip level is blurred for increasing roughness values
 * @param {WebGL2RenderingContext} gl 
 * @param {{width: number, height: number, data: Float32Array}} hdrData 
 * @param {function} onProgress - Progress callback (0-1)
 * @returns {WebGLTexture}
 */
export function createPrefilteredHDRTexture(gl, hdrData, onProgress = null) {
  // Calculate number of mip levels
  const maxDim = Math.max(hdrData.width, hdrData.height);
  const numMips = Math.floor(Math.log2(maxDim)) + 1;
  
  // Create the texture with mipmap storage
  // Note: Using RGBA16F because RGB16F is not guaranteed color-renderable in WebGL2
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, numMips, gl.RGBA16F, hdrData.width, hdrData.height);
  
  // Convert RGB to RGBA for upload
  const rgbaData = new Float32Array(hdrData.width * hdrData.height * 4);
  for (let i = 0; i < hdrData.width * hdrData.height; i++) {
    rgbaData[i * 4] = hdrData.data[i * 3];
    rgbaData[i * 4 + 1] = hdrData.data[i * 3 + 1];
    rgbaData[i * 4 + 2] = hdrData.data[i * 3 + 2];
    rgbaData[i * 4 + 3] = 1.0;
  }
  
  // Upload base level
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, hdrData.width, hdrData.height, gl.RGBA, gl.FLOAT, rgbaData);
  
  if (onProgress) onProgress(0.1);
  
  // Create blur shader for pre-filtering
  const blurShader = createBlurShader(gl);
  if (!blurShader) {
    console.warn('Could not create blur shader, using auto-generated mipmaps');
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (onProgress) onProgress(1);
    return texture;
  }
  
  // Create framebuffer for rendering mips
  const fbo = gl.createFramebuffer();
  
  // Create quad for fullscreen rendering
  const quadVAO = createFullscreenQuad(gl);
  
  // Process each mip level (skip level 0 which is the original)
  let srcTexture = texture;
  let srcWidth = hdrData.width;
  let srcHeight = hdrData.height;
  
  for (let mip = 1; mip < numMips; mip++) {
    const dstWidth = Math.max(1, srcWidth >> 1);
    const dstHeight = Math.max(1, srcHeight >> 1);
    
    // Roughness increases with each mip level
    const roughness = mip / (numMips - 1);
    
    // Create temp texture for this mip level (RGBA16F for renderability)
    const tempTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tempTexture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, dstWidth, dstHeight);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    
    // Render blurred mip to temp texture
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tempTexture, 0);
    gl.viewport(0, 0, dstWidth, dstHeight);
    
    gl.useProgram(blurShader.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.uniform1i(blurShader.uTexture, 0);
    gl.uniform1f(blurShader.uRoughness, roughness);
    gl.uniform2f(blurShader.uTexelSize, 1.0 / srcWidth, 1.0 / srcHeight);
    gl.uniform1i(blurShader.uMipLevel, mip - 1);
    
    gl.bindVertexArray(quadVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    
    // Copy temp texture to mip level
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, mip, 0, 0, 0, 0, dstWidth, dstHeight);
    
    // Clean up temp texture
    gl.deleteTexture(tempTexture);
    
    srcWidth = dstWidth;
    srcHeight = dstHeight;
    
    if (onProgress) onProgress(0.1 + 0.9 * (mip / (numMips - 1)));
  }
  
  // Clean up
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteVertexArray(quadVAO);
  gl.deleteProgram(blurShader.program);
  
  // Set texture parameters
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  
  if (onProgress) onProgress(1);
  
  return texture;
}

/**
 * Create a blur shader for HDR pre-filtering
 */
function createBlurShader(gl) {
  const vsSource = `#version 300 es
    in vec2 aPosition;
    out vec2 vTexCoord;
    void main() {
      vTexCoord = aPosition * 0.5 + 0.5;
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `;
  
  // Importance sampling GGX for pre-filtered environment maps
  const fsSource = `#version 300 es
    precision highp float;
    
    uniform sampler2D uTexture;
    uniform float uRoughness;
    uniform vec2 uTexelSize;
    uniform int uMipLevel;
    
    in vec2 vTexCoord;
    out vec4 fragColor;
    
    const float PI = 3.14159265359;
    const float MAX_MIP_LEVELS = 12.0;
    const int SAMPLE_COUNT = 64;
    
    // Van der Corput radical inverse
    float radicalInverse(uint bits) {
      bits = (bits << 16u) | (bits >> 16u);
      bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
      bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
      bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
      bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
      return float(bits) * 2.3283064365386963e-10;
    }
    
    vec2 hammersley(uint i, uint n) {
      return vec2(float(i) / float(n), radicalInverse(i));
    }
    
    // GGX importance sampling
    vec3 importanceSampleGGX(vec2 xi, vec3 N, float roughness) {
      float a = roughness * roughness;
      
      float phi = 2.0 * PI * xi.x;
      float cosTheta = sqrt((1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y));
      float sinTheta = sqrt(1.0 - cosTheta * cosTheta);
      
      // Spherical to cartesian
      vec3 H;
      H.x = cos(phi) * sinTheta;
      H.y = sin(phi) * sinTheta;
      H.z = cosTheta;
      
      // Tangent space to world space
      vec3 up = abs(N.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
      vec3 tangent = normalize(cross(up, N));
      vec3 bitangent = cross(N, tangent);
      
      return normalize(tangent * H.x + bitangent * H.y + N * H.z);
    }
    
    // Convert UV to equirectangular direction
    vec3 uvToDirection(vec2 uv) {
      float phi = uv.x * 2.0 * PI;
      float theta = uv.y * PI;
      
      return vec3(
        sin(theta) * cos(phi),
        cos(theta),
        sin(theta) * sin(phi)
      );
    }
    
    // Convert direction to UV
    vec2 directionToUV(vec3 dir) {
      float phi = atan(dir.z, dir.x);
      float theta = acos(clamp(dir.y, -1.0, 1.0));
      
      return vec2(
        phi / (2.0 * PI) + 0.5,
        theta / PI
      );
    }
    
    void main() {
      vec3 N = uvToDirection(vTexCoord);
      vec3 R = N;
      vec3 V = R;
      
      float roughness = max(uRoughness, 0.04);
      
      vec3 prefilteredColor = vec3(0.0);
      float totalWeight = 0.0;
      
      for (int i = 0; i < SAMPLE_COUNT; i++) {
        vec2 xi = hammersley(uint(i), uint(SAMPLE_COUNT));
        vec3 H = importanceSampleGGX(xi, N, roughness);
        vec3 L = normalize(2.0 * dot(V, H) * H - V);
        
        float NdotL = max(dot(N, L), 0.0);
        if (NdotL > 0.0) {
          vec2 sampleUV = directionToUV(L);
          prefilteredColor += textureLod(uTexture, sampleUV, float(uMipLevel)).rgb * NdotL;
          totalWeight += NdotL;
        }
      }
      
      prefilteredColor = prefilteredColor / max(totalWeight, 0.001);
      fragColor = vec4(prefilteredColor, 1.0);
    }
  `;
  
  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Blur shader error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }
  
  const vs = compileShader(gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);
  
  if (!vs || !fs) return null;
  
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Blur program link error:', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  
  return {
    program,
    uTexture: gl.getUniformLocation(program, 'uTexture'),
    uRoughness: gl.getUniformLocation(program, 'uRoughness'),
    uTexelSize: gl.getUniformLocation(program, 'uTexelSize'),
    uMipLevel: gl.getUniformLocation(program, 'uMipLevel'),
  };
}

/**
 * Create fullscreen quad VAO
 */
function createFullscreenQuad(gl) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  
  const positions = new Float32Array([
    -1, -1,
     1, -1,
     1,  1,
    -1, -1,
     1,  1,
    -1,  1,
  ]);
  
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  
  gl.bindVertexArray(null);
  
  return vao;
}
