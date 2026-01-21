/**
 * HDR (Radiance RGBE) file loader with Multiple Importance Sampling (MIS) support
 * Parses .hdr files and generates PDF/CDF textures for environment map sampling
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
        // Cap exponent to prevent Float32 overflow (e=200 gives 2^64 which is huge)
        // We clamp to a reasonable HDR range that float16 can represent (max 65504)
        const clampedE = Math.min(e, 200); // 2^(200-136) = 2^64, still huge but won't overflow float32
        const scale = Math.pow(2, clampedE - 128 - 8) / exposure;
        
        // Also clamp final values to float16 max to prevent issues in WebGL
        const maxHDR = 65504.0;
        pixels[i] = Math.min(r * scale, maxHDR);
        pixels[i + 1] = Math.min(g * scale, maxHDR);
        pixels[i + 2] = Math.min(b * scale, maxHDR);
        
        // Check for NaN/Inf and replace with bright white
        if (!Number.isFinite(pixels[i])) pixels[i] = maxHDR;
        if (!Number.isFinite(pixels[i + 1])) pixels[i + 1] = maxHDR;
        if (!Number.isFinite(pixels[i + 2])) pixels[i + 2] = maxHDR;
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
 * @returns {{texture: WebGLTexture, mipLevels: number}}
 */
export function createPrefilteredHDRTexture(gl, hdrData, onProgress = null) {
  // Save current WebGL state to restore later
  const savedViewport = gl.getParameter(gl.VIEWPORT);
  const savedFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  const savedVAO = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
  const savedProgram = gl.getParameter(gl.CURRENT_PROGRAM);
  const savedActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
  const savedTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);
  
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
  
  // Clean up resources
  gl.deleteFramebuffer(fbo);
  gl.deleteVertexArray(quadVAO);
  gl.deleteProgram(blurShader.program);
  
  // Restore original WebGL state
  gl.bindFramebuffer(gl.FRAMEBUFFER, savedFramebuffer);
  gl.bindVertexArray(savedVAO);
  gl.useProgram(savedProgram);
  gl.activeTexture(savedActiveTexture);
  gl.bindTexture(gl.TEXTURE_2D, savedTexture);
  gl.viewport(savedViewport[0], savedViewport[1], savedViewport[2], savedViewport[3]);
  
  // Set texture parameters (need to rebind the HDR texture)
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  
  if (onProgress) onProgress(1);
  
  return { texture, mipLevels: numMips };
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
    const int SAMPLE_COUNT = 256;
    
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
      
      // Tangent space to world space (Y-up convention to match uvToDirection)
      vec3 up = abs(N.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
      vec3 tangent = normalize(cross(up, N));
      vec3 bitangent = cross(N, tangent);
      
      return normalize(tangent * H.x + bitangent * H.y + N * H.z);
    }
    
    // Convert UV to equirectangular direction (Y-flipped for HDR convention)
    vec3 uvToDirection(vec2 uv) {
      float phi = (uv.x - 0.5) * 2.0 * PI;
      float theta = (0.5 - uv.y) * PI;
      
      return vec3(
        cos(theta) * cos(phi),
        sin(theta),
        cos(theta) * sin(phi)
      );
    }
    
    // Convert direction to UV (Y-flipped for HDR convention)
    vec2 directionToUV(vec3 dir) {
      float phi = atan(dir.z, dir.x);
      float theta = asin(clamp(dir.y, -1.0, 1.0));
      
      return vec2(
        phi / (2.0 * PI) + 0.5,
        0.5 - theta / PI
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
          // Clamp extreme HDR values to prevent Inf/NaN from sun regions
          // 65504.0 is the max representable value in float16
          vec3 texSample = textureLod(uTexture, sampleUV, float(uMipLevel)).rgb;
          texSample = clamp(texSample, 0.0, 65504.0);
          prefilteredColor += texSample * NdotL;
          totalWeight += NdotL;
        }
      }
      
      prefilteredColor = prefilteredColor / max(totalWeight, 0.001);
      
      // Final NaN/Inf protection
      if (any(isnan(prefilteredColor)) || any(isinf(prefilteredColor))) {
        prefilteredColor = vec3(0.0);
      }
      
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

