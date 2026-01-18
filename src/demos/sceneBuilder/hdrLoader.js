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
