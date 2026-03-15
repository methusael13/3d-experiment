// Atmospheric Fog Shader
// Combined aerial perspective (haze) + height fog in a single fullscreen pass.
//
// Haze: Distant objects fade toward the sky horizon color using exponential
//       extinction with height-dependent density (Rayleigh-like aerial perspective).
// Fog:  Ground-level height fog using analytically integrated exponential density
//       along the view ray, with Henyey-Greenstein forward scattering toward the sun.

// ============ Fullscreen Quad Vertex Shader ============

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
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

struct FogUniforms {
  // Camera
  inverseViewProj: mat4x4f,   // 64 bytes (offset 0)
  cameraPosition: vec3f,       // 12 bytes (offset 64)
  near: f32,                   // 4 bytes  (offset 76)
  far: f32,                    // 4 bytes  (offset 80)
  fogMode: f32,                // 4 bytes  (offset 84) 0.0 = exp, 1.0 = exp2
  _pad1: f32,                 // 4 bytes  (offset 88)
  _pad2: f32,                 // 4 bytes  (offset 92)

  // Haze params
  hazeExtinction: f32,         // 4 bytes  (offset 96)  = 1.0 / visibilityDistance
  hazeIntensity: f32,          // 4 bytes  (offset 100)
  hazeScaleHeight: f32,        // 4 bytes  (offset 104)
  hazeEnabled: f32,            // 4 bytes  (offset 108) 1.0 = on, 0.0 = off

  // Height fog params
  fogDensity: f32,             // 4 bytes  (offset 112)
  fogHeight: f32,              // 4 bytes  (offset 116)
  fogHeightFalloff: f32,       // 4 bytes  (offset 120)
  fogEnabled: f32,             // 4 bytes  (offset 124) 1.0 = on, 0.0 = off

  fogColor: vec3f,             // 12 bytes (offset 128)
  fogSunScattering: f32,       // 4 bytes  (offset 140)

  // Sun / light
  sunDirection: vec3f,         // 12 bytes (offset 144)
  sunIntensity: f32,           // 4 bytes  (offset 156)
  sunColor: vec3f,             // 12 bytes (offset 160)
  _pad3: f32,                 // 4 bytes  (offset 172)
}

@group(0) @binding(0) var colorTexture: texture_2d<f32>;
@group(0) @binding(1) var depthTexture: texture_depth_2d;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var<uniform> u: FogUniforms;

// ============ Helpers ============

const PI: f32 = 3.14159265359;

// Rayleigh scattering coefficients (normalized for haze color — blue scatters most)
const RAYLEIGH_RGB: vec3f = vec3f(0.15, 0.35, 0.65);

// Reconstruct world position from depth + UV using reversed-Z
fn reconstructWorldPos(uv: vec2f, depth: f32) -> vec3f {
  // NDC: xy from uv, z = depth (reversed-Z: 1.0 = near, 0.0 = far)
  let ndc = vec4f(uv * 2.0 - 1.0, depth, 1.0);
  // Flip Y for WebGPU (NDC Y points up, UV Y points down)
  let ndcFlipped = vec4f(ndc.x, -ndc.y, ndc.z, 1.0);
  let worldH = u.inverseViewProj * ndcFlipped;
  return worldH.xyz / worldH.w;
}

// Linearize reversed-Z depth to view-space distance
fn linearizeDepthReversedZ(depth: f32) -> f32 {
  // For reversed-Z: near maps to 1.0, far maps to 0.0
  // Linear depth = near * far / (far - depth * (far - near))
  let z = depth;
  return u.near * u.far / (u.far - z * (u.far - u.near));
}

// Compute the lit fog color based on sun/moon illumination.
// Fog particles have no inherent brightness — they scatter ambient light.
// fogColor is the base tint; sunColor × sunIntensity provides the actual illumination.
fn computeLitFogColor(viewDir: vec3f) -> vec3f {
  // Ambient illumination on fog from sun/moon (normalized to daytime reference of 20.0)
  let fogIllumination = u.sunColor * saturate(u.sunIntensity / 20.0);
  let litFogColor = u.fogColor * fogIllumination;

  // Forward scattering glow when looking toward the sun (Mie-like)
  let cosAngle = dot(viewDir, normalize(u.sunDirection));
  let scatterPhase = hgPhase(cosAngle, 0.7);
  let sunGlow = u.sunColor * scatterPhase * u.fogSunScattering * u.sunIntensity * 0.1;

  return litFogColor + sunGlow;
}

