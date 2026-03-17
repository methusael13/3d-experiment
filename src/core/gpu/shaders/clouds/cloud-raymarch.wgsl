/**
 * cloud-raymarch.wgsl — Volumetric cloud ray march compute shader
 *
 * Marches rays through a spherical cloud shell, sampling 3D noise textures
 * and a 2D weather map to compute cloud color + transmittance.
 *
 * Output: rgba16float texture
 *   RGB = in-scattered light (cloud color from sun illumination)
 *   A   = transmittance (1 = fully transparent, 0 = fully opaque)
 *
 * Phase 2: Multi-scattering approximation, time-of-day coloring, improved
 *          height gradients per cloud type, detail erosion modulation.
 */

// ========== Uniforms ==========

struct CloudUniforms {
  inverseViewProj: mat4x4f,     // [0..63]
  cameraPosition: vec3f,        // [64..75]
  time: f32,                    // [76..79]
  sunDirection: vec3f,          // [80..91]
  sunIntensity: f32,            // [92..95]
  sunColor: vec3f,              // [96..107]
  coverage: f32,                // [108..111]
  cloudBase: f32,               // [112..115]
  cloudThickness: f32,          // [116..119]
  density: f32,                 // [120..123]  extinction coefficient
  cloudType: f32,               // [124..127]
  weatherOffset: vec2f,         // [128..135]  wind-driven UV offset
  near: f32,                    // [136..139]
  far: f32,                     // [140..143]
  resolution: vec2u,            // [144..151]  half-res output dimensions
  earthRadius: f32,             // [152..155]
  frameIndex: u32,              // [156..159]  frame counter for checkerboard + blue noise
  fullResolution: vec2u,        // [160..167]  full viewport dimensions
  checkerboard: u32,            // [168..171]  1 = checkerboard enabled
  _pad1: f32,                   // [172..175]
}

@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var shapeNoise: texture_3d<f32>;
@group(0) @binding(3) var detailNoise: texture_3d<f32>;
@group(0) @binding(4) var weatherMap: texture_2d<f32>;
@group(0) @binding(5) var noiseSampler: sampler;
@group(0) @binding(6) var blueNoiseTexture: texture_2d<f32>;

// ========== Constants ==========

const PI = 3.14159265358979;
const MAX_MARCH_STEPS = 64;
const MAX_LIGHT_STEPS = 6;
const STEP_SIZE_EMPTY = 200.0;    // Step size in empty space (meters)
const STEP_SIZE_CLOUD = 80.0;     // Step size inside cloud (meters)
const LIGHT_STEP_SIZE = 400.0;    // Step size for light march
const TRANSMITTANCE_THRESHOLD = 0.01;

// ========== Utility ==========

fn remap(value: f32, oldMin: f32, oldMax: f32, newMin: f32, newMax: f32) -> f32 {
  return newMin + (saturate((value - oldMin) / (oldMax - oldMin))) * (newMax - newMin);
}

// ========== Phase Function ==========

fn henyeyGreenstein(cosTheta: f32, g: f32) -> f32 {
  let g2 = g * g;
  let denom = 1.0 + g2 - 2.0 * g * cosTheta;
  return (1.0 - g2) / (4.0 * PI * pow(denom, 1.5));
}

// ========== Height Gradient ==========

fn heightGradient(heightFrac: f32, cloudType: f32) -> f32 {
  if (cloudType < 0.25) {
    return smoothstep(0.0, 0.05, heightFrac) * smoothstep(1.0, 0.95, heightFrac);
  } else if (cloudType < 0.6) {
    return smoothstep(0.0, 0.08, heightFrac) * smoothstep(1.0, 0.7, heightFrac);
  } else {
    return smoothstep(0.0, 0.1, heightFrac) * smoothstep(1.0, 0.6, heightFrac);
  }
}

// ========== Ray-Sphere Intersection ==========

fn raySphereIntersect(ro: vec3f, rd: vec3f, radius: f32) -> vec2f {
  let a = dot(rd, rd);
  let b = 2.0 * dot(ro, rd);
  let c = dot(ro, ro) - radius * radius;
  let discriminant = b * b - 4.0 * a * c;
  if (discriminant < 0.0) {
    return vec2f(-1.0, -1.0);
  }
  let sqrtD = sqrt(discriminant);
  let t0 = (-b - sqrtD) / (2.0 * a);
  let t1 = (-b + sqrtD) / (2.0 * a);
  return vec2f(t0, t1);
}

// ========== Cloud Density ==========

