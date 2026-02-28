// Screen Space Reflections (SSR) Shader
// Hi-Z ray marching in screen space with binary refinement
// Reconstructs normals from depth derivatives (no G-buffer required)
//
// Uses reversed-Z depth buffer (WebGPU): z=1 at near, z=0 at far

// ============================================================================
// Uniforms
// ============================================================================

struct SSRParams {
  // Row 0: projectionMatrix (mat4x4f) - 64 bytes
  projectionMatrix: mat4x4f,
  // Row 4: inverseProjectionMatrix (mat4x4f) - 64 bytes
  inverseProjectionMatrix: mat4x4f,
  // Row 8: viewMatrix (mat4x4f) - 64 bytes
  viewMatrix: mat4x4f,
  // Row 12: inverseViewMatrix (mat4x4f) - 64 bytes
  inverseViewMatrix: mat4x4f,
  // Row 16: params1 (vec4f) - 16 bytes
  // x = maxSteps, y = refinementSteps, z = maxDistance, w = stepSize
  params1: vec4f,
  // Row 17: params2 (vec4f) - 16 bytes
  // x = thickness, y = edgeFade, z = jitter (0 or 1), w = time (for jitter)
  params2: vec4f,
  // Row 18: params3 (vec4f) - 16 bytes
  // x = width, y = height, z = near, w = far
  params3: vec4f,
}

// ============================================================================
// Bindings
// ============================================================================

@group(0) @binding(0) var<uniform> ssr: SSRParams;
@group(0) @binding(1) var depthTexture: texture_depth_2d;
@group(0) @binding(2) var sceneColorTexture: texture_2d<f32>;
@group(0) @binding(3) var normalsTexture: texture_2d<f32>;   // World-space normals G-buffer (packed 0-1)

// ============================================================================
// Fullscreen Vertex Shader
// ============================================================================

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  
  // Generate fullscreen triangle from vertex index
  let x = f32(i32(vertexIndex) / 2) * 4.0 - 1.0;
  let y = f32(i32(vertexIndex) % 2) * 4.0 - 1.0;
  
  output.position = vec4f(x, y, 0.0, 1.0);
  output.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  
  return output;
}

// ============================================================================
// Helper Functions
// ============================================================================

// Linearize reversed-Z depth to view-space distance
fn linearizeDepthReversed(d: f32, near: f32, far: f32) -> f32 {
  return near * far / (near + d * (far - near));
}

// Reconstruct view-space position from screen UV and depth
fn reconstructViewPos(uv: vec2f, depth: f32) -> vec3f {
  // Convert UV to NDC: x,y in [-1,1], z is raw depth
  let ndc = vec4f(uv.x * 2.0 - 1.0, (1.0 - uv.y) * 2.0 - 1.0, depth, 1.0);
  let viewPos = ssr.inverseProjectionMatrix * ndc;
  return viewPos.xyz / viewPos.w;
}

// Reconstruct view-space normal from depth derivatives (fallback when G-buffer is empty)
fn reconstructNormalFromDepth(uv: vec2f, centerDepth: f32) -> vec3f {
  let width = ssr.params3.x;
  let height = ssr.params3.y;
  let pixelCoord = uv * vec2f(width, height);
  
  let depthRight = textureLoad(depthTexture, vec2i(pixelCoord + vec2f(1.0, 0.0)), 0);
  let depthUp = textureLoad(depthTexture, vec2i(pixelCoord + vec2f(0.0, -1.0)), 0);
  
  let center = reconstructViewPos(uv, centerDepth);
  let texelSize = vec2f(1.0 / width, 1.0 / height);
  let right = reconstructViewPos(uv + vec2f(texelSize.x, 0.0), depthRight);
  let up = reconstructViewPos(uv + vec2f(0.0, -texelSize.y), depthUp);
  
  let dx = right - center;
  let dy = up - center;
  return normalize(cross(dx, dy));
}

