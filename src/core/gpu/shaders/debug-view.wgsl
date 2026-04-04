// Debug View Shader — Fullscreen visualization of depth, normals, SSR, or SDF buffers
// Renders on top of the scene to the backbuffer

struct DebugViewParams {
  // x = mode (0=off, 1=depth, 2=normals, 3=SSR, 4=SDF), y = near, z = far, w = sdfAvailable
  params: vec4f,
}

// SDF uniform params (matches GlobalDistanceField consumer uniform: center+pad, extent+voxelSize)
struct SDFParams {
  center: vec3f,
  _pad0: f32,
  extent: vec3f,
  voxelSize: f32,
}

// SDF view params: inverseVP matrix for world position reconstruction
struct SDFViewParams {
  inverseViewProj: mat4x4f,
  sdfCenter: vec4f,     // unused (actual center comes from SDFParams)
  sdfExtent: vec4f,     // unused (actual extent comes from SDFParams)
}

@group(0) @binding(0) var<uniform> debugView: DebugViewParams;
@group(0) @binding(1) var depthTexture: texture_depth_2d;
@group(0) @binding(2) var normalsTexture: texture_2d<f32>;
@group(0) @binding(3) var ssrTexture: texture_2d<f32>;
// SDF resources (bindings 4, 6, 7)
// r32float is unfilterable-float in WebGPU — must use textureLoad, not textureSampleLevel
// No sampler needed (binding 5 skipped — auto-layout excludes unused bindings)
@group(0) @binding(4) var sdfTexture: texture_3d<f32>;
@group(0) @binding(6) var<uniform> sdfParams: SDFParams;
@group(0) @binding(7) var<uniform> sdfViewParams: SDFViewParams;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  let x = f32(i32(vertexIndex) / 2) * 4.0 - 1.0;
  let y = f32(i32(vertexIndex) % 2) * 4.0 - 1.0;
  output.position = vec4f(x, y, 0.0, 1.0);
  output.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return output;
}

// Linearize reversed-Z depth
fn linearizeDepthReversed(d: f32, near: f32, far: f32) -> f32 {
  return near * far / (near + d * (far - near));
}

// Sample the SDF 3D texture at a world position using manual trilinear interpolation
// (r32float textures are unfilterable in WebGPU — can't use textureSampleLevel)
fn sampleSDF(worldPos: vec3f) -> f32 {
  let uvw = (worldPos - sdfParams.center + sdfParams.extent) / (sdfParams.extent * 2.0);
  if (any(uvw < vec3f(0.0)) || any(uvw > vec3f(1.0))) { return 999.0; }

  let sdfSize = vec3f(textureDimensions(sdfTexture));
  let tc = uvw * sdfSize - 0.5;
  let tc0 = vec3i(floor(tc));
  let f = fract(tc);

  // Clamp to valid range
  let maxC = vec3i(sdfSize) - vec3i(1);
  let c0 = clamp(tc0, vec3i(0), maxC);
  let c1 = clamp(tc0 + vec3i(1), vec3i(0), maxC);

  // 8 texel loads for trilinear
  let v000 = textureLoad(sdfTexture, vec3u(vec3i(c0.x, c0.y, c0.z)), 0).r;
  let v100 = textureLoad(sdfTexture, vec3u(vec3i(c1.x, c0.y, c0.z)), 0).r;
  let v010 = textureLoad(sdfTexture, vec3u(vec3i(c0.x, c1.y, c0.z)), 0).r;
  let v110 = textureLoad(sdfTexture, vec3u(vec3i(c1.x, c1.y, c0.z)), 0).r;
  let v001 = textureLoad(sdfTexture, vec3u(vec3i(c0.x, c0.y, c1.z)), 0).r;
  let v101 = textureLoad(sdfTexture, vec3u(vec3i(c1.x, c0.y, c1.z)), 0).r;
  let v011 = textureLoad(sdfTexture, vec3u(vec3i(c0.x, c1.y, c1.z)), 0).r;
  let v111 = textureLoad(sdfTexture, vec3u(vec3i(c1.x, c1.y, c1.z)), 0).r;

  // Trilinear blend
  let x00 = mix(v000, v100, f.x);
  let x10 = mix(v010, v110, f.x);
  let x01 = mix(v001, v101, f.x);
  let x11 = mix(v011, v111, f.x);
  let xy0 = mix(x00, x10, f.y);
  let xy1 = mix(x01, x11, f.y);
  return mix(xy0, xy1, f.z);
}

// Reconstruct world position from depth buffer using inverseVP
fn worldPosFromDepth(uv: vec2f, rawDepth: f32) -> vec3f {
  let ndcX = uv.x * 2.0 - 1.0;
  let ndcY = 1.0 - uv.y * 2.0;
  let clip = vec4f(ndcX, ndcY, rawDepth, 1.0);
  let world4 = sdfViewParams.inverseViewProj * clip;
  return world4.xyz / world4.w;
}