fn sampleDensity(p: vec3f) -> f32 {
  // 1. Height fraction within cloud layer [0, 1]
  let altitude = length(p) - u.earthRadius;
  let heightFrac = saturate((altitude - u.cloudBase) / u.cloudThickness);

  // 2. Height-based density profile
  let hGrad = heightGradient(heightFrac, u.cloudType);
  if (hGrad < 0.001) { return 0.0; }

  // 3. Weather map sample — use world XZ relative to camera for sensible tiling
  //    (Earth-centered XZ is huge; we want tiling relative to the scene)
  let worldXZ = p.xz; // Earth-centered, but the fract() makes it tile
  let weatherUV = fract(worldXZ * 0.00002 + u.weatherOffset);
  let weather = textureSampleLevel(weatherMap, noiseSampler, weatherUV, 0.0);
  let coverageVal = weather.r * u.coverage * 2.5; // Amplify by global coverage
  let cloudTypeVal = weather.g;

  // Early out if no coverage here
  if (coverageVal < 0.05) {
    return 0.0;
  }

  // 4. Base shape from 3D noise — scale relative to cloud layer, not absolute position
  let noisePos = vec3f(p.x, (altitude - u.cloudBase), p.z);
  let uvw = noisePos * 0.0004;
  let shape = textureSampleLevel(shapeNoise, noiseSampler, uvw, 0.0);
  // FBM combination of the shape channels
  let shapeFBM = shape.r * 0.625 + shape.g * 0.25 + shape.b * 0.125;

  // 5. Combine shape with height gradient and coverage
  var density = shapeFBM * hGrad;
  // Apply coverage: higher coverage = more area passes threshold
  density = saturate(remap(density, 1.0 - coverageVal, 1.0, 0.0, 1.0));

  // 6. Erode edges with detail noise — smooth transition, no hard threshold.
  // Scale erosion by the current density so that at cloud edges (density near 0)
  // the erosion naturally tapers to zero, preventing the hard on/off discontinuity
  // that causes shimmering when combined with blue noise dithering + checkerboard.
  {
    let detailUVW = noisePos * 0.003;
    let detail = textureSampleLevel(detailNoise, noiseSampler, detailUVW, 0.0);
    let detailFBM = detail.r * 0.625 + detail.g * 0.25 + detail.b * 0.125;
    let detailModifier = mix(detailFBM, 1.0 - detailFBM, saturate(heightFrac * 5.0));
    let baseErosionStrength = mix(0.1, 0.25, saturate(cloudTypeVal));
    // Density-scaled erosion: fade erosion to 0 as density approaches 0.
    // smoothstep provides a soft ramp instead of a hard threshold cliff.
    let densityFade = smoothstep(0.0, 0.15, density);
    let erosionStrength = baseErosionStrength * densityFade;
    density = remap(density, detailModifier * erosionStrength, 1.0, 0.0, 1.0);
  }

  return max(0.0, density);
}

// ========== Light March (self-shadowing) ==========

fn lightMarch(pos: vec3f, dither: f32) -> f32 {
  var opticalDepth = 0.0;
  var samplePos = pos;

  // Dither the light march start to break up regular banding
  samplePos += u.sunDirection * LIGHT_STEP_SIZE * dither * 0.5;

  // Use exponentially increasing step sizes to reduce banding
  var stepSize = LIGHT_STEP_SIZE * 0.5;
  for (var i = 0; i < MAX_LIGHT_STEPS; i++) {
    samplePos += u.sunDirection * stepSize;

    // Check if we've left the cloud layer
    let alt = length(samplePos) - u.earthRadius;
    if (alt < u.cloudBase || alt > u.cloudBase + u.cloudThickness) {
      break;
    }

    opticalDepth += sampleDensity(samplePos) * stepSize;
    stepSize *= 1.4; // Exponentially increasing steps
  }

  return exp(-opticalDepth * u.density);
}

// ========== Blue Noise Dither ==========

fn blueNoiseDither(pixelCoord: vec2u) -> f32 {
  // Sample blue noise texture with per-frame rotation to break up temporal patterns
  let noiseSize = textureDimensions(blueNoiseTexture);
  // Rotate sample coordinates each frame using golden ratio offset
  let frameOffset = u.frameIndex * 97u; // prime multiplier for good distribution
  let sampleCoord = vec2u(
    (pixelCoord.x + frameOffset) % noiseSize.x,
    (pixelCoord.y + frameOffset * 7u) % noiseSize.y
  );
  let noise = textureLoad(blueNoiseTexture, sampleCoord, 0).r;
  return noise;
}

// ========== Checkerboard ==========