// Henyey-Greenstein phase function for forward scattering
fn hgPhase(cosTheta: f32, g: f32) -> f32 {
  let g2 = g * g;
  let denom = 1.0 + g2 - 2.0 * g * cosTheta;
  return (1.0 - g2) / (4.0 * PI * pow(denom, 1.5));
}

// Compute sky horizon color from sun direction using simplified Rayleigh model.
// This approximates what the Nishita scattering produces at the horizon,
// ensuring haze blends seamlessly with the sky background.
fn computeHorizonColor(sunDir: vec3f) -> vec3f {
  // Sun elevation factor: at horizon (y≈0) we get warm sunset colors,
  // higher up we get more blue
  let sunElevation = max(0.0, sunDir.y);

  // Base horizon blue (Rayleigh scattering at horizon)
  let horizonBlue = vec3f(0.45, 0.6, 0.85);

  // Warm sunset tint when sun is low
  let sunsetWarm = vec3f(0.85, 0.55, 0.35);

  // Mix based on sun elevation: low sun → warm, high sun → blue
  let t = smoothstep(0.0, 0.4, sunElevation);
  var horizonColor = mix(sunsetWarm, horizonBlue, t);

  // Scale by sun intensity (dimmer at night)
  let intensityScale = saturate(sunElevation * 5.0 + 0.1);
  horizonColor *= intensityScale;

  return horizonColor;
}

// ============ Atmospheric Haze (Aerial Perspective) ============

// Exponential extinction with altitude-dependent density.
// Objects at distance d and height h are obscured by:
//   factor = 1 - exp(-extinction * d * exp(-h / scaleHeight))
fn computeHaze(worldPos: vec3f, dist: f32) -> vec3f {
  let height = max(0.0, worldPos.y);

  // Height-dependent optical depth: denser near ground, thins with altitude
  let heightDensity = exp(-height / u.hazeScaleHeight);
  let opticalDepth = u.hazeExtinction * dist * heightDensity;
  let hazeFactor = saturate((1.0 - exp(-opticalDepth)) * u.hazeIntensity);

  // Haze color: sky horizon color blended with Rayleigh blue tint
  let horizonColor = computeHorizonColor(u.sunDirection);
  let hazeColor = mix(horizonColor, horizonColor * RAYLEIGH_RGB * 3.0, 0.3);

  return hazeColor * hazeFactor;
}

fn computeHazeFactor(worldPos: vec3f, dist: f32) -> f32 {
  let height = max(0.0, worldPos.y);
  let heightDensity = exp(-height / u.hazeScaleHeight);
  let opticalDepth = u.hazeExtinction * dist * heightDensity;
  return saturate((1.0 - exp(-opticalDepth)) * u.hazeIntensity);
}

// ============ Height Fog ============

// Analytically integrated exponential height fog along the view ray.
// The fog density at height h is: density(h) = globalDensity * exp(-falloff * (h - fogHeight))
// Integrating along the ray from camera to point gives a closed-form solution.
fn computeHeightFog(worldPos: vec3f, cameraPos: vec3f, dist: f32) -> f32 {
  let rayDir = (worldPos - cameraPos) / max(dist, 0.001);

  // Height difference between camera and endpoint
  let heightA = cameraPos.y - u.fogHeight;
  let heightB = worldPos.y - u.fogHeight;

  // Fog density at camera and endpoint heights
  // No max(0,...) clamp — negative heights (below fogHeight) correctly yield
  // higher density via positive exponent, and the integral stays continuous.
  let densityA = u.fogDensity * exp(-u.fogHeightFalloff * heightA);
  let densityB = u.fogDensity * exp(-u.fogHeightFalloff * heightB);

  // Analytical integration along the ray
  // For a vertical ray component dy, the integrated density is:
  //   integral = (densityA - densityB) / (falloff * dy_component)
  // For near-horizontal rays, use average density to avoid division by near-zero
  let dy = rayDir.y;
  var fogAmount: f32;

  if (abs(dy) > 0.001) {
    // Standard analytical integration of exponential height fog along ray.
    // The integrated optical depth is: (densityA - densityB) / (falloff * dy)
    // where dy already encodes the ray length (it's the vertical component of
    // the *unit* direction times dist, baked into heightA/B endpoint difference).
    fogAmount = abs((densityA - densityB) / (u.fogHeightFalloff * dy));
  } else {
    // Near-horizontal ray: use average density × distance
    let avgDensity = (densityA + densityB) * 0.5;
    fogAmount = avgDensity * dist;
  }

  // Apply absorption: exp (gradual) or exp2 (clear near, sharp wall)
  if (u.fogMode > 0.5) {
    // Exp² mode: clear near camera, then steep fog wall (Silent Hill style)
    return saturate(1.0 - exp(-fogAmount * fogAmount));
  }
  return saturate(1.0 - exp(-fogAmount));
}