// ============================================
// MULTIPLE IMPORTANCE SAMPLING (MIS) SUPPORT
// ============================================

/**
 * Compute luminance from RGB
 */
function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Generate PDF/CDF textures for environment map importance sampling
 * Uses Veach's method: marginal distribution for rows, conditional for columns
 * 
 * @param {WebGL2RenderingContext} gl
 * @param {{width: number, height: number, data: Float32Array}} hdrData
 * @returns {{marginalCDF: WebGLTexture, conditionalCDF: WebGLTexture, totalLuminance: number}}
 */
export function generateEnvMapPDFCDF(gl, hdrData) {
  const { width, height, data } = hdrData;
  
  // Step 1: Compute sin-weighted luminance for each pixel
  // (equirectangular maps need sin(theta) weighting for correct solid angle)
  const luminanceMap = new Float32Array(width * height);
  const rowSums = new Float32Array(height);
  
  for (let y = 0; y < height; y++) {
    // theta goes from 0 at top (north pole) to PI at bottom (south pole)
    // In our flipped convention, y=0 is top, y=height-1 is bottom
    const theta = (y + 0.5) / height * Math.PI;
    const sinTheta = Math.sin(theta);
    
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      
      // Sin-weighted luminance (accounts for equirectangular distortion)
      const lum = luminance(r, g, b) * sinTheta;
      luminanceMap[y * width + x] = lum;
      rowSum += lum;
    }
    rowSums[y] = rowSum;
  }
  
  // Step 2: Compute marginal CDF (probability of selecting each row)
  const marginalPDF = new Float32Array(height);
  const marginalCDF = new Float32Array(height + 1);
  let totalLuminance = 0;
  
  for (let y = 0; y < height; y++) {
    totalLuminance += rowSums[y];
  }
  
  // Avoid division by zero for black images
  if (totalLuminance < 1e-10) {
    totalLuminance = 1.0;
    for (let y = 0; y < height; y++) {
      rowSums[y] = 1.0 / height;
    }
  }
  
  marginalCDF[0] = 0;
  for (let y = 0; y < height; y++) {
    marginalPDF[y] = rowSums[y] / totalLuminance;
    marginalCDF[y + 1] = marginalCDF[y] + marginalPDF[y];
  }
  // Normalize to ensure CDF ends at exactly 1.0
  marginalCDF[height] = 1.0;
  
  // Step 3: Compute conditional CDFs (probability of selecting column given row)
  // Store as a 2D texture: each row contains the CDF for that row
  const conditionalCDF = new Float32Array((width + 1) * height);
  
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (width + 1);
    const rowSum = rowSums[y] > 1e-10 ? rowSums[y] : 1.0;
    
    conditionalCDF[rowOffset] = 0;
    for (let x = 0; x < width; x++) {
      const lum = luminanceMap[y * width + x];
      conditionalCDF[rowOffset + x + 1] = conditionalCDF[rowOffset + x] + lum / rowSum;
    }
    // Normalize
    conditionalCDF[rowOffset + width] = 1.0;
  }
  
  // Step 4: Create textures
  // Marginal CDF: 1D texture (height+1 values) stored as (height+1) x 1 R32F
  const marginalTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, marginalTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, height + 1, 1, 0, gl.RED, gl.FLOAT, marginalCDF);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  
  // Conditional CDF: 2D texture (width+1) x height R32F
  const conditionalTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, conditionalTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width + 1, height, 0, gl.RED, gl.FLOAT, conditionalCDF);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  
  return {
    marginalCDF: marginalTexture,
    conditionalCDF: conditionalTexture,
    totalLuminance,
    width,
    height
  };
}

