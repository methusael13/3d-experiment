// Screen-Space Ambient Occlusion (SSAO) Shader
// Uses depth buffer only - normals reconstructed from depth derivatives

// ============ Fullscreen Quad Vertex Shader ============

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // Fullscreen triangle (3 vertices cover entire screen)
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  let uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0)
  );
  
  var output: VertexOutput;
  output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  output.uv = uvs[vertexIndex];
  return output;
}

// ============ Uniforms ============

// Uniforms for SSAO parameters
struct SSAOParams {
  // xy: inverse viewport size (1/width, 1/height)
  // zw: viewport size (width, height)
  viewportParams: vec4f,
  // x: radius in world units
  // y: intensity/strength
  // z: bias to prevent self-occlusion
  // w: number of samples
  ssaoParams: vec4f,
  // Projection matrix elements for depth reconstruction
  // x: near, y: far, z: projM[0][0], w: projM[1][1]
  projParams: vec4f,
}

@group(0) @binding(0) var depthTexture: texture_2d<f32>;
@group(0) @binding(1) var noiseSampler: sampler;
@group(0) @binding(2) var<uniform> params: SSAOParams;
@group(0) @binding(3) var<storage, read> sampleKernel: array<vec4f>;

// Linearize depth value
fn linearizeDepth(depth: f32) -> f32 {
  let near = params.projParams.x;
  let far = params.projParams.y;
  // Handle both standard and reverse-Z depth buffers
  return (near * far) / (far - depth * (far - near));
}

// Reconstruct view-space position from depth
fn reconstructViewPos(uv: vec2f, depth: f32) -> vec3f {
  let linearDepth = linearizeDepth(depth);
  
  // Reconstruct view-space position
  let ndc = vec2f(uv.x * 2.0 - 1.0, (1.0 - uv.y) * 2.0 - 1.0);
  let viewPos = vec3f(
    ndc.x * linearDepth / params.projParams.z,
    ndc.y * linearDepth / params.projParams.w,
    -linearDepth
  );
  
  return viewPos;
}

// Reconstruct normal from depth buffer using cross product of derivatives
// This is a common technique used when no normal buffer is available
fn reconstructNormalFromDepth(uv: vec2f, pixelCoord: vec2i) -> vec3f {
  let texelSize = params.viewportParams.xy;
  let viewportSize = params.viewportParams.zw;
  let maxCoord = vec2i(viewportSize) - vec2i(1, 1);
  
  // Sample depths at neighboring pixels (clamped to valid bounds)
  let depthC = textureLoad(depthTexture, pixelCoord, 0).r;
  
  // Clamp coordinates to prevent out-of-bounds sampling at edges
  let coordR = clamp(pixelCoord + vec2i(1, 0), vec2i(0, 0), maxCoord);
  let coordL = clamp(pixelCoord - vec2i(1, 0), vec2i(0, 0), maxCoord);
  let coordU = clamp(pixelCoord + vec2i(0, 1), vec2i(0, 0), maxCoord);
  let coordD = clamp(pixelCoord - vec2i(0, 1), vec2i(0, 0), maxCoord);
  
  let depthR = textureLoad(depthTexture, coordR, 0).r;
  let depthL = textureLoad(depthTexture, coordL, 0).r;
  let depthU = textureLoad(depthTexture, coordU, 0).r;
  let depthD = textureLoad(depthTexture, coordD, 0).r;
  
  // Reconstruct view positions with clamped UVs
  let uvR = clamp(uv + vec2f(texelSize.x, 0.0), vec2f(0.0), vec2f(1.0));
  let uvL = clamp(uv - vec2f(texelSize.x, 0.0), vec2f(0.0), vec2f(1.0));
  let uvU = clamp(uv + vec2f(0.0, texelSize.y), vec2f(0.0), vec2f(1.0));
  let uvD = clamp(uv - vec2f(0.0, texelSize.y), vec2f(0.0), vec2f(1.0));
  
  let posC = reconstructViewPos(uv, depthC);
  let posR = reconstructViewPos(uvR, depthR);
  let posL = reconstructViewPos(uvL, depthL);
  let posU = reconstructViewPos(uvU, depthU);
  let posD = reconstructViewPos(uvD, depthD);
  
  // Use the smaller derivative to avoid artifacts at depth discontinuities
  var dPdx: vec3f;
  var dPdy: vec3f;
  
  // Choose derivative with smaller magnitude (better handles edges)
  let dxR = posR - posC;
  let dxL = posC - posL;
  if (abs(dxR.z) < abs(dxL.z)) {
    dPdx = dxR;
  } else {
    dPdx = dxL;
  }
  
  let dyU = posU - posC;
  let dyD = posC - posD;
  if (abs(dyU.z) < abs(dyD.z)) {
    dPdy = dyU;
  } else {
    dPdy = dyD;
  }
  
  // Normal is perpendicular to both derivatives
  let normal = normalize(cross(dPdx, dPdy));
  
  return normal;
}