// Read world-space normal from G-buffer and transform to view space.
// Falls back to depth-reconstructed normal when G-buffer is empty (terrain, ground, etc.)
fn getViewNormal(texCoord: vec2i, uv: vec2f, depth: f32) -> vec3f {
  let packed = textureLoad(normalsTexture, texCoord, 0);
  
  // Check if G-buffer has valid data (non-zero normal means an object wrote normals)
  let normalLength = length(packed.xyz);
  if (normalLength < 0.01) {
    // G-buffer empty at this pixel (terrain, ground, sky pass don't write normals)
    // Fall back to depth-derivative reconstruction
    return reconstructNormalFromDepth(uv, depth);
  }
  
  // Unpack normal from [0,1] to [-1,1]
  let worldNormal = packed.xyz * 2.0 - 1.0;
  // Transform world normal to view space: V * N (not V^T * N)
  // In column-major WGSL, mat * vec is the correct world→view transform
  let viewNormal = normalize((ssr.viewMatrix * vec4f(worldNormal, 0.0)).xyz);
  return viewNormal;
}

// Get metallic value from normals G-buffer (stored in alpha channel)
fn getMetallic(texCoord: vec2i) -> f32 {
  return textureLoad(normalsTexture, texCoord, 0).w;
}

// Simple hash for jitter
fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

// Project view-space position to screen UV + depth
fn projectToScreen(viewPos: vec3f) -> vec3f {
  let clipPos = ssr.projectionMatrix * vec4f(viewPos, 1.0);
  let ndc = clipPos.xyz / clipPos.w;
  // NDC to screen UV (flip Y for WebGPU convention)
  let screenUV = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  return vec3f(screenUV, ndc.z);
}

// ============================================================================
// Screen-Space Ray March
// ============================================================================

struct RayMarchResult {
  hit: bool,
  uv: vec2f,
  confidence: f32,
}

fn rayMarch(origin: vec3f, direction: vec3f, jitterAmount: f32) -> RayMarchResult {
  var result: RayMarchResult;
  result.hit = false;
  result.uv = vec2f(0.0);
  result.confidence = 0.0;
  
  let maxSteps = i32(ssr.params1.x);
  let refinementSteps = i32(ssr.params1.y);
  let maxDistance = ssr.params1.z;
  let baseStepSize = ssr.params1.w;
  let thickness = ssr.params2.x;
  let near = ssr.params3.z;
  let far = ssr.params3.w;
  let width = ssr.params3.x;
  let height = ssr.params3.y;
  
  // Step along the reflection ray in view space
  var rayPos = origin;
  var stepSize = baseStepSize;
  
  // Apply jitter to starting position to break banding
  rayPos += direction * stepSize * jitterAmount;
  
  for (var i = 0; i < maxSteps; i++) {
    rayPos += direction * stepSize;
    
    // Check if ray is too far
    let rayDist = length(rayPos - origin);
    if (rayDist > maxDistance) {
      break;
    }
    
    // Project current ray position to screen
    let screenCoord = projectToScreen(rayPos);
    let screenUV = screenCoord.xy;
    let rayDepthNDC = screenCoord.z;
    
    // Check screen bounds
    if (screenUV.x < 0.0 || screenUV.x > 1.0 || screenUV.y < 0.0 || screenUV.y > 1.0) {
      break;
    }
    
    // Sample depth buffer at ray's screen position
    let texCoord = vec2i(screenUV * vec2f(width, height));
    let sceneDepthNDC = textureLoad(depthTexture, texCoord, 0);
    
    // Skip sky pixels (reversed-Z: 0 = far plane / sky)
    if (sceneDepthNDC < 0.0001) {
      continue;
    }
    
    // Linearize both depths for thickness comparison
    let sceneDepthLinear = linearizeDepthReversed(sceneDepthNDC, near, far);
    let rayDepthLinear = -rayPos.z; // View space Z is negative (looking down -Z)
    
    // Check for intersection: ray is behind geometry within thickness
    let depthDiff = rayDepthLinear - sceneDepthLinear;
    
    if (depthDiff > 0.0 && depthDiff < thickness * (1.0 + rayDist * 0.01)) {
      // Hit! Now do binary refinement for precision
      var hitPos = rayPos;
      var stepBack = stepSize * 0.5;
      
      for (var r = 0; r < refinementSteps; r++) {
        hitPos -= direction * stepBack;
        
        let refineScreen = projectToScreen(hitPos);
        let refineTexCoord = vec2i(refineScreen.xy * vec2f(width, height));
        let refineSceneDepth = textureLoad(depthTexture, refineTexCoord, 0);
        let refineSceneLinear = linearizeDepthReversed(refineSceneDepth, near, far);
        let refineRayLinear = -hitPos.z;
        let refineDiff = refineRayLinear - refineSceneLinear;
        
        if (refineDiff > 0.0) {
          // Still behind - step back more
          stepBack *= 0.5;
        } else {
          // In front - step forward
          hitPos += direction * stepBack;
          stepBack *= 0.5;
        }
      }
      
      // Get final screen UV
      let finalScreen = projectToScreen(hitPos);
      result.uv = finalScreen.xy;
      
      // Confidence based on various factors
      var confidence = 1.0;
      
      // Fade at screen edges
      let edgeFade = ssr.params2.y;
      let edgeX = smoothstep(0.0, edgeFade, result.uv.x) * smoothstep(1.0, 1.0 - edgeFade, result.uv.x);
      let edgeY = smoothstep(0.0, edgeFade, result.uv.y) * smoothstep(1.0, 1.0 - edgeFade, result.uv.y);
      confidence *= edgeX * edgeY;
      
      // Fade with ray distance
      let distanceFade = 1.0 - saturate(rayDist / maxDistance);
      confidence *= distanceFade;
      
      // Fade based on how close the depth match is (thinner = more confident)
      let thicknessFade = 1.0 - saturate(depthDiff / thickness);
      confidence *= thicknessFade;
      
      result.hit = true;
      result.confidence = saturate(confidence);
      return result;
    }
    
    // Adaptive step size: increase with distance for efficiency
    stepSize = baseStepSize * (1.0 + rayDist * 0.02);
  }
  
  return result;
}