/// Returns true if this pixel should be ray-marched this frame.
/// When checkerboard is enabled, only half the pixels are marched per frame.
fn shouldMarchThisFrame(coord: vec2u) -> bool {
  if (u.checkerboard == 0u) {
    return true; // Checkerboard disabled — march all pixels
  }
  return ((coord.x + coord.y + u.frameIndex) % 2u) == 0u;
}

// ========== Main ==========

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let pixelCoord = globalId.xy;
  if (pixelCoord.x >= u.resolution.x || pixelCoord.y >= u.resolution.y) {
    return;
  }

  // Checkerboard: skip non-marched pixels (they'll be reconstructed by temporal filter)
  if (!shouldMarchThisFrame(pixelCoord)) {
    // Write transparent black — the temporal filter will reconstruct from history + neighbors
    textureStore(outputTexture, pixelCoord, vec4f(0.0, 0.0, 0.0, 1.0));
    return;
  }

  // 1. Reconstruct view ray from pixel coordinate
  let uv = (vec2f(pixelCoord) + 0.5) / vec2f(u.resolution);
  let ndc = uv * 2.0 - 1.0;
  // Flip Y for NDC (clip space Y goes up, screen Y goes down)
  let clipPos = vec4f(ndc.x, -ndc.y, 1.0, 1.0);
  let worldPos4 = u.inverseViewProj * clipPos;
  let worldTarget = worldPos4.xyz / worldPos4.w;

  // Camera position on the Earth surface (translate to Earth-centered coords)
  let earthCenter = vec3f(0.0, -u.earthRadius, 0.0);
  let camPosEC = u.cameraPosition - earthCenter; // Relative to Earth center
  let rayDir = normalize(worldTarget - u.cameraPosition);

  // 2. Intersect ray with cloud shell spheres
  let innerRadius = u.earthRadius + u.cloudBase;
  let outerRadius = u.earthRadius + u.cloudBase + u.cloudThickness;

  let innerHit = raySphereIntersect(camPosEC, rayDir, innerRadius);
  let outerHit = raySphereIntersect(camPosEC, rayDir, outerRadius);

  // Determine entry and exit distances
  var tEntry: f32;
  var tExit: f32;

  let camAltitude = length(camPosEC) - u.earthRadius;

  if (camAltitude < u.cloudBase) {
    // Camera below clouds: ray must go upward to hit the cloud shell above us.
    // Check if the ray is pointing upward relative to Earth surface normal.
    let upDir = normalize(camPosEC);
    let cosUp = dot(rayDir, upDir);
    if (cosUp <= 0.0) {
      // Ray points downward/horizontal — won't hit clouds above
      textureStore(outputTexture, pixelCoord, vec4f(0.0, 0.0, 0.0, 1.0));
      return;
    }
    // Use the NEAR intersection of inner sphere that's ahead of us (going up)
    // innerHit.y = far exit when inside sphere, but for a ray going up from inside,
    // this is where it exits upward through the inner sphere shell
    tEntry = max(innerHit.y, 0.0);
    tExit = outerHit.y;
  } else if (camAltitude > u.cloudBase + u.cloudThickness) {
    // Camera above clouds: enter at outer sphere, exit at inner sphere
    if (outerHit.x < 0.0) {
      // No forward intersection with outer sphere
      textureStore(outputTexture, pixelCoord, vec4f(0.0, 0.0, 0.0, 1.0));
      return;
    }
    tEntry = outerHit.x;
    tExit = max(innerHit.x, outerHit.x); // inner may not be hit if ray is tangent
  } else {
    // Camera inside cloud layer
    tEntry = 0.0;
    tExit = outerHit.y;
  }

  // No intersection or behind camera
  if (tEntry < 0.0 || tExit < 0.0 || tEntry >= tExit) {
    textureStore(outputTexture, pixelCoord, vec4f(0.0, 0.0, 0.0, 1.0));
    return;
  }

  // Cap march distance for performance
  tExit = min(tExit, tEntry + 30000.0);

  // 3. Per-pixel blue noise dither to reduce banding
  // Note: We intentionally do NOT snap tEntry to a world-aligned grid here.
  // The grid snap (dot(worldPos, 1.0) / stepSize) causes radial stretching
  // when the camera translates because the snap offset varies non-uniformly
  // across ray directions. Instead, we rely on blue noise dithering alone,
  // which produces smooth results without translation-dependent artifacts.
  let dither = blueNoiseDither(pixelCoord);
  tEntry += dither * STEP_SIZE_CLOUD * 0.5;

  // 4. Ray march through cloud layer
  var scatteredLight = vec3f(0.0);
  var transmittance = 1.0;
  var t = tEntry;
  var stepSize = STEP_SIZE_CLOUD;
  var zeroDensityCount = 0u;

  let cosTheta = dot(rayDir, u.sunDirection);

  // ========== Time-of-day coloring ==========
  // u.sunColor already includes the day→night transition from DirectionalLight
  // (moonlight blue hue at ~0.03 intensity when sun is below horizon).
  // u.sunDirection points TOWARDS the light source (not from it).
  //
  // Night detection: use the intensity magnitude rather than direction,
  // because the direction always points towards the light source (moon or sun)
  // and its Y component doesn't indicate day/night.
  let intensityMag = length(u.sunColor) * u.sunIntensity;

  // Sunset: detected when intensity is in the transition range (moderate)
  // Full day: intensityMag >> 1.0, night: intensityMag < 0.1
  let sunsetFactor = smoothstep(0.05, 0.3, intensityMag) * (1.0 - smoothstep(0.5, 2.0, intensityMag));
  let sunsetTint = mix(vec3f(1.0), vec3f(1.6, 0.7, 0.3), sunsetFactor * 0.6);

  // Effective sun color: use the DirectionalLight's color (already moon-tinted at night)
  // with additional sunset atmospheric tint
  let effectiveSunColor = u.sunColor * sunsetTint;
  let effectiveSunIntensity = u.sunIntensity;

  // Night detection: low intensity = night (moonlight)
  let nightFactor = 1.0 - smoothstep(0.0, 0.5, intensityMag);

  // Ambient sky color shifts with time of day
  let daySkyAmbient = vec3f(0.4, 0.5, 0.7);
  let sunsetSkyAmbient = vec3f(0.5, 0.35, 0.25);
  let nightSkyAmbient = vec3f(0.05, 0.06, 0.12);
  var skyAmbient = mix(daySkyAmbient, sunsetSkyAmbient, sunsetFactor);
  skyAmbient = mix(skyAmbient, nightSkyAmbient, nightFactor);

  for (var i = 0; i < MAX_MARCH_STEPS; i++) {
    if (t >= tExit) { break; }
    if (transmittance < TRANSMITTANCE_THRESHOLD) { break; }

    let samplePos = camPosEC + rayDir * t;
    let density = sampleDensity(samplePos);

    if (density > 0.001) {
      zeroDensityCount = 0u;

      // Switch to fine step size
      stepSize = STEP_SIZE_CLOUD;

      // Beer-Lambert extinction
      let extinction = density * u.density;
      let transmittanceStep = exp(-extinction * stepSize);

      // Light march for self-shadowing (dithered to break banding)
      let sunTransmittance = lightMarch(samplePos, dither);

      // ========== Frostbite multi-scattering approximation (3 octaves) ==========
      // Each octave reduces attenuation (light penetrates deeper) and scattering
      // becomes more isotropic — simulates multiple-bounce light diffusion
      var totalScattering = vec3f(0.0);
      var attenuationFactor = 1.0;
      var contributionFactor = 1.0;
      var phaseFactor = 1.0;
      for (var oct = 0; oct < 3; oct++) {
        let octTransmittance = pow(sunTransmittance, attenuationFactor);
        // Blend forward/backward scatter with isotropic, increasingly isotropic per octave
        let octPhaseForward = henyeyGreenstein(cosTheta, 0.8 * phaseFactor);
        let octPhaseBack = henyeyGreenstein(cosTheta, -0.3 * phaseFactor);
        let octPhaseDirectional = octPhaseForward * 0.8 + octPhaseBack * 0.2;
        let isotropicPhase = 1.0 / (4.0 * PI);
        let octPhase = mix(octPhaseDirectional, isotropicPhase, 0.5 * (1.0 - phaseFactor));

        totalScattering += effectiveSunColor * effectiveSunIntensity * octTransmittance * octPhase * contributionFactor;

        attenuationFactor *= 0.25;
        contributionFactor *= 0.5;
        phaseFactor *= 0.5;
      }

      // Ambient/sky term — height-dependent to brighten cloud tops
      let heightFrac = saturate((length(samplePos) - u.earthRadius - u.cloudBase) / u.cloudThickness);
      let ambient = skyAmbient * 0.18 * (0.4 + 0.6 * heightFrac);

      let scatterStep = (totalScattering + ambient) * density * stepSize;
      scatteredLight += transmittance * scatterStep;
      transmittance *= transmittanceStep;
    } else {
      zeroDensityCount += 1u;
      // Use larger steps in empty space
      if (zeroDensityCount > 3u) {
        stepSize = STEP_SIZE_EMPTY;
      }
    }

    t += stepSize;
  }

  // Output: RGB = scattered light, A = transmittance
  textureStore(outputTexture, pixelCoord, vec4f(scatteredLight, transmittance));
}