// ============ Fragment Shader ============

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // Sample scene color (HDR)
  let sceneColor = textureSample(colorTexture, texSampler, uv);
  var color = sceneColor.rgb;

  // Sample depth (texture_depth_2d returns f32 directly, not vec4)
  let texSize = textureDimensions(depthTexture);
  let pixelCoord = vec2i(vec2f(texSize) * uv);
  let depth = textureLoad(depthTexture, pixelCoord, 0);

  // Reconstruct view direction from UV (for sky fog blending)
  let ndcForDir = vec4f(uv * 2.0 - 1.0, 0.5, 1.0);
  let ndcFlippedDir = vec4f(ndcForDir.x, -ndcForDir.y, ndcForDir.z, 1.0);
  let worldFar = u.inverseViewProj * ndcFlippedDir;
  let viewDir = normalize(worldFar.xyz / worldFar.w - u.cameraPosition);

  // Sky pixels (reversed-Z: depth buffer cleared to exactly 0.0).
  // Must use exact zero check — with large far planes, valid geometry at far distances
  // can have very small depth values (e.g. 0.00005) that would be misclassified as sky
  // with a loose threshold like 0.0001.
  let isSky = depth == 0.0;

  if (isSky) {
    // Sky pixels use the SAME analytical fog/haze integration as geometry,
    // but with a virtual far point along the view ray. This ensures the sky
    // at the horizon converges to exactly the same color that distant geometry
    // fades toward — no heuristic mismatch.

    // Virtual far point: place it at the visibility distance along the view ray.
    // This represents "what a surface at the visibility limit would look like".
    let skyDist = 1.0 / max(u.hazeExtinction, 0.0001); // = visibilityDistance
    let skyWorldPos = u.cameraPosition + viewDir * skyDist;

    // ── Sky Haze (same computation as geometry) ──
    if (u.hazeEnabled > 0.5) {
      let hazeColor = computeHaze(skyWorldPos, skyDist);
      let hazeFactor = computeHazeFactor(skyWorldPos, skyDist);
      color = color * (1.0 - hazeFactor) + hazeColor;
    }

    // ── Sky Height Fog (same analytical integration as geometry) ──
    if (u.fogEnabled > 0.5) {
      let fogFactor = computeHeightFog(skyWorldPos, u.cameraPosition, skyDist);
      let finalFogColor = computeLitFogColor(viewDir);
      color = mix(color, finalFogColor, fogFactor);
    }

    return vec4f(color, sceneColor.a);
  }

  // ── Geometry pixels: reconstruct world position from depth ──
  let worldPos = reconstructWorldPos(uv, depth);
  let toPoint = worldPos - u.cameraPosition;
  let dist = length(toPoint);

  // ── Atmospheric Haze (aerial perspective) ──
  if (u.hazeEnabled > 0.5) {
    let hazeColor = computeHaze(worldPos, dist);
    let hazeFactor = computeHazeFactor(worldPos, dist);

    // Additive blend: scene fades out, haze color fades in
    color = color * (1.0 - hazeFactor) + hazeColor;
  }

  // ── Height Fog ──
  if (u.fogEnabled > 0.5) {
    let fogFactor = computeHeightFog(worldPos, u.cameraPosition, dist);
    let finalFogColor = computeLitFogColor(viewDir);
    color = mix(color, finalFogColor, fogFactor);
  }

  return vec4f(color, sceneColor.a);
}