// Hash function for per-pixel noise
fn hash(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Create rotation matrix from random angle
fn createRotationMatrix(angle: f32) -> mat3x3f {
  let c = cos(angle);
  let s = sin(angle);
  return mat3x3f(
    vec3f(c, s, 0.0),
    vec3f(-s, c, 0.0),
    vec3f(0.0, 0.0, 1.0)
  );
}

// Create TBN matrix from normal (for hemisphere sampling)
fn createTBN(normal: vec3f) -> mat3x3f {
  // Choose up vector that's not parallel to normal
  var up = vec3f(0.0, 1.0, 0.0);
  if (abs(normal.y) > 0.99) {
    up = vec3f(1.0, 0.0, 0.0);
  }
  
  let tangent = normalize(cross(up, normal));
  let bitangent = cross(normal, tangent);
  
  return mat3x3f(tangent, bitangent, normal);
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let pixelCoord = vec2i(uv * params.viewportParams.zw);
  
  // Sample depth
  let depth = textureLoad(depthTexture, pixelCoord, 0).r;
  
  // Skip sky pixels (depth = 1.0 or 0.0 depending on convention)
  if (depth >= 0.9999 || depth <= 0.0001) {
    return vec4f(1.0, 1.0, 1.0, 1.0);
  }
  
  // Get view-space position
  let viewPos = reconstructViewPos(uv, depth);
  
  // Reconstruct normal from depth buffer (no separate normal texture needed)
  let normal = reconstructNormalFromDepth(uv, pixelCoord);
  
  // SSAO parameters
  let radius = params.ssaoParams.x;
  let intensity = params.ssaoParams.y;
  let bias = params.ssaoParams.z;
  let numSamples = i32(params.ssaoParams.w);
  
  // Create TBN for hemisphere sampling
  let TBN = createTBN(normal);
  
  // Random rotation per pixel (reduces banding)
  let noiseScale = params.viewportParams.zw / 4.0; // 4x4 tile
  let randomAngle = hash(uv * noiseScale) * 6.28318; // 2*PI
  let rotationMat = createRotationMatrix(randomAngle);
  
  // Accumulate occlusion
  var occlusion = 0.0;
  
  for (var i = 0; i < numSamples; i++) {
    // Get sample from kernel (pre-generated hemisphere samples)
    var sampleDir = sampleKernel[i].xyz;
    
    // Apply random rotation
    sampleDir = rotationMat * sampleDir;
    
    // Transform to view-space using TBN
    sampleDir = TBN * sampleDir;
    
    // Scale by radius and sample distance (samples closer to center have more weight)
    let sampleScale = sampleKernel[i].w; // Pre-computed scale (0-1 range)
    let samplePos = viewPos + sampleDir * radius * sampleScale;
    
    // Project sample to screen space
    let sampleClip = vec4f(
      samplePos.x * params.projParams.z,
      samplePos.y * params.projParams.w,
      samplePos.z,
      1.0
    );
    
    // Perspective divide and convert to UV
    let sampleNDC = sampleClip.xy / (-samplePos.z);
    let sampleUV = vec2f(sampleNDC.x * 0.5 + 0.5, 0.5 - sampleNDC.y * 0.5);
    
    // Check bounds
    if (sampleUV.x < 0.0 || sampleUV.x > 1.0 || sampleUV.y < 0.0 || sampleUV.y > 1.0) {
      continue;
    }
    
    // Sample depth at projected position
    let sampleCoord = vec2i(sampleUV * params.viewportParams.zw);
    let sampleDepth = textureLoad(depthTexture, sampleCoord, 0).r;
    
    // Reconstruct sample view position
    let sampleViewPos = reconstructViewPos(sampleUV, sampleDepth);
    
    // Range check (avoid sampling across depth discontinuities)
    let rangeCheck = smoothstep(0.0, 1.0, radius / abs(viewPos.z - sampleViewPos.z));
    
    // Compare depths
    // If sample is occluded (behind the surface), add to occlusion
    let depthDiff = -samplePos.z - (-sampleViewPos.z);
    if (depthDiff > bias && depthDiff < radius) {
      occlusion += rangeCheck;
    }
  }
  
  // Normalize and invert
  occlusion = 1.0 - (occlusion / f32(numSamples)) * intensity;
  occlusion = clamp(occlusion, 0.0, 1.0);
  
  return vec4f(occlusion, occlusion, occlusion, 1.0);
}