/**
 * Create pre-filtered HDR texture with MIS (Multiple Importance Sampling)
 * Combines BRDF importance sampling with environment map importance sampling
 * @param {WebGL2RenderingContext} gl 
 * @param {{width: number, height: number, data: Float32Array}} hdrData 
 * @param {function} onProgress - Progress callback (0-1)
 * @returns {{texture: WebGLTexture, mipLevels: number, pdfCdf: object}}
 */
export function createPrefilteredHDRTextureWithMIS(gl, hdrData, onProgress = null) {
  // Save current WebGL state
  const savedViewport = gl.getParameter(gl.VIEWPORT);
  const savedFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  const savedVAO = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
  const savedProgram = gl.getParameter(gl.CURRENT_PROGRAM);
  const savedActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
  const savedTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);
  
  if (onProgress) onProgress(0.05);
  
  // Generate PDF/CDF textures for environment importance sampling
  const pdfCdf = generateEnvMapPDFCDF(gl, hdrData);
  
  if (onProgress) onProgress(0.15);
  
  // Calculate number of mip levels
  const maxDim = Math.max(hdrData.width, hdrData.height);
  const numMips = Math.floor(Math.log2(maxDim)) + 1;
  
  // Create the texture with mipmap storage (RGBA16F for renderability)
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
  
  if (onProgress) onProgress(0.2);
  
  // Create MIS blur shader
  const misShader = createMISBlurShader(gl);
  if (!misShader) {
    console.warn('Could not create MIS shader, falling back to standard pre-filtering');
    gl.deleteTexture(pdfCdf.marginalCDF);
    gl.deleteTexture(pdfCdf.conditionalCDF);
    
    // Restore state and fall back
    gl.bindFramebuffer(gl.FRAMEBUFFER, savedFramebuffer);
    gl.bindVertexArray(savedVAO);
    gl.useProgram(savedProgram);
    gl.activeTexture(savedActiveTexture);
    gl.bindTexture(gl.TEXTURE_2D, savedTexture);
    gl.viewport(savedViewport[0], savedViewport[1], savedViewport[2], savedViewport[3]);
    
    return createPrefilteredHDRTexture(gl, hdrData, onProgress);
  }
  
  // Create framebuffer for rendering mips
  const fbo = gl.createFramebuffer();
  const quadVAO = createFullscreenQuad(gl);
  
  // Process each mip level
  let srcWidth = hdrData.width;
  let srcHeight = hdrData.height;
  
  for (let mip = 1; mip < numMips; mip++) {
    const dstWidth = Math.max(1, srcWidth >> 1);
    const dstHeight = Math.max(1, srcHeight >> 1);
    const roughness = mip / (numMips - 1);
    
    // Create temp texture for this mip level
    const tempTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tempTexture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, dstWidth, dstHeight);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    
    // Render with MIS
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tempTexture, 0);
    gl.viewport(0, 0, dstWidth, dstHeight);
    
    gl.useProgram(misShader.program);
    
    // Bind HDR texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.uniform1i(misShader.uTexture, 0);
    
    // Bind marginal CDF
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, pdfCdf.marginalCDF);
    gl.uniform1i(misShader.uMarginalCDF, 1);
    
    // Bind conditional CDF
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, pdfCdf.conditionalCDF);
    gl.uniform1i(misShader.uConditionalCDF, 2);
    
    // Set uniforms
    gl.uniform1f(misShader.uRoughness, roughness);
    gl.uniform2f(misShader.uTexelSize, 1.0 / srcWidth, 1.0 / srcHeight);
    gl.uniform1i(misShader.uMipLevel, mip - 1);
    gl.uniform2f(misShader.uEnvMapSize, hdrData.width, hdrData.height);
    gl.uniform1f(misShader.uTotalLuminance, pdfCdf.totalLuminance);
    
    gl.bindVertexArray(quadVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    
    // Copy to mip level
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, mip, 0, 0, 0, 0, dstWidth, dstHeight);
    
    gl.deleteTexture(tempTexture);
    
    srcWidth = dstWidth;
    srcHeight = dstHeight;
    
    if (onProgress) onProgress(0.2 + 0.8 * (mip / (numMips - 1)));
  }
  
  // Clean up
  gl.deleteFramebuffer(fbo);
  gl.deleteVertexArray(quadVAO);
  gl.deleteProgram(misShader.program);
  
  // Restore state
  gl.bindFramebuffer(gl.FRAMEBUFFER, savedFramebuffer);
  gl.bindVertexArray(savedVAO);
  gl.useProgram(savedProgram);
  gl.activeTexture(savedActiveTexture);
  gl.bindTexture(gl.TEXTURE_2D, savedTexture);
  gl.viewport(savedViewport[0], savedViewport[1], savedViewport[2], savedViewport[3]);
  
  // Set final texture parameters
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  
  if (onProgress) onProgress(1);
  
  return { texture, mipLevels: numMips, pdfCdf };
}