// ============================================================================
// Fragment Shader
// ============================================================================

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let uv = input.uv;
  let width = ssr.params3.x;
  let height = ssr.params3.y;
  let near = ssr.params3.z;
  let far = ssr.params3.w;
  
  // Sample depth
  let texCoord = vec2i(uv * vec2f(width, height));
  let depth = textureLoad(depthTexture, texCoord, 0);
  
  // Skip sky (reversed-Z: 0 = far plane)
  if (depth < 0.0001) {
    return vec4f(0.0, 0.0, 0.0, 0.0);
  }
  
  // Reconstruct view-space position
  let viewPos = reconstructViewPos(uv, depth);
  
  // Read view-space normal from G-buffer (with depth-reconstruction fallback for terrain/ground)
  let viewNormal = getViewNormal(texCoord, uv, depth);
  
  // Skip surfaces facing away from camera (backfaces)
  // In view space, camera looks down -Z, so normal.z > 0 means facing camera
  if (viewNormal.z < 0.05) {
    return vec4f(0.0, 0.0, 0.0, 0.0);
  }
  
  // Calculate reflection direction in view space
  let viewDir = normalize(viewPos);
  let reflectDir = reflect(viewDir, viewNormal);
  
  // Skip reflections pointing toward camera (they'd reflect behind the screen)
  if (reflectDir.z > 0.0) {
    return vec4f(0.0, 0.0, 0.0, 0.0);
  }
  
  // Compute jitter amount
  var jitterAmount = 0.0;
  if (ssr.params2.z > 0.5) {
    let time = ssr.params2.w;
    jitterAmount = hash(uv * vec2f(width, height) + vec2f(time * 100.0, time * 73.0));
  }
  
  // Ray march in view space
  let result = rayMarch(viewPos, reflectDir, jitterAmount);
  
  if (result.hit) {
    // Sample scene color at hit position
    let hitTexCoord = vec2i(result.uv * vec2f(width, height));
    let hitColor = textureLoad(sceneColorTexture, hitTexCoord, 0).rgb;
    
    // Output: RGB = reflected color, A = confidence/mask
    return vec4f(hitColor, result.confidence);
  }
  
  return vec4f(0.0, 0.0, 0.0, 0.0);
}