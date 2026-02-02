// Heightmap Downsample Compute Shader
//
// Generates lower resolution versions of heightmaps for LOD-based rendering.
// Uses box filter (average of 2x2 pixels) for smooth downsampling.
// This preserves the large-scale features while reducing memory bandwidth
// for distant terrain patches.

// ============================================================================
// Uniforms
// ============================================================================

struct DownsampleUniforms {
  // Source texture dimensions
  srcWidth: u32,
  srcHeight: u32,
  // Destination texture dimensions
  dstWidth: u32,
  dstHeight: u32,
  // Mip level being generated (0 = half res, 1 = quarter res, etc.)
  mipLevel: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}

// ============================================================================
// Bindings
// ============================================================================

@group(0) @binding(0) var<uniform> uniforms: DownsampleUniforms;
@group(0) @binding(1) var srcHeightmap: texture_2d<f32>;
@group(0) @binding(2) var dstHeightmap: texture_storage_2d<r32float, write>;

// ============================================================================
// Box Filter Downsample
// ============================================================================

// Simple 2x2 box filter - averages 4 pixels
fn boxFilter(srcCoord: vec2u) -> f32 {
  // Sample 4 pixels from source (2x2 block)
  let p00 = textureLoad(srcHeightmap, srcCoord, 0).r;
  let p10 = textureLoad(srcHeightmap, srcCoord + vec2u(1, 0), 0).r;
  let p01 = textureLoad(srcHeightmap, srcCoord + vec2u(0, 1), 0).r;
  let p11 = textureLoad(srcHeightmap, srcCoord + vec2u(1, 1), 0).r;
  
  // Return average
  return (p00 + p10 + p01 + p11) * 0.25;
}

// ============================================================================
// Min-Max Preserving Downsample (Alternative)
// ============================================================================

// Preserves local extrema better for terrain (optional)
fn minMaxPreservingFilter(srcCoord: vec2u) -> f32 {
  // Sample 4 pixels
  let p00 = textureLoad(srcHeightmap, srcCoord, 0).r;
  let p10 = textureLoad(srcHeightmap, srcCoord + vec2u(1, 0), 0).r;
  let p01 = textureLoad(srcHeightmap, srcCoord + vec2u(0, 1), 0).r;
  let p11 = textureLoad(srcHeightmap, srcCoord + vec2u(1, 1), 0).r;
  
  // Find min and max
  let minVal = min(min(p00, p10), min(p01, p11));
  let maxVal = max(max(p00, p10), max(p01, p11));
  let avgVal = (p00 + p10 + p01 + p11) * 0.25;
  
  // Bias toward extrema to preserve peaks and valleys
  let extremaDist = max(avgVal - minVal, maxVal - avgVal);
  if (maxVal - avgVal > avgVal - minVal) {
    // Closer to max - bias upward slightly
    return mix(avgVal, maxVal, 0.2);
  } else {
    // Closer to min - bias downward slightly
    return mix(avgVal, minVal, 0.2);
  }
}

// ============================================================================
// Main Compute Shader
// ============================================================================

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let dstCoord = globalId.xy;
  
  // Bounds check for destination
  if (dstCoord.x >= uniforms.dstWidth || dstCoord.y >= uniforms.dstHeight) {
    return;
  }
  
  // Calculate source coordinate (2x for each mip level reduction)
  let srcCoord = dstCoord * 2u;
  
  // Ensure we don't read past source bounds
  let clampedSrcCoord = min(srcCoord, vec2u(uniforms.srcWidth - 2u, uniforms.srcHeight - 2u));
  
  // Apply box filter
  let height = boxFilter(clampedSrcCoord);
  
  // Write to destination mip
  textureStore(dstHeightmap, dstCoord, vec4f(height, 0.0, 0.0, 1.0));
}

// ============================================================================
// Mip Chain Generator
// ============================================================================

// Entry point for generating a specific mip level
// Call this multiple times to build the full mip chain:
//   mip0 (1024) -> mip1 (512) -> mip2 (256) -> mip3 (128) -> mip4 (64)

@compute @workgroup_size(8, 8)
fn generate_mip(@builtin(global_invocation_id) globalId: vec3u) {
  let dstCoord = globalId.xy;
  
  // Bounds check
  if (dstCoord.x >= uniforms.dstWidth || dstCoord.y >= uniforms.dstHeight) {
    return;
  }
  
  // Source coordinates at 2x resolution
  let srcCoord = dstCoord * 2u;
  
  // Clamp to valid range
  let maxSrc = vec2u(uniforms.srcWidth - 1u, uniforms.srcHeight - 1u);
  let clampedSrc = min(srcCoord, maxSrc);
  
  // Sample 4 texels with clamping
  let p00 = textureLoad(srcHeightmap, clampedSrc, 0).r;
  let p10 = textureLoad(srcHeightmap, min(clampedSrc + vec2u(1, 0), maxSrc), 0).r;
  let p01 = textureLoad(srcHeightmap, min(clampedSrc + vec2u(0, 1), maxSrc), 0).r;
  let p11 = textureLoad(srcHeightmap, min(clampedSrc + vec2u(1, 1), maxSrc), 0).r;
  
  // Average for smooth downsampling
  let height = (p00 + p10 + p01 + p11) * 0.25;
  
  textureStore(dstHeightmap, dstCoord, vec4f(height, 0.0, 0.0, 1.0));
}