/**
 * Create MIS blur shader for HDR pre-filtering
 * Combines BRDF importance sampling with environment map importance sampling
 */
function createMISBlurShader(gl) {
  const vsSource = `#version 300 es
    in vec2 aPosition;
    out vec2 vTexCoord;
    void main() {
      vTexCoord = aPosition * 0.5 + 0.5;
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `;
  
  const fsSource = `#version 300 es
    precision highp float;
    
    uniform sampler2D uTexture;
    uniform sampler2D uMarginalCDF;
    uniform sampler2D uConditionalCDF;
    uniform float uRoughness;
    uniform vec2 uTexelSize;
    uniform int uMipLevel;
    uniform vec2 uEnvMapSize;
    uniform float uTotalLuminance;
    
    in vec2 vTexCoord;
    out vec4 fragColor;
    
    const float PI = 3.14159265359;
    const int BRDF_SAMPLES = 256;  // Samples from BRDF distribution
    const int ENV_SAMPLES = 256;   // Samples from environment map distribution
    
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
    
    // GGX importance sampling (BRDF sampling)
    vec3 importanceSampleGGX(vec2 xi, vec3 N, float roughness) {
      float a = roughness * roughness;
      
      float phi = 2.0 * PI * xi.x;
      float cosTheta = sqrt((1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y));
      float sinTheta = sqrt(1.0 - cosTheta * cosTheta);
      
      vec3 H;
      H.x = cos(phi) * sinTheta;
      H.y = sin(phi) * sinTheta;
      H.z = cosTheta;
      
      // Tangent space to world space (Y-up convention to match uvToDirection)
      vec3 up = abs(N.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
      vec3 tangent = normalize(cross(up, N));
      vec3 bitangent = cross(N, tangent);
      
      return normalize(tangent * H.x + bitangent * H.y + N * H.z);
    }
    
    // GGX PDF for a given half vector
    float pdfGGX(vec3 N, vec3 H, vec3 V, float roughness) {
      float a = roughness * roughness;
      float a2 = a * a;
      float NdotH = max(dot(N, H), 0.0);
      float NdotH2 = NdotH * NdotH;
      
      float denom = NdotH2 * (a2 - 1.0) + 1.0;
      float D = a2 / (PI * denom * denom);
      
      return D * NdotH / (4.0 * max(dot(V, H), 0.001));
    }
    
    // Convert UV to equirectangular direction
    vec3 uvToDirection(vec2 uv) {
      float phi = (uv.x - 0.5) * 2.0 * PI;
      float theta = (0.5 - uv.y) * PI;
      return vec3(cos(theta) * cos(phi), sin(theta), cos(theta) * sin(phi));
    }
    
    // Convert direction to UV
    vec2 directionToUV(vec3 dir) {
      float phi = atan(dir.z, dir.x);
      float theta = asin(clamp(dir.y, -1.0, 1.0));
      return vec2(phi / (2.0 * PI) + 0.5, 0.5 - theta / PI);
    }
    
    // Binary search to find index in CDF with proper interpolation
    float searchCDF(sampler2D cdfTex, float xi, float texCoordY, float size) {
      float lo = 0.0;
      float hi = 1.0;
      
      // Binary search for bracket
      for (int i = 0; i < 20; i++) {
        float mid = (lo + hi) * 0.5;
        float cdfVal = texture(cdfTex, vec2(mid, texCoordY)).r;
        if (xi < cdfVal) {
          hi = mid;
        } else {
          lo = mid;
        }
      }
      
      // Linear interpolation within found bracket for smoother results
      float cdfLo = texture(cdfTex, vec2(lo, texCoordY)).r;
      float cdfHi = texture(cdfTex, vec2(hi, texCoordY)).r;
      float t = (xi - cdfLo) / max(cdfHi - cdfLo, 0.0001);
      
      return mix(lo, hi, clamp(t, 0.0, 1.0));
    }
    
    // Sample direction from environment map CDF - with corrected coordinate mapping
    vec3 sampleEnvMap(vec2 xi, out float pdf) {
      // Sample row (marginal distribution)
      // The marginal CDF texture is (height+1) x 1, normalized to [0,1]
      float rowNorm = searchCDF(uMarginalCDF, xi.y, 0.5, uEnvMapSize.y + 1.0);
      
      // Sample column (conditional distribution for this row)
      // The conditional CDF texture is (width+1) x height
      float rowTexCoord = rowNorm; // Row in [0,1] range maps directly
      float colNorm = searchCDF(uConditionalCDF, xi.x, rowTexCoord, uEnvMapSize.x + 1.0);
      
      // Convert normalized coords to UV for environment map sampling
      // No offset needed - we want the exact sampled position
      vec2 uv = vec2(colNorm, rowNorm);
      vec3 dir = uvToDirection(uv);
      
      // Compute PDF correctly for equirectangular mapping
      float theta = (0.5 - uv.y) * PI;
      float sinTheta = max(abs(sin(theta)), 0.0001);
      
      // PDF = luminance_normalized * jacobian_inverse
      // jacobian for equirectangular = 2 * PI * PI * sin(theta) / (width * height)
      vec3 envColor = textureLod(uTexture, uv, 0.0).rgb;
      float lum = 0.2126 * envColor.r + 0.7152 * envColor.g + 0.0722 * envColor.b;
      
      // PDF = (lum / totalLum) * (width * height) / (2 * PI^2 * sin(theta))
      pdf = (lum / max(uTotalLuminance, 0.0001)) * uEnvMapSize.x * uEnvMapSize.y / (2.0 * PI * PI * sinTheta);
      pdf = max(pdf, 0.0001);
      
      return dir;
    }
    
    // Environment map PDF for a given direction - must match sampleEnvMap's PDF
    float pdfEnvMap(vec3 dir) {
      vec2 uv = directionToUV(dir);
      vec3 envColor = textureLod(uTexture, uv, 0.0).rgb;
      float lum = 0.2126 * envColor.r + 0.7152 * envColor.g + 0.0722 * envColor.b;
      
      // theta from UV (must match uvToDirection convention)
      float theta = (0.5 - uv.y) * PI;
      float sinTheta = max(abs(sin(theta)), 0.0001);
      
      // Same formula as in sampleEnvMap
      return (lum / max(uTotalLuminance, 0.0001)) * uEnvMapSize.x * uEnvMapSize.y / (2.0 * PI * PI * sinTheta);
    }
    
    // Power heuristic for MIS (Veach)
    float powerHeuristic(float nf, float pf, float ng, float pg) {
      float f = nf * pf;
      float g = ng * pg;
      return (f * f) / (f * f + g * g + 0.0001);
    }
    
    void main() {
      vec3 N = uvToDirection(vTexCoord);
      vec3 V = N;
      
      float roughness = max(uRoughness, 0.04);
      
      vec3 result = vec3(0.0);
      float totalWeight = 0.0;
      
      // ============================================
      // BRDF IMPORTANCE SAMPLING
      // Sample directions based on GGX distribution
      // ============================================
      for (int i = 0; i < BRDF_SAMPLES; i++) {
        vec2 xi = hammersley(uint(i), uint(BRDF_SAMPLES));
        vec3 H = importanceSampleGGX(xi, N, roughness);
        vec3 L = normalize(2.0 * dot(V, H) * H - V);
        
        float NdotL = max(dot(N, L), 0.0);
        if (NdotL > 0.0) {
          vec2 sampleUV = directionToUV(L);
          vec3 envColor = textureLod(uTexture, sampleUV, float(uMipLevel)).rgb;
          envColor = clamp(envColor, 0.0, 65504.0);
          
          // PDFs for MIS
          float pdfBRDF = pdfGGX(N, H, V, roughness);
          float pdfEnv = pdfEnvMap(L);
          
          // MIS weight using power heuristic
          float misWeight = powerHeuristic(float(BRDF_SAMPLES), pdfBRDF, float(ENV_SAMPLES), pdfEnv);
          
          // Contribution
          float weight = NdotL * misWeight;
          result += envColor * weight;
          totalWeight += weight;
        }
      }
      
      // ============================================
      // ENVIRONMENT MAP IMPORTANCE SAMPLING
      // Sample directions based on environment luminance
      // ============================================
      for (int i = 0; i < ENV_SAMPLES; i++) {
        vec2 xi = hammersley(uint(i + BRDF_SAMPLES), uint(ENV_SAMPLES));
        
        float pdfEnv;
        vec3 L = sampleEnvMap(xi, pdfEnv);
        
        float NdotL = max(dot(N, L), 0.0);
        if (NdotL > 0.0) {
          vec2 sampleUV = directionToUV(L);
          vec3 envColor = textureLod(uTexture, sampleUV, float(uMipLevel)).rgb;
          envColor = clamp(envColor, 0.0, 65504.0);
          
          // Compute BRDF PDF for this direction
          vec3 H = normalize(V + L);
          float pdfBRDF = pdfGGX(N, H, V, roughness);
          
          // MIS weight
          float misWeight = powerHeuristic(float(ENV_SAMPLES), pdfEnv, float(BRDF_SAMPLES), pdfBRDF);
          
          // Contribution (need to account for BRDF evaluation)
          float a = roughness * roughness;
          float a2 = a * a;
          float NdotH = max(dot(N, H), 0.0);
          float denom = NdotH * NdotH * (a2 - 1.0) + 1.0;
          float D = a2 / (PI * denom * denom);
          
          float weight = NdotL * D * misWeight / max(pdfEnv, 0.001);
          result += envColor * weight;
          totalWeight += weight;
        }
      }
      
      result = result / max(totalWeight, 0.001);
      
      // NaN/Inf protection
      if (any(isnan(result)) || any(isinf(result))) {
        result = vec3(0.0);
      }
      
      fragColor = vec4(result, 1.0);
    }
  `;
  
  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('MIS shader error:', gl.getShaderInfoLog(shader));
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
    console.error('MIS program link error:', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  
  return {
    program,
    uTexture: gl.getUniformLocation(program, 'uTexture'),
    uMarginalCDF: gl.getUniformLocation(program, 'uMarginalCDF'),
    uConditionalCDF: gl.getUniformLocation(program, 'uConditionalCDF'),
    uRoughness: gl.getUniformLocation(program, 'uRoughness'),
    uTexelSize: gl.getUniformLocation(program, 'uTexelSize'),
    uMipLevel: gl.getUniformLocation(program, 'uMipLevel'),
    uEnvMapSize: gl.getUniformLocation(program, 'uEnvMapSize'),
    uTotalLuminance: gl.getUniformLocation(program, 'uTotalLuminance'),
  };
}