// Color ramp for SDF distance visualization
fn sdfColorRamp(dist: f32) -> vec3f {
  // Inside geometry (negative): red
  if (dist < 0.0) {
    let t = saturate(-dist / 5.0); // 0-5m inside = gradient
    return mix(vec3f(0.8, 0.2, 0.1), vec3f(0.4, 0.0, 0.0), t);
  }
  // On surface (near zero): bright white/yellow
  if (dist < 0.5) {
    let t = dist / 0.5;
    return mix(vec3f(1.0, 1.0, 0.8), vec3f(0.2, 0.8, 0.3), t);
  }
  // Near surface (0.5-5m): green to cyan
  if (dist < 5.0) {
    let t = (dist - 0.5) / 4.5;
    return mix(vec3f(0.2, 0.8, 0.3), vec3f(0.1, 0.4, 0.8), t);
  }
  // Medium distance (5-20m): blue
  if (dist < 20.0) {
    let t = (dist - 5.0) / 15.0;
    return mix(vec3f(0.1, 0.4, 0.8), vec3f(0.05, 0.1, 0.3), t);
  }
  // Far (>20m): dark blue
  return vec3f(0.03, 0.05, 0.15);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let mode = i32(debugView.params.x);
  let near = debugView.params.y;
  let far = debugView.params.z;
  let sdfAvailable = debugView.params.w;
  let texSize = vec2f(f32(textureDimensions(depthTexture).x), f32(textureDimensions(depthTexture).y));
  let texCoord = vec2i(input.uv * texSize);

  if (mode == 1) {
    // Depth visualization: linearized, remapped to grayscale
    let rawDepth = textureLoad(depthTexture, texCoord, 0);
    if (rawDepth == 0.0) {
      return vec4f(0.2, 0.0, 0.3, 1.0); // Sky = purple
    }
    let linearDepth = linearizeDepthReversed(rawDepth, near, far);
    let normalized = 1.0 - saturate(linearDepth / far);
    return vec4f(vec3f(normalized), 1.0);
  }

  if (mode == 2) {
    // Normals visualization
    let rawDepth = textureLoad(depthTexture, texCoord, 0);
    if (rawDepth == 0.0) {
      return vec4f(0.0, 0.0, 0.0, 1.0); // Sky = black
    }
    
    let packed = textureLoad(normalsTexture, texCoord, 0);
    let normalLength = length(packed.xyz);
    
    if (normalLength > 0.01) {
      return vec4f(packed.xyz, 1.0);
    }
    
    // Fallback: reconstruct from depth derivatives
    let depthR = textureLoad(depthTexture, vec2i(vec2f(texCoord) + vec2f(1.0, 0.0)), 0);
    let depthU = textureLoad(depthTexture, vec2i(vec2f(texCoord) + vec2f(0.0, -1.0)), 0);
    
    let centerLinear = linearizeDepthReversed(rawDepth, near, far);
    let rightLinear = linearizeDepthReversed(depthR, near, far);
    let upLinear = linearizeDepthReversed(depthU, near, far);
    
    let dx = rightLinear - centerLinear;
    let dy = upLinear - centerLinear;
    let normal = normalize(vec3f(-dx * 100.0, 1.0, -dy * 100.0));
    return vec4f(normal * 0.5 + 0.5, 1.0);
  }

  if (mode == 3) {
    // SSR visualization
    let ssrSample = textureLoad(ssrTexture, texCoord, 0);
    let ssrColor = ssrSample.rgb;
    let confidence = ssrSample.a;
    
    if (confidence < 0.01) {
      return vec4f(0.0, 0.0, 0.0, 1.0);
    }
    return vec4f(ssrColor * confidence, 1.0);
  }

  if (mode == 4) {
    // SDF visualization: sample distance field at each pixel's world position
    if (sdfAvailable < 0.5) {
      // SDF not available — show message color (dark red)
      return vec4f(0.15, 0.02, 0.02, 1.0);
    }

    let rawDepth = textureLoad(depthTexture, texCoord, 0);
    
    // Sky pixels: show SDF at a far distance along the view ray
    if (rawDepth == 0.0) {
      return vec4f(0.03, 0.05, 0.15, 1.0); // Dark blue = far/sky
    }

    // Reconstruct world position from depth
    let worldPos = worldPosFromDepth(input.uv, rawDepth);
    
    // Sample SDF at this world position
    let dist = sampleSDF(worldPos);
    
    // Outside SDF volume
    if (dist > 900.0) {
      return vec4f(0.1, 0.1, 0.1, 1.0); // Gray = outside volume
    }

    // Color-ramp the distance
    let color = sdfColorRamp(dist);
    
    // Add isolines every 2 meters for visual reference
    let isolineFreq = 2.0;
    let isoline = abs(fract(dist / isolineFreq + 0.5) - 0.5) * isolineFreq;
    let isolineMask = smoothstep(0.0, 0.15, isoline);
    let finalColor = color * mix(0.6, 1.0, isolineMask);
    
    return vec4f(finalColor, 1.0);
  }

  // Mode 0 = off, shouldn't reach here
  return vec4f(0.0, 0.0, 0.0, 0.0);
}
